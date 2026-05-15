import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda function that invites a new user to the Cognito user pool.
 * Only callers in the 'admin' group can use this (enforced in handler).
 */
export const inviteUser = defineFunction({
  name: 'invite-user',
  entry: './handler.ts',
  timeoutSeconds: 30
});
