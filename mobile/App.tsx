import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { createApi } from '@glucose-compass/api-client';
import { disableAppleHealthBackgroundSync, enableAppleHealthBackgroundSync, syncAppleHealth } from './src/health';
import { clearNativeSession, loadNativeSession, saveNativeSession, validNativeAccessToken, type NativeSession } from './src/auth';

const WEBSITE_URL = 'https://d1jg9rtis2fmyi.cloudfront.net';
const DEXCOM_RETURN_URL = 'glucosecompass://integrations/dexcom';
const DISABLE_ZOOM = `
  (function () {
    var viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      viewport = document.createElement('meta');
      viewport.name = 'viewport';
      document.head.appendChild(viewport);
    }
    viewport.content = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    document.documentElement.style.touchAction = 'pan-y';
    document.documentElement.style.webkitTextSizeAdjust = '100%';
    if (document.body) document.body.style.touchAction = 'pan-y';
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (name) {
      document.addEventListener(name, function (event) { event.preventDefault(); }, { passive: false });
    });
    document.addEventListener('touchmove', function (event) {
      if (event.touches && event.touches.length > 1) event.preventDefault();
    }, { passive: false });
    document.addEventListener('dblclick', function (event) { event.preventDefault(); }, { passive: false });
  })();
  true;
`;

type AuthMessage = NativeSession;
type BridgeMessage = AuthMessage | { type: 'SIGNED_OUT' } | { type: 'SYNC_NOW' } | { type: 'CONNECT_DEXCOM' };

export default function App() {
  const web = useRef<WebView>(null);
  const auth = useRef<AuthMessage | null>(null);
  const syncing = useRef(false);
  const backgroundCleanup = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const notifyWebsite = useCallback((type: 'NATIVE_SYNC_COMPLETE' | 'NATIVE_SYNC_ERROR', detail: string) => {
    const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(type)},{detail:${JSON.stringify(detail)}}));true;`;
    web.current?.injectJavaScript(script);
  }, []);

  const synchronize = useCallback(async (interactive: boolean, reconnectDexcom = false) => {
    const session = auth.current;
    if (!session || syncing.current) return;
    syncing.current = true;
    const api = createApi(session.apiUrl, async () => {
      const current = auth.current;
      if (!current) throw new Error('Sign in to synchronize health data.');
      const valid = await validNativeAccessToken(current);
      auth.current = valid;
      return valid.accessToken;
    });
    try {
      const connections = await api.connections();
      const permissionKey = `permissions-requested-${session.userId}`;
      const alreadyRequested = await SecureStore.getItemAsync(permissionKey);
      const dexcomPermissionKey = `dexcom-requested-${session.userId}`;
      const dexcomAlreadyRequested = await SecureStore.getItemAsync(dexcomPermissionKey);

      if (interactive || !alreadyRequested || connections.apple_health.status !== 'not_connected') {
        await syncAppleHealth(api, session.userId);
      }

      if (connections.dexcom.configured) {
        const connected = connections.dexcom.status === 'connected' || connections.dexcom.status === 'connected_no_data';
        if (reconnectDexcom || (!connected && (interactive || !dexcomAlreadyRequested))) {
          const start = await api.startDexcomConnection();
          const result = await WebBrowser.openAuthSessionAsync(start.authorization_url, DEXCOM_RETURN_URL);
          await SecureStore.setItemAsync(dexcomPermissionKey, new Date().toISOString());
          if (result.type === 'success') await api.syncDexcom();
        } else if (connected) {
          await api.syncDexcom();
        }
      }

      await SecureStore.setItemAsync(permissionKey, new Date().toISOString());
      notifyWebsite('NATIVE_SYNC_COMPLETE', 'Your available Apple Health and Dexcom data are synchronized.');
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : 'Health synchronization could not be completed.';
      if (interactive) setError(message);
      notifyWebsite('NATIVE_SYNC_ERROR', message);
    } finally { syncing.current = false; }
  }, [notifyWebsite]);

  const startBackgroundHealthSync = useCallback(async () => {
    const cleanup = await enableAppleHealthBackgroundSync(() => { void synchronize(false); });
    backgroundCleanup.current?.();
    backgroundCleanup.current = cleanup;
  }, [synchronize]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as BridgeMessage;
      if (message.type === 'AUTHENTICATED') {
        const changedUser = auth.current?.userId !== message.userId;
        const session = {
          ...message,
          refreshToken: message.refreshToken ?? (!changedUser ? auth.current?.refreshToken : undefined),
        };
        auth.current = session;
        void saveNativeSession(session);
        if (changedUser) void synchronize(false).then(startBackgroundHealthSync);
      } else if (message.type === 'SYNC_NOW') {
        void synchronize(true);
      } else if (message.type === 'CONNECT_DEXCOM') {
        void synchronize(true, true);
      } else if (message.type === 'SIGNED_OUT') {
        auth.current = null;
        void clearNativeSession();
        backgroundCleanup.current?.();
        backgroundCleanup.current = null;
        void disableAppleHealthBackgroundSync();
      }
    } catch { /* Ignore messages not created by the Glucose Compass website. */ }
  }, [startBackgroundHealthSync, synchronize]);

  useEffect(() => {
    let active = true;
    void loadNativeSession().then(session => {
      if (!active || !session) return;
      auth.current = session;
      void synchronize(false).then(async () => {
        if (!active) return;
        await startBackgroundHealthSync();
      });
    });
    return () => {
      active = false;
      backgroundCleanup.current?.();
      backgroundCleanup.current = null;
    };
  }, [startBackgroundHealthSync, synchronize]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && auth.current) void synchronize(false);
    });
    return () => subscription.remove();
  }, [synchronize]);

  return <SafeAreaView style={styles.safe}>
    <WebView
      ref={web}
      source={{ uri: WEBSITE_URL }}
      injectedJavaScriptBeforeContentLoaded={DISABLE_ZOOM}
      injectedJavaScript={DISABLE_ZOOM}
      style={styles.web}
      onMessage={onMessage}
      onLoadEnd={() => { web.current?.injectJavaScript(DISABLE_ZOOM); setLoading(false); }}
      onError={() => { setLoading(false); setError('The app could not reach Glucose Compass. Check your internet connection and try again.'); }}
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      javaScriptEnabled
      domStorageEnabled
      bounces={false}
      scalesPageToFit={false}
      setBuiltInZoomControls={false}
      setDisplayZoomControls={false}
      textZoom={100}
      allowsBackForwardNavigationGestures
      allowsInlineMediaPlayback
      applicationNameForUserAgent="GlucoseCompassMobile/1.0"
      setSupportMultipleWindows={false}
    />
    {loading && <View style={styles.overlay}><ActivityIndicator size="large" color="#214e3d" /><Text style={styles.loading}>Opening Glucose Compass…</Text></View>}
    {error && <View style={styles.error}><Text style={styles.errorText}>{error}</Text><TouchableOpacity onPress={() => { setError(''); web.current?.reload(); }}><Text style={styles.retry}>Try again</Text></TouchableOpacity></View>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8f9f3' },
  web: { flex: 1, backgroundColor: '#f8f9f3' },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#f8f9f3', alignItems: 'center', justifyContent: 'center', gap: 14 },
  loading: { color: '#536b58', fontSize: 14 },
  error: { position: 'absolute', left: 16, right: 16, bottom: 20, padding: 15, borderRadius: 12, backgroundColor: '#fff4ee', borderWidth: 1, borderColor: '#e4c8ba', flexDirection: 'row', alignItems: 'center', gap: 12 },
  errorText: { flex: 1, color: '#6d5047', fontSize: 13, lineHeight: 18 },
  retry: { color: '#214e3d', fontWeight: '700' },
});
