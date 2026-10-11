import * as SecureStore from 'expo-secure-store';

const SESSION_KEY = 'glucose-compass-native-session';

export interface NativeSession {
  type: 'AUTHENTICATED';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  apiUrl: string;
  userId: string;
  clientId: string;
  cognitoDomain: string;
}

export async function saveNativeSession(session: NativeSession) {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

export async function loadNativeSession(): Promise<NativeSession | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as NativeSession;
    if (!session.accessToken || !session.apiUrl || !session.userId || !session.clientId || !session.cognitoDomain) throw new Error('Incomplete session');
    return session;
  } catch {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
}

export async function clearNativeSession() {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function validNativeAccessToken(session: NativeSession) {
  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt && session.expiresAt > now + 60) return session;
  if (!session.refreshToken) throw new Error('Open Glucose Compass and sign in again to resume Apple Health synchronization.');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: session.clientId,
    refresh_token: session.refreshToken,
  });
  const response = await fetch(`${session.cognitoDomain.replace(/\/$/, '')}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const result = await response.json();
  if (!response.ok || typeof result.access_token !== 'string') {
    throw new Error('Open Glucose Compass and sign in again to resume Apple Health synchronization.');
  }
  const refreshed: NativeSession = {
    ...session,
    accessToken: result.access_token,
    refreshToken: typeof result.refresh_token === 'string' ? result.refresh_token : session.refreshToken,
    expiresAt: now + Number(result.expires_in ?? 3600),
  };
  await saveNativeSession(refreshed);
  return refreshed;
}
