import { useCallback, useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './admin-console.css';


const SITE_DEFINITIONS = [
  { id: 'bitcider', name: 'BitCider', page: '/', health: '/health', description: 'Personal Cider source and account hub' },
  { id: 'bitmono', name: 'BitMono', page: '/bitmono/', health: '/api/bitmono/health', description: 'Monochrome music source with fallback search' },
  { id: 'bitconnection', name: 'BitConnection', page: '/bitconnection/', health: '/api/bitconnection/health', description: 'Listening rooms, profiles, and realtime sync' }
];

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || 'The admin request could not be completed.');
  }
  return payload;
}

function StatusPill({ state = 'checking', label }) {
  const normalized = state === 'online' ? 'online'
    : state === 'offline' || state === 'error' ? 'offline'
      : state === 'warning' || state === 'slow' ? 'warning' : 'checking';
  return <span className={'admin-status-pill is-' + normalized}><i />{label || (normalized === 'online' ? 'ONLINE' : normalized === 'offline' ? 'OFFLINE' : normalized === 'warning' ? 'SLOW' : 'CHECKING')}</span>;
}

function copyText(value) {
  if (value) void navigator.clipboard?.writeText(String(value)).catch(() => {});
}

function BitCiderPreview() {
  return (
    <div className="admin-site-preview">
      <div className="admin-preview-top"><span className="admin-preview-brand"><i /> BITCIDER</span><span className="admin-preview-menu">•••</span></div>
      <div className="admin-preview-hero">
        <div className="admin-preview-orbit"><span /><i /><b /></div>
        <div className="admin-preview-overline">YOUR MUSIC SOURCE</div>
        <strong>Your <em>Cider.</em><br />Your BitChord.</strong>
        <span className="admin-preview-copy">Connect Cider and bring your library to BitChord.</span>
        <div className="admin-preview-cta">CONNECT CIDER <b>↗</b></div>
      </div>
      <div className="admin-preview-footer"><span>BITCIDER</span><span>MADE FOR BITCHORD</span></div>
    </div>
  );
}

function MiniSitePreview({ site }) {
  if (site.id === 'bitcider') return <BitCiderPreview />;
  if (site.id === 'bitmono') {
    return (
      <div className="admin-mini-preview is-mono">
        <span className="admin-mini-kicker">MONOCHROME × BITCHORD</span>
        <strong>Your <em>Monochrome.</em><br />Your BitChord.</strong>
        <div className="admin-mini-equalizer"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
        <small>FREE MUSIC SOURCE</small>
      </div>
    );
  }
  return (
    <div className="admin-mini-preview is-connection">
      <span className="admin-mini-kicker">LIVE LISTENING</span>
      <strong>Music hits<br /><em>different</em> together.</strong>
      <div className="admin-mini-room"><i /><i /><i /><span>ROOM READY</span></div>
      <small>POWERED BY BITCHORD</small>
    </div>
  );
}

function SiteNode({ site, status, openSite, runTest }) {
  return (
    <article className={'admin-map-node admin-map-node-' + site.id}>
      <div className="admin-node-topline">
        <span className="admin-node-index">{site.id === 'bitcider' ? '01 / CORE' : site.id === 'bitmono' ? '02 / SOURCE' : '03 / SOCIAL'}</span>
        <StatusPill state={status?.state || 'checking'} label={status?.label || 'CHECKING'} />
      </div>
      <div className="admin-node-preview"><MiniSitePreview site={site} /></div>
      <div className="admin-node-details">
        <div><h3>{site.name}</h3><p>{site.description}</p></div>
        <span className="admin-node-code">{status?.httpStatus ? 'HTTP ' + status.httpStatus : 'SITE NODE'}</span>
      </div>
      <div className="admin-node-actions">
        <button type="button" onClick={() => openSite(site.page)}>OPEN PAGE <span>↗</span></button>
        <button type="button" onClick={() => runTest(site)} disabled={status?.testing}>TEST</button>
      </div>
    </article>
  );
}

function MapView({ overview, pageStatuses, refreshPages, runTest }) {
  const canvasRef = useRef(null);
  const viewportRef = useRef(null);
  const backendRef = useRef(null);
  const siteRefs = useRef({});

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return undefined;

    const drawConnections = () => {
      const bounds = viewport.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const pixelRatio = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
      const pixelWidth = Math.round(width * pixelRatio);
      const pixelHeight = Math.round(height * pixelRatio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const backend = backendRef.current?.getBoundingClientRect();
      if (!backend) return;
      const startX = backend.left + backend.width / 2 - bounds.left;
      const startY = backend.bottom - bounds.top;

      SITE_DEFINITIONS.forEach((site, index) => {
        const node = siteRefs.current[site.id]?.getBoundingClientRect();
        if (!node) return;
        const endX = node.left + node.width / 2 - bounds.left;
        const endY = node.top - bounds.top;
        const distance = Math.max(24, (endY - startY) * 0.48);
        const gradient = context.createLinearGradient(startX, startY, endX, endY);
        gradient.addColorStop(0, 'rgba(130, 215, 213, .3)');
        gradient.addColorStop(1, index === 0 ? 'rgba(239, 139, 168, .78)' : index === 1 ? 'rgba(218, 225, 226, .65)' : 'rgba(151, 206, 225, .72)');

        context.beginPath();
        context.moveTo(startX, startY);
        context.bezierCurveTo(startX, startY + distance, endX, endY - distance, endX, endY);
        context.strokeStyle = gradient;
        context.lineWidth = 2;
        context.stroke();

        context.beginPath();
        context.arc(endX, endY, 3.5, 0, Math.PI * 2);
        context.fillStyle = index === 0 ? '#ef8ba8' : index === 1 ? '#d8e1e2' : '#97cee1';
        context.fill();
      });
    };

    drawConnections();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(drawConnections) : null;
    observer?.observe(viewport);
    if (backendRef.current) observer?.observe(backendRef.current);
    Object.values(siteRefs.current).forEach(node => observer?.observe(node));
    window.addEventListener('resize', drawConnections);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', drawConnections);
    };
  }, []);

  const openSite = path => window.open(path, '_blank', 'noopener,noreferrer');

  return (
    <section className="admin-map-view">
      <div className="admin-section-heading">
        <div><span className="admin-eyebrow">SYSTEM TOPOLOGY</span><h2>Site canvas</h2><p>A flat 2D view of the three connected pages and their Deplexo backend. No personal user information is displayed.</p></div>
        <button className="admin-button admin-button-quiet" type="button" onClick={refreshPages}>REFRESH STATUS <span>↻</span></button>
      </div>
      <div className="admin-map-toolbar">
        <span><i /> 2D SITE CANVAS</span><span>DEPLEXO API CORE</span><span>3 CONNECTED PAGES</span>
      </div>
      <div className="admin-map-viewport" ref={viewportRef} role="region" aria-label="Two dimensional map of BitCider, BitMono, and BitConnection">
        <canvas ref={canvasRef} className="admin-map-canvas-lines" aria-hidden="true" />
        <div className="admin-map-canvas-content">
          <div className="admin-map-backend" ref={backendRef}>
            <span className="admin-map-backend-light" />
            <span className="admin-map-backend-copy"><strong>DEPLEXO</strong><small>SHARED API CORE</small></span>
            <span className="admin-map-backend-state">BACKEND</span>
          </div>
          <div className="admin-map-sites">
            {SITE_DEFINITIONS.map(site => (
              <div className="admin-map-site" key={site.id} ref={element => {
                if (element) siteRefs.current[site.id] = element;
                else delete siteRefs.current[site.id];
              }}>
                <SiteNode site={site} status={pageStatuses[site.id]} openSite={openSite} runTest={runTest} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="admin-map-summary">
        <div><span>REGISTERED ACCOUNTS</span><strong>{overview?.users ?? '…'}</strong></div>
        <div><span>ACTIVE SESSIONS</span><strong>{overview?.activeUsers ?? '…'}</strong></div>
        <div><span>LIVE ROOMS</span><strong>{overview?.activeRooms ?? '…'}</strong></div>
        <div><span>SUSPENDED</span><strong>{overview?.suspendedUsers ?? '…'}</strong></div>
      </div>
    </section>
  );
}
export default function AdminConsole({ bootstrapCode = '', onBootstrapConsumed = () => {}, onClose }) {
  const [phase, setPhase] = useState('loading');
  const [status, setStatus] = useState(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('map');
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [pageStatuses, setPageStatuses] = useState({
    bitcider: { state: 'checking', label: 'CHECKING' },
    bitmono: { state: 'checking', label: 'CHECKING' },
    bitconnection: { state: 'checking', label: 'CHECKING' }
  });
  const [botTarget, setBotTarget] = useState('both');
  const [botCredentials, setBotCredentials] = useState(null);
  const [busy, setBusy] = useState('');
  const [showBootstrapCode, setShowBootstrapCode] = useState(false);
  const firstFocusRef = useRef(null);

  const refreshStatus = useCallback(async () => {
    const payload = await requestJson('/api/admin/status');
    setStatus(payload);
    // Every admin-console opening requires a fresh owner-passkey ceremony,
    // even when an unexpired HttpOnly admin session cookie is present.
    setCsrfToken('');
    setPhase(payload.initialized ? 'login' : 'bootstrap');
    return payload;
  }, []);

  const refreshDashboard = useCallback(async () => {
    const [overviewPayload, usersPayload] = await Promise.all([
      requestJson('/api/admin/overview'),
      requestJson('/api/admin/users')
    ]);
    setOverview(overviewPayload);
    setUsers(Array.isArray(usersPayload.users) ? usersPayload.users : []);
  }, []);

  const refreshPageStatuses = useCallback(async () => {
    await Promise.all(SITE_DEFINITIONS.map(async site => {
      const started = performance.now();
      try {
        const response = await fetch(site.page, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
        const durationMs = Math.round(performance.now() - started);
        setPageStatuses(previous => ({
          ...previous,
          [site.id]: {
            state: response.ok ? 'online' : response.status >= 500 ? 'offline' : 'warning',
            label: response.ok ? 'ONLINE' : 'HTTP ' + response.status,
            httpStatus: response.status,
            durationMs,
            testing: false
          }
        }));
      } catch (requestError) {
        setPageStatuses(previous => ({
          ...previous,
          [site.id]: { state: 'offline', label: 'UNREACHABLE', error: requestError.message, testing: false }
        }));
      }
    }));
  }, []);

  useEffect(() => {
    let active = true;
    requestJson('/api/admin/status').then(payload => {
      if (!active) return;
      setStatus(payload);
      // Do not resume the dashboard from an existing cookie on a new console
      // visit. Require the owner passkey each time admin mode is opened.
      setCsrfToken('');
      setPhase(payload.initialized ? 'login' : 'bootstrap');
    }).catch(loadError => {
      if (active) {
        setError(loadError.message || 'Admin authorization service is unavailable.');
        setPhase('error');
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!bootstrapCode || phase !== 'bootstrap') return;
    setShowBootstrapCode(true);
  }, [bootstrapCode, phase]);

  useEffect(() => {
    if (phase !== 'authenticated') return undefined;
    refreshDashboard().catch(loadError => setError(loadError.message || 'Could not load admin data.'));
    refreshPageStatuses();
    const dashboardTimer = window.setInterval(() => refreshDashboard().catch(() => {}), 20000);
    const pageTimer = window.setInterval(refreshPageStatuses, 30000);
    return () => {
      window.clearInterval(dashboardTimer);
      window.clearInterval(pageTimer);
    };
  }, [phase, refreshDashboard, refreshPageStatuses]);

  async function enrollOwnerPasskey() {
    setBusy('bootstrap');
    setError('');
    setNotice('');
    try {
      if (!bootstrapCode) throw new Error('Enter the one-time bootstrap code from the developer console.');
      const started = await requestJson('/api/admin/bootstrap/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: bootstrapCode })
      });
      const registration = await startRegistration({ optionsJSON: started.optionsJSON });
      const verified = await requestJson('/api/admin/bootstrap/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration)
      });
      setCsrfToken(verified.csrfToken || '');
      onBootstrapConsumed();
      setShowBootstrapCode(false);
      setStatus({ initialized: true, authenticated: true, passkeyCount: 1, passkeyLimit: 1 });
      setPhase('authenticated');
      setNotice('Owner passkey enrolled. This is the only admin passkey slot.');
    } catch (enrollError) {
      setError(enrollError.message || 'Could not enroll the admin passkey.');
    } finally {
      setBusy('');
    }
  }

  async function signInWithOwnerPasskey() {
    setBusy('login');
    setError('');
    try {
      const started = await requestJson('/api/admin/auth/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const authentication = await startAuthentication({ optionsJSON: started.optionsJSON });
      const verified = await requestJson('/api/admin/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authentication)
      });
      setCsrfToken(verified.csrfToken || '');
      setPhase('authenticated');
    } catch (loginError) {
      setError(loginError.message || 'Admin passkey verification failed.');
    } finally {
      setBusy('');
    }
  }

  async function logout() {
    setBusy('logout');
    try {
      await requestJson('/api/admin/logout', {
        method: 'POST',
        headers: { 'X-BitCider-Admin-CSRF': csrfToken }
      });
      setCsrfToken('');
      setPhase('login');
      setNotice('Admin mode signed out.');
    } catch (logoutError) {
      setError(logoutError.message || 'Could not sign out of admin mode.');
    } finally {
      setBusy('');
    }
  }

  async function runTest(site) {
    setPageStatuses(previous => ({
      ...previous,
      [site.id]: { ...(previous[site.id] || {}), state: 'checking', label: 'TESTING', testing: true }
    }));
    const started = performance.now();
    try {
      const [pageResponse, healthResponse] = await Promise.all([
        fetch(site.page, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' }),
        fetch(site.health, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      ]);
      const healthPayload = await healthResponse.json().catch(() => ({}));
      const durationMs = Math.round(performance.now() - started);
      const ok = pageResponse.ok && healthResponse.ok && healthPayload.ok !== false;
      setPageStatuses(previous => ({
        ...previous,
        [site.id]: {
          state: ok ? 'online' : healthResponse.status >= 500 || pageResponse.status >= 500 ? 'offline' : 'warning',
          label: ok ? 'HEALTHY' : 'CHECK FAILED',
          httpStatus: pageResponse.status,
          healthStatus: healthResponse.status,
          durationMs,
          health: healthPayload.service || healthPayload.status || 'Response received',
          testing: false
        }
      }));
      setNotice(site.name + ' test finished in ' + durationMs + ' ms.');
      setError('');
    } catch (testError) {
      setPageStatuses(previous => ({
        ...previous,
        [site.id]: { ...(previous[site.id] || {}), state: 'offline', label: 'TEST FAILED', error: testError.message, testing: false }
      }));
      setError(site.name + ': ' + (testError.message || 'Test failed.'));
    }
  }

  async function runAllTests() {
    setBusy('tests');
    setError('');
    await Promise.all(SITE_DEFINITIONS.map(runTest));
    setBusy('');
  }

  async function moderateUser(user, action) {
    const message = action === 'delete'
      ? 'Permanently delete this anonymous ' + user.product + ' account? This cannot be undone.'
      : (user.suspended ? 'Restore this account?' : 'Suspend this account and revoke its active sessions?');
    if (!window.confirm(message)) return;
    setBusy('user:' + user.ref);
    setError('');
    try {
      if (action === 'delete') {
        await requestJson('/api/admin/users/' + encodeURIComponent(user.ref), {
          method: 'DELETE',
          headers: { 'X-BitCider-Admin-CSRF': csrfToken }
        });
        setNotice('Anonymous account deleted.');
      } else {
        await requestJson('/api/admin/users/' + encodeURIComponent(user.ref) + '/suspension', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-BitCider-Admin-CSRF': csrfToken },
          body: JSON.stringify({ suspended: !user.suspended })
        });
        setNotice(user.suspended ? 'Account restored. The user must sign in again.' : 'Account suspended and active sessions revoked.');
      }
      await refreshDashboard();
    } catch (actionError) {
      setError(actionError.message || 'The account action failed.');
    } finally {
      setBusy('');
    }
  }

  async function createBot() {
    setBusy('bot');
    setError('');
    setNotice('');
    setBotCredentials(null);
    const products = botTarget === 'both' ? ['bitcider', 'bitconnection'] : [botTarget];
    try {
      const result = await requestJson('/api/admin/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BitCider-Admin-CSRF': csrfToken },
        body: JSON.stringify({ products })
      });
      setBotCredentials(result);
      setNotice('Bot account created. Copy its credentials now, because the generated password is only shown once.');
      await refreshDashboard();
    } catch (botError) {
      setError(botError.message || 'Could not create the bot account.');
    } finally {
      setBusy('');
    }
  }

  const selectedSite = SITE_DEFINITIONS.find(site => site.id === tab);

  if (phase === 'loading') {
    return <div className="admin-console-overlay"><div className="admin-auth-card"><span className="admin-loading-orbit" /><p>Checking admin authorization…</p><button type="button" onClick={onClose}>CLOSE</button></div></div>;
  }

  if (phase !== 'authenticated') {
    return (
      <div className="admin-console-overlay" role="presentation">
        <section className="admin-auth-card" role="dialog" aria-modal="true" aria-labelledby="admin-auth-title">
          <button className="admin-console-close" type="button" onClick={onClose} aria-label="Close admin mode">×</button>
          <div className="admin-auth-emblem"><span>BC</span><i /><b /></div>
          <div className="admin-eyebrow">RESTRICTED SYSTEM ACCESS</div>
          <h1 id="admin-auth-title">{phase === 'bootstrap' ? 'Initialize owner access.' : phase === 'error' ? 'Admin service unavailable.' : 'Admin mode.'}</h1>
          <p className="admin-auth-copy">
            {phase === 'bootstrap'
              ? 'The first owner must enroll exactly one passkey. The one-time bootstrap code only opens enrollment and cannot sign in afterward.'
              : phase === 'error'
                ? 'The protected admin service could not be reached. Check the backend deployment and try again.'
                : 'This site is already initialized. Sign in using the one registered owner passkey.'}
          </p>
          {phase === 'bootstrap' && (
            <div className="admin-auth-setup-note">
              <strong>ONE OWNER · ONE PASSKEY</strong>
              <span>{status?.bootstrapConfigured === false
                ? 'BACKEND SECRET MISSING: Add BITCIDER_ADMIN_BOOTSTRAP_CODE to the Deplexo backend environment, then redeploy and reopen this console.'
                : status?.bootstrapAvailable === false
                  ? 'BOOTSTRAP IS LOCKED: The backend reports that first-owner enrollment is not currently available. Check the admin state before retrying.'
                  : 'Bootstrap is available only when BITCIDER_ADMIN_BOOTSTRAP_CODE is configured and no owner key exists.'}</span>
            </div>
          )}
          {error && <div className="admin-console-error" role="alert">{error}</div>}
          {notice && <div className="admin-console-notice" role="status">{notice}</div>}
          {phase === 'bootstrap' ? (
            <button className="admin-button admin-button-primary admin-auth-submit" type="button" onClick={enrollOwnerPasskey} disabled={busy === 'bootstrap' || !bootstrapCode || status?.bootstrapAvailable !== true}>
              {busy === 'bootstrap' ? 'WAITING FOR PASSKEY…' : 'ENROLL FIRST PASSKEY'}
            </button>
          ) : phase === 'login' ? (
            <button className="admin-button admin-button-primary admin-auth-submit" type="button" onClick={signInWithOwnerPasskey} disabled={busy === 'login'}>
              {busy === 'login' ? 'VERIFYING…' : 'SIGN IN WITH PASSKEY'}
            </button>
          ) : (
            <button className="admin-button admin-button-primary admin-auth-submit" type="button" onClick={() => window.location.reload()}>RETRY</button>
          )}
          <div className="admin-auth-footer"><span>BITCIDER / ADMIN CORE</span><span>SECURE SESSION · PASSKEY REQUIRED</span></div>
          <span className="admin-auth-code-state" aria-live="polite">{showBootstrapCode && bootstrapCode ? 'BOOTSTRAP CODE RECEIVED IN MEMORY' : ''}</span>
        </section>
      </div>
    );
  }

  return (
    <div className="admin-console-overlay is-dashboard" role="presentation">
      <div className="admin-console-shell">
        <header className="admin-console-topbar">
          <div className="admin-console-brand"><span className="admin-console-mark">BC</span><div><strong>BITCIDER</strong><small>ADMIN CONSOLE / OWNER ACCESS</small></div></div>
          <div className="admin-topbar-state"><StatusPill state="online" label="OWNER SESSION" /><span>ONE PASSKEY ENROLLED</span></div>
          <div className="admin-topbar-actions"><button type="button" className="admin-button admin-button-quiet" onClick={refreshDashboard}>SYNC DATA ↻</button><button type="button" className="admin-button admin-button-quiet" onClick={logout} disabled={busy === 'logout'}>LOCK ADMIN</button><button type="button" className="admin-console-close" onClick={onClose} aria-label="Close admin console">×</button></div>
        </header>
        <div className="admin-console-layout">
          <aside className="admin-console-sidebar">
            <div className="admin-sidebar-label">CONTROL PLANE</div>
            {[
              ['map', '⌘', 'Site map'],
              ['users', '◉', 'Users'],
              ['bots', '✳', 'Bot accounts'],
              ['diagnostics', '⌁', 'Diagnostics']
            ].map(([id, symbol, label]) => (
              <button key={id} type="button" className={'admin-nav-item' + (tab === id ? ' is-active' : '')} onClick={() => setTab(id)}>
                <span>{symbol}</span>{label}{tab === id && <i />}
              </button>
            ))}
            <div className="admin-sidebar-spacer" />
            <div className="admin-sidebar-owner"><i /><span>OWNER ACCESS</span><small>Session expires in 2 hours</small></div>
            <div className="admin-sidebar-version">BITCIDER ADMIN · 1.0</div>
          </aside>
          <main className="admin-console-main">
            {tab === 'map' && <MapView overview={overview} pageStatuses={pageStatuses} refreshPages={refreshPageStatuses} runTest={runTest} />}
            {tab === 'users' && (
              <section className="admin-pane">
                <div className="admin-section-heading"><div><span className="admin-eyebrow">ANONYMIZED PRESENCE</span><h2>Users</h2><p>Only anonymous account references and access state are shown. No usernames, profile data, device names, addresses, or IPs.</p></div><button type="button" className="admin-button admin-button-quiet" onClick={refreshDashboard}>REFRESH LIST ↻</button></div>
                <div className="admin-user-summary"><div><span>ACCOUNTS</span><strong>{users.length}</strong></div><div><span>ACTIVE</span><strong>{users.filter(user => user.active).length}</strong></div><div><span>SUSPENDED</span><strong>{users.filter(user => user.suspended).length}</strong></div></div>
                <div className="admin-user-list">
                  {users.length ? users.map((user, index) => (
                    <article className="admin-user-row" key={user.ref}>
                      <div className="admin-user-number">{String(index + 1).padStart(2, '0')}</div>
                      <div className="admin-user-copy"><strong>Anonymous account {String(index + 1).padStart(2, '0')}</strong><span>{user.product}{user.bot ? ' · Admin-created bot' : ''}</span><code>{user.ref}</code></div>
                      <StatusPill state={user.suspended ? 'warning' : user.active ? 'online' : 'checking'} label={user.suspended ? 'SUSPENDED' : user.active ? 'ACTIVE' : 'IDLE'} />
                      <div className="admin-user-actions">
                        <button type="button" onClick={() => moderateUser(user, 'suspend')} disabled={busy === 'user:' + user.ref}>{user.suspended ? 'RESTORE' : 'SUSPEND'}</button>
                        <button type="button" className="is-danger" onClick={() => moderateUser(user, 'delete')} disabled={busy === 'user:' + user.ref}>DELETE</button>
                      </div>
                    </article>
                  )) : <div className="admin-empty-state">No registered accounts were found.</div>}
                </div>
                <p className="admin-privacy-footnote">Active means the account made an authenticated request within the last two minutes. These are session presence estimates, not a live network trace.</p>
              </section>
            )}
            {tab === 'bots' && (
              <section className="admin-pane">
                <div className="admin-section-heading"><div><span className="admin-eyebrow">TEST IDENTITIES</span><h2>Bot accounts</h2><p>Create a generated test identity for BitCider, BitConnection, or both products.</p></div></div>
                <div className="admin-bot-builder">
                  <div className="admin-bot-card-head"><span>NEW BOT IDENTITY</span><StatusPill state="online" label="SERVER GENERATED" /></div>
                  <div className="admin-bot-product-select">
                    <label><span>PRODUCT TARGET</span><select value={botTarget} onChange={event => setBotTarget(event.target.value)}><option value="both">Both products</option><option value="bitcider">BitCider only</option><option value="bitconnection">BitConnection only</option></select></label>
                    <div className="admin-bot-product-hints"><span>BitCider requires its generated Account Key at sign-in.</span><span>Both products receive separate account records with the same generated username and password.</span></div>
                  </div>
                  <button className="admin-button admin-button-primary" type="button" onClick={createBot} disabled={busy === 'bot'}>{busy === 'bot' ? 'GENERATING…' : 'GENERATE BOT ACCOUNT'} <span>↗</span></button>
                </div>
                {botCredentials && (
                  <div className="admin-generated-credentials">
                    <div className="admin-generated-head"><div><span className="admin-eyebrow">CREATED SUCCESSFULLY</span><h3>{botCredentials.username}</h3><p>Copy these now. The password and Account Key are not stored in the admin console.</p></div><StatusPill state="online" label="CREATED" /></div>
                    <div className="admin-credential-row"><span>USERNAME</span><code>{botCredentials.username}</code><button type="button" onClick={() => copyText(botCredentials.username)}>COPY</button></div>
                    <div className="admin-credential-row"><span>PASSWORD</span><code>{botCredentials.password}</code><button type="button" onClick={() => copyText(botCredentials.password)}>COPY</button></div>
                    {botCredentials.bitcider && <div className="admin-credential-row"><span>BITCIDER ACCOUNT KEY</span><code>{botCredentials.bitcider.accountKey}</code><button type="button" onClick={() => copyText(botCredentials.bitcider.accountKey)}>COPY</button></div>}
                    {botCredentials.bitconnection?.recoveryCodes?.length > 0 && <div className="admin-secret-block"><span>BITCONNECTION RECOVERY CODES</span><div>{botCredentials.bitconnection.recoveryCodes.map(code => <code key={code}>{code}</code>)}</div><button type="button" onClick={() => copyText(botCredentials.bitconnection.recoveryCodes.join('\n'))}>COPY ALL</button></div>}
                    {botCredentials.bitcider?.recoveryCodes?.length > 0 && <div className="admin-secret-block"><span>BITCIDER RECOVERY CODES</span><div>{botCredentials.bitcider.recoveryCodes.map(code => <code key={code}>{code}</code>)}</div><button type="button" onClick={() => copyText(botCredentials.bitcider.recoveryCodes.join('\n'))}>COPY ALL</button></div>}
                    {botCredentials.bitcider && <p className="admin-privacy-footnote">This BitCider test account starts without a linked Cider token. It can authenticate to BitCider, but it is not a real Apple Music/Cider connection.</p>}
                  </div>
                )}
              </section>
            )}
            {tab === 'diagnostics' && (
              <section className="admin-pane">
                <div className="admin-section-heading"><div><span className="admin-eyebrow">LIVE SERVICE CHECKS</span><h2>Diagnostics</h2><p>Inspect each page, test its backing API, and open a separate live preview.</p></div><button type="button" className="admin-button admin-button-primary" onClick={runAllTests} disabled={busy === 'tests'}>{busy === 'tests' ? 'TESTING…' : 'RUN ALL TESTS'}</button></div>
                <div className="admin-diagnostic-list">
                  {SITE_DEFINITIONS.map(site => {
                    const result = pageStatuses[site.id] || {};
                    return <article className="admin-diagnostic-card" key={site.id}>
                      <div className="admin-diagnostic-top"><div><span className="admin-eyebrow">{site.page}</span><h3>{site.name}</h3><p>{site.description}</p></div><StatusPill state={result.state || 'checking'} label={result.label || 'CHECKING'} /></div>
                      <div className="admin-diagnostic-metrics"><span>PAGE HTTP <strong>{result.httpStatus || 'Not checked'}</strong></span><span>HEALTH HTTP <strong>{result.healthStatus || 'Not tested'}</strong></span><span>LATENCY <strong>{result.durationMs != null ? result.durationMs + ' ms' : '—'}</strong></span></div>
                      {result.error && <p className="admin-diagnostic-error">{result.error}</p>}
                      <div className="admin-diagnostic-actions"><button type="button" className="admin-button admin-button-primary" onClick={() => runTest(site)} disabled={result.testing}>TEST PAGE + API</button><button type="button" className="admin-button admin-button-quiet" onClick={() => window.open(site.page, '_blank', 'noopener,noreferrer')}>OPEN PREVIEW ↗</button></div>
                    </article>;
                  })}
                </div>
                <div className="admin-security-note"><strong>ADMIN SECURITY</strong><span>One owner passkey is registered. Bootstrap is consumed. Admin sessions are short-lived, same-site, HttpOnly cookies and require passkey verification to renew.</span></div>
              </section>
            )}
            {error && <div className="admin-console-error admin-console-global-message" role="alert">{error}<button type="button" onClick={() => setError('')}>×</button></div>}
            {notice && <div className="admin-console-notice admin-console-global-message" role="status">{notice}<button type="button" onClick={() => setNotice('')}>×</button></div>}
          </main>
        </div>
      </div>
      <button className="admin-dashboard-dismiss" type="button" onClick={onClose}>CLOSE CONSOLE</button>
    </div>
  );
}
