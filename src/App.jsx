import { useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import BackgroundSwitcher from './BackgroundSwitcher.jsx';
import { runCiderBrowserRelay } from './cider-bridge.js';
import BitConnectionEntrance from './BitConnectionEntrance.jsx';
import UnifiedAccountCenterIdentity from './UnifiedAccountCenter.jsx';
import AdminConsole from './AdminConsole.jsx';

const SCOPES = ['playback', 'queue', 'library', 'audio'];
const API_VERSION = '2026-11-24-account-center-v13';
const SYNC_NOTIFICATION_KEY = 'bitcider.sync-notification-watch.v1';
function Icon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'arrow') return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>;
  if (name === 'check') return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === 'music') return <svg {...common}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
  if (name === 'account') return <svg {...common}><circle cx="12" cy="8" r="3.3" /><path d="M5.2 20a6.8 6.8 0 0 1 13.6 0" /><circle cx="12" cy="12" r="10" /></svg>;
  if (name === 'link') return <svg {...common}><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" /></svg>;
  if (name === 'shield') return <svg {...common}><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></svg>;
  if (name === 'external') return <svg {...common}><path d="M14 3h7v7M10 14 21 3" /><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" /></svg>;
  if (name === 'eye') return <svg {...common}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
  if (name === 'eye-off') return <svg {...common}><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.2A11.2 11.2 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 4.1M6.2 6.2C3.5 8.1 2 12 2 12s3.6 7 10 7c1.1 0 2.1-.2 3-.5" /></svg>;
  if (name === 'wand') return <svg {...common}><path d="m15 4 5 5M4 20l12.5-12.5M4 4v4M2 6h4M18 15v5M15.5 17.5h5M10 2v3M8.5 3.5h3" /></svg>;
  if (name === 'unplug') return <svg {...common}><path d="m16 16 3 3M2 2l20 20M7 7 4 4M14 7l3-3M7 14l-3 3" /><path d="M8 8a5 5 0 0 0 7 7" /></svg>;
  return null;
}


const CIPHER_GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789#$%&*+=<>?';

function scrambleText(value) {
  return Array.from(value, character => /[A-Za-z0-9]/.test(character)
    ? CIPHER_GLYPHS[Math.floor(Math.random() * CIPHER_GLYPHS.length)]
    : character
  ).join('');
}

function CipherText({ text, phase }) {
  const [displayText, setDisplayText] = useState(text);

  useEffect(() => {
    if (phase === 'idle') {
      setDisplayText(text);
      return undefined;
    }

    if (phase === 'handoff') {
      setDisplayText(scrambleText(text));
      return undefined;
    }

    const characters = Array.from(text);
    const revealOrder = characters
      .map((character, index) => /[A-Za-z0-9]/.test(character) ? index : -1)
      .filter(index => index >= 0);

    // Fisher-Yates gives each character a stable, randomized reveal position.
    for (let index = revealOrder.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [revealOrder[index], revealOrder[swapIndex]] = [revealOrder[swapIndex], revealOrder[index]];
    }

    if (phase === 'encrypt') {
      setDisplayText(scrambleText(text));
    } else if (phase === 'decrypt') {
      setDisplayText(scrambleText(text));
    } else {
      setDisplayText(text);
      return undefined;
    }

    let step = 0;
    const totalSteps = phase === 'encrypt' ? 13 : 20;
    const interval = window.setInterval(() => {
      step += 1;

      if (phase === 'encrypt') {
        // Keep the outgoing word encrypted until the page handoff replaces it.
        setDisplayText(scrambleText(text));
      } else {
        const revealed = new Set(revealOrder.slice(0, Math.ceil(revealOrder.length * step / totalSteps)));
        setDisplayText(characters.map((character, index) => (
          revealed.has(index) || !/[A-Za-z0-9]/.test(character)
            ? character
            : CIPHER_GLYPHS[Math.floor(Math.random() * CIPHER_GLYPHS.length)]
        )).join(''));
      }

      if (step >= totalSteps) {
        window.clearInterval(interval);
        if (phase === 'decrypt') setDisplayText(text);
      }
    }, phase === 'encrypt' ? 34 : 38);

    return () => window.clearInterval(interval);
  }, [phase, text]);

  return <span aria-label={text}>{displayText}</span>;
}

function getErrorMessage(payload, fallback) {
  return payload?.error?.message || payload?.message || payload?.error || fallback;
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
    return { level: 2, label: 'Mid · Try adding something', note: 'A longer passphrase or another character type can make this stronger.' };
  }
  return { level: 3, label: 'Hard · Good', note: 'Looks harder to guess. Keep it unique to BitCider.' };
}

function isGoogleChromeBrowser() {
  const brands = navigator.userAgentData?.brands;
  if (Array.isArray(brands) && brands.length) {
    return brands.some(entry => entry.brand === 'Google Chrome');
  }
  const userAgent = navigator.userAgent || '';
  const chromiumShell = ['Edg/', 'OPR/', 'Opera/', 'Brave/', 'CriOS/', 'SamsungBrowser/'];
  return userAgent.includes('Chrome/')
    && !chromiumShell.some(marker => userAgent.includes(marker))
    && !navigator.brave;
}

async function requestChromePasswordManagerSave(accountKey, password) {
  if (!window.isSecureContext
    || typeof window.PasswordCredential !== 'function'
    || typeof navigator.credentials?.store !== 'function') {
    throw new Error('The browser credential-save API is unavailable.');
  }
  const credential = new window.PasswordCredential({
    id: accountKey,
    password,
    name: 'BitCider Account',
    iconURL: new URL('/favicon.svg', window.location.origin).href
  });
  await navigator.credentials.store(credential);
}

function AccountSetupWindow({
  inline = false,
  initialFlow = null,
  initialHasPasskeys = false,
  initialCiderLinked = false,
  onComplete,
  onClose
}) {
  const [stage, setStage] = useState(initialFlow === 'existing' ? 'login' : initialFlow === 'new' ? 'create' : 'waiting');
  const [accountKey, setAccountKey] = useState('');
  const [ciderLinked, setCiderLinked] = useState(initialCiderLinked || initialFlow === 'existing');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [hasPasskeys, setHasPasskeys] = useState(initialHasPasskeys);
  const [passkeyCount, setPasskeyCount] = useState(0);
  const [passkeyLimit, setPasskeyLimit] = useState(5);
  const [tokenEncryptionConfigured, setTokenEncryptionConfigured] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState('');
  const [enrollmentPassword, setEnrollmentPassword] = useState('');
  const [isGeneratedPassword, setIsGeneratedPassword] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordAnimating, setPasswordAnimating] = useState(false);
  const [passwordAnimatedValue, setPasswordAnimatedValue] = useState('');
  const passwordAnimationRef = useRef(null);
  const strength = passwordStrength(password);

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

  async function post(path, payload = {}) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BitCider-CSRF': csrfToken },
      cache: 'no-store',
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error?.message || result?.message || result?.error || 'The account request could not be completed.');
    return result;
  }

  async function loadStatus() {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.message || 'Could not load account status.');
    setCsrfToken(result.csrfToken || '');
    setPasskeyCount(Number(result.passkeyCount || 0));
    setPasskeyLimit(Number(result.passkeyLimit || 5));
    setTokenEncryptionConfigured(result.tokenEncryptionConfigured === true);
    return result;
  }

  function saveCredentialsInChrome(accountKeyValue, passwordValue) {
    if (!accountKeyValue || !passwordValue || !isGoogleChromeBrowser()) return;
    // Keep the browser-native credential save out of the BitCider UI.
    // Chrome remains responsible for its own Password Manager prompt and storage.
    void requestChromePasswordManagerSave(accountKeyValue, passwordValue).catch(() => {});
  }

  function finish() {
    setEnrollmentPassword('');
    setAccountKey('');
    setPassword('');
    setPasswordConfirm('');
    if (inline) {
      onComplete?.();
      return;
    }
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'BITCIDER_ACCOUNT_SETUP_COMPLETE' }, window.location.origin);
      }
    } catch {}
    window.setTimeout(() => window.close(), 220);
  }

  useEffect(() => {
    loadStatus().catch(err => setError(err.message || 'Could not prepare account setup.'));
  }, []);

  useEffect(() => {
    if (inline) return undefined;
    function onParentMessage(event) {
      if (event.origin !== window.location.origin || event.source !== window.opener) return;
      if (event.data?.type !== 'BITCIDER_ACCOUNT_FLOW') return;
      const nextFlow = event.data.flow === 'existing' ? 'existing' : 'new';
      setHasPasskeys(event.data.hasPasskeys === true);
      setCiderLinked(nextFlow === 'existing' || event.data.ciderLinked === true);
      setStage(nextFlow === 'existing' ? 'login' : 'create');
      setError('');
      setInfo('');
    }
    window.addEventListener('message', onParentMessage);
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'BITCIDER_ACCOUNT_POPUP_READY' }, window.location.origin);
      }
    } catch {}
    return () => window.removeEventListener('message', onParentMessage);
  }, [inline]);

  async function signInWithPasskey() {
    setBusy(true);
    setError('');
    try {
      const optionsJSON = await post('/api/account/passkeys/auth/options');
      const authentication = await startAuthentication({ optionsJSON });
      const result = await post('/api/account/passkeys/auth/verify', authentication);
      if (result.accountKey) {
        setAccountKey(result.accountKey);
        setStage('account-key');
        setInfo('A new Account Key was created for this older account. Save it before continuing.');
      } else {
        setInfo(result.evictedDevice
          ? 'Passkey verified. ' + result.evictedDevice + ' was signed out to stay within the five-device limit.'
          : 'Passkey verified. Your BitCider account is restored.');
        finish();
      }
    } catch (err) {
      setError(err.message || 'Passkey sign-in was cancelled or could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPassword(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await post('/api/account/login', { accountKey: accountKey.trim(), password });
      if (result.accountKey) {
        setAccountKey(result.accountKey);
        saveCredentialsInChrome(result.accountKey, password);
        setStage('account-key');
        setInfo('A new Account Key was created for this older account. Save it before continuing.');
      } else {
        finish();
      }
    } catch (err) {
      setError(err.message || 'The password could not be verified for this Cider connection.');
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(event) {
    event.preventDefault();
    if (password !== passwordConfirm) {
      setError('The passphrases do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await post('/api/account/register', { password });
      const createdAccountKey = result.accountKey || '';
      setEnrollmentPassword(password);
      setAccountKey(createdAccountKey);
      setRecoveryCodes(Array.isArray(result.recoveryCodes) ? result.recoveryCodes : []);
      saveCredentialsInChrome(createdAccountKey, password);
      setPassword('');
      setPasswordConfirm('');
      setStage('recovery');
      setInfo('Your account is created. Save these recovery codes before continuing.');
      await loadStatus();
    } catch (err) {
      setError(err.message || 'Could not create your BitCider account.');
    } finally {
      setBusy(false);
    }
  }

  async function recoverAccount(event) {
    event.preventDefault();
    if (password !== passwordConfirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await post('/api/account/recover', { recoveryCode, newPassword: password });
      const recoveredAccountKey = result.accountKey || '';
      setAccountKey(recoveredAccountKey);
      setRecoveryCodes(Array.isArray(result.recoveryCodes) ? result.recoveryCodes : []);
      saveCredentialsInChrome(recoveredAccountKey, password);
      setPassword('');
      setPasswordConfirm('');
      setRecoveryCode('');
      setStage('recovery-reset');
      setInfo('Your password has been reset. Save your replacement recovery codes.');
      await loadStatus();
    } catch (err) {
      setError(err.message || 'The recovery code could not be verified for this Cider connection.');
    } finally {
      setBusy(false);
    }
  }

  function showClipboardNotice() {
    setClipboardNotice('Copied to clipboard');
    window.setTimeout(() => setClipboardNotice(''), 1900);
  }

  async function copyAccountKey() {
    if (!accountKey) return;
    try {
      await navigator.clipboard.writeText(accountKey);
      setError('');
      showClipboardNotice();
    } catch {
      setClipboardNotice('');
      setError('Clipboard access was blocked. Select and copy the Account Key manually.');
    }
  }

  async function copyRecoveryCodes() {
    if (!recoveryCodes.length) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setError('');
      showClipboardNotice();
    } catch {
      setClipboardNotice('');
      setError('Clipboard access was blocked. Select and copy the codes manually.');
    }
  }

  async function addOnboardingPasskey() {
    if (!enrollmentPassword) {
      setError('Your passphrase is no longer available in this window. Finish setup and add passkeys from account recovery or sign in again.');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('Opening your device’s passkey setup…');
    try {
      const deviceName = 'Passkey ' + (passkeyCount + 1);
      const optionsJSON = await post('/api/account/passkeys/register/options', { password: enrollmentPassword });
      const registration = await startRegistration({ optionsJSON });
      const result = await post('/api/account/passkeys/register/verify', { ...registration, deviceName });
      setPasskeyCount(Number(result.passkeyCount || passkeyCount + 1));
      setHasPasskeys(true);
      setInfo('Passkey ' + (result.passkeyCount || passkeyCount + 1) + ' of ' + passkeyLimit + ' added.');
    } catch (err) {
      setError(err.message || 'Could not add this passkey. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const canSubmitCreate = Boolean(password.length > 0 && passwordConfirm.length > 0 && csrfToken && !busy);
  const canSubmitLogin = Boolean(password.length > 0 && (accountKey.trim().length > 0 || ciderLinked) && csrfToken && !busy);
  const canSubmitRecovery = Boolean(recoveryCode.trim() && password.length > 0 && passwordConfirm.length > 0 && csrfToken && !busy);
  const strengthClass = strength.level ? 'password-strength level-' + strength.level : 'password-strength';

  return (
    <div className={inline ? 'account-popup-overlay' : 'account-popup-page'}>
      <section className="account-popup-card" aria-live="polite">
        <div className="account-popup-top">
          <div className="account-popup-brand">
            <img src="/favicon.svg" alt="" />
            <span>Bit<span>Cider</span></span>
          </div>
          {inline && <button className="account-popup-close" type="button" onClick={onClose} aria-label="Close account setup">×</button>}
        </div>

        <div className="account-popup-content">
          {stage === 'waiting' && (
            <div className="account-popup-state">
              <div className="card-label">CIDER CONNECTION APPROVED</div>
              <h1>Preparing your account…</h1>
              <p>This window is waiting for BitCider to securely check whether this Cider token is already linked.</p>
            </div>
          )}

          {stage === 'create' && (
            <div className="account-popup-state">
              <div className="card-label">NEW CIDER LINK</div>
              <h1>Create your BitCider account.</h1>
              <p>Your Cider connection is ready. Create a password so this link can be restored when you sign in on another device.</p>
              {!tokenEncryptionConfigured && (
                <div className="account-popup-warning">Secure cloud storage is not configured on the BitCider backend yet. Account setup is unavailable until Deplexo has the encryption secret.</div>
              )}
              <form className="account-popup-form" id="account-create-form" autoComplete="on" onSubmit={createAccount}>
                <label>
                  <span>CREATE A PASSWORD</span>
                  <div className={'account-password-shell' + (passwordAnimating ? ' is-animating ' + (passwordVisible ? 'is-decrypting' : 'is-encrypting') : '')}>
                    <button
                      className="account-password-tool account-password-generator"
                      type="button"
                      onClick={generateAccountPassword}
                      disabled={busy || passwordAnimating}
                      aria-label="Generate a cryptographically random password"
                      title="Generate a secure password"
                    ><Icon name="wand" size={16} /></button>
                    <input
                      id="new-password"
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
                    <button
                      className="account-password-tool account-password-visibility"
                      type="button"
                      onClick={togglePasswordVisibility}
                      disabled={!password || busy || passwordAnimating}
                      aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                      aria-pressed={passwordVisible}
                      title={passwordVisible ? 'Hide password' : 'Show password'}
                    ><Icon name={passwordVisible ? 'eye-off' : 'eye'} size={16} /></button>
                  </div>
                </label>
                <div className={strengthClass} aria-live="polite">
                  <div className="password-strength-bars"><i /><i /><i /></div>
                  <strong>{strength.label}</strong>
                  <span>{strength.note}</span>
                </div>
                <label>
                  <span>CONFIRM PASSWORD</span>
                  <input
                    id="confirm-password"
                    name="confirm-password"
                    type={passwordAnimating || passwordVisible || isGeneratedPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={passwordAnimating ? passwordAnimatedValue : isGeneratedPassword && !passwordVisible ? 'Password123' : passwordConfirm}
                    onChange={event => {
                      setPasswordConfirm(event.target.value);
                      setIsGeneratedPassword(false);
                    }}
                    readOnly={passwordAnimating || isGeneratedPassword}
                    placeholder="Type it again"
                    required
                    dir="ltr"
                    spellCheck={false}
                  />
                </label>
                <p className="account-popup-footnote">Generate a 24–500 character password with secure randomness, or type your own. Generated passwords include multiple scripts, symbols and combining characters. The hidden preview reads Password123; the actual password is much more complex.</p>
                <button className="account-submit-button" type="submit" disabled={!canSubmitCreate || !tokenEncryptionConfigured}>{busy ? 'CREATING ACCOUNT…' : 'CREATE ACCOUNT'}</button>
              </form>
              <button className="account-recovery-link" type="button" onClick={() => { setCiderLinked(false); setAccountKey(''); setPassword(''); setPasswordConfirm(''); setError(''); setStage('login'); }}>ALREADY HAVE AN ACCOUNT? SIGN IN</button>
            </div>
          )}

          {stage === 'recovery' && (
            <div className="account-popup-state account-security-compact">
              <h1>Save your Account Key and recovery codes.</h1>
              <p>Your Account Key identifies your BitCider account on new devices. It is shown once. Keep it private and store the recovery codes separately.</p>
              <div className="account-key-display"><span>ACCOUNT KEY</span><code>{accountKey}</code><button className="account-secondary-button" type="button" onClick={copyAccountKey} disabled={!accountKey}>COPY ACCOUNT KEY</button></div>
              <div className="popup-recovery-codes">{recoveryCodes.map(code => <code key={code}>{code}</code>)}</div>
              <div className="account-popup-actions">
                <button className="account-secondary-button" type="button" onClick={copyRecoveryCodes} disabled={!recoveryCodes.length}>COPY CODES</button>
                <button className="account-submit-button" type="button" onClick={() => { setRecoverySaved(true); setStage('passkeys'); }} disabled={!recoveryCodes.length || !accountKey}>I SAVED MY KEY AND CODES</button>
              </div>
            </div>
          )}

          {stage === 'passkeys' && (
            <div className="account-popup-state">
              <div className="card-label">PASSKEY SETUP · {Math.min(passkeyCount, passkeyLimit)}/{passkeyLimit}</div>
              <h1>Add up to five passkeys.</h1>
              <p>Set up separate passkeys on devices or password managers you use. Each passkey is added with its own secure browser prompt.</p>
              <div className="passkey-progress" aria-label={passkeyCount + ' of ' + passkeyLimit + ' passkeys added'}>
                {Array.from({ length: passkeyLimit }, (_, index) => <i className={index < passkeyCount ? 'is-complete' : ''} key={index} />)}
              </div>
              <div className="account-popup-actions">
                <button className="account-submit-button" type="button" onClick={addOnboardingPasskey} disabled={busy || passkeyCount >= passkeyLimit}>
                  {busy ? 'WAITING FOR AUTHENTICATOR…' : passkeyCount === 0 ? 'ADD FIRST PASSKEY' : passkeyCount < passkeyLimit ? 'ADD ANOTHER PASSKEY' : 'FIVE PASSKEYS ADDED'}
                </button>
                <button className="account-secondary-button" type="button" onClick={finish} disabled={busy}>FINISH SETUP</button>
              </div>
              <p className="account-popup-footnote">You can finish with one passkey or add more, up to the five-passkey limit. You can skip this step and return later.</p>
            </div>
          )}

          {stage === 'login' && (
            <div className="account-popup-state">
              <div className="card-label">BITCIDER ACCOUNT</div>
              <h1>Welcome back.</h1>
              <p>Use a passkey, or enter your Account Key and password. On a device already linked to Cider, the Account Key can be left blank.</p>
              <div className="account-passkey-prompt">
                <div className="passkey-prompt-indicator">PASSKEY SIGN-IN</div>
                <p>Use a discoverable passkey saved in this browser, device, or synced password manager.</p>
                <button className="account-passkey-button" type="button" onClick={signInWithPasskey} disabled={busy || !csrfToken}>{busy ? 'WAITING FOR PASSKEY…' : 'CONTINUE WITH PASSKEY'}</button>
              </div>
              <div className="account-popup-divider"><span>OR USE YOUR PASSWORD</span></div>
              <form className="account-popup-form" id="account-login-form" autoComplete="on" onSubmit={signInWithPassword}>
                <label>
                  <span>ACCOUNT KEY</span>
                  <input id="account-key" name="username" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={accountKey} onChange={event => setAccountKey(event.target.value)} placeholder={ciderLinked ? 'Optional on this already-linked device' : 'Paste your saved Account Key'} required={!ciderLinked} />
                </label>
                <label>
                  <span>PASSWORD</span>
                  <input id="account-password" name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Your BitCider password" required />
                </label>
                <button className="account-submit-button" type="submit" disabled={!canSubmitLogin}>{busy ? 'SIGNING IN…' : 'SIGN IN'}</button>
              </form>
              <button className="account-recovery-link" type="button" onClick={() => { setPassword(''); setPasswordConfirm(''); setError(''); setStage('recover'); }}>USE A RECOVERY CODE INSTEAD</button>
            </div>
          )}

          {stage === 'recover' && (
            <div className="account-popup-state">
              <div className="card-label">ACCOUNT RECOVERY</div>
              <h1>Reset your password.</h1>
              <p>Enter one unused recovery code from this account and choose a new password. You do not need the original device or Cider connection.</p>
              <form className="account-popup-form" onSubmit={recoverAccount}>
                <label>
                  <span>ONE-TIME RECOVERY CODE</span>
                  <input autoComplete="off" value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" required />
                </label>
                <label>
                  <span>NEW PASSWORD</span>
                  <input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Choose a new password" required />
                </label>
                <div className={strengthClass} aria-live="polite">
                  <div className="password-strength-bars"><i /><i /><i /></div>
                  <strong>{strength.label}</strong>
                  <span>{strength.note}</span>
                </div>
                <label>
                  <span>CONFIRM NEW PASSWORD</span>
                  <input type="password" autoComplete="new-password" value={passwordConfirm} onChange={event => setPasswordConfirm(event.target.value)} placeholder="Type it again" required />
                </label>
                <button className="account-submit-button" type="submit" disabled={!canSubmitRecovery}>{busy ? 'RECOVERING ACCOUNT…' : 'RESET PASSWORD'}</button>
              </form>
              <button className="account-recovery-link" type="button" onClick={() => { setPassword(''); setPasswordConfirm(''); setRecoveryCode(''); setError(''); setStage('login'); }}>BACK TO SIGN IN</button>
            </div>
          )}

          {stage === 'account-key' && (
            <div className="account-popup-state">
              <div className="card-label">ACCOUNT KEY CREATED</div>
              <h1>Save your Account Key.</h1>
              <p>This older account did not have an Account Key yet. It is shown once. Store it privately so you can sign in from other devices.</p>
              <div className="account-key-display"><span>ACCOUNT KEY</span><code>{accountKey}</code><button className="account-secondary-button" type="button" onClick={copyAccountKey} disabled={!accountKey}>COPY ACCOUNT KEY</button></div>
              <button className="account-submit-button" type="button" onClick={finish} disabled={!accountKey}>I SAVED MY ACCOUNT KEY</button>
            </div>
          )}

          {stage === 'recovery-reset' && (
            <div className="account-popup-state account-security-compact">
              <div className="card-label">PASSWORD RECOVERED</div>
              <h1>Save your new recovery codes.</h1>
              <p>Your password and Account Key have been reset. Other active devices were signed out. Save the new key and replacement recovery codes before continuing.</p>
              <div className="account-key-display"><span>NEW ACCOUNT KEY</span><code>{accountKey}</code><button className="account-secondary-button" type="button" onClick={copyAccountKey} disabled={!accountKey}>COPY ACCOUNT KEY</button></div>
              <div className="popup-recovery-codes">{recoveryCodes.map(code => <code key={code}>{code}</code>)}</div>
              <div className="account-popup-actions">
                <button className="account-secondary-button" type="button" onClick={copyRecoveryCodes} disabled={!recoveryCodes.length}>COPY CODES</button>
                <button className="account-submit-button" type="button" onClick={finish} disabled={!recoveryCodes.length}>FINISH</button>
              </div>
            </div>
          )}

          {error && <div className="notice notice-warning">{error}</div>}
          {info && stage !== 'recovery' && <div className="notice notice-info">{info}</div>}
          {clipboardNotice && (
            <div className="account-clipboard-toast" role="status" aria-live="polite">
              <Icon name="check" size={13} />
              <span>{clipboardNotice}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}


function AccountManagementOverlay({ status, csrfToken, bitConnectionAuthenticated = false, onClose, onDeleted, onStatusRefresh }) {
  const [passwordChangeCurrentPassword, setPasswordChangeCurrentPassword] = useState('');
  const [passkeyPassword, setPasskeyPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [revealedAccountKey, setRevealedAccountKey] = useState('');
  const [revealedRecoveryCodes, setRevealedRecoveryCodes] = useState([]);
  const [deleteStage, setDeleteStage] = useState('idle');
  const [deleteCaught, setDeleteCaught] = useState(0);
  const [deleteSpot, setDeleteSpot] = useState({ x: 160, y: 120 });
  const [deleteProgress, setDeleteProgress] = useState(0);
  const [deleteProgressLabel, setDeleteProgressLabel] = useState('Preparing account deletion');
  const [busyAction, setBusyAction] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info');

  const accountDate = status.account?.createdAt
    ? new Date(status.account.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Available';

  async function accountRequest(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BitCider-CSRF': csrfToken },
      cache: 'no-store',
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(getErrorMessage(result, 'The account security action could not be completed.'));
    return result;
  }

  function notify(text, type = 'info') {
    setMessage(text);
    setMessageType(type);
  }

  function closeOverlay() {
    setPasswordChangeCurrentPassword('');
    setPasskeyPassword('');
    setNewPassword('');
    setRevealedAccountKey('');
    setRevealedRecoveryCodes([]);
    onClose();
  }

  async function revealSecret(secretType) {
    setBusyAction(secretType);
    setMessage('');
    try {
      const optionsJSON = await accountRequest('/api/account/secrets/reveal/options', { secretType });
      const assertion = await startAuthentication({ optionsJSON });
      const result = await accountRequest('/api/account/secrets/reveal', assertion);
      if (secretType === 'account-key') {
        setRevealedAccountKey(result.accountKey || '');
        notify('Your replacement Account Key is ready. Copy it now, because it cannot be shown again.', 'success');
      } else {
        setRevealedRecoveryCodes(Array.isArray(result.recoveryCodes) ? result.recoveryCodes : []);
        notify('Your replacement backup codes are ready. The previous set is no longer valid.', 'success');
      }
      await onStatusRefresh();
    } catch (error) {
      notify(error.message || 'Passkey verification could not authorize this secret.', 'warning');
    } finally {
      setBusyAction('');
    }
  }

  async function rotateAccountKey() {
    return revealSecret('account-key');
  }

  async function rotateRecoveryCodes() {
    return revealSecret('backup-codes');
  }

  async function updatePassword() {
    if (!passwordChangeCurrentPassword || !newPassword) return notify('Enter your current password and a new password.', 'warning');
    setBusyAction('password');
    setMessage('');
    try {
      const result = await accountRequest('/api/account/password/change', { currentPassword: passwordChangeCurrentPassword, newPassword });
      setPasswordChangeCurrentPassword('');
      setNewPassword('');
      await onStatusRefresh();
      notify(
        result.revokedDevices
          ? 'Password updated. Other signed-in devices were signed out.'
          : 'Your password has been updated.',
        'success'
      );
    } catch (error) {
      notify(error.message || 'Could not update your password.', 'warning');
    } finally {
      setBusyAction('');
    }
  }

  async function addPasskey() {
    if (!passkeyPassword) return notify('Enter your current password before adding a passkey.', 'warning');
    setBusyAction('passkey-add');
    setMessage('');
    try {
      const optionsJSON = await accountRequest('/api/account/passkeys/register/options', { password: passkeyPassword });
      const registration = await startRegistration({ optionsJSON });
      const result = await accountRequest('/api/account/passkeys/register/verify', {
        ...registration,
        deviceName: 'Passkey ' + ((status.passkeys || []).length + 1)
      });
      setPasskeyPassword('');
      await onStatusRefresh();
      notify('Passkey added to your BitCider account.', 'success');
    } catch (error) {
      notify(error.message || 'Could not add this passkey.', 'warning');
    } finally {
      setBusyAction('');
    }
  }

  async function removePasskey(credentialId) {
    if (!passkeyPassword) return notify('Enter your current password before removing a passkey.', 'warning');
    setBusyAction('passkey:' + credentialId);
    setMessage('');
    try {
      await accountRequest('/api/account/passkeys/remove', {
        credentialId,
        password: passkeyPassword
      });
      setPasskeyPassword('');
      await onStatusRefresh();
      notify('Passkey removed from your BitCider account.', 'success');
    } catch (error) {
      notify(error.message || 'Could not remove that passkey.', 'warning');
    } finally {
      setBusyAction('');
    }
  }

  async function copyValue(value, label) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      notify(label + ' copied. Store it somewhere private.', 'success');
    } catch {
      notify('Clipboard access was blocked. Select and copy it manually.', 'warning');
    }
  }

  function randomDeletePosition() {
    const panel = document.querySelector('.account-center-panel');
    const grid = panel?.querySelector('.account-center-grid');
    if (!panel || !grid) return { x: 160, y: 120, cardIndex: 0, side: 0 };

    // Keep the target attached to one of the three security cards. It is
    // positioned in the grid's own coordinate space, so scrolling the cards
    // carries the target with them instead of moving the whole account panel.
    const cards = Array.from(panel.querySelectorAll('.account-center-grid > .account-center-card')).slice(0, 3);
    const candidates = cards.filter(card => {
      const rect = card.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!candidates.length) return { x: 160, y: 120, cardIndex: 0, side: 0 };

    const chosenCard = candidates[Math.floor(Math.random() * candidates.length)];
    const gridRect = grid.getBoundingClientRect();
    const rect = chosenCard.getBoundingClientRect();
    const cardLeft = rect.left - gridRect.left;
    const cardTop = rect.top - gridRect.top;
    const cardRight = cardLeft + rect.width;
    const cardBottom = cardTop + rect.height;
    const buttonWidth = window.innerWidth <= 480 ? 112 : 146;
    const buttonHeight = window.innerWidth <= 480 ? 39 : 41;
    const randomBetween = (min, max) => min <= max
      ? min + Math.random() * (max - min)
      : (min + max) / 2;
    const side = Math.floor(Math.random() * 4);
    let x;
    let y;

    // The target sits underneath the card (z-index 4 vs 5), with a visible
    // strip extending beyond exactly one of its four edges.
    if (side === 0) { // top edge
      x = randomBetween(cardLeft + buttonWidth * 0.55, cardRight - buttonWidth * 0.55);
      y = cardTop + buttonHeight * 0.2;
    } else if (side === 1) { // right edge
      x = cardRight - buttonWidth * 0.2;
      y = randomBetween(cardTop + buttonHeight * 0.55, cardBottom - buttonHeight * 0.55);
    } else if (side === 2) { // bottom edge
      x = randomBetween(cardLeft + buttonWidth * 0.55, cardRight - buttonWidth * 0.55);
      y = cardBottom - buttonHeight * 0.2;
    } else { // left edge
      x = cardLeft + buttonWidth * 0.2;
      y = randomBetween(cardTop + buttonHeight * 0.55, cardBottom - buttonHeight * 0.55);
    }

    return {
      x: Math.round(x),
      y: Math.round(y),
      cardIndex: cards.indexOf(chosenCard),
      side
    };
  }
  useEffect(() => {
    if (deleteStage === 'intro') {
      const reveal = window.setTimeout(() => setDeleteStage('hands'), 850);
      return () => window.clearTimeout(reveal);
    }
    if (deleteStage === 'hands') {
      const reveal = window.setTimeout(() => setDeleteStage('game'), 2000);
      return () => window.clearTimeout(reveal);
    }
    return undefined;
  }, [deleteStage]);

  function startDeleteGame() {
    setDeleteCaught(0);
    setDeleteSpot(randomDeletePosition());
    setDeleteStage('intro');
    setMessage('');
  }

  function catchDeleteTarget(event) {
    event.stopPropagation();
    if (deleteStage !== 'game') return;
    const nextCatch = deleteCaught + 1;
    setDeleteCaught(nextCatch);
    if (nextCatch >= 5) {
      void executeDeletion();
      return;
    }
    setDeleteSpot(randomDeletePosition());
    setDeleteStage('hands');
  }

  async function clearThisOriginData() {
    try { window.localStorage.clear(); } catch {}
    try { window.sessionStorage.clear(); } catch {}
    try {
      if ('caches' in window) {
        const cacheNames = await window.caches.keys();
        await Promise.all(cacheNames.map(name => window.caches.delete(name)));
      }
    } catch {}
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(registration => registration.unregister()));
      }
    } catch {}
  }

  async function executeDeletion() {
    setDeleteStage('crt-off');
    document.documentElement.classList.add('bitcider-crt-off');
    await new Promise(resolve => window.setTimeout(resolve, 1450));
    document.documentElement.classList.remove('bitcider-crt-off');

    setDeleteStage('deleting');
    setDeleteProgress(4);
    setDeleteProgressLabel('Opening the secure deletion process');

    // Paint the progress screen before starting the request, even on very fast servers.
    await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    const progressStartedAt = Date.now();
    const minimumProgressVisibleMs = 1650;

    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BitCider-CSRF': csrfToken },
        cache: 'no-store',
        body: JSON.stringify({})
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(getErrorMessage(payload, 'Account deletion could not be started.'));
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('This browser could not read the live account deletion status.');
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = block.split('\n').find(line => line.startsWith('data:'));
          if (dataLine) {
            const event = JSON.parse(dataLine.slice(5).trim());
            if (typeof event.progress === 'number') setDeleteProgress(event.progress);
            if (event.label) setDeleteProgressLabel(event.label);
            if (event.type === 'error') throw new Error(event.label || 'Account deletion was interrupted.');
            if (event.type === 'complete') completed = true;
          }
          boundary = buffer.indexOf('\n\n');
        }
        if (done) break;
      }

      if (!completed) throw new Error('The server closed the deletion process before confirming completion.');
      setDeleteProgress(100);
      setDeleteProgressLabel('Account deleted successfully');
      const progressElapsed = Date.now() - progressStartedAt;
      if (progressElapsed < minimumProgressVisibleMs) {
        await new Promise(resolve => window.setTimeout(resolve, minimumProgressVisibleMs - progressElapsed));
      }
      await clearThisOriginData();
      await onDeleted();

      setDeleteStage('crt-on');
      document.documentElement.classList.add('bitcider-crt-on');
      await new Promise(resolve => window.setTimeout(resolve, 1550));
      document.documentElement.classList.remove('bitcider-crt-on');
      onClose();
    } catch (error) {
      document.documentElement.classList.remove('bitcider-crt-off', 'bitcider-crt-on');
      setDeleteStage('crt-on');
      document.documentElement.classList.add('bitcider-crt-on');
      await new Promise(resolve => window.setTimeout(resolve, 1450));
      document.documentElement.classList.remove('bitcider-crt-on');
      setDeleteStage('idle');
      notify(error.message || 'Account deletion could not be completed. Your account is still active.', 'warning');
    }
  }

  if (deleteStage === 'crt-off' || deleteStage === 'crt-on') return null;

  if (!status.account?.authenticated) {
    return (
      <div className="account-center-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
        <section className="account-center-panel" role="dialog" aria-modal="true" aria-labelledby="account-center-title">
          <header className="account-center-header">
            <UnifiedAccountCenterIdentity currentProduct="bitcider" bitConnectionAuthenticated={bitConnectionAuthenticated} />
            <button className="account-center-close" type="button" onClick={onClose} aria-label="Close account settings">×</button>
          </header>
          <div className="account-center-content">
            <section className="account-center-card">
              <div className="account-center-card-head"><span>ACCOUNT ACCESS</span><span className="account-center-state">{status.loading ? 'CHECKING' : bitConnectionAuthenticated ? 'SIGNED IN' : 'NO ACTIVE SESSION'}</span></div>
              <p>{status.loading ? 'Checking your BitCider and BitConnection sessions.' : bitConnectionAuthenticated ? 'Your BitConnection session is active. Manage its profile, passkeys, and account security from BitAccount Center.' : 'No BitCider account is signed in on this browser. Sign in to either product to manage your account here.'}</p>
              {bitConnectionAuthenticated && <a className="account-center-action unified-account-center-open-link" href="/bitconnection/?account=1&identity=bitconnection" target="_blank" rel="noreferrer">OPEN BITCONNECTION SETTINGS</a>}
            </section>
          </div>
        </section>
      </div>
    );
  }

  if (deleteStage === 'deleting') {
    return (
      <div className="account-delete-cinema is-black" role="status" aria-live="polite">
        <div className="account-delete-progress">
          <div className="account-delete-progress-track" role="progressbar" aria-label="Account deletion progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={deleteProgress}>
            <i style={{ width: deleteProgress + '%' }} />
          </div>
          <div className="account-delete-progress-meta">
            <span>{deleteProgressLabel} · BITCIDER / ACCOUNT PURGE</span>
            <span>{Math.round(deleteProgress)}%</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className={'account-center-overlay' + (deleteStage === 'game' || deleteStage === 'hands' ? ' is-delete-hunt' : '')} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && deleteStage !== 'game' && deleteStage !== 'hands') closeOverlay(); }}>
      <section className="account-center-panel" role="dialog" aria-modal="true" aria-labelledby="account-center-title">
        <header className="account-center-header">
          <UnifiedAccountCenterIdentity
            currentProduct="bitcider"
            bitCiderAuthenticated={status.account?.authenticated === true}
            bitConnectionAuthenticated={bitConnectionAuthenticated}
            createdAt={status.account?.createdAt}
          />
          <button className="account-center-close" type="button" onClick={closeOverlay} aria-label="Close account settings">×</button>
        </header>

        <div className="account-center-content">
          <div className="account-center-grid">
            {deleteStage === 'game' && (
              <button
                className="account-danger-button account-delete-target"
                type="button"
                style={{ left: deleteSpot.x + 'px', top: deleteSpot.y + 'px' }}
                onPointerDown={event => event.stopPropagation()}
                onClick={catchDeleteTarget}
              >Delete account</button>
            )}
            <section className="account-center-card">
              <div className="account-center-card-head"><span>ACCOUNT KEY</span><span className={status.account?.accountKeyConfigured ? 'account-center-state' : 'account-center-state is-muted'}>{status.account?.accountKeyConfigured ? 'PROTECTED' : 'NOT SET'}</span></div>
              {revealedAccountKey ? (
                <div className="account-center-secret">
                  <code>{revealedAccountKey}</code>
                  <button type="button" className="account-secondary-button" onClick={() => copyValue(revealedAccountKey, 'Account Key')}>COPY KEY</button>
                </div>
              ) : (
                <div className="account-center-masked-secret">•••• •••• •••• •••• •••• ••••</div>
              )}
              <p>The existing key is stored as a one-way verifier and cannot be read back. A passkey is required to replace it and reveal the new key.</p>
              <button type="button" className="account-center-action" onClick={rotateAccountKey} disabled={!(status.passkeys || []).length || busyAction === 'account-key'}>
                {busyAction === 'account-key' ? 'WAITING FOR PASSKEY…' : revealedAccountKey ? 'REPLACE & REVEAL KEY AGAIN' : 'REPLACE & REVEAL KEY'}
              </button>
            </section>

            <section className="account-center-card">
              <div className="account-center-card-head"><span>PASSWORD</span><span className="account-center-state">ENCRYPTED VERIFIER</span></div>
              <div className="account-center-masked-secret">••••••••••••••••</div>
              <p>The current password cannot be viewed. Enter it here to set a new one. Other signed-in devices will be signed out.</p>
              <label className="account-center-password-label"><span>CURRENT PASSWORD</span><input type="password" autoComplete="current-password" value={passwordChangeCurrentPassword} onChange={event => setPasswordChangeCurrentPassword(event.target.value)} placeholder="Current password" /></label>
              <input className="account-center-input" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="New password" />
              <button type="button" className="account-center-action" onClick={updatePassword} disabled={!passwordChangeCurrentPassword || !newPassword || busyAction === 'password'}>
                {busyAction === 'password' ? 'UPDATING…' : 'UPDATE PASSWORD'}
              </button>
            </section>

            <section className="account-center-card">
              <div className="account-center-card-head"><span>BACKUP CODES</span><span className="account-center-state">{status.account?.recoveryCodeCount ?? 0} AVAILABLE</span></div>
              {revealedRecoveryCodes.length ? (
                <div className="account-center-recovery-codes">
                  {revealedRecoveryCodes.map(code => <code key={code}>{code}</code>)}
                  <button type="button" className="account-secondary-button" onClick={() => copyValue(revealedRecoveryCodes.join('\n'), 'Backup codes')}>COPY ALL CODES</button>
                </div>
              ) : (
                <div className="account-center-masked-secret">•••• •••• •••• ••••</div>
              )}
              <p>Only code hashes are kept on the server. A passkey is required to replace this set and reveal the new codes. Replacing them invalidates every previous code.</p>
              <button type="button" className="account-center-action" onClick={rotateRecoveryCodes} disabled={!(status.passkeys || []).length || busyAction === 'backup-codes'}>
                {busyAction === 'backup-codes' ? 'WAITING FOR PASSKEY…' : 'REPLACE & REVEAL BACKUP CODES'}
              </button>
            </section>

            <section className="account-center-card account-center-passkeys">
              <div className="account-center-card-head"><span>LINKED PASSKEYS</span><span className="account-center-state">{(status.passkeys || []).length} / {status.passkeyLimit || 5}</span></div>
              {(status.passkeys || []).length ? (
                <div className="account-center-passkey-list">
                  {status.passkeys.map(passkey => (
                    <div className="account-center-passkey" key={passkey.id}>
                      <div className="account-center-passkey-icon"><Icon name="shield" size={17} /></div>
                      <div className="account-center-passkey-copy">
                        <strong>{passkey.name || 'Passkey'}</strong>
                        <span>{passkey.deviceType === 'multiDevice' ? 'Synced passkey' : 'Device-bound passkey'} · {passkey.lastUsedAt ? 'Used ' + new Date(passkey.lastUsedAt).toLocaleDateString() : 'Not used yet'}</span>
                      </div>
                      <button type="button" className="account-center-remove" onClick={() => removePasskey(passkey.id)} disabled={!passkeyPassword || busyAction === 'passkey:' + passkey.id}>Remove</button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="account-center-empty">No passkeys are currently linked to this account.</p>
              )}
              <p>Enter your account password before adding or removing a passkey. Removing one unlinks it from BitCider but does not delete it from your device or password manager.</p>
              <label className="account-center-password-label"><span>PASSWORD REQUIRED FOR PASSKEY CHANGES</span><input type="password" autoComplete="current-password" value={passkeyPassword} onChange={event => setPasskeyPassword(event.target.value)} placeholder="Current password" /></label>
              <button type="button" className="account-center-action" onClick={addPasskey} disabled={!passkeyPassword || busyAction === 'passkey-add' || (status.passkeys || []).length >= (status.passkeyLimit || 5)}>
                {busyAction === 'passkey-add' ? 'WAITING FOR AUTHENTICATOR…' : (status.passkeys || []).length >= (status.passkeyLimit || 5) ? 'PASSKEY LIMIT REACHED' : 'ADD PASSKEY'}
              </button>
            </section>
          </div>

          {message && <div className={'account-center-message ' + (messageType === 'warning' ? 'is-warning' : '')} role="status">{message}</div>}

          <div className="account-center-danger-zone">
            <div><strong>Delete account</strong><p>Permanently remove your account and its saved Cider connection. This cannot be undone.</p></div>
            {deleteStage !== 'game' && deleteStage !== 'hands' && <button type="button" className={'account-danger-button account-delete-start' + (deleteStage === 'intro' ? ' is-launching' : '')} onClick={startDeleteGame} data-game-message="Let's play a little game before you terminate the account.">Delete account</button>}
          </div>
        </div>
      </section>
    </div>
    {deleteStage === 'hands' && (
      <div className="account-peekaboo-blink" aria-hidden="true">
        <span className="account-peekaboo-lid eyelid-top" />
        <span className="account-peekaboo-lid eyelid-bottom" />
        <span className="account-peekaboo-closed-eyes">⌣　⌣</span>
      </div>
    )}
    </>
  );
}

export default function App() {
  const isAccountPopup = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('account') === 'setup';
  const [adminConsoleOpen, setAdminConsoleOpen] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('admin') === '1');
  const [adminBootstrapCode, setAdminBootstrapCode] = useState('');
  const [inlineAccountFlow, setInlineAccountFlow] = useState(null);
  const [accountOverlayOpen, setAccountOverlayOpen] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('account-center') === '1');
  const [bitConnectionAccountAuthenticated, setBitConnectionAccountAuthenticated] = useState(false);
  const [pageMode, setPageMode] = useState(() => (
    typeof window !== 'undefined'
      && (window.location.pathname === '/bitmono/' || window.location.pathname === '/bitmono')
      ? 'mono'
      : 'cider'
  ));
  const [modeTransitionPhase, setModeTransitionPhase] = useState('idle');
  const [modeSwitcherOpen, setModeSwitcherOpen] = useState(false);
  const modeDragRef = useRef(null);
  const modeSuppressClickUntilRef = useRef(0);
  const [modeDragProgress, setModeDragProgress] = useState(null);
  const [modeTransitionTarget, setModeTransitionTarget] = useState('');
  const [bitMonoCopied, setBitMonoCopied] = useState(false);
  const [bitMonoHealth, setBitMonoHealth] = useState({
    state: 'checking',
    message: 'Checking live BitMono song search.'
  });
  const bitMonoAddonUrl = typeof window !== 'undefined'
    ? window.location.origin + '/bitmono/manifest.json'
    : '/bitmono/manifest.json';
  const [status, setStatus] = useState({ loading: true, connected: false });
  const [browserBridge, setBrowserBridge] = useState({ state: 'offline', message: 'Waiting for the local Cider bridge.' });
  const [busy, setBusy] = useState(false);
  const [connectPhase, setConnectPhase] = useState('idle');
  const [addonUrlGenerating, setAddonUrlGenerating] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState('info');
  const [copied, setCopied] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [securityPassword, setSecurityPassword] = useState('');
  const [syncNotificationWatch, setSyncNotificationWatch] = useState(() => {
    try {
      return typeof window !== 'undefined'
        && 'Notification' in window
        && Notification.permission === 'granted'
        && window.localStorage.getItem(SYNC_NOTIFICATION_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const mono = pageMode === 'mono';
    const title = mono ? 'BitMono | BitCider' : 'BitCider';
    const description = mono
      ? 'Use BitMono as your personal BitChord audio source, powered by Monochrome with Deezer fallback, complete-track caching, and smooth, seekable playback.'
      : 'Connect Cider to BitCider and create your own personal BitChord source, with encrypted account syncing and smooth, seekable audio streaming.';
    const pageUrl = mono
      ? 'https://bitcider.palabokmagtiis.workers.dev/bitmono/'
      : 'https://bitcider.palabokmagtiis.workers.dev/';

    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', pageUrl);
    document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', title);
    document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', description);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', pageUrl);
  }, [pageMode]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const mono = pageMode === 'mono';
    document.title = mono ? 'BitMono' : 'BitCider';
    const favicon = document.querySelector('link[rel~="icon"]');
    if (favicon) favicon.href = mono
      ? '/monofavicon.svg?v=bitmono-brand-20261123'
      : '/favicon.svg?v=bitcider-brand-20261122';
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = mono ? '#080808' : '#0d0708';
    const description = document.querySelector('meta[name="description"]');
    if (description) description.content = mono
      ? 'BitMono is a free Monochrome music source for BitChord.'
      : 'Connect your Cider account and use it as a personal BitChord source with BitCider.';
  }, [pageMode]);

  const [syncNotificationPermission, setSyncNotificationPermission] = useState(() => {
    try {
      return typeof window !== 'undefined' && 'Notification' in window
        ? Notification.permission
        : 'unsupported';
    } catch {
      return 'unsupported';
    }
  });

  async function refreshStatus() {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, 'BitCider status check failed (HTTP ' + response.status + ').'));
      }
      const backendCompatible = payload?.apiVersion === API_VERSION;
      setCsrfToken(payload?.csrfToken || '');
      setStatus({
        loading: false,
        ...payload,
        backendCompatible,
        deploymentWarning: backendCompatible
          ? null
          : 'It looks like that the Frontend and the Backend are not up to sync with the latest changes from the BitCider Github Repo, Try Again Later when both ends Sync.'
      });
    } catch (error) {
      setStatus({
        loading: false,
        connected: false,
        error: error?.message || 'The BitCider service could not return a readable status response.'
      });
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
    if (isAccountPopup) return undefined;
    let active = true;
    async function refreshBitConnectionAccountStatus() {
      try {
        const response = await fetch('/api/bitconnection/account', { cache: 'no-store', credentials: 'same-origin' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error('BitConnection account status unavailable.');
        if (active) setBitConnectionAccountAuthenticated(payload.authenticated === true);
      } catch {
        if (active) setBitConnectionAccountAuthenticated(false);
      }
    }
    refreshBitConnectionAccountStatus();
    const timer = window.setInterval(refreshBitConnectionAccountStatus, 15000);
    const refreshOnFocus = () => refreshBitConnectionAccountStatus();
    window.addEventListener('focus', refreshOnFocus);
    function onAccountPopupMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'BITCIDER_ACCOUNT_POPUP_READY' && event.source === window.__bitciderAccountPopup) {
        if (window.__bitciderAccountPopupPending) {
          event.source.postMessage(window.__bitciderAccountPopupPending, window.location.origin);
        }
        return;
      }
      if (event.data?.type === 'BITCIDER_ACCOUNT_SETUP_COMPLETE' && event.source === window.__bitciderAccountPopup) {
        const popup = window.__bitciderAccountPopup;
        window.__bitciderAccountPopup = null;
        window.__bitciderAccountPopupPending = null;
        try { if (popup && !popup.closed) popup.close(); } catch {}
        setInlineAccountFlow(null);
        setNotice('Your BitCider account is ready. Your saved Cider connection has been restored.');
        setNoticeType('success');
        refreshStatus();
        setConnectPhase('promoting');
        window.setTimeout(() => setConnectPhase(current => current === 'promoting' ? 'idle' : current), 2300);
      }
    }
    window.addEventListener('message', onAccountPopupMessage);
    refreshStatus();
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
      window.removeEventListener('message', onAccountPopupMessage);
    };
  }, [isAccountPopup]);
  
  useEffect(() => {
    refreshStatus();
    // Keep last-active timestamps meaningful for the five-device limit while
    // this account page remains open, even when the user is just listening.
    const heartbeat = window.setInterval(refreshStatus, 30000);
    return () => window.clearInterval(heartbeat);
  }, []);

  useEffect(() => {
    if (isAccountPopup || pageMode !== 'mono') return undefined;

    let active = true;
    let inFlight = false;
    let useLegacySearchHealth = false;

    async function checkBitMonoHealth() {
      if (!active || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;

      const startedAt = performance.now();
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      const slowTimer = window.setTimeout(() => {
        if (!active || !inFlight) return;
        const elapsedMs = Math.round(performance.now() - startedAt);
        const message = 'Live BitMono search is taking longer than 2 seconds (' + elapsedMs + ' ms).';
        setBitMonoHealth({ state: 'slow', message, durationMs: elapsedMs });
        console.warn('[BitMono health] Live song search is delayed.', {
          endpoint: useLegacySearchHealth ? '/bitmono/search' : '/api/bitmono/health',
          query: 'Daft Punk',
          elapsedMs,
          note: 'The health check exercises the live song-search pipeline used by the addon.'
        });
      }, 2000);

      try {
        let usingSearchFallback = useLegacySearchHealth;
        let endpoint = usingSearchFallback
          ? '/bitmono/search?q=Daft%20Punk'
          : '/api/bitmono/health';
        let response = await fetch(endpoint, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        let payload = await response.json().catch(() => null);

        // Older Deplexo backend builds expose the production search route but
        // do not yet include the dedicated /api/bitmono/health diagnostic.
        // Detect that once, then use the real search route as a compatibility
        // probe instead of logging a 404 every few seconds.
        if (!usingSearchFallback && response.status === 404) {
          useLegacySearchHealth = true;
          usingSearchFallback = true;
          endpoint = '/bitmono/search?q=Daft%20Punk';
          response = await fetch(endpoint, {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: controller.signal
          });
          payload = await response.json().catch(() => null);
          if (active) {
            console.warn('[BitMono health] Dedicated health route is not deployed yet; using live search compatibility check.', {
              healthEndpoint: '/api/bitmono/health',
              fallbackEndpoint: endpoint,
              fallbackHttpStatus: response.status
            });
          }
        }

        if (!active) return;

        if (usingSearchFallback) {
          const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
          const provider = tracks.some(track => String(track?.id || '').startsWith('dzr_'))
            ? 'deezer'
            : 'monochrome';
          payload = {
            ok: response.ok && tracks.length > 0,
            status: response.ok && tracks.length > 0 ? 'good' : 'bad',
            statusMessage: tracks.length
              ? 'BitMono live search is working. Using the search route as a compatibility health check until the backend health route is deployed.'
              : 'The BitMono compatibility search returned no tracks. Check the live search backend.',
            requestId: response.headers.get('X-BitMono-Request-Id') || payload?.requestId || null,
            provider: tracks.length ? provider : null,
            resultCount: tracks.length,
            sampleTracks: tracks.slice(0, 3).map(track => ({
              title: String(track?.title || '').slice(0, 90),
              artist: String(track?.artist || '').slice(0, 90),
              provider: String(track?.id || '').startsWith('dzr_') ? 'deezer' : 'monochrome'
            })),
            error: payload?.error || null,
            message: payload?.message || null
          };
        }

        const clientLatencyMs = Math.round(performance.now() - startedAt);
        const details = {
          requestId: response.headers.get('X-BitMono-Request-Id') || payload?.requestId || null,
          httpStatus: response.status,
          endpoint,
          healthEndpointFallback: usingSearchFallback,
          clientLatencyMs,
          serverDurationMs: payload?.durationMs == null ? null : (Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null),
          provider: payload?.provider || null,
          resultCount: Number(payload?.resultCount || 0),
          sampleTracks: Array.isArray(payload?.sampleTracks) ? payload.sampleTracks : [],
          diagnostics: Array.isArray(payload?.diagnostics) ? payload.diagnostics : [],
          error: payload?.error || null,
          message: payload?.message || null
        };

        if (!response.ok || payload?.ok !== true || details.resultCount < 1) {
          const message = payload?.message || 'Live BitMono song search failed (HTTP ' + response.status + ').';
          setBitMonoHealth({ state: 'bad', message, ...details });
          if (usingSearchFallback) {
            console.warn('[BitMono health] Live search compatibility check is unavailable.', details);
          } else {
            console.error('[BitMono health] Live song search failed.', details);
          }
          return;
        }

        const clientIsSlow = clientLatencyMs >= 2000;
        const state = payload?.status === 'slow' || clientIsSlow ? 'slow' : 'good';
        const message = clientIsSlow && payload?.status !== 'slow'
          ? 'Songs are returning, but the full browser-to-addon health request is taking longer than 2 seconds.'
          : (payload?.statusMessage || (state === 'slow'
            ? 'BitMono is returning songs, but the live source is degraded or slow.'
            : 'BitMono live song search returned tracks.'));
        setBitMonoHealth({ state, message, ...details });

        if (state === 'slow') {
          console.warn('[BitMono health] Live song search is degraded.', details);
        }
      } catch (error) {
        if (!active) return;
        const clientLatencyMs = Math.round(performance.now() - startedAt);
        const message = error?.name === 'AbortError'
          ? 'BitMono live song search did not respond within 20 seconds.'
          : (error?.message || 'BitMono health check could not reach the addon backend.');
        const details = {
          endpoint: useLegacySearchHealth ? '/bitmono/search' : '/api/bitmono/health',
          query: 'Daft Punk',
          healthEndpointFallback: useLegacySearchHealth,
          clientLatencyMs,
          error: error?.message || String(error),
          aborted: error?.name === 'AbortError'
        };
        setBitMonoHealth({ state: 'bad', message, ...details });
        console.error('[BitMono health] Could not complete the live song search.', details);
      } finally {
        window.clearTimeout(timeout);
        window.clearTimeout(slowTimer);
        inFlight = false;
      }
    }

    setBitMonoHealth({ state: 'checking', message: 'Checking live BitMono song search.' });
    void checkBitMonoHealth();
    const interval = window.setInterval(checkBitMonoHealth, 30000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkBitMonoHealth();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isAccountPopup, pageMode]);

  useEffect(() => {
    if (isAccountPopup || status.loading || !status.connected || !status.addonUrl
      || !csrfToken || status.backendCompatible !== true || status.tokenEncryptionConfigured !== true) {
      if (!status.connected) setBrowserBridge({ state: 'offline', message: 'Link Cider to start the in-browser bridge.' });
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    setBrowserBridge({ state: 'connecting', message: 'Connecting this browser to Cider on this computer…' });

    runCiderBrowserRelay({
      addonUrl: status.addonUrl,
      csrfToken,
      signal: controller.signal,
      onState: (state, message) => {
        if (!active) return;
        setBrowserBridge({ state, message });
        setStatus(current => ({
          ...current,
          ciderBridgeConfigured: state === 'connected',
          ciderRelay: {
            ...(current.ciderRelay || {}),
            provisioned: true,
            online: state === 'connected',
            lastSeenAt: state === 'connected' ? new Date().toISOString() : (current.ciderRelay?.lastSeenAt || null),
            mode: 'browser'
          }
        }));
      }
    }).catch(error => {
      if (!active || controller.signal.aborted) return;
      setBrowserBridge({
        state: 'reconnecting',
        message: error?.message || 'The browser could not keep the local Cider connection open.'
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [isAccountPopup, status.loading, status.connected, status.addonUrl, status.backendCompatible, status.tokenEncryptionConfigured, status.account?.authenticated, status.ciderConnectionUpdatedAt, csrfToken]);

  async function enableSyncNotification() {
    if (!('Notification' in window)) {
      setSyncNotificationPermission('unsupported');
      setNotice('This browser does not support desktop notifications.');
      setNoticeType('warning');
      return;
    }

    try {
      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
      setSyncNotificationPermission(permission);

      if (permission !== 'granted') {
        setSyncNotificationWatch(false);
        try { window.localStorage.removeItem(SYNC_NOTIFICATION_KEY); } catch {}
        setNotice(permission === 'denied'
          ? 'Notifications are blocked for this website. Allow them in your browser site settings, then try again.'
          : 'Notification permission was not granted.');
        setNoticeType('warning');
        return;
      }

      window.localStorage.setItem(SYNC_NOTIFICATION_KEY, '1');
      setSyncNotificationWatch(true);
      setNotice('Notifications are enabled. Keep this BitCider page open and we’ll let you know when both ends sync.');
      setNoticeType('success');
    } catch (error) {
      setNotice(error?.message || 'Could not enable browser notifications.');
      setNoticeType('warning');
    }
  }

  useEffect(() => {
    if (!syncNotificationWatch) return undefined;

    let stopped = false;
    let checking = false;

    function finishSyncNotification() {
      if (stopped || !('Notification' in window) || Notification.permission !== 'granted') return;
      // Clear the opt-in before displaying so a refresh or overlapping check
      // cannot produce a duplicate notification.
      try { window.localStorage.removeItem(SYNC_NOTIFICATION_KEY); } catch {}
      setSyncNotificationWatch(false);
      setSyncNotificationPermission(Notification.permission);
      try {
        new Notification('BitCider', {
          body: 'Both ends are now in Sync',
          tag: 'bitcider-frontend-backend-synced',
          renotify: false
        });
      } catch (error) {
        console.warn('BitCider sync notification could not be displayed:', error);
      }
    }

    if (!('Notification' in window) || Notification.permission !== 'granted') {
      setSyncNotificationWatch(false);
      try { window.localStorage.removeItem(SYNC_NOTIFICATION_KEY); } catch {}
      return undefined;
    }

    // refreshStatus can discover the matching API version before the polling
    // request does. Handle that transition here too, without missing the alert.
    if (status.backendCompatible === true) {
      finishSyncNotification();
      return undefined;
    }

    async function checkForSync() {
      if (stopped || checking) return;
      checking = true;
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        if (stopped || payload?.apiVersion !== API_VERSION) return;
        finishSyncNotification();
      } catch {
        // A temporary network/backend failure is not a sync event. Keep polling.
      } finally {
        checking = false;
      }
    }

    checkForSync();
    const interval = window.setInterval(checkForSync, 15000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') checkForSync();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [syncNotificationWatch, status.backendCompatible]);

  async function postAccountAction(path, payload = {}) {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BitCider-CSRF': csrfToken
      },
      cache: 'no-store',
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(getErrorMessage(result, 'The account security action could not be completed.'));
    return result;
  }

  async function signInWithPasskey() {
    setAccountBusy(true);
    setNotice('Waiting for your passkey…');
    setNoticeType('info');
    try {
      const optionsJSON = await postAccountAction('/api/account/passkeys/auth/options');
      const authentication = await startAuthentication({ optionsJSON });
      const result = await postAccountAction('/api/account/passkeys/auth/verify', authentication);
      setNotice(result.evictedDevice
        ? 'Signed in with your passkey. ' + result.evictedDevice + ' was signed out to keep the five-device limit.'
        : 'Signed in with your passkey. Your saved Cider connection has been restored.');
      setNoticeType('success');
      await refreshStatus();
    } catch (error) {
      setNotice(error?.message || 'Passkey sign-in was cancelled or could not be completed.');
      setNoticeType('warning');
    } finally {
      setAccountBusy(false);
    }
  }

  async function addPasskey() {
    if (!securityPassword) {
      setNotice('Enter your current BitCider passphrase to add a passkey.');
      setNoticeType('warning');
      return;
    }
    setAccountBusy(true);
    setNotice('Opening your device’s passkey setup…');
    setNoticeType('info');
    try {
      const deviceName = passkeyName.trim().slice(0, 40);
      const optionsJSON = await postAccountAction('/api/account/passkeys/register/options', {
        password: securityPassword
      });
      const registration = await startRegistration({ optionsJSON });
      const result = await postAccountAction('/api/account/passkeys/register/verify', {
        ...registration,
        deviceName
      });
      setSecurityPassword('');
      setPasskeyName('');
      setNotice('Passkey added. You can now sign in with it on this website.');
      setNoticeType('success');
      await refreshStatus();
    } catch (error) {
      setNotice(error?.message || 'Could not add that passkey. Try again.');
      setNoticeType('warning');
    } finally {
      setAccountBusy(false);
    }
  }

  async function removePasskey(credentialId) {
    if (!securityPassword) {
      setNotice('Enter your current BitCider passphrase to remove a passkey.');
      setNoticeType('warning');
      return;
    }
    setAccountBusy(true);
    try {
      await postAccountAction('/api/account/passkeys/remove', {
        credentialId,
        password: securityPassword
      });
      setSecurityPassword('');
      setNotice('Passkey removed from your BitCider account.');
      setNoticeType('success');
      await refreshStatus();
    } catch (error) {
      setNotice(error?.message || 'Could not remove that passkey.');
      setNoticeType('warning');
    } finally {
      setAccountBusy(false);
    }
  }

  async function revokeDevice(sessionIdHash) {
    if (!securityPassword) {
      setNotice('Enter your current BitCider passphrase to revoke a device.');
      setNoticeType('warning');
      return;
    }
    setAccountBusy(true);
    try {
      await postAccountAction('/api/account/devices/revoke', {
        sessionIdHash,
        password: securityPassword
      });
      setSecurityPassword('');
      setNotice('That device has been signed out of your BitCider account.');
      setNoticeType('success');
      await refreshStatus();
    } catch (error) {
      setNotice(error?.message || 'Could not revoke that device.');
      setNoticeType('warning');
    } finally {
      setAccountBusy(false);
    }
  }

  async function copyRecoveryCodes() {
    if (!recoveryCodes.length) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join(String.fromCharCode(10)));
      setNotice('Recovery codes copied. Store them somewhere private and offline.');
      setNoticeType('success');
    } catch {
      setNotice('Clipboard access was blocked. Select and copy the recovery codes manually.');
      setNoticeType('warning');
    }
  }

  function openAccountPopup() {
    try {
      const popup = window.open(
        '/?account=setup',
        'BitCiderAccountSetup',
        'popup=yes,width=560,height=780,resizable=yes,scrollbars=yes'
      );
      if (popup) {
        window.__bitciderAccountPopup = popup;
        window.__bitciderAccountPopupPending = null;
        popup.focus();
        return popup;
      }
    } catch {}
    return null;
  }

  function sendAccountFlow(popup, flow) {
    const message = {
      type: 'BITCIDER_ACCOUNT_FLOW',
      flow: flow.flow,
      ciderLinked: flow.ciderLinked === true,
      hasPasskeys: flow.hasPasskeys === true
    };
    if (popup && !popup.closed) {
      window.__bitciderAccountPopupPending = message;
      try { popup.postMessage(message, window.location.origin); } catch {}
      return;
    }
    setInlineAccountFlow(message);
  }

  function continuePendingAccountSetup() {
    const popup = openAccountPopup();
    sendAccountFlow(popup, { flow: 'new' });
  }

  async function saveToken(token, grantedScopes = SCOPES) {
    const response = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BitCider-CSRF': csrfToken },
      cache: 'no-store',
      body: JSON.stringify({ token, scopes: grantedScopes, authMethod: 'cider-api-auth-request' })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(getErrorMessage(payload, 'Could not save the Cider connection.'));
    return payload;
  }

  async function requestCiderToken() {
    // Chrome 142+ gates HTTPS-to-loopback requests behind its Loopback network
    // permission. Check the state first, then make the request from this click.
    if (navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({ name: 'loopback-network' });
        if (permission.state === 'denied') {
          throw new Error('Chrome is blocking BitCider from reaching Cider on this computer. Open this site’s permissions, set Loopback network access to Allow, reload BitCider, and try again.');
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Loopback network access')) throw error;
        // Older browsers do not recognize the granular permission name.
      }
    }

    let response;
    try {
      response = await fetch('http://127.0.0.1:10767/api/v2/auth/request', {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_name: 'BitCider', scopes: SCOPES }),
        cache: 'no-store',
        credentials: 'omit',
        targetAddressSpace: 'loopback',
        signal: AbortSignal.timeout(125000)
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error('Cider authorization timed out. Make sure Cider is open, allow BitCider to access your local network when Chrome asks, then try again.');
      }
      throw new Error('Could not reach Cider’s local API. Make sure Cider is open and allow **Loopback network** access for this BitCider website in Chrome Site settings.');
    }

    const payload = await response.json().catch(() => ({}));
    const apiError = payload?.error;
    const errorCode = typeof apiError === 'object'
      ? apiError?.code
      : (typeof apiError === 'string' && /^[A-Z0-9_]+$/.test(apiError) ? apiError : payload?.code || '');
    const apiMessage = typeof apiError === 'object'
      ? apiError?.message
      : (typeof apiError === 'string' && errorCode !== apiError ? apiError : payload?.message || '');

    const knownErrors = {
      AUTH_REQUEST_TIMEOUT: 'Cider’s approval dialog timed out. Keep Cider open and try connecting again.',
      AUTH_REQUEST_BUSY: 'Cider already has an approval dialog open. Finish or dismiss that dialog before trying again.',
      AUTH_REQUEST_COOLDOWN: 'Cider is limiting new authorization requests. Wait at least 5 seconds, then try again.',
      AUTH_REQUEST_BANNED: 'Cider temporarily blocked new authorization requests after repeated denials. Wait 15 minutes before trying again.',
      AUTH_RESPONSE_MALFORMED: 'Cider returned an unexpected authorization response. Update or restart Cider, then try again.'
    };

    if (!response.ok) {
      if (response.status === 404 || response.status === 405) {
        throw new Error('This Cider version does not support the authorization API. Update Cider and try again.');
      }
      const authorizationError = new Error(knownErrors[errorCode] || apiMessage || 'Cider could not authorize BitCider (HTTP ' + response.status + '). Check Cider and try again.');
      authorizationError.code = errorCode;
      throw authorizationError;
    }

    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const token = typeof data?.token === 'string' ? data.token.trim() : '';
    // Match only actual CR/LF characters. Escaping these twice would reject
    // ordinary token characters such as "r" and "n".
    if (token.length < 12 || token.length > 8192 || token.includes(String.fromCharCode(10)) || token.includes(String.fromCharCode(13))){
      throw new Error('Cider returned an invalid authorization response. Please try again.');
    }
    const grantedScopes = Array.isArray(data?.scopes)
      ? data.scopes.filter(scope => SCOPES.includes(scope))
      : SCOPES;
    if (!grantedScopes.length) {
      throw new Error('Cider approved BitCider without any of the requested permissions. Please authorize at least one requested scope.');
    }
    return { token, scopes: grantedScopes };
  }

  async function connectCider() {
    if (status.backendCompatible !== true) {
      setNotice('The Deplexo backend needs to be updated before Cider can be linked. Redeploy BitCider main and reload this page.');
      setNoticeType('warning');
      return;
    }
    if (status.tokenEncryptionConfigured !== true) {
      setNotice('Secure account storage is not configured on the BitCider backend yet. Add the Deplexo encryption secret before linking Cider.');
      setNoticeType('warning');
      return;
    }
    // Open synchronously from the Connect click so the browser does not block
    // the compact account window after Cider's native consent flow completes.
    const popup = openAccountPopup();
    setBusy(true);
    setConnectPhase('connecting');
    setNotice('Requesting access from Cider. Approve the BitCider dialog in the Cider app.');
    setNoticeType('info');
    try {
      const authorization = await requestCiderToken();
      setNotice('Cider approved BitCider. Checking whether this token is already linked…');
      setAddonUrlGenerating(true);
      let result;
      try {
        result = await saveToken(authorization.token, authorization.scopes);
      } finally {
        setAddonUrlGenerating(false);
      }

      if (result.accountLinked) {
        if (result.alreadyAuthenticated) {
          if (popup && !popup.closed) popup.close();
          window.__bitciderAccountPopup = null;
          window.__bitciderAccountPopupPending = null;
          setNotice('This Cider connection is already saved to your signed-in BitCider account.');
          setNoticeType('success');
          await refreshStatus();
          setConnectPhase('promoting');
          window.setTimeout(() => setConnectPhase(current => current === 'promoting' ? 'idle' : current), 2300);
        } else {
          setNotice('This Cider connection already belongs to a BitCider account. Sign in to restore it.');
          setNoticeType('info');
          sendAccountFlow(popup, {
            flow: 'existing',
            ciderLinked: true,
            hasPasskeys: result.hasPasskeys
          });
        }
      } else if (result.savedToCurrentAccount) {
        if (popup && !popup.closed) popup.close();
        window.__bitciderAccountPopup = null;
        window.__bitciderAccountPopupPending = null;
        setNotice('Cider is now linked to your BitCider account.');
        setNoticeType('success');
        await refreshStatus();
        setConnectPhase('promoting');
        window.setTimeout(() => setConnectPhase(current => current === 'promoting' ? 'idle' : current), 2300);
      } else {
        // Reflect the newly staged token immediately. If the popup is closed,
        // the main connection card can still offer a Continue Account Setup action.
        await refreshStatus();
        setNotice('Cider is linked on this device. Finish creating your BitCider account in the account window.');
        setNoticeType('info');
        sendAccountFlow(popup, { flow: 'new' });
      }
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      window.__bitciderAccountPopup = null;
      window.__bitciderAccountPopupPending = null;
      if (error?.code === 'AUTH_REQUEST_DENIED') {
        setNotice('');
        setConnectPhase('denied');
        try {
          if (window.matchMedia?.('(pointer: coarse)').matches && typeof navigator.vibrate === 'function') {
            navigator.vibrate([85, 45, 85]);
          }
        } catch {}
        window.setTimeout(() => {
          setConnectPhase(current => current === 'denied' ? 'denied-return' : current);
          window.setTimeout(() => setConnectPhase(current => current === 'denied-return' ? 'idle' : current), 660);
        }, 1160);
      } else {
        setNotice(error.message || 'Could not complete Cider authorization.');
        setNoticeType('warning');
        setConnectPhase('idle');
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyAddonUrl() {
    if (!status.addonUrl) return;
    try {
      await navigator.clipboard.writeText(status.addonUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice('Clipboard access was blocked. Select and copy the URL manually.');
      setNoticeType('warning');
    }
  }

  async function copyBitMonoAddonUrl() {
    try {
      await navigator.clipboard.writeText(bitMonoAddonUrl);
      setBitMonoCopied(true);
      window.setTimeout(() => setBitMonoCopied(false), 1800);
    } catch {
      setNotice('Clipboard access was blocked. Select and copy the BitMono URL manually.');
      setNoticeType('warning');
    }
  }

  function updateModeDrag(event) {
    const drag = modeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    const trackRect = event.currentTarget.getBoundingClientRect();
    const thumbWidth = Math.max(1, trackRect.width / 2 - 5);
    const minLeft = 5;
    const maxLeft = Math.max(minLeft, trackRect.width - 5 - thumbWidth);
    const thumbLeft = Math.min(maxLeft, Math.max(minLeft, event.clientX - trackRect.left - drag.grabOffset));
    drag.progress = (thumbLeft - minLeft) / Math.max(1, maxLeft - minLeft);
    if (Math.abs(event.clientX - drag.startX) >= 8) drag.moved = true;
    setModeDragProgress(drag.progress);
    return true;
  }

  function beginModeDrag(event) {
    if (modeTransitionPhase !== 'idle' || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const dragTarget = event.target instanceof Element
      ? event.target.closest('.mode-toggle-thumb, .mode-toggle-option')
      : null;
    if (!dragTarget) return;
    const option = dragTarget.closest('.mode-toggle-option');
    // The active half is also a grab surface; the other half remains a normal click target.
    if (option && option.dataset.source !== pageMode) return;
    const thumb = event.currentTarget.querySelector('.mode-toggle-thumb');
    if (!thumb) return;

    const thumbRect = thumb.getBoundingClientRect();
    const startProgress = pageMode === 'mono' ? 1 : 0;
    modeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      grabOffset: event.clientX - thumbRect.left,
      progress: startProgress,
      moved: false
    };
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
    setModeDragProgress(startProgress);
  }

  function finishModeDrag(event) {
    const drag = modeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateModeDrag(event);
    const shouldSwitch = drag.moved;
    const nextMode = drag.progress >= 0.5 ? 'mono' : 'cider';
    if (shouldSwitch) modeSuppressClickUntilRef.current = Date.now() + 350;
    modeDragRef.current = null;
    setModeDragProgress(null);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}
    if (shouldSwitch && nextMode !== pageMode) switchPageMode(nextMode);
  }

  function cancelModeDrag(event) {
    const drag = modeDragRef.current;
    if (!drag || (event?.pointerId != null && drag.pointerId !== event.pointerId)) return;
    modeDragRef.current = null;
    setModeDragProgress(null);
  }

  function handleSourceChoice(nextMode) {
    // Pointer capture can generate a trailing click after a drag. Ignore that click
    // so it cannot undo the mode selected by the drag.
    if (Date.now() < modeSuppressClickUntilRef.current) return;
    switchPageMode(nextMode);
  }

  function handleModeSliderKeyDown(event) {
    if (modeTransitionPhase !== 'idle') return;
    if (event.key === 'ArrowLeft' || event.key === 'Home') {
      event.preventDefault();
      switchPageMode('cider');
    } else if (event.key === 'ArrowRight' || event.key === 'End') {
      event.preventDefault();
      switchPageMode('mono');
    }
  }

  function setPageModeAndRoute(nextMode) {
    setPageMode(nextMode);
    const nextPath = nextMode === 'mono' ? '/bitmono/' : '/';
    if (window.location.pathname !== nextPath) {
      window.history.replaceState(
        window.history.state,
        '',
        nextPath + window.location.search + window.location.hash
      );
    }
  }

  function switchPageMode(nextMode) {
    if (nextMode !== 'cider' && nextMode !== 'mono') return;
    if (modeTransitionPhase !== 'idle' || nextMode === pageMode) return;
    setModeTransitionTarget(nextMode);

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      setPageModeAndRoute(nextMode);
      setModeTransitionTarget('');
      return;
    }

    // One shared timeline coordinates the outgoing brand, visual handoff and incoming reveal.
    setModeTransitionPhase('encrypt');
    window.setTimeout(() => {
      setModeTransitionPhase('handoff');
      setPageModeAndRoute(nextMode);

      window.setTimeout(() => {
        setModeTransitionPhase('decrypt');
        window.setTimeout(() => {
          setModeTransitionPhase('idle');
          setModeTransitionTarget('');
        }, 820);
      }, 220);
    }, 500);
  }

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch('/api/disconnect', {
        method: 'POST',
        headers: { 'X-BitCider-CSRF': csrfToken }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(getErrorMessage(payload, 'Could not disconnect.'));
      setNotice('Cider has been disconnected from this BitCider instance.');
      setNoticeType('info');
      setConnectPhase('idle');
      await refreshStatus();
    } catch (error) {
      setNotice(error.message);
      setNoticeType('warning');
    } finally {
      setBusy(false);
    }
  }

  const selectorMode = modeDragProgress === null
    ? (modeTransitionTarget || pageMode)
    : (modeDragProgress >= 0.5 ? 'mono' : 'cider');
  const connected = Boolean(status.connected);

  if (isAccountPopup) return <AccountSetupWindow />;

  return (
    <main className={`site-shell ${pageMode === 'mono' ? 'mono-mode' : 'cider-mode'} ${modeTransitionPhase !== 'idle' ? `mode-phase-${modeTransitionPhase} mode-target-${modeTransitionTarget}` : ''}`}>
      <BackgroundSwitcher warping={addonUrlGenerating} mode={pageMode} />
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <a className={`brand ${pageMode === 'mono' ? 'is-mono' : 'is-cider'}`} href="/" aria-label={pageMode === 'mono' ? 'BitMono home' : 'BitCider home'}>
          <span className="brand-logo-stack" aria-hidden="true">
            <img className="brand-logo brand-logo-cider" src="/favicon.svg?v=bitcider-brand-20261122" alt="" />
            <img className="brand-logo brand-logo-mono" src="/monofavicon.svg?v=bitmono-brand-20261123" alt="" />
          </span>
          <span className="brand-word-stack" aria-hidden="true">
            <span className="brand-word brand-word-cider">Bit<span><CipherText text="Cider" phase={modeTransitionPhase} /></span></span>
            <span className="brand-word brand-word-mono">Bit<span><CipherText text="Mono" phase={modeTransitionPhase} /></span></span>
          </span>
        </a>
        {(status.account?.authenticated === true || bitConnectionAccountAuthenticated) && (
          <button className="account-avatar-trigger" type="button" onClick={() => setAccountOverlayOpen(true)} aria-label="Open BitAccount Center" title="BitAccount">
            <Icon name="account" size={21} />
          </button>
        )}
      </header>

      {accountOverlayOpen && (
        <AccountManagementOverlay
          status={status}
          csrfToken={csrfToken}
          bitConnectionAuthenticated={bitConnectionAccountAuthenticated}
          onClose={() => setAccountOverlayOpen(false)}
          onStatusRefresh={refreshStatus}
          onDeleted={async () => {
            setPageMode('cider');
            setModeSwitcherOpen(false);
            setModeDragProgress(null);
            setInlineAccountFlow(null);
            setNotice('');
            setConnectPhase('idle');
            setRecoveryCodes([]);
            setSecurityPassword('');
            setSyncNotificationWatch(false);
            setStatus({ loading: true, connected: false });
            setBrowserBridge({ state: 'offline', message: 'Waiting for the local Cider bridge.' });
            await refreshStatus();
          }}
        />
      )}

      <section className="hero">
        <div className="hero-copy">
          {pageMode === 'mono' ? (
            <>
              <div className="eyebrow"><span className="eyebrow-line" /> MONOCHROME × BITCHORD</div>
              <h1>Your <span className="monochrome-word"><CipherText text="Monochrome." phase={modeTransitionPhase} /></span><br /><span className="bitchord-word">Your BitChord.</span></h1>
              <p className="hero-description">
                Use Monochrome as your free personal music source in BitChord. Copy the BitMono addon link below to add it.
              </p>
            </>
          ) : (
            <>
              <div className="eyebrow"><span className="eyebrow-line" /> CIDER × BITCHORD</div>
              <h1>Your <span className="cider-word"><CipherText text="Cider." phase={modeTransitionPhase} /></span><br /><span className="bitchord-word">Your BitChord.</span></h1>
              <p className="hero-description">
                Connect your Cider account now to use as a source within BitChord as your personal source of music.
              </p>
            </>
          )}
        </div>

        <div className="connection-column">
        <section className="connection-card" aria-live="polite">
          <div className="source-mode-content">
          {pageMode === 'mono' ? (
            <div className="bitmono-card-content">
              <div className="card-heading bitmono-card-heading">
                <span className="bitmono-card-mark"><img src="/monochrome-logo.svg?v=bitmono-brand-20261123" alt="" /></span>
                <div>
                  <h2>BitMono is ready</h2>
                  <p>A free Monochrome music source for BitChord. No account linking or addon payment is required.</p>
                </div>
              </div>
              <div className="addon-url-panel bitmono-url-panel">
                <div className="bitmono-url-panel-head">
                  <div className="scope-title">FREE BITMONO ADDON URL</div>
                  <span
                    className={`bitmono-health-dot is-${bitMonoHealth.state}`}
                    role="status"
                    aria-label={`BitMono song search status: ${bitMonoHealth.state}. ${bitMonoHealth.message || ''}`}
                    title={bitMonoHealth.message || 'Checking live BitMono song search.'}
                  />
                </div>
                <div className="url-row bitmono-url-row">
                  <input className="bitmono-url-input" type="text" value={bitMonoAddonUrl} readOnly aria-label="BitMono addon URL" onFocus={event => event.currentTarget.select()} />
                  <button
                    className={`copy-button ${bitMonoCopied ? 'is-copied' : ''}`}
                    type="button"
                    onClick={copyBitMonoAddonUrl}
                    aria-label="Copy BitMono addon URL"
                  >
                    {bitMonoCopied ? <Icon name="check" /> : <Icon name="copy" />}
                  </button>
                </div>
                <div className="url-hint bitmono-free-hint">
                  <span className="tiny-dot" /> FREE · NO ACCOUNT LINKING
                </div>
              </div>
              <p className="bitmono-setup-hint">In BitChord, open Settings → Sources / Add-ons → Add custom source, then paste this URL.</p>
              <p className="bitmono-quality-note">The current Monochrome stream endpoint supplies FLAC / Lossless stereo. The extra Atmos, Hi-Res, High, and Low choices stay available in BitChord, but BitMono reports Lossless stereo until Monochrome provides those renditions.</p>
            </div>
          ) : (
            <>
          {status.backendCompatible === true && status.tokenEncryptionConfigured !== true && (
            <div className="notice notice-warning">
              Secure account storage is not configured. Add the stable 32-byte base64url BITCIDER_ENCRYPTION_KEY secret in Deplexo before linking Cider.
            </div>
          )}

          {!connected ? (
            <>
              <div className="card-heading">
                <img
                  className="library-music-icon"
                  src="/icons/library_music.svg?v=20261123-rose-library-icon01"
                  alt=""
                  aria-hidden="true"
                />
                <div>
                  <h2>Link Cider</h2>
                  <p>Approve BitCider directly in Cider. Your token is returned automatically.</p>
                </div>
              </div>
              <button
                className={`primary-button connect-button connect-phase-${connectPhase}`}
                onClick={connectCider}
                disabled={busy || connectPhase !== 'idle' || status.loading || status.backendCompatible !== true || status.tokenEncryptionConfigured !== true}
                aria-busy={connectPhase === 'connecting'}
              >
                <span className="connect-button-label">{connectPhase === 'denied' ? 'DENIED' : 'CONNECT TO CIDER'}</span>
                <span className="connect-button-dots" aria-hidden="true"><i /><i /><i /></span>
                <span className="button-icon connect-button-icon"><Icon name="arrow" /></span>
              </button>
              <p className="auth-help">Keep this page open while Cider displays its consent prompt. Approve the requested scopes in Cider, and allow Chrome’s Loopback network permission so BitCider can reach Cider on this device.</p>
            </>
          ) : (
            <>
              <div className={`card-heading connected-heading ${connectPhase === 'promoting' ? 'is-entering' : ''}`}>
                <div className="success-icon"><Icon name="check" size={24} /></div>
                <div>
                  <h2>Cider is linked</h2>
                  <p>{status.pendingAccountSetup ? 'Finish securing this Cider link with a BitCider account.' : 'Your personal source is ready to add.'}</p>
                </div>
              </div>
              {status.pendingAccountSetup ? (
                <div className="pending-account-panel">
                  <div className="scope-title">SAVE THIS CONNECTION</div>
                  <p>Your Cider token is safely staged on this device. Create your BitCider account to keep it available when you sign in elsewhere.</p>
                  <button className="primary-button pending-account-button" type="button" onClick={continuePendingAccountSetup}>
                    <span>CONTINUE ACCOUNT SETUP</span>
                    <span className="button-icon"><Icon name="arrow" /></span>
                  </button>
                </div>
              ) : (
                <div className={`addon-url-panel ${connectPhase === 'promoting' ? 'is-entering' : ''}`}>
                  <div className="scope-title">YOUR BITCHORD ADDON URL</div>
                  <div className="url-row">
                    <code>{status.addonUrl}</code>
                    <button
                      className={`copy-button ${connectPhase === 'promoting' ? 'copy-button-entering' : ''} ${copied ? 'is-copied' : ''}`}
                      onClick={copyAddonUrl}
                      aria-label="Copy addon URL"
                    >
                      {copied ? <Icon name="check" /> : <Icon name="copy" />}
                    </button>
                  </div>
                  <div className="url-hint">
                    <span className="tiny-dot" />
                    {status.publicUrlConfigured ? 'Public endpoint configured' : 'Local network endpoint'}
                  </div>
                </div>
              )}
              {connected && (
                <section className="cider-relay-panel" aria-label="In-browser Cider bridge">
                  <div className="cider-relay-panel-head">
                    <div>
                      <div className="scope-title">IN-BROWSER CIDER BRIDGE</div>
                      <p>BitCider connects to the Cider app through this browser tab.</p>
                    </div>
                    <span className={`cider-relay-state ${browserBridge.state === 'connected' ? 'is-online' : 'is-offline'}`}>
                      <i />
                      {browserBridge.state === 'connected'
                        ? 'ONLINE'
                        : browserBridge.state === 'cider-auth-required'
                          ? 'RECONNECT CIDER'
                          : browserBridge.state === 'cider-access-blocked'
                          ? 'CIDER ACCESS BLOCKED'
                          : browserBridge.state === 'cider-unavailable'
                            ? 'CIDER OFFLINE'
                            : browserBridge.state === 'replaced'
                              ? 'ACTIVE IN ANOTHER TAB'
                              : browserBridge.state === 'connecting' || browserBridge.state === 'reconnecting'
                              ? 'CONNECTING'
                              : 'OFFLINE'}
                    </span>
                  </div>
                  <p className="cider-relay-copy">
                    No downloads, scripts, or installers. Keep this BitCider tab open on the computer where Cider is running while using the BitChord addon.
                  </p>
                  <p className={`cider-relay-instructions ${browserBridge.state === 'cider-unavailable' || browserBridge.state === 'cider-auth-required' || browserBridge.state === 'cider-access-blocked' || browserBridge.state === 'reconnecting' || browserBridge.state === 'replaced' ? 'cider-relay-offline-note' : ''}`}>
                    {browserBridge.message || 'Starting the local Cider connection…'}
                  </p>
                  {browserBridge.state === 'cider-auth-required' && (
                    <button
                      className="primary-button relay-reconnect-button"
                      type="button"
                      onClick={connectCider}
                      disabled={busy || connectPhase !== 'idle'}
                    >
                      <span>RECONNECT CIDER ON THIS DEVICE</span>
                      <span className="button-icon"><Icon name="arrow" /></span>
                    </button>
                  )}
                </section>
              )}
              <div className={`connected-actions ${connectPhase === 'promoting' ? 'is-promoting' : ''}`}>
                {connectPhase === 'promoting' && (
                  <button className="primary-button copy-addon-cta" type="button" disabled aria-hidden="true" tabIndex={-1}>
                    <span>COPY ADDON URL</span>
                    <span className="button-icon"><Icon name="copy" /></span>
                  </button>
                )}
                <button
                  className={`disconnect-button disconnect-primary ${connectPhase === 'promoting' ? 'is-promoting' : ''}`}
                  onClick={disconnect}
                  disabled={busy || connectPhase === 'promoting'}
                >
                  <Icon name="unplug" size={15} /> Disconnect Cider
                </button>
              </div>
            </>
          )}


          {status.backendCompatible === false && (
            <div className="notice notice-warning sync-mismatch-notice">
              <span className="sync-mismatch-copy">{status.deploymentWarning}</span>
              <button
                type="button"
                className="sync-notification-button"
                onClick={enableSyncNotification}
                disabled={syncNotificationWatch || syncNotificationPermission === 'denied' || syncNotificationPermission === 'unsupported'}
              >
                {syncNotificationWatch
                  ? 'NOTIFICATION ENABLED · WAITING FOR SYNC'
                  : syncNotificationPermission === 'denied'
                    ? 'NOTIFICATIONS BLOCKED IN BROWSER SETTINGS'
                    : syncNotificationPermission === 'unsupported'
                      ? 'BROWSER NOTIFICATIONS NOT SUPPORTED'
                      : 'NOTIFY ME WHEN BOTH ENDS SYNC'}
              </button>
              {syncNotificationWatch && (
                <span className="sync-notification-hint">Keep this page open. BitCider checks for sync every 15 seconds.</span>
              )}
            </div>
          )}
          {notice && <div className={'notice notice-' + noticeType}>{notice}</div>}
          {!notice && status.backendCompatible !== false && (status.message || status.error || status.deploymentWarning) && (
            <div className="notice notice-warning">{status.message || status.error || status.deploymentWarning}</div>
          )}
            </>
          )}
          </div>
        <div
          className={`mode-switcher ${modeSwitcherOpen ? 'is-open' : ''}`}
          aria-label="Music sources"
        >
          <div
            className="mode-switch-panel"
            id="bitcider-mode-panel"
            aria-hidden={!modeSwitcherOpen}
          >
            <div
              className={`mode-toggle ${selectorMode === 'mono' ? 'is-mono' : 'is-cider'} ${modeDragProgress !== null ? 'is-dragging' : ''} ${modeTransitionPhase !== 'idle' ? 'is-switching' : ''}`}
              role="group"
              aria-label="Choose music source"
              onPointerDown={beginModeDrag}
              onPointerMove={updateModeDrag}
              onPointerUp={finishModeDrag}
              onPointerCancel={cancelModeDrag}
              onLostPointerCapture={cancelModeDrag}
            >
              <span
                className="mode-toggle-thumb"
                style={modeDragProgress !== null ? { transform: `translateX(${modeDragProgress * 100}%)` } : undefined}
                aria-hidden="true"
              />
              <button
                className="mode-toggle-option"
                type="button"
                onClick={() => handleSourceChoice('cider')}
                data-source="cider"
                aria-pressed={selectorMode === 'cider'}
                disabled={!modeSwitcherOpen}
              >Cider</button>
              <button
                className="mode-toggle-option"
                type="button"
                onClick={() => handleSourceChoice('mono')}
                data-source="mono"
                aria-pressed={selectorMode === 'mono'}
                disabled={!modeSwitcherOpen}
              >Monochrome</button>
              <svg className="mode-warp-defs" aria-hidden="true" focusable="false">
                <defs>
                  <filter id="bitcider-source-warp" x="-20%" y="-30%" width="140%" height="160%">
                    <feTurbulence type="fractalNoise" baseFrequency="0.018 0.06" numOctaves="2" seed="8" result="warp-noise">
                      <animate attributeName="baseFrequency" values="0.018 0.06;0.055 0.025;0.018 0.06" dur="0.65s" repeatCount="indefinite" />
                    </feTurbulence>
                    <feDisplacementMap in="SourceGraphic" in2="warp-noise" scale="8" xChannelSelector="R" yChannelSelector="G" />
                  </filter>
                </defs>
              </svg>
            </div>
          </div>
          <button
            className="mode-pull-tab"
            type="button"
            onClick={() => setModeSwitcherOpen(open => !open)}
            aria-expanded={modeSwitcherOpen}
            aria-controls="bitcider-mode-panel"
          >
            <span className="mode-pull-label">Music Sources</span>
          </button>
        </div>
        </section>
        </div>
      </section>



      {pageMode === 'cider' && inlineAccountFlow && (
        <AccountSetupWindow
          inline
          initialFlow={inlineAccountFlow.flow}
          initialHasPasskeys={inlineAccountFlow.hasPasskeys}
          initialCiderLinked={inlineAccountFlow.ciderLinked}
          onClose={() => setInlineAccountFlow(null)}
          onComplete={() => {
            setInlineAccountFlow(null);
            setNotice('Your BitCider account is ready. Your saved Cider connection has been restored.');
            setNoticeType('success');
            refreshStatus();
            setConnectPhase('promoting');
            window.setTimeout(() => setConnectPhase(current => current === 'promoting' ? 'idle' : current), 2300);
          }}
        />
      )}

      {pageMode === 'cider' && !status.publicUrlConfigured && connected && !status.pendingAccountSetup && (
        <div className="network-note">
          <b>Network note</b>
          Your generated URL uses your local network address. BitChord must be able to reach this computer on the same network. For access outside your network, configure a public HTTPS tunnel and set <code>BITCIDER_PUBLIC_URL</code>.
        </div>
      )}

      <footer className="footer">
        <span className="footer-brand-group"><span className="footer-brand-name">{pageMode === 'mono' ? 'BITMONO' : 'BITCIDER'}</span><BitConnectionEntrance /></span>
        <span>{pageMode === 'mono' ? 'MADE FOR BITCHORD · POWERED BY MONOCHROME' : 'MADE FOR BITCHORD · POWERED BY CIDER'}</span>
        <a href="https://bitchord.kushagrasingh.in/docs" target="_blank" rel="noreferrer">ADDON PROTOCOL <Icon name="external" size={12} /></a>
      </footer>
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
