import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import BackgroundSwitcher from './BackgroundSwitcher.jsx';

const SCOPES = ['playback', 'queue', 'library', 'audio'];
const API_VERSION = '2026-11-23-account-key-v10';
const SYNC_NOTIFICATION_KEY = 'bitcider.sync-notification-watch.v1';
function Icon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'arrow') return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>;
  if (name === 'check') return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === 'music') return <svg {...common}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
  if (name === 'link') return <svg {...common}><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" /></svg>;
  if (name === 'shield') return <svg {...common}><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></svg>;
  if (name === 'external') return <svg {...common}><path d="M14 3h7v7M10 14 21 3" /><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" /></svg>;
  if (name === 'unplug') return <svg {...common}><path d="m16 16 3 3M2 2l20 20M7 7 4 4M14 7l3-3M7 14l-3 3" /><path d="M8 8a5 5 0 0 0 7 7" /></svg>;
  return null;
}

function getErrorMessage(payload, fallback) {
  return payload?.error?.message || payload?.message || payload?.error || fallback;
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
  const strength = passwordStrength(password);

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
      setEnrollmentPassword(password);
      setAccountKey(result.accountKey || '');
      setRecoveryCodes(Array.isArray(result.recoveryCodes) ? result.recoveryCodes : []);
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
      setAccountKey(result.accountKey || '');
      setRecoveryCodes(Array.isArray(result.recoveryCodes) ? result.recoveryCodes : []);
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
              <form className="account-popup-form" onSubmit={createAccount}>
                <label>
                  <span>CREATE A PASSWORD</span>
                  <input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Choose any password" required />
                </label>
                <div className={strengthClass} aria-live="polite">
                  <div className="password-strength-bars"><i /><i /><i /></div>
                  <strong>{strength.label}</strong>
                  <span>{strength.note}</span>
                </div>
                <label>
                  <span>CONFIRM PASSWORD</span>
                  <input type="password" autoComplete="new-password" value={passwordConfirm} onChange={event => setPasswordConfirm(event.target.value)} placeholder="Type it again" required />
                </label>
                <p className="account-popup-footnote">There is no password character-count rule. The strength indicator is only a live estimate and will never block a password by itself.</p>
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
              <form className="account-popup-form" onSubmit={signInWithPassword}>
                <label>
                  <span>ACCOUNT KEY</span>
                  <input autoComplete="off" spellCheck={false} value={accountKey} onChange={event => setAccountKey(event.target.value)} placeholder={ciderLinked ? 'Optional on this already-linked device' : 'Paste your saved Account Key'} required={!ciderLinked} />
                </label>
                <label>
                  <span>PASSWORD</span>
                  <input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Your BitCider password" required />
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

export default function App() {
  const isAccountPopup = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('account') === 'setup';
  const [inlineAccountFlow, setInlineAccountFlow] = useState(null);
  const [status, setStatus] = useState({ loading: true, connected: false });
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
  const [relayConfigBusy, setRelayConfigBusy] = useState(false);
  const [relayAgentUrl, setRelayAgentUrl] = useState('');
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
    if (isAccountPopup) return undefined;
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
    return () => window.removeEventListener('message', onAccountPopupMessage);
  }, [isAccountPopup]);
  
  useEffect(() => {
    refreshStatus();
    // Keep last-active timestamps meaningful for the five-device limit while
    // this account page remains open, even when the user is just listening.
    const heartbeat = window.setInterval(refreshStatus, 30000);
    return () => window.clearInterval(heartbeat);
  }, []);

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

  async function downloadRelayConfig() {
    if (!csrfToken || !status.account?.authenticated || relayConfigBusy) return;
    setRelayConfigBusy(true);
    setNotice('Creating your private desktop relay credentials…');
    setNoticeType('info');
    try {
      const response = await fetch('/api/relay/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BitCider-CSRF': csrfToken
        },
        cache: 'no-store',
        body: '{}'
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.config) {
        throw new Error(getErrorMessage(result, 'Could not create the local Cider relay config.'));
      }
      const blob = new Blob([JSON.stringify(result.config, null, 2)], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'bitcider-relay.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
      setRelayAgentUrl(result.agentUrl || '');
      setStatus(current => ({
        ...current,
        ciderBridgeConfigured: true,
        ciderRelay: { provisioned: true, online: false, lastSeenAt: null }
      }));
      setNotice('Your relay config was downloaded. It contains only your private relay key, not your Cider app token. The runner retrieves your encrypted Cider token from BitCider over HTTPS at startup and keeps it in memory. Keep the config private and never share it. Download the relay runner too, save both files in the same folder, then run: node bitcider-relay.mjs');
      setNoticeType('success');
    } catch (error) {
      setNotice(error?.message || 'Could not download the local Cider relay config.');
      setNoticeType('warning');
    } finally {
      setRelayConfigBusy(false);
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

  const connected = Boolean(status.connected);

  if (isAccountPopup) return <AccountSetupWindow />;

  return (
    <main className="site-shell">
      <BackgroundSwitcher warping={addonUrlGenerating} />
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <a className="brand" href="/" aria-label="BitCider home">
          <img className="brand-logo" src="/favicon.svg?v=bitcider-brand-20261122" alt="" />
          <span className="brand-word">Bit<span>Cider</span></span>
        </a>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> CIDER × BITCHORD</div>
          <h1>Your <span className="cider-word">Cider.</span><br /><span className="bitchord-word">Your BitChord.</span></h1>
          <p className="hero-description">
            Connect your Cider account once. BitCider turns that approved connection into a personal source you can add to BitChord.
          </p>
          <div className="hero-meta">
            <span><Icon name="shield" size={15} /> Your own connection</span>
            <span className="meta-separator" />
            <span><Icon name="link" size={15} /> One addon URL</span>
          </div>
        </div>

        <section className="connection-card" aria-live="polite">
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
              {status.account?.authenticated === true && (
                <section className="cider-relay-panel" aria-label="Local Cider relay setup">
                  <div className="cider-relay-panel-head">
                    <div>
                      <div className="scope-title">DESKTOP CIDER RELAY</div>
                      <p>Connect this BitCider account to Cider on the computer where you listen.</p>
                    </div>
                    <span className={`cider-relay-state ${status.ciderRelay?.online ? 'is-online' : 'is-offline'}`}>
                      <i />
                      {status.ciderRelay?.online ? 'ONLINE' : 'OFFLINE'}
                    </span>
                  </div>
                  <p className="cider-relay-copy">
                    Search and playback requests are sent through your own encrypted outbound relay. Cider’s API port stays on your computer and is never exposed to the internet.
                  </p>
                  <button
                    className="primary-button relay-config-button"
                    type="button"
                    onClick={downloadRelayConfig}
                    disabled={relayConfigBusy || !status.tokenEncryptionConfigured}
                  >
                    <span>{relayConfigBusy ? 'PREPARING CONFIG…' : status.ciderRelay?.provisioned ? 'REISSUE RELAY CONFIG' : 'DOWNLOAD RELAY CONFIG'}</span>
                    <span className="button-icon"><Icon name="arrow" /></span>
                  </button>
                  {relayAgentUrl && (
                    <a className="relay-agent-link" href={relayAgentUrl} download="bitcider-relay.mjs">
                      Download the desktop relay runner
                    </a>
                  )}
                  <p className="cider-relay-instructions">
                    Save <code>bitcider-relay.json</code> and <code>bitcider-relay.mjs</code> in the same folder. With Cider open, run <code>node bitcider-relay.mjs</code> from that folder. Keep the relay running while using the BitChord addon.
                  </p>
                  {status.ciderRelay?.provisioned && !status.ciderRelay?.online && (
                    <p className="cider-relay-offline-note">The relay key is registered, but no desktop relay has checked in yet. Starting the runner should change this to ONLINE.</p>
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

          {connected && status.ciderBridgeConfigured === false && (
            <div className="notice notice-warning addon-bridge-notice">
              {status.account?.authenticated === true
                ? 'Your Cider connection is saved, but this account has no desktop relay configured yet. Download the relay config in the Desktop Cider Relay panel above to restore addon search and playback.'
                : 'Create or sign in to a BitCider account to generate your private desktop Cider relay. Hosted addon search and playback cannot reach Cider on this computer until that relay is running.'}
            </div>
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
        </section>
      </section>

      {inlineAccountFlow && (
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

      {!status.publicUrlConfigured && connected && !status.pendingAccountSetup && (
        <div className="network-note">
          <b>Network note</b>
          Your generated URL uses your local network address. BitChord must be able to reach this computer on the same network. For access outside your network, configure a public HTTPS tunnel and set <code>BITCIDER_PUBLIC_URL</code>.
        </div>
      )}

      <footer className="footer">
        <span>BITCIDER</span>
        <span>MADE FOR BITCHORD · POWERED BY CIDER</span>
        <a href="https://bitchord.kushagrasingh.in/docs" target="_blank" rel="noreferrer">ADDON PROTOCOL <Icon name="external" size={12} /></a>
      </footer>
    </main>
  );
}
