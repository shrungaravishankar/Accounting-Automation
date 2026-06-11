import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { inviteUser } from '../functions/invite-user/resource';
import { listAppUsers } from '../functions/list-app-users/resource';
import { manageUser } from '../functions/manage-user/resource';
import { listTeamData } from '../functions/list-team-data/resource';
import { decideUnlockRequest } from '../functions/decide-unlock-request/resource';
import { zohoOauth } from '../functions/zoho-oauth/resource';
import { zohoSync } from '../functions/zoho-sync/resource';
import { replaceUser } from '../functions/replace-user/resource';
import { invoiceOcr } from '../functions/invoice-ocr/resource';
/**
 * AppSync GraphQL schema for BCL AutoLedger.
 *
 * Note on team-scoped access: Amplify Gen2 1.4's `groupsDefinedIn('team')` rule
 * has a known bug — it auto-creates an internal `team` field that mutations
 * can't write to, and refuses to let the field be re-declared. So team-lead
 * visibility is implemented via a Lambda resolver (`listTeamData`) which runs
 * with elevated access, filters by the caller's team, and returns matching
 * rows. Same pattern for `decideUnlockRequest`, which unlocks a project on
 * behalf of an admin.
 */
const schema = a.schema({
  AppHealth: a
    .model({
      status: a.string()
    })
    .authorization((allow) => [allow.authenticated()]),

  /**
   * One row per exported file. The owner (creator) can read their own history;
   * the `admin` group can read everything. The actual file lives in S3 at
   * `storagePath`; this is the searchable log/metadata.
   */
  ExportLog: a
    .model({
      userName: a.string(),
      userEmail: a.string(),
      kind: a.string(),                  // "journal" | "expenses" | "revenue" | "bsItems" | "suspense" | "bills" | "export"
      filename: a.string().required(),
      sizeBytes: a.integer(),
      storagePath: a.string().required(), // S3 key including identity prefix
      client: a.string(),
      clientId: a.string(),
      transactionsCount: a.integer(),
      expensesCount: a.integer(),
      journalsCount: a.integer(),
      bsItemsCount: a.integer(),
      revenueCount: a.integer(),
      suspenseCount: a.integer(),
      dateFrom: a.string(),
      dateTo: a.string(),
      sourceBank: a.string(),
      sourceCoa: a.string(),
      sourceVendors: a.string(),
      sourceCustomers: a.string(),
      generatedAt: a.datetime(),
      team: a.string()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read']),
      allow.group('admin').to(['read', 'delete']),
      allow.group('team-lead').to(['read']),
    ]),

  /** A client/company the signed-in user works on. Owner + admin full access. */
  Client: a
    .model({
      name: a.string().required(),
      // Captured at creation so Team Leads / Admin can see who created what.
      ownerEmail: a.string(),
      ownerName: a.string(),
      team: a.string(),
      // Zoho Books organization ID this client is linked to. Set when the
      // client was imported from Zoho; null for manually-created clients.
      zohoOrgId: a.string(),
      // Comma-separated list of User emails this client is shared with.
      // Admin populates this via the Assign Users dialog. Users only see
      // clients where their email appears here (or that they own).
      assignedTo: a.string()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read', 'update', 'delete']),
      allow.group('admin').to(['create', 'read', 'update', 'delete']),
      // Admins (team-lead role) can update + delete clients in their team,
      // even ones they didn't personally create — e.g. a User's legacy
      // client. UI still filters cross-team rows out of view; API access
      // is gated by client-side team filter in alClientList.
      allow.group('team-lead').to(['read', 'update', 'delete']),
    ]),

  /**
   * A saved project (one processed bank statement) for re-download. Metadata
   * lives here; the heavy payload (transactions + journal entries) is a JSON
   * file in S3 at `dataPath`.
   */
  Project: a
    .model({
      clientId: a.string().required(),
      clientName: a.string(),
      name: a.string().required(),
      exportedAt: a.datetime(),
      bankName: a.string(),
      period: a.string(),
      txnCount: a.integer(),
      expenseCount: a.integer(),
      journalCount: a.integer(),
      bsCount: a.integer(),
      prCount: a.integer(),
      suspenseCount: a.integer(),
      dataPath: a.string().required(),
      // Captured at creation so Managers/Team Leads can see who exported what.
      ownerEmail: a.string(),
      ownerName: a.string(),
      // When true the project is read-only — reopen / rename / delete are blocked.
      locked: a.boolean(),
      team: a.string()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read', 'update', 'delete']),
      allow.group('admin').to(['create', 'read', 'update', 'delete']),
      // Admins can update + delete projects in their team (e.g. clean up a
      // User's old work after a hand-off). Cross-team API access is gated
      // by the same client-side team filter as Client.
      allow.group('team-lead').to(['read', 'update', 'delete']),
    ]),

  /**
   * Request from a non-admin user to unlock a locked project. Team Leads (the
   * "Admin" role in the UI) and Super Admins decide on these from their
   * dashboard — approving flips the matching Project.locked to false (handled
   * server-side by the decideUnlockRequest Lambda).
   */
  UnlockRequest: a
    .model({
      projectId: a.string().required(),
      projectName: a.string(),
      clientId: a.string(),
      clientName: a.string(),
      requestedByEmail: a.string(),
      requestedByName: a.string(),
      status: a.string().required(), // 'pending' | 'approved' | 'denied'
      requestedAt: a.datetime(),
      decidedByEmail: a.string(),
      decidedAt: a.datetime(),
      reason: a.string(),
      team: a.string()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read']),
      allow.group('admin').to(['read', 'update', 'delete']),
      allow.group('team-lead').to(['read']),
    ]),

  /**
   * Per-Admin Zoho Books refresh token + region. One row per Admin — the
   * refresh token gives access to ALL organizations under their Zoho login,
   * so the per-client zohoOrgId on Client rows is what scopes API calls to a
   * specific organization. Refresh tokens are long-lived; we only re-OAuth
   * if Zoho revokes the grant.
   */
  ZohoCredentials: a
    .model({
      refreshToken: a.string().required(),
      region: a.string(),
      ownerEmail: a.string(),
      connectedAt: a.datetime(),
      lastUsedAt: a.datetime()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read', 'update', 'delete']),
      allow.group('admin').to(['read', 'delete'])
    ]),

  InviteResult: a.customType({
    success: a.boolean().required(),
    message: a.string().required()
  }),

  ManageResult: a.customType({
    success: a.boolean().required(),
    message: a.string().required(),
    tempPassword: a.string()
  }),

  inviteUser: a
    .mutation()
    .arguments({
      email: a.string().required(),
      fullName: a.string().required(),
      role: a.string().required()
    })
    .returns(a.ref('InviteResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(inviteUser)),

  listAppUsers: a
    .query()
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(listAppUsers)),

  manageUser: a
    .mutation()
    .arguments({
      email: a.string().required(),
      action: a.string().required(),
      role: a.string()
    })
    .returns(a.ref('ManageResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(manageUser)),

  /**
   * Returns rows visible to the caller based on their team. Admins (Cognito
   * 'admin' group) get everything; team-leads (Cognito 'team-<sub>' group) get
   * rows whose `team` field matches. Members get only their own rows.
   * `kind`: 'projects' | 'clients' | 'exportLogs' | 'unlockRequests'.
   * `clientId` is required for `kind = 'projects'`.
   */
  listTeamData: a
    .query()
    .arguments({
      kind: a.string().required(),
      clientId: a.string()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(listTeamData)),

  /**
   * Approve or deny an UnlockRequest. On approval, also flips the matching
   * Project's `locked` field to false. Caller must be a super-admin OR a
   * team-lead whose team matches the request's `team`.
   */
  decideUnlockRequest: a
    .mutation()
    .arguments({
      requestId: a.string(),
      projectId: a.string(),
      approve: a.boolean().required()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(decideUnlockRequest)),

  /**
   * Completes a Zoho OAuth flow: exchanges the authorization code for a
   * refresh token and stores it. Called by the frontend right after the user
   * is redirected back from Zoho's consent page.
   */
  zohoConnect: a
    .mutation()
    .arguments({ code: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoOauth)),

  /**
   * Pulls data from Zoho Books on the caller's behalf.
   * `kind` is one of: organizations, chartofaccounts, vendors, customers.
   * `organizationId` is required for everything except 'organizations'.
   */
  zohoFetch: a
    .query()
    .arguments({
      kind: a.string().required(),
      organizationId: a.string(),
      // Optional JSON-encoded extra params (e.g. date range for kind='recentEntries').
      // Older callers omit this; new code passes a stringified object.
      params: a.string()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoSync)),

  /**
   * Push an entry to Zoho Books on behalf of the caller.
   * kind = 'pushExpense' | 'pushJournal' | 'pushPayment'.
   * payload is a JSON string in Zoho's expected body format.
   */
  zohoPush: a
    .mutation()
    .arguments({
      kind: a.string().required(),
      organizationId: a.string().required(),
      payload: a.string().required()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoSync)),

  /**
   * Revert a previously-pushed Zoho Books entry.
   * kind = 'deleteExpense' | 'deleteJournal' | 'deletePayment'.
   * resourceId is the Zoho id returned at push time, passed via `payload`
   * to reuse the same generic Lambda arg shape.
   */
  zohoDelete: a
    .mutation()
    .arguments({
      kind: a.string().required(),
      organizationId: a.string().required(),
      payload: a.string().required()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoSync)),

  /**
   * Invoice OCR via AWS Textract AnalyzeExpense. Frontend sends a
   * base64-encoded PDF or image and receives structured fields
   * (vendor, customer, dates, totals, VAT, line items) to pre-fill
   * the manual invoice creation modal.
   */
  invoiceOcr: a
    .mutation()
    .arguments({
      fileBase64: a.string().required(),
      mimeType: a.string()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(invoiceOcr)),

  /**
   * Replace a User or Admin with a new email. Inherits their client
   * assignments + project ownership. Admin can replace Users in their team;
   * Super Admin can replace anyone (including other Admins).
   */
  replaceUser: a
    .mutation()
    .arguments({
      oldEmail: a.string().required(),
      newEmail: a.string().required(),
      newName: a.string(),
      deleteOld: a.boolean()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(replaceUser))
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool'
  }
});
