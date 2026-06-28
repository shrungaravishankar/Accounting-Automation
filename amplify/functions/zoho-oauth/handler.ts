declare const process: { env: Record<string, string | undefined> };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type Event = {
  arguments: { code: string };
  identity?: { username?: string; sub?: string; claims?: Record<string, any> };
};

export const handler = async (event: Event) => {
  const code = event.arguments?.code;
  if (!code) return JSON.stringify({ success: false, message: 'Missing authorization code.' });

  const claims = (event.identity?.claims || {}) as any;
  const ownerEmail = (claims.email || event.identity?.username || '').toLowerCase();
  const ownerSub = claims.sub || event.identity?.sub || '';
  if (!ownerEmail || !ownerSub) {
    return JSON.stringify({ success: false, message: 'Could not determine caller identity.' });
  }

  const region = process.env.ZOHO_REGION || 'com';
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const redirectUri = process.env.ZOHO_REDIRECT_URI;
  const tableName = process.env.ZOHOCRED_TABLE_NAME;

  const missing: string[] = [];
  if (!clientId) missing.push('ZOHO_CLIENT_ID');
  if (!clientSecret) missing.push('ZOHO_CLIENT_SECRET');
  if (!redirectUri) missing.push('ZOHO_REDIRECT_URI');
  if (!tableName) missing.push('ZOHOCRED_TABLE_NAME');
  if (missing.length) {
    return JSON.stringify({ success: false, message: 'Server misconfiguration — missing: ' + missing.join(', ') });
  }

  try {
    // Exchange the auth code for a refresh + access token.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code
    });
    const tokRes = await fetch(`https://accounts.zoho.${region}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const rawText = await tokRes.text();
    let tok: any;
    try { tok = JSON.parse(rawText); }
    catch (parseErr) {
      console.error('[zoho-oauth] Non-JSON response from Zoho:', tokRes.status, rawText.slice(0, 500));
      return JSON.stringify({
        success: false,
        message: `Zoho returned a non-JSON response (HTTP ${tokRes.status}). Check the Lambda logs — first 200 chars: ${rawText.slice(0, 200)}`
      });
    }
    if (!tokRes.ok || !tok.refresh_token) {
      console.error('[zoho-oauth] Zoho rejected:', tokRes.status, tok);
      return JSON.stringify({
        success: false,
        message: 'Zoho rejected the code: ' + (tok.error || tok.error_description || tokRes.statusText)
      });
    }

    // Upsert: one credentials row per Admin. If they reconnect, overwrite.
    const existing = await ddb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'ownerEmail = :e',
      ExpressionAttributeValues: { ':e': ownerEmail },
      Limit: 1
    }));
    const now = new Date().toISOString();
    if (existing.Items && existing.Items[0]) {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { id: existing.Items[0].id },
        // Clear any cached access token so the new refresh token is used to
        // mint a fresh one on the next call (zoho-sync caches access tokens).
        UpdateExpression: 'SET refreshToken = :t, #r = :rg, connectedAt = :c, lastUsedAt = :u, #o = :o, accessToken = :empty, accessTokenExpiry = :zero',
        ExpressionAttributeNames: { '#r': 'region', '#o': 'owner' },
        ExpressionAttributeValues: {
          ':t': tok.refresh_token,
          ':rg': region,
          ':c': now,
          ':u': now,
          ':o': existing.Items[0].owner || (ownerSub + '::' + ownerSub),
          ':empty': '',
          ':zero': 0
        }
      }));
    } else {
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: {
          id: crypto.randomUUID(),
          owner: ownerSub + '::' + ownerSub, // matches Amplify's owner format <sub>::<sub>
          ownerEmail,
          refreshToken: tok.refresh_token,
          region,
          connectedAt: now,
          lastUsedAt: now,
          createdAt: now,
          updatedAt: now,
          __typename: 'ZohoCredentials'
        }
      }));
    }

    return JSON.stringify({ success: true, message: 'Connected to Zoho.' });
  } catch (err: any) {
    return JSON.stringify({ success: false, message: err?.message || 'Zoho OAuth exchange failed.' });
  }
};
