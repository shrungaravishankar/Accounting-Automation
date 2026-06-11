declare const process: { env: Record<string, string | undefined> };
declare const Buffer: {
  from(input: string, encoding: string): Uint8Array;
};

import {
  TextractClient,
  AnalyzeExpenseCommand,
  ExpenseField,
  ExpenseDocument,
  LineItemFields
} from '@aws-sdk/client-textract';

const textract = new TextractClient({});

type Event = {
  arguments: { fileBase64: string; mimeType?: string };
  identity?: { username?: string; claims?: Record<string, any> };
};

/**
 * Pull a labelled field's value (and confidence) out of Textract's
 * SummaryFields. Textract uses canonical labels like INVOICE_RECEIPT_ID,
 * VENDOR_NAME, RECEIVER_NAME, TAX, TOTAL, SUBTOTAL, INVOICE_RECEIPT_DATE.
 * Falls back to the first match if there are multiple.
 */
function getSummary(doc: ExpenseDocument | undefined, label: string): { value: string; confidence: number } | null {
  const fields = (doc?.SummaryFields || []) as ExpenseField[];
  for (const f of fields) {
    const t = f.Type?.Text;
    if (t === label) {
      return {
        value: f.ValueDetection?.Text || '',
        confidence: Number(f.ValueDetection?.Confidence || 0)
      };
    }
  }
  return null;
}

/**
 * Return ALL labelled fields whose Type matches one of the candidates.
 * Useful for fields Textract returns as multiple instances (e.g. multiple
 * VENDOR_VAT_NUMBER occurrences when both vendor and customer have TRNs).
 */
function getAllSummary(doc: ExpenseDocument | undefined, labels: string[]): Array<{ label: string; value: string; confidence: number }> {
  const fields = (doc?.SummaryFields || []) as ExpenseField[];
  const out: Array<{ label: string; value: string; confidence: number }> = [];
  for (const f of fields) {
    const t = f.Type?.Text;
    if (t && labels.includes(t)) {
      out.push({
        label: t,
        value: f.ValueDetection?.Text || '',
        confidence: Number(f.ValueDetection?.Confidence || 0)
      });
    }
  }
  return out;
}

function parseAmount(s: string | undefined | null): number {
  if (!s) return 0;
  // Strip currency symbols and thousands separators; tolerate "AED 1,234.56".
  const cleaned = s.replace(/[^0-9.\-,]/g, '').replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

/**
 * Try to coerce Textract's date string into YYYY-MM-DD. Textract returns
 * dates in whatever format the document uses (e.g. "15-Mar-2026",
 * "15/03/2026", "March 15, 2026"). Returns null if we can't parse it.
 */
function toIsoDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // DD/MM/YYYY or DD-MM-YYYY (UAE convention).
  const dmy = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const pad = (n: string) => n.length < 2 ? '0' + n : n;
    return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;
  }
  // Anything Date() can parse.
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** Extract line items from Textract's LineItemGroups. */
function extractLineItems(doc: ExpenseDocument | undefined): Array<{ description: string; amount: number; quantity: number; rate: number; confidence: number }> {
  const out: Array<{ description: string; amount: number; quantity: number; rate: number; confidence: number }> = [];
  const groups = (doc?.LineItemGroups || []);
  for (const g of groups) {
    for (const li of (g.LineItems || [])) {
      const lif = (li.LineItemExpenseFields || []) as ExpenseField[];
      let description = '';
      let amount = 0;
      let quantity = 1;
      let rate = 0;
      let conf = 0;
      for (const f of lif) {
        const t = f.Type?.Text;
        const v = f.ValueDetection?.Text || '';
        const c = Number(f.ValueDetection?.Confidence || 0);
        if (t === 'ITEM' && v) { description = v; conf = Math.max(conf, c); }
        else if (t === 'PRICE' && v) { amount = parseAmount(v); conf = Math.max(conf, c); }
        else if (t === 'QUANTITY' && v) { quantity = parseAmount(v) || 1; }
        else if (t === 'UNIT_PRICE' && v) { rate = parseAmount(v); }
      }
      if (rate === 0 && amount > 0 && quantity > 0) rate = amount / quantity;
      if (amount === 0 && rate > 0 && quantity > 0) amount = rate * quantity;
      if (description || amount > 0) {
        out.push({ description: description || 'Item', amount, quantity: quantity || 1, rate: rate || amount, confidence: conf });
      }
    }
  }
  return out;
}

/**
 * Decode the base64 payload. Frontend may send a data-URL ("data:image/png;base64,xxx")
 * or just the base64 chunk; handle both. Cap at 10 MB to stay under Textract's sync limit.
 */
function decodeBase64(b64: string): Uint8Array {
  const idx = b64.indexOf(',');
  const raw = idx >= 0 && b64.slice(0, idx).startsWith('data:') ? b64.slice(idx + 1) : b64;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length > 10 * 1024 * 1024) {
    throw new Error('File is larger than 10 MB. Compress it or split into pages.');
  }
  return buf;
}

export const handler = async (event: Event) => {
  try {
    const claims = (event.identity?.claims || {}) as any;
    if (!claims.email && !event.identity?.username) {
      return JSON.stringify({ error: 'Not authenticated.' });
    }
    const b64 = event.arguments?.fileBase64;
    if (!b64) return JSON.stringify({ error: 'fileBase64 is required.' });

    const bytes = decodeBase64(b64);

    const cmd = new AnalyzeExpenseCommand({ Document: { Bytes: bytes } });
    const res = await textract.send(cmd);

    const doc = (res.ExpenseDocuments || [])[0];
    if (!doc) {
      return JSON.stringify({ error: 'Textract returned no expense documents — is this an invoice/receipt image?' });
    }

    const vendor = getSummary(doc, 'VENDOR_NAME');
    const receiver = getSummary(doc, 'RECEIVER_NAME');
    const invoiceNumber = getSummary(doc, 'INVOICE_RECEIPT_ID');
    const dateRaw = getSummary(doc, 'INVOICE_RECEIPT_DATE');
    const dueRaw = getSummary(doc, 'DUE_DATE');
    const total = getSummary(doc, 'TOTAL');
    const subtotal = getSummary(doc, 'SUBTOTAL');
    const tax = getSummary(doc, 'TAX');
    // UAE TRNs sometimes land as VENDOR_VAT_NUMBER or as a free-text label;
    // collect candidates and pick a 15-digit run if found.
    const trnCandidates = getAllSummary(doc, ['VENDOR_VAT_NUMBER', 'RECEIVER_VAT_NUMBER', 'TAX_PAYER_ID']);
    let vendorTrn: string | null = null;
    let receiverTrn: string | null = null;
    for (const c of trnCandidates) {
      const digits = c.value.replace(/\D/g, '');
      if (digits.length === 15) {
        if (c.label === 'VENDOR_VAT_NUMBER') vendorTrn = digits;
        else if (c.label === 'RECEIVER_VAT_NUMBER') receiverTrn = digits;
      }
    }

    // VAT percent — Textract gives us the TAX amount, not the rate. Derive
    // from total/subtotal when possible. For UAE this usually rounds to 5.
    let vatPercent: number | null = null;
    const subtotalN = parseAmount(subtotal?.value);
    const taxN = parseAmount(tax?.value);
    if (subtotalN > 0 && taxN > 0) {
      const pct = (taxN / subtotalN) * 100;
      vatPercent = Math.round(pct * 100) / 100;
    }

    const lineItems = extractLineItems(doc);

    return JSON.stringify({
      error: null,
      // The vendor on the invoice is the *issuer* (the AutoLedger user's customer);
      // the receiver is the entity being billed (the AutoLedger user's client).
      // Frontend reads `vendor_name` as the customer name to create in Zoho.
      vendor_name: vendor?.value || '',
      vendor_confidence: vendor?.confidence || 0,
      receiver_name: receiver?.value || '',
      receiver_confidence: receiver?.confidence || 0,
      vendor_trn: vendorTrn,
      receiver_trn: receiverTrn,
      invoice_number: invoiceNumber?.value || '',
      invoice_date: toIsoDate(dateRaw?.value || ''),
      invoice_date_raw: dateRaw?.value || '',
      due_date: toIsoDate(dueRaw?.value || ''),
      total: parseAmount(total?.value),
      subtotal: subtotalN,
      tax: taxN,
      vat_percent: vatPercent,
      line_items: lineItems
    });
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || 'OCR failed' });
  }
};
