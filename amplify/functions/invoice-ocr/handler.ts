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
  DetectDocumentTextCommand,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
  ExpenseField,
  ExpenseDocument,
  Block,
  LineItemFields
} from '@aws-sdk/client-textract';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand
} from '@aws-sdk/client-bedrock-runtime';

const textract = new TextractClient({});
const s3 = new S3Client({});
const OCR_BUCKET = process.env.OCR_BUCKET || '';
const BEDROCK_REGION = process.env.BEDROCK_REGION || 'us-east-1';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || '';
const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

/** True if the bytes / mime indicate a PDF (sync Textract only takes 1-page PDFs). */
function isPdf(bytes: Uint8Array, mimeType?: string): boolean {
  if (mimeType && mimeType.toLowerCase().includes('pdf')) return true;
  // PDF magic number: "%PDF" = 0x25 0x50 0x44 0x46
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** Bundled OCR result: structured expense docs + the flat text lines. */
type OcrResult = { docs: ExpenseDocument[]; rawLines: string[] };

/** Pull the plain-text LINE blocks out of a Detect/GetDocumentText response. */
function linesFromBlocks(blocks: Block[] | undefined): string[] {
  const out: string[] = [];
  for (const b of (blocks || [])) {
    if (b.BlockType === 'LINE' && b.Text) out.push(b.Text);
  }
  return out;
}

/**
 * Synchronous path for single-page images / single-page PDFs. Runs
 * AnalyzeExpense (structured fields) and DetectDocumentText (raw lines) in
 * parallel — the raw text lets us recover the TRN / bill number / grand
 * total that AnalyzeExpense frequently misses on UAE invoice layouts.
 */
async function analyzeSync(bytes: Uint8Array): Promise<OcrResult> {
  const [exp, txt] = await Promise.all([
    textract.send(new AnalyzeExpenseCommand({ Document: { Bytes: bytes } })),
    textract.send(new DetectDocumentTextCommand({ Document: { Bytes: bytes } })).catch(() => null)
  ]);
  return { docs: exp.ExpenseDocuments || [], rawLines: linesFromBlocks(txt?.Blocks) };
}

/**
 * Asynchronous Expense analysis for multi-page PDFs. Stages the file in S3,
 * starts the job, polls until it finishes, and paginates the full result set.
 * The staged object is always cleaned up. Bounded to stay under the 60s
 * Lambda timeout.
 */
async function analyzeAsync(bytes: Uint8Array): Promise<OcrResult> {
  if (!OCR_BUCKET) throw new Error('OCR_BUCKET is not configured — cannot process multi-page PDFs.');
  const key = 'textract-temp/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf';
  await s3.send(new PutObjectCommand({ Bucket: OCR_BUCKET, Key: key, Body: bytes, ContentType: 'application/pdf' }));
  const location = { S3Object: { Bucket: OCR_BUCKET, Name: key } };
  // AppSync caps the whole request at ~30s (shorter than the Lambda's 60s),
  // so bail at ~25s to return a clean "split the PDF" message rather than a
  // generic gateway timeout. Typical 2-5 page bills finish well within this.
  const deadline = Date.now() + 25 * 1000;
  const sleep = () => new Promise<void>((r) => setTimeout(() => r(), 2000));

  try {
    // Kick off BOTH jobs first so Textract runs them concurrently — wall-clock
    // is max(expense, text), not the sum.
    const [expStart, txtStart] = await Promise.all([
      textract.send(new StartExpenseAnalysisCommand({ DocumentLocation: location })),
      textract.send(new StartDocumentTextDetectionCommand({ DocumentLocation: location })).catch(() => null)
    ]);
    const expJob = expStart.JobId;
    if (!expJob) throw new Error('Textract did not return a job id.');
    const txtJob = txtStart?.JobId;

    // Poll the expense job (required) and paginate its results.
    const docs: ExpenseDocument[] = [];
    let nextToken: string | undefined;
    for (;;) {
      const g = await textract.send(new GetExpenseAnalysisCommand({ JobId: expJob, NextToken: nextToken }));
      const status = g.JobStatus;
      if (status === 'SUCCEEDED' || status === 'PARTIAL_SUCCESS') {
        docs.push(...(g.ExpenseDocuments || []));
        if (g.NextToken) { nextToken = g.NextToken; continue; }  // page through results
        break;
      }
      if (status === 'FAILED') {
        throw new Error('Textract job failed' + (g.StatusMessage ? ': ' + g.StatusMessage : '.'));
      }
      if (Date.now() > deadline) {
        throw new Error('OCR timed out on a large PDF. Try splitting it into fewer pages.');
      }
      await sleep();
      nextToken = undefined;
    }

    // Collect raw text (best-effort — never let it block the structured result).
    const rawLines: string[] = [];
    if (txtJob) {
      try {
        let tToken: string | undefined;
        for (;;) {
          const t = await textract.send(new GetDocumentTextDetectionCommand({ JobId: txtJob, NextToken: tToken }));
          const status = t.JobStatus;
          if (status === 'SUCCEEDED' || status === 'PARTIAL_SUCCESS') {
            rawLines.push(...linesFromBlocks(t.Blocks));
            if (t.NextToken) { tToken = t.NextToken; continue; }
            break;
          }
          if (status === 'FAILED' || Date.now() > deadline) break;
          await sleep();
          tToken = undefined;
        }
      } catch (_) { /* raw text is a bonus; ignore failures */ }
    }

    return { docs, rawLines };
  } finally {
    // Best-effort cleanup of the staged file.
    try { await s3.send(new DeleteObjectCommand({ Bucket: OCR_BUCKET, Key: key })); } catch (_) { /* ignore */ }
  }
}

type Event = {
  arguments: { fileBase64: string; mimeType?: string };
  identity?: { username?: string; claims?: Record<string, any> };
};

declare const TextDecoder: { new (): { decode(input: Uint8Array): string } };

/** Detect the media type for Claude from the bytes / declared mime. */
function mediaTypeOf(bytes: Uint8Array, mimeType?: string): string {
  if (mimeType) {
    const m = mimeType.toLowerCase();
    if (m.includes('pdf')) return 'application/pdf';
    if (m.includes('png')) return 'image/png';
    if (m.includes('jpeg') || m.includes('jpg')) return 'image/jpeg';
    if (m.includes('webp')) return 'image/webp';
    if (m.includes('gif')) return 'image/gif';
  }
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  return 'image/jpeg';
}

const CLAUDE_PROMPT = [
  'You are an expert UAE accounting data-extraction engine. Read this supplier bill / tax invoice and return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:',
  '{',
  '  "vendor_name": string|null,        // the SUPPLIER / issuer (the "From" party)',
  '  "vendor_trn": string|null,         // supplier 15-digit TRN; null if absent or all-zeros placeholder',
  '  "receiver_name": string|null,      // the CUSTOMER billed (the "To"/"Bill To" party)',
  '  "receiver_trn": string|null,',
  '  "invoice_number": string|null,     // the bill/invoice/tax-invoice number; NOT a PO/order/account number',
  '  "invoice_date": string|null,       // YYYY-MM-DD',
  '  "due_date": string|null,           // YYYY-MM-DD',
  '  "currency": string|null,           // 3-letter code, e.g. AED',
  '  "line_items": [ { "description": string, "quantity": number, "rate": number } ],',
  '  "subtotal": number|null,           // the subtotal/net total PRINTED on the bill (before VAT)',
  '  "tax": number|null,                // the total VAT amount PRINTED on the bill',
  '  "total": number|null               // the grand total PRINTED on the bill (incl. VAT)',
  '}',
  'CRITICAL line-item rules:',
  '- Return EVERY line on the bill. Never merge two lines into one and never drop a line — if the bill lists 6 products, return 6 line items.',
  '- Keep each description COMPLETE and verbatim (e.g. "VINUVA ORGANIC PINOT GRIGIO 6X75CL", not just "GRIGIO"). Do not truncate.',
  '- quantity = the QTY shown for that line (default 1 only if no quantity column exists).',
  '- rate = the UNIT PRICE BEFORE VAT for ONE unit. If the bill has several price columns (e.g. Unit Price, Net Price, Price Tax Incl., Amount Incl. M.Tax, Grand Total), pick the per-unit price that EXCLUDES VAT (Unit/Net Price), never a tax-inclusive column and never a line total.',
  '- Do NOT return a line amount; the system computes amount = quantity x rate itself.',
  'Totals rules: subtotal, tax and total must be the figures literally PRINTED on the bill (do not recompute them). All monetary values are plain numbers — strip currency symbols, codes and thousands separators. Never invent a TRN; ignore all-zero placeholders. Use null for anything not present. Return JSON only.'
].join('\n');

/**
 * Primary extractor — Claude (Sonnet 4.6) vision via Amazon Bedrock. Reads
 * photographed / dense multi-column invoices far more reliably than Textract.
 * Returns the same field set the Textract path produces, or throws so the
 * caller can fall back to Textract.
 */
async function extractInvoiceWithClaude(rawB64: string, mediaType: string): Promise<any> {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const isPdfDoc = mediaType === 'application/pdf';
  const mediaBlock = isPdfDoc
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: rawB64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: rawB64 } };
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 3000,
    messages: [{ role: 'user', content: [mediaBlock, { type: 'text', text: CLAUDE_PROMPT }] }]
  };
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body)
  }));
  const payload = JSON.parse(new TextDecoder().decode(res.body as Uint8Array));
  const text = ((payload.content || []) as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('');
  // Pull the JSON object out of the response (tolerate stray fences/prose).
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude returned no JSON object.');
  const f = JSON.parse(text.slice(start, end + 1));

  const num = (v: any) => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
  const validTrn = (s: any) => typeof s === 'string' && /^\d{15}$/.test(s.replace(/\D/g, '')) && !/^(\d)\1{14}$/.test(s.replace(/\D/g, ''));

  // Line items: keep quantity and the per-unit rate (before VAT) exactly as
  // read; the tool computes amount = quantity × rate itself (bottom-up) rather
  // than copying — and never back-distributes the total across lines.
  const lineItems = (Array.isArray(f.line_items) ? f.line_items : []).map((li: any) => {
    const quantity = num(li.quantity) || 1;
    let rate = num(li.rate);
    // Tolerate older shape / models that still send an amount: derive the unit rate.
    if (!rate && num(li.amount)) rate = round2(num(li.amount) / quantity);
    const amount = round2(quantity * rate);
    return { description: String(li.description || '').trim(), quantity, rate, amount, confidence: 99 };
  }).filter((li: any) => li.description || li.amount > 0);

  // Tool-computed totals (bottom-up): subtotal = Σ(qty × rate), VAT at the
  // rate the bill implies (UAE standard 5%), total = subtotal + VAT.
  const sumLines = round2(lineItems.reduce((s: number, li: any) => s + li.amount, 0));
  // What the bill PRINTS — kept separately so the validator can flag (not
  // silently overwrite) any disagreement with the tool's own calculation.
  const printedSubtotal = num(f.subtotal) || null;
  const printedTax = num(f.tax) || null;
  const printedTotal = num(f.total) || null;
  // Detect the VAT rate from the printed figures; default to UAE 5% when VAT is present.
  let vatPercent: number | null = null;
  if (printedSubtotal && printedTax) vatPercent = round2((printedTax / printedSubtotal) * 100);
  else if (printedTax && sumLines) vatPercent = round2((printedTax / sumLines) * 100);
  if (vatPercent != null && Math.abs(vatPercent - 5) <= 1) vatPercent = 5;            // snap to standard
  if (vatPercent != null && Math.abs(vatPercent) <= 0.5) vatPercent = 0;              // zero-rated/exempt
  const subtotalN = sumLines || printedSubtotal || 0;
  const rateForCalc = vatPercent != null ? vatPercent : (printedTax || printedTotal ? 5 : 0);
  const taxN = round2(subtotalN * (rateForCalc / 100));
  const totalN = round2(subtotalN + taxN);
  if (vatPercent == null) vatPercent = rateForCalc || null;

  const vendorTrn = validTrn(f.vendor_trn) ? String(f.vendor_trn).replace(/\D/g, '') : null;
  const receiverTrn = validTrn(f.receiver_trn) ? String(f.receiver_trn).replace(/\D/g, '') : null;

  return {
    error: null,
    extractor: 'claude',
    vendor_name: f.vendor_name || '',
    vendor_confidence: 99,
    receiver_name: f.receiver_name || '',
    receiver_confidence: 99,
    vendor_trn: vendorTrn,
    receiver_trn: receiverTrn,
    vendor_address: f.vendor_address || '',
    receiver_address: f.receiver_address || '',
    invoice_number: f.invoice_number || '',
    invoice_date: f.invoice_date || null,
    invoice_date_raw: f.invoice_date || '',
    due_date: f.due_date || null,
    total: totalN,
    subtotal: subtotalN,
    tax: taxN,
    vat_percent: vatPercent,
    // What the bill literally prints — for the validator to cross-check the
    // tool's own bottom-up calculation against (flag, never silently replace).
    printed_subtotal: printedSubtotal,
    printed_tax: printedTax,
    printed_total: printedTotal,
    line_items: lineItems,
    doc_type: f.doc_type || 'invoice',
    is_invoice: true,
    is_credit_note: false,
    currency: String(f.currency || 'AED').toUpperCase(),
    vat_flags: [],
    page_count: 1,
    confidences: { vendor: 99, receiver: 99, invoice_number: 99, date: 99, total: 99, subtotal: 99, tax: 99 }
  };
}

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

    // ---- Primary path: Claude (Sonnet 4.6) vision via Bedrock ----
    // Far better on photographed / dense multi-column invoices, and cheaper
    // than the Textract AnalyzeExpense path. Falls through to Textract on any
    // error (model access not enabled, parse failure, Bedrock unavailable).
    if (BEDROCK_MODEL_ID) {
      try {
        const idx = b64.indexOf(',');
        const rawB64 = idx >= 0 && b64.slice(0, idx).startsWith('data:') ? b64.slice(idx + 1) : b64;
        const mediaType = mediaTypeOf(bytes, event.arguments?.mimeType);
        const claudeResult = await extractInvoiceWithClaude(rawB64, mediaType);
        return JSON.stringify(claudeResult);
      } catch (e: any) {
        console.warn('[claude-ocr] extraction failed, falling back to Textract:', e?.name, e?.message);
      }
    }

    // Sync AnalyzeExpense is fast but only accepts single-page PDFs / images.
    // For PDFs we try sync first (covers single-page bills) and fall back to
    // the async S3 job when Textract rejects a multi-page PDF with
    // UnsupportedDocumentException ("Request has unsupported document format").
    let ocr: OcrResult;
    if (isPdf(bytes, event.arguments?.mimeType)) {
      try {
        ocr = await analyzeSync(bytes);
      } catch (e: any) {
        const name = e?.name || '';
        const msg = e?.message || '';
        if (name === 'UnsupportedDocumentException' || /unsupported document format/i.test(msg)) {
          ocr = await analyzeAsync(bytes);
        } else {
          throw e;
        }
      }
    } else {
      ocr = await analyzeSync(bytes);
    }
    const docs = ocr.docs;
    const rawLines = ocr.rawLines;

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
    // A real UAE TRN is 15 digits and never all-the-same-digit (e.g.
    // 000000000000000 is a "not VAT-registered" placeholder some systems print).
    const validTrn = (s: string) => /^\d{15}$/.test(s) && !/^(\d)\1{14}$/.test(s);
    for (const c of trnCandidates) {
      const digits = c.value.replace(/\D/g, '');
      if (!validTrn(digits)) continue;
      if (c.label === 'VENDOR_VAT_NUMBER') vendorTrn = digits;
      else if (c.label === 'RECEIVER_VAT_NUMBER') receiverTrn = digits;
    }

    // ---- Raw-text recovery from DetectDocumentText ----
    // AnalyzeExpense misses header TRNs / bill numbers and is fooled by
    // "Payment Made" / "Balance Due 0.00" rows when picking the grand total,
    // so recover those deterministically from the flat text lines.
    const fullLines = rawLines.map((l) => l.trim()).filter(Boolean);
    const fullText = fullLines.join('\n');
    // Only money-shaped tokens count: either thousand-separated (1,234 / 1,234.56)
    // or carrying a decimal (1234.56). Bare long integer runs are NOT amounts —
    // they are TRNs (15 digits), barcodes, invoice/customer numbers, IBANs — and
    // matching them caused 15-digit TRNs to be picked as subtotal/total. Also cap
    // magnitude well below any TRN (1e8 ≫ realistic AED bill, ≪ a 15-digit TRN).
    const amountsOn = (line: string): number[] =>
      (line.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}/g) || [])
        .map(parseAmount).filter((n) => n > 0 && n < 1e8);
    const labeledAmount = (labelRe: RegExp, excludeRe: RegExp | null): number | null => {
      for (let i = 0; i < fullLines.length; i++) {
        const ln = fullLines[i];
        if (excludeRe && excludeRe.test(ln)) continue;
        if (!labelRe.test(ln)) continue;
        const a = amountsOn(ln);
        if (a.length) return a[a.length - 1];
        // Table layouts split the label and its value into separate LINE
        // blocks — look at the next few lines for the first amount.
        for (let j = i + 1; j < Math.min(i + 4, fullLines.length); j++) {
          if (excludeRe && excludeRe.test(fullLines[j])) continue;
          const b = amountsOn(fullLines[j]);
          if (b.length) return b[0];
        }
      }
      return null;
    };
    // (a) TRNs — associate each 15-digit run with the vendor or the customer by
    // PROXIMITY to their names in the text. The vendor's TRN sits in the vendor
    // ("From") block; the customer's by the "To" / Bill-To block. This avoids
    // grabbing the customer's TRN (which often appears first in document order)
    // as the vendor's. Placeholder all-same-digit TRNs are ignored.
    const trnHits = [...fullText.matchAll(/\b(\d{15})\b/g)]
      .map((m) => ({ trn: m[1], idx: m.index || 0 }))
      .filter((h) => validTrn(h.trn));
    const lc = fullText.toLowerCase();
    const anchorOf = (name: string | undefined) => {
      const k = (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim()
        .split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
      return k ? lc.indexOf(k) : -1;
    };
    const vPos = anchorOf(vendor?.value);
    const rPos = anchorOf(receiver?.value);
    for (const h of trnHits) {
      const dV = vPos >= 0 ? Math.abs(h.idx - vPos) : Number.POSITIVE_INFINITY;
      const dR = rPos >= 0 ? Math.abs(h.idx - rPos) : Number.POSITIVE_INFINITY;
      if (dV <= dR) { if (!vendorTrn) vendorTrn = h.trn; }
      else if (!receiverTrn) receiverTrn = h.trn;
    }
    // Fallbacks (issuer first, customer second) if proximity left gaps.
    if (!vendorTrn && trnHits[0]) vendorTrn = trnHits[0].trn;
    if (!receiverTrn) { const other = trnHits.find((h) => h.trn !== vendorTrn); if (other) receiverTrn = other.trn; }
    // (b) Bill number — match against the JOINED text, not per line. Textract
    // chunks table cells into separate LINE blocks (and does so inconsistently
    // run to run), so a per-line scan misses "# BCL/2031" whenever the "#" and
    // the ref land in different blocks. \s spans the newline, so this is stable.
    let rawInvoiceNo: string | null = null;
    // Explicit "Invoice/Bill No: X".
    const invLabel = fullText.match(/(?:tax\s+invoice|invoice|bill)\s*(?:no\.?|number|num)\s*[:.#\-]*\s*([A-Za-z0-9][A-Za-z0-9/\-]{1,24})/i);
    if (invLabel && invLabel[1] && !/^(date|no|number|num)$/i.test(invLabel[1])) rawInvoiceNo = invLabel[1].trim();
    // Else the bare "# REF" header form (e.g. "# BCL/2031"). Skip refs whose
    // preceding text marks them as a PO / order / purchase reference.
    if (!rawInvoiceNo) {
      for (const mm of fullText.matchAll(/([A-Za-z.\s]{0,16})#\s*([A-Za-z]{1,6}[\/\-]?\d{2,}[A-Za-z0-9/\-]*)/g)) {
        if (/\b(order|p\.?\s*o|lpo|purchase)\b/i.test(mm[1])) continue;
        rawInvoiceNo = mm[2].trim();
        break;
      }
    }
    // Totals reconciliation. The reliable invariant on a UAE tax invoice is
    // total = subtotal + VAT, with VAT = subtotal × rate (5%). Textract grabs
    // the wrong column unpredictably (the VAT-inclusive col as subtotal on one
    // bill, the taxable col as total on another, and misses VAT entirely on a
    // third). So instead of trusting any single field, gather EVERY amount on
    // the document and find the (subtotal, total) pair whose ratio is 1 + rate,
    // maximizing the total — that pair is the taxable base and the grand total,
    // and VAT is their difference. Self-correcting across invoice layouts.
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const aeSubtotal = parseAmount(subtotal?.value);
    const aeTax = parseAmount(tax?.value);
    const aeTotal = parseAmount(total?.value);

    // Detected VAT rate (UAE standard supply is 5%; any printed % wins).
    let detectedRate = 0;
    const pctMatches = (fullText.match(/(\d{1,2}(?:\.\d+)?)\s*%/g) || [])
      .map((s) => parseFloat(s)).filter((p) => p > 0 && p <= 20);
    if (pctMatches.length) detectedRate = pctMatches.find((p) => Math.round(p) === 5) || pctMatches[0];
    const rate = (detectedRate > 0 ? detectedRate : 5) / 100;

    // Every monetary amount on the document (raw text + AnalyzeExpense fields).
    const amtSet = new Set<number>();
    for (const ln of fullLines) for (const a of amountsOn(ln)) amtSet.add(round2(a));
    [aeSubtotal, aeTax, aeTotal].forEach((n) => { if (n > 0 && n < 1e8) amtSet.add(round2(n)); });
    const amounts = [...amtSet].sort((a, b) => b - a);

    let vatPercent: number | null = null;
    let subtotalN = 0, totalN = 0, taxN = 0;
    // Largest total with a matching taxable base wins (line-level pairs lose to
    // the grand-total pair because we iterate totals high-to-low).
    for (const T of amounts) {
      let s = 0;
      for (const S of amounts) {
        if (S >= T) continue;
        if (Math.abs(T - S * (1 + rate)) <= Math.max(0.5, S * 0.005)) { s = S; break; }
      }
      if (s) { totalN = T; subtotalN = s; taxN = round2(T - s); break; }
    }

    if (!totalN) {
      // FALLBACK — zero-rated / exempt, or a single figure with no VAT pair.
      taxN = aeTax;
      const rawGrandTotal = labeledAmount(/\btotal\b/i, /(sub[\s-]*total|balance|payment|paid|amount\s+(?:due|paid))/i);
      totalN = rawGrandTotal || aeTotal || aeSubtotal || amounts[0] || 0;
      if (taxN > 0 && totalN - taxN > 0) subtotalN = round2(totalN - taxN);
      else if (taxN > 0) { subtotalN = round2(taxN / rate); totalN = round2(subtotalN + taxN); }
      else subtotalN = totalN;  // no VAT charged → subtotal equals total
    }

    if (subtotalN > 0 && taxN > 0) vatPercent = round2((taxN / subtotalN) * 100);

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
    // Normalize line amounts to the TAXABLE base (what VAT is computed on) and
    // default missing quantities to 1. Textract often returns each line's
    // VAT-inclusive "Amount" column; when the line total sums to the grand
    // total (gross) rather than the subtotal, strip VAT proportionally so the
    // amounts reconcile with the taxable subtotal.
    const sumLines = lineItems.reduce((s, li) => s + (li.amount || 0), 0);
    const near = (a: number, b: number) => b > 0 && Math.abs(a - b) <= Math.max(1, b * 0.03);
    const linesAreGross = subtotalN > 0 && sumLines > 0 && near(sumLines, totalN) && !near(sumLines, subtotalN);
    for (const li of lineItems) {
      if (!li.quantity || li.quantity <= 0) li.quantity = 1;
      if (linesAreGross) li.amount = round2(li.amount * (subtotalN / sumLines));
      li.rate = li.quantity > 0 ? round2(li.amount / li.quantity) : li.amount;
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
    // Include the flat DetectDocumentText lines so classification, currency,
    // TRN fallback, and VAT-flag scanning see header text AnalyzeExpense drops.
    const corpus = (rawText.join(' \n ') + ' \n ' + fullText).toLowerCase();

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
    const looksLikeInvoice = !!(invoiceNumber?.value || rawInvoiceNo) && totalN > 0;
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
    // NB: the corporate-tax branch REQUIRES a trn/registration token after
    // "corporate tax" — otherwise an ordinary service line like "Corporate Tax
    // Filing" would false-positive and wrongly null a legitimate VAT TRN.
    const hasCtTrnLabel = /\b(?:ct[\s\-_]*trn|corporate[\s\-_]*tax[\s\-_]*(?:trn|registration|reg\.?\s*(?:no\.?|number)?)|trn\s*\(\s*ct\s*\)|tax\s*registration\s*number\s*\(\s*(?:ct|corporate))/i.test(corpus);
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
      invoice_number: (invoiceNumber?.value && invoiceNumber.value.trim()) || rawInvoiceNo || '',
      invoice_date: toIsoDate(dateRaw?.value || ''),
      invoice_date_raw: dateRaw?.value || '',
      due_date: toIsoDate(dueRaw?.value || ''),
      total: totalN,
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
