import { lazy, Suspense, useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
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

function identityHeaders(identityMode, account) {
  if (identityMode === 'bitcider') {
    return {
      'X-BitConnection-Identity': 'bitcider',
      'X-BitCider-CSRF': account?.csrfToken || ''
    };
  }
  return { 'X-BitConnection-CSRF': account?.csrfToken || '' };
}

function ProfileSetup({ account, identityMode, onSaved, onBack }) {
  const [username, setUsername] = useState(account?.profile?.username || '');
  const [avatarDataUrl, setAvatarDataUrl] = useState(account?.profile?.avatarDataUrl || null);
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
    if (file.size > 1024 * 1024) {
      setError('Profile pictures must be 1 MB or smaller.');
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
          ...identityHeaders(identityMode, account)
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
      <p className="bc-window-copy">
        {identityMode === 'bitcider'
          ? 'You chose to use your signed-in BitCider account. Your BitConnection profile stays separate from the Cider addon and connection.'
          : 'Choose the public identity people will see when you host or join a party.'}
      </p>
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
            <strong>{avatarName || (avatarDataUrl ? 'Current picture' : 'Choose a picture')}</strong>
            <small>PNG, JPEG, or WebP · up to 1 MB</small>
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

function AccountAuth({ account, onAuthenticated, onRecovery }) {
  const [mode, setMode] = useState('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState(null);
  const [avatarPreviewName, setAvatarPreviewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function setModeAndClear(nextMode) {
    setMode(nextMode);
    setError('');
  }

  function chooseAvatar(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
      setError('Choose a PNG, JPEG, or WebP image up to 1 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarDataUrl(typeof reader.result === 'string' ? reader.result : null);
      setAvatarPreviewName(file.name);
      setError('');
    };
    reader.onerror = () => setError('The selected image could not be read.');
    reader.readAsDataURL(file);
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'register') {
        const response = await fetch('/api/bitconnection/auth/register', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account.csrfToken || '' },
          body: JSON.stringify({ username, password, avatarDataUrl })
        });
        const payload = await readResponse(response, 'Could not create your BitConnection account.');
        onAuthenticated({ ...payload, password, newlyRegistered: true });
      } else if (mode === 'login') {
        const response = await fetch('/api/bitconnection/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account.csrfToken || '' },
          body: JSON.stringify({ username, password })
        });
        const payload = await readResponse(response, 'Could not sign in.');
        onAuthenticated({ ...payload, password, newlyRegistered: false });
      } else {
        const response = await fetch('/api/bitconnection/auth/recover', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account.csrfToken || '' },
          body: JSON.stringify({ username, recoveryCode, newPassword })
        });
        const payload = await readResponse(response, 'Could not recover your account.');
        onRecovery({ ...payload, password: newPassword });
      }
    } catch (authError) {
      setError(authError.message || 'Account authentication failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bc-window-form">
      <div className="bc-window-kicker">INDEPENDENT BITCONNECTION ACCOUNT</div>
      <h1>{mode === 'register' ? 'Your own space.' : mode === 'login' ? 'Welcome back.' : 'Recover your account.'}</h1>
      <p className="bc-window-copy">
        This account has its own password, passkeys, recovery codes, and sessions. Creating it does not connect Cider or create a BitCider addon.
      </p>
      <div className="bc-auth-tabs" role="tablist" aria-label="Account access">
        <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'is-active' : ''} onClick={() => setModeAndClear('register')}>Create</button>
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-active' : ''} onClick={() => setModeAndClear('login')}>Sign in</button>
        <button type="button" role="tab" aria-selected={mode === 'recover'} className={mode === 'recover' ? 'is-active' : ''} onClick={() => setModeAndClear('recover')}>Recover</button>
      </div>
      <form onSubmit={submit}>
        <label className="bc-field-card">
          <span className="bc-field-label">USERNAME <small>UP TO 24 CHARACTERS</small></span>
          <input autoFocus value={username} onChange={event => setUsername(event.target.value)} maxLength={24} autoComplete="username" placeholder="Your BitConnection username" required />
        </label>
        {mode === 'register' && (
          <>
            <label className="bc-field-card">
              <span className="bc-field-label">PASSPHRASE <small>NO CHARACTER-COUNT LIMIT</small></span>
              <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="Create a strong passphrase" required />
            </label>
            <label className="bc-field-card bc-avatar-field">
              <span className="bc-field-label">PROFILE PICTURE <small>OPTIONAL</small></span>
              <span className="bc-avatar-picker">
                <span className="bc-avatar-preview">{avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <span>+</span>}</span>
                <span className="bc-avatar-file"><strong>{avatarPreviewName || 'Choose a picture'}</strong><small>PNG, JPEG, or WebP · up to 1 MB</small></span>
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseAvatar} />
              </span>
            </label>
          </>
        )}
        {mode === 'login' && (
          <label className="bc-field-card">
            <span className="bc-field-label">PASSPHRASE</span>
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="Your BitConnection passphrase" required />
          </label>
        )}
        {mode === 'recover' && (
          <>
            <label className="bc-field-card">
              <span className="bc-field-label">ONE-TIME RECOVERY CODE</span>
              <input value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} autoComplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" required />
            </label>
            <label className="bc-field-card">
              <span className="bc-field-label">NEW PASSPHRASE</span>
              <input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" placeholder="Create a new passphrase" required />
            </label>
          </>
        )}
        {error && <div className="bc-form-error" role="alert">{error}</div>}
        <div className="bc-window-actions">
          <button className="bc-primary-button" type="submit" disabled={busy || !username.trim() || (mode === 'register' && !password) || (mode === 'login' && !password) || (mode === 'recover' && (!recoveryCode.trim() || !newPassword))}>
            {busy ? 'Please wait…' : mode === 'register' ? 'Create BitConnection account' : mode === 'login' ? 'Sign in' : 'Reset passphrase'}
          </button>
        </div>
      </form>
      {mode === 'login' && (
        <button className="bc-passkey-signin" type="button" onClick={onPasskeySignIn} disabled={busy}>
          <span aria-hidden="true">⌁</span> Sign in with a passkey
        </button>
      )}
    </section>
  );
}

function RecoveryCodes({ recoveryCodes, account, password, onContinue }) {
  const [saved, setSaved] = useState(false);
  const [passkeyPassword, setPasskeyPassword] = useState(password || '');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState('');
  const [copied, setCopied] = useState(false);

  async function addPasskey() {
    setPasskeyBusy(true);
    setPasskeyMessage('');
    try {
      const optionsResponse = await fetch('/api/bitconnection/passkeys/register/options', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account?.csrfToken || '' },
        body: JSON.stringify({ password: passkeyPassword })
      });
      const optionsJSON = await readResponse(optionsResponse, 'Could not start passkey setup.');
      const registration = await startRegistration({ optionsJSON });
      const verifyResponse = await fetch('/api/bitconnection/passkeys/register/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account?.csrfToken || '' },
        body: JSON.stringify({ ...registration, deviceName: navigator.userAgent })
      });
      const verified = await readResponse(verifyResponse, 'Could not save this passkey.');
      setPasskeyMessage('Passkey added to your BitConnection account.');
      setSaved(true);
    } catch (error) {
      setPasskeyMessage(error.message || 'Passkey setup was cancelled.');
    } finally {
      setPasskeyBusy(false);
    }
  }

  const codesText = recoveryCodes.join('\n');

  return (
    <section className="bc-window-state bc-recovery-state">
      <div className="bc-window-kicker">SAVE THESE ONCE</div>
      <h1>Your recovery codes.</h1>
      <p>Each code can be used once to reset your passphrase and issue a fresh set. These codes are only shown now, so save them somewhere private.</p>
      <div className="bc-recovery-codes">
        {recoveryCodes.map(code => <code key={code}>{code}</code>)}
      </div>
      <div className="bc-window-actions bc-recovery-actions">
        <button className="bc-secondary-button" type="button" onClick={() => {
          navigator.clipboard?.writeText(codesText).then(() => setCopied(true)).catch(() => setPasskeyMessage('Clipboard access was blocked.'));
        }}>{copied ? 'Copied' : 'Copy recovery codes'}</button>
        <a className="bc-secondary-button" href={URL.createObjectURL(new Blob([codesText], { type: 'text/plain' }))} download="bitconnection-recovery-codes.txt">Save as file</a>
      </div>
      <div className="bc-passkey-setup">
        <strong>Want passkey sign-in too?</strong>
        <p>Add a device passkey. It stays inside BitConnection and is separate from BitCider passkeys.</p>
        <input type="password" value={passkeyPassword} onChange={event => setPasskeyPassword(event.target.value)} placeholder="Confirm your BitConnection passphrase" autoComplete="current-password" />
        <button className="bc-secondary-button" type="button" onClick={addPasskey} disabled={passkeyBusy || !passkeyPassword}>{passkeyBusy ? 'Setting up…' : 'Add a passkey'}</button>
        {passkeyMessage && <small role="status">{passkeyMessage}</small>}
      </div>
      <label className="bc-recovery-confirm">
        <input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />
        <span>I have saved my recovery codes somewhere safe.</span>
      </label>
      <div className="bc-window-actions">
        <button className="bc-primary-button" type="button" disabled={!saved} onClick={onContinue}>Continue to room setup</button>
      </div>
    </section>
  );
}

function CreateRoomWindow() {
  const [account, setAccount] = useState(null);
  const [identityMode, setIdentityMode] = useState('bitconnection');
  const [stage, setStage] = useState('loading');
  const [profile, setProfile] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [roomName, setRoomName] = useState('');
  const [visibility, setVisibility] = useState('public');
  const [partySize, setPartySize] = useState(4);
  const [ownerOnlyControls, setOwnerOnlyControls] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdRoom, setCreatedRoom] = useState(null);

  async function loadAccount(mode = 'bitconnection') {
    const headers = mode === 'bitcider' ? { 'X-BitConnection-Identity': 'bitcider' } : {};
    const payload = await readResponse(await fetch('/api/bitconnection/account', {
      headers, cache: 'no-store', credentials: 'same-origin'
    }), 'Could not load account information.');
    setAccount(payload);
    setProfile(payload.profile || null);
    setPartySize(Math.min(4, payload.maxPartySize || 10));
    setIdentityMode(mode);
    return payload;
  }

  useEffect(() => {
    let active = true;
    fetch('/api/bitconnection/account', { cache: 'no-store', credentials: 'same-origin' })
      .then(response => readResponse(response, 'Could not load account information.'))
      .then(payload => {
        if (!active) return;
        setAccount(payload);
        setProfile(payload.profile || null);
        setPartySize(Math.min(4, payload.maxPartySize || 10));
        if (payload.authenticated) {
          setIdentityMode('bitconnection');
          setStage(payload.profile?.username ? 'room' : 'profile');
        } else if (payload.bitCiderAccountAvailable) {
          setStage('choose-account');
        } else {
          setStage('auth');
        }
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

  async function chooseBitCiderAccount() {
    setBusy(true);
    setError('');
    try {
      const payload = await loadAccount('bitcider');
      if (!payload.authenticated) throw new Error('Sign in to BitCider first, then choose this option again.');
      setStage(payload.profile?.username ? 'room' : 'profile');
    } catch (choiceError) {
      setError(choiceError.message || 'Could not use this BitCider account.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshIndependentAccount() {
    const payload = await loadAccount('bitconnection');
    setIdentityMode('bitconnection');
    return payload;
  }

  function handleAuthenticated(payload) {
    setRecoveryPassword(payload.password || '');
    if (payload.recoveryCodes?.length) {
      setRecoveryCodes(payload.recoveryCodes);
      setStage('recovery');
    } else {
      refreshIndependentAccount().then(next => {
        setProfile(next.profile || null);
        setStage(next.profile?.username ? 'room' : 'profile');
      }).catch(loadError => {
        setError(loadError.message || 'Could not load your BitConnection profile.');
      });
    }
  }

  function handleRecovery(payload) {
    setRecoveryPassword(payload.password || '');
    setRecoveryCodes(payload.recoveryCodes || []);
    setStage('recovery');
  }

  async function handlePasskeySignIn() {
    setBusy(true);
    setError('');
    try {
      const optionsResponse = await fetch('/api/bitconnection/passkeys/auth/options', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-BitConnection-CSRF': account?.csrfToken || '' }
      });
      const optionsJSON = await readResponse(optionsResponse, 'Could not start passkey sign-in.');
      const authentication = await startAuthentication({ optionsJSON });
      const verifyResponse = await fetch('/api/bitconnection/passkeys/auth/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account?.csrfToken || '' },
        body: JSON.stringify(authentication)
      });
      await readResponse(verifyResponse, 'Could not verify this passkey.');
      const payload = await refreshIndependentAccount();
      setStage(payload.profile?.username ? 'room' : 'profile');
    } catch (passkeyError) {
      setError(passkeyError.message || 'Passkey sign-in failed.');
    } finally {
      setBusy(false);
    }
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
          ...identityHeaders(identityMode, account)
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

      {stage === 'choose-account' && (
        <section className="bc-window-state">
          <div className="bc-window-kicker">ACCOUNT FOUND</div>
          <h1>How would you like to continue?</h1>
          <p>You already have a BitCider account on this device. You can explicitly reuse that signed-in identity or create a separate BitConnection account with its own password, passkeys, and recovery codes.</p>
          <div className="bc-window-actions">
            <button className="bc-secondary-button" type="button" onClick={closeWindow}>Not now</button>
            <button className="bc-secondary-button" type="button" disabled={busy} onClick={() => setStage('auth')}>Create separate account</button>
            <button className="bc-primary-button" type="button" disabled={busy} onClick={chooseBitCiderAccount}>Use BitCider account</button>
          </div>
          {error && <div className="bc-form-error" role="alert">{error}</div>}
        </section>
      )}

      {stage === 'auth' && account && (
        <AccountAuth
          account={account}
          onAuthenticated={handleAuthenticated}
          onRecovery={handleRecovery}
          onPasskeySignIn={handlePasskeySignIn}
        />
      )}

      {stage === 'recovery' && recoveryCodes.length > 0 && (
        <RecoveryCodes
          recoveryCodes={recoveryCodes}
          account={account}
          password={recoveryPassword}
          onContinue={() => {
            refreshIndependentAccount().then(payload => {
              setProfile(payload.profile || null);
              setStage(payload.profile?.username ? 'room' : 'profile');
            }).catch(loadError => setError(loadError.message || 'Could not load your profile.'));
          }}
        />
      )}

      {stage === 'profile' && (
        <ProfileSetup
          account={account}
          identityMode={identityMode}
          onBack={() => setStage(identityMode === 'bitcider' ? 'choose-account' : 'auth')}
          onSaved={saved => {
            setProfile(saved);
            setStage('room');
          }}
        />
      )}

      {stage === 'room' && profile && (
        <form className="bc-window-form" onSubmit={createRoom}>
          <div className="bc-window-kicker">HOST A LISTENING PARTY</div>
          <h1>Set the room.</h1>
          <p className="bc-window-copy">
            Signed in as <strong>{profile.username}</strong>. Music comes exclusively from YouTube Music through BitChord Web.
            {identityMode === 'bitcider' ? ' This uses your existing BitCider login only, and does not create or change a Cider addon.' : ''}
          </p>
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
          <p>The room settings are saved on Deplexo. Live membership, WebRTC audio, and the immersive player view are the next integration stage.</p>
          <div className="bc-created-code"><small>ROOM CODE</small><strong>{createdRoom.roomCode}</strong></div>
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
      {stage !== 'created' && stage !== 'error' && error && stage !== 'choose-account' && <div className="bc-global-error" role="alert">{error}</div>}
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
