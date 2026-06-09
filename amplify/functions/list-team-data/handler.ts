declare const process: { env: Record<string, string | undefined> };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
  // custom:team attribute (set by invite-user). Read from JWT claims.
  const claims = ((event.identity as any)?.claims || {}) as any;
  const teamFromClaim = (claims['custom:team'] || '') as string;
  const teamGroup = teamFromGroup || teamFromClaim;
  const isStaff = !isSuperAdmin && !teamFromGroup;
  const callerEmail = ((claims.email || event.identity?.username || '') as string).toLowerCase();

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

    const visible = isSuperAdmin
      ? items
      : items.filter(r => {
          if (r.team !== teamGroup) return false;
          // Extra restriction for Users (staff): clients must be explicitly
          // assigned to them, or they must own the row. Admins see all rows
          // in their team without needing to be in assignedTo.
          if (isStaff && kind === 'clients') {
            const owns = (r.ownerEmail || '').toLowerCase() === callerEmail;
            const assignedCsv = (r.assignedTo || '').toLowerCase();
            const assignedTo = assignedCsv.split(',').map((s: string) => s.trim()).filter(Boolean);
            return owns || assignedTo.includes(callerEmail);
          }
          // For Users listing projects, only return ones they "own" by
          // ownerEmail (covers inherited projects after a replace-user run
          // even though the Cognito sub doesn't match anymore).
          if (isStaff && kind === 'projects') {
            return (r.ownerEmail || '').toLowerCase() === callerEmail;
          }
          return true;
        });
    return JSON.stringify({ error: null, items: visible });
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || 'list-team-data failed', items: [] });
  }
};
