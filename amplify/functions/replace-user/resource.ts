import { defineFunction } from '@aws-amplify/backend';

/**
 * Replaces a User or Admin with a new identity. Used when someone leaves the
 * org. Inherits all of the old account's client assignments + project
 * ownership to the new account, optionally deletes the old one.
 *
 * - Super Admin can replace anyone (User or Admin).
 * - Admin can only replace Users in their own team.
 */
export const replaceUser = defineFunction({
  name: 'replace-user',
  entry: './handler.ts',
  timeoutSeconds: 60,
  resourceGroupName: 'data'
});
