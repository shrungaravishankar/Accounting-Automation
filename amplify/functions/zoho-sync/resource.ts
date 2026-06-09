import { defineFunction } from '@aws-amplify/backend';

declare const process: { env: Record<string, string | undefined> };

/**
 * Fetches data from Zoho Books on behalf of the caller using their stored
 * refresh token. Supports kinds:
 *   - organizations: list of organizations under the caller's Zoho account
 *   - chartofaccounts: chart of accounts for a given organization
 *   - vendors: contacts with contact_type=vendor for a given organization
 *   - customers: contacts with contact_type=customer for a given organization
 */
export const zohoSync = defineFunction({
  name: 'zoho-sync',
  entry: './handler.ts',
  timeoutSeconds: 60,
  resourceGroupName: 'data',
  environment: {
    ZOHO_CLIENT_ID: '1000.33B2MPKF1NI1OWO736YS1Q7YDJAJBX',
    // Sourced from Amplify Console → App settings → Environment variables.
    ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET || '',
    ZOHO_REGION: 'com'
  }
});
