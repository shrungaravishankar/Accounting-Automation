import { defineFunction } from '@aws-amplify/backend';

/**
 * Returns Projects / Clients / ExportLogs / UnlockRequests visible to the
 * caller based on their Cognito team group. Used to give team-lead Admins
 * visibility into work created by their team members.
 */
export const listTeamData = defineFunction({
  name: 'list-team-data',
  entry: './handler.ts',
  timeoutSeconds: 30
});
