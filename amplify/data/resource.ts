import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { inviteUser } from '../functions/invite-user/resource';
import { listAppUsers } from '../functions/list-app-users/resource';

/**
 * AppSync GraphQL schema for BCL AutoLedger.
 * The AppHealth model is a placeholder so AppSync has a valid Query type.
 */
const schema = a.schema({
  AppHealth: a
    .model({
      status: a.string()
    })
    .authorization((allow) => [allow.authenticated()]),

  InviteResult: a.customType({
    success: a.boolean().required(),
    message: a.string().required()
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
    .handler(a.handler.function(listAppUsers))
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool'
  }
});
