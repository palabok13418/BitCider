import { useEffect, useMemo, useState } from 'react';
import LineWaves from './LineWaves.jsx';

const CIDER_API = 'http://127.0.0.1:10767';
const SCOPES = ['playback', 'queue', 'library', 'audio'];
const CIDER_AUTH_URI = 'cider://request-auth?app-name=BitCider&scopes=playback%2Cqueue%2Clibrary%2Caudio';

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

function extractToken(payload) {
  const candidates = [
    payload?.data?.token,
    payload?.data?.appToken,
    payload?.data?.app_token,
    payload?.token,
    payload?.appToken,
    payload?.app_token
  ];
  const token = candidates.find(value => typeof value === 'string' && value.length > 12);
  return token || null;
}

export default function App() {
  const [status, setStatus] = useState({ loading: true, connected: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState('info');
  const [manualToken, setManualToken] = useState('');
  const [showManualToken, setShowManualToken] = useState(false);
  const [copied, setCopied] = useState(false);

  const authUri = useMemo(() => CIDER_AUTH_URI, []);

  async function refreshStatus() {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      const data = await response.json();
      setStatus({ loading: false, ...data });
    } catch {
      setStatus({ loading: false, connected: false, error: 'The BitCider service is not responding.' });
    }
  }

  useEffect(() => { refreshStatus(); }, []);

  async function saveToken(token) {
    const response = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(getErrorMessage(payload, 'Could not save the Cider connection.'));
    setManualToken('');
    setShowManualToken(false);
    setNotice('Cider is linked. Your personal BitChord source is ready.');
    setNoticeType('success');
    await refreshStatus();
  }

  async function connectCider() {
    setBusy(true);
    setNotice('Opening Cider authorization…');
    setNoticeType('info');

    // Request the token through Cider's local browser-auth endpoint. The
    // cider:// link below remains available as a manual fallback.
    try {
      const response = await fetch(CIDER_API + '/api/v2/auth/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ appName: 'BitCider', scopes: SCOPES })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(getErrorMessage(payload, 'Cider could not authorize BitCider.'));
      const token = extractToken(payload);
      if (token) {
        await saveToken(token);
      } else {
        setShowManualToken(true);
        setNotice('Approve BitCider in Cider. If Cider shows a one-time token, paste it below to finish linking.');
        setNoticeType('info');
      }
    } catch (error) {
      setShowManualToken(true);
      setNotice(error?.message || 'Could not reach Cider. Open the Cider authorization link, approve it, then paste the token shown by Cider.');
      setNoticeType('warning');
    } finally {
      setBusy(false);
    }
  }

  async function submitManualToken(event) {
    event.preventDefault();
    if (!manualToken.trim()) return;
    setBusy(true);
    try {
      await saveToken(manualToken.trim());
    } catch (error) {
      setNotice(error.message);
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
      setShowManualToken(false);
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
                  <p>Authorize BitCider from the Cider app.</p>
                </div>
              </div>
              <div className="scope-panel">
                <div className="scope-title">BITCIDER WILL REQUEST</div>
                <div className="scope-list">
                  {SCOPES.map(scope => <span className="scope-chip" key={scope}>{scope}</span>)}
                </div>
                <p>Only the access needed for discovery, queue handling and playback.</p>
              </div>
              <button className="primary-button" onClick={connectCider} disabled={busy || status.loading}>
                <span>{busy ? 'WAITING FOR CIDER' : 'CONNECT CIDER'}</span>
                <span className="button-icon"><Icon name="arrow" /></span>
              </button>
              <a className="text-link" href={authUri}>Open Cider authorization manually <Icon name="external" size={14} /></a>

              {showManualToken && (
                <form className="manual-token-form" onSubmit={submitManualToken}>
                  <label htmlFor="cider-token">ONE-TIME CIDER TOKEN</label>
                  <input
                    id="cider-token"
                    type="password"
                    autoComplete="off"
                    spellCheck="false"
                    value={manualToken}
                    onChange={event => setManualToken(event.target.value)}
                    placeholder="Paste the token shown by Cider"
                  />
                  <button type="submit" disabled={busy || !manualToken.trim()}>FINISH LINKING</button>
                  <small>The token is saved encrypted by your BitCider service. Do not share it.</small>
                </form>
              )}
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
