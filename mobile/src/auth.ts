import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { config } from './config';

WebBrowser.maybeCompleteAuthSession();

export const redirectUri = AuthSession.makeRedirectUri({ scheme: 'glucosecompass', path: 'auth/callback' });
export const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `${config.cognitoDomain}/oauth2/authorize`,
  tokenEndpoint: `${config.cognitoDomain}/oauth2/token`,
  revocationEndpoint: `${config.cognitoDomain}/oauth2/revoke`,
  endSessionEndpoint: `${config.cognitoDomain}/logout`,
};

const TOKEN_KEY = 'glucose-compass-tokens';

export async function saveTokens(tokens: AuthSession.TokenResponse) {
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens.getRequestConfig()));
}

export async function loadTokens() {
  const raw = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!raw) return null;
  try { return new AuthSession.TokenResponse(JSON.parse(raw)); }
  catch { await SecureStore.deleteItemAsync(TOKEN_KEY); return null; }
}

export async function clearTokens() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function validAccessToken(tokens: AuthSession.TokenResponse) {
  if (tokens.shouldRefresh() && tokens.refreshToken) {
    const refreshed = await AuthSession.refreshAsync({ clientId: config.clientId, refreshToken: tokens.refreshToken }, discovery);
    await saveTokens(refreshed);
    return { token: refreshed.accessToken, tokens: refreshed };
  }
  if (!tokens.accessToken) throw new Error('Please sign in again.');
  return { token: tokens.accessToken, tokens };
}
