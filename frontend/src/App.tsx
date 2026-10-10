import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { User, UserManager } from 'oidc-client-ts';
import { Activity, ArrowDownToLine, ArrowRight, Camera, Check, ChevronRight, CircleHelp, Clock3, FileText, Image as ImageIcon, ImagePlus, LayoutDashboard, Leaf, LogOut, Plus, Search, ShieldCheck, Sparkles, Trash2, Upload, Utensils, X } from 'lucide-react';
import { createApi, type Api } from '@glucose-compass/api-client';
import type { Food, ImportStatus, Interpretation, Meal, MealPhoto, Nutrition, Reading, RuntimeConfig } from '@glucose-compass/contracts';
import { createAuth } from './auth';

type View = 'overview' | 'meal' | 'history' | 'data';
const emptyNutrition = (): Nutrition => ({ carbs_g: 0, protein_g: 0, fat_g: 0, fiber_g: 0, calories: 0 });
const localTime = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const friendlyDate = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

export function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [preview, setPreview] = useState(false);
  const [view, setView] = useState<View>('overview');
  const [notice, setNotice] = useState('');
  const [meals, setMeals] = useState<Meal[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
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

  const refresh = async () => {
    if (!api) return;
    try {
      const [historyPage, cgm] = await Promise.all([api.meals(), api.readings()]);
      setMeals(historyPage.items); setHasMoreMeals(historyPage.has_more); setReadings(cgm.items);
    } catch (error) { setNotice(errorMessage(error)); }
  };
  useEffect(() => { void refresh(); }, [api]);

  const signIn = async () => {
    if (!auth.current) return;
    try { await auth.current.signinRedirect(); } catch (error) { setNotice(errorMessage(error)); }
  };
  const signOut = async () => {
    if (auth.current && config) {
      try { await auth.current.revokeTokens(['refresh_token']); } catch { /* Local session is always cleared. */ }
      await auth.current.removeUser();
      setUser(null); setMeals([]); setReadings([]);
      location.assign(`${config.cognitoDomain}/logout?client_id=${encodeURIComponent(config.clientId)}&logout_uri=${encodeURIComponent(`${location.origin}/`)}`);
    } else { setPreview(false); setMeals([]); setReadings([]); }
  };
  const saveMeal = async (saved: Meal) => { setMeals(previous => [saved, ...previous.filter(x => x.id !== saved.id)]); setView('history'); setNotice(preview ? 'Preview meal added for this session only.' : 'Your meal is saved.'); };

  if (!ready) return <div className="boot"><Leaf size={28} /><p>Opening your workspace…</p></div>;
  if (!user && !preview) return <div className="welcome">
    <header><Brand /><span className="eyebrow">PERSONAL WELLNESS JOURNAL</span></header>
    <main className="welcome-grid"><div><span className="pill"><span className="dot" /> YOUR BODY. YOUR CONTEXT.</span><h1>A little more context.<br /><em>A clearer picture.</em></h1><p className="welcome-copy">Bring your meals and glucose history together. Discover the patterns that make your everyday experience yours.</p><div className="welcome-actions"><button className="primary" onClick={signIn} disabled={!config?.configured}>Sign in or create an account <ArrowRight size={18} /></button>{!config?.configured && <button className="secondary" onClick={() => setPreview(true)}>Explore the workspace</button>}</div>{!config?.configured && <p className="setup-note">Local preview · AWS sign-in is awaiting deployment.</p>}{notice && <p role="alert" className="notice">{notice}</p>}<div className="welcome-trust"><ShieldCheck size={18} /> Your journal belongs to you.</div></div><div className="welcome-visual"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><Leaf className="hero-leaf" size={150} strokeWidth={.65} /><div className="floating-card"><span className="icon-box"><Utensils size={20} /></span><div><strong>Meal by meal.</strong><span>Build your personal picture.</span></div><Check size={18} /></div><div className="visual-caption">A space to understand<br /><em>your daily rhythm.</em></div></div></main><footer>Glucose Compass · RU Health Hackathon <span>Research prototype. Not for diagnosis or medication decisions.</span></footer>
  </div>;

  return <div className="app-shell">
    <aside className="sidebar"><Brand /><div className="workspace-label">YOUR WORKSPACE</div><nav aria-label="Main navigation">{([
      ['overview', LayoutDashboard, 'Overview'], ['meal', Utensils, 'Log a meal'], ['history', Clock3, 'Meal history'], ['data', Activity, 'Your CGM data'],
    ] as const).map(([key, Icon, label]) => <button key={key} className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => { setView(key); setNotice(''); }}><Icon size={19} /><span>{label}</span>{view === key && <span className="nav-dot" />}</button>)}</nav><div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={20} /><strong>Personal by design</strong><p>Your meals and readings stay connected to your account.</p></div><button className="account-button" onClick={signOut}><span className="avatar">{preview ? 'P' : (user?.profile.email?.[0] ?? 'Y').toUpperCase()}</span><span><strong>{preview ? 'Preview workspace' : 'Your account'}</strong><small>{preview ? 'Exit preview' : 'Sign out'}</small></span><LogOut size={17} /></button></div></aside>
    <div className="main-shell"><header className="topbar"><span>YOUR DAILY RHYTHM</span><div><span className="dot" /> {preview ? 'Local preview' : 'Personal journal'}<span className="topbar-divider" />{new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div></header>
      <main className="content">{preview && <div className="preview-banner"><CircleHelp size={17} /><span>Preview workspace. Sign-in, uploads, and cloud saving will work after AWS deployment. Preview entries disappear when you leave.</span></div>}{notice && <div role="status" className="notice"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={16} /></button></div>}
      {view === 'overview' && <><div className="page-heading"><div><p className="eyebrow">ONE MEAL AT A TIME</p><h1>Your daily picture</h1><p>A little context for the way your body responds.</p></div><button className="primary" onClick={() => setView('meal')}><Plus size={18} /> Log a meal</button></div>
        <div className="summary-grid"><Summary icon={<Utensils size={20} />} label="Meals in your journal" value={String(meals.length)} detail={hasMoreMeals ? 'Showing your latest 100' : meals.length ? 'Every entry adds context' : 'Your first meal starts the story'} /><Summary icon={<Activity size={20} />} label="Latest glucose reading" value={readings.length ? String(Math.round(readings.at(-1)!.glucose_mg_dl)) : '—'} unit={readings.length ? 'mg/dL' : ''} detail={readings.length ? friendlyDate(readings.at(-1)!.timestamp) : 'Connect your history with a CSV upload'} /><Summary icon={<Sparkles size={20} />} label="Personal predictions" value="Coming next" detail="Your model integration is pending" /></div>
        <div className="dashboard-grid"><section className="panel glucose-panel"><div className="panel-heading"><div><h2>Your glucose history</h2><p>Observed readings, with your meals in context.</p></div><span className="chip">{readings.length ? 'Latest readings' : 'No data yet'}</span></div>{readings.length ? <GlucoseChart readings={readings} /> : <div className="chart-empty"><div className="chart-grid"><i /><i /><i /><i /></div><div className="empty-icon"><Activity size={29} strokeWidth={1.5} /></div><h3>Your story starts with your data</h3><p>Upload a CGM export to see your glucose history here.</p><button className="secondary" onClick={() => setView('data')}><Upload size={16} /> Upload CGM data</button></div>}<div className="panel-foot"><span className="legend-dot" /> Observed glucose <span className="muted">Up to 288 recent readings</span></div></section>
          <section className="next-step-card"><span className="round-icon"><Leaf size={25} /></span><p className="eyebrow">MAKE IT PERSONAL</p><h2>Small entries.<br />More understanding.</h2><p>What you eat and when you eat it add meaningful context to your glucose history.</p><ol><li><span>01</span> Bring in your CGM history</li><li><span>02</span> Log a meal and its portions</li><li><span>03</span> Explore predictions when available</li></ol><button onClick={() => setView(readings.length ? 'meal' : 'data')}>Take the next step <ArrowRight size={18} /></button></section></div>
        <section className="panel recent-panel"><div className="panel-heading"><div><h2>Recent meals</h2><p>The everyday details that build your picture.</p></div><button className="text-button" onClick={() => setView('history')}>View history <ArrowRight size={16} /></button></div>{meals.length ? meals.slice(0, 3).map(meal => <MealRow key={meal.id} meal={meal} />) : <div className="empty-row"><span className="icon-box"><Utensils size={20} /></span><div><strong>A fresh page for your meals</strong><p>Search for a food or describe what you ate.</p></div><button className="text-button" onClick={() => setView('meal')}>Add your first meal <Plus size={16} /></button></div>}</section>
      </>}
      {view === 'meal' && <MealForm api={api} preview={preview} onSaved={saveMeal} onError={setNotice} />}
      {view === 'history' && <><div className="page-heading"><div><p className="eyebrow">YOUR FOOD JOURNAL</p><h1>Meal history</h1><p>Confirmed portions and nutrition, all in one place.</p></div><button className="primary" onClick={() => setView('meal')}><Plus size={18} /> Log a meal</button></div><section className="panel">{meals.length ? meals.map(meal => <MealRow key={meal.id} meal={meal} action={async () => { if (!api) { setNotice('Predictions will be available when your team connects the model.'); return; } try { await api.predict(meal.id); setNotice('Prediction saved.'); } catch (error) { setNotice(errorMessage(error)); } }} />) : <Empty title="Your journal is ready" text="Your saved meals will appear here." icon={<Utensils size={28} />} />}{hasMoreMeals && <p className="panel-foot">Showing the latest 100 meals. Full-history export will be added in the next phase.</p>}</section></>}
      {view === 'data' && <DataUpload api={api} onError={setNotice} onReady={refresh} readings={readings} />}
      <footer className="app-footer"><span>Made for your everyday understanding.</span><span>Research prototype · No diagnosis or medication advice</span></footer></main>
    </div>
  </div>;
}

function Brand() { return <div className="brand"><span><Leaf size={23} strokeWidth={1.7} /></span><strong>glucose compass<span className="brand-period">.</span></strong></div>; }
function Summary({ icon, label, value, unit, detail }: { icon: React.ReactNode; label: string; value: string; unit?: string; detail: string }) { return <section className="summary-card"><div className="summary-label">{label}<span>{icon}</span></div><div className="summary-value">{value}<small>{unit}</small></div><p>{detail}</p></section>; }
function Empty({ title, text, icon }: { title: string; text: string; icon: React.ReactNode }) { return <div className="simple-empty"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{text}</p></div>; }
function MealRow({ meal, action }: { meal: Meal; action?: () => void }) { return <article className="meal-row"><span className="meal-icon">{meal.photo ? <ImageIcon size={20} /> : <Utensils size={20} />}</span><div className="meal-main"><h3>{meal.description || meal.foods.map(f => f.name).join(', ')}</h3><p>{friendlyDate(meal.eaten_at)} · {meal.foods.length} food{meal.foods.length !== 1 ? 's' : ''}{meal.photo ? ' · Photo attached' : ''}</p></div><div className="meal-macro"><strong>{Math.round(meal.nutrition.carbs_g)}g</strong><small>carbs</small></div><div className="meal-macro"><strong>{Math.round(meal.nutrition.calories)}</strong><small>kcal</small></div>{action && <button className="icon-button" title="Request prediction" aria-label={`Request prediction for ${meal.description || 'meal'}`} onClick={action}><ChevronRight size={20} /></button>}</article>; }

function MealForm({ api, preview, onSaved, onError }: { api: Api | null; preview: boolean; onSaved: (meal: Meal) => void; onError: (message: string) => void }) {
  const [mode, setMode] = useState<'search' | 'text' | 'photo'>('search');
  const [query, setQuery] = useState(''); const [results, setResults] = useState<Food[]>([]);
  const [description, setDescription] = useState(''); const [eatenAt, setEatenAt] = useState(localTime());
  const [selected, setSelected] = useState<{ food: Food; grams: number }[]>([]);
  const [interpreted, setInterpreted] = useState<Interpretation | null>(null);
  const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [uploadedPhoto, setUploadedPhoto] = useState<MealPhoto | null>(null);
  const photoPreviewRef = useRef('');
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
  const choosePhoto = (file: File | null) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { onError('Choose a JPEG, PNG, or WebP image.'); return; }
    if (file.size > 8 * 1024 * 1024) { onError('Choose an image smaller than 8 MB.'); return; }
    if (photoPreviewRef.current) URL.revokeObjectURL(photoPreviewRef.current);
    const nextPreview = URL.createObjectURL(file); photoPreviewRef.current = nextPreview;
    setPhotoFile(file); setPhotoPreview(nextPreview); setUploadedPhoto(null);
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
      if (mode === 'photo' && photoFile && !readyPhoto) {
        if (api) {
          const started = await api.startMealPhoto(photoFile.name, photoFile.type as MealPhoto['content_type'], photoFile.size);
          const uploadBody = new FormData(); Object.entries(started.upload.fields).forEach(([key, value]) => uploadBody.append(key, value)); uploadBody.append('file', photoFile);
          const uploaded = await fetch(started.upload.url, { method: 'POST', body: uploadBody });
          if (!uploaded.ok) throw new Error('The meal photo upload failed. Please try again.');
          readyPhoto = await api.completeMealPhoto(started.photo.id); setUploadedPhoto(readyPhoto);
        } else {
          readyPhoto = { id: crypto.randomUUID(), filename: photoFile.name, content_type: photoFile.type as MealPhoto['content_type'], size_bytes: photoFile.size, status: 'ready' };
        }
      }
      const fields = { description, eaten_at: new Date(eatenAt).toISOString(), entry_method: mode, foods: selected.map(x => ({ food_id: x.food.id, grams: x.grams })), ...(readyPhoto ? { photo_id: readyPhoto.id } : {}) };
      const payload = JSON.stringify(fields);
      if (requestKey.current.payload !== payload) requestKey.current = { payload, id: crypto.randomUUID() };
      const saved = api ? await api.saveMeal({ ...fields, request_id: requestKey.current.id }) : {
        id: requestKey.current.id, description, eaten_at: fields.eaten_at, created_at: new Date().toISOString(), nutrition: total,
        foods: selected.map(x => ({ food_id: x.food.id, name: x.food.name, grams: x.grams, nutrition: Object.fromEntries(Object.entries(x.food.per_100g).map(([k, v]) => [k, v * x.grams / 100])) as unknown as Nutrition })),
        ...(readyPhoto ? { photo: readyPhoto } : {}),
      };
      onSaved(saved);
    } catch (error) { onError(errorMessage(error)); } finally { setSaving(false); }
  };
  return <><div className="page-heading"><div><p className="eyebrow">ADD A LITTLE CONTEXT</p><h1>What’s on your plate?</h1><p>Find your foods, confirm the portions, and make it part of your journal.</p></div></div><form className="meal-form-grid" onSubmit={save}><section className="panel meal-editor"><div className="tabs"><button type="button" className={mode === 'search' ? 'selected' : ''} onClick={() => setMode('search')}><Search size={17} /> Search foods</button><button type="button" className={mode === 'text' ? 'selected' : ''} onClick={() => setMode('text')}><FileText size={17} /> Describe a meal</button><button type="button" className={mode === 'photo' ? 'selected' : ''} onClick={() => setMode('photo')}><ImagePlus size={17} /> Add a photo</button></div>
    {mode === 'text' && <div className="text-entry"><label htmlFor="meal-description">What did you eat?</label><textarea id="meal-description" value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} placeholder="For example: 150 g cooked rice and grilled chicken" rows={4} /><p className="field-help">You’ll review the matches and confirm portions before saving.</p><button type="button" className="secondary" onClick={interpret} disabled={description.length < 3 || loading}><Sparkles size={16} />{loading ? 'Finding the foods…' : 'Find foods in my description'}</button>{interpreted && <div className="interpretation">{interpreted.items.map((item, i) => <div key={i}><strong>{item.name}</strong><p className="field-help">{item.grams ? `${item.grams} g from your description` : 'Portion not specified. Confirm grams below.'}</p>{item.matches.length ? item.matches.map(food => <button type="button" key={food.id} onClick={() => add(food, item.grams ?? 100)}>{food.name}<Plus size={16} /></button>) : <p>No match. Try a simpler search below.</p>}</div>)}</div>}</div>}
    {mode === 'photo' && <div className="photo-entry"><label className={`photo-drop-zone ${photoPreview ? 'has-photo' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); choosePhoto(event.dataTransfer.files?.[0] ?? null); }}>{photoPreview ? <img src={photoPreview} alt="Selected meal preview" /> : <><span className="empty-icon"><Camera size={28} /></span><strong>Take or choose a meal photo</strong><span>Use your camera on a phone, or select an image.</span></>}<input aria-label="Choose meal photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={event => choosePhoto(event.target.files?.[0] ?? null)} /></label>{photoFile && <div className="photo-details"><span><strong>{photoFile.name}</strong><small>{(photoFile.size / 1024 / 1024).toFixed(1)} MB · Private upload</small></span><button type="button" aria-label="Remove selected photo" onClick={() => { if (photoPreviewRef.current) URL.revokeObjectURL(photoPreviewRef.current); photoPreviewRef.current = ''; setPhotoFile(null); setPhotoPreview(''); setUploadedPhoto(null); }}><Trash2 size={17} /></button></div>}<p className="field-help">JPEG, PNG, or WebP · Up to 8 MB. Add the foods below so nutrition can be calculated.</p></div>}
    <div className="search-area"><label htmlFor="food-search">{mode === 'text' ? 'Or find another food' : mode === 'photo' ? 'Add foods shown in the photo' : 'Search the food catalog'}</label><div className="search-input"><Search size={19} /><input id="food-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Try rice, eggs, oatmeal…" autoComplete="off" /></div><p className="field-help">USDA FNDDS · Nutrition shown per 100 g</p><div className="food-results" aria-live="polite">{searching ? <p className="search-hint">Searching the catalog…</p> : results.length ? results.map(food => <button type="button" className="food-result" key={food.id} onClick={() => add(food)}><span><strong>{food.name}</strong><small>{food.per_100g.calories} kcal · {food.per_100g.carbs_g} g carbs</small></span><Plus size={19} /></button>) : <p className="search-hint">{query.length >= 2 ? 'No matching foods. Try a broader term or log the ingredients separately.' : 'Search for individual foods or common prepared meals.'}</p>}</div></div></section>
    <section className="panel meal-summary"><div className="panel-heading"><h2>Your meal</h2><span className="chip">{selected.length} selected</span></div>{!selected.length ? <div className="selection-empty"><Utensils size={29} /><p>Add a food to get started.</p></div> : selected.map((item, index) => <div className="selected-food" key={`${item.food.id}-${index}`}><div><strong>{item.food.name}</strong><button type="button" aria-label={`Remove ${item.food.name}`} onClick={() => setSelected(list => list.filter((_, i) => i !== index))}><Trash2 size={16} /></button></div>{item.food.portions.length > 0 && <select aria-label={`Suggested portion for ${item.food.name}`} value="" onChange={e => setSelected(list => list.map((x, i) => i === index ? { ...x, grams: Number(e.target.value) } : x))}><option value="" disabled>Choose a portion (optional)</option>{item.food.portions.map((portion, i) => <option key={i} value={portion.grams}>{portion.label} · {portion.grams} g</option>)}</select>}<label className="grams-input"><input aria-label={`Grams of ${item.food.name}`} type="number" min="0.1" max="10000" step="0.1" required value={item.grams || ''} onChange={e => setSelected(list => list.map((x, i) => i === index ? { ...x, grams: Number(e.target.value) } : x))} /> grams</label></div>)}<div className="macro-grid">{[['Carbs', total.carbs_g, 'g'], ['Protein', total.protein_g, 'g'], ['Fat', total.fat_g, 'g'], ['Fiber', total.fiber_g, 'g']].map(([label, value, unit]) => <div key={String(label)}><strong>{Math.round(Number(value))}<small>{unit}</small></strong><span>{label}</span></div>)}</div><div className="calories"><span>Estimated energy</span><strong>{Math.round(total.calories)} kcal</strong></div><label htmlFor="meal-time">When did you eat?</label><input id="meal-time" type="datetime-local" required value={eatenAt} onChange={e => setEatenAt(e.target.value)} />{mode !== 'text' && <><label htmlFor="meal-note">Meal name or note <span className="muted">(optional)</span></label><input id="meal-note" value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} placeholder="Lunch, afternoon snack…" /></>}<button className="primary full-width" type="submit" disabled={!selected.length || saving || (mode === 'photo' && !photoFile)}><Check size={18} />{saving ? (mode === 'photo' ? 'Uploading and saving…' : 'Saving…') : preview ? 'Add preview meal' : 'Confirm and save meal'}</button><p className="field-help">Review the food matches and portions. Nutrition values are estimates.</p></section></form></>;
}

function DataUpload({ api, onError, onReady, readings }: { api: Api | null; onError: (s: string) => void; onReady: () => Promise<void>; readings: Reading[] }) {
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
  return <><div className="page-heading"><div><p className="eyebrow">BRING YOUR HISTORY</p><h1>Your CGM data</h1><p>A personal starting point for understanding your response.</p></div></div><div className="upload-grid"><section className="panel upload-panel"><div className="panel-heading"><div><h2>Upload a CGM export</h2><p>Your original file is kept in private storage.</p></div><ShieldCheck size={21} /></div><label className="drop-zone"><span className="empty-icon"><Upload size={30} /></span><strong>{file ? file.name : 'Choose your CSV file'}</strong><span>{file ? `${(file.size / 1024).toFixed(1)} KB · Click to choose another` : 'Select an export from your computer or phone'}</span><small>CSV · Up to 10 MB · 20,000 readings</small><input aria-label="Select CGM CSV" type="file" accept=".csv,text/csv" onChange={e => { setFile(e.target.files?.[0] ?? null); setStatus(null); }} /></label><label htmlFor="glucose-unit">Glucose unit used in this file</label><select id="glucose-unit" value={unit} onChange={e => setUnit(e.target.value as typeof unit)}><option>mg/dL</option><option>mmol/L</option></select><button className="primary full-width" disabled={!file || busy} onClick={upload}><Upload size={17} />{busy ? 'Uploading and processing…' : 'Upload and process'}</button>{status && <div className={`import-status ${status.status}`}><strong>{status.status === 'ready' ? `${status.reading_count} readings ready` : status.status === 'failed' ? 'Import needs attention' : 'Your import is in progress'}</strong><p>{status.error ?? status.filename}</p>{!busy && status.status !== 'ready' && status.status !== 'failed' && <button className="text-button" onClick={checkStatus}>Check status <ArrowRight size={15} /></button>}</div>}</section><section className="format-card"><FileText size={28} strokeWidth={1.5} /><h2>A clear format,<br />a smoother import.</h2><p>This first version accepts a CSV with two columns:</p><code>timestamp,glucose</code><p>Include a timezone in every timestamp and select the glucose unit above. Device-specific export adapters will be added after we inspect your sample.</p><a className="secondary" href="/cgm-template.csv" download><ArrowDownToLine size={16} /> Download example CSV</a><small>The example contains synthetic readings for format illustration only.</small></section></div>{readings.length > 0 && <section className="panel"><div className="panel-heading"><h2>Your latest readings</h2><span className="chip">mg/dL</span></div><GlucoseChart readings={readings} /></section>}</>;
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
