declare const process: { env: Record<string, string | undefined> };

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminAddUserToGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminListGroupsForUserCommand,
  AdminDeleteUserCommand,
  UserNotFoundException,
  UsernameExistsException
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const cognito = new CognitoIdentityProviderClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type Event = {
  arguments: {
    oldEmail: string;
    newEmail: string;
    newName?: string;
    deleteOld?: boolean;
  };
  identity?: { username?: string; groups?: string[]; claims?: Record<string, any> };
};

async function getUserGroups(userPoolId: string, username: string): Promise<string[]> {
  const r = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: userPoolId, Username: username
  }));
  return (r.Groups || []).map(g => g.GroupName).filter((g): g is string => !!g);
}

export const handler = async (event: Event) => {
  const groups = event.identity?.groups || [];
  const isSuperAdmin = groups.includes('admin');
  const callerTeam = groups.find(g => g.startsWith('team-') && g !== 'team-lead') || '';
  const isAdmin = !isSuperAdmin && !!callerTeam;
  if (!isSuperAdmin && !isAdmin) {
    return JSON.stringify({ success: false, message: 'Only Admin or Super Admin can replace users.' });
  }

  const oldEmail = (event.arguments?.oldEmail || '').trim().toLowerCase();
  const newEmail = (event.arguments?.newEmail || '').trim().toLowerCase();
  const newName = (event.arguments?.newName || '').trim();
  const deleteOld = !!event.arguments?.deleteOld;

  if (!oldEmail || !newEmail) {
    return JSON.stringify({ success: false, message: 'Both oldEmail and newEmail are required.' });
  }
  if (oldEmail === newEmail) {
    return JSON.stringify({ success: false, message: 'Old and new emails are the same.' });
  }

  const userPoolId = process.env.USER_POOL_ID;
  const clientTable = process.env.CLIENT_TABLE_NAME;
  const projectTable = process.env.PROJECT_TABLE_NAME;
  if (!userPoolId || !clientTable || !projectTable) {
    return JSON.stringify({ success: false, message: 'Server misconfiguration — table env vars missing.' });
  }

  try {
    // 1. Get old user's groups + custom:team to mirror onto the new user.
    let oldUserGroups: string[];
    let oldTeam = '';
    try {
      const old = await cognito.send(new AdminGetUserCommand({
        UserPoolId: userPoolId, Username: oldEmail
      }));
      oldTeam = old.UserAttributes?.find(a => a.Name === 'custom:team')?.Value || '';
      oldUserGroups = await getUserGroups(userPoolId, oldEmail);
    } catch (e: any) {
      if (e instanceof UserNotFoundException) {
        return JSON.stringify({ success: false, message: 'Old user not found in Cognito.' });
      }
      throw e;
    }

    const oldIsSuperAdmin = oldUserGroups.includes('admin');
    const oldIsAdminRole = !oldIsSuperAdmin && oldUserGroups.some(g => g.startsWith('team-') && g !== 'team-lead');

    // Authorisation: an Admin can only replace Users in their own team.
    // Replacing Admins (or Super Admins) requires the Super Admin.
    if (!isSuperAdmin) {
      if (oldIsSuperAdmin || oldIsAdminRole) {
        return JSON.stringify({ success: false, message: 'Only Super Admin can replace an Admin or Super Admin.' });
      }
      if (oldTeam && oldTeam !== callerTeam) {
        return JSON.stringify({ success: false, message: 'You can only replace users in your own team.' });
      }
    }

    // 2. Find or create the new user. If they already exist we still ensure
    //    they're in the same groups as the old user (so they inherit access).
    let newUserExists = true;
    try {
      await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: newEmail }));
    } catch (e: any) {
      if (e instanceof UserNotFoundException) newUserExists = false;
      else throw e;
    }

    if (!newUserExists) {
      try {
        await cognito.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: newEmail,
          UserAttributes: [
            { Name: 'email', Value: newEmail },
            { Name: 'email_verified', Value: 'true' },
            ...(newName ? [{ Name: 'name', Value: newName }] : []),
            ...(oldTeam ? [{ Name: 'custom:team', Value: oldTeam }] : [])
          ],
          DesiredDeliveryMediums: ['EMAIL']
        }));
      } catch (e: any) {
        if (e instanceof UsernameExistsException) {
          // Race condition — proceed as if exists.
        } else throw e;
      }
    }

    // Sync custom:team on existing new user too (idempotent).
    if (newUserExists && oldTeam) {
      try {
        await cognito.send(new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: newEmail,
          UserAttributes: [{ Name: 'custom:team', Value: oldTeam }]
        }));
      } catch (_) {}
    }

    // Add new user to every group the old user was in. Skips ones they're
    // already in.
    const newCurrentGroups = await getUserGroups(userPoolId, newEmail).catch(() => [] as string[]);
    for (const g of oldUserGroups) {
      if (!newCurrentGroups.includes(g)) {
        try {
          await cognito.send(new AdminAddUserToGroupCommand({
            UserPoolId: userPoolId, Username: newEmail, GroupName: g
          }));
        } catch (_) { /* ignore individual add failures */ }
      }
    }

    // 3. Transfer Client.assignedTo entries: replace old email with new email
    //    in every Client's CSV. Dedupes in case both already appeared.
    let clientsUpdated = 0;
    let lastKey: any = undefined;
    do {
      const res: any = await ddb.send(new ScanCommand({
        TableName: clientTable,
        ExclusiveStartKey: lastKey
      }));
      for (const row of (res.Items || [])) {
        const csv = (row.assignedTo || '').toLowerCase();
        if (!csv.includes(oldEmail)) continue;
        const list = csv.split(',').map((s: string) => s.trim()).filter(Boolean);
        const replaced = list.map((e: string) => e === oldEmail ? newEmail : e);
        const deduped = Array.from(new Set(replaced));
        await ddb.send(new UpdateCommand({
          TableName: clientTable,
          Key: { id: row.id },
          UpdateExpression: 'SET assignedTo = :a',
          ExpressionAttributeValues: { ':a': deduped.join(',') }
        }));
        clientsUpdated++;
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);

    // 4. Transfer Project.ownerEmail: every project owned by the old email
    //    becomes owned by the new email. Note: the Amplify-managed `owner`
    //    field (Cognito sub) is NOT changed — the new user sees these
    //    projects via the listTeamData lambda's ownerEmail filter, not via
    //    owner-based auth.
    let projectsUpdated = 0;
    lastKey = undefined;
    do {
      const res: any = await ddb.send(new ScanCommand({
        TableName: projectTable,
        FilterExpression: 'ownerEmail = :e',
        ExpressionAttributeValues: { ':e': oldEmail },
        ExclusiveStartKey: lastKey
      }));
      for (const row of (res.Items || [])) {
        await ddb.send(new UpdateCommand({
          TableName: projectTable,
          Key: { id: row.id },
          UpdateExpression: 'SET ownerEmail = :e',
          ExpressionAttributeValues: { ':e': newEmail }
        }));
        projectsUpdated++;
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);

    // 5. Delete the old user if requested.
    if (deleteOld) {
      try {
        await cognito.send(new AdminDeleteUserCommand({
          UserPoolId: userPoolId, Username: oldEmail
        }));
      } catch (_) { /* best-effort */ }
    }

    return JSON.stringify({
      success: true,
      message: `Replaced ${oldEmail} → ${newEmail}. ${clientsUpdated} client assignment(s) and ${projectsUpdated} project(s) transferred.${deleteOld ? ' Old account deleted.' : ' Old account kept (still active).'}`
    });
  } catch (err: any) {
    return JSON.stringify({ success: false, message: err?.message || 'Replace failed.' });
  }
};
