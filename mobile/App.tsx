import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import { createApi } from '@glucose-compass/api-client';
import type { Profile } from '@glucose-compass/contracts';
import { clearTokens, discovery, loadTokens, redirectUri, saveTokens, validAccessToken } from './src/auth';
import { config } from './src/config';
import { syncAppleHealth } from './src/health';

export default function App() {
  const [tokens, setTokens] = useState<AuthSession.TokenResponse | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [request, response, promptAsync] = AuthSession.useAuthRequest({
    clientId: config.clientId, redirectUri, responseType: AuthSession.ResponseType.Code,
    scopes: ['openid', 'email', 'profile', 'wellness-api/access'], usePKCE: true,
  }, discovery);

  useEffect(() => { void loadTokens().then(setTokens); }, []);
  useEffect(() => {
    if (response?.type !== 'success' || !request?.codeVerifier) return;
    void AuthSession.exchangeCodeAsync({ clientId: config.clientId, code: response.params.code, redirectUri, extraParams: { code_verifier: request.codeVerifier } }, discovery)
      .then(async next => { await saveTokens(next); setTokens(next); }).catch(error => setMessage(error instanceof Error ? error.message : 'Sign-in failed.'));
  }, [response, request]);

  const api = useMemo(() => tokens ? createApi(config.apiUrl, async () => {
    const result = await validAccessToken(tokens); if (result.tokens !== tokens) setTokens(result.tokens); return result.token;
  }) : null, [tokens]);
  useEffect(() => { if (api) void api.profile().then(result => setProfile(result.profile)).catch(error => setMessage(error.message)); }, [api]);

  const sync = async () => {
    if (!api) return; setBusy(true); setMessage('');
    try { const result = await syncAppleHealth(api); setMessage(result.accepted ? `${result.accepted} Apple Health records synchronized.` : 'No new Apple Health records were available.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Apple Health synchronization failed.'); }
    finally { setBusy(false); }
  };
  const signOut = async () => { await clearTokens(); setTokens(null); setProfile(null); };

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.page}><Text style={styles.brand}>glucose compass.</Text>{!tokens ? <View style={styles.hero}><Text style={styles.eyebrow}>YOUR BODY · YOUR CONTEXT</Text><Text style={styles.title}>Understand your response, meal by meal.</Text><Text style={styles.copy}>Connect your private meal, glucose, and Apple Health history to the same AWS account used by the website.</Text><TouchableOpacity disabled={!request} style={styles.primary} onPress={() => void promptAsync()}><Text style={styles.primaryText}>Sign in or create an account</Text></TouchableOpacity></View> : <><View style={styles.header}><View><Text style={styles.eyebrow}>PERSONAL DATA CONNECTIONS</Text><Text style={styles.title}>Hi{profile ? `, ${profile.first_name}` : ''}.</Text></View><TouchableOpacity onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></TouchableOpacity></View><View style={styles.card}><Text style={styles.cardTitle}>Apple Health</Text><Text style={styles.copy}>Heart rate, steps, basal energy, active calories, workout duration, and workout energy.</Text><TouchableOpacity disabled={busy} style={styles.primary} onPress={() => void sync()}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Allow access and sync 7 days</Text>}</TouchableOpacity></View><View style={styles.card}><Text style={styles.cardTitle}>Dexcom CGM</Text><Text style={styles.copy}>Glucose readings will retain the interval and timestamps provided by Dexcom.</Text><View style={styles.pending}><Text style={styles.pendingText}>Dexcom developer credentials required</Text></View></View>{message ? <Text style={styles.message}>{message}</Text> : null}</>}</ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8f9f3' }, page: { flexGrow: 1, padding: 24 }, brand: { color: '#214e3d', fontFamily: 'Georgia', fontSize: 27, fontWeight: '600', marginBottom: 42 }, hero: { flex: 1, justifyContent: 'center', paddingBottom: 70 }, eyebrow: { color: '#77866d', fontSize: 11, letterSpacing: 1.8, fontWeight: '700', marginBottom: 12 }, title: { color: '#263c30', fontFamily: 'Georgia', fontSize: 42, lineHeight: 48, marginBottom: 18 }, copy: { color: '#778175', fontSize: 15, lineHeight: 23, marginBottom: 24 }, primary: { minHeight: 52, borderRadius: 10, backgroundColor: '#214e3d', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 }, primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 25 }, link: { color: '#53715c', paddingTop: 4 }, card: { backgroundColor: '#fffefb', borderColor: '#e2e7dc', borderWidth: 1, borderRadius: 14, padding: 22, marginBottom: 16 }, cardTitle: { color: '#294333', fontFamily: 'Georgia', fontSize: 26, marginBottom: 10 }, pending: { backgroundColor: '#eff1e8', borderRadius: 9, padding: 15, alignItems: 'center' }, pendingText: { color: '#7d856d', fontSize: 12, fontWeight: '600' }, message: { color: '#496451', lineHeight: 21, padding: 10 },
});
