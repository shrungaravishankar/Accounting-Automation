declare const process: { env: Record<string, string | undefined> };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

type Kind = 'projects' | 'clients' | 'exportLogs' | 'unlockRequests';

type Event = {
  arguments: { kind: Kind; clientId?: string };
  identity?: { username?: string; groups?: string[] };
};

async function scanAll(tableName: string, filter?: { expression: string; values: Record<string, any>; names?: Record<string, string> }) {
  const items: any[] = [];
  let lastKey: any = undefined;
  do {
    const out = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastKey,
      ...(filter ? {
        FilterExpression: filter.expression,
        ExpressionAttributeValues: filter.values,
        ...(filter.names ? { ExpressionAttributeNames: filter.names } : {})
      } : {})
    }));
    items.push(...(out.Items || []));
    lastKey = out.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export const handler = async (event: Event) => {
  const groups = event.identity?.groups || [];
  const isSuperAdmin = groups.includes('admin');
  // Skip the flat 'team-lead' group — it's a role marker, not a team.
  const teamFromGroup = groups.find(g => g.startsWith('team-') && g !== 'team-lead') || '';
  // Staff users aren't in a team-<sub> Cognito group; their team is in the
  // custom:team attribute (set by invite-user). Read from JWT claims first
  // (fast path); fall back to AdminGetUser if the app client doesn't expose
  // custom:team in the ID token.
  const claims = ((event.identity as any)?.claims || {}) as any;
  let teamFromClaim = (claims['custom:team'] || '') as string;
  const callerEmail = ((claims.email || event.identity?.username || '') as string).toLowerCase();
  const isStaff = !isSuperAdmin && !teamFromGroup;

  if (isStaff && !teamFromClaim && callerEmail && process.env.USER_POOL_ID) {
    try {
      const u = await cognito.send(new AdminGetUserCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: callerEmail
      }));
      teamFromClaim = u.UserAttributes?.find(a => a.Name === 'custom:team')?.Value || '';
      console.log('[list-team-data] Fetched custom:team from Cognito for', callerEmail, '->', teamFromClaim);
    } catch (err: any) {
      console.warn('[list-team-data] AdminGetUser failed for', callerEmail, err?.message);
    }
  }

  const teamGroup = teamFromGroup || teamFromClaim;
  console.log('[list-team-data] callerEmail=', callerEmail, 'groups=', JSON.stringify(groups), 'teamGroup=', teamGroup, 'isStaff=', isStaff, 'kind=', event.arguments?.kind);

  if (!isSuperAdmin && !teamGroup) {
    return JSON.stringify({ error: 'Not authorized to list team data.', items: [] });
  }

  const kind = event.arguments?.kind;
  const clientId = event.arguments?.clientId;
  if (!kind) return JSON.stringify({ error: 'kind is required', items: [] });

  const tables = {
    projects: process.env.PROJECT_TABLE_NAME,
    clients: process.env.CLIENT_TABLE_NAME,
    exportLogs: process.env.EXPORTLOG_TABLE_NAME,
    unlockRequests: process.env.UNLOCKREQUEST_TABLE_NAME
  } as const;

  const tableName = tables[kind];
  if (!tableName) return JSON.stringify({ error: 'unknown kind: ' + kind, items: [] });

  try {
    let items: any[] = [];

    if (kind === 'projects') {
      if (!clientId) return JSON.stringify({ error: 'clientId is required for kind=projects', items: [] });
      items = await scanAll(tableName, { expression: 'clientId = :c', values: { ':c': clientId } });
    } else if (kind === 'unlockRequests') {
      items = await scanAll(tableName, {
        expression: '#s = :s',
        values: { ':s': 'pending' },
        names: { '#s': 'status' }
      });
    } else {
      items = await scanAll(tableName);
    }

    // Build a set of email-like identifiers for the caller so we tolerate
    // missing claims.email + case differences.
    const callerIdentifiers = new Set<string>();
    if (callerEmail) callerIdentifiers.add(callerEmail);
    if (event.identity?.username) callerIdentifiers.add(event.identity.username.toLowerCase());

    // Fetch from Cognito as the source of truth for the caller's email
    // (covers cases where AppSync didn't pass claims.email).
    if (isStaff && process.env.USER_POOL_ID && event.identity?.username) {
      try {
        const u = await cognito.send(new AdminGetUserCommand({
          UserPoolId: process.env.USER_POOL_ID,
          Username: event.identity.username
        }));
        const e = u.UserAttributes?.find(a => a.Name === 'email')?.Value;
        if (e) callerIdentifiers.add(e.toLowerCase());
      } catch (_) {}
    }

    const idList = Array.from(callerIdentifiers);
    console.log('[list-team-data] caller identifiers:', JSON.stringify(idList));

    const visible = isSuperAdmin
      ? items
      : items.filter(r => {
          if (isStaff && kind === 'clients') {
            const ownerLower = (r.ownerEmail || '').toLowerCase();
            const assignedCsv = (r.assignedTo || '').toLowerCase();
            const assignedTo = assignedCsv.split(',').map((s: string) => s.trim()).filter(Boolean);
            const owns = idList.some(i => i === ownerLower);
            const isAssigned = idList.some(i => assignedTo.includes(i));
            const pass = owns || isAssigned;
            console.log('[list-team-data] client', r.name, 'id', r.id, 'team', r.team, 'ownerEmail', r.ownerEmail, 'assignedTo', r.assignedTo, '-> owns:', owns, 'assigned:', isAssigned, 'pass:', pass);
            return pass;
          }
          if (isStaff && kind === 'projects') {
            const ownerLower = (r.ownerEmail || '').toLowerCase();
            return idList.some(i => i === ownerLower);
          }
          // Admins use the team-<sub> match.
          return r.team === teamGroup;
        });
    console.log('[list-team-data] visible count:', visible.length, 'of', items.length);
    return JSON.stringify({ error: null, items: visible });
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || 'list-team-data failed', items: [] });
  }
};
