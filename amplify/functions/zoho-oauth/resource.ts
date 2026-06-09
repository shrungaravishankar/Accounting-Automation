import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * Exchanges a Zoho OAuth authorization code for a refresh token, stores it in
 * the ZohoCredentials table owned by the calling user, and reports success.
 *
 * The refresh token alone is enough to mint a fresh access token any time we
 * need to call the Zoho Books API on the Admin's behalf — no need to keep
 * re-prompting them for consent.
 */
export const zohoOauth = defineFunction({
  name: 'zoho-oauth',
  entry: './handler.ts',
  timeoutSeconds: 30,
  resourceGroupName: 'data',
  environment: {
    ZOHO_CLIENT_ID: '1000.QO9XLUC1QMJH4Q9CTYVYXRV9708DST',
    ZOHO_CLIENT_SECRET: secret('ZOHO_CLIENT_SECRET'),
    ZOHO_REGION: 'com',
    ZOHO_REDIRECT_URI: 'https://accounting-automation.bclworkspace.in/oauth-callback'
  }
});
