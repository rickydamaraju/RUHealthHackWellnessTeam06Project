import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import type { RuntimeConfig } from '@glucose-compass/contracts';

export function createAuth(config: RuntimeConfig) {
  const origin = window.location.origin;
  const issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
  const domain = config.cognitoDomain.replace(/\/$/, '');
  return new UserManager({
    authority: issuer, client_id: config.clientId,
    redirect_uri: `${origin}/auth/callback`, response_type: 'code',
    scope: 'openid email profile wellness-api/access',
    automaticSilentRenew: true, loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    stateStore: new WebStorageStateStore({ store: window.localStorage }),
    metadata: { issuer, authorization_endpoint: `${domain}/oauth2/authorize`, token_endpoint: `${domain}/oauth2/token`,
      revocation_endpoint: `${domain}/oauth2/revoke`, userinfo_endpoint: `${domain}/oauth2/userInfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json` },
  });
}
