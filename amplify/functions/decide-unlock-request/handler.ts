declare const process: { env: Record<string, string | undefined> };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type Event = {
  arguments: { requestId?: string; projectId?: string; approve: boolean };
  identity?: { username?: string; groups?: string[]; claims?: Record<string, any> };
};

export const handler = async (event: Event) => {
  const groups = event.identity?.groups || [];
  const isSuperAdmin = groups.includes('admin');
  const teamGroup = groups.find(g => g.startsWith('team-') && g !== 'team-lead') || '';
  const isTeamLead = groups.includes('team-lead') || !!teamGroup;
  const claims = (event.identity?.claims || {}) as any;
  const callerEmail = claims.email || event.identity?.username || '';

  if (!isSuperAdmin && !isTeamLead) {
    return JSON.stringify({ success: false, message: 'Not authorized to decide unlock requests.' });
  }

  const requestId = event.arguments?.requestId;
  const directProjectId = event.arguments?.projectId;
  const approve = !!event.arguments?.approve;
  if (!requestId && !directProjectId) {
    return JSON.stringify({ success: false, message: 'Either requestId or projectId is required.' });
  }

  const unlockTable = process.env.UNLOCKREQUEST_TABLE_NAME;
  const projectTable = process.env.PROJECT_TABLE_NAME;
  if (!unlockTable || !projectTable) {
    return JSON.stringify({ success: false, message: 'Table env vars not configured.' });
  }

  try {
    // Path A — decide an existing UnlockRequest.
    if (requestId) {
      const reqRes = await ddb.send(new GetCommand({ TableName: unlockTable, Key: { id: requestId } }));
      const req = reqRes.Item;
      if (!req) return JSON.stringify({ success: false, message: 'Unlock request not found.' });

      if (!isSuperAdmin && req.team !== teamGroup) {
        return JSON.stringify({ success: false, message: 'You can only decide unlock requests for your own team.' });
      }
      if (req.status && req.status !== 'pending') {
        return JSON.stringify({ success: false, message: 'This request has already been ' + req.status + '.' });
      }

      if (approve && req.projectId) {
        await ddb.send(new UpdateCommand({
          TableName: projectTable,
          Key: { id: req.projectId },
          UpdateExpression: 'SET locked = :f',
          ExpressionAttributeValues: { ':f': false }
        }));
      }
      await ddb.send(new UpdateCommand({
        TableName: unlockTable,
        Key: { id: requestId },
        UpdateExpression: 'SET #s = :s, decidedByEmail = :e, decidedAt = :t',
        ExpressionAttributeValues: {
          ':s': approve ? 'approved' : 'denied',
          ':e': callerEmail,
          ':t': new Date().toISOString()
        },
        ExpressionAttributeNames: { '#s': 'status' }
      }));
      return JSON.stringify({ success: true, message: approve ? 'Project unlocked.' : 'Request denied.' });
    }

    // Path B — admin directly unlocks a project (no request entry needed).
    if (directProjectId) {
      const pRes = await ddb.send(new GetCommand({ TableName: projectTable, Key: { id: directProjectId } }));
      const proj = pRes.Item;
      if (!proj) return JSON.stringify({ success: false, message: 'Project not found.' });
      if (!isSuperAdmin && proj.team !== teamGroup) {
        return JSON.stringify({ success: false, message: 'You can only unlock projects in your own team.' });
      }
      await ddb.send(new UpdateCommand({
        TableName: projectTable,
        Key: { id: directProjectId },
        UpdateExpression: 'SET locked = :v',
        ExpressionAttributeValues: { ':v': !approve ? true : false }
      }));
      return JSON.stringify({ success: true, message: approve ? 'Project unlocked.' : 'Project locked.' });
    }

    return JSON.stringify({ success: false, message: 'No action taken.' });
  } catch (err: any) {
    return JSON.stringify({ success: false, message: err?.message || 'decide-unlock-request failed' });
  }
};
