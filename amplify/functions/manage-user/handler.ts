declare const process: { env: Record<string, string | undefined> };

import {
  CognitoIdentityProviderClient,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  UserNotFoundException
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient();

const ROLE_GROUPS = ['admin', 'manager', 'team-lead', 'staff'] as const;
type Role = typeof ROLE_GROUPS[number];

type ManageEvent = {
  arguments: {
    email: string;
    action: 'reset-password' | 'delete' | 'set-role';
    role?: string;
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
      const newRole = (event.arguments.role || '').trim() as Role;
      if (!(ROLE_GROUPS as readonly string[]).includes(newRole)) {
        return { success: false, message: 'Role must be admin, manager, team-lead, or staff.', tempPassword: '' };
      }
      // Remove the user from any of the role groups they currently belong to.
      const grpRes = await client.send(new AdminListGroupsForUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedEmail
      }));
      const currentGroups = (grpRes.Groups || []).map(g => g.GroupName).filter((g): g is string => !!g);
      for (const g of currentGroups) {
        if ((ROLE_GROUPS as readonly string[]).includes(g) && g !== newRole) {
          await client.send(new AdminRemoveUserFromGroupCommand({
            UserPoolId: userPoolId,
            Username: normalizedEmail,
            GroupName: g
          }));
        }
      }
      // Add the new role (idempotent — Cognito ignores duplicates).
      if (!currentGroups.includes(newRole)) {
        await client.send(new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: normalizedEmail,
          GroupName: newRole
        }));
      }
      return {
        success: true,
        message: `Role for ${normalizedEmail} updated to ${newRole}.`,
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
