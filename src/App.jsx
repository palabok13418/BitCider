import { useEffect, useState } from 'react';
import LineWaves from './LineWaves.jsx';

const SCOPES = ['playback', 'queue', 'library', 'audio'];
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
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState('info');
  const [copied, setCopied] = useState(false);

  async function refreshStatus() {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, 'BitCider status check failed (HTTP ' + response.status + ').'));
      }
      setStatus({ loading: false, ...payload });
    } catch (error) {
      setStatus({
        loading: false,
        connected: false,
        error: error?.message || 'The BitCider service could not return a readable status response.'
      });
    }
  }

  useEffect(() => { refreshStatus(); }, []);

  async function saveToken(token, grantedScopes = SCOPES) {
    const response = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      AUTH_REQUEST_DENIED: 'The BitCider permission request was denied in Cider. Click Connect Cider again and approve the request in Cider’s consent dialog.',
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
      throw new Error(knownErrors[errorCode] || apiMessage || 'Cider could not authorize BitCider (HTTP ' + response.status + '). Check Cider and try again.');
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
    setBusy(true);
    setNotice('Requesting access from Cider. Approve the BitCider dialog in the Cider app.');
    setNoticeType('info');
    try {
      const authorization = await requestCiderToken();
      setNotice('Cider approved BitCider. Saving your encrypted connection…');
      await saveToken(authorization.token, authorization.scopes);
    } catch (error) {
      setNotice(error.message || 'Could not complete Cider authorization.');
      setNoticeType('warning');
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
      const response = await fetch('/api/disconnect', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(getErrorMessage(payload, 'Could not disconnect.'));
      setNotice('Cider has been disconnected from this BitCider instance.');
      setNoticeType('info');
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
          <span className="brand-mark"><Icon name="music" size={19} /></span>
          <span className="brand-word">bit<span>cider</span></span>
        </a>
        <div className="topbar-right">
          <span className="topbar-caption">PERSONAL AUDIO BRIDGE</span>
          <span className={'connection-pill ' + (connected ? 'is-connected' : '')}>
            <span className="status-dot" />
            {status.loading ? 'CHECKING' : connected ? 'CIDER LINKED' : 'NOT LINKED'}
          </span>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> CIDER × BITCHORD</div>
          <h1>Your Cider.<br /><span>Your BitChord.</span></h1>
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
            <span className="step-counter">{connected ? 'READY' : 'STEP 01 / 02'}</span>
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
              <div className="scope-panel">
                <div className="scope-title">BITCIDER WILL REQUEST</div>
                <div className="scope-list">
                  {SCOPES.map(scope => <span className="scope-chip" key={scope}>{scope}</span>)}
                </div>
                <p>Search your Cider library, read the queue and control playback.</p>
              </div>
              <button className="primary-button" onClick={connectCider} disabled={busy || status.loading}>
                <span>{busy ? 'WAITING FOR CIDER' : 'CONNECT CIDER'}</span>
                <span className="button-icon"><Icon name="arrow" /></span>
              </button>
              <p className="auth-help">Keep this page open while Cider displays its consent prompt. Approve the requested scopes in Cider, and allow Chrome’s Loopback network permission so BitCider can reach Cider on this device.</p>
            </>
          ) : (
            <>
              <div className="card-heading connected-heading">
                <div className="success-icon"><Icon name="check" size={24} /></div>
                <div>
                  <h2>Cider is linked</h2>
                  <p>Your personal source is ready to add.</p>
                </div>
              </div>
              <div className="addon-url-panel">
                <div className="scope-title">YOUR BITCHORD ADDON URL</div>
                <div className="url-row">
                  <code>{status.addonUrl}</code>
                  <button className="copy-button" onClick={copyAddonUrl} aria-label="Copy addon URL">
                    {copied ? <Icon name="check" /> : <Icon name="copy" />}
                  </button>
                </div>
                <div className="url-hint">
                  <span className="tiny-dot" />
                  {status.publicUrlConfigured ? 'Public endpoint configured' : 'Local network endpoint'}
                </div>
              </div>
              <div className="install-steps">
                <div className="install-step"><span>01</span><p>Copy your personal URL above.</p></div>
                <div className="install-step"><span>02</span><p>In BitChord, open <b>Settings → Sources → Add an addon</b>.</p></div>
                <div className="install-step"><span>03</span><p>Paste the URL and save. Cider is the source, BitChord is the player.</p></div>
              </div>
              <div className="connected-actions">
                <button className="primary-button" onClick={copyAddonUrl}>
                  <span>{copied ? 'COPIED' : 'COPY ADDON URL'}</span>
                  <span className="button-icon"><Icon name={copied ? 'check' : 'copy'} /></span>
                </button>
                <button className="disconnect-button" onClick={disconnect} disabled={busy}>
                  <Icon name="unplug" size={15} /> Disconnect Cider
                </button>
              </div>
            </>
          )}

          {notice && <div className={'notice notice-' + noticeType}>{notice}</div>}
          {!notice && status.message && <div className="notice notice-warning">{status.message}</div>}
        </section>
      </section>

      <section className="feature-strip">
        <article className="feature-item">
          <span className="feature-number">01</span>
          <div><h3>Your Cider account</h3><p>Authorization stays tied to the Cider account you approve.</p></div>
        </article>
        <article className="feature-item">
          <span className="feature-number">02</span>
          <div><h3>Your personal endpoint</h3><p>BitCider creates a unique addon URL for this connection.</p></div>
        </article>
        <article className="feature-item">
          <span className="feature-number">03</span>
          <div><h3>BitChord playback</h3><p>Add the URL once. BitChord requests music from your source.</p></div>
        </article>
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
