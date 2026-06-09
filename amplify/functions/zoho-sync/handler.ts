declare const process: { env: Record<string, string | undefined> };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type Event = {
  arguments: { kind: string; organizationId?: string };
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
      // Paginate — chart of accounts can be 100s of entries.
      const all: any[] = [];
      let page = 1;
      // Zoho's per_page max is 200 for COA on most accounts.
      while (true) {
        const j = await zohoGet('chartofaccounts', accessToken, region, {
          organization_id: orgId,
          per_page: '200',
          page: String(page)
        });
        all.push(...(j.chartofaccounts || []));
        if (!j.page_context || !j.page_context.has_more_page) break;
        page++;
        if (page > 20) break; // hard cap
      }
      const accounts = all.map((a: any) => ({
        name: a.account_name,
        type: a.account_type || '',
        code: a.account_code || ''
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
      const names = all.map((c: any) => c.contact_name).filter(Boolean);
      return JSON.stringify({ error: null, items: names });
    }

    return JSON.stringify({ error: 'unknown kind: ' + kind });
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || 'zoho-sync failed' });
  }
};
