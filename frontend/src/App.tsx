import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { User, UserManager } from 'oidc-client-ts';
import { Activity, ArrowDownToLine, ArrowRight, Camera, Check, ChevronDown, CircleHelp, FileText, Footprints, HeartPulse, Image as ImageIcon, ImagePlus, LayoutDashboard, Leaf, LogOut, Plus, Search, ShieldCheck, Sparkles, Trash2, Upload, UserRound, Utensils, X } from 'lucide-react';
import { createApi, type Api } from '@glucose-compass/api-client';
import type { ActivityImportStatus, ActivityReading, DiabetesStatus, Food, HealthRecord, ImportStatus, Interpretation, Meal, MealPhoto, MealPhotoContentType, Nutrition, PhotoAnalysis, Prediction, Profile, ProfileInput, Reading, RuntimeConfig } from '@glucose-compass/contracts';
import { createAuth } from './auth';

type View = 'overview' | 'meal' | 'health' | 'prediction';
const emptyNutrition = (): Nutrition => ({ carbs_g: 0, protein_g: 0, fat_g: 0, fiber_g: 0, calories: 0 });
const localTime = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const friendlyDate = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const photoTypes: Record<string, MealPhotoContentType> = {
  'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp',
  'image/gif': 'image/gif', 'image/heic': 'image/heic', 'image/heif': 'image/heif', 'image/avif': 'image/avif',
  'image/bmp': 'image/bmp', 'image/x-ms-bmp': 'image/bmp', 'image/tiff': 'image/tiff', 'image/x-tiff': 'image/tiff',
};
const extensionTypes: Record<string, MealPhotoContentType> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', dib: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};
const detectPhotoType = (file: File) => photoTypes[file.type.toLowerCase()] ?? extensionTypes[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? null;

declare global { interface Window { ReactNativeWebView?: { postMessage: (message: string) => void } } }
const postToNative = (message: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
const requestNativeData = (type: 'SYNC_NOW' | 'CONNECT_DEXCOM') => {
  if (!window.ReactNativeWebView) return Promise.resolve();
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('NATIVE_SYNC_COMPLETE', finish); window.removeEventListener('NATIVE_SYNC_ERROR', finish); resolve(); };
    const timer = window.setTimeout(finish, 60000);
    window.addEventListener('NATIVE_SYNC_COMPLETE', finish, { once: true });
    window.addEventListener('NATIVE_SYNC_ERROR', finish, { once: true });
    postToNative({ type });
  });
};
const refreshNativeData = () => requestNativeData('SYNC_NOW');
const connectNativeDexcom = () => requestNativeData('CONNECT_DEXCOM');

export function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [preview, setPreview] = useState(false);
  const [view, setView] = useState<View>('overview');
  const [notice, setNotice] = useState('');
  const [meals, setMeals] = useState<Meal[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [activity, setActivity] = useState<ActivityReading[]>([]);
  const [healthRecords, setHealthRecords] = useState<HealthRecord[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [hasMoreMeals, setHasMoreMeals] = useState(false);
  const auth = useRef<UserManager | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    (async () => {
      try {
        const response = await fetch('/config.json', { cache: 'no-store' });
        const settings: RuntimeConfig = await response.json();
        setConfig(settings);
        if (settings.configured) {
          const manager = createAuth(settings); auth.current = manager;
          if (location.pathname === '/auth/callback') {
            setUser(await manager.signinRedirectCallback());
            history.replaceState({}, '', '/');
          } else {
            const session = await manager.getUser();
            if (session && !session.expired) setUser(session);
          }
          manager.events.addUserLoaded(setUser);
          manager.events.addUserUnloaded(() => setUser(null));
          manager.events.addSilentRenewError(() => { setUser(null); setNotice('Your session ended. Please sign in again.'); });
        }
      } catch { setNotice('The sign-in configuration could not be loaded. Please refresh or contact the team.'); }
      finally { setReady(true); }
    })();
  }, []);

  const api = useMemo<Api | null>(() => config?.configured && user ? createApi(config.apiUrl, async () => {
    const session = await auth.current!.getUser();
    if (!session || session.expired) throw new Error('Your session ended. Please sign in again.');
    return session.access_token;
  }) : null, [config, user]);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [historyPage, cgm, movement, participant, health] = await Promise.all([api.meals(), api.readings(), api.activity(), api.profile(), api.healthData()]);
      setMeals(historyPage.items); setHasMoreMeals(historyPage.has_more); setReadings(cgm.items); setActivity(movement.items);
      setProfile(participant.profile); setHealthRecords(health.items);
    } catch (error) { setNotice(errorMessage(error)); }
    finally { setProfileLoaded(true); }
  }, [api]);
  useEffect(() => { void refresh(); }, [api]);
  useEffect(() => {
    if (!api) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const interval = window.setInterval(refreshWhenVisible, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [api, refresh]);
  useEffect(() => {
    if (!user || !config) { postToNative({ type: 'SIGNED_OUT' }); return; }
    void auth.current?.getUser().then(session => {
      if (session && !session.expired) postToNative({
        type: 'AUTHENTICATED', accessToken: session.access_token, refreshToken: session.refresh_token,
        expiresAt: session.expires_at, apiUrl: config.apiUrl, userId: String(session.profile.sub),
        clientId: config.clientId, cognitoDomain: config.cognitoDomain,
      });
    });
  }, [user, config]);
  useEffect(() => {
    const synchronized = () => { void refresh(); };
    window.addEventListener('NATIVE_SYNC_COMPLETE', synchronized);
    return () => window.removeEventListener('NATIVE_SYNC_COMPLETE', synchronized);
  }, [refresh]);

  const signIn = async () => {
    if (!auth.current) return;
    try { await auth.current.signinRedirect(); } catch (error) { setNotice(errorMessage(error)); }
  };
  const signOut = async () => {
    postToNative({ type: 'SIGNED_OUT' });
    if (auth.current && config) {
      try { await auth.current.revokeTokens(['refresh_token']); } catch { /* Local session is always cleared. */ }
      await auth.current.removeUser();
      setUser(null); setMeals([]); setReadings([]); setActivity([]); setHealthRecords([]); setProfile(null); setPrediction(null); setProfileLoaded(false); setAccountOpen(false);
      location.assign(`${config.cognitoDomain}/logout?client_id=${encodeURIComponent(config.clientId)}&logout_uri=${encodeURIComponent(`${location.origin}/`)}`);
    } else { setPreview(false); setMeals([]); setReadings([]); setActivity([]); setHealthRecords([]); setProfile(null); setPrediction(null); setProfileLoaded(false); setAccountOpen(false); }
  };
  const saveMeal = async (saved: Meal) => { setMeals(previous => [saved, ...previous.filter(x => x.id !== saved.id)]); setView('overview'); setNotice(preview ? 'Preview meal added for this session only.' : 'Your meal is saved.'); };
  if (!ready) return <div className="boot"><Leaf size={28} /><p>Opening your workspace…</p></div>;
  if (!user && !preview) return <div className="welcome">
    <header><Brand /><span className="eyebrow">PERSONAL WELLNESS JOURNAL</span></header>
    <main className="welcome-grid"><div><span className="pill"><span className="dot" /> YOUR BODY. YOUR CONTEXT.</span><h1>A little more context.<br /><em>A clearer picture.</em></h1><p className="welcome-copy">Bring your meals and glucose history together. Discover the patterns that make your everyday experience yours.</p><div className="welcome-actions"><button className="primary" onClick={signIn} disabled={!config?.configured}>Sign in or create an account <ArrowRight size={18} /></button>{!config?.configured && <button className="secondary" onClick={() => setPreview(true)}>Explore the workspace</button>}</div>{!config?.configured && <p className="setup-note">Local preview · AWS sign-in is awaiting deployment.</p>}{notice && <p role="alert" className="notice">{notice}</p>}<div className="welcome-trust"><ShieldCheck size={18} /> Your journal belongs to you.</div></div><div className="welcome-visual"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><Leaf className="hero-leaf" size={150} strokeWidth={.65} /><div className="floating-card"><span className="icon-box"><Utensils size={20} /></span><div><strong>Meal by meal.</strong><span>Build your personal picture.</span></div><Check size={18} /></div><div className="visual-caption">A space to understand<br /><em>your daily rhythm.</em></div></div></main><footer>Glucose Compass · RU Health Hackathon <span>Research prototype. Not for diagnosis or medication decisions.</span></footer>
  </div>;

  if (user && api && !profileLoaded) return <div className="boot"><Leaf size={28} /><p>Preparing your profile…</p></div>;
  if (user && api && !profile) return <Onboarding api={api} onSaved={setProfile} onSignOut={signOut} />;

  return <div className="app-shell">
    <aside className="sidebar"><Brand /><div className="workspace-label">YOUR WORKSPACE</div><nav aria-label="Main navigation">{([
      ['overview', LayoutDashboard, 'Overview'], ['meal', Utensils, 'Log a meal'], ['health', HeartPulse, 'Health data'], ['prediction', Sparkles, 'Prediction'],
    ] as const).map(([key, Icon, label]) => <button key={key} className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => { setView(key); setNotice(''); setAccountOpen(false); }}><Icon size={19} /><span>{label}</span>{view === key && <span className="nav-dot" />}</button>)}<button className={accountOpen ? 'nav-item mobile-account-nav active' : 'nav-item mobile-account-nav'} onClick={() => setAccountOpen(open => !open)}><UserRound size={19} /><span>Account</span></button></nav><div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={20} /><strong>Personal by design</strong><p>Your meals and readings stay connected to your account.</p></div><div className="account-area">{accountOpen && <div className="account-menu" role="menu"><div><strong>{preview ? 'Preview workspace' : profile ? `${profile.first_name} ${profile.last_name}` : 'Signed in'}</strong><small>{preview ? 'Local demonstration' : String(user?.profile.email ?? 'Your private account')}</small></div><button role="menuitem" onClick={() => void signOut()}><LogOut size={16} />{preview ? 'Exit preview' : 'Sign out'}</button></div>}<button className="account-button" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen(open => !open)}><span className="avatar">{preview ? 'P' : (profile?.first_name?.[0] ?? user?.profile.email?.[0] ?? 'Y').toUpperCase()}</span><span><strong>{preview ? 'Preview workspace' : profile?.first_name ?? 'Your account'}</strong><small>{preview ? 'Open options' : String(user?.profile.email ?? 'Open profile')}</small></span><ChevronDown className={accountOpen ? 'account-chevron open' : 'account-chevron'} size={17} /></button></div></div></aside>
    <div className="main-shell"><header className="topbar"><span>YOUR DAILY RHYTHM</span><div><span className="dot" /> {preview ? 'Local preview' : 'Personal journal'}<span className="topbar-divider" />{new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div></header>
      <main className="content">{preview && <div className="preview-banner"><CircleHelp size={17} /><span>Preview workspace. Sign-in, uploads, and cloud saving will work after AWS deployment. Preview entries disappear when you leave.</span></div>}{notice && <div role="status" className="notice"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={16} /></button></div>}
      {view === 'overview' && <><div className="page-heading"><div><p className="eyebrow">ONE MEAL AT A TIME</p><h1>Your daily picture</h1><p>A little context for the way your body responds.</p></div><button className="primary" onClick={() => setView('meal')}><Plus size={18} /> Log a meal</button></div>
        <div className="summary-grid summary-grid-two"><Summary icon={<Utensils size={20} />} label="Meals in your journal" value={String(meals.length)} detail={hasMoreMeals ? 'Showing your latest 100' : meals.length ? 'Every entry adds context' : 'Your first meal starts the story'} /><Summary icon={<Activity size={20} />} label="Latest glucose reading" value={readings.length ? String(Math.round(readings.at(-1)!.glucose_mg_dl)) : '—'} unit={readings.length ? 'mg/dL' : ''} detail={readings.length ? friendlyDate(readings.at(-1)!.timestamp) : 'Connect your history with a CGM upload'} /></div>
        <div className="dashboard-grid"><section className="panel glucose-panel"><div className="panel-heading"><div><h2>Your glucose history</h2><p>Observed readings, with your meals in context.</p></div><span className="chip">{readings.length ? 'Latest readings' : 'No data yet'}</span></div>{readings.length ? <GlucoseChart readings={readings} /> : <div className="chart-empty"><div className="chart-grid"><i /><i /><i /><i /></div><div className="empty-icon"><Activity size={29} strokeWidth={1.5} /></div><h3>Your story starts with your data</h3><p>Upload a CGM export to see your glucose history here.</p><button className="secondary" onClick={() => setView('health')}><Upload size={16} /> Open health data</button></div>}<div className="panel-foot"><span className="legend-dot" /> Observed glucose <span className="muted">Up to 288 recent readings</span></div></section>
          <section className="next-step-card"><span className="round-icon"><Leaf size={25} /></span><p className="eyebrow">MAKE IT PERSONAL</p><h2>Small entries.<br />More understanding.</h2><p>What you eat and when you eat it add meaningful context to your glucose history.</p><ol><li><span>01</span> Bring in your health data</li><li><span>02</span> Log a meal and its portions</li><li><span>03</span> Predict a meal you may eat</li></ol><button onClick={async () => { if (!window.ReactNativeWebView) { setNotice('Open Glucose Compass on your iPhone to connect Apple Health and Dexcom.'); return; } setNotice('Opening your health connections…'); await refreshNativeData(); setNotice('Your available Apple Health and Dexcom data are synchronized.'); }}><HeartPulse size={18} /> Connect or sync health data</button><button onClick={() => setView(readings.length ? 'prediction' : 'health')}>Take the next step <ArrowRight size={18} /></button></section></div>
        <section className="panel recent-panel"><div className="panel-heading"><div><h2>Recent meals</h2><p>Your latest journal entries.</p></div><span className="chip">Latest {Math.min(3, meals.length)}</span></div>{meals.length ? meals.slice(0, 3).map(meal => <MealRow key={meal.id} meal={meal} />) : <div className="empty-row"><span className="icon-box"><Utensils size={20} /></span><div><strong>A fresh page for your meals</strong><p>Search for a food or describe what you ate.</p></div><button className="text-button" onClick={() => setView('meal')}>Add your first meal <Plus size={16} /></button></div>}</section>
      </>}
      {view === 'meal' && <MealForm api={api} preview={preview} onSaved={saveMeal} onError={setNotice} />}
      {view === 'health' && <><div className="page-heading"><div><p className="eyebrow">YOUR CONNECTED CONTEXT</p><h1>Health data</h1><p>Manage CGM uploads, Apple Health, activity, and heart-rate information together.</p></div></div><section className="health-section"><div className="section-title"><Activity size={21} /><div><h2>CGM data</h2><p>Upload and review your glucose history.</p></div></div><DataUpload api={api} onError={setNotice} onReady={refresh} readings={readings} embedded /></section><section className="health-section"><div className="section-title"><HeartPulse size={21} /><div><h2>Activity and Apple Health</h2><p>Upload activity data or synchronize it from the iPhone app.</p></div></div><ActivityUpload api={api} onError={setNotice} onReady={refresh} activity={activity} healthRecords={healthRecords} embedded /></section></>}
      {view === 'prediction' && <><div className="page-heading"><div><p className="eyebrow">EXPLORE A FUTURE MEAL</p><h1>Predict a meal response</h1><p>Build a meal without adding it to your journal, then estimate its two-hour response.</p></div></div><MealForm api={api} preview={preview} onError={setNotice} predictionMode onPredicted={result => { setPrediction(result); setNotice(result.input_summary.reference_cgm_fallback_used ? 'Prediction ready using the shared CGM reference because this account has no uploaded CGM.' : 'Prediction ready and checked for wellness language.'); }} />{prediction && <PredictionPanel prediction={prediction} />}</>}
      <footer className="app-footer"><span>Made for your everyday understanding.</span><span>Research prototype · No diagnosis or medication advice</span></footer></main>
    </div>
    {accountOpen && <div className="mobile-account-overlay" role="dialog" aria-modal="true" aria-label="Account options"><button className="mobile-account-backdrop" aria-label="Close account options" onClick={() => setAccountOpen(false)} /><section><button className="mobile-account-close" aria-label="Close account options" onClick={() => setAccountOpen(false)}><X size={20} /></button><span className="avatar">{preview ? 'P' : (profile?.first_name?.[0] ?? user?.profile.email?.[0] ?? 'Y').toUpperCase()}</span><h2>{preview ? 'Preview workspace' : profile ? `${profile.first_name} ${profile.last_name}` : 'Your account'}</h2><p>{preview ? 'Local demonstration' : String(user?.profile.email ?? 'Your private account')}</p>{!preview && <button className="mobile-connect" onClick={async () => { setAccountOpen(false); setNotice('Opening Dexcom authorization…'); await connectNativeDexcom(); setNotice('Dexcom connection finished. Your available data is synchronized.'); }}><HeartPulse size={18} /> Connect or change Dexcom</button>}<button className="mobile-signout" onClick={() => void signOut()}><LogOut size={18} />{preview ? 'Exit preview' : 'Sign out'}</button></section></div>}
  </div>;
}

function Onboarding({ api, onSaved, onSignOut }: { api: Api; onSaved: (profile: Profile) => void; onSignOut: () => Promise<void> }) {
  type ProfileForm = Omit<ProfileInput, 'age' | 'height' | 'weight'> & { age: string; height: string; weight: string };
  const [form, setForm] = useState<ProfileForm>({ first_name: '', last_name: '', age: '', height: '', height_unit: 'cm', weight: '', weight_unit: 'kg', diabetes_status: 'unknown' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => setForm(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      if (!form.age || !form.height || !form.weight) throw new Error('Enter your age, height, and weight.');
      onSaved(await api.saveProfile({ ...form, age: Number(form.age), height: Number(form.height), weight: Number(form.weight) }));
    }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setSaving(false); }
  };
  const statuses: { value: DiabetesStatus; label: string }[] = [
    { value: 'type_1', label: 'Type 1' }, { value: 'type_2', label: 'Type 2' },
    { value: 'no_diabetes', label: 'No diabetes' }, { value: 'unknown', label: 'Unknown' },
  ];
  return <div className="onboarding"><header><Brand /><button className="text-button" onClick={() => void onSignOut()}><LogOut size={16} /> Sign out</button></header><main><section className="onboarding-copy"><span className="pill"><span className="dot" /> YOUR STARTING POINT</span><h1>Let’s personalize<br /><em>your experience.</em></h1><p>These details help your future model understand your individual context. You can still review every meal and prediction before using it.</p><div className="onboarding-private"><ShieldCheck size={21} /><span><strong>Private to your account</strong><small>Saved in your protected AWS data partition.</small></span></div></section><form className="onboarding-form" onSubmit={submit}><div><p className="eyebrow">A FEW DETAILS ABOUT YOU</p><h2>Complete your profile</h2><p>This takes about a minute.</p></div>{error && <div className="notice" role="alert">{error}</div>}<div className="form-two"><label>First name<input required autoComplete="given-name" maxLength={80} value={form.first_name} onChange={event => update('first_name', event.target.value)} /></label><label>Last name<input required autoComplete="family-name" maxLength={80} value={form.last_name} onChange={event => update('last_name', event.target.value)} /></label></div><label>Age<input required type="number" min={1} max={120} inputMode="numeric" placeholder="Age" value={form.age} onChange={event => update('age', event.target.value)} /></label><div className="form-two"><label>Height<div className="measure-field"><input required type="number" min={form.height_unit === 'cm' ? 50 : 20} max={form.height_unit === 'cm' ? 250 : 100} step="0.1" inputMode="decimal" placeholder={form.height_unit === 'cm' ? '170' : '67'} value={form.height} onChange={event => update('height', event.target.value)} /><select aria-label="Height unit" value={form.height_unit} onChange={event => update('height_unit', event.target.value as 'cm' | 'in')}><option value="cm">cm</option><option value="in">inches</option></select></div></label><label>Weight<div className="measure-field"><input required type="number" min={form.weight_unit === 'kg' ? 20 : 44} max={form.weight_unit === 'kg' ? 500 : 1100} step="0.1" inputMode="decimal" placeholder={form.weight_unit === 'kg' ? '70' : '154'} value={form.weight} onChange={event => update('weight', event.target.value)} /><select aria-label="Weight unit" value={form.weight_unit} onChange={event => update('weight_unit', event.target.value as 'kg' | 'lb')}><option value="kg">kg</option><option value="lb">pounds</option></select></div></label></div><fieldset><legend>Which option describes you?</legend><div className="status-options">{statuses.map(option => <label key={option.value} className={form.diabetes_status === option.value ? 'selected' : ''}><input type="radio" name="diabetes-status" value={option.value} checked={form.diabetes_status === option.value} onChange={() => update('diabetes_status', option.value)} /><span>{option.label}</span></label>)}</div></fieldset><button className="primary full-width" type="submit" disabled={saving}><Check size={18} />{saving ? 'Saving your profile…' : 'Continue to my dashboard'}</button><small className="onboarding-note">Research prototype · This information supports wellness personalization and is not used to diagnose a condition.</small></form></main></div>;
}

function Brand() { return <div className="brand"><span><Leaf size={23} strokeWidth={1.7} /></span><strong>glucose compass<span className="brand-period">.</span></strong></div>; }
function Summary({ icon, label, value, unit, detail }: { icon: React.ReactNode; label: string; value: string; unit?: string; detail: string }) { return <section className="summary-card"><div className="summary-label">{label}<span>{icon}</span></div><div className="summary-value">{value}<small>{unit}</small></div><p>{detail}</p></section>; }
function Empty({ title, text, icon }: { title: string; text: string; icon: React.ReactNode }) { return <div className="simple-empty"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{text}</p></div>; }
const genericMealNames = new Set(['food', 'food item', 'meal item', 'unknown food', 'visible food']);
function mealTitle(meal: Meal) {
  const parts = meal.description.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  if (meal.description.trim() && !(parts.length && parts.every(part => genericMealNames.has(part)))) return meal.description;
  const foods = [...new Set(meal.foods.map(food => food.name).filter(Boolean))];
  return foods.join(', ') || 'Saved meal';
}
function MealRow({ meal }: { meal: Meal }) { return <article className="meal-row"><span className="meal-icon">{meal.photo ? <ImageIcon size={20} /> : <Utensils size={20} />}</span><div className="meal-main"><h3>{mealTitle(meal)}</h3><p>{friendlyDate(meal.eaten_at)}</p></div></article>; }

function PredictionPanel({ prediction }: { prediction: Prediction }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [prediction.id]);
  const points = [{ minutes: 0, glucose_mg_dl: prediction.baseline_mg_dl }, ...prediction.curve.filter(point => point.minutes > 0)].sort((a, b) => a.minutes - b.minutes);
  const allValues = points.map(point => point.glucose_mg_dl);
  const min = Math.floor((Math.min(...allValues) - 10) / 10) * 10;
  const max = Math.ceil((Math.max(...allValues) + 10) / 10) * 10;
  const width = 900, height = 360, left = 64, right = 28, top = 24, bottom = 54;
  const x = (minutes: number) => left + minutes / 120 * (width - left - right);
  const y = (value: number) => top + (max - value) / Math.max(1, max - min) * (height - top - bottom);
  const line = points.map(point => `${x(point.minutes)},${y(point.glucose_mg_dl)}`).join(' ');
  const guardrailLabel = prediction.guardrail_status === 'passed' ? 'Bedrock wellness check passed' : prediction.guardrail_status === 'blocked' ? 'Bedrock blocked the explanation' : 'Bedrock check unavailable';
  return <section ref={panel} className="panel prediction-panel prediction-graph-only" aria-live="polite"><div className="prediction-heading"><div><p className="eyebrow">PERSONAL RESPONSE ESTIMATE</p><h2>Predicted glucose response</h2><p>Glucose level from 0 to 120 minutes after the meal.</p></div><span className={`wellness-status ${prediction.guardrail_status}`}><ShieldCheck size={16} /> {guardrailLabel}</span></div><div className="prediction-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Predicted glucose starts at ${Math.round(prediction.baseline_mg_dl)} and peaks at ${Math.round(prediction.peak_mg_dl)} milligrams per deciliter around ${prediction.time_to_peak_minutes} minutes.`}>{[0, .25, .5, .75, 1].map(fraction => { const value = max - fraction * (max - min); return <g key={fraction}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="chart-rule" /><text x={left - 12} y={y(value) + 4} textAnchor="end">{Math.round(value)}</text></g>; })}<text x="16" y={height / 2} textAnchor="middle" className="axis-title" transform={`rotate(-90 16 ${height / 2})`}>Glucose (mg/dL)</text>{[0, 30, 60, 90, 120].map(minutes => <g key={minutes}><line x1={x(minutes)} x2={x(minutes)} y1={top} y2={height - bottom} className="chart-rule vertical" /><text x={x(minutes)} y={height - 28} textAnchor="middle">{minutes}</text></g>)}<text x={(left + width - right) / 2} y={height - 7} textAnchor="middle" className="axis-title">Minutes after meal</text><polyline points={line} className="prediction-line" />{points.filter(point => point.minutes % 30 === 0).map(point => <g key={point.minutes}><circle cx={x(point.minutes)} cy={y(point.glucose_mg_dl)} r="5" /><text x={x(point.minutes)} y={y(point.glucose_mg_dl) - 13} textAnchor="middle" className="point-label">{Math.round(point.glucose_mg_dl)}</text></g>)}</svg></div></section>;
}

function MealForm({ api, preview = false, onSaved, onError, predictionMode = false, onPredicted }: { api: Api | null; preview?: boolean; onSaved?: (meal: Meal) => void; onError: (message: string) => void; predictionMode?: boolean; onPredicted?: (prediction: Prediction) => void }) {
  const [mode, setMode] = useState<'search' | 'text' | 'photo'>('search');
  const [query, setQuery] = useState(''); const [results, setResults] = useState<Food[]>([]);
  const [description, setDescription] = useState(''); const [eatenAt, setEatenAt] = useState(localTime());
  const [selected, setSelected] = useState<{ food: Food; grams: number }[]>([]);
  const [interpreted, setInterpreted] = useState<Interpretation | null>(null);
  const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoContentType, setPhotoContentType] = useState<MealPhotoContentType | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoPreviewFailed, setPhotoPreviewFailed] = useState(false);
  const [uploadedPhoto, setUploadedPhoto] = useState<MealPhoto | null>(null);
  const [photoAnalysis, setPhotoAnalysis] = useState<PhotoAnalysis | null>(null);
  const [analyzingPhoto, setAnalyzingPhoto] = useState(false);
  const photoPreviewRef = useRef('');
  const photoRequest = useRef(0);
  const requestKey = useRef({ payload: '', id: '' });
  useEffect(() => () => { if (photoPreviewRef.current) URL.revokeObjectURL(photoPreviewRef.current); }, []);
  useEffect(() => {
    let live = true;
    if (query.trim().length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const foods = api ? (await api.foods(query)).items : ((await (await fetch('/preview-catalog.json')).json()) as Food[]).filter(f => query.toLowerCase().split(/\s+/).every(word => f.name.toLowerCase().includes(word))).slice(0, 20);
        if (live) setResults(foods);
      } catch (error) { if (live) onError(errorMessage(error)); }
      finally { if (live) setSearching(false); }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, api]);
  const add = (food: Food, grams = 100) => { setSelected(list => [...list, { food, grams }]); };
  const uploadAndAnalyzePhoto = async (file: File, contentType: MealPhotoContentType, requestId: number) => {
    if (!api) { onError('Photo identification requires AWS sign-in.'); return; }
    setAnalyzingPhoto(true);
    try {
      const started = await api.startMealPhoto(file.name, contentType, file.size);
      const uploadBody = new FormData(); Object.entries(started.upload.fields).forEach(([key, value]) => uploadBody.append(key, value)); uploadBody.append('file', file);
      const uploaded = await fetch(started.upload.url, { method: 'POST', body: uploadBody });
      if (!uploaded.ok) throw new Error('The meal photo upload failed. Please try again.');
      const ready = await api.completeMealPhoto(started.photo.id);
      const analysis = await api.analyzeMealPhoto(ready.id);
      if (photoRequest.current !== requestId) return;
      if (photoPreviewRef.current) URL.revokeObjectURL(photoPreviewRef.current);
      photoPreviewRef.current = '';
      setPhotoPreview(analysis.preview_url); setPhotoPreviewFailed(false);
      const suggestions = analysis.items.reduce<{ food: Food; grams: number }[]>((list, item) => {
        const food = item.matches[0];
        if (!food) return list;
        const existing = list.findIndex(entry => entry.food.id === food.id);
        if (existing >= 0) return list.map((entry, index) => index === existing ? { ...entry, grams: entry.grams + item.grams } : entry);
        return [...list, { food, grams: item.grams }];
      }, []);
      setUploadedPhoto(ready); setPhotoAnalysis(analysis); setSelected(suggestions);
      setDescription(analysis.items.map(item => item.name).join(', '));
      if (!suggestions.length) onError('Foods were detected, but none matched the USDA catalog. Try another photo or use food search.');
    } catch (error) {
      if (photoRequest.current === requestId) onError(errorMessage(error));
    } finally {
      if (photoRequest.current === requestId) setAnalyzingPhoto(false);
    }
  };
  const choosePhoto = (file: File | null) => {
    if (!file) return;
    const contentType = detectPhotoType(file);
    if (!contentType) { onError('Choose a JPEG, PNG, HEIC, HEIF, AVIF, WebP, GIF, BMP, or TIFF image.'); return; }
    if (file.size > 15 * 1024 * 1024) { onError('Choose an image smaller than 15 MB.'); return; }
    if (photoPreviewRef.current) URL.revokeObjectURL(photoPreviewRef.current);
    const nextPreview = URL.createObjectURL(file); photoPreviewRef.current = nextPreview;
    const requestId = ++photoRequest.current;
    setPhotoFile(file); setPhotoContentType(contentType); setPhotoPreview(nextPreview); setPhotoPreviewFailed(false); setUploadedPhoto(null); setPhotoAnalysis(null); setSelected([]); setDescription('');
    void uploadAndAnalyzePhoto(file, contentType, requestId);
  };
  const total = selected.reduce((sum, item) => { for (const key of Object.keys(sum) as (keyof Nutrition)[]) sum[key] += item.food.per_100g[key] * item.grams / 100; return sum; }, emptyNutrition());
  const interpret = async () => {
    if (!api) { onError('Text interpretation needs the AWS connection. Try food search in this preview.'); return; }
    setLoading(true);
    try { setInterpreted(await api.interpret(description)); } catch (error) { onError(errorMessage(error)); } finally { setLoading(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected.length || saving) return;
    setSaving(true);
    try {
      let readyPhoto = uploadedPhoto;
      if (mode === 'photo' && photoFile && photoContentType && !readyPhoto) {
        if (api) {
          const started = await api.startMealPhoto(photoFile.name, photoContentType, photoFile.size);
          const uploadBody = new FormData(); Object.entries(started.upload.fields).forEach(([key, value]) => uploadBody.append(key, value)); uploadBody.append('file', photoFile);
          const uploaded = await fetch(started.upload.url, { method: 'POST', body: uploadBody });
          if (!uploaded.ok) throw new Error('The meal photo upload failed. Please try again.');
          readyPhoto = await api.completeMealPhoto(started.photo.id); setUploadedPhoto(readyPhoto);
        } else {
          readyPhoto = { id: crypto.randomUUID(), filename: photoFile.name, content_type: photoContentType, size_bytes: photoFile.size, status: 'ready' };
        }
      }
      const fields = { description, eaten_at: new Date(eatenAt).toISOString(), entry_method: mode, foods: selected.map(x => ({ food_id: x.food.id, grams: x.grams })), ...(readyPhoto ? { photo_id: readyPhoto.id } : {}) };
      if (predictionMode) {
        if (!api) throw new Error('Sign in to request a prediction.');
        onPredicted?.(await api.predictMeal(fields));
        return;
      }
      const payload = JSON.stringify(fields);
      if (requestKey.current.payload !== payload) requestKey.current = { payload, id: crypto.randomUUID() };
      const saved = api ? await api.saveMeal({ ...fields, request_id: requestKey.current.id }) : {
        id: requestKey.current.id, description, eaten_at: fields.eaten_at, created_at: new Date().toISOString(), nutrition: total,
        foods: selected.map(x => ({ food_id: x.food.id, name: x.food.name, grams: x.grams, nutrition: Object.fromEntries(Object.entries(x.food.per_100g).map(([k, v]) => [k, v * x.grams / 100])) as unknown as Nutrition })),
        ...(readyPhoto ? { photo: readyPhoto } : {}),
      };
      onSaved?.(saved);
    } catch (error) { onError(errorMessage(error)); } finally { setSaving(false); }
  };
  return <>{!predictionMode && <div className="page-heading"><div><p className="eyebrow">ADD A LITTLE CONTEXT</p><h1>What’s on your plate?</h1><p>Find your foods, confirm the portions, and make it part of your journal.</p></div></div>}<form className="meal-form-grid" onSubmit={save}><section className="panel meal-editor"><div className="tabs"><button type="button" className={mode === 'search' ? 'selected' : ''} onClick={() => setMode('search')}><Search size={17} /> Search foods</button><button type="button" className={mode === 'text' ? 'selected' : ''} onClick={() => setMode('text')}><FileText size={17} /> Describe a meal</button><button type="button" className={mode === 'photo' ? 'selected' : ''} onClick={() => setMode('photo')}><ImagePlus size={17} /> Add a photo</button></div>
    {mode === 'text' && <div className="text-entry"><label htmlFor="meal-description">What did you eat?</label><textarea id="meal-description" value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} placeholder="For example: 150 g cooked rice and grilled chicken" rows={4} /><p className="field-help">You’ll review the matches and confirm portions before saving.</p><button type="button" className="secondary" onClick={interpret} disabled={description.length < 3 || loading}><Sparkles size={16} />{loading ? 'Finding the foods…' : 'Find foods in my description'}</button>{interpreted && <div className="interpretation">{interpreted.items.map((item, i) => <div key={i}><strong>{item.name}</strong><p className="field-help">{item.grams ? `${item.grams} g from your description` : 'Portion not specified. Confirm grams below.'}</p>{item.matches.length ? item.matches.map(food => <button type="button" key={food.id} onClick={() => add(food, item.grams ?? 100)}>{food.name}<Plus size={16} /></button>) : <p>No match. Try a simpler search below.</p>}</div>)}</div>}</div>}
    {mode === 'photo' && <div className="photo-entry"><label className={`photo-drop-zone ${photoPreview ? 'has-photo' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); choosePhoto(event.dataTransfer.files?.[0] ?? null); }}>{photoPreview && !photoPreviewFailed ? <img src={photoPreview} alt="Selected meal preview" onError={() => setPhotoPreviewFailed(true)} /> : photoFile ? <><span className="empty-icon"><ImageIcon size={28} /></span><strong>Photo selected</strong><span>{photoFile.name}</span></> : <><span className="empty-icon"><Camera size={28} /></span><strong>Take or choose a meal photo</strong><span>Use your camera on a phone, or select an image.</span></>}<input aria-label="Choose meal photo" type="file" accept="image/*,.heic,.heif,.avif,.tif,.tiff,.bmp" capture="environment" onChange={event => choosePhoto(event.target.files?.[0] ?? null)} /></label>{photoFile && <div className="photo-details"><span><strong>{photoFile.name}</strong><small>{(photoFile.size / 1024 / 1024).toFixed(1)} MB · Private upload</small></span><button type="button" aria-label="Remove selected photo" onClick={() => { photoRequest.current += 1; if (photoPreviewRef.current) URL.revokeObjectURL(photoPreviewRef.current); photoPreviewRef.current = ''; setPhotoFile(null); setPhotoContentType(null); setPhotoPreview(''); setPhotoPreviewFailed(false); setUploadedPhoto(null); setPhotoAnalysis(null); setSelected([]); setAnalyzingPhoto(false); }}><Trash2 size={17} /></button></div>}{analyzingPhoto && <div className="photo-analysis-status"><Sparkles size={18} /><span><strong>Identifying your meal…</strong><small>Converting the image and matching visible foods to USDA nutrition.</small></span></div>}{photoAnalysis && !analyzingPhoto && <div className="photo-analysis-status ready"><Check size={18} /><span><strong>{selected.length} food{selected.length === 1 ? '' : 's'} matched</strong><small>Review the suggested portions and nutrition before saving.</small></span></div>}<p className="field-help">JPEG, PNG, HEIC/HEIF, AVIF, WebP, GIF, BMP, or TIFF · Up to 15 MB. Results are estimates.</p></div>}
    {mode !== 'photo' && <div className="search-area"><label htmlFor="food-search">{mode === 'text' ? 'Or find another food' : 'Search the food catalog'}</label><div className="search-input"><Search size={19} /><input id="food-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Try rice, eggs, oatmeal…" autoComplete="off" /></div><p className="field-help">USDA FNDDS · Nutrition shown per 100 g</p><div className="food-results" aria-live="polite">{searching ? <p className="search-hint">Searching the catalog…</p> : results.length ? results.map(food => <button type="button" className="food-result" key={food.id} onClick={() => add(food)}><span><strong>{food.name}</strong><small>{food.per_100g.calories} kcal · {food.per_100g.carbs_g} g carbs</small></span><Plus size={19} /></button>) : <p className="search-hint">{query.length >= 2 ? 'No matching foods. Try a broader term or log the ingredients separately.' : 'Search for individual foods or common prepared meals.'}</p>}</div></div>}</section>
    <section className="panel meal-summary"><div className="panel-heading"><h2>{predictionMode ? 'Meal to predict' : 'Your meal'}</h2><span className="chip">{selected.length} selected</span></div>{!selected.length ? <div className="selection-empty">{analyzingPhoto ? <Sparkles size={29} /> : <Utensils size={29} />}<p>{analyzingPhoto ? 'Analyzing the photo and finding USDA matches…' : mode === 'photo' ? 'Choose a photo to identify its foods.' : 'Add a food to get started.'}</p></div> : selected.map((item, index) => <div className="selected-food" key={`${item.food.id}-${index}`}><div><strong>{item.food.name}</strong><button type="button" aria-label={`Remove ${item.food.name}`} onClick={() => setSelected(list => list.filter((_, i) => i !== index))}><Trash2 size={16} /></button></div>{item.food.portions.length > 0 && <select aria-label={`Suggested portion for ${item.food.name}`} value="" onChange={e => setSelected(list => list.map((x, i) => i === index ? { ...x, grams: Number(e.target.value) } : x))}><option value="" disabled>Choose a portion (optional)</option>{item.food.portions.map((portion, i) => <option key={i} value={portion.grams}>{portion.label} · {portion.grams} g</option>)}</select>}<label className="grams-input"><input aria-label={`Grams of ${item.food.name}`} type="number" min="0.1" max="10000" step="0.1" required value={item.grams || ''} onChange={e => setSelected(list => list.map((x, i) => i === index ? { ...x, grams: Number(e.target.value) } : x))} /> grams</label></div>)}<div className="macro-grid">{[['Carbs', total.carbs_g, 'g'], ['Protein', total.protein_g, 'g'], ['Fat', total.fat_g, 'g'], ['Fiber', total.fiber_g, 'g']].map(([label, value, unit]) => <div key={String(label)}><strong>{Math.round(Number(value))}<small>{unit}</small></strong><span>{label}</span></div>)}</div><div className="calories"><span>Estimated energy</span><strong>{Math.round(total.calories)} kcal</strong></div><label htmlFor="meal-time">{predictionMode ? 'When might you eat?' : 'When did you eat?'}</label><input id="meal-time" type="datetime-local" required value={eatenAt} onChange={e => setEatenAt(e.target.value)} />{mode !== 'text' && <><label htmlFor="meal-note">Meal name or note <span className="muted">(optional)</span></label><input id="meal-note" value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} placeholder="Lunch, afternoon snack…" /></>}<button className="primary full-width" type="submit" disabled={!selected.length || saving || analyzingPhoto || (mode === 'photo' && !uploadedPhoto)}>{predictionMode ? <Sparkles size={18} /> : <Check size={18} />}{saving ? (predictionMode ? 'Predicting…' : 'Saving…') : predictionMode ? 'Predict glucose response' : preview ? 'Add preview meal' : 'Confirm and save meal'}</button><p className="field-help">{predictionMode ? 'This meal will be predicted without being added to your journal.' : 'Review the food matches and portions. Nutrition values are estimates.'}</p></section></form></>;
}

function DataUpload({ api, onError, onReady, readings, embedded = false }: { api: Api | null; onError: (s: string) => void; onReady: () => Promise<void>; readings: Reading[]; embedded?: boolean }) {
  const [file, setFile] = useState<File | null>(null); const [unit, setUnit] = useState<'mg/dL' | 'mmol/L'>('mg/dL');
  const [status, setStatus] = useState<ImportStatus | null>(null); const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const upload = async () => {
    if (!api) { onError('Uploads become available after AWS deployment and sign-in.'); return; }
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { onError('Choose a CSV smaller than 10 MB.'); return; }
    setBusy(true);
    try {
      const started = await api.startImport(file.name, unit); setStatus(started.import);
      const body = new FormData(); Object.entries(started.upload.fields).forEach(([key, value]) => body.append(key, value)); body.append('file', file);
      const response = await fetch(started.upload.url, { method: 'POST', body });
      if (!response.ok) throw new Error('The file upload failed. Please try again.');
      for (let i = 0; i < 45 && alive.current; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (!alive.current) break;
        const next = await api.importStatus(started.import.id); setStatus(next);
        if (next.status === 'failed') throw new Error(next.error ?? 'The file could not be processed.');
        if (next.status === 'ready') { await onReady(); break; }
      }
    } catch (error) { if (alive.current) onError(errorMessage(error)); } finally { if (alive.current) setBusy(false); }
  };
  const checkStatus = async () => { if (!api || !status) return; try { const next = await api.importStatus(status.id); setStatus(next); if (next.status === 'ready') await onReady(); } catch (error) { onError(errorMessage(error)); } };
  return <>{!embedded && <div className="page-heading"><div><p className="eyebrow">BRING YOUR HISTORY</p><h1>Your CGM data</h1><p>A personal starting point for understanding your response.</p></div></div>}<div className="upload-grid"><section className="panel upload-panel"><div className="panel-heading"><div><h2>Upload a CGM export</h2><p>Your original file is kept in private storage.</p></div><ShieldCheck size={21} /></div><label className="drop-zone"><span className="empty-icon"><Upload size={30} /></span><strong>{file ? file.name : 'Choose your CSV file'}</strong><span>{file ? `${(file.size / 1024).toFixed(1)} KB · Click to choose another` : 'Select an export from your computer or phone'}</span><small>CSV · Up to 10 MB · 20,000 readings</small><input aria-label="Select CGM CSV" type="file" accept=".csv,text/csv" onChange={e => { setFile(e.target.files?.[0] ?? null); setStatus(null); }} /></label><label htmlFor="glucose-unit">Glucose unit used in this file</label><select id="glucose-unit" value={unit} onChange={e => setUnit(e.target.value as typeof unit)}><option>mg/dL</option><option>mmol/L</option></select><button className="primary full-width" disabled={!file || busy} onClick={upload}><Upload size={17} />{busy ? 'Uploading and processing…' : 'Upload and process'}</button>{status && <div className={`import-status ${status.status}`}><strong>{status.status === 'ready' ? `${status.reading_count} readings ready` : status.status === 'failed' ? 'Import needs attention' : 'Your import is in progress'}</strong><p>{status.error ?? status.filename}</p>{!busy && status.status !== 'ready' && status.status !== 'failed' && <button className="text-button" onClick={checkStatus}>Check status <ArrowRight size={15} /></button>}</div>}</section><section className="format-card"><FileText size={28} strokeWidth={1.5} /><h2>A clear format,<br />a smoother import.</h2><p>This first version accepts a CSV with two columns:</p><code>timestamp,glucose</code><p>Include a timezone in every timestamp and select the glucose unit above. Device-specific export adapters will be added after we inspect your sample.</p><a className="secondary" href="/cgm-template.csv" download><ArrowDownToLine size={16} /> Download example CSV</a><small>The example contains synthetic readings for format illustration only.</small></section></div>{readings.length > 0 && <section className="panel"><div className="panel-heading"><h2>Your latest readings</h2><span className="chip">mg/dL</span></div><GlucoseChart readings={readings} /></section>}</>;
}

function ActivityUpload({ api, onError, onReady, activity, healthRecords, embedded = false }: { api: Api | null; onError: (s: string) => void; onReady: () => Promise<void>; activity: ActivityReading[]; healthRecords: HealthRecord[]; embedded?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ActivityImportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const upload = async () => {
    if (!api) { onError('Activity uploads require AWS sign-in.'); return; }
    if (!file) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension !== 'zip' && extension !== 'csv') { onError('Choose an Apple Health export ZIP or activity CSV.'); return; }
    const maxSize = extension === 'zip' ? 250 : 50;
    if (file.size > maxSize * 1024 * 1024) { onError(`Choose a ${extension.toUpperCase()} smaller than ${maxSize} MB.`); return; }
    const contentType = extension === 'zip' ? 'application/zip' as const : 'text/csv' as const;
    setBusy(true);
    try {
      const started = await api.startActivityImport(file.name, contentType); setStatus(started.import);
      const body = new FormData(); Object.entries(started.upload.fields).forEach(([key, value]) => body.append(key, value)); body.append('file', file);
      const response = await fetch(started.upload.url, { method: 'POST', body });
      if (!response.ok) throw new Error('The activity file upload failed. Please try again.');
      for (let i = 0; i < 60 && alive.current; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (!alive.current) break;
        const next = await api.activityImportStatus(started.import.id); setStatus(next);
        if (next.status === 'failed') throw new Error(next.error ?? 'The activity file could not be processed.');
        if (next.status === 'ready') { await onReady(); break; }
      }
    } catch (error) { if (alive.current) onError(errorMessage(error)); }
    finally { if (alive.current) setBusy(false); }
  };
  const latest = activity.at(-1);
  return <>{!embedded && <div className="page-heading"><div><p className="eyebrow">ADD YOUR MOVEMENT CONTEXT</p><h1>Your activity data</h1><p>Bring in Apple Watch movement and heart rate alongside meals and glucose.</p></div></div>}<div className="upload-grid"><section className="panel upload-panel"><div className="panel-heading"><div><h2>Upload activity history</h2><p>Your original file is kept in private storage.</p></div><ShieldCheck size={21} /></div><label className="drop-zone"><span className="empty-icon"><HeartPulse size={30} /></span><strong>{file ? file.name : 'Choose Apple Health ZIP or CSV'}</strong><span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · Click to choose another` : 'Select the export from your iPhone, Mac, or computer'}</span><small>Apple Health ZIP up to 250 MB · CSV up to 50 MB</small><input aria-label="Select activity export" type="file" accept=".zip,.csv,application/zip,text/csv" onChange={event => { setFile(event.target.files?.[0] ?? null); setStatus(null); }} /></label><button className="primary full-width" disabled={!file || busy} onClick={upload}><Upload size={17} />{busy ? 'Uploading and processing…' : 'Upload and process'}</button>{status && <div className={`import-status ${status.status}`}><strong>{status.status === 'ready' ? `${status.reading_count} activity intervals ready` : status.status === 'failed' ? 'Import needs attention' : 'Your activity import is in progress'}</strong><p>{status.error ?? status.filename}</p></div>}</section><section className="format-card"><Footprints size={28} strokeWidth={1.5} /><h2>Export from<br />Apple Health.</h2><p>On your iPhone, open Health, tap your profile picture, choose <strong>Export All Health Data</strong>, then upload the resulting export.zip here.</p><p>You can also upload a CSV with this header:</p><code>timestamp,steps,active_energy_kcal,heart_rate_bpm</code><a className="secondary" href="/activity-template.csv" download><ArrowDownToLine size={16} /> Download example CSV</a><small>Steps and active energy are summed; heart rate is averaged into five minute intervals.</small></section></div>{activity.length > 0 && <section className="panel"><div className="panel-heading"><div><h2>Latest activity</h2><p>{activity.length} recent five minute intervals are available to the prediction pipeline.</p></div><span className="chip">{latest ? friendlyDate(latest.timestamp) : ''}</span></div><div className="activity-summary"><Summary icon={<Footprints size={19} />} label="Steps" value={String(latest?.steps ?? '—')} detail="Latest interval" /><Summary icon={<Activity size={19} />} label="Active energy" value={latest?.active_energy_kcal == null ? '—' : String(latest.active_energy_kcal)} unit={latest?.active_energy_kcal == null ? '' : 'kcal'} detail="Latest interval" /><Summary icon={<HeartPulse size={19} />} label="Heart rate" value={latest?.heart_rate_bpm == null ? '—' : String(latest.heart_rate_bpm)} unit={latest?.heart_rate_bpm == null ? '' : 'bpm'} detail="Latest interval average" /></div></section>}</>;
}

function GlucoseChart({ readings }: { readings: Reading[] }) {
  const width = 700, height = 240, pad = 40;
  const times = readings.map(x => new Date(x.timestamp).getTime());
  const values = readings.map(x => x.glucose_mg_dl);
  const min = Math.floor((Math.min(...values) - 10) / 10) * 10;
  const max = Math.ceil((Math.max(...values) + 10) / 10) * 10;
  const duration = Math.max(1, times.at(-1)! - times[0]);
  const points = readings.map((item, i) => `${pad + (times[i] - times[0]) / duration * (width - pad * 2)},${height - pad - (item.glucose_mg_dl - min) / (max - min) * (height - pad * 2)}`).join(' ');
  return <div className="glucose-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Observed glucose from ${friendlyDate(readings[0].timestamp)} to ${friendlyDate(readings.at(-1)!.timestamp)}. Values range from ${Math.min(...values)} to ${Math.max(...values)} milligrams per deciliter.`}>{[0, 1, 2, 3, 4].map(i => <g key={i}><line x1={pad} x2={width - pad} y1={pad + i / 4 * (height - pad * 2)} y2={pad + i / 4 * (height - pad * 2)} stroke="#e9ede8" /><text x={pad - 10} y={pad + i / 4 * (height - pad * 2) + 4} textAnchor="end">{Math.round(max - i / 4 * (max - min))}</text></g>)}<polyline points={points} fill="none" stroke="#47765d" strokeWidth="2.5" strokeLinejoin="round" /><text x={pad} y={height - 8}>{new Date(readings[0].timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text><text x={width - pad} y={height - 8} textAnchor="end">{new Date(readings.at(-1)!.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text></svg></div>;
}
