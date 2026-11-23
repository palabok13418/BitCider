import { useEffect, useState } from 'react';
import LineWaves from './LineWaves.jsx';

const SCOPES = ['playback', 'queue', 'library', 'audio'];
const API_VERSION = '2026-11-22-secure-accounts-v2';
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

export default function App() {
  const [status, setStatus] = useState({ loading: true, connected: false });
  const [busy, setBusy] = useState(false);
  const [connectPhase, setConnectPhase] = useState('idle');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState('info');
  const [copied, setCopied] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  const [accountMode, setAccountMode] = useState('login');
  const [accountUsername, setAccountUsername] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountPasswordConfirm, setAccountPasswordConfirm] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState([]);

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
          : 'This website is newer than its Deplexo backend. Redeploy the latest BitCider main branch to Deplexo, then reload this page before linking Cider.'
      });
    } catch (error) {
      setStatus({
        loading: false,
        connected: false,
        error: error?.message || 'The BitCider service could not return a readable status response.'
      });
    }
  }

  useEffect(() => { refreshStatus(); }, []);

  async function accountRequest(path, payload) {
    setAccountBusy(true);
    setNotice('');
    try {
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
      if (!response.ok) throw new Error(getErrorMessage(result, 'The account request could not be completed.'));
      if (Array.isArray(result.recoveryCodes)) setRecoveryCodes(result.recoveryCodes);
      if (path.endsWith('/register')) {
        setNotice('Your BitCider account is ready. Save your recovery codes somewhere safe.');
        setNoticeType('success');
      } else if (path.endsWith('/recover')) {
        setNotice('Your passphrase has been reset. Save your new recovery codes, then sign in.');
        setNoticeType('success');
        setAccountMode('login');
        setAccountPassword('');
        setAccountPasswordConfirm('');
        setRecoveryCode('');
      } else {
        setNotice('You are signed in. Your saved Cider connection has been restored.');
        setNoticeType('success');
      }
      setAccountPassword('');
      setAccountPasswordConfirm('');
      await refreshStatus();
      return true;
    } catch (error) {
      setNotice(error.message || 'The account request could not be completed.');
      setNoticeType('warning');
      return false;
    } finally {
      setAccountBusy(false);
    }
  }

  async function submitAccount(event) {
    event.preventDefault();
    if (accountMode === 'register' && accountPassword !== accountPasswordConfirm) {
      setNotice('The passphrases do not match.');
      setNoticeType('warning');
      return;
    }
    if (accountMode === 'recover' && accountPassword !== accountPasswordConfirm) {
      setNotice('The new passphrases do not match.');
      setNoticeType('warning');
      return;
    }
    if (accountMode === 'register') {
      await accountRequest('/api/account/register', { username: accountUsername, password: accountPassword });
    } else if (accountMode === 'recover') {
      await accountRequest('/api/account/recover', {
        username: accountUsername,
        recoveryCode,
        newPassword: accountPassword
      });
    } else {
      await accountRequest('/api/account/login', { username: accountUsername, password: accountPassword });
    }
  }

  async function logoutAccount() {
    setAccountBusy(true);
    try {
      const response = await fetch('/api/account/logout', {
        method: 'POST',
        headers: { 'X-BitCider-CSRF': csrfToken },
        cache: 'no-store'
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(getErrorMessage(result, 'Could not sign out.'));
      setRecoveryCodes([]);
      setNotice('You have been signed out. Your cloud-saved Cider connection remains on your account.');
      setNoticeType('info');
      await refreshStatus();
    } catch (error) {
      setNotice(error.message || 'Could not sign out.');
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

  async function saveToken(token, grantedScopes = SCOPES) {
    const response = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BitCider-CSRF': csrfToken },
      body: JSON.stringify({ token, scopes: grantedScopes, authMethod: 'cider-api-auth-request' })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(getErrorMessage(payload, 'Could not save the Cider connection.'));
    setNotice('Cider is linked. Your personal BitChord source has been created.');
    setNoticeType('success');
    await refreshStatus();
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
    setBusy(true);
    setConnectPhase('connecting');
    setNotice('Requesting access from Cider. Approve the BitCider dialog in the Cider app.');
    setNoticeType('info');
    try {
      const authorization = await requestCiderToken();
      setNotice('Cider approved BitCider. Saving your encrypted connection…');
      await saveToken(authorization.token, authorization.scopes);
      setConnectPhase('promoting');
      // Keep the staged success choreography alive until the final
      // Disconnect action has finished rising into the shared button slot.
      window.setTimeout(() => {
        setConnectPhase(current => current === 'promoting' ? 'idle' : current);
      }, 2300);
    } catch (error) {
      if (error?.code === 'AUTH_REQUEST_DENIED') {
        // The red Denied animation is the only denial feedback.
        setNotice('');
        setConnectPhase('denied');
        try {
          if (window.matchMedia?.('(pointer: coarse)').matches && typeof navigator.vibrate === 'function') {
            navigator.vibrate([85, 45, 85]);
          }
        } catch {
          // The visual shake remains available when device vibration is unsupported.
        }
        // Hold the contracted red state briefly, then expand the button
        // and bring the normal label back into its original left-aligned place.
        window.setTimeout(() => {
          setConnectPhase(current => current === 'denied' ? 'denied-return' : current);
          window.setTimeout(() => {
            setConnectPhase(current => current === 'denied-return' ? 'idle' : current);
          }, 660);
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

  return (
    <main className="site-shell">
      <LineWaves
        className="site-waves"
        color1="#d7e5ff"
        color2="#aab7ff"
        color3="#80d9e8"
        colorCycleSpeed={0.22}
        speed={0.23}
        lineCount={88}
        lineWidth={1.05}
        glow={0.8}
        brightness={0.72}
        highlight={0.88}
        highlightWidth={1.15}
        warpIntensity={1.2}
        warpScale={1.1}
        rotation={-31}
        edgeFade={0.35}
        mouseInfluence={1.4}
        opacity={0.68}
      />
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
          <div className="card-topline">
            <div className="card-label">YOUR CONNECTION</div>
          </div>

          {!connected ? (
            <>
              <div className="card-heading">
                <div className="cider-icon"><Icon name="music" size={25} /></div>
                <div>
                  <h2>Link Cider</h2>
                  <p>Approve BitCider directly in Cider. Your token is returned automatically.</p>
                </div>
              </div>
              <button
                className={`primary-button connect-button connect-phase-${connectPhase}`}
                onClick={connectCider}
                disabled={busy || connectPhase !== 'idle' || status.loading || status.backendCompatible !== true}
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
                  <p>Your personal source is ready to add.</p>
                </div>
              </div>
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

          {notice && <div className={'notice notice-' + noticeType}>{notice}</div>}
          {!notice && (status.message || status.error || status.deploymentWarning) && <div className="notice notice-warning">{status.message || status.error || status.deploymentWarning}</div>}
        </section>
      </section>

      <section className="account-card" aria-label="BitCider account">
        {status.backendCompatible === true && status.tokenEncryptionConfigured !== true && (
          <div className="account-security-warning">
            <strong>Extra storage protection is not configured yet.</strong>
            Add a stable 32-byte base64url <code>BITCIDER_ENCRYPTION_KEY</code> secret to Deplexo. Existing Cider tokens will be upgraded automatically on the next backend start.
          </div>
        )}
        {status.account?.authenticated ? (
          <>
            <div className="account-card-header">
              <div>
                <div className="card-label">BITCIDER ACCOUNT</div>
                <h2>Saved to your account</h2>
                <p>Signed in as <strong>@{status.account.username}</strong>. Your Cider connection and personal addon URL are stored securely in your BitCider account.</p>
              </div>
              <button className="account-secondary-button" type="button" onClick={logoutAccount} disabled={accountBusy || status.backendCompatible !== true}>
                {accountBusy ? 'PLEASE WAIT…' : 'SIGN OUT'}
              </button>
            </div>
            <div className="account-saved-row">
              <span className="account-saved-indicator" />
              <span>{status.connected ? 'Cider connection and addon URL saved in the cloud' : 'Account saved. Connect Cider to create your personal addon URL.'}</span>
            </div>
          </>
        ) : (
          <>
            <div className="account-card-header">
              <div>
                <div className="card-label">SAVE YOUR CONNECTION</div>
                <h2>Your BitCider account</h2>
                <p>Create an account to keep your Cider connection and personal BitChord URL available when you sign in on another device.</p>
              </div>
            </div>
            <div className="account-tabs" role="tablist" aria-label="Account actions">
              <button type="button" className={accountMode === 'login' ? 'is-active' : ''} onClick={() => setAccountMode('login')} disabled={accountBusy}>SIGN IN</button>
              <button type="button" className={accountMode === 'register' ? 'is-active' : ''} onClick={() => setAccountMode('register')} disabled={accountBusy}>CREATE ACCOUNT</button>
              <button type="button" className={accountMode === 'recover' ? 'is-active' : ''} onClick={() => setAccountMode('recover')} disabled={accountBusy}>RECOVER</button>
            </div>
            <form className="account-form" onSubmit={submitAccount}>
              <label>
                <span>USERNAME</span>
                <input
                  autoComplete="username"
                  maxLength={24}
                  minLength={3}
                  value={accountUsername}
                  onChange={event => setAccountUsername(event.target.value)}
                  placeholder="your-username"
                  required
                />
              </label>
              {accountMode === 'recover' && (
                <label>
                  <span>ONE-TIME RECOVERY CODE</span>
                  <input
                    autoComplete="off"
                    value={recoveryCode}
                    onChange={event => setRecoveryCode(event.target.value)}
                    placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                    required
                  />
                </label>
              )}
              <label>
                <span>{accountMode === 'recover' ? 'NEW PASSPHRASE' : 'PASSPHRASE'}</span>
                <input
                  autoComplete={accountMode === 'login' ? 'current-password' : 'new-password'}
                  type="password"
                  minLength={14}
                  maxLength={128}
                  value={accountPassword}
                  onChange={event => setAccountPassword(event.target.value)}
                  placeholder="At least 14 characters"
                  required
                />
              </label>
              {accountMode !== 'login' && (
                <label>
                  <span>CONFIRM PASSPHRASE</span>
                  <input
                    autoComplete="new-password"
                    type="password"
                    minLength={14}
                    maxLength={128}
                    value={accountPasswordConfirm}
                    onChange={event => setAccountPasswordConfirm(event.target.value)}
                    placeholder="Enter it again"
                    required
                  />
                </label>
              )}
              <button className="account-submit-button" type="submit" disabled={accountBusy || !csrfToken || status.backendCompatible !== true}>
                {accountBusy ? 'SECURING YOUR ACCOUNT…' : accountMode === 'register' ? 'CREATE SECURE ACCOUNT' : accountMode === 'recover' ? 'RESET PASSPHRASE' : 'SIGN IN'}
              </button>
            </form>
            <p className="account-security-note">Your device keeps only a Secure, HttpOnly sign-in cookie, not your passphrase or addon URL. Passphrases use scrypt hashing; Cider tokens are encrypted on the server. Recovery codes are shown once and can each be used one time.</p>
          </>
        )}
        {recoveryCodes.length > 0 && (
          <div className="recovery-panel">
            <div className="recovery-panel-heading">
              <div>
                <div className="scope-title">ONE-TIME RECOVERY CODES</div>
                <h3>Save these before leaving</h3>
              </div>
              <button type="button" className="account-secondary-button" onClick={copyRecoveryCodes}>COPY CODES</button>
            </div>
            <p>Each code can reset your passphrase once. These codes are not stored in your browser and cannot be shown again.</p>
            <div className="recovery-codes">
              {recoveryCodes.map(code => <code key={code}>{code}</code>)}
            </div>
            <button type="button" className="account-submit-button" onClick={() => setRecoveryCodes([])}>I SAVED MY RECOVERY CODES</button>
          </div>
        )}
      </section>

      {!status.publicUrlConfigured && connected && (
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
