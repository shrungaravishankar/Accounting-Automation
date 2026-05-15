import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda that lists all users in the Cognito user pool along with
 * their group memberships and activation status.
 * Only admin callers can use this (enforced in handler).
 */
export const listAppUsers = defineFunction({
  name: 'list-app-users',
  entry: './handler.ts',
  timeoutSeconds: 30
});
