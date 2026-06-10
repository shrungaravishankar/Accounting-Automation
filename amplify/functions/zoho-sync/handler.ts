declare const process: { env: Record<string, string | undefined> };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type Event = {
  arguments: { kind: string; organizationId?: string; payload?: string };
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

async function zohoGet(path: string, accessToken: string, region: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://www.zohoapis.${region}/books/v3/${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, {
    headers: { Authorization: 'Zoho-oauthtoken ' + accessToken }
  });
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
  const j: any = await r.json();
  if (!r.ok || j.code !== 0) {
    // Zoho returns its own error code in j.code (0 = success) and j.message
    // with a human-readable reason. Surface both to the caller.
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
      return JSON.stringify({ error: null, items: orgs });
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
      return JSON.stringify({ error: null, items: accounts });
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
      return JSON.stringify({ error: null, items: names, idByName });
    }

    // Open invoices for a given org — used to link Payment Received entries
    // to specific invoices instead of creating unapplied payments.
    if (kind === 'openInvoices') {
      const all: any[] = [];
      let page = 1;
      while (true) {
        const j = await zohoGet('invoices', accessToken, region, {
          organization_id: orgId,
          status: 'unpaid,partially_paid,overdue,sent',
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
      return JSON.stringify({ error: null, items: invoices });
    }

    // Push operations — accept a JSON payload string and POST to Zoho.
    // Each push returns the Zoho response so the frontend can show the
    // created resource's id and surface specific errors per entry.
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
      return JSON.stringify({ error: null, success: true, id: resourceId, raw: j });
    }

    return JSON.stringify({ error: 'unknown kind: ' + kind });
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || 'zoho-sync failed' });
  }
};
