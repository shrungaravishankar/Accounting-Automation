import { defineStorage } from '@aws-amplify/backend';

/**
 * Private S3 bucket for exported accounting files (Excel / CSV).
 *
 * Files live under exports/{identityId}/... so each user can only read/write
 * their own folder. Members of the `admin` group can read/delete everything
 * (for support / audit). Nothing is public.
 */
export const storage = defineStorage({
  name: 'autoledgerExports',
  access: (allow) => ({
    'exports/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      allow.groups(['admin']).to(['read', 'write', 'delete']),
    ],
    // Saved-project payloads (transactions + journal entries) as JSON blobs.
    'projects/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      allow.groups(['admin']).to(['read', 'write', 'delete']),
    ],
    // Per-client working config + global reference DB (JSON blobs).
    'config/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      allow.groups(['admin']).to(['read', 'write', 'delete']),
    ],
  }),
});
