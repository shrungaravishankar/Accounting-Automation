declare const process: { env: Record<string, string | undefined> };

import {
  CognitoIdentityProviderClient,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
  CreateGroupCommand,
  GroupExistsException,
  UserNotFoundException
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient();

type ManageEvent = {
  arguments: {
    email: string;
    action: 'reset-password' | 'delete' | 'set-role';
    role?: string; // 'admin' | 'team-lead' | 'staff'  (only for set-role)
  };
  identity?: {
    groups?: string[];
    username?: string;
    claims?: { email?: string };
  };
};

/**
 * Generate a temporary password that satisfies Cognito's default password
 * policy: minimum 8 chars with at least one upper, one lower, one digit,
 * and one special character. Uses Math.random — sufficient for a one-time
 * password that is invalidated on the user's first successful login.
 */
function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%&';
  const all = upper + lower + digit + special;

  const pick = (set: string) => set.charAt(Math.floor(Math.random() * set.length));

  // Guarantee at least one character of each required class
  let pwd = pick(upper) + pick(lower) + pick(digit) + pick(special);
  for (let i = 0; i < 8; i++) {
    pwd += pick(all);
  }

  // Fisher-Yates shuffle so the required-class chars are not at fixed positions
  const arr = pwd.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.join('');
}

export const handler = async (event: ManageEvent) => {
  // ---- Authorization: only admins ----
  const callerGroups = event.identity?.groups || [];
  if (!callerGroups.includes('admin')) {
    return {
      success: false,
      message: 'Unauthorized: only admins can manage users.',
      tempPassword: ''
    };
  }

  const { email, action } = event.arguments;
  const userPoolId = process.env.USER_POOL_ID;

  if (!userPoolId) {
    return { success: false, message: 'Server misconfiguration: USER_POOL_ID missing.', tempPassword: '' };
  }
  if (!email || !action) {
    return { success: false, message: 'Email and action are required.', tempPassword: '' };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // ---- Self-action protection ----
  const callerEmail = (event.identity?.claims?.email || event.identity?.username || '').toLowerCase();
  if (callerEmail && callerEmail === normalizedEmail) {
    return {
      success: false,
      message: 'You cannot perform this action on your own account.',
      tempPassword: ''
    };
  }

  try {
    if (action === 'reset-password') {
      const tempPassword = generateTempPassword();
      await client.send(new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: normalizedEmail,
        Password: tempPassword,
        Permanent: false
      }));
      return {
        success: true,
        message: `Temporary password generated for ${normalizedEmail}. They will be required to change it on next login.`,
        tempPassword
      };
    } else if (action === 'delete') {
      await client.send(new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedEmail
      }));
      return {
        success: true,
        message: `User ${normalizedEmail} has been permanently deleted.`,
        tempPassword: ''
      };
    } else if (action === 'set-role') {
      // Only Super Admins (Cognito 'admin' group) may change roles.
      if (!callerGroups.includes('admin')) {
        return { success: false, message: 'Only a Super Admin can change roles.', tempPassword: '' };
      }
      const newRole = (event.arguments.role || '').trim();
      const ALLOWED = ['admin', 'team-lead', 'staff'];
      if (!ALLOWED.includes(newRole)) {
        return { success: false, message: 'Role must be admin (Super Admin), team-lead (Admin), or staff (User).', tempPassword: '' };
      }

      // Pull the user's sub (needed when promoting to Admin → create team-<sub>)
      // and their current group memberships.
      const userRes = await client.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedEmail
      }));
      const sub = userRes.UserAttributes?.find(a => a.Name === 'sub')?.Value || '';

      const grpRes = await client.send(new AdminListGroupsForUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedEmail
      }));
      const current = (grpRes.Groups || []).map(g => g.GroupName).filter((g): g is string => !!g);

      // Helpers
      const add = async (g: string) => {
        if (!current.includes(g)) {
          await client.send(new AdminAddUserToGroupCommand({
            UserPoolId: userPoolId, Username: normalizedEmail, GroupName: g
          }));
        }
      };
      const remove = async (g: string) => {
        if (current.includes(g)) {
          await client.send(new AdminRemoveUserFromGroupCommand({
            UserPoolId: userPoolId, Username: normalizedEmail, GroupName: g
          }));
        }
      };

      if (newRole === 'admin') {
        // Promote to Super Admin: add to 'admin'; remove from staff + any team-* group; clear custom:team.
        await add('admin');
        await remove('staff');
        for (const g of current.filter(g => g.startsWith('team-'))) await remove(g);
        await client.send(new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId, Username: normalizedEmail,
          UserAttributes: [{ Name: 'custom:team', Value: '' }]
        }));
      } else if (newRole === 'team-lead') {
        // Make them an Admin with their own team: remove 'admin'; ensure team-<sub> + 'staff'; set custom:team.
        if (!sub) return { success: false, message: 'Could not determine user sub; aborting.', tempPassword: '' };
        const team = `team-${sub}`;
        try {
          await client.send(new CreateGroupCommand({
            UserPoolId: userPoolId, GroupName: team,
            Description: `Team led by ${normalizedEmail}`
          }));
        } catch (e: any) { if (!(e instanceof GroupExistsException)) throw e; }
        await remove('admin');
        await add('staff');
        await add(team);
        // Remove any OTHER team-* groups they were in.
        for (const g of current.filter(g => g.startsWith('team-') && g !== team)) await remove(g);
        await client.send(new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId, Username: normalizedEmail,
          UserAttributes: [{ Name: 'custom:team', Value: team }]
        }));
      } else {
        // Demote / set as User: ensure 'staff'; remove 'admin' and any team-* group.
        // custom:team is left as-is (it should already point to their Admin's team if applicable).
        await add('staff');
        await remove('admin');
        for (const g of current.filter(g => g.startsWith('team-'))) await remove(g);
      }

      return {
        success: true,
        message: `Role updated for ${normalizedEmail}.`,
        tempPassword: ''
      };
    } else {
      return { success: false, message: `Unknown action: ${action}`, tempPassword: '' };
    }
  } catch (err: any) {
    if (err instanceof UserNotFoundException) {
      return { success: false, message: 'User not found.', tempPassword: '' };
    }
    return { success: false, message: err?.message || 'Operation failed.', tempPassword: '' };
  }
};
