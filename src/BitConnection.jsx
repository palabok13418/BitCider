import { lazy, Suspense, useEffect, useState } from 'react';
import './bitconnection.css';

const Grainient = lazy(() => import('./Grainient.jsx'));
const ENTRY_KEY = 'bitconnection.entry-transition.v1';
const CREATE_URL = '/bitconnection/?create=1';

function consumeEntryTransition() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(ENTRY_KEY) || 'null');
    window.sessionStorage.removeItem(ENTRY_KEY);
    return Boolean(value && Number.isFinite(value.startedAt) && Date.now() - value.startedAt < 60000);
  } catch {
    return false;
  }
}

const initialEntryStage = consumeEntryTransition() ? 'searching' : 'idle';

async function readResponse(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || fallback);
  return payload;
}

function openCreateWindow() {
  const popup = window.open(
    CREATE_URL,
    'bitconnection-create-room',
    'popup=yes,width=620,height=780,resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no'
  );
  if (!popup) window.location.assign(CREATE_URL);
}

function ProfileSetup({ account, onSaved, onBack }) {
  const [username, setUsername] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState(null);
  const [avatarName, setAvatarName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function chooseAvatar(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > 170 * 1024) {
      setError('Profile pictures must be 170 KB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarDataUrl(typeof reader.result === 'string' ? reader.result : null);
      setAvatarName(file.name);
      setError('');
    };
    reader.onerror = () => setError('The selected image could not be read.');
    reader.readAsDataURL(file);
  }

  async function saveProfile(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/bitconnection/account/profile', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-BitCider-CSRF': account.csrfToken || ''
        },
        body: JSON.stringify({ username, avatarDataUrl })
      });
      const payload = await readResponse(response, 'Could not save your BitConnection profile.');
      onSaved(payload.profile);
    } catch (saveError) {
      setError(saveError.message || 'Could not save your profile.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="bc-window-form" onSubmit={saveProfile}>
      <div className="bc-window-kicker">BITCONNECTION ACCOUNT CENTER</div>
      <h1>Make it yours.</h1>
      <p className="bc-window-copy">You chose to use your signed-in BitCider account for BitConnection. Set the identity other people will see in your rooms.</p>

      <label className="bc-field-card">
        <span className="bc-field-label">USERNAME <small>REQUIRED · 24 CHARACTERS MAX</small></span>
        <input autoFocus value={username} onChange={event => setUsername(event.target.value)} maxLength={24} placeholder="Choose your BitConnection username" autoComplete="nickname" required />
      </label>

      <label className="bc-field-card bc-avatar-field">
        <span className="bc-field-label">PROFILE PICTURE <small>OPTIONAL</small></span>
        <span className="bc-avatar-picker">
          <span className="bc-avatar-preview">
            {avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <span>+</span>}
          </span>
          <span className="bc-avatar-file">
            <strong>{avatarName || 'Choose a picture'}</strong>
            <small>PNG, JPEG, or WebP · up to 170 KB</small>
          </span>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseAvatar} />
        </span>
      </label>

      {error && <div className="bc-form-error" role="alert">{error}</div>}
      <div className="bc-window-actions">
        <button className="bc-secondary-button" type="button" onClick={onBack} disabled={busy}>Back</button>
        <button className="bc-primary-button" type="submit" disabled={busy || !username.trim()}>{busy ? 'Saving…' : 'Save profile'}</button>
      </div>
    </form>
  );
}

function CreateRoomWindow() {
  const [account, setAccount] = useState(null);
  const [stage, setStage] = useState('loading');
  const [profile, setProfile] = useState(null);
  const [roomName, setRoomName] = useState('');
  const [visibility, setVisibility] = useState('public');
  const [partySize, setPartySize] = useState(4);
  const [ownerOnlyControls, setOwnerOnlyControls] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdRoom, setCreatedRoom] = useState(null);

  useEffect(() => {
    let active = true;
    fetch('/api/bitconnection/account', { cache: 'no-store', credentials: 'same-origin' })
      .then(response => readResponse(response, 'Could not load account information.'))
      .then(payload => {
        if (!active) return;
        setAccount(payload);
        setProfile(payload.profile || null);
        setPartySize(Math.min(4, payload.maxPartySize || 10));
        if (!payload.authenticated) setStage('sign-in');
        else if (payload.profile?.username) setStage('room');
        else setStage('choose-account');
      })
      .catch(loadError => {
        if (!active) return;
        setError(loadError.message || 'Could not connect to Deplexo.');
        setStage('error');
      });
    return () => { active = false; };
  }, []);

  function closeWindow() {
    window.close();
    window.setTimeout(() => {
      if (!window.closed) window.location.assign('/bitconnection/');
    }, 120);
  }

  async function createRoom(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const fullscreenRequest = document.documentElement.requestFullscreen?.();
    if (fullscreenRequest?.catch) fullscreenRequest.catch(() => {});

    try {
      const response = await fetch('/api/bitconnection/rooms', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-BitCider-CSRF': account?.csrfToken || ''
        },
        body: JSON.stringify({ roomName, visibility, partySize, ownerOnlyControls })
      });
      const payload = await readResponse(response, 'Could not create the room.');
      setCreatedRoom(payload.room);
      setStage('created');
    } catch (createError) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setError(createError.message || 'Could not create the room.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bc-window-shell">
      <Suspense fallback={null}>
        <Grainient
          className="bitconnection-grainient"
          colors={['#10070b', '#2a0b17', '#76203b', '#d62e5b', '#f49aad']}
          type="linear" angle={42} bands={1.2} speed={0.22} flow={0.82}
          scale={1.08} softness={0.76} silk={0.7} grainAmount={0.045}
          grainSize={1.15} grainAnimated contrast={1.08} saturation={0.82}
          variation={28} interactive stir={0.7} clickSwirl intro lightMode={false} dpr={1.2}
        />
      </Suspense>
      <header className="bc-window-header">
        <span className="bc-window-brand"><i /> BitConnection</span>
        <button type="button" className="bc-window-close" onClick={closeWindow} aria-label="Close window">×</button>
      </header>

      {stage === 'loading' && <section className="bc-window-state"><span className="bc-loading-orbit" /><p>Connecting to Deplexo…</p></section>}

      {stage === 'sign-in' && (
        <section className="bc-window-state">
          <div className="bc-window-kicker">HOST ACCOUNT REQUIRED</div>
          <h1>Hosting starts with an account.</h1>
          <p>Sign in to your BitCider account first, then return here to link it to BitConnection. A separate BitConnection sign-up flow is not enabled yet.</p>
          <div className="bc-window-actions">
            <a className="bc-primary-button" href="/">Open BitCider</a>
            <button className="bc-secondary-button" type="button" onClick={closeWindow}>Close</button>
          </div>
        </section>
      )}

      {stage === 'choose-account' && (
        <section className="bc-window-state">
          <div className="bc-window-kicker">ACCOUNT FOUND</div>
          <h1>Use your BitCider account?</h1>
          <p>Connect your signed-in BitCider account to BitConnection. Your BitConnection username and optional profile picture will be separate from your BitCider display details.</p>
          <div className="bc-window-actions">
            <button className="bc-secondary-button" type="button" onClick={closeWindow}>Not now</button>
            <button className="bc-primary-button" type="button" onClick={() => setStage('profile')}>Use this account</button>
          </div>
        </section>
      )}

      {stage === 'profile' && (
        <ProfileSetup
          account={account}
          onBack={() => setStage('choose-account')}
          onSaved={saved => {
            setProfile(saved);
            setAccount(current => ({ ...current, profile: saved }));
            setStage('room');
          }}
        />
      )}

      {stage === 'room' && profile && (
        <form className="bc-window-form" onSubmit={createRoom}>
          <div className="bc-window-kicker">HOST A LISTENING PARTY</div>
          <h1>Set the room.</h1>
          <p className="bc-window-copy">Signed in as <strong>{profile.username}</strong>. Music comes exclusively from YouTube Music through BitChord Web.</p>

          <label className="bc-field-card">
            <span className="bc-field-label">ROOM NAME <small>1–48 CHARACTERS</small></span>
            <input value={roomName} onChange={event => setRoomName(event.target.value)} maxLength={48} placeholder="Give your party a name" required autoFocus />
          </label>

          <fieldset className="bc-field-card bc-visibility-card">
            <legend className="bc-field-label">PARTY VISIBILITY</legend>
            <div className={`bc-visibility-switch is-${visibility}`}>
              <span className="bc-visibility-thumb" />
              <button type="button" aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}>Public</button>
              <button type="button" aria-pressed={visibility === 'private'} onClick={() => setVisibility('private')}>Private</button>
            </div>
            <small className="bc-field-hint">{visibility === 'public' ? 'Anyone can discover and request to join.' : 'Guests need an invitation link or QR code.'}</small>
          </fieldset>

          <label className="bc-field-card">
            <span className="bc-field-label">PARTY SIZE</span>
            <select value={partySize} onChange={event => setPartySize(Number(event.target.value))}>
              {Array.from({ length: Math.max(1, account?.maxPartySize || 10) - 1 }, (_, index) => index + 2).map(size => (
                <option key={size} value={size}>{size} people</option>
              ))}
            </select>
          </label>

          <label className="bc-field-card bc-permission-card">
            <span className="bc-permission-copy">
              <strong>Only I can control music</strong>
              <small>{ownerOnlyControls ? 'Only the host can play, pause, and choose songs.' : 'Participants can play, pause, and adjust volume.'}</small>
            </span>
            <input type="checkbox" checked={ownerOnlyControls} onChange={event => setOwnerOnlyControls(event.target.checked)} />
            <span className="bc-toggle-visual" aria-hidden="true" />
          </label>

          {error && <div className="bc-form-error" role="alert">{error}</div>}
          <div className="bc-window-actions">
            <button className="bc-secondary-button" type="button" onClick={closeWindow} disabled={busy}>Cancel</button>
            <button className="bc-primary-button" type="submit" disabled={busy || !roomName.trim()}>{busy ? 'Creating…' : 'Create room'}</button>
          </div>
        </form>
      )}

      {stage === 'created' && createdRoom && (
        <section className="bc-window-state">
          <div className="bc-window-kicker">ROOM RECORD CREATED</div>
          <h1>{createdRoom.roomName}</h1>
          <p>The room settings are saved on Deplexo. The live listening connection and immersive player view are the next integration stage.</p>
          <div className="bc-created-code">
            <small>ROOM CODE</small>
            <strong>{createdRoom.roomCode}</strong>
          </div>
          <div className="bc-window-actions">
            <button className="bc-secondary-button" type="button" onClick={closeWindow}>Close</button>
            <button className="bc-primary-button" type="button" onClick={() => {
              navigator.clipboard?.writeText(createdRoom.roomCode).catch(() => {});
            }}>Copy room code</button>
          </div>
        </section>
      )}

      {stage === 'error' && (
        <section className="bc-window-state">
          <div className="bc-window-kicker">CONNECTION ISSUE</div>
          <h1>Could not prepare the room.</h1>
          <p>{error}</p>
          <button className="bc-primary-button" type="button" onClick={() => window.location.reload()}>Try again</button>
        </section>
      )}
      {stage !== 'created' && stage !== 'error' && error && <div className="bc-global-error" role="alert">{error}</div>}
    </main>
  );
}

export default function BitConnection() {
  const [apiState, setApiState] = useState('checking');
  const [entryStage, setEntryStage] = useState(initialEntryStage);
  const isCreateWindow = new URLSearchParams(window.location.search).get('create') === '1';

  useEffect(() => {
    let active = true;
    fetch('/api/bitconnection/health', { cache: 'no-store', credentials: 'same-origin' })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) throw new Error(payload.message || 'BitConnection API is unavailable.');
        if (active) setApiState('online');
      })
      .catch(() => {
        if (active) setApiState('offline');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (entryStage !== 'searching') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setEntryStage('idle');
      return undefined;
    }
    let cancelled = false;
    const timers = [];
    const waitForPage = async () => {
      if (document.readyState !== 'complete') {
        await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
      }
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      if (cancelled) return;
      timers.push(window.setTimeout(() => setEntryStage('holding'), 5200));
      timers.push(window.setTimeout(() => setEntryStage('burning'), 7200));
      timers.push(window.setTimeout(() => setEntryStage('idle'), 8550));
    };
    waitForPage();
    return () => {
      cancelled = true;
      timers.forEach(timer => window.clearTimeout(timer));
    };
  }, [entryStage]);

  if (isCreateWindow) return <CreateRoomWindow />;

  return (
    <main className="bitconnection-shell">
      <Suspense fallback={null}>
        <Grainient
          className="bitconnection-grainient"
          colors={['#10070b', '#2a0b17', '#76203b', '#d62e5b', '#f49aad']}
          type="linear"
          angle={42}
          bands={1.2}
          speed={0.22}
          flow={0.82}
          scale={1.08}
          softness={0.76}
          silk={0.7}
          grainAmount={0.045}
          grainSize={1.15}
          grainAnimated
          contrast={1.08}
          saturation={0.82}
          variation={28}
          interactive
          stir={0.7}
          clickSwirl
          intro
          lightMode={false}
          dpr={1.2}
        />
      </Suspense>
      <header className="bitconnection-header">
        <a className="bitconnection-wordmark" href="/bitconnection/" aria-label="BitConnection home">
          <span className="bitconnection-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>BitConnection</span>
        </a>
        <a className="bitconnection-back-link" href="/">Back to BitCider</a>
      </header>
      <section className="bitconnection-hero">
        <div className="bitconnection-eyebrow"><span /> LIVE LISTENING · POWERED BY BITCHORD</div>
        <h1>Music hits<br /><em>different</em> together.</h1>
        <p className="bitconnection-intro">Start a listening party from your BitChord Web player and bring everyone into the same moment.</p>
        <div className="bitconnection-actions">
          <button className="bitconnection-create-button" type="button" onClick={openCreateWindow}>
            <span>Create a room</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
          <span className="bitconnection-source-note">YouTube Music via BitChord Web</span>
        </div>
        <div className={`bitconnection-api-status is-${apiState}`} aria-live="polite">
          <span className="bitconnection-api-dot" />
          <span>{apiState === 'checking' ? 'Connecting to Deplexo' : apiState === 'online' ? 'Deplexo API connected' : 'Deplexo API unavailable'}</span>
        </div>
      </section>
      <footer className="bitconnection-footer">
        <span>BITCONNECTION</span>
        <span>ONE ROOM · ONE MOMENT</span>
      </footer>
      {entryStage !== 'idle' && (
        <div className={`bitconnection-entry-cover is-${entryStage}`} aria-hidden="true">
          <div className="bitconnection-flame-wrap">
            <svg className="bitconnection-entry-flame" viewBox="0 0 64 80" focusable="false">
              <path className="bitconnection-flame-outer" d="M34 2C38 17 57 22 55 44c-1 19-12 32-25 32S5 63 7 45C8 31 18 23 22 12c1 12 6 16 8 18C36 21 35 12 34 2Z" />
              <path className="bitconnection-flame-inner" d="M34 35c2 9 12 13 10 25-1 8-6 13-14 13-8 0-13-7-12-15 1-6 5-10 8-15 1 6 4 8 5 9 3-5 3-10 3-17Z" />
            </svg>
          </div>
        </div>
      )}
    </main>
  );
}
