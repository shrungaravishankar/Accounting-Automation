declare const process: { env: Record<string, string | undefined> };
declare const Buffer: {
  from(input: string, encoding: string): Uint8Array;
};
declare function setTimeout(cb: () => void, ms: number): unknown;

import {
  TextractClient,
  AnalyzeExpenseCommand,
  StartExpenseAnalysisCommand,
  GetExpenseAnalysisCommand,
  ExpenseField,
  ExpenseDocument,
  LineItemFields
} from '@aws-sdk/client-textract';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';

const textract = new TextractClient({});
const s3 = new S3Client({});
const OCR_BUCKET = process.env.OCR_BUCKET || '';

/** True if the bytes / mime indicate a PDF (sync Textract only takes 1-page PDFs). */
function isPdf(bytes: Uint8Array, mimeType?: string): boolean {
  if (mimeType && mimeType.toLowerCase().includes('pdf')) return true;
  // PDF magic number: "%PDF" = 0x25 0x50 0x44 0x46
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** Synchronous AnalyzeExpense for single-page images / single-page PDFs. */
async function analyzeSync(bytes: Uint8Array): Promise<ExpenseDocument[]> {
  const res = await textract.send(new AnalyzeExpenseCommand({ Document: { Bytes: bytes } }));
  return res.ExpenseDocuments || [];
}

/**
 * Asynchronous Expense analysis for multi-page PDFs. Stages the file in S3,
 * starts the job, polls until it finishes, and paginates the full result set.
 * The staged object is always cleaned up. Bounded to stay under the 60s
 * Lambda timeout.
 */
async function analyzeAsync(bytes: Uint8Array): Promise<ExpenseDocument[]> {
  if (!OCR_BUCKET) throw new Error('OCR_BUCKET is not configured — cannot process multi-page PDFs.');
  const key = 'textract-temp/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf';
  await s3.send(new PutObjectCommand({ Bucket: OCR_BUCKET, Key: key, Body: bytes, ContentType: 'application/pdf' }));
  try {
    const start = await textract.send(new StartExpenseAnalysisCommand({
      DocumentLocation: { S3Object: { Bucket: OCR_BUCKET, Name: key } }
    }));
    const jobId = start.JobId;
    if (!jobId) throw new Error('Textract did not return a job id.');

    const docs: ExpenseDocument[] = [];
    let nextToken: string | undefined;
    // AppSync caps the whole request at ~30s (shorter than the Lambda's 60s),
    // so bail at ~25s to return a clean "split the PDF" message rather than a
    // generic gateway timeout. Typical 2-5 page bills finish well within this.
    const deadline = Date.now() + 25 * 1000;
    for (;;) {
      const g = await textract.send(new GetExpenseAnalysisCommand({ JobId: jobId, NextToken: nextToken }));
      const status = g.JobStatus;
      if (status === 'SUCCEEDED' || status === 'PARTIAL_SUCCESS') {
        docs.push(...(g.ExpenseDocuments || []));
        if (g.NextToken) { nextToken = g.NextToken; continue; }  // page through results
        return docs;
      }
      if (status === 'FAILED') {
        throw new Error('Textract job failed' + (g.StatusMessage ? ': ' + g.StatusMessage : '.'));
      }
      // IN_PROGRESS — wait and re-poll from the start of the result set.
      if (Date.now() > deadline) {
        throw new Error('OCR timed out on a large PDF. Try splitting it into fewer pages.');
      }
      await new Promise<void>((r) => setTimeout(() => r(), 2000));
      nextToken = undefined;
    }
  } finally {
    // Best-effort cleanup of the staged file.
    try { await s3.send(new DeleteObjectCommand({ Bucket: OCR_BUCKET, Key: key })); } catch (_) { /* ignore */ }
  }
}

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

    // Sync AnalyzeExpense is fast but only accepts single-page PDFs / images.
    // For PDFs we try sync first (covers single-page bills) and fall back to
    // the async S3 job when Textract rejects a multi-page PDF with
    // UnsupportedDocumentException ("Request has unsupported document format").
    let docs: ExpenseDocument[];
    if (isPdf(bytes, event.arguments?.mimeType)) {
      try {
        docs = await analyzeSync(bytes);
      } catch (e: any) {
        const name = e?.name || '';
        const msg = e?.message || '';
        if (name === 'UnsupportedDocumentException' || /unsupported document format/i.test(msg)) {
          docs = await analyzeAsync(bytes);
        } else {
          throw e;
        }
      }
    } else {
      docs = await analyzeSync(bytes);
    }

    const doc = docs[0];
    if (!doc) {
      return JSON.stringify({ error: 'Textract returned no expense documents — is this an invoice/receipt image?' });
    }

    // Multi-page: header fields come from the first page that has them;
    // totals come from the LAST page that has them (where invoice totals
    // conventionally sit on multi-page documents).
    const firstOf = (label: string) => {
      for (const d of docs) { const v = getSummary(d, label); if (v && v.value) return v; }
      return null;
    };
    const lastOf = (label: string) => {
      for (let i = docs.length - 1; i >= 0; i--) { const v = getSummary(docs[i], label); if (v && v.value) return v; }
      return null;
    };
    const vendor = firstOf('VENDOR_NAME');
    const receiver = firstOf('RECEIVER_NAME');
    const invoiceNumber = firstOf('INVOICE_RECEIPT_ID');
    const dateRaw = firstOf('INVOICE_RECEIPT_DATE');
    const dueRaw = firstOf('DUE_DATE');
    const total = lastOf('TOTAL');
    const subtotal = lastOf('SUBTOTAL');
    const tax = lastOf('TAX');
    // Address fields for the receiver — used when creating the customer
    // in Zoho. Textract surfaces RECEIVER_BILL_TO_ADDRESS or the more
    // generic RECEIVER_ADDRESS depending on the invoice layout.
    const receiverAddress = firstOf('RECEIVER_BILL_TO_ADDRESS')
      || firstOf('RECEIVER_ADDRESS')
      || firstOf('RECEIVER_SHIP_TO_ADDRESS');
    const vendorAddress = firstOf('VENDOR_ADDRESS');
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
    let subtotalN = parseAmount(subtotal?.value);
    const taxN = parseAmount(tax?.value);
    const totalN = parseAmount(total?.value);
    // Reconciliation: when Textract returns a subtotal that clearly does not
    // match total/VAT (busy invoice layouts often grab a stray figure from
    // another column), prefer total − VAT. Threshold: ≥ AED 1 OR 5 % of total.
    if (totalN > 0 && taxN >= 0) {
      const expected = subtotalN + taxN;
      const drift = Math.abs(expected - totalN);
      const tolerance = Math.max(1, totalN * 0.05);
      if (subtotalN <= 0 || drift > tolerance) {
        const derived = totalN - taxN;
        if (derived > 0) subtotalN = Math.round(derived * 100) / 100;
      }
    }
    if (subtotalN > 0 && taxN > 0) {
      const pct = (taxN / subtotalN) * 100;
      vatPercent = Math.round(pct * 100) / 100;
    }

    // Aggregate line items across every page, de-duplicating identical
    // (description, amount) pairs that repeat in carried-forward tables.
    const lineItems: ReturnType<typeof extractLineItems> = [];
    const liSeen = new Set<string>();
    for (const d of docs) {
      for (const li of extractLineItems(d)) {
        const key = li.description.toLowerCase() + '|' + li.amount.toFixed(2);
        if (liSeen.has(key)) continue;
        liSeen.add(key);
        lineItems.push(li);
      }
    }

    // ---- Raw text corpus (labels + values from every detected field) ----
    // Used by the frontend's validation engine for document classification,
    // credit-note detection, currency detection, and VAT-intelligence
    // keyword scanning. AnalyzeExpense doesn't return a flat text blob, so
    // we synthesize one from all label/value detections across the doc.
    const rawText: string[] = [];
    const collectText = (fields: ExpenseField[] | undefined) => {
      for (const f of (fields || [])) {
        const label = (f as any).LabelDetection?.Text;
        const value = f.ValueDetection?.Text;
        const type = f.Type?.Text;
        if (label) rawText.push(label);
        if (value) rawText.push(value);
        if (type && type !== 'OTHER') rawText.push(type);
      }
    };
    for (const d of docs) {
      collectText(d.SummaryFields as ExpenseField[]);
      for (const g of (d.LineItemGroups || [])) {
        for (const li of (g.LineItems || [])) {
          collectText(li.LineItemExpenseFields as ExpenseField[]);
        }
      }
    }
    const corpus = rawText.join(' \n ').toLowerCase();

    // ---- Document classification ----
    // Acceptance rule: if the document carries 'invoice' wording OR has
    // the structural shape of one (invoice number + total), accept it.
    // Reject ONLY when the document is unambiguously a quotation, a
    // proforma, or a credit note — supporting paperwork that wraps an
    // invoice (contracts, agreements, POs attached as cover sheets) is
    // not grounds to reject. Credit notes are still routed separately.
    const isCreditNote = /credit\s*note|tax\s*credit\s*note|\bcn[-\s]?\d/i.test(corpus);
    const rejectedMatch = corpus.match(/quotation|proforma|pro[-\s]forma\s*invoice/i);
    const acceptedMatch = corpus.match(/simplified\s*tax\s*invoice|tax\s*invoice|commercial\s*invoice|\binvoice\b/i);
    const looksLikeInvoice = !!(invoiceNumber?.value) && parseAmount(total?.value) > 0;
    let docType = 'unknown';
    if (isCreditNote) docType = 'credit_note';
    else if (acceptedMatch) {
      const m = acceptedMatch[0];
      docType = /simplified/.test(m) ? 'simplified_tax_invoice' : /tax/.test(m) ? 'tax_invoice' : /commercial/.test(m) ? 'commercial_invoice' : 'invoice';
    }
    else if (rejectedMatch && !looksLikeInvoice) docType = rejectedMatch[0].replace(/\s+/g, '_');
    else if (looksLikeInvoice) docType = 'invoice';
    const isInvoice = !isCreditNote && (!!acceptedMatch || (looksLikeInvoice && !rejectedMatch));

    // ---- Currency detection ----
    // The token attached to the TOTAL amount is the strongest signal —
    // a UAE invoice in USD will still mention AED in T&Cs/footer, so a
    // global keyword count was misleading. Order of preference:
    //   1. Currency code/symbol immediately adjacent to TOTAL or SUBTOTAL
    //      values (e.g. "USD 60,000.00", "$60,000", "AED 12,000").
    //   2. Currency code/symbol adjacent to any line-item PRICE.
    //   3. Most-frequent currency code in the doc.
    //   4. Bare symbol fallback ($ / € / £).
    const SUPPORTED = ['AED','USD','EUR','GBP','SAR','QAR','OMR','KWD','BHD'];
    const detectInString = (s: string | undefined | null): string | null => {
      if (!s) return null;
      const u = s.toUpperCase();
      for (const code of SUPPORTED) { if (u.includes(code)) return code; }
      if (s.includes('$')) return 'USD';
      if (s.includes('€')) return 'EUR';
      if (s.includes('£')) return 'GBP';
      if (/د\.?\s*إ/.test(s) || /dhs?\b/i.test(s)) return 'AED';
      return null;
    };
    let currency: string | null = null;
    // (1) inspect TOTAL / SUBTOTAL raw values
    currency = detectInString(total?.value) || detectInString(subtotal?.value) || null;
    // (2) inspect line-item PRICE/UNIT_PRICE values
    if (!currency) {
      outer: for (const d of docs) {
        for (const g of (d.LineItemGroups || [])) {
          for (const li of (g.LineItems || [])) {
            for (const f of (li.LineItemExpenseFields || []) as ExpenseField[]) {
              const t = f.Type?.Text;
              if (t === 'PRICE' || t === 'UNIT_PRICE') {
                const c = detectInString(f.ValueDetection?.Text);
                if (c) { currency = c; break outer; }
              }
            }
          }
        }
      }
    }
    // (3) most-frequent code in the full corpus
    if (!currency) {
      let bestCount = 0, best: string | null = null;
      for (const code of SUPPORTED) {
        const re = new RegExp('\\b' + code.toLowerCase() + '\\b', 'g');
        const count = (corpus.match(re) || []).length;
        if (count > bestCount) { bestCount = count; best = code; }
      }
      currency = best;
    }
    // (4) symbol fallback
    if (!currency) {
      if (corpus.includes('$')) currency = 'USD';
      else if (corpus.includes('€')) currency = 'EUR';
      else if (corpus.includes('£')) currency = 'GBP';
      else currency = 'AED';
    }

    // ---- TRN fallback scan ----
    // If Textract's VAT-number fields missed them, scan the corpus for
    // 15-digit runs near a 'trn' / 'vat' mention.
    if (!vendorTrn || !receiverTrn) {
      const trnRuns = corpus.match(/\b\d{15}\b/g) || [];
      if (trnRuns.length >= 1 && !vendorTrn) vendorTrn = trnRuns[0];
      if (trnRuns.length >= 2 && !receiverTrn) receiverTrn = trnRuns[1];
    }

    // ---- VAT intelligence indicators ----
    const vatFlags: string[] = [];
    if (/reverse\s*charge/i.test(corpus)) vatFlags.push('reverse_charge');
    if (/outside\s*uae|out\s*of\s*scope/i.test(corpus)) vatFlags.push('outside_uae');
    if (/export\s*(supply|of)/i.test(corpus)) vatFlags.push('export_supply');
    if (/zero[-\s]*rated/i.test(corpus)) vatFlags.push('zero_rated');
    if (/designated\s*zone/i.test(corpus)) vatFlags.push('designated_zone');
    if (/exempt/i.test(corpus)) vatFlags.push('exempt');

    // ---- Corporate Tax (CT) TRN misuse detection ----
    // UAE FTA issues two separate registration numbers: a VAT TRN (only
    // for VAT-registered entities) and a CT TRN (Corporate Tax, issued
    // to most businesses regardless of VAT status). Some clients print
    // the CT TRN on their sales invoices as an identifier — this is
    // incorrect, because:
    //   • Tax invoices may only show a VAT TRN, and only when the issuer
    //     is VAT-registered.
    //   • A CT TRN on the invoice does NOT make the supplier/customer
    //     VAT-registered; the receiver cannot reclaim VAT against it.
    // We detect a CT-TRN label here and surface a flag. When the label
    // present is CT only (no VAT TRN label), we also null the picked-up
    // 15-digit TRNs so the invoice is processed as if neither party
    // were VAT-registered (booked as Sales without VAT TRN).
    const hasCtTrnLabel = /\b(?:ct[\s\-_]*trn|corporate[\s\-_]*tax(?:[\s\-_]*trn|[\s\-_]*registration)?|trn\s*\(\s*ct\s*\)|tax\s*registration\s*number\s*\(\s*(?:ct|corporate))/i.test(corpus);
    const hasVatTrnLabel = /\b(?:vat[\s\-_]*trn|trn\s*\(\s*vat\s*\)|vat\s*registration\s*(?:no\.?|number))/i.test(corpus);
    if (hasCtTrnLabel) {
      vatFlags.push('ct_trn_on_document');
      if (!hasVatTrnLabel) {
        vatFlags.push('ct_trn_only');
        vendorTrn = null;
        receiverTrn = null;
      }
    }

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
      vendor_address: vendorAddress?.value || '',
      receiver_address: receiverAddress?.value || '',
      invoice_number: invoiceNumber?.value || '',
      invoice_date: toIsoDate(dateRaw?.value || ''),
      invoice_date_raw: dateRaw?.value || '',
      due_date: toIsoDate(dueRaw?.value || ''),
      total: parseAmount(total?.value),
      subtotal: subtotalN,
      tax: taxN,
      vat_percent: vatPercent,
      line_items: lineItems,
      // Validation-engine inputs
      doc_type: docType,
      is_invoice: isInvoice,
      is_credit_note: isCreditNote,
      currency,
      vat_flags: vatFlags,
      page_count: docs.length,
      confidences: {
        vendor: vendor?.confidence || 0,
        receiver: receiver?.confidence || 0,
        invoice_number: invoiceNumber?.confidence || 0,
        date: dateRaw?.confidence || 0,
        total: total?.confidence || 0,
        subtotal: subtotal?.confidence || 0,
        tax: tax?.confidence || 0
      }
    });
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || 'OCR failed' });
  }
};
