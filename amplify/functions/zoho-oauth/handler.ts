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
  if (!clientId || !clientSecret || !redirectUri || !tableName) {
    return JSON.stringify({ success: false, message: 'Server misconfiguration — Zoho env vars missing.' });
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
    const tok: any = await tokRes.json();
    if (!tokRes.ok || !tok.refresh_token) {
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
        UpdateExpression: 'SET refreshToken = :t, #r = :rg, connectedAt = :c, lastUsedAt = :u, #o = :o',
        ExpressionAttributeNames: { '#r': 'region', '#o': 'owner' },
        ExpressionAttributeValues: {
          ':t': tok.refresh_token,
          ':rg': region,
          ':c': now,
          ':u': now,
          ':o': existing.Items[0].owner || (ownerSub + '::' + ownerSub)
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
