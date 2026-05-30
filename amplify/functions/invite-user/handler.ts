declare const process: { env: Record<string, string | undefined> };

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  UsernameExistsException
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient();

/**
 * AppSync resolver event shape (simplified).
 * The `identity` object includes the caller's Cognito groups.
 */
type InviteEvent = {
  arguments: {
    email: string;
    fullName: string;
    role: 'admin' | 'manager' | 'team-lead' | 'staff';
  };
  identity?: {
    groups?: string[];
    username?: string;
  };
};

const ALLOWED_ROLES = ['admin', 'manager', 'team-lead', 'staff'] as const;

export const handler = async (event: InviteEvent) => {
  // ---- Authorization: only admins can invite users ----
  const callerGroups = event.identity?.groups || [];
  if (!callerGroups.includes('admin')) {
    return {
      success: false,
      message: 'Unauthorized: only admins can invite users.'
    };
  }

  const { email, fullName, role } = event.arguments;
  const userPoolId = process.env.USER_POOL_ID;

  // ---- Validation ----
  if (!email || !fullName || !role) {
    return { success: false, message: 'Email, full name, and role are required.' };
  }
  if (!(ALLOWED_ROLES as readonly string[]).includes(role)) {
    return { success: false, message: 'Role must be admin, manager, team-lead, or staff.' };
  }
  if (!userPoolId) {
    return { success: false, message: 'Server misconfiguration: USER_POOL_ID missing.' };
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // ---- Step 1: Create the user (sends email invite automatically) ----
    await client.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: normalizedEmail,
      UserAttributes: [
        { Name: 'email', Value: normalizedEmail },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: fullName }
      ],
      DesiredDeliveryMediums: ['EMAIL']
    }));

    // ---- Step 2: Add the user to the requested group ----
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: normalizedEmail,
      GroupName: role
    }));

    return {
      success: true,
      message: `Invitation sent to ${normalizedEmail}. They'll receive a temporary password by email.`
    };
  } catch (err: any) {
    if (err instanceof UsernameExistsException) {
      return { success: false, message: 'A user with this email already exists.' };
    }
    return { success: false, message: err?.message || 'Failed to invite user.' };
  }
};
