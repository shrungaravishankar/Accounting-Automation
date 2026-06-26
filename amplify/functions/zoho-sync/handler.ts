declare const process: { env: Record<string, string | undefined> };
declare const Buffer: { from(input: string, encoding: string): Uint8Array };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type Event = {
  arguments: { kind: string; organizationId?: string; payload?: string; params?: string };
  identity?: { username?: string; sub?: string; claims?: Record<string, any> };
};

// Tracks whether Zoho returned a rotated refresh_token in the last
// refresh response. Zoho's docs say the refresh token is stable, but a
// small number of flows (consent-prompt re-grants, scope changes) do
// return a fresh token — when that happens we persist it so the
// integration stays connected. The handler reads this after the call
// and writes the new token back to DDB.
let lastRotatedRefreshToken: string | null = null;

async function getAccessToken(refreshToken: string, region: string): Promise<string> {
  lastRotatedRefreshToken = null;
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
      ? ' — your Zoho refresh token is no longer valid. Open the sidebar → click your name → Connect to Zoho to re-authorise.'
      : '';
    throw new Error('Could not refresh Zoho access token: ' + msg + hint);
  }
  // Zoho usually keeps the refresh_token stable across refresh calls, but
  // when it does rotate (consent re-grant, scope change), capture the new
  // one so the caller can persist it — otherwise the next refresh would
  // fail with "Access Denied" the moment Zoho's side rotates.
  if (j.refresh_token && j.refresh_token !== refreshToken) {
    lastRotatedRefreshToken = j.refresh_token;
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

    // Stamp lastUsedAt — best-effort. Also persist a rotated
    // refresh_token if Zoho returned one, so the integration stays
    // connected without a manual reconnect.
    const updateExpr = lastRotatedRefreshToken
      ? 'SET lastUsedAt = :u, refreshToken = :t'
      : 'SET lastUsedAt = :u';
    const updateVals: any = { ':u': new Date().toISOString() };
    if (lastRotatedRefreshToken) updateVals[':t'] = lastRotatedRefreshToken;
    ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { id: cred.id },
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: updateVals
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

    // Bank accounts for a given org — used by the Bank Statement Upload
    // tab. Returns every bank-like account configured in Zoho Books
    // (bank / credit_card / paypal). Each entry exposes the exact
    // account name Zoho uses on journal entries so the user does not
    // have to type it manually.
    if (kind === 'bankAccounts') {
      const all: any[] = [];
      let page = 1;
      while (true) {
        const j = await zohoGet('bankaccounts', accessToken, region, {
          organization_id: orgId,
          per_page: '200',
          page: String(page)
        });
        all.push(...(j.bankaccounts || []));
        if (!j.page_context || !j.page_context.has_more_page) break;
        page++;
        if (page > 20) break;
      }
      const accounts = all
        .filter((a: any) => a.is_active !== false)
        // Only real bank accounts — drop cash, credit_card, paypal and any
        // other non-bank ledgers that Zoho also exposes via /bankaccounts.
        .filter((a: any) => (a.account_type || '').toLowerCase() === 'bank')
        .map((a: any) => ({
          account_id: a.account_id,
          account_name: a.account_name,
          account_code: a.account_code || '',
          account_type: a.account_type,
          account_number: a.account_number || '',
          currency_code: a.currency_code || '',
          uncategorized_transactions: Number(a.uncategorized_transactions || 0),
          is_primary_account: !!a.is_primary_account,
          // Books balance + last-synced date — used by the upload screen
          // to sanity-check the CSV's auto-calculated closing balance.
          balance: Number(a.balance || 0),
          last_synced_date: a.last_synced_date || a.last_imported_date || '',
          status: a.status || 'active'
        }));
      return JSON.stringify({ error: null, items: accounts, apiUsage: lastApiUsage });
    }

    // Open bills for a given org — used by the Bills flow on the bank
    // statement review to apply a debit payment against an existing vendor
    // bill instead of creating a standalone expense. Mirrors openInvoices.
    if (kind === 'openBills') {
      const all: any[] = [];
      let page = 1;
      while (true) {
        // Zoho Books bills filter values: Status.Open (open + overdue +
        // partially paid). Anything else with balance>0 is filtered below.
        const j = await zohoGet('bills', accessToken, region, {
          organization_id: orgId,
          filter_by: 'Status.Open',
          per_page: '200',
          page: String(page)
        });
        all.push(...(j.bills || []));
        if (!j.page_context || !j.page_context.has_more_page) break;
        page++;
        if (page > 20) break;
      }
      const bills = all
        .filter((b: any) => Number(b.balance) > 0)
        .map((b: any) => ({
          bill_id: b.bill_id,
          bill_number: b.bill_number,
          vendor_id: b.vendor_id,
          vendor_name: b.vendor_name,
          date: b.date,
          due_date: b.due_date,
          total: Number(b.total),
          balance: Number(b.balance),
          status: b.status
        }));
      return JSON.stringify({ error: null, items: bills, apiUsage: lastApiUsage });
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

    // Bills by exact bill_number — duplicate detection for the Bill OCR
    // module. Mirrors findInvoice. params = JSON { billNumber, vendorName? }.
    if (kind === 'findBill') {
      let p: any = {};
      try { p = JSON.parse(event.arguments?.params || '{}'); } catch (_) { p = {}; }
      const billNo = (p.billNumber || '').trim();
      if (!billNo) return JSON.stringify({ error: 'billNumber is required (pass via params)' });
      const j = await zohoGet('bills', accessToken, region, {
        organization_id: orgId,
        bill_number: billNo
      });
      const matches = (j.bills || []).map((b: any) => ({
        bill_id: b.bill_id,
        bill_number: b.bill_number,
        vendor_id: b.vendor_id,
        vendor_name: b.vendor_name,
        date: b.date,
        total: Number(b.total),
        balance: Number(b.balance),
        status: b.status
      }));
      return JSON.stringify({ error: null, items: matches, apiUsage: lastApiUsage });
    }

    // Vendor search — mirror of searchCustomer. Used by Bill OCR push to
    // detect existing vendors before createVendor.
    if (kind === 'searchVendor') {
      const payloadStr = event.arguments?.payload || '';
      let p: any;
      try { p = JSON.parse(payloadStr); } catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      const name = String(p.name || '').trim();
      if (!name) return JSON.stringify({ error: null, matches: [], apiUsage: lastApiUsage });
      try {
        const j = await zohoGet('contacts', accessToken, region, {
          organization_id: orgId!,
          contact_name_contains: name,
          contact_type: 'vendor',
          per_page: '20'
        });
        const matches = (j?.contacts || []).map((c: any) => ({
          contact_id: c.contact_id,
          contact_name: c.contact_name,
          contact_type: c.contact_type,
          email: c.email,
          status: c.status,
          // TRN is the key field for Bill OCR validation.
          trn: c.tax_reg_no || c.trn || ''
        }));
        return JSON.stringify({ error: null, matches, apiUsage: lastApiUsage });
      } catch (e: any) {
        return JSON.stringify({ error: e?.message || String(e), matches: [], apiUsage: lastApiUsage });
      }
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
      // Floating pair — fetch the historical reference rate for the
      // invoice date from Frankfurter (ECB data, free, no key).
      // Frankfurter doesn't quote AED directly (ECB only publishes the
      // ~30 reference currencies), but AED is hard-pegged to USD at
      // 3.6725, so for *→AED we fetch *→USD on the invoice date and
      // multiply by the peg. Same trick for AED→* via USD. Weekend/
      // holiday dates: Frankfurter returns the most recent prior
      // working-day rate (its `date` field tells us which).
      const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : '';
      const usdToAed = 3.6725;
      const frankfurter = async (base: string, sym: string) => {
        // Use the .dev host directly — .app issues a 301 to .dev that
        // node-fetch in the Lambda runtime doesn't always follow for
        // cross-host redirects, which silently breaks the lookup.
        const r = await fetch(`https://api.frankfurter.dev/v1/${isoDate}?base=${base}&symbols=${sym}`);
        const j: any = await r.json();
        return { rate: j && j.rates && j.rates[sym], dateUsed: j && j.date };
      };
      if (isoDate) {
        try {
          let rate: number | null = null;
          let dateUsed: string | null = null;
          if (to === 'AED' && from !== 'AED') {
            const f = await frankfurter(from, 'USD');
            if (f.rate) { rate = Number(f.rate) * usdToAed; dateUsed = f.dateUsed; }
          } else if (from === 'AED' && to !== 'AED') {
            const f = await frankfurter('USD', to);
            if (f.rate) { rate = Number(f.rate) / usdToAed; dateUsed = f.dateUsed; }
          } else {
            const f = await frankfurter(from, to);
            if (f.rate) { rate = Number(f.rate); dateUsed = f.dateUsed; }
          }
          if (rate) {
            return JSON.stringify({ error: null, rate: Math.round(rate * 100000) / 100000, source: `frankfurter.dev (ECB reference rate, ${dateUsed || isoDate}${to === 'AED' || from === 'AED' ? ' · via USD @ 3.6725 peg' : ''})`, dateUsed: dateUsed || isoDate, apiUsage: lastApiUsage });
          }
        } catch (_) { /* fall through to latest */ }
      }
      try {
        const r = await fetch(`https://open.er-api.com/v6/latest/${from}`);
        const j: any = await r.json();
        const rate = j && j.rates && j.rates[to];
        if (rate) {
          return JSON.stringify({ error: null, rate: Math.round(Number(rate) * 100000) / 100000, source: 'open.er-api.com (latest reference rate — historical lookup failed)', dateUsed: new Date().toISOString().slice(0, 10), apiUsage: lastApiUsage });
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

    // Search Zoho contacts by name (fuzzy contains match). Used by the
    // Revenue push flow to detect customers that already exist in Zoho
    // before creating a duplicate. payload = { name }. Returns
    // { matches: [{ contact_id, contact_name, contact_type, email }, ...] }
    // ordered by Zoho's relevance (closest first).
    if (kind === 'searchCustomer') {
      const payloadStr = event.arguments?.payload || '';
      let p: any;
      try { p = JSON.parse(payloadStr); } catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      const name = String(p.name || '').trim();
      if (!name) return JSON.stringify({ error: null, matches: [], apiUsage: lastApiUsage });
      try {
        const j = await zohoGet('contacts', accessToken, region, {
          organization_id: orgId!,
          contact_name_contains: name,
          contact_type: 'customer',
          per_page: '20'
        });
        const matches = (j?.contacts || []).map((c: any) => ({
          contact_id: c.contact_id,
          contact_name: c.contact_name,
          contact_type: c.contact_type,
          email: c.email,
          status: c.status
        }));
        return JSON.stringify({ error: null, matches, apiUsage: lastApiUsage });
      } catch (e: any) {
        return JSON.stringify({ error: e?.message || String(e), matches: [], apiUsage: lastApiUsage });
      }
    }

    // Push operations — accept a JSON payload string and POST to Zoho.
    // Each push returns the Zoho response so the frontend can show the
    // created resource's id and surface specific errors per entry.
    // Create a customer (contact_type=customer). payload = { name, email?,
    // mobile?, gst_treatment?, trn? }. Used by the Revenue flow when a
    // bank-statement row references a customer that doesn't exist yet in
    // Zoho. UAE-specific: VAT/TRN goes onto the contact via tax_treatment
    // = 'vat_registered' / 'vat_not_registered' and trn field.
    if (kind === 'createCustomer') {
      const payloadStr = event.arguments?.payload || '';
      let p: any;
      try { p = JSON.parse(payloadStr); } catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      if (!p.contact_name) return JSON.stringify({ error: 'contact_name is required' });
      // Resolve currency_id from currency_code. Zoho's Contact API
      // silently ignores currency_code when no currency_id is supplied
      // and falls back to the org's base currency — that's why USD
      // invoices were creating AED contacts. Fetch the org's enabled
      // currencies and map the code; fail loudly if the currency isn't
      // enabled so the user knows to add it in Zoho first.
      const wantedCode = (p.currency_code || 'AED').toUpperCase();
      let resolvedCurrencyId: string | null = null;
      try {
        const curList = await zohoGet('settings/currencies', accessToken, region, { organization_id: orgId! });
        const all = (curList?.currencies || []) as any[];
        const hit = all.find(c => String(c.currency_code || '').toUpperCase() === wantedCode);
        if (hit) resolvedCurrencyId = String(hit.currency_id);
        else {
          const enabled = all.map(c => c.currency_code).join(', ');
          throw new Error(`Currency ${wantedCode} is not enabled in this Zoho organisation. Enabled: ${enabled || '(none)'}. Add it in Zoho → Settings → Currencies, then retry.`);
        }
      } catch (e: any) {
        // Hard fail — otherwise Zoho silently downgrades to AED.
        return JSON.stringify({ error: e?.message || String(e) });
      }
      const body: any = {
        contact_name: p.contact_name,
        contact_type: 'customer',
        currency_id: resolvedCurrencyId,
        currency_code: wantedCode
      };
      if (p.email) body.email = p.email;
      if (p.phone) body.phone = p.phone;
      // tax_treatment value is country-bucketed in Zoho UAE edition:
      //   AE                              → vat_registered / vat_not_registered
      //   GCC (SA/OM/BH/QA/KW)            → gcc_vat_registered / gcc_vat_not_registered
      //   Everything else (Spain etc.)    → omit; Zoho rejects "non_gcc"
      //     on contacts with "Invalid Element tax_treatment [zoho code 8]"
      //     and infers the treatment from billing_address.country on its own.
      const cc = String(p.country_code || '').toUpperCase();
      const isAE = cc === 'AE';
      const isGCC = ['SA','OM','BH','QA','KW'].includes(cc);
      const hasTrn = !!p.trn;
      if (isAE) {
        body.tax_treatment = hasTrn ? 'vat_registered' : 'vat_not_registered';
      } else if (isGCC) {
        body.tax_treatment = hasTrn ? 'gcc_vat_registered' : 'gcc_vat_not_registered';
      }
      if (hasTrn) body.tax_reg_no = p.trn;
      // Zoho's Contacts API doesn't accept `country_code` at the root —
      // it wants the country NAME inside billing_address.country /
      // shipping_address.country. We map the ISO-2 code that the
      // frontend sends to the full name Zoho's UI displays. Anything
      // unmapped falls through as the raw code (still valid, just less
      // pretty in the Zoho UI).
      // Full ISO 3166-1 → Zoho display-name map. Names match Zoho's own
      // country dropdown conventions ("Türkiye", "Czech Republic",
      // "United Arab Emirates", etc.) so the contact's Country/Region
      // looks identical to a manually-created one.
      const COUNTRY_NAMES: Record<string,string> = {
        AF:'Afghanistan',AX:'Åland Islands',AL:'Albania',DZ:'Algeria',AS:'American Samoa',AD:'Andorra',AO:'Angola',AI:'Anguilla',AQ:'Antarctica',AG:'Antigua and Barbuda',
        AR:'Argentina',AM:'Armenia',AW:'Aruba',AU:'Australia',AT:'Austria',AZ:'Azerbaijan',BS:'Bahamas',BH:'Bahrain',BD:'Bangladesh',BB:'Barbados',
        BY:'Belarus',BE:'Belgium',BZ:'Belize',BJ:'Benin',BM:'Bermuda',BT:'Bhutan',BO:'Bolivia',BA:'Bosnia and Herzegovina',BW:'Botswana',BR:'Brazil',
        IO:'British Indian Ocean Territory',VG:'British Virgin Islands',BN:'Brunei',BG:'Bulgaria',BF:'Burkina Faso',BI:'Burundi',KH:'Cambodia',CM:'Cameroon',CA:'Canada',CV:'Cape Verde',
        KY:'Cayman Islands',CF:'Central African Republic',TD:'Chad',CL:'Chile',CN:'China',CX:'Christmas Island',CC:'Cocos (Keeling) Islands',CO:'Colombia',KM:'Comoros',CK:'Cook Islands',
        CR:'Costa Rica',HR:'Croatia',CU:'Cuba',CW:'Curaçao',CY:'Cyprus',CZ:'Czech Republic',CD:'Democratic Republic of the Congo',DK:'Denmark',DJ:'Djibouti',DM:'Dominica',
        DO:'Dominican Republic',TL:'East Timor',EC:'Ecuador',EG:'Egypt',SV:'El Salvador',GQ:'Equatorial Guinea',ER:'Eritrea',EE:'Estonia',SZ:'Eswatini',ET:'Ethiopia',
        FK:'Falkland Islands',FO:'Faroe Islands',FJ:'Fiji',FI:'Finland',FR:'France',GF:'French Guiana',PF:'French Polynesia',GA:'Gabon',GM:'Gambia',GE:'Georgia',
        DE:'Germany',GH:'Ghana',GI:'Gibraltar',GR:'Greece',GL:'Greenland',GD:'Grenada',GP:'Guadeloupe',GU:'Guam',GT:'Guatemala',GG:'Guernsey',
        GN:'Guinea',GW:'Guinea-Bissau',GY:'Guyana',HT:'Haiti',HN:'Honduras',HK:'Hong Kong',HU:'Hungary',IS:'Iceland',IN:'India',ID:'Indonesia',
        IR:'Iran',IQ:'Iraq',IE:'Ireland',IM:'Isle of Man',IL:'Israel',IT:'Italy',CI:'Ivory Coast',JM:'Jamaica',JP:'Japan',JE:'Jersey',
        JO:'Jordan',KZ:'Kazakhstan',KE:'Kenya',KI:'Kiribati',XK:'Kosovo',KW:'Kuwait',KG:'Kyrgyzstan',LA:'Laos',LV:'Latvia',LB:'Lebanon',
        LS:'Lesotho',LR:'Liberia',LY:'Libya',LI:'Liechtenstein',LT:'Lithuania',LU:'Luxembourg',MO:'Macao',MG:'Madagascar',MW:'Malawi',MY:'Malaysia',
        MV:'Maldives',ML:'Mali',MT:'Malta',MH:'Marshall Islands',MQ:'Martinique',MR:'Mauritania',MU:'Mauritius',YT:'Mayotte',MX:'Mexico',FM:'Micronesia',
        MD:'Moldova',MC:'Monaco',MN:'Mongolia',ME:'Montenegro',MS:'Montserrat',MA:'Morocco',MZ:'Mozambique',MM:'Myanmar',NA:'Namibia',NR:'Nauru',
        NP:'Nepal',NL:'Netherlands',NC:'New Caledonia',NZ:'New Zealand',NI:'Nicaragua',NE:'Niger',NG:'Nigeria',NU:'Niue',NF:'Norfolk Island',KP:'North Korea',
        MK:'North Macedonia',MP:'Northern Mariana Islands',NO:'Norway',OM:'Oman',PK:'Pakistan',PW:'Palau',PS:'Palestine',PA:'Panama',PG:'Papua New Guinea',PY:'Paraguay',
        PE:'Peru',PH:'Philippines',PN:'Pitcairn Islands',PL:'Poland',PT:'Portugal',PR:'Puerto Rico',QA:'Qatar',CG:'Republic of the Congo',RE:'Réunion',RO:'Romania',
        RU:'Russia',RW:'Rwanda',BL:'Saint Barthélemy',SH:'Saint Helena',KN:'Saint Kitts and Nevis',LC:'Saint Lucia',MF:'Saint Martin',PM:'Saint Pierre and Miquelon',VC:'Saint Vincent and the Grenadines',WS:'Samoa',
        SM:'San Marino',ST:'São Tomé and Príncipe',SA:'Saudi Arabia',SN:'Senegal',RS:'Serbia',SC:'Seychelles',SL:'Sierra Leone',SG:'Singapore',SX:'Sint Maarten',SK:'Slovakia',
        SI:'Slovenia',SB:'Solomon Islands',SO:'Somalia',ZA:'South Africa',KR:'South Korea',SS:'South Sudan',ES:'Spain',LK:'Sri Lanka',SD:'Sudan',SR:'Suriname',
        SJ:'Svalbard and Jan Mayen',SE:'Sweden',CH:'Switzerland',SY:'Syria',TW:'Taiwan',TJ:'Tajikistan',TZ:'Tanzania',TH:'Thailand',TG:'Togo',TK:'Tokelau',
        TO:'Tonga',TT:'Trinidad and Tobago',TN:'Tunisia',TR:'Türkiye',TM:'Turkmenistan',TC:'Turks and Caicos Islands',TV:'Tuvalu',UG:'Uganda',UA:'Ukraine',AE:'United Arab Emirates',
        GB:'United Kingdom',US:'United States',UY:'Uruguay',UZ:'Uzbekistan',VU:'Vanuatu',VA:'Vatican City',VE:'Venezuela',VN:'Vietnam',WF:'Wallis and Futuna',EH:'Western Sahara',
        YE:'Yemen',ZM:'Zambia',ZW:'Zimbabwe',
      };
      const countryName = p.country_code ? (COUNTRY_NAMES[String(p.country_code).toUpperCase()] || p.country_code) : '';
      // place_of_supply applies only to UAE customers — it's the
      // emirate where the supply lands per Art. 27. For non-UAE
      // contacts Zoho rejects the element entirely. Only send it when
      // the customer's country is AE.
      if (isAE && p.place_of_supply) body.place_of_supply = p.place_of_supply;
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
      if (billingAddr) {
        // Zoho's contact billing_address uses `country` (full name),
        // not `country_code`. Override whatever toAddress() inferred
        // from the last comma-separated chunk with the explicit value
        // the user picked in the review modal.
        if (countryName) billingAddr.country = countryName;
        body.billing_address = billingAddr;
      }
      const shipAddr = toAddress(p.shipping_address || p.address);
      if (shipAddr) {
        if (countryName) shipAddr.country = countryName;
        body.shipping_address = shipAddr;
      }
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

    // Create a vendor (contact_type=vendor). Mirror of createCustomer —
    // used by Bill OCR when the extracted vendor isn't in Zoho yet.
    // payload = { contact_name, email?, phone?, country_code?, trn?,
    //   currency_code? }.
    if (kind === 'createVendor') {
      const payloadStr = event.arguments?.payload || '';
      let p: any;
      try { p = JSON.parse(payloadStr); } catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      if (!p.contact_name) return JSON.stringify({ error: 'contact_name is required' });
      const wantedCode = (p.currency_code || 'AED').toUpperCase();
      let resolvedCurrencyId: string | null = null;
      try {
        const curList = await zohoGet('settings/currencies', accessToken, region, { organization_id: orgId! });
        const all = (curList?.currencies || []) as any[];
        const hit = all.find((c: any) => String(c.currency_code || '').toUpperCase() === wantedCode);
        if (hit) resolvedCurrencyId = String(hit.currency_id);
        else {
          const enabled = all.map((c: any) => c.currency_code).join(', ');
          throw new Error(`Currency ${wantedCode} is not enabled in this Zoho organisation. Enabled: ${enabled || '(none)'}. Add it in Zoho → Settings → Currencies, then retry.`);
        }
      } catch (e: any) {
        return JSON.stringify({ error: e?.message || String(e) });
      }
      const body: any = {
        contact_name: p.contact_name,
        contact_type: 'vendor',
        currency_id: resolvedCurrencyId,
        currency_code: wantedCode
      };
      if (p.email) body.email = p.email;
      if (p.phone) body.phone = p.phone;
      const cc = String(p.country_code || '').toUpperCase();
      const isAE = cc === 'AE' || !cc; // default UAE
      const isGCC = ['SA','OM','BH','QA','KW'].includes(cc);
      const hasTrn = !!p.trn;
      if (isAE) body.tax_treatment = hasTrn ? 'vat_registered' : 'vat_not_registered';
      else if (isGCC) body.tax_treatment = hasTrn ? 'gcc_vat_registered' : 'gcc_vat_not_registered';
      if (hasTrn) body.tax_reg_no = p.trn;
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

    // Create a bill. Mirror of createInvoice but posts to /bills.
    // payload = { vendor_id, bill_number, date, due_date?, line_items[],
    //   currency_code, notes?, terms? }. Each line_item carries tax_id
    //   from /settings/taxes (input VAT for bills).
    if (kind === 'createBill') {
      const payloadStr = event.arguments?.payload || '';
      let p: any;
      try { p = JSON.parse(payloadStr); } catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      if (!p.vendor_id) return JSON.stringify({ error: 'vendor_id is required' });
      if (!Array.isArray(p.line_items) || p.line_items.length === 0) return JSON.stringify({ error: 'at least one line_item is required' });
      let j: any;
      try {
        j = await zohoPost('bills', accessToken, region, { organization_id: orgId }, p);
      } catch (e: any) {
        const hints: string[] = [];
        if (p.tax_treatment !== undefined) hints.push(`tax_treatment="${p.tax_treatment}"`);
        if (p.currency_code !== undefined) hints.push(`currency_code="${p.currency_code}"`);
        if (p.bill_number  !== undefined) hints.push(`bill_number="${p.bill_number}"`);
        const suffix = hints.length ? ' · sent: ' + hints.join(', ') : '';
        console.error('[zoho-sync] createBill failed', { message: e?.message, payload: p });
        throw new Error((e?.message || String(e)) + suffix);
      }
      const bill = j.bill || {};
      return JSON.stringify({
        error: null,
        success: true,
        id: bill.bill_id || null,
        bill_number: bill.bill_number || p.bill_number,
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
        let suffix = hints.length ? ' · sent: ' + hints.join(', ') : '';
        // When Zoho rejects place_of_supply / tax_treatment, fetch the
        // most recent existing invoice in the org and append the actual
        // values it has stored — that's ground truth for what Zoho's API
        // accepts for this organisation, no more guessing.
        const msg = String(e?.message || '');
        const wantsGroundTruth = /place_of_supply|tax_treatment|gst_treatment|vat_treatment/i.test(msg) || /\[zoho code (?:2|6|7)\]/.test(msg);
        if (wantsGroundTruth) {
          try {
            const list = await zohoGet('invoices', accessToken, region, { organization_id: orgId!, per_page: '1', sort_column: 'date', sort_order: 'D' });
            const recent = (list?.invoices || [])[0];
            if (recent && recent.invoice_id) {
              const full = await zohoGet(`invoices/${recent.invoice_id}`, accessToken, region, { organization_id: orgId! });
              const inv = full?.invoice || {};
              const truth: string[] = [];
              if (inv.place_of_supply !== undefined) truth.push(`place_of_supply="${inv.place_of_supply}"`);
              if (inv.tax_treatment !== undefined)   truth.push(`tax_treatment="${inv.tax_treatment}"`);
              if (inv.gst_treatment !== undefined)   truth.push(`gst_treatment="${inv.gst_treatment}"`);
              if (inv.vat_treatment !== undefined)   truth.push(`vat_treatment="${inv.vat_treatment}"`);
              if (truth.length) suffix += ' · Zoho stores on a real invoice: ' + truth.join(', ');
            }
          } catch (_) { /* best-effort */ }
        }
        console.error('[zoho-sync] createInvoice failed', { message: e?.message, payload: p });
        throw new Error((e?.message || String(e)) + suffix);
      }
      const inv = j.invoice || {};
      // Zoho creates invoices in 'draft' status by default. The Revenue
      // OCR workflow represents a real, issued invoice — mark it as Sent
      // immediately via /invoices/{id}/status/sent. Best-effort: if the
      // status flip fails we still return success for the creation, with
      // markSentError populated so the frontend can surface a warning.
      let markSentError: string | null = null;
      if (inv.invoice_id) {
        try {
          await zohoPost(`invoices/${inv.invoice_id}/status/sent`, accessToken, region, { organization_id: orgId! }, {});
        } catch (e: any) {
          markSentError = e?.message || String(e);
          console.warn('[zoho-sync] mark-sent failed for', inv.invoice_id, markSentError);
        }
      }
      return JSON.stringify({
        error: null,
        success: true,
        id: inv.invoice_id || null,
        invoice_number: inv.invoice_number || '',
        balance: Number(inv.balance || 0),
        total: Number(inv.total || 0),
        markSentError,
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

    if (kind === 'pushExpense' || kind === 'pushJournal' || kind === 'pushPayment' || kind === 'pushBillPayment') {
      const payloadStr = event.arguments?.payload || '';
      let payload: any;
      try { payload = JSON.parse(payloadStr); }
      catch (_) { return JSON.stringify({ error: 'payload must be a JSON string' }); }
      const path = kind === 'pushExpense' ? 'expenses'
        : kind === 'pushJournal' ? 'journals'
        : kind === 'pushBillPayment' ? 'vendorpayments'
        : 'customerpayments';
      const j = await zohoPost(path, accessToken, region, { organization_id: orgId }, payload);
      // Surface the new resource id where applicable.
      const resourceId = j.expense?.expense_id || j.journal?.journal_id || j.payment?.payment_id || j.vendorpayment?.payment_id || null;
      return JSON.stringify({ error: null, success: true, id: resourceId, raw: j, apiUsage: lastApiUsage });
    }

    // Revert a previously-pushed entry. resourceId comes through `payload`
    // (the existing string argument, reused so we don't need a schema bump).
    if (kind === 'deleteExpense' || kind === 'deleteJournal' || kind === 'deletePayment' || kind === 'deleteBillPayment') {
      const resourceId = (event.arguments?.payload || '').trim();
      if (!resourceId) return JSON.stringify({ error: 'resourceId is required (pass via payload)' });
      const path = kind === 'deleteExpense' ? `expenses/${resourceId}`
        : kind === 'deleteJournal' ? `journals/${resourceId}`
        : kind === 'deleteBillPayment' ? `vendorpayments/${resourceId}`
        : `customerpayments/${resourceId}`;
      const j = await zohoDelete(path, accessToken, region, { organization_id: orgId });
      return JSON.stringify({ error: null, success: true, message: j.message || 'Deleted', apiUsage: lastApiUsage });
    }

    return JSON.stringify({ error: 'unknown kind: ' + kind });
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || 'zoho-sync failed', apiUsage: lastApiUsage });
  }
};
