import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda that handles admin user management:
 * - reset-password: generates a new temp password and forces user to change it
 * - delete: permanently removes a user from the Cognito user pool
 *
 * Only admin callers can invoke this (enforced in handler).
 */
export const manageUser = defineFunction({
  name: 'manage-user',
  entry: './handler.ts',
  timeoutSeconds: 30
});
