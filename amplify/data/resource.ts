import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { inviteUser } from '../functions/invite-user/resource';

/**
 * AppSync GraphQL schema exposing a single custom mutation: inviteUser.
 * The mutation is routed to the inviteUser Lambda, which enforces that
 * the caller is in the 'admin' Cognito group.
 */
const schema = a.schema({
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
    .handler(a.handler.function(inviteUser))
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool'
  }
});
