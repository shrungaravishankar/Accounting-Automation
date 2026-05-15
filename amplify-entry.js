// Single-bundle entry for the browser.
// esbuild bundles this into amplify-bundle.js, giving us ONE Amplify singleton
// shared across all sub-imports (auth + data).
export { Amplify } from 'aws-amplify';
export {
  signIn, signOut, confirmSignIn, getCurrentUser, fetchAuthSession,
  fetchUserAttributes, resetPassword, confirmResetPassword
} from 'aws-amplify/auth';
export { generateClient } from 'aws-amplify/data';
