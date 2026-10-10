import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { createApi } from '@glucose-compass/api-client';
import type { Connections, Profile } from '@glucose-compass/contracts';
import { clearTokens, discovery, loadTokens, redirectUri, saveTokens, validAccessToken } from './src/auth';
import { config } from './src/config';
import { syncAppleHealth } from './src/health';

const dexcomReturnUrl = 'glucosecompass://integrations/dexcom';

export default function App() {
  const [tokens, setTokens] = useState<AuthSession.TokenResponse | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [connections, setConnections] = useState<Connections | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'health' | 'dexcom' | null>(null);
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
  const refresh = useCallback(async () => {
    if (!api) return;
    const [profileResult, connectionResult] = await Promise.all([api.profile(), api.connections()]);
    setProfile(profileResult.profile); setConnections(connectionResult);
  }, [api]);
  useEffect(() => { void refresh().catch(error => setMessage(error.message)); }, [refresh]);

  const connectHealth = async () => {
    if (!api) return; setBusy('health'); setMessage('');
    try {
      const result = await syncAppleHealth(api); await refresh();
      setMessage(result.accepted ? `${result.accepted} valid Apple Health observations synchronized.` : 'Apple Health is connected, but no positive observations were available in the last 7 days. Nothing was stored as zero.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Apple Health permission or synchronization failed.'); }
    finally { setBusy(null); }
  };
  const connectDexcom = async () => {
    if (!api) return; setBusy('dexcom'); setMessage('');
    try {
      const start = await api.startDexcomConnection();
      const result = await WebBrowser.openAuthSessionAsync(start.authorization_url, dexcomReturnUrl);
      if (result.type !== 'success') { setMessage(result.type === 'cancel' ? 'Dexcom connection was cancelled. No glucose data was collected.' : 'Dexcom permission was not completed.'); return; }
      const synced = await api.syncDexcom(); await refresh();
      setMessage(synced.accepted ? `${synced.accepted} Dexcom glucose readings synchronized at their original timestamps.` : 'Dexcom is connected, but it returned no recent CGM readings. The model will treat CGM as missing and will not create zero readings.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Dexcom connection failed.'); }
    finally { setBusy(null); }
  };
  const syncDexcom = async () => {
    if (!api) return; setBusy('dexcom'); setMessage('');
    try {
      const result = await api.syncDexcom(); await refresh();
      setMessage(result.accepted ? `${result.accepted} recent Dexcom readings synchronized.` : 'Dexcom returned no recent readings. No placeholder or zero readings were stored.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Dexcom synchronization failed.'); }
    finally { setBusy(null); }
  };
  const signOut = async () => { await clearTokens(); setTokens(null); setProfile(null); setConnections(null); };
  const dexcom = connections?.dexcom;
  const dexcomConnected = dexcom?.status === 'connected' || dexcom?.status === 'connected_no_data';

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.brand}>glucose compass.</Text>
    {!tokens ? <View style={styles.hero}><Text style={styles.eyebrow}>YOUR BODY · YOUR CONTEXT</Text><Text style={styles.title}>Understand your response, meal by meal.</Text><Text style={styles.copy}>Sign in, then choose whether to connect Apple Health and Dexcom. Your passwords are never shared with Glucose Compass.</Text><TouchableOpacity disabled={!request} style={styles.primary} onPress={() => void promptAsync()}><Text style={styles.primaryText}>Sign in or create an account</Text></TouchableOpacity></View> : <>
      <View style={styles.header}><View><Text style={styles.eyebrow}>CONNECT YOUR DATA</Text><Text style={styles.title}>Hi{profile ? `, ${profile.first_name}` : ''}.</Text></View><TouchableOpacity onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></TouchableOpacity></View>
      <Text style={styles.intro}>Choose each connection below. Missing data stays missing; the prediction model never interprets an absent reading as zero.</Text>
      <ConnectionCard title="Apple Health" status={connections?.apple_health.status ?? 'not_connected'} detail="Heart rate, steps, basal energy, active calories, workout duration, and workout energy." note={connections?.apple_health.last_synced_at ? `Last synchronized ${formatDate(connections.apple_health.last_synced_at)}` : 'You choose the Health permissions in the iPhone prompt.'} busy={busy === 'health'} button="Allow Apple Health and sync" onPress={connectHealth} />
      <ConnectionCard title="Dexcom CGM" status={dexcom?.status ?? 'not_connected'} detail="Glucose readings are imported at the timestamps and interval supplied by Dexcom." note={!dexcom?.configured ? 'The app is ready, but the team must add approved Dexcom credentials to AWS.' : dexcom?.status === 'connected_no_data' ? 'Connected, with no recent CGM readings. This is treated as missing data.' : dexcom?.last_reading_at ? `Latest available reading ${formatDate(dexcom.last_reading_at)}` : 'Dexcom will ask you to sign in and approve access.'} busy={busy === 'dexcom'} button={dexcomConnected ? 'Sync Dexcom again' : 'Connect Dexcom'} disabled={!dexcom?.configured} onPress={dexcomConnected ? syncDexcom : connectDexcom} />
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <View style={styles.dataRule}><Text style={styles.ruleTitle}>How gaps are handled</Text><Text style={styles.ruleText}>Zero and invalid measurements are discarded. A connected account with no readings remains “connected, no data,” and those empty periods are excluded from model input.</Text></View>
    </>}
  </ScrollView></SafeAreaView>;
}

function ConnectionCard({ title, status, detail, note, busy, button, disabled, onPress }: { title: string; status: string; detail: string; note: string; busy: boolean; button: string; disabled?: boolean; onPress: () => Promise<void> }) {
  const labels: Record<string, string> = { connected: 'Connected', connected_no_data: 'Connected · no recent data', denied: 'Permission not granted', reauthorization_required: 'Reconnect required', unavailable: 'Setup required', not_connected: 'Not connected' };
  const active = status === 'connected';
  return <View style={styles.card}><View style={styles.cardHeading}><Text style={styles.cardTitle}>{title}</Text><View style={[styles.status, active && styles.statusActive]}><Text style={[styles.statusText, active && styles.statusTextActive]}>{labels[status] ?? labels.not_connected}</Text></View></View><Text style={styles.copy}>{detail}</Text><Text style={styles.note}>{note}</Text><TouchableOpacity disabled={busy || disabled} style={[styles.primary, disabled && styles.disabled]} onPress={() => void onPress()}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{button}</Text>}</TouchableOpacity></View>;
}
function formatDate(value: string) { return new Date(value).toLocaleString(); }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8f9f3' }, page: { flexGrow: 1, padding: 24, paddingBottom: 45 }, brand: { color: '#214e3d', fontFamily: 'Georgia', fontSize: 27, fontWeight: '600', marginBottom: 38 }, hero: { flex: 1, justifyContent: 'center', paddingBottom: 70 }, eyebrow: { color: '#77866d', fontSize: 11, letterSpacing: 1.8, fontWeight: '700', marginBottom: 12 }, title: { color: '#263c30', fontFamily: 'Georgia', fontSize: 38, lineHeight: 44, marginBottom: 14 }, copy: { color: '#778175', fontSize: 15, lineHeight: 23, marginBottom: 20 }, intro: { color: '#667565', fontSize: 14, lineHeight: 21, marginBottom: 20 }, primary: { minHeight: 52, borderRadius: 10, backgroundColor: '#214e3d', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 }, disabled: { backgroundColor: '#9aa79d' }, primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 5 }, link: { color: '#53715c', paddingTop: 4 }, card: { backgroundColor: '#fffefb', borderColor: '#e2e7dc', borderWidth: 1, borderRadius: 14, padding: 22, marginBottom: 16 }, cardHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }, cardTitle: { color: '#294333', fontFamily: 'Georgia', fontSize: 25 }, status: { backgroundColor: '#f1f1ea', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 }, statusActive: { backgroundColor: '#e6f0df' }, statusText: { color: '#7d856d', fontSize: 10, fontWeight: '700' }, statusTextActive: { color: '#487143' }, note: { color: '#8a9487', fontSize: 12, lineHeight: 18, marginBottom: 18 }, message: { color: '#496451', lineHeight: 21, padding: 14, backgroundColor: '#edf3e6', borderRadius: 10, marginBottom: 16 }, dataRule: { borderTopWidth: 1, borderTopColor: '#dfe5d9', paddingTop: 18, marginTop: 5 }, ruleTitle: { color: '#405947', fontSize: 13, fontWeight: '700', marginBottom: 7 }, ruleText: { color: '#7c887b', fontSize: 12, lineHeight: 19 },
});
