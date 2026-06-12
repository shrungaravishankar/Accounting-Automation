declare const process: { env: Record<string, string | undefined> };
declare const Buffer: { from(input: string, encoding: string): Uint8Array };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type Event = {
  arguments: { kind: string; organizationId?: string; payload?: string; params?: string };
  identity?: { username?: string; sub?: string; claims?: Record<string, any> };
};

async function getAccessToken(refreshToken: string, region: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID!,
    client_secret: process.env.ZOHO_CLIENT_SECRET!,
    refresh_token: refreshToken
  });
  const r = await fetch(`https://accounts.zoho.${region}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const rawText = await r.text();
  let j: any;
  try { j = JSON.parse(rawText); }
  catch (_) {
    console.error('[zoho-sync] Non-JSON refresh response:', r.status, rawText.slice(0, 500));
    throw new Error(`Zoho returned a non-JSON refresh response (HTTP ${r.status}): ${rawText.slice(0, 200)}`);
  }
  if (!r.ok || !j.access_token) {
    console.error('[zoho-sync] Refresh failed. HTTP', r.status, 'body=', JSON.stringify(j));
    const msg = j.error || j.error_description || r.statusText;
    const hint = (msg === 'invalid_code' || msg === 'invalid_grant' || /denied/i.test(msg))
      ? ' — your refresh token is no longer valid. Click avatar → Connect to Zoho again to re-authorise.'
      : '';
    throw new Error('Could not refresh Zoho access token: ' + msg + hint);
  }
  return j.access_token;
}

// Pulled from the last Zoho call so we can return the org's daily API
// quota counters with every response. Zoho sends X-Rate-Limit-Limit /
// Remaining / Reset (epoch seconds) headers on every successful call.
let lastApiUsage: { limit: number | null; remaining: number | null; reset: number | null } = {
  limit: null, remaining: null, reset: null
};

function captureApiUsage(headers: Headers) {
  const num = (v: string | null) => (v == null || v === '' ? null : Number(v));
  const lim = num(headers.get('x-rate-limit-limit'));
  const rem = num(headers.get('x-rate-limit-remaining'));
  const rst = num(headers.get('x-rate-limit-reset'));
  if (lim != null || rem != null || rst != null) {
    lastApiUsage = { limit: lim, remaining: rem, reset: rst };
  }
}

async function zohoGet(path: string, accessToken: string, region: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.zohoapis.${region}/books/v3/${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, {
    headers: { Authorization: 'Zoho-oauthtoken ' + accessToken }
  });
  captureApiUsage(r.headers);
  const j: any = await r.json();
  if (!r.ok || j.code !== 0) {
    throw new Error('Zoho API ' + path + ' failed: ' + (j.message || r.statusText));
  }
  return j;
}

async function zohoPost(path: string, accessToken: string, region: string, params: Record<string, string>, body: any) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.zohoapis.${region}/books/v3/${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Zoho-oauthtoken ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  captureApiUsage(r.headers);
  const j: any = await r.json();
  if (!r.ok || j.code !== 0) {
    // Zoho returns its own error code in j.code (0 = success) and j.message
    // with a human-readable reason. Surface both to the caller.
    throw new Error((j.message || r.statusText) + (j.code ? ' [zoho code ' + j.code + ']' : ''));
  }
  return j;
}

async function zohoDelete(path: string, accessToken: string, region: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.zohoapis.${region}/books/v3/${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: 'Zoho-oauthtoken ' + accessToken }
  });
  captureApiUsage(r.headers);
  const j: any = await r.json();
  if (!r.ok || j.code !== 0) {
    throw new Error((j.message || r.statusText) + (j.code ? ' [zoho code ' + j.code + ']' : ''));
  }
  return j;
}

export const handler = async (event: Event) => {
  const kind = event.arguments?.kind;
  const orgId = event.arguments?.organizationId;
  if (!kind) return JSON.stringify({ error: 'kind is required' });

  const claims = (event.identity?.claims || {}) as any;
  const ownerEmail = (claims.email || event.identity?.username || '').toLowerCase();
  if (!ownerEmail) return JSON.stringify({ error: 'Could not determine caller identity.' });

  const tableName = process.env.ZOHOCRED_TABLE_NAME;
  if (!tableName) return JSON.stringify({ error: 'Server misconfiguration — table env var missing.' });

  try {
    // Find the caller's stored Zoho credentials.
    const credRes = await ddb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'ownerEmail = :e',
      ExpressionAttributeValues: { ':e': ownerEmail },
      Limit: 1
    }));
    const cred = credRes.Items && credRes.Items[0];
    if (!cred) {
      return JSON.stringify({ error: 'Not connected to Zoho yet. Click \'Connect Zoho\' first.' });
    }
    const region = cred.region || 'com';
    const accessToken = await getAccessToken(cred.refreshToken, region);

    // Stamp lastUsedAt — best-effort.
    ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { id: cred.id },
      UpdateExpression: 'SET lastUsedAt = :u',
      ExpressionAttributeValues: { ':u': new Date().toISOString() }
    })).catch(() => {});

    if (kind === 'organizations') {
      const j = await zohoGet('organizations', accessToken, region);
      const orgs = (j.organizations || []).map((o: any) => ({
        organization_id: o.organization_id,
        name: o.name,
        currency_code: o.currency_code,
        country: o.country,
        is_default_org: o.is_default_org
      }));
      return JSON.stringify({ error: null, items: orgs, apiUsage: lastApiUsage });
    }

    if (!orgId) return JSON.stringify({ error: 'organizationId is required for kind=' + kind });

    if (kind === 'chartofaccounts') {
      const all: any[] = [];
      let page = 1;
      while (true) {
        const j = await zohoGet('chartofaccounts', accessToken, region, {
          organization_id: orgId,
          per_page: '200',
          page: String(page)
        });
        all.push(...(j.chartofaccounts || []));
        if (!j.page_context || !j.page_context.has_more_page) break;
        page++;
        if (page > 20) break;
      }
      const accounts = all.map((a: any) => ({
        name: a.account_name,
        type: a.account_type || '',
        code: a.account_code || '',
        id: a.account_id  // NEW — needed for push
      }));
      return JSON.stringify({ error: null, items: accounts, apiUsage: lastApiUsage });
    }

    if (kind === 'vendors' || kind === 'customers') {
      const contactType = kind === 'vendors' ? 'vendor' : 'customer';
      const all: any[] = [];
      let page = 1;
      while (true) {
        const j = await zohoGet('contacts', accessToken, region, {
          organization_id: orgId,
          contact_type: contactType,
          per_page: '200',
          page: String(page)
        });
        all.push(...(j.contacts || []));
        if (!j.page_context || !j.page_context.has_more_page) break;
        page++;
        if (page > 20) break;
      }
      // Return both names (UI compat) and an id map for push.
      const names: string[] = [];
      const idByName: Record<string, string> = {};
      for (const c of all) {
        if (c.contact_name && c.contact_id) {
          names.push(c.contact_name);
          idByName[c.contact_name] = c.contact_id;
        }
      }
      return JSON.stringify({ error: null, items: names, idByName, apiUsage: lastApiUsage });
    }

    // Open invoices for a given org — used to link Payment Received entries
    // to specific invoices instead of creating unapplied payments.
    if (kind === 'openInvoices') {
      const all: any[] = [];
      let page = 1;
      while (true) {
        // Zoho's `status` param only takes a single value — a comma list
        // returns 'Invalid value passed for status'. filter_by=Status.Unpaid
        // covers unpaid + partially paid + overdue in one call; the
        // balance>0 filter below drops anything else.
        const j = await zohoGet('invoices', accessToken, region, {
          organization_id: orgId,
          filter_by: 'Status.Unpaid',
          per_page: '200',
          page: String(page)
        });
        all.push(...(j.invoices || []));
        if (!j.page_context || !j.page_context.has_more_page) break;
        page++;
        if (page > 20) break;
      }
      const invoices = all
        .filter((i: any) => Number(i.balance) > 0)
        .map((i: any) => ({
          invoice_id: i.invoice_id,
          invoice_number: i.invoice_number,
          customer_id: i.customer_id,
          customer_name: i.customer_name,
          date: i.date,
          due_date: i.due_date,
          total: Number(i.total),
          balance: Number(i.balance),
          status: i.status
        }));
      return JSON.stringify({ error: null, items: invoices, apiUsage: lastApiUsage });
    }

    // Look up invoices by exact invoice_number — duplicate detection for
    // the OCR module. params = JSON { invoiceNumber }. Returns matches
    // (possibly across customers; the frontend narrows by customer name).
    if (kind === 'findInvoice') {
      let p: any = {};
      try { p = JSON.parse(event.arguments?.params || '{}'); } catch (_) { p = {}; }
      const invNo = (p.invoiceNumber || '').trim();
      if (!invNo) return JSON.stringify({ error: 'invoiceNumber is required (pass via params)' });
      const j = await zohoGet('invoices', accessToken, region, {
        organization_id: orgId,
        invoice_number: invNo
      });
      const matches = (j.invoices || []).map((i: any) => ({
        invoice_id: i.invoice_id,
        invoice_number: i.invoice_number,
        customer_id: i.customer_id,
        customer_name: i.customer_name,
        date: i.date,
        total: Number(i.total),
        balance: Number(i.balance),
        status: i.status
      }));
      return JSON.stringify({ error: null, items: matches, apiUsage: lastApiUsage });
    }

    // Historical FX rate for foreign-currency invoices. params = JSON
    // { from, to, date }. GCC pegs are constants (USD/SAR/QAR/OMR/KWD/BHD
    // are all pegged to USD, hence stable against AED); floating pairs
    // (EUR/GBP) are fetched live from a free rates API as a best-effort
    // proxy for the Central Bank of UAE reference rate — the response
    // carries `source` so the audit trail shows where the number came
    // from, and the frontend allows a manual override either way.
    if (kind === 'fxRate') {
      let p: any = {};
      try { p = JSON.parse(event.arguments?.params || '{}'); } catch (_) { p = {}; }
      const from = (p.from || '').toUpperCase();
      const to = (p.to || 'AED').toUpperCase();
      if (!from) return JSON.stringify({ error: 'from currency is required' });
      if (from === to) return JSON.stringify({ error: null, rate: 1, source: 'identity', dateUsed: p.date || null, apiUsage: lastApiUsage });

      // Pegged cross-rates via AED (1 USD = 3.6725 AED fixed since 1997;
      // SAR/QAR/OMR/KWD/BHD are USD-pegged so their AED crosses are stable).
      const AED_PER: Record<string, number> = {
        USD: 3.6725,
        SAR: 0.97933,   // 3.75 SAR / USD
        QAR: 1.00892,   // 3.64 QAR / USD
        OMR: 9.54545,   // 0.3845 OMR / USD
        KWD: 11.95440,  // ~0.3072 KWD / USD
        BHD: 9.74801,   // 0.376 BHD / USD
        AED: 1
      };
      const pegged = (f: string, t: string): number | null => {
        if (AED_PER[f] != null && AED_PER[t] != null) return AED_PER[f] / AED_PER[t];
        return null;
      };
      const peg = pegged(from, to);
      if (peg != null) {
        return JSON.stringify({ error: null, rate: Math.round(peg * 100000) / 100000, source: 'GCC peg (fixed parity)', dateUsed: p.date || null, apiUsage: lastApiUsage });
      }
      // Floating pair — try the free open.er-api.com latest table.
      try {
        const r = await fetch(`https://open.er-api.com/v6/latest/${from}`);
        const j: any = await r.json();
        const rate = j && j.rates && j.rates[to];
        if (rate) {
          return JSON.stringify({ error: null, rate: Math.round(Number(rate) * 100000) / 100000, source: 'open.er-api.com (latest reference rate)', dateUsed: new Date().toISOString().slice(0, 10), apiUsage: lastApiUsage });
        }
      } catch (_) { /* fall through */ }
      return JSON.stringify({ error: 'Historical exchange rate could not be retrieved. Enter the rate manually.', apiUsage: lastApiUsage });
    }

    // Organization profile — legal name + VAT TRN as configured in Zoho
    // Books (Settings → Taxes → Tax Registration Number). The frontend
    // syncs these into the per-client config so users never type them.
    if (kind === 'orgProfile') {
      const j = await zohoGet(`organizations/${orgId}`, accessToken, region);
      const o = j.organization || {};
      // Zoho exposes the VAT registration under tax_reg_no on the detailed
      // org object for GCC editions; fall back to scanning custom fields.
      let trn = (o.tax_reg_no || '').replace(/\D/g, '');
      if (trn.length !== 15) {
        const blob = JSON.stringify(o);
        const m = blob.match(/\b1\d{14}\b/);
        trn = m ? m[0] : '';
      }
      // Org address — used to infer the supplier's emirate so the
      // frontend can default Place of Supply for B2C invoices.
      const a = o.address || {};
      const addressBlob = [a.address, a.street2, a.city, a.state, a.country].filter(Boolean).join(', ');
      return JSON.stringify({
        error: null,
        name: o.name || '',
        currency_code: o.currency_code || 'AED',
        trn,
        address: addressBlob,
        city: a.city || '',
        state: a.state || '',
        country: a.country || '',
        apiUsage: lastApiUsage
      });
    }

    // Taxes configured in this Zoho org. UAE orgs typically expose
    // "Standard Rate" (5%), "Zero Rated" (0%), "Exempt" (0%), and
    // "Out of Scope" (0%). Returned as { id, name, percentage, type }
    // so the frontend can map a row to the correct tax based on the
    // chosen sales account / supply type.
    if (kind === 'taxes') {
      const j = await zohoGet('settings/taxes', accessToken, region, { organization_id: orgId });
      const taxes = (j.taxes || []).map((t: any) => ({
        id: t.tax_id,
        name: t.tax_name,
        percentage: Number(t.tax_percentage || 0),
        type: t.tax_type || '',
        specifier: t.tax_specifier || ''
      }));
      return JSON.stringify({ error: null, items: taxes, apiUsage: lastApiUsage });
    }

    // Recent entries — fetch expenses, journals, and customer payments
    // for a date range so the frontend can check for duplicates BEFORE
    // pushing. params = JSON string with optional fromDate / toDate
    // (YYYY-MM-DD). If absent, defaults to the last 365 days.
    if (kind === 'recentEntries') {
      let p: any = {};
      try { p = JSON.parse(event.arguments?.params || '{}'); } catch (_) { p = {}; }
      const today = new Date();
      const past = new Date(today.getTime() - 365 * 86400000);
      const fromDate = p.fromDate || past.toISOString().slice(0, 10);
      const toDate = p.toDate || today.toISOString().slice(0, 10);
      // `only` lets callers fetch just one slice — Learn-from-Zoho asks
      // for ['expenses'] so the call returns in seconds instead of
      // hitting AppSync's 30 s ceiling on busy orgs.
      const only: string[] = Array.isArray(p.only) && p.only.length > 0 ? p.only : ['expenses','journals','payments'];
      // Cap pagination — 10 pages × 200 = 2 000 entries per endpoint, more
      // than enough for any single learning pass. Old value of 20 could
      // stretch a single call to >30 s on orgs with thousands of journals.
      const maxPages = Math.max(1, Math.min(20, Number(p.maxPages || 10)));

      const pageAll = async (path: string, listKey: string) => {
        const out: any[] = [];
        let page = 1;
        while (true) {
          const j: any = await zohoGet(path, accessToken, region, {
            organization_id: orgId,
            date_start: fromDate,
            date_end: toDate,
            per_page: '200',
            page: String(page)
          });
          out.push(...(j[listKey] || []));
          if (!j.page_context || !j.page_context.has_more_page) break;
          page++;
          if (page > maxPages) break;
        }
        return out;
      };

      const wantExp = only.includes('expenses');
      const wantJrn = only.includes('journals');
      const wantPay = only.includes('payments');
      const [expRaw, jrnRaw, payRaw] = await Promise.all([
        wantExp ? pageAll('expenses', 'expenses') : Promise.resolve([] as any[]),
        wantJrn ? pageAll('journals', 'journals') : Promise.resolve([] as any[]),
        wantPay ? pageAll('customerpayments', 'customerpayments') : Promise.resolve([] as any[])
      ]);

      const expenses = expRaw.map((e: any) => ({
        id: e.expense_id,
        date: e.date,
        description: e.description || '',
        amount: Number(e.total || e.bcy_total || e.amount || 0),
        account: e.account_name || ''
      }));
      const journals = jrnRaw.map((j: any) => ({
        id: j.journal_id,
        date: j.journal_date,
        description: j.notes || j.reference_number || '',
        amount: Number(j.total || 0)
      }));
      const payments = payRaw.map((p: any) => ({
        id: p.payment_id,
        date: p.date,
        description: p.description || p.reference_number || '',
        amount: Number(p.amount || 0),
        customer: p.customer_name || ''
      }));

      return JSON.stringify({
        error: null,
        fromDate, toDate,
        expenses, journals, payments,
        apiUsage: lastApiUsage
      });
    }

    // Push operations — accept a JSON payload string and POST to Zoho.
    // Each push returns the Zoho response so the frontend can show the
    // created resource's id and surface specific errors per entry.
    // Create a customer (contact_type=customer). payload = { name, email?,
    // mobile?, gst_treatment?, trn? }. Used by the Revenue flow when a
    // bank-statement row references a customer that doesn't exist yet in
    // Zoho. UAE-specific: VAT/TRN goes onto the contact via tax_treatment
    // = 'vat_registered' / 'non_vat_registered' and trn field.
    if (kind === 'createCustomer') {
      const payloadStr = event.arguments?.payload || '';
      let p: any;
      try { p = JSON.parse(payloadStr); } catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      if (!p.contact_name) return JSON.stringify({ error: 'contact_name is required' });
      const body: any = {
        contact_name: p.contact_name,
        contact_type: 'customer',
        currency_code: p.currency_code || 'AED'
      };
      if (p.email) body.email = p.email;
      if (p.phone) body.phone = p.phone;
      if (p.trn) {
        body.tax_treatment = 'vat_registered';
        body.tax_reg_no = p.trn;
      } else {
        body.tax_treatment = p.tax_treatment || 'non_vat_registered';
      }
      if (p.country_code) body.country_code = p.country_code;
      // Billing / shipping address — Zoho stores them as structured
      // objects; callers may pass either a structured object or a single
      // string blob (the OCR pipeline does the latter), which we map to
      // `attention` so the line breaks survive in Zoho.
      const toAddress = (v: any) => {
        if (!v) return null;
        if (typeof v === 'string') {
          const t = v.trim();
          if (!t) return null;
          // Best-effort split: last comma-separated chunk → country/zip,
          // first → street. Keeps Zoho happy without faking structure.
          const parts = t.split(/\n|,/).map((s: string) => s.trim()).filter(Boolean);
          const out: any = { address: t };
          if (parts.length >= 1) out.address = parts[0];
          if (parts.length >= 2) out.street2 = parts.slice(1, -2).join(', ') || undefined;
          if (parts.length >= 3) out.city = parts[parts.length - 2];
          if (parts.length >= 2) out.country = parts[parts.length - 1];
          return out;
        }
        return v;
      };
      const billingAddr = toAddress(p.billing_address || p.address);
      if (billingAddr) body.billing_address = billingAddr;
      const shipAddr = toAddress(p.shipping_address || p.address);
      if (shipAddr) body.shipping_address = shipAddr;
      const j = await zohoPost('contacts', accessToken, region, { organization_id: orgId }, body);
      const contact = j.contact || {};
      return JSON.stringify({
        error: null,
        success: true,
        id: contact.contact_id || null,
        name: contact.contact_name || p.contact_name,
        raw: j,
        apiUsage: lastApiUsage
      });
    }

    // Create an invoice. payload is the Zoho-Books invoice body
    // (customer_id, date, due_date, line_items[], notes, terms,
    // currency_code, gst_treatment, tax_treatment, place_of_supply, ...).
    // UAE-specific: tax_treatment must be set (vat_registered /
    // vat_not_registered / non_gcc / dz_vat_registered etc) and each
    // line_item carries a tax_id from /settings/taxes.
    if (kind === 'createInvoice') {
      const payloadStr = event.arguments?.payload || '';
      let p: any;
      try { p = JSON.parse(payloadStr); } catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      if (!p.customer_id) return JSON.stringify({ error: 'customer_id is required' });
      if (!Array.isArray(p.line_items) || p.line_items.length === 0) return JSON.stringify({ error: 'at least one line_item is required' });
      let j: any;
      try {
        j = await zohoPost('invoices', accessToken, region, { organization_id: orgId }, p);
      } catch (e: any) {
        // Zoho's generic "code 6 / invalid value" doesn't say which field
        // is wrong. Echo the payload fields most likely to be the culprit
        // (place_of_supply, tax_treatment, currency_code, gst_treatment)
        // so the reviewer can see at a glance which value Zoho rejected.
        const hints: string[] = [];
        if (p.place_of_supply !== undefined) hints.push(`place_of_supply="${p.place_of_supply}"`);
        if (p.tax_treatment !== undefined)   hints.push(`tax_treatment="${p.tax_treatment}"`);
        if (p.currency_code !== undefined)   hints.push(`currency_code="${p.currency_code}"`);
        if (p.gst_treatment !== undefined)   hints.push(`gst_treatment="${p.gst_treatment}"`);
        if (p.vat_treatment !== undefined)   hints.push(`vat_treatment="${p.vat_treatment}"`);
        const suffix = hints.length ? ' · sent: ' + hints.join(', ') : '';
        console.error('[zoho-sync] createInvoice failed', { message: e?.message, payload: p });
        throw new Error((e?.message || String(e)) + suffix);
      }
      const inv = j.invoice || {};
      return JSON.stringify({
        error: null,
        success: true,
        id: inv.invoice_id || null,
        invoice_number: inv.invoice_number || '',
        balance: Number(inv.balance || 0),
        total: Number(inv.total || 0),
        raw: j,
        apiUsage: lastApiUsage
      });
    }

    // Attach a file (PDF / image) to an existing Zoho invoice. Zoho's
    // endpoint is /invoices/{id}/attachment with multipart/form-data,
    // field name "attachment". Frontend sends a base64 blob; we decode
    // and post via Node's built-in FormData + fetch.
    if (kind === 'attachToInvoice') {
      const payloadStr = event.arguments?.payload || '';
      let p: any;
      try { p = JSON.parse(payloadStr); } catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      const invoiceId = (p.invoiceId || '').trim();
      const fileBase64 = p.fileBase64 || '';
      const fileName = (p.fileName || 'invoice.pdf').replace(/[^\w.\-]/g, '_');
      const mimeType = p.mimeType || 'application/pdf';
      if (!invoiceId) return JSON.stringify({ error: 'invoiceId is required' });
      if (!fileBase64) return JSON.stringify({ error: 'fileBase64 is required' });
      const idx = fileBase64.indexOf(',');
      const raw = idx >= 0 && fileBase64.slice(0, idx).startsWith('data:') ? fileBase64.slice(idx + 1) : fileBase64;
      const bytes = (Buffer as any).from(raw, 'base64');
      const form = new FormData();
      form.append('attachment', new Blob([bytes], { type: mimeType }), fileName);
      const url = `https://www.zohoapis.${region}/books/v3/invoices/${invoiceId}/attachment?organization_id=${orgId}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Zoho-oauthtoken ' + accessToken },
        body: form as any
      });
      captureApiUsage(r.headers);
      const j: any = await r.json();
      if (!r.ok || j.code !== 0) {
        throw new Error((j.message || r.statusText) + (j.code ? ' [zoho code ' + j.code + ']' : ''));
      }
      return JSON.stringify({ error: null, success: true, message: j.message || 'Attached', apiUsage: lastApiUsage });
    }

    if (kind === 'pushExpense' || kind === 'pushJournal' || kind === 'pushPayment') {
      const payloadStr = event.arguments?.payload || '';
      let payload: any;
      try { payload = JSON.parse(payloadStr); }
      catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      const path = kind === 'pushExpense' ? 'expenses'
        : kind === 'pushJournal' ? 'journals'
        : 'customerpayments';
      const j = await zohoPost(path, accessToken, region, { organization_id: orgId }, payload);
      // Surface the new resource id where applicable.
      const resourceId = j.expense?.expense_id || j.journal?.journal_id || j.payment?.payment_id || null;
      return JSON.stringify({ error: null, success: true, id: resourceId, raw: j, apiUsage: lastApiUsage });
    }

    // Revert a previously-pushed entry. resourceId comes through `payload`
    // (the existing string argument, reused so we don't need a schema bump).
    if (kind === 'deleteExpense' || kind === 'deleteJournal' || kind === 'deletePayment') {
      const resourceId = (event.arguments?.payload || '').trim();
      if (!resourceId) return JSON.stringify({ error: 'resourceId is required (pass via payload)' });
      const path = kind === 'deleteExpense' ? `expenses/${resourceId}`
        : kind === 'deleteJournal' ? `journals/${resourceId}`
        : `customerpayments/${resourceId}`;
      const j = await zohoDelete(path, accessToken, region, { organization_id: orgId });
      return JSON.stringify({ error: null, success: true, message: j.message || 'Deleted', apiUsage: lastApiUsage });
    }

    return JSON.stringify({ error: 'unknown kind: ' + kind });
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || 'zoho-sync failed', apiUsage: lastApiUsage });
  }
};
