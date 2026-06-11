import { defineFunction } from '@aws-amplify/backend';

/**
 * AWS Textract-powered invoice OCR. The frontend sends a base64-encoded
 * PDF or image and we return structured invoice fields (vendor, customer,
 * date, totals, VAT, line items) extracted via Textract AnalyzeExpense —
 * the purpose-built model for receipts and invoices.
 *
 * Memory bumped to 1 GB because base64 decoding + Textract response
 * parsing of multi-page invoices can spike. Timeout 60s covers slow OCR.
 */
export const invoiceOcr = defineFunction({
  name: 'invoice-ocr',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 1024,
  resourceGroupName: 'data'
});
