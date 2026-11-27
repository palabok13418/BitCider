import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BitConnectionApiClient } from './bitconnection/realtime-client.mjs';
import { startBitConnectionGuestTransport, startBitConnectionHostTransport, startBitConnectionHostMediaTransport } from './bitconnection/audio-transport.mjs';
import { attachBitCiderStream } from './bitconnection/stream-player.mjs';
import {
  getMusicKitPlayer,
  musicKitQueueDescriptor,
  normalizeAppleCatalogTrack,
  musicKitPlaybackSnapshot,
  subscribeAppleMusicPlayback,
  controlAppleMusicPlayback as controlMusicKitPlayback
} from './bitconnection/musickit-player.mjs';
import PartyRoomExperience from './BitConnectionParty.jsx';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './bitconnection.css';
import UnifiedAccountCenterIdentity from './UnifiedAccountCenter.jsx';
import AdminConsole from './AdminConsole.jsx';

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
    'popup=yes,width=1280,height=820,resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no'
  );
  if (!popup) window.location.assign(CREATE_URL);
}

function openAccountWindow() {
  const popup = window.open(
    '/bitconnection/?account=1',
    'bitconnection-account',
    'popup=yes,width=860,height=720,resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no'
  );
  if (!popup) window.location.assign('/bitconnection/?account=1');
}

function openJoinWindow(roomId) {
  const popup = window.open(
    '/bitconnection/?join=' + encodeURIComponent(roomId),
    'bitconnection-join-' + String(roomId).slice(0, 16),
    'popup=yes,width=1280,height=820,resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no'
  );
  if (!popup) window.location.assign('/bitconnection/?join=' + encodeURIComponent(roomId));
}

function PublicPartyCard({ room, onJoin }) {
  const count = Number(room.participantCount || 0);
  const capacity = Number(room.partySize || 0);
  const track = room.currentTrack?.title;
  return (
    <article className="bc-public-party-card">
      <div className="bc-public-party-topline">
        <span className="bc-public-live"><i /> LIVE NOW</span>
      </div>
      <h3>{room.roomName}</h3>
      <p className="bc-public-host">Hosted by <strong>{room.hostUsername || 'BitConnection host'}</strong></p>
      {track && (
        <p className="bc-public-track">
          <span>NOW PLAYING</span>
          <strong>{track}</strong>
          {room.currentTrack?.artist && <small>{room.currentTrack.artist}</small>}
        </p>
      )}
      <div className="bc-public-party-bottom">
        <span>{count} / {capacity} here</span>
        <button type="button" onClick={() => onJoin(room.roomId)}>Join party <span aria-hidden="true">↗</span></button>
      </div>
    </article>
  );
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
      <div className="bc-window-kicker">BITACCOUNT CENTER · BITCONNECTION PROFILE</div>
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

const PASSWORD_GENERATOR_GROUPS = [
  Array.from('abcdefghijklmnopqrstuvwxyz'),
  Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
  Array.from('0123456789'),
  Array.from('!@#$%^&*()-_=+[]{};:,.<>/?\\\\|~'),
  Array.from('⟡⧫⌬⍟⎈⧉⌘⌥⚙⚛⚝⚿♜♞♢♧☠𖤐🜁🜂🜃🜄'),
  ['𝔄', '𝕏', '𝖘', '𝒵', '𝓠', '𝖅', '𝔷', '𝕽', '𝘿', '𝙓'],
  Array.from('ضصثقفقغعهخحجددذرزسشص'),
  Array.from('密碼鍵龍影秘語字夢狐霧夜星'),
  Array.from('ЖФЯщΩψξλΔЖФЯ'),
  ['a\\u0336\\u035c\\u0315', 'Z\\u0338\\u0351\\u034f', 'm\\u0337\\u0307\\u0323', 'Q\\u0336\\u034f\\u031c', 'x\\u0338\\u0334\\u0301', 'R\\u0337\\u0308\\u035c']
];
const PASSWORD_GENERATOR_POOL = PASSWORD_GENERATOR_GROUPS.flat();
const PASSWORD_MORPH_GLYPHS = Array.from('ABCDEFGHJKLMNPQRSTUVWXYZ23456789#$%&*+=<>?⟡⧫⌬⍟⚛⚝ЖΩ密龍');

function secureRandomIndex(maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x100000000) {
    throw new RangeError('Invalid secure random range.');
  }
  const limit = Math.floor(0x100000000 / maximum) * maximum;
  const sample = new Uint32Array(1);
  do {
    window.crypto.getRandomValues(sample);
  } while (sample[0] >= limit);
  return sample[0] % maximum;
}

function generateCryptographicPassword() {
  const length = 24 + secureRandomIndex(477);
  const characters = PASSWORD_GENERATOR_GROUPS.map(group => group[secureRandomIndex(group.length)]);
  while (characters.length < length) {
    characters.push(PASSWORD_GENERATOR_POOL[secureRandomIndex(PASSWORD_GENERATOR_POOL.length)]);
  }
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = secureRandomIndex(index + 1);
    [characters[index], characters[swap]] = [characters[swap], characters[index]];
  }
  return characters.join('');
}

function morphPasswordText(from, to, progress) {
  const source = Array.from(from);
  const target = Array.from(to);
  const length = Math.max(source.length, target.length);
  const settled = Math.floor(length * Math.max(0, Math.min(1, progress)));
  return Array.from({ length }, (_, index) => {
    if (index < settled) return target[index] || '';
    return source[index] || PASSWORD_MORPH_GLYPHS[secureRandomIndex(PASSWORD_MORPH_GLYPHS.length)];
  }).join('');
}



function passwordStrength(value) {
  if (!value) return { level: 0, label: 'Start typing', note: 'No character-count limit. Strength is guidance, not a gate.' };
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /[0-9]/.test(value),
    /[^A-Za-z0-9]/.test(value),
    /[^\x00-\x7F]/.test(value)
  ].filter(Boolean).length;
  const predictable = /(.)\1{3,}|0123|1234|2345|abcd|bcde|qwer|asdf|password|letmein|welcome/i.test(value);
  if (value.length < 8 || (classes === 1 && value.length < 12)) {
    return { level: 1, label: 'Simple', note: 'Add more length or variety to make it harder to guess.' };
  }
  if (value.length < 14 || classes < 3 || predictable) {
    return { level: 2, label: 'Mid · Try adding something', note: 'A longer password or another character type can make this stronger.' };
  }
  return { level: 3, label: 'Hard · Good', note: 'Looks harder to guess. Keep it unique to BitCider.' };
}


function BitConnectionAuthIcon({ name }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'wand') return <svg {...common}><path d="m15 4 5 5M4 20 16.5 7.5M4 4v4M2 6h4M18 15v5M15.5 17.5h5M10 2v3M8.5 3.5h3" /></svg>;
  if (name === 'eye-off') return <svg {...common}><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.2A11.2 11.2 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 4.1M6.2 6.2C3.5 8.1 2 12 2 12s3.6 7 10 7c1.1 0 2.1-.2 3-.5" /></svg>;
  return <svg {...common}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
}

function AccountAuth({ account, initialMode = 'register', onAuthenticated, onRecovery, onPasskeySignIn }) {
  const [mode, setMode] = useState(initialMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [isGeneratedPassword, setIsGeneratedPassword] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordAnimating, setPasswordAnimating] = useState(false);
  const [passwordAnimatedValue, setPasswordAnimatedValue] = useState('');
  const passwordAnimationRef = useRef(null);
  const strength = passwordStrength(password);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState(null);
  const [avatarPreviewName, setAvatarPreviewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => {
    if (passwordAnimationRef.current) window.clearInterval(passwordAnimationRef.current);
  }, []);

  function generateAccountPassword() {
    try {
      if (passwordAnimationRef.current) window.clearInterval(passwordAnimationRef.current);
      const generated = generateCryptographicPassword();
      setPassword(generated);
      setPasswordConfirm(generated);
      setIsGeneratedPassword(true);
      setPasswordVisible(false);
      setPasswordAnimating(false);
      setPasswordAnimatedValue('');
      setError('');
    } catch {
      setError('Secure password generation is unavailable in this browser context. Use a supported HTTPS browser and try again.');
    }
  }

  function togglePasswordVisibility() {
    if (!password || passwordAnimating) return;
    const nextVisible = !passwordVisible;
    const hiddenText = isGeneratedPassword
      ? 'Password123'
      : '•'.repeat(Math.min(Array.from(password).length, 48));
    const from = passwordVisible ? password : hiddenText;
    const to = nextVisible ? password : hiddenText;
    if (passwordAnimationRef.current) window.clearInterval(passwordAnimationRef.current);

    setPasswordAnimating(true);
    setPasswordAnimatedValue(from);
    let frame = 0;
    const totalFrames = 15;
    passwordAnimationRef.current = window.setInterval(() => {
      frame += 1;
      setPasswordAnimatedValue(morphPasswordText(from, to, frame / totalFrames));
      if (frame >= totalFrames) {
        window.clearInterval(passwordAnimationRef.current);
        passwordAnimationRef.current = null;
        setPasswordVisible(nextVisible);
        setPasswordAnimatedValue('');
        setPasswordAnimating(false);
      }
    }, 32);
  }

  function setModeAndClear(nextMode) {
    if (passwordAnimationRef.current) {
      window.clearInterval(passwordAnimationRef.current);
      passwordAnimationRef.current = null;
    }
    setPasswordAnimating(false);
    setPasswordAnimatedValue('');
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
        if (password !== passwordConfirm) {
          setError('The passwords do not match.');
          return;
        }
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
      <h1>{mode === 'register' ? 'Your own space.' : mode === 'login' ? 'Welcome back.' : 'Recover your account.'}</h1>
      <p className="bc-window-copy">
        {mode === 'register'
          ? 'Create your BitConnection profile to host listening rooms, invite friends, and keep your party identity in one place.'
          : mode === 'login'
            ? 'Sign in to your existing BitConnection account. This stays separate from your BitCider login.'
            : 'Use one of your saved one-time recovery codes to reset your BitConnection password.'}
      </p>
      <div className={'bc-auth-tabs' + (mode === 'login' || mode === 'recover' ? ' is-login' : '')} role="tablist" aria-label="Account access">
        <button type="button" role="tab" aria-selected={mode === 'register'} aria-controls="bc-auth-panel" className={mode === 'register' ? 'is-active' : ''} onClick={() => setModeAndClear('register')}>Create account</button>
        <button type="button" role="tab" aria-selected={mode === 'login' || mode === 'recover'} aria-controls="bc-auth-panel" className={mode === 'login' || mode === 'recover' ? 'is-active' : ''} onClick={() => setModeAndClear('login')}>Sign in</button>
      </div>
      <form id="bc-auth-panel" aria-live="polite" onSubmit={submit}>
        <label className="bc-field-card">
          <span className="bc-field-label">USERNAME <small>UP TO 24 CHARACTERS</small></span>
          <input autoFocus value={username} onChange={event => setUsername(event.target.value)} maxLength={24} autoComplete="username" placeholder="Your BitConnection username" required />
        </label>
        {mode === 'register' && (
          <>
            <label className="bc-field-card">
              <span className="bc-field-label">CREATE A PASSWORD <small>NO CHARACTER-COUNT LIMIT</small></span>
              <span className={'bc-auth-password-shell' + (passwordAnimating ? ' is-animating ' + (passwordVisible ? 'is-decrypting' : 'is-encrypting') : '')}>
                <button className="bc-auth-password-tool bc-auth-password-generator" type="button" onClick={generateAccountPassword} disabled={busy || passwordAnimating} aria-label="Generate a cryptographically random password" title="Generate a secure password"><BitConnectionAuthIcon name="wand" /></button>
                <input
                  id="bc-new-password"
                  name="new-password"
                  type={passwordAnimating || passwordVisible || isGeneratedPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={passwordAnimating ? passwordAnimatedValue : isGeneratedPassword && !passwordVisible ? 'Password123' : password}
                  onChange={event => {
                    setPassword(event.target.value);
                    setPasswordConfirm('');
                    setIsGeneratedPassword(false);
                  }}
                  readOnly={passwordAnimating || (isGeneratedPassword && !passwordVisible)}
                  placeholder="Start Typing"
                  required
                  dir="ltr"
                  spellCheck={false}
                  aria-label="Create a password"
                />
                <button className="bc-auth-password-tool bc-auth-password-visibility" type="button" onClick={togglePasswordVisibility} disabled={!password || busy || passwordAnimating} aria-label={passwordVisible ? 'Hide password' : 'Show password'} aria-pressed={passwordVisible} title={passwordVisible ? 'Hide password' : 'Show password'}><BitConnectionAuthIcon name={passwordVisible ? 'eye-off' : 'eye'} /></button>
              </span>
            </label>
            <div className={'bc-password-strength' + (strength.level ? ' level-' + strength.level : '')} aria-live="polite">
              <div className="bc-password-strength-bars"><i /><i /><i /></div>
              <strong>{strength.label}</strong>
              <span>{strength.note}</span>
            </div>
            <label className="bc-field-card">
              <span className="bc-field-label">CONFIRM PASSWORD</span>
              <input id="bc-confirm-password" name="confirm-password" type={passwordAnimating || passwordVisible || isGeneratedPassword ? 'text' : 'password'} autoComplete="new-password" value={passwordAnimating ? passwordAnimatedValue : isGeneratedPassword && !passwordVisible ? 'Password123' : passwordConfirm} onChange={event => { setPasswordConfirm(event.target.value); setIsGeneratedPassword(false); }} readOnly={passwordAnimating || isGeneratedPassword} placeholder="Type it again" required dir="ltr" spellCheck={false} />
            </label>
            <p className="bc-password-footnote">Generate a 24–500 character password with secure randomness, or type your own. Generated passwords include multiple scripts, symbols and combining characters. The hidden preview reads Password123; the actual password is much more complex.</p>
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
            <span className="bc-field-label">PASSWORD</span>
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="Your BitConnection password" required />
          </label>
        )}
        {mode === 'recover' && (
          <>
            <label className="bc-field-card">
              <span className="bc-field-label">ONE-TIME RECOVERY CODE</span>
              <input value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} autoComplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" required />
            </label>
            <label className="bc-field-card">
              <span className="bc-field-label">NEW PASSWORD</span>
              <input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" placeholder="Create a new password" required />
            </label>
          </>
        )}
        {error && <div className="bc-form-error" role="alert">{error}</div>}
        <div className="bc-window-actions">
          {mode === 'recover' && (
            <button className="bc-secondary-button" type="button" onClick={() => setModeAndClear('login')} disabled={busy}>Back to sign in</button>
          )}
          <button className="bc-primary-button" type="submit" disabled={busy || !username.trim() || (mode === 'register' && (!password || !passwordConfirm || password !== passwordConfirm)) || (mode === 'login' && !password) || (mode === 'recover' && (!recoveryCode.trim() || !newPassword))}>
            {busy ? 'Please wait…' : mode === 'register' ? 'Create BitConnection account' : mode === 'login' ? 'Sign in' : 'Reset password'}
          </button>
        </div>
        {mode === 'login' && (
          <button className="bc-recovery-link" type="button" onClick={() => setModeAndClear('recover')} disabled={busy}>
            Forgot your password? Use a recovery code
          </button>
        )}
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
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const [passkeyAdded, setPasskeyAdded] = useState(false);
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
      setPasskeyAdded(true);
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
      <p>Each code can be used once to reset your password and issue a fresh set. These codes are only shown now, so save them somewhere private.</p>
      <div className="bc-recovery-codes">
        {recoveryCodes.map(code => <code key={code}>{code}</code>)}
      </div>
      <div className="bc-window-actions bc-recovery-actions">
        <button className="bc-secondary-button" type="button" onClick={() => {
          navigator.clipboard?.writeText(codesText).then(() => setCopied(true)).catch(() => setPasskeyMessage('Clipboard access was blocked.'));
        }}>{copied ? 'Copied' : 'Copy recovery codes'}</button>
        <button className="bc-secondary-button" type="button" onClick={() => {
          const blobUrl = URL.createObjectURL(new Blob([codesText], { type: 'text/plain' }));
          const link = document.createElement('a');
          link.href = blobUrl;
          link.download = 'bitconnection-recovery-codes.txt';
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        }}>Save as file</button>
      </div>
      <div className="bc-passkey-setup">
        <strong>Want passkey sign-in too?</strong>
        <p>Add a device passkey. It stays inside BitConnection and is separate from BitCider passkeys.</p>
        <input type="password" value={passkeyPassword} onChange={event => setPasskeyPassword(event.target.value)} placeholder="Confirm your BitConnection password" autoComplete="current-password" />
        <button className="bc-secondary-button" type="button" onClick={addPasskey} disabled={passkeyBusy || !passkeyPassword || passkeyAdded}>{passkeyBusy ? 'Setting up…' : passkeyAdded ? 'Passkey added' : 'Add a passkey'}</button>
        {passkeyMessage && <small role="status">{passkeyMessage}</small>}
      </div>
      <label className="bc-recovery-confirm">
        <input type="checkbox" checked={confirmedSaved} onChange={event => setConfirmedSaved(event.target.checked)} />
        <span>I have saved my recovery codes somewhere safe.</span>
      </label>
      <div className="bc-window-actions">
        <button className="bc-primary-button" type="button" disabled={!confirmedSaved} onClick={onContinue}>Continue to room setup</button>
      </div>
    </section>
  );
}

function AccountManagementWindow() {
  const [account, setAccount] = useState(null);
  const [identityMode, setIdentityMode] = useState('bitconnection');
  const [profile, setProfile] = useState(null);
  const [passkeys, setPasskeys] = useState([]);
  const [passkeysUnavailable, setPasskeysUnavailable] = useState(false);
  const [stage, setStage] = useState('loading');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [passkeyPassword, setPasskeyPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [appleMusicStatus, setAppleMusicStatus] = useState(null);
  const [appleMusicUserToken, setAppleMusicUserToken] = useState('');
  const [appleMusicBusy, setAppleMusicBusy] = useState(false);

  async function loadAccount(mode = 'auto') {
    const selectedMode = mode === 'auto' ? 'bitconnection' : mode;
    const headers = selectedMode === 'bitcider' ? { 'X-BitConnection-Identity': 'bitcider' } : {};
    const payload = await readResponse(await fetch('/api/bitconnection/account', {
      headers, cache: 'no-store', credentials: 'same-origin'
    }), 'Could not load your account.');
    if (mode === 'auto' && payload.bitCiderAccountAvailable) {
      return loadAccount('bitcider');
    }
    setAccount(payload);
    setIdentityMode(selectedMode);
    setProfile(payload.profile || null);
    if (payload.authenticated) {
      const providerHeaders = selectedMode === 'bitcider' ? { 'X-BitConnection-Identity': 'bitcider' } : {};
      const providerResponse = await fetch('/api/bitconnection/account/providers/apple-music', {
        headers: providerHeaders, cache: 'no-store', credentials: 'same-origin'
      });
      const providerPayload = providerResponse.ok ? await providerResponse.json().catch(() => null) : null;
      setAppleMusicStatus(providerPayload);
    } else {
      setAppleMusicStatus(null);
    }
    if (payload.authenticated && selectedMode === 'bitconnection') {
      const passkeyResponse = await fetch('/api/bitconnection/passkeys', {
        cache: 'no-store', credentials: 'same-origin'
      });
      if (passkeyResponse.status === 404) {
        // Older Deplexo deployments may not yet expose passkey listing. Keep
        // BitAccount Center usable instead of failing the entire account load.
        setPasskeys([]);
        setPasskeysUnavailable(true);
      } else {
        const passkeyPayload = await readResponse(passkeyResponse, 'Could not load your passkeys.');
        setPasskeys(passkeyPayload.passkeys || []);
        setPasskeysUnavailable(false);
      }
    } else {
      setPasskeys([]);
      setPasskeysUnavailable(false);
    }
    setStage(!payload.authenticated ? 'auth' : payload.profile?.username ? 'manage' : 'profile');
    return payload;
  }

  useEffect(() => {
    let active = true;
    const requestedIdentity = new URLSearchParams(window.location.search).get('identity');
    loadAccount(requestedIdentity === 'bitconnection' ? 'bitconnection' : 'auto').catch(loadError => {
      if (!active) return;
      setError(loadError.message || 'Could not connect to your account.');
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

  function handleAuthenticated(payload) {
    if (payload.recoveryCodes?.length) {
      setRecoveryPassword(payload.password || '');
      setRecoveryCodes(payload.recoveryCodes);
      setStage('recovery');
      return;
    }
    loadAccount('bitconnection').catch(loadError => {
      setError(loadError.message || 'Could not refresh your account.');
    });
  }

  function handleRecovery(payload) {
    setRecoveryPassword(payload.password || '');
    setRecoveryCodes(payload.recoveryCodes || []);
    setStage('recovery');
  }

  async function signInWithPasskey() {
    setBusy(true);
    setError('');
    try {
      const optionsJSON = await readResponse(await fetch('/api/bitconnection/passkeys/auth/options', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-BitConnection-CSRF': account?.csrfToken || '' }
      }), 'Could not start passkey sign-in.');
      const authentication = await startAuthentication({ optionsJSON });
      await readResponse(await fetch('/api/bitconnection/passkeys/auth/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account?.csrfToken || '' },
        body: JSON.stringify(authentication)
      }), 'Could not verify your passkey.');
      await loadAccount('bitconnection');
    } catch (passkeyError) {
      setError(passkeyError.message || 'Passkey sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    if (!passkeyPassword) {
      setError('Enter your account password to add a passkey.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const optionsJSON = await readResponse(await fetch('/api/bitconnection/passkeys/register/options', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account?.csrfToken || '' },
        body: JSON.stringify({ password: passkeyPassword })
      }), 'Could not start passkey setup.');
      const registration = await startRegistration({ optionsJSON });
      await readResponse(await fetch('/api/bitconnection/passkeys/register/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account?.csrfToken || '' },
        body: JSON.stringify({ ...registration, deviceName: navigator.userAgent })
      }), 'Could not save this passkey.');
      await loadAccount('bitconnection');
      setPasskeyPassword('');
      setNotice('Passkey added to your BitConnection account.');
    } catch (passkeyError) {
      setError(passkeyError.message || 'Passkey setup was cancelled.');
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey(credentialId) {
    if (!passkeyPassword) {
      setError('Enter your account password before removing a passkey.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await readResponse(await fetch('/api/bitconnection/passkeys/remove', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-BitConnection-CSRF': account?.csrfToken || '' },
        body: JSON.stringify({ password: passkeyPassword, credentialId })
      }), 'Could not remove this passkey.');
      await loadAccount('bitconnection');
      setPasskeyPassword('');
      setNotice('Passkey removed.');
    } catch (removeError) {
      setError(removeError.message || 'Could not remove this passkey.');
    } finally {
      setBusy(false);
    }
  }



  async function saveAppleMusicToken(event) {
    event.preventDefault();
    if (!account?.authenticated || !appleMusicUserToken.trim() || appleMusicBusy) return;
    setAppleMusicBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/bitconnection/account/providers/apple-music', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...identityHeaders(identityMode, account)
        },
        body: JSON.stringify({ userMediaToken: appleMusicUserToken.trim() })
      });
      const payload = await readResponse(response, 'Could not connect Apple Music.');
      setAppleMusicUserToken('');
      setAppleMusicStatus(previous => ({
        ...(previous || {}),
        provider: 'Apple Music',
        connected: true,
        connectedAt: payload.connectedAt || new Date().toISOString(),
        secureStorageConfigured: true
      }));
      setNotice('Apple Music is connected to this BitAccount.');
    } catch (connectError) {
      setError(connectError.message || 'Could not connect Apple Music.');
    } finally {
      setAppleMusicBusy(false);
    }
  }

  async function disconnectAppleMusic() {
    if (!account?.authenticated || appleMusicBusy) return;
    setAppleMusicBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/bitconnection/account/providers/apple-music', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: identityHeaders(identityMode, account)
      });
      await readResponse(response, 'Could not disconnect Apple Music.');
      setAppleMusicStatus(previous => ({ ...(previous || {}), connected: false, connectedAt: null }));
      setAppleMusicUserToken('');
      setNotice('Apple Music has been disconnected.');
    } catch (disconnectError) {
      setError(disconnectError.message || 'Could not disconnect Apple Music.');
    } finally {
      setAppleMusicBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await readResponse(await fetch('/api/bitconnection/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-BitConnection-CSRF': account?.csrfToken || '' }
      }), 'Could not sign out.');
      setAccount(null);
      setProfile(null);
      setPasskeys([]);
      setStage('signedout');
    } catch (logoutError) {
      setError(logoutError.message || 'Could not sign out.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bc-window-shell bc-account-window">
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
      {stage === 'loading' && <section className="bc-window-state"><span className="bc-loading-orbit" /><p>Loading your account…</p></section>}
      {stage === 'auth' && account && (
        <AccountAuth
          account={account}
          initialMode="login"
          onAuthenticated={handleAuthenticated}
          onRecovery={handleRecovery}
          onPasskeySignIn={signInWithPasskey}
        />
      )}
      {stage === 'recovery' && recoveryCodes.length > 0 && (
        <RecoveryCodes
          recoveryCodes={recoveryCodes}
          account={account}
          password={recoveryPassword}
          onContinue={() => {
            setRecoveryCodes([]);
            loadAccount('bitconnection').catch(loadError => setError(loadError.message || 'Could not load your account.'));
          }}
        />
      )}
      {stage === 'profile' && (
        <ProfileSetup
          account={account}
          identityMode={identityMode}
          onBack={() => setStage(account?.authenticated ? 'manage' : 'auth')}
          onSaved={saved => { setProfile(saved); setStage('manage'); }}
        />
      )}
      {stage === 'manage' && profile && (
        <div className="bc-account-workspace">
          <header className="bc-account-topbar">
            <div className="bc-account-brand">
              <span className="bc-account-brand-mark" aria-hidden="true">BA</span>
              <div>
                <span>BITACCOUNT</span>
                <strong>BitAccount Center</strong>
              </div>
            </div>
            <div className="bc-account-top-actions">
              <span className="bc-account-protected"><i aria-hidden="true" /> ACCOUNT PROTECTED</span>
              <button className="bc-secondary-button" type="button" onClick={() => setStage('profile')}>Edit profile</button>
            </div>
          </header>

          <div className="bc-account-grid">
            <aside className="bc-account-profile-panel">
              <div className="bc-account-panel-kicker">YOUR BITACCOUNT</div>
              <UnifiedAccountCenterIdentity currentProduct="bitconnection" profile={profile} createdAt={profile.createdAt} />
              <div className="bc-account-profile-note">
                <span className="bc-account-note-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M12 3.5 19 6v5.2c0 4.6-3 7.7-7 9.3-4-1.6-7-4.7-7-9.3V6l7-2.5Z" /><path d="m9 12 2 2 4-4" /></svg>
                </span>
                <span><strong>Profile & connected apps</strong><small>Your identity and product sign-in status.</small></span>
              </div>
            </aside>

            <section className="bc-account-security-panel">
              <div className="bc-account-security-head">
                <div>
                  <span className="bc-account-panel-kicker">SIGN-IN & SECURITY</span>
                  <h2>Passkeys</h2>
                  <p>Use a device passkey to sign in without typing your password.</p>
                </div>
                {identityMode === 'bitconnection' && !passkeysUnavailable && (
                  <span className="bc-account-count">{passkeys.length} <small>/ 5</small></span>
                )}
              </div>

              {identityMode === 'bitconnection' ? (
                passkeysUnavailable ? (
                  <div className="bc-account-unavailable">
                    <strong>Passkey management unavailable</strong>
                    <p>This Deplexo backend has not exposed passkey listing yet. Your account and profile are still available.</p>
                  </div>
                ) : (
                  <>
                    <div className="bc-account-passkey-add">
                      <label>
                        <span>Confirm account password</span>
                        <input type="password" value={passkeyPassword} onChange={event => setPasskeyPassword(event.target.value)} autoComplete="current-password" placeholder="Enter your password" />
                      </label>
                      <button className="bc-primary-button" type="button" onClick={addPasskey} disabled={busy || passkeys.length >= 5 || !passkeyPassword}>
                        {busy ? 'Working…' : 'Add passkey'}
                      </button>
                    </div>
                    <div className="bc-account-passkey-list" aria-label="Registered passkeys">
                      {passkeys.length > 0 ? passkeys.map((passkey, index) => (
                        <div className="bc-account-passkey-row" key={passkey.id}>
                          <span className="bc-account-key-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><circle cx="8.2" cy="10" r="4.2" /><path d="M12.1 10H21v3h-2v2h-3v-2h-3.1" /></svg>
                          </span>
                          <span className="bc-account-passkey-copy">
                            <strong>{passkey.name || 'Passkey ' + (index + 1)}</strong>
                            <small>{passkey.deviceType === 'multiDevice' ? 'Synced passkey' : 'Device passkey'}</small>
                          </span>
                          <button className="bc-account-remove" type="button" onClick={() => removePasskey(passkey.id)} disabled={busy || !passkeyPassword}>Remove</button>
                        </div>
                      )) : (
                        <div className="bc-account-empty">
                          <span className="bc-account-empty-icon" aria-hidden="true">⌁</span>
                          <div><strong>No passkeys yet</strong><small>Add a passkey to make future sign-ins faster and more secure.</small></div>
                        </div>
                      )}
                    </div>
                  </>
                )
              ) : (
                <div className="bc-account-unavailable">
                  <strong>Managed through your BitCider sign-in</strong>
                  <p>Your existing BitCider sign-in is being used for this profile. BitConnection will not change those credentials here.</p>
                </div>
              )}
            </section>
          </div>


          <section className="bc-account-provider-panel" aria-label="Connected music services">
            <div className="bc-account-provider-heading">
              <div>
                <span className="bc-account-panel-kicker">CONNECTED MUSIC SERVICES</span>
                <h2>Apple Music</h2>
                <p>Connect your Apple Music User Media Token for subscriber-backed TTML lyrics and personal recommendation shelves. Deplexo discovers Apple's web-player Bearer automatically, so no separate Apple Developer token is needed.</p>
              </div>
              <span className={'bc-account-provider-state' + (appleMusicStatus?.connected ? ' is-connected' : '')}>
                <i />{appleMusicStatus?.connected ? 'CONNECTED' : 'NOT CONNECTED'}
              </span>
            </div>
            {!appleMusicStatus?.secureStorageConfigured && (
              <div className="bc-account-unavailable">
                <strong>Encrypted provider storage is unavailable</strong>
                <p>Configure the dedicated Deplexo BITCIDER_ENCRYPTION_KEY before saving an Apple Music token.</p>
              </div>
            )}
            {appleMusicStatus?.connected && (
              <div className="bc-account-provider-connected">
                <span className="bc-account-provider-check" aria-hidden="true">✓</span>
                <div><strong>Apple Music account linked</strong><small>{appleMusicStatus.connectedAt ? 'Connected ' + new Date(appleMusicStatus.connectedAt).toLocaleDateString() : 'Your token is stored securely.'} · Token hidden</small></div>
                <button className="bc-account-remove" type="button" onClick={disconnectAppleMusic} disabled={appleMusicBusy}>Disconnect</button>
              </div>
            )}
            <form className="bc-account-provider-form" onSubmit={saveAppleMusicToken}>
              <label>
                <span>{appleMusicStatus?.connected ? 'REPLACE USER MEDIA TOKEN' : 'APPLE MUSIC USER MEDIA TOKEN'}</span>
                <input
                  type="password"
                  value={appleMusicUserToken}
                  onChange={event => setAppleMusicUserToken(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your Apple Music User Media Token"
                  aria-label="Apple Music User Media Token"
                  disabled={!appleMusicStatus?.secureStorageConfigured || appleMusicBusy}
                />
              </label>
              <button className="bc-primary-button" type="submit" disabled={!appleMusicUserToken.trim() || !appleMusicStatus?.secureStorageConfigured || appleMusicBusy}>
                {appleMusicBusy ? 'Saving…' : appleMusicStatus?.connected ? 'Update connection' : 'Connect Apple Music'}
              </button>
            </form>
            <small className="bc-account-provider-footnote">Your token is encrypted on Deplexo and never shown again or stored in browser storage. It is paired with Apple's automatically discovered web-player Bearer for subscriber-only lyrics and recommendation requests. Only connect an account you own.</small>
          </section>

          {error && <div className="bc-account-message is-error" role="alert">{error}</div>}
          {notice && <div className="bc-account-message is-success" role="status">{notice}</div>}

          <footer className="bc-account-footer">
            <span>Changes to your profile and passkeys apply to BitConnection.</span>
            <div>
              {identityMode === 'bitconnection' && <button className="bc-account-signout" type="button" onClick={signOut} disabled={busy}>Sign out</button>}
              <button className="bc-primary-button" type="button" onClick={closeWindow} disabled={busy}>Done</button>
            </div>
          </footer>
        </div>
      )}
      {stage === 'signedout' && (
        <section className="bc-window-state">
          <div className="bc-window-kicker">ACCOUNT SIGNED OUT</div>
          <h1>See you next time.</h1>
          <p>Your BitConnection session has been signed out on this device.</p>
          <button className="bc-primary-button" type="button" onClick={closeWindow}>Close</button>
        </section>
      )}
      {stage === 'error' && (
        <section className="bc-window-state">
          <div className="bc-window-kicker">ACCOUNT UNAVAILABLE</div>
          <h1>Could not load your account.</h1>
          <p>{error}</p>
          <button className="bc-primary-button" type="button" onClick={() => window.location.reload()}>Try again</button>
        </section>
      )}
      {stage !== 'error' && stage !== 'loading' && stage !== 'signedout' && error && stage !== 'manage' && <div className="bc-global-error" role="alert">{error}</div>}
    </main>
  );
}

function JoinPublicPartyWindow({ roomId }) {
  const [csrfToken, setCsrfToken] = useState('');
  const [room, setRoom] = useState(null);
  const [roomState, setRoomState] = useState(null);
  const [stage, setStage] = useState('loading');
  const [error, setError] = useState('');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [hostAudioState, setHostAudioState] = useState('idle');
  const [hostAudioError, setHostAudioError] = useState('');
  const audioRef = useRef(null);
  const sessionRef = useRef(null);
  const transportRef = useRef(null);
  const automaticJoinStartedRef = useRef(false);

  useEffect(() => {
    let active = true;
    async function loadRoom() {
      try {
        const account = await readResponse(await fetch('/api/bitconnection/account', {
          cache: 'no-store', credentials: 'same-origin'
        }), 'Could not prepare a guest session.');
        const directory = await readResponse(await fetch('/api/bitconnection/rooms/public', {
          cache: 'no-store', credentials: 'same-origin'
        }), 'Could not load public parties.');
        const found = (directory.rooms || []).find(item => item.roomId === roomId);
        if (!found) throw new Error('That public party is no longer live.');
        if (!active) return;
        setCsrfToken(account.csrfToken || '');
        setRoom(found);
        setStage('ready');
      } catch (loadError) {
        if (!active) return;
        setError(loadError.message || 'Could not load that party.');
        setStage('error');
      }
    }
    loadRoom();
    return () => { active = false; };
  }, [roomId]);

  useEffect(() => () => {
    const transport = transportRef.current;
    const session = sessionRef.current;
    transportRef.current = null;
    sessionRef.current = null;
    if (transport) void transport.stop({ leave: true });
    else if (session) void session.leave();
  }, []);

  useEffect(() => {
    if (stage !== 'ready' || automaticJoinStartedRef.current) return;
    automaticJoinStartedRef.current = true;
    void joinParty();
  }, [stage]);

  async function joinParty() {
    if (stage !== 'ready') return;
    setStage('joining');
    setError('');
    try {
      const client = new BitConnectionApiClient({ csrfToken });
      const joined = await client.joinRoom({ roomId });
      if (!joined.session) throw new Error('The room did not return a guest connection.');
      sessionRef.current = joined.session;
      setRoom(joined.room || room);
      const transport = await startBitConnectionGuestTransport({
        session: joined.session,
        audioElement: audioRef.current,
        onRoomState: state => {
          setRoomState(state);
          if (state.room) setRoom(state.room);
          if (state.participant?.role) joined.session.role = state.participant.role;
        },
        onAudioPlaybackBlocked: () => setAudioBlocked(true),
        onError: transportError => setError(transportError.message || 'The party connection encountered an error.')
      });
      transportRef.current = transport;
      setStage('connected');
    } catch (joinError) {
      setError(joinError.message || 'Could not join this party.');
      setStage('error');
    }
  }

  async function playAudio() {
    try {
      await transportRef.current?.playAudio();
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
    }
  }
  async function startPromotedHostAudio() {
    const session = sessionRef.current;
    if (!session || hostAudioState === 'requesting' || hostAudioState === 'streaming') return;
    session.role = 'host';
    setHostAudioState('requesting');
    setHostAudioError('');
    // Start the native tab picker before awaiting anything so the click gesture is preserved.
    const startPromise = startBitConnectionHostTransport({
      session,
      onRoomState: state => {
        setRoomState(state);
        if (state.room) setRoom(state.room);
      },
      onError: transportError => setHostAudioError(transportError.message || 'The room connection encountered an error.'),
      onCaptureEnded: () => {
        transportRef.current = null;
        setHostAudioState('idle');
        setHostAudioError('BitChord tab sharing stopped. Start sharing again to resume the room audio.');
      }
    });
    const previousTransport = transportRef.current;
    transportRef.current = null;
    try {
      if (previousTransport) await previousTransport.stop({ leave: false });
      const transport = await startPromise;
      transportRef.current = transport;
      setHostAudioState('streaming');
    } catch (transportError) {
      setHostAudioState('idle');
      setHostAudioError(transportError.message || 'Could not start BitChord tab audio.');
    }
  }

  async function stopPromotedHostAudio() {
    const transport = transportRef.current;
    transportRef.current = null;
    if (transport) await transport.stop({ leave: false });
    setHostAudioState('idle');
  }


  async function leaveParty() {
    const transport = transportRef.current;
    const session = sessionRef.current;
    transportRef.current = null;
    sessionRef.current = null;
    if (transport) await transport.stop({ leave: true });
    else if (session) await session.leave().catch(() => {});
    window.close();
    window.setTimeout(() => {
      if (!window.closed) window.location.assign('/bitconnection/');
    }, 120);
  }

  const playback = roomState?.playbackState;
  return (
    <main className="bc-window-shell bc-join-window">
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
      <audio ref={audioRef} autoPlay playsInline className="bc-party-audio-output" />
      {stage === 'connected' && room && roomState && sessionRef.current && (
        <PartyRoomExperience
          room={room}
          roomState={roomState}
          session={sessionRef.current}
          role="guest"
          onRoomState={setRoomState}
          onLeave={leaveParty}
          audioRef={audioRef}
          hostAudioState={hostAudioState}
          hostAudioError={hostAudioError}
          onStartHostAudio={startPromotedHostAudio}
          onStopHostAudio={stopPromotedHostAudio}
          audioBlocked={audioBlocked}
          onResumeAudio={playAudio}
        />
      )}
      {stage !== 'connected' && <section className="bc-window-state">
        <div className="bc-window-kicker">{stage === 'connected' ? 'CONNECTED TO PUBLIC PARTY' : 'PUBLIC LISTENING PARTY'}</div>
        <h1>{room?.roomName || (stage === 'loading' ? 'Finding the party…' : 'Join the party.')}</h1>
        {room && <p>Hosted by <strong>{room.hostUsername}</strong> · {room.participantCount || roomState?.participants?.length || 0} / {room.partySize} people</p>}
        {stage === 'ready' && <p>Joining the public party…</p>}
        {stage === 'joining' && <p>Connecting to the room and preparing audio…</p>}
        {stage === 'connected' && (
          <>
            <div className="bc-party-playback">
              <span>{playback?.isPlaying ? 'NOW PLAYING' : 'WAITING FOR PLAYBACK'}</span>
              <strong>{playback?.track?.title || 'Waiting for the host to share BitChord audio'}</strong>
              {playback?.track?.artist && <small>{playback.track.artist}</small>}
            </div>
            <p>Your guest connection is active. Audio plays directly from the host through WebRTC.</p>
            {audioBlocked && <button className="bc-primary-button" type="button" onClick={playAudio}>Play party audio</button>}
          </>
        )}
        {stage === 'loading' && <span className="bc-loading-orbit" />}
        {error && <div className="bc-form-error" role="alert">{error}</div>}
        {(stage === 'error' || stage === 'ready' || stage === 'connected') && (
          <div className="bc-window-actions"><button className="bc-secondary-button" type="button" onClick={leaveParty}>{stage === 'connected' ? 'Leave party' : 'Close'}</button></div>
        )}
      </section>}
    </main>
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
  const [ownerOnlyControls, setOwnerOnlyControls] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdRoom, setCreatedRoom] = useState(null);
  const [hostSession, setHostSession] = useState(null);
  const [roomState, setRoomState] = useState(null);
  const [hostAudioState, setHostAudioState] = useState('idle');
  const [hostAudioError, setHostAudioError] = useState('');
  const hostTransportRef = useRef(null);
  const hostPlayerRef = useRef(null);
  const hostStreamEngineRef = useRef(null);
  const hostAudioModeRef = useRef('tab');
  const appleMusicPlayerRef = useRef(null);
  const appleMusicUnsubscribeRef = useRef(null);
  const [appleMusicPlaybackStatus, setAppleMusicPlaybackStatus] = useState('checking');
  const [appleMusicPlaybackError, setAppleMusicPlaybackError] = useState('');
  const [appleMusicPlayback, setAppleMusicPlayback] = useState(null);

  useEffect(() => () => {
    const transport = hostTransportRef.current;
    const session = hostSession;
    const streamEngine = hostStreamEngineRef.current;
    hostTransportRef.current = null;
    hostStreamEngineRef.current = null;
    if (streamEngine) void streamEngine.destroy().catch(() => {});
    if (transport) void transport.stop({ leave: true });
    else if (session) void session.leave().catch(() => {});
  }, [hostSession]);

  useEffect(() => {
    if (roomState?.participant?.role === 'host' || !hostTransportRef.current) return;
    const transport = hostTransportRef.current;
    hostTransportRef.current = null;
    void transport.stop({ leave: false });
    setHostAudioState('idle');
  }, [roomState?.participant?.role]);

  useEffect(() => {
    let active = true;
    appleMusicPlayerRef.current = null;
    appleMusicUnsubscribeRef.current?.();
    appleMusicUnsubscribeRef.current = null;
    setAppleMusicPlaybackStatus('checking');
    setAppleMusicPlaybackError('');

    async function prepareMusicKit() {
      if (!account?.authenticated) {
        setAppleMusicPlaybackStatus('unavailable');
        setAppleMusicPlaybackError('Sign in to BitAccount Center to initialize direct Apple Music playback.');
        return;
      }
      try {
        const response = await fetch('/api/bitconnection/account/providers/apple-music/playback-config', {
          headers: identityHeaders(identityMode, account),
          credentials: 'same-origin',
          cache: 'no-store'
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.message || 'Direct Apple Music playback is not configured on Deplexo.');
        }
        const music = await getMusicKitPlayer(payload);
        if (!active) return;
        appleMusicPlayerRef.current = music;
        appleMusicUnsubscribeRef.current = subscribeAppleMusicPlayback(music, () => {
          setAppleMusicPlayback(musicKitPlaybackSnapshot(music));
        });
        setAppleMusicPlaybackStatus('ready');
      } catch (error) {
        if (!active) return;
        setAppleMusicPlaybackStatus('unavailable');
        setAppleMusicPlaybackError(error.message || 'Could not initialize Apple MusicKit.');
      }
    }

    void prepareMusicKit();
    return () => {
      active = false;
      appleMusicUnsubscribeRef.current?.();
      appleMusicUnsubscribeRef.current = null;
      appleMusicPlayerRef.current = null;
    };
  }, [account?.authenticated, account?.csrfToken, identityMode]);

  useEffect(() => {
    const player = hostPlayerRef.current;
    if (!player || !hostSession) return undefined;
    const handleEnded = async () => {
      try {
        await hostSession.updatePlayback({ isPlaying: false, positionSeconds: Number(player.duration || player.currentTime || 0) });
        setRoomState(await hostSession.getState());
      } catch (error) {
        setHostAudioError(error.message || 'Could not sync the end of the BitMono track.');
      }
    };
    player.addEventListener('ended', handleEnded);
    return () => player.removeEventListener('ended', handleEnded);
  }, [hostSession, stage]);

  async function publishAppleMusicPlayback(snapshot) {
    if (!hostSession || hostSession.role !== 'host' || !snapshot?.track?.id) return null;
    const track = normalizeAppleCatalogTrack({
      id: snapshot.track.id,
      title: snapshot.track.title,
      artist: snapshot.track.artist,
      album: snapshot.track.album,
      artworkUrl: snapshot.track.artworkUrl,
      durationSeconds: snapshot.durationSeconds
    });
    const result = await hostSession.updatePlayback({
      source: 'apple-music',
      track,
      isPlaying: Boolean(snapshot.isPlaying),
      positionSeconds: Math.max(0, Number(snapshot.positionSeconds) || 0)
    });
    setRoomState(await hostSession.getState());
    return result;
  }

  async function playAppleMusicTrack(item) {
    const music = appleMusicPlayerRef.current;
    if (!music || appleMusicPlaybackStatus !== 'ready') {
      throw new Error(appleMusicPlaybackError || 'Direct Apple Music playback is not ready. Check the MusicKit developer token configured on Deplexo.');
    }
    const track = normalizeAppleCatalogTrack(item);
    // authorize() is invoked from the user's Play button gesture. MusicKit
    // owns the subscriber authorization and FairPlay playback session.
    await music.authorize();
    await music.setQueue(musicKitQueueDescriptor(track));
    await music.play();
    const snapshot = musicKitPlaybackSnapshot(music);
    setAppleMusicPlayback(snapshot);
    await publishAppleMusicPlayback({
      ...snapshot,
      track: snapshot.track || {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        artworkUrl: track.artworkUrl
      },
      durationSeconds: snapshot.durationSeconds || track.durationSeconds
    });
    if (!hostTransportRef.current) {
      setHostAudioError('Apple Music is playing on this device. Start tab-audio sharing to send it to party guests.');
    } else {
      setHostAudioError('');
    }
    return snapshot;
  }

  async function controlAppleMusic(action) {
    const music = appleMusicPlayerRef.current;
    if (!music) throw new Error('Apple Music playback has not been initialized.');
    const snapshot = musicKitPlaybackSnapshot(music);
    const actualAction = action === 'toggle' ? (snapshot.isPlaying ? 'pause' : 'play') : action;
    const next = await controlMusicKitPlayback(music, actualAction);
    setAppleMusicPlayback(next);
    await publishAppleMusicPlayback(next);
    return next;
  }

  async function seekAppleMusic(positionSeconds) {
    const music = appleMusicPlayerRef.current;
    if (!music) throw new Error('Apple Music playback has not been initialized.');
    const next = await controlMusicKitPlayback(music, 'seek', positionSeconds);
    setAppleMusicPlayback(next);
    await publishAppleMusicPlayback(next);
    return next;
  }

  async function loadAccount(mode = 'bitconnection') {
    const headers = mode === 'bitcider' ? { 'X-BitConnection-Identity': 'bitcider' } : {};
    const payload = await readResponse(await fetch('/api/bitconnection/account', {
      headers, cache: 'no-store', credentials: 'same-origin'
    }), 'Could not load account information.');
    setAccount(payload);
    setProfile(payload.profile || null);
    setPartySize(Math.min(4, payload.maxPartySize || 30));
    setIdentityMode(mode);
    return payload;
  }

  useEffect(() => {
    let active = true;
    fetch('/api/bitconnection/account', { cache: 'no-store', credentials: 'same-origin' })
      .then(response => readResponse(response, 'Could not load account information.'))
      .then(async payload => {
        if (!active) return;
        setAccount(payload);
        setProfile(payload.profile || null);
        setPartySize(Math.min(4, payload.maxPartySize || 30));
        if (payload.authenticated) {
          setIdentityMode('bitconnection');
          setStage(payload.profile?.username ? 'room' : 'profile');
          return;
        }
        if (payload.bitCiderAccountAvailable) {
          const ciderAccount = await loadAccount('bitcider');
          if (!active) return;
          if (!ciderAccount.authenticated) {
            throw new Error('A BitCider account was detected, but automatic sign-in could not be completed. Sign in to BitCider and reopen BitConnection.');
          }
          setStage(ciderAccount.profile?.username ? 'room' : 'profile');
          return;
        }
        setStage('auth');
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
    const requestedPartySize = Number(partySize);
    if (!Number.isSafeInteger(requestedPartySize) || requestedPartySize < 2 || requestedPartySize > 30) {
      setError('Enter a party size between 2 and 30 people.');
      return;
    }
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
        body: JSON.stringify({ roomName, visibility, partySize: requestedPartySize, ownerOnlyControls })
      });
      const payload = await readResponse(response, 'Could not create the room.');
      const client = new BitConnectionApiClient({
        csrfToken: identityMode === 'bitconnection' ? account?.csrfToken : '',
        identityMode,
        ciderCsrfToken: identityMode === 'bitcider' ? account?.csrfToken : ''
      });
      const session = client.createHostSession(payload);
      const initialState = await session.getState();
      setCreatedRoom(payload);
      setHostSession(session);
      setRoomState(initialState);
      setStage('created');
    } catch (createError) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setError(createError.message || 'Could not create the room.');
    } finally {
      setBusy(false);
    }
  }

  async function startHostAudio() {
    if (!createdRoom?.room?.roomId || !hostSession || hostAudioState === 'requesting' || hostTransportRef.current) return;
    setHostAudioState('requesting');
    setHostAudioError('');
    try {
      const transport = await startBitConnectionHostTransport({
        session: hostSession,
        onRoomState: setRoomState,
        onError: transportError => setHostAudioError(transportError.message || 'The room connection encountered an error.'),
        onCaptureEnded: () => {
          hostTransportRef.current = null;
          setHostAudioState('idle');
          setHostAudioError('BitChord tab sharing stopped. Start sharing again to resume the room audio.');
        }
      });
      hostTransportRef.current = transport;
      setHostAudioState('streaming');
    } catch (transportError) {
      setHostAudioState('idle');
      setHostAudioError(transportError.message || 'Could not start BitChord tab audio.');
    }
  }



  async function playBitMonoTrack(track, streamUrl, mimeType = '') {
    if (!hostSession || hostSession.role !== 'host') throw new Error('Only the host can start a Bit Mono stream.');
    if (!track?.trackId || !String(streamUrl || '').startsWith('/bitmono/audio/')) throw new Error('The Bit Mono stream is not ready yet.');
    const player = hostPlayerRef.current;
    if (!player) throw new Error('The party audio player is not ready.');
    const cleanTrack = {
      source: 'bitmono',
      trackId: String(track.trackId),
      title: String(track.title || '').slice(0, 180),
      artist: String(track.artist || '').slice(0, 180),
      durationSeconds: Number(track.durationSeconds || 0),
      ...(track.thumbnailUrl ? { thumbnailUrl: String(track.thumbnailUrl) } : {}),
      ...(track.audioQuality ? { audioQuality: String(track.audioQuality).slice(0, 40) } : {}),
      ...( /^[0-9]{1,20}$/.test(String(track.appleMusicSongId || '')) ? { appleMusicSongId: String(track.appleMusicSongId) } : {}),
      ...( /^[a-z]{2}$/.test(String(track.appleMusicStorefront || '').toLowerCase()) ? { appleMusicStorefront: String(track.appleMusicStorefront).toLowerCase() } : {})
    };
    if (!cleanTrack.title || !cleanTrack.artist || !Number.isFinite(cleanTrack.durationSeconds) || cleanTrack.durationSeconds <= 0) {
      throw new Error('The Bit Mono result is missing valid track metadata.');
    }

    setHostAudioError('');
    player.pause();
    await hostStreamEngineRef.current?.destroy?.();
    hostStreamEngineRef.current = null;
    const streamEngine = await attachBitCiderStream(player, streamUrl, {
      mimeType: mimeType || track.mimeType || track.contentType || '',
      onError: streamError => setHostAudioError(streamError.message || 'The HLS stream encountered an error.')
    });
    hostStreamEngineRef.current = streamEngine;
    const playPromise = player.play();
    let startedNewTransport = false;
    let transportPromise = Promise.resolve(hostTransportRef.current);
    if (!hostTransportRef.current || hostAudioModeRef.current !== 'bitmono') {
      if (hostTransportRef.current) {
        const old = hostTransportRef.current;
        hostTransportRef.current = null;
        await old.stop({ leave: false });
      }
      startedNewTransport = true;
      setHostAudioState('requesting');
      transportPromise = playPromise.then(async () => {
        const transport = await startBitConnectionHostMediaTransport({
          session: hostSession,
          audioElement: player,
          onRoomState: setRoomState,
          onError: transportError => setHostAudioError(transportError.message || 'The room audio connection encountered an error.')
        });
        hostTransportRef.current = transport;
        return transport;
      });
    }

    try {
      await Promise.all([transportPromise, playPromise]);
      hostAudioModeRef.current = 'bitmono';
      setHostAudioState('streaming');
      const result = await hostSession.updatePlayback({
        source: 'bitmono', track: cleanTrack, isPlaying: true, positionSeconds: 0
      });
      setRoomState(await hostSession.getState());
      return result;
    } catch (error) {
      if (startedNewTransport && hostTransportRef.current) {
        const failedTransport = hostTransportRef.current;
        hostTransportRef.current = null;
        await failedTransport.stop({ leave: false }).catch(() => {});
      }
      if (startedNewTransport) hostAudioModeRef.current = 'tab';
      const failedStreamEngine = hostStreamEngineRef.current;
      hostStreamEngineRef.current = null;
      if (failedStreamEngine) await failedStreamEngine.destroy().catch(() => {});
      player.pause();
      setHostAudioState('idle');
      setHostAudioError(error.message || 'Could not start Bit Mono audio for the party.');
      throw error;
    }
  }

  async function controlBitMonoPlayback(action) {
    const player = hostPlayerRef.current;
    if (!player || hostAudioModeRef.current !== 'bitmono') return;
    if (action === 'toggle') {
      if (player.paused) await player.play();
      else player.pause();
      await hostSession?.updatePlayback?.({ isPlaying: !player.paused, positionSeconds: player.currentTime || 0 });
    } else if (action === 'pause') {
      player.pause();
      await hostSession?.updatePlayback?.({ isPlaying: false, positionSeconds: player.currentTime || 0 });
    } else if (action === 'play') {
      await player.play();
      await hostSession?.updatePlayback?.({ isPlaying: true, positionSeconds: player.currentTime || 0 });
    }
    setRoomState(await hostSession.getState());
  }

  async function seekBitMonoPlayback(positionSeconds) {
    const player = hostPlayerRef.current;
    if (!player || hostAudioModeRef.current !== 'bitmono') return;
    const next = Math.max(0, Math.min(Number(player.duration || 86400), Number(positionSeconds) || 0));
    player.currentTime = next;
    await hostSession?.updatePlayback?.({ positionSeconds: next, isPlaying: !player.paused });
    setRoomState(await hostSession.getState());
  }

  async function stopHostAudio() {
    const transport = hostTransportRef.current;
    hostTransportRef.current = null;
    if (transport) await transport.stop({ leave: false });
    const player = hostPlayerRef.current;
    if (player) {
      const positionSeconds = Number(player.currentTime || 0);
      await hostStreamEngineRef.current?.destroy?.();
      hostStreamEngineRef.current = null;
      player.pause();
      player.removeAttribute('src');
      player.load();
      await hostSession?.updatePlayback?.({ isPlaying: false, positionSeconds });
      if (hostSession?.getState) setRoomState(await hostSession.getState());
    }
    hostAudioModeRef.current = 'tab';
    setHostAudioState('idle');
  }

  async function leaveCreatedRoom() {
    const transport = hostTransportRef.current;
    const session = hostSession;
    hostTransportRef.current = null;
    const player = hostPlayerRef.current;
    if (player) {
      await hostStreamEngineRef.current?.destroy?.();
      hostStreamEngineRef.current = null;
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
    hostAudioModeRef.current = 'tab';
    if (transport) await transport.stop({ leave: true });
    else if (session) await session.leave().catch(() => {});
    closeWindow();
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
      {stage === 'loading' && <section className="bc-window-state"><span className="bc-loading-orbit" /><p>Connecting to Deplexo…</p></section>}

      {stage === 'auth' && account && (
        <AccountAuth
          account={account}
          initialMode="register"
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
          onBack={async () => {
            if (identityMode === 'bitcider') {
              try {
                await refreshIndependentAccount();
                setStage('auth');
              } catch (backError) {
                setError(backError.message || 'Could not switch to BitConnection account setup.');
              }
            } else {
              setStage('auth');
            }
          }}
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
            <legend><span className="bc-field-label">PARTY VISIBILITY</span></legend>
            <div className={`bc-visibility-switch is-${visibility}`}>
              <span className="bc-visibility-thumb" />
              <button type="button" aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}>Public</button>
              <button type="button" aria-pressed={visibility === 'private'} onClick={() => setVisibility('private')}>Private</button>
            </div>
            <small className="bc-field-hint">{visibility === 'public' ? 'Anyone can discover and join.' : 'Guests need an invitation link or QR code.'}</small>
          </fieldset>
          <label className="bc-field-card">
            <span className="bc-field-label">PARTY SIZE <small>2–30 PEOPLE MAX</small></span>
            <input
              type="number"
              inputMode="numeric"
              min="2"
              max="30"
              step="1"
              value={partySize}
              onChange={event => setPartySize(event.target.value)}
              placeholder="Enter the number of people"
              required
            />
            <small className="bc-field-hint">Enter how many people can join this room, including you.</small>
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
            <button className="bc-primary-button" type="submit" disabled={busy || !roomName.trim() || !Number.isSafeInteger(Number(partySize)) || Number(partySize) < 2 || Number(partySize) > 30}>{busy ? 'Creating…' : 'Create room'}</button>
          </div>
        </form>
      )}

      {stage === 'created' && createdRoom && hostSession && roomState && (
        <>
        <audio ref={hostPlayerRef} className="bc-party-audio-output" preload="none" />
        <PartyRoomExperience
          room={createdRoom.room}
          roomState={roomState}
          session={hostSession}
          role="host"
          onRoomState={setRoomState}
          onLeave={leaveCreatedRoom}
          hostAudioState={hostAudioState}
          hostAudioError={hostAudioError}
          onStartHostAudio={startHostAudio}
          onStopHostAudio={stopHostAudio}
          onPlayBitMonoTrack={playBitMonoTrack}
          onControlBitMono={controlBitMonoPlayback}
          onSeekBitMono={seekBitMonoPlayback}
          onPlayAppleMusicTrack={playAppleMusicTrack}
          onControlAppleMusic={controlAppleMusic}
          onSeekAppleMusic={seekAppleMusic}
        />
        </>
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
  const [adminConsoleOpen, setAdminConsoleOpen] = useState(() => new URLSearchParams(window.location.search).get('admin') === '1');
  const [adminBootstrapCode, setAdminBootstrapCode] = useState('');
  const [apiState, setApiState] = useState('checking');
  const [accountAvailable, setAccountAvailable] = useState(false);
  const [accountAvatarUrl, setAccountAvatarUrl] = useState('');
  const [entryStage, setEntryStage] = useState(initialEntryStage);
  const flameRunAnimationRef = useRef(null);
  const burnMaskAnimationRef = useRef(null);
  const burnGlowAnimationRef = useRef(null);
  const burnCoreAnimationRef = useRef(null);
  const burnHotAnimationRef = useRef(null);
  const routeParams = new URLSearchParams(window.location.search);
  const isCreateWindow = routeParams.get('create') === '1';
  const isAccountWindow = routeParams.get('account') === '1';
  const joinRoomId = routeParams.get('join') || '';
  const [publicParties, setPublicParties] = useState([]);
  const [partySearch, setPartySearch] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [partyDirectoryLoading, setPartyDirectoryLoading] = useState(true);
  const [partySearchLoading, setPartySearchLoading] = useState(false);
  const [partyDirectoryError, setPartyDirectoryError] = useState('');
  const [partyServiceCopied, setPartyServiceCopied] = useState(false);
  const partyServiceUrl = 'https://bitcider.de.deplexo.com/party';

  async function copyPartyServiceUrl() {
    try {
      await navigator.clipboard.writeText(partyServiceUrl);
      setPartyServiceCopied(true);
      window.setTimeout(() => setPartyServiceCopied(false), 1800);
    } catch {
      setPartyServiceCopied(false);
    }
  }

  useEffect(() => {
    function openAdminConsole(event) {
      setAdminBootstrapCode(typeof event?.detail?.code === 'string' ? event.detail.code : '');
      setAdminConsoleOpen(true);
    }
    const helper = Object.freeze({
      open() {
        window.dispatchEvent(new CustomEvent('bitcider-admin-open'));
        return 'Opening the protected BitCider admin console.';
      },
      bootstrap(code) {
        if (typeof code !== 'string' || code.length < 1) {
          return 'Provide the one-time BITCIDER_ADMIN_BOOTSTRAP_CODE value.';
        }
        window.dispatchEvent(new CustomEvent('bitcider-admin-open', { detail: { code } }));
        return 'Bootstrap request opened. The code is kept in page memory and is only used for first-owner passkey enrollment.';
      }
    });
    const previousHelper = window.bitciderAdmin;
    window.bitciderAdmin = helper;
    window.addEventListener('bitcider-admin-open', openAdminConsole);
    return () => {
      window.removeEventListener('bitcider-admin-open', openAdminConsole);
      if (window.bitciderAdmin === helper) {
        if (previousHelper === undefined) delete window.bitciderAdmin;
        else window.bitciderAdmin = previousHelper;
      }
    };
  }, []);

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
    if (isCreateWindow || isAccountWindow || joinRoomId) return undefined;
    let active = true;
    async function refreshAccountAvailability() {
      try {
        const payload = await readResponse(await fetch('/api/bitconnection/account', {
          cache: 'no-store', credentials: 'same-origin'
        }), 'Could not check account availability.');
        // Match BitAccount identity precedence: an active BitCider login
        // is used before an independent BitConnection session.
        let activeIdentity = payload;
        if (payload.bitCiderAccountAvailable) {
          activeIdentity = await readResponse(await fetch('/api/bitconnection/account', {
            headers: { 'X-BitConnection-Identity': 'bitcider' },
            cache: 'no-store', credentials: 'same-origin'
          }), 'Could not load the signed-in BitCider profile.');
        }
        if (!active) return;
        const signedIn = Boolean(activeIdentity.authenticated);
        setAccountAvailable(signedIn);
        setAccountAvatarUrl(signedIn && typeof activeIdentity.profile?.avatarDataUrl === 'string'
          ? activeIdentity.profile.avatarDataUrl
          : '');
      } catch {
        if (active) {
          setAccountAvailable(false);
          setAccountAvatarUrl('');
        }
      }
    }
    refreshAccountAvailability();
    const timer = window.setInterval(refreshAccountAvailability, 15000);
    const refreshOnFocus = () => refreshAccountAvailability();
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [isCreateWindow, isAccountWindow, joinRoomId]);

  useEffect(() => {
    if (isCreateWindow || isAccountWindow || joinRoomId) return undefined;
    let active = true;
    async function refreshPublicParties() {
      try {
        const payload = await readResponse(await fetch('/api/bitconnection/rooms/public', {
          cache: 'no-store', credentials: 'same-origin'
        }), 'Could not load public parties.');
        if (!active) return;
        setPublicParties(payload.rooms || []);
        setPartyDirectoryError('');
      } catch (directoryError) {
        if (!active) return;
        setPartyDirectoryError(directoryError.message || 'Public parties are unavailable.');
      } finally {
        if (active) setPartyDirectoryLoading(false);
      }
    }
    refreshPublicParties();
    const timer = window.setInterval(refreshPublicParties, 20000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isCreateWindow, isAccountWindow, joinRoomId]);

  useEffect(() => {
    if (isCreateWindow || isAccountWindow || joinRoomId) return undefined;
    const query = partySearch.trim();
    if (!query) {
      setSearchResults(null);
      setPartySearchLoading(false);
      return undefined;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      setPartySearchLoading(true);
      try {
        const payload = await readResponse(await fetch('/api/bitconnection/rooms/public?q=' + encodeURIComponent(query), {
          cache: 'no-store', credentials: 'same-origin'
        }), 'Could not search public parties.');
        if (active) setSearchResults(payload.rooms || []);
      } catch (searchError) {
        if (active) setSearchResults([]);
      } finally {
        if (active) setPartySearchLoading(false);
      }
    }, 260);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [partySearch, isCreateWindow, isAccountWindow, joinRoomId]);

  useEffect(() => {
    // One effect owns the entire entry sequence. Do not depend on entryStage:
    // changing to "holding" would otherwise run cleanup and cancel the burn timers.
    if (initialEntryStage !== 'searching') return undefined;
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
      try {
        flameRunAnimationRef.current?.beginElement?.();
      } catch {
        // CSS still keeps the fire visible if SVG motion is unavailable.
      }
      timers.push(window.setTimeout(() => setEntryStage('holding'), 5200));
      timers.push(window.setTimeout(() => setEntryStage('burning'), 7200));
      timers.push(window.setTimeout(() => setEntryStage('idle'), 8850));
    };
    waitForPage();
    return () => {
      cancelled = true;
      timers.forEach(timer => window.clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    if (entryStage !== 'burning') return;
    [burnMaskAnimationRef, burnGlowAnimationRef, burnCoreAnimationRef, burnHotAnimationRef].forEach(animationRef => {
      try {
        animationRef.current?.beginElement?.();
      } catch {
        // The cover still clears when reduced-motion or an older SVG engine skips SMIL.
      }
    });
  }, [entryStage]);

  if (isCreateWindow) return <CreateRoomWindow />;
  if (isAccountWindow) return <AccountManagementWindow />;
  if (joinRoomId) return <JoinPublicPartyWindow roomId={joinRoomId} />;

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
          <img className="bitconnection-logo" src="/bitconnection/connection_favicon.svg?v=bc-favicon-64-v2" alt="" aria-hidden="true" />
          <span>BitConnection</span>
        </a>
        {accountAvailable && (
          <button className="bitconnection-account-button" type="button" onClick={openAccountWindow} aria-label="Manage account" title="Manage account">
            {accountAvatarUrl
              ? <img className="bitconnection-account-avatar" src={accountAvatarUrl} alt="" aria-hidden="true" />
              : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.4" /><path d="M4.7 20a7.3 7.3 0 0 1 14.6 0" /></svg>}
            <span>Account</span>
          </button>
        )}
      </header>
      <div className="bitconnection-layout">
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
      <aside className="bitconnection-discovery" aria-label="Public listening parties">
        <section className="bc-party-service-card" aria-label="BitChord party service URL">
          <strong>BitConnection URL</strong>
          <p>Paste this address into BitChord to connect.</p>
          <div className="bc-party-service-url">
            <code>{partyServiceUrl}</code>
            <button type="button" onClick={copyPartyServiceUrl} aria-label="Copy BitConnection party service URL">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>
              {partyServiceCopied ? 'Copied' : 'Copy URL'}
            </button>
          </div>
        </section>
        <div className="bc-discovery-heading">
          <div className="bitconnection-eyebrow"><span /> LIVE DISCOVERY</div>
          <h2>More happening now</h2>
        </div>
        <div className="bc-party-search-shell">
          <label className="bc-party-search">
            <span>SEARCH PUBLIC PARTIES</span>
            <div>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.2 4.2" /></svg>
              <input type="search" value={partySearch} onChange={event => setPartySearch(event.target.value)} placeholder="Search rooms, hosts, or songs" />
            </div>
          </label>
        </div>
        <div className="bc-discovery-results" aria-live="polite">
          <div className="bc-discovery-results-heading">{partySearch.trim() ? 'SEARCH RESULTS' : 'DISCOVERABLE PARTIES'}</div>
          {partySearch.trim() && partySearchLoading ? (
            <div className="bc-public-empty">Searching live rooms…</div>
          ) : (partySearch.trim() ? searchResults : publicParties)?.length ? (
            (partySearch.trim() ? searchResults : publicParties).map(room => (
              <PublicPartyCard key={room.roomId} room={room} onJoin={openJoinWindow} />
            ))
          ) : (
            <div className="bc-public-empty">
              {partySearch.trim()
                ? 'No matching public parties found.'
                : partyDirectoryError
                  ? partyDirectoryError
                  : partyDirectoryLoading
                    ? 'Finding discoverable parties…'
                    : 'No public parties are live right now.'}
            </div>
          )}
        </div>
      </aside>
      </div>
      <footer className="bitconnection-footer">
        <span>BITCONNECTION</span>
        <span>ONE ROOM · ONE MOMENT</span>
      </footer>
      {entryStage !== 'idle' && (
        <div className={`bitconnection-entry-cover is-${entryStage}`} aria-hidden="true">
          <svg className="bitconnection-burn-field" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" focusable="false">
            <defs>
              <linearGradient id="bitconnection-fire-edge" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#fff6b0" />
                <stop offset=".2" stopColor="#ffd35a" />
                <stop offset=".48" stopColor="#ff6a20" />
                <stop offset=".76" stopColor="#e92712" />
                <stop offset="1" stopColor="#7d120d" />
              </linearGradient>
              <filter id="bitconnection-burn-distortion" filterUnits="userSpaceOnUse" x="-80" y="-80" width="1160" height="1160">
                <feTurbulence type="fractalNoise" baseFrequency=".024 .07" numOctaves="2" seed="13" result="burnNoise">
                  <animate attributeName="baseFrequency" values=".024 .07;.048 .13;.024 .07" dur=".46s" repeatCount="indefinite" />
                </feTurbulence>
                <feDisplacementMap in="SourceGraphic" in2="burnNoise" scale="28" xChannelSelector="R" yChannelSelector="G" />
              </filter>
              <filter id="bitconnection-fire-glow" x="-70%" y="-70%" width="240%" height="240%">
                <feGaussianBlur stdDeviation="22" result="soft" />
                <feMerge>
                  <feMergeNode in="soft" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <mask id="bitconnection-burn-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000">
                <rect x="0" y="0" width="1000" height="1000" fill="white" />
                <circle cx="500" cy="500" r="0" fill="black" filter="url(#bitconnection-burn-distortion)">
                  <animate
                    ref={burnMaskAnimationRef}
                    attributeName="r"
                    values="0;180;480;760;1040"
                    keyTimes="0;.22;.52;.8;1"
                    dur="1.65s"
                    begin="indefinite"
                    fill="freeze"
                    calcMode="spline"
                    keySplines=".18 .72 .22 1;.18 .72 .22 1;.18 .72 .22 1;.18 .72 .22 1"
                  />
                </circle>
              </mask>
            </defs>

            <rect className="bitconnection-burn-blackness" width="1000" height="1000" fill="#020102" mask="url(#bitconnection-burn-mask)" />

            <g className="bitconnection-burn-front">
              <circle className="bitconnection-burn-halo" cx="500" cy="500" r="0" fill="none" stroke="#ed2c10" strokeWidth="108" filter="url(#bitconnection-fire-glow)">
                <animate ref={burnGlowAnimationRef} attributeName="r" from="0" to="920" dur="1.65s" begin="indefinite" fill="freeze" />
              </circle>
              <circle className="bitconnection-burn-orange" cx="500" cy="500" r="0" fill="none" stroke="#ff4a16" strokeWidth="55" filter="url(#bitconnection-burn-distortion)">
                <animate ref={burnCoreAnimationRef} attributeName="r" from="0" to="920" dur="1.65s" begin="indefinite" fill="freeze" />
              </circle>
              <circle className="bitconnection-burn-hot" cx="500" cy="500" r="0" fill="none" stroke="url(#bitconnection-fire-edge)" strokeWidth="18" filter="url(#bitconnection-burn-distortion)">
                <animate ref={burnHotAnimationRef} attributeName="r" from="0" to="920" dur="1.65s" begin="indefinite" fill="freeze" />
              </circle>

              <g className="bitconnection-burn-tongues">
                <path d="M500 238 C456 194 480 145 520 92 C558 148 548 197 500 238Z" />
                <path transform="rotate(45 500 500)" d="M500 238 C456 194 480 145 520 92 C558 148 548 197 500 238Z" />
                <path transform="rotate(90 500 500)" d="M500 238 C456 194 480 145 520 92 C558 148 548 197 500 238Z" />
                <path transform="rotate(135 500 500)" d="M500 238 C456 194 480 145 520 92 C558 148 548 197 500 238Z" />
                <path transform="rotate(180 500 500)" d="M500 238 C456 194 480 145 520 92 C558 148 548 197 500 238Z" />
                <path transform="rotate(225 500 500)" d="M500 238 C456 194 480 145 520 92 C558 148 548 197 500 238Z" />
                <path transform="rotate(270 500 500)" d="M500 238 C456 194 480 145 520 92 C558 148 548 197 500 238Z" />
                <path transform="rotate(315 500 500)" d="M500 238 C456 194 480 145 520 92 C558 148 548 197 500 238Z" />
              </g>
            </g>
          </svg>

          <div className="bitconnection-flame-wrap">
            <svg className="bitconnection-entry-flame" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" focusable="false">
              <defs>
                <linearGradient id="bitconnection-flame-shell" x1=".5" y1="1" x2=".5" y2="0">
                  <stop offset="0" stopColor="#a9150d" />
                  <stop offset=".28" stopColor="#f03a12" />
                  <stop offset=".62" stopColor="#ff8425" />
                  <stop offset="1" stopColor="#ffd85b" />
                </linearGradient>
                <linearGradient id="bitconnection-flame-lobe" x1="0" y1="1" x2="1" y2="0">
                  <stop offset="0" stopColor="#ff3214" />
                  <stop offset=".52" stopColor="#ff8a27" />
                  <stop offset="1" stopColor="#ffe88b" />
                </linearGradient>
                <radialGradient id="bitconnection-flame-core" cx=".5" cy=".68" r=".58">
                  <stop offset="0" stopColor="#fffde2" />
                  <stop offset=".34" stopColor="#fff2a0" />
                  <stop offset=".72" stopColor="#ffbd43" />
                  <stop offset="1" stopColor="#ff5a19" stopOpacity=".1" />
                </radialGradient>
                <filter id="bitconnection-flame-warp" x="-30%" y="-25%" width="160%" height="160%">
                  <feTurbulence type="fractalNoise" baseFrequency=".018 .035" numOctaves="2" seed="7" result="flameNoise">
                    <animate attributeName="baseFrequency" values=".018 .035;.032 .075;.018 .035" dur=".38s" repeatCount="indefinite" />
                  </feTurbulence>
                  <feDisplacementMap in="SourceGraphic" in2="flameNoise" scale="12" xChannelSelector="R" yChannelSelector="G" />
                </filter>
                <filter id="bitconnection-flame-soft-glow" x="-50%" y="-45%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="11" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <g className="bitconnection-flame-travel" transform="translate(432 416)">
                <animateTransform
                  ref={flameRunAnimationRef}
                  attributeName="transform"
                  type="translate"
                  values="-220 416;1030 416;-220 416;432 416"
                  keyTimes="0;.34;.68;1"
                  dur="5.2s"
                  begin="indefinite"
                  fill="freeze"
                  calcMode="spline"
                  keySplines=".35 0 .65 1;.35 0 .65 1;.32 0 .68 1"
                />
                <g transform="scale(.55)">
                  <g className="bitconnection-flame-warp">
                    <path className="bitconnection-flame-outer" filter="url(#bitconnection-flame-warp)" d="M130 12 C151 53 194 69 190 119 C225 159 217 222 181 263 C154 294 105 300 72 274 C29 241 23 183 51 143 C65 119 87 104 91 69 C109 88 118 111 121 130 C145 95 137 49 130 12Z" />
                    <path className="bitconnection-flame-tongue tongue-a" d="M89 261 C55 229 57 192 77 161 C83 184 98 194 103 214 C115 188 107 160 113 138 C140 176 141 222 121 260Z" />
                    <path className="bitconnection-flame-tongue tongue-b" d="M155 267 C185 231 187 201 171 170 C166 193 151 201 146 221 C139 195 146 169 141 148 C118 186 119 233 139 264Z" />
                    <path className="bitconnection-flame-tongue tongue-c" d="M126 247 C103 220 111 183 130 153 C149 181 157 215 143 247Z" />
                    <path className="bitconnection-flame-inner" d="M130 278 C93 277 78 244 91 211 C101 186 117 171 123 143 C151 177 175 203 166 240 C161 262 148 276 130 278Z" />
                    <path className="bitconnection-flame-core" d="M130 269 C111 261 107 241 116 222 C123 208 129 201 130 184 C151 207 158 226 150 246 C146 259 139 267 130 269Z" />
                  </g>
                  <g className="bitconnection-flame-embers">
                    <circle cx="62" cy="151" r="4" />
                    <circle cx="205" cy="171" r="3" />
                    <circle cx="95" cy="95" r="3" />
                    <circle cx="165" cy="83" r="4" />
                    <circle cx="128" cy="56" r="3" />
                    <circle cx="78" cy="211" r="2.5" />
                    <circle cx="187" cy="222" r="2.5" />
                  </g>
                </g>
              </g>
            </svg>
          </div>
        </div>
      )}
      {adminConsoleOpen && (
        <AdminConsole
          bootstrapCode={adminBootstrapCode}
          onBootstrapConsumed={() => setAdminBootstrapCode('')}
          onClose={() => {
            setAdminConsoleOpen(false);
            setAdminBootstrapCode('');
          }}
        />
      )}
    </main>
  );
}
