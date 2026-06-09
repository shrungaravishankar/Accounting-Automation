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
      // Amplify Gen2 attaches entity-based policies only to the default
      // auth role; users in Cognito groups assume group-specific roles
      // that lack the rule. Grant the two CDK-managed groups explicitly.
      // Team-lead Admins are also members of 'staff' (set by invite-user),
      // so they assume the staff role and pick this rule up automatically.
      allow.groups(['admin', 'staff']).to(['read', 'write', 'delete']),
    ],
    // Saved-project payloads (transactions + journal entries) as JSON blobs.
    'projects/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      // Amplify Gen2 attaches entity-based policies only to the default
      // auth role; users in Cognito groups assume group-specific roles
      // that lack the rule. Grant the two CDK-managed groups explicitly.
      // Team-lead Admins are also members of 'staff' (set by invite-user),
      // so they assume the staff role and pick this rule up automatically.
      allow.groups(['admin', 'staff']).to(['read', 'write', 'delete']),
    ],
    // Per-client working config + global reference DB (JSON blobs).
    'config/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      // Amplify Gen2 attaches entity-based policies only to the default
      // auth role; users in Cognito groups assume group-specific roles
      // that lack the rule. Grant the two CDK-managed groups explicitly.
      // Team-lead Admins are also members of 'staff' (set by invite-user),
      // so they assume the staff role and pick this rule up automatically.
      allow.groups(['admin', 'staff']).to(['read', 'write', 'delete']),
    ],
  }),
});
