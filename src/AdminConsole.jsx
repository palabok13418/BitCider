import { useCallback, useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './admin-console.css';


const SITE_DEFINITIONS = [
  { id: 'bitcider', name: 'BitCider', page: '/', health: '/api/health', description: 'Personal Cider source and account hub' },
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
  const normalized = state === 'online' || state === 'operational' ? 'online'
    : state === 'offline' || state === 'error' ? 'offline'
      : state === 'warning' || state === 'slow' || state === 'degraded' || state === 'partial' ? 'warning' : 'checking';
  return <span className={'admin-status-pill is-' + normalized}><i />{label || (normalized === 'online' ? 'ONLINE' : normalized === 'offline' ? 'OFFLINE' : normalized === 'warning' ? 'DEGRADED' : 'CHECKING')}</span>;
}

function copyText(value) {
  if (value) void navigator.clipboard?.writeText(String(value)).catch(() => {});
}

function MiniSitePreview({ site }) {
  return (
    <div className="admin-live-preview">
      <iframe
        src={site.page}
        title={site.name + ' live page preview'}
        loading="lazy"
        tabIndex={-1}
        aria-hidden="true"
      />
      <span className="admin-preview-live-label">LIVE PAGE</span>
    </div>
  );
}

function AddonTrackTest() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [query, setQuery] = useState('Chicago Michael Jackson');

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const status = await requestJson('/api/status');
      if (status.connected !== true || typeof status.addonUrl !== 'string' || !status.addonUrl) {
        throw new Error('Link Cider in this browser first. The personal BitChord add-on is not available in this session.');
      }
      const manifestUrl = new URL(status.addonUrl, window.location.origin);
      if (!/^\/[A-Za-z0-9_-]{1,100}\/manifest\.json$/.test(manifestUrl.pathname)) {
        throw new Error('The personal add-on URL did not match the expected proxied manifest route.');
      }
      const manifest = await requestJson(manifestUrl.pathname);
      if (!Array.isArray(manifest.resources) || !manifest.resources.includes('search')) {
        throw new Error('The personal add-on manifest does not declare search support.');
      }
      const searchPath = manifestUrl.pathname.replace(/\/manifest\.json$/, '/search') + '?q=' + encodeURIComponent(query.trim());
      const search = await requestJson(searchPath);
      const tracks = Array.isArray(search.tracks) ? search.tracks : [];
      const track = tracks.find(item =>
        String(item.title || '').trim().toLowerCase() === 'chicago' &&
        String(item.artist || '').toLowerCase().includes('michael jackson')
      );
      if (!track) {
        setResult({
          ok: false,
          title: 'No exact Chicago match returned',
          detail: tracks.length
            ? 'The add-on returned ' + tracks.length + ' result(s), but none matched the exact title “Chicago” and artist “Michael Jackson”. No stream was requested.'
            : 'The live Cider search returned no tracks. Check that Cider is signed in and its browser relay is running.',
          candidates: tracks.slice(0, 4).map(item => String(item.title || 'Untitled') + ' · ' + String(item.artist || 'Unknown artist'))
        });
        return;
      }
      if (!manifest.resources.includes('stream')) {
        throw new Error('The add-on found the track but its manifest does not declare stream support.');
      }
      const streamPath = manifestUrl.pathname.replace(/\/manifest\.json$/, '/stream/' + encodeURIComponent(track.id)) + '?quality=HIGH';
      const stream = await requestJson(streamPath);
      const mediaUrl = new URL(stream.url);
      if (mediaUrl.protocol !== 'https:') {
        throw new Error('The stream resolver returned a non-HTTPS media URL. BitChord requires absolute secure media URLs.');
      }
      setResult({
        ok: true,
        title: String(track.title) + ' · ' + String(track.artist),
        detail: 'Exact catalogue match found. The personal add-on returned a valid HTTPS stream URL and metadata. No audio file was downloaded or played.',
        album: track.album || 'Album not supplied',
        duration: Number.isFinite(Number(track.duration)) ? Math.round(Number(track.duration)) + ' sec' : 'Not supplied',
        quality: stream.quality || stream.format || 'Metadata returned',
        codec: stream.codec || stream.format || 'Not supplied',
        mediaHost: mediaUrl.host
      });
    } catch (error) {
      setResult({ ok: false, title: 'Addon test failed', detail: error.message || 'The live add-on test failed.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-addon-test">
      <div className="admin-addon-test-copy">
        <span className="admin-eyebrow">LIVE BITCHORD ADD-ON CHECK</span>
        <h3>Test a real track</h3>
        <p>Search the linked Cider catalogue, verify the exact recording, then ask the personal add-on for stream metadata. This does not download or play the audio.</p>
      </div>
      <div className="admin-addon-test-controls">
        <label htmlFor="admin-addon-query">TRACK SEARCH</label>
        <input id="admin-addon-query" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" className="admin-button admin-button-primary" onClick={run} disabled={busy || !query.trim()}>
          {busy ? 'TESTING ADD-ON…' : 'TEST CHICAGO BY MICHAEL JACKSON'}
        </button>
      </div>
      {result && (
        <div className={'admin-addon-test-result ' + (result.ok ? 'is-success' : 'is-failed')} role="status">
          <div><strong>{result.title}</strong><span>{result.detail}</span></div>
          {result.ok && <dl><div><dt>ALBUM</dt><dd>{result.album}</dd></div><div><dt>DURATION</dt><dd>{result.duration}</dd></div><div><dt>QUALITY</dt><dd>{result.quality}</dd></div><div><dt>CODEC</dt><dd>{result.codec}</dd></div><div><dt>MEDIA HOST</dt><dd>{result.mediaHost}</dd></div></dl>}
          {result.candidates?.length > 0 && <ul>{result.candidates.map((candidate, index) => <li key={index}>{candidate}</li>)}</ul>}
        </div>
      )}
    </section>
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

const TOPOLOGY_NODES = [
  { id: 'deplexo', type: 'backend', title: 'Deplexo', subtitle: 'Primary API · persistent data', x: 620, y: 18 },
  { id: 'site-bitcider', parentId: 'deplexo', type: 'page', title: 'BitCider', subtitle: 'Cider source + account center', x: 28, y: 142, probeKey: 'site-bitcider' },
  { id: 'site-bitmono', parentId: 'deplexo', type: 'page', title: 'BitMono', subtitle: 'Monochrome music source', x: 518, y: 142, probeKey: 'site-bitmono' },
  { id: 'site-bitconnection', parentId: 'deplexo', type: 'page', title: 'BitConnection', subtitle: 'Rooms + realtime sync', x: 1008, y: 142, probeKey: 'site-bitconnection' },

  { id: 'bc-connect', parentId: 'site-bitcider', type: 'feature', title: 'Cider connection', subtitle: 'Link + browser bridge', x: 28, y: 292 },
  { id: 'bc-cider-state', parentId: 'bc-connect', type: 'check', title: 'Cider session', subtitle: 'Account link state', x: 250, y: 258, probeKey: 'bc-cider-state' },
  { id: 'bc-browser-relay', parentId: 'bc-connect', type: 'check', title: 'Browser relay', subtitle: 'Local Cider bridge', x: 250, y: 330, probeKey: 'bc-browser-relay' },
  { id: 'bc-auth-flow', parentId: 'bc-connect', type: 'check', title: 'Authorization', subtitle: 'Browser auth support', x: 250, y: 402, probeKey: 'bc-auth-flow' },

  { id: 'bc-identity', parentId: 'site-bitcider', type: 'feature', title: 'Account center', subtitle: 'Sessions + credentials', x: 28, y: 522 },
  { id: 'bc-account-state', parentId: 'bc-identity', type: 'check', title: 'Account session', subtitle: 'Signed-in state', x: 250, y: 486, probeKey: 'bc-account-state' },
  { id: 'bc-passkeys', parentId: 'bc-identity', type: 'check', title: 'Passkeys', subtitle: 'Credential inventory', x: 250, y: 558, probeKey: 'bc-passkeys' },
  { id: 'bc-recovery', parentId: 'bc-identity', type: 'check', title: 'Recovery codes', subtitle: 'Unused recovery inventory', x: 250, y: 630, probeKey: 'bc-recovery' },
  { id: 'bc-encryption', parentId: 'bc-identity', type: 'check', title: 'Token encryption', subtitle: 'At-rest key status', x: 250, y: 702, probeKey: 'bc-encryption' },

  { id: 'bc-addon', parentId: 'site-bitcider', type: 'feature', title: 'BitChord add-on', subtitle: 'Manifest + search + stream', x: 28, y: 840 },
  { id: 'bc-addon-manifest', parentId: 'bc-addon', type: 'check', title: 'Addon manifest', subtitle: 'Personal source config', x: 250, y: 804, probeKey: 'bc-addon-manifest' },
  { id: 'bc-addon-search', parentId: 'bc-addon', type: 'check', title: 'Live song search', subtitle: 'Browser-to-Cider path', x: 250, y: 876, probeKey: 'bc-addon-search' },
  { id: 'bc-addon-stream', parentId: 'bc-addon', type: 'check', title: 'Stream resolver', subtitle: 'Requires a real track', x: 250, y: 948, probeKey: 'bc-addon-stream' },
  { id: 'bc-renditions', parentId: 'bc-addon', type: 'check', title: 'Audio renditions', subtitle: 'AAC + Atmos options', x: 250, y: 1020, probeKey: 'bc-renditions' },

  { id: 'mono-source', parentId: 'site-bitmono', type: 'feature', title: 'Source discovery', subtitle: 'Manifest + live search', x: 518, y: 292 },
  { id: 'mono-manifest', parentId: 'mono-source', type: 'check', title: 'Addon manifest', subtitle: 'Search + stream routes', x: 740, y: 240, probeKey: 'mono-manifest' },
  { id: 'mono-search', parentId: 'mono-source', type: 'check', title: 'Live search', subtitle: 'Real upstream query', x: 740, y: 312, probeKey: 'mono-search' },
  { id: 'mono-primary', parentId: 'mono-source', type: 'check', title: 'Monochrome', subtitle: 'Primary provider', x: 740, y: 384, probeKey: 'mono-primary' },
  { id: 'mono-fallback', parentId: 'mono-source', type: 'check', title: 'Deezer fallback', subtitle: 'Fallback provider', x: 740, y: 456, probeKey: 'mono-fallback' },

  { id: 'mono-playback', parentId: 'site-bitmono', type: 'feature', title: 'Playback delivery', subtitle: 'Full-track stream cache', x: 518, y: 542 },
  { id: 'mono-stream', parentId: 'mono-playback', type: 'check', title: 'Stream resolver', subtitle: 'Requires a real track', x: 740, y: 506, probeKey: 'mono-stream' },
  { id: 'mono-cache', parentId: 'mono-playback', type: 'check', title: 'Complete-file cache', subtitle: 'Verified during playback', x: 740, y: 578, probeKey: 'mono-cache' },

  { id: 'mono-quality', parentId: 'site-bitmono', type: 'feature', title: 'Audio quality', subtitle: 'Lossless + high resolution', x: 518, y: 792 },
  { id: 'mono-lossless', parentId: 'mono-quality', type: 'check', title: 'Lossless FLAC', subtitle: 'Manifest capability', x: 740, y: 756, probeKey: 'mono-lossless' },
  { id: 'mono-hires-atmos', parentId: 'mono-quality', type: 'check', title: 'Hi-Res + Atmos', subtitle: 'Declared options', x: 740, y: 828, probeKey: 'mono-hires-atmos' },

  { id: 'conn-identity', parentId: 'site-bitconnection', type: 'feature', title: 'Accounts + profiles', subtitle: 'Independent identity', x: 1008, y: 292 },
  { id: 'conn-account-api', parentId: 'conn-identity', type: 'check', title: 'Account API', subtitle: 'Session endpoint', x: 1230, y: 258, probeKey: 'conn-account-api' },
  { id: 'conn-passkeys', parentId: 'conn-identity', type: 'check', title: 'Passkeys', subtitle: 'Protected listing route', x: 1230, y: 330, probeKey: 'conn-passkeys' },
  { id: 'conn-recovery', parentId: 'conn-identity', type: 'check', title: 'Recovery codes', subtitle: 'Declared capability', x: 1230, y: 402, probeKey: 'conn-recovery' },

  { id: 'conn-rooms', parentId: 'site-bitconnection', type: 'feature', title: 'Listening rooms', subtitle: 'Directory + permissions', x: 1008, y: 542 },
  { id: 'conn-directory', parentId: 'conn-rooms', type: 'check', title: 'Public directory', subtitle: 'Live room listing', x: 1230, y: 486, probeKey: 'conn-directory' },
  { id: 'conn-create-room', parentId: 'conn-rooms', type: 'check', title: 'Room creation', subtitle: 'Sign-in/profile gated', x: 1230, y: 558, probeKey: 'conn-create-room' },
  { id: 'conn-playback-sync', parentId: 'conn-rooms', type: 'check', title: 'Playback sync', subtitle: 'Declared capability', x: 1230, y: 630, probeKey: 'conn-playback-sync' },
  { id: 'conn-shared-queue', parentId: 'conn-rooms', type: 'check', title: 'Shared queue', subtitle: 'Room permissions', x: 1230, y: 702, probeKey: 'conn-shared-queue' },

  { id: 'conn-audio', parentId: 'site-bitconnection', type: 'feature', title: 'Realtime + audio', subtitle: 'Signaling + direct WebRTC', x: 1008, y: 792 },
  { id: 'conn-signaling', parentId: 'conn-audio', type: 'check', title: 'Realtime signaling', subtitle: 'Requires an active room', x: 1230, y: 744, probeKey: 'conn-signaling' },
  { id: 'conn-ice', parentId: 'conn-audio', type: 'check', title: 'ICE configuration', subtitle: 'Participant-scoped test', x: 1230, y: 816, probeKey: 'conn-ice' },
  { id: 'conn-direct-audio', parentId: 'conn-audio', type: 'check', title: 'Direct WebRTC audio', subtitle: 'Browser session required', x: 1230, y: 888, probeKey: 'conn-direct-audio' },
  { id: 'conn-private-access', parentId: 'conn-audio', type: 'check', title: 'Private-room checks', subtitle: 'Proximity + host code', x: 1230, y: 960, probeKey: 'conn-private-access' }
];

const TOPOLOGY_SIZES = {
  backend: { width: 218, height: 78 },
  page: { width: 204, height: 82 },
  feature: { width: 188, height: 66 },
  check: { width: 184, height: 60 }
};

const TOPOLOGY_STATES = {
  operational: { color: '#62d6a1', label: 'OPERATIONAL' },
  advertised: { color: '#82b9ef', label: 'SUPPORTED' },
  degraded: { color: '#e7b65e', label: 'DEGRADED' },
  partial: { color: '#e7b65e', label: 'PARTIAL' },
  offline: { color: '#f07880', label: 'OFFLINE' },
  idle: { color: '#8e9ba8', label: 'IDLE' },
  unverified: { color: '#748696', label: 'NOT PROBED' }
};

function topologyState(state) {
  return TOPOLOGY_STATES[state] || TOPOLOGY_STATES.unverified;
}

function aggregateTopologyStatus(children) {
  const states = children.map(child => child?.state || 'unverified');
  if (!states.length) return { state: 'unverified', label: 'NOT PROBED', detail: 'No child checks are registered.' };
  if (states.includes('offline')) return { state: 'offline', label: 'OFFLINE', detail: 'At least one child check is unreachable.' };
  if (states.includes('degraded')) return { state: 'degraded', label: 'DEGRADED', detail: 'At least one child check is responding with a degraded result.' };

  const operational = states.filter(state => state === 'operational');
  const advertised = states.filter(state => state === 'advertised');
  const waiting = states.filter(state => state === 'idle' || state === 'unverified');
  if (operational.length && (advertised.length || waiting.length)) {
    return { state: 'partial', label: 'PARTIAL', detail: operational.length + ' child checks are operational; ' + (advertised.length + waiting.length) + ' are capability-only, session-gated, or not independently verified.' };
  }
  if (advertised.length && (waiting.length || !operational.length)) {
    return { state: 'partial', label: 'PARTIAL', detail: advertised.length + ' capabilities are declared; ' + waiting.length + ' require a session or deeper test.' };
  }
  if (operational.length) return { state: 'operational', label: 'OPERATIONAL', detail: 'All child checks were independently verified by live probes.' };
  if (states.every(state => state === 'idle')) return { state: 'idle', label: 'IDLE', detail: 'The feature is available but waiting for an authenticated or active session.' };
  return { state: 'unverified', label: 'NOT PROBED', detail: 'No independent live probe is available for these child features.' };
}

function buildTopologyStatuses(probes) {
  const result = { ...probes };
  for (const node of TOPOLOGY_NODES.filter(item => item.type === 'feature')) {
    const children = TOPOLOGY_NODES.filter(item => item.parentId === node.id).map(item => result[item.id]);
    result[node.id] = aggregateTopologyStatus(children);
  }
  return result;
}

function fitTopologyView(width, height) {
  const graph = { left: 10, top: 8, right: 1430, bottom: 1090 };
  const scale = Math.max(0.28, Math.min(1.05, Math.min((width - 48) / (graph.right - graph.left), (height - 48) / (graph.bottom - graph.top))));
  return {
    scale,
    x: (width - (graph.right - graph.left) * scale) / 2 - graph.left * scale,
    y: (height - (graph.bottom - graph.top) * scale) / 2 - graph.top * scale
  };
}

function truncateCanvasText(context, value, maxWidth) {
  const text = String(value || '');
  if (context.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (shortened.length > 1 && context.measureText(shortened + '…').width > maxWidth) shortened = shortened.slice(0, -1);
  return shortened + '…';
}

function paintCanvasNode(context, node, position, status, scale, selected, hovered) {
  const size = TOPOLOGY_SIZES[node.type] || TOPOLOGY_SIZES.check;
  const { width, height } = size;
  const state = topologyState(status?.state);
  const x = position.x;
  const y = position.y;
  const radius = node.type === 'backend' ? 15 : 11;

  context.save();
  context.shadowColor = selected ? state.color : 'rgba(0,0,0,.32)';
  context.shadowBlur = selected ? 24 / scale : 13 / scale;
  context.shadowOffsetY = 5 / scale;
  context.beginPath();
  if (typeof context.roundRect === 'function') context.roundRect(x, y, width, height, radius);
  else context.rect(x, y, width, height);
  context.fillStyle = node.type === 'backend'
    ? 'rgba(20, 40, 50, .98)'
    : node.type === 'page'
      ? 'rgba(19, 31, 42, .98)'
      : node.type === 'feature'
        ? 'rgba(17, 29, 38, .97)'
        : 'rgba(11, 22, 31, .98)';
  context.fill();
  context.shadowBlur = 0;
  context.lineWidth = (selected ? 2 : hovered ? 1.7 : 1) / scale;
  context.strokeStyle = selected ? state.color : hovered ? 'rgba(193, 231, 229, .72)' : state.color + '88';
  context.stroke();

  context.fillStyle = state.color;
  context.beginPath();
  context.arc(x + width - 16, y + 17, 4.6 / scale, 0, Math.PI * 2);
  context.fill();

  const titleFont = (node.type === 'backend' ? 15 : node.type === 'page' ? 14 : node.type === 'feature' ? 12.5 : 11.5) / scale;
  const subtitleFont = 8.5 / scale;
  context.textBaseline = 'top';
  context.font = '800 ' + titleFont + 'px Inter, ui-sans-serif, system-ui, sans-serif';
  context.fillStyle = node.type === 'backend' ? '#e9fbff' : node.type === 'page' ? '#f2f8fa' : '#e3eef1';
  const titleMax = width - 40;

  if (node.type === 'page' || node.type === 'backend') {
    context.font = '700 ' + (7 / scale) + 'px ui-monospace, monospace';
    context.fillStyle = 'rgba(143, 179, 188, .5)';
    context.fillText(node.type === 'backend' ? 'PRIMARY BACKEND' : 'PRODUCT PAGE', x + 13, y + 8, width - 34);
    context.font = '800 ' + titleFont + 'px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillStyle = node.type === 'backend' ? '#e9fbff' : '#f2f8fa';
    context.fillText(truncateCanvasText(context, node.title, titleMax), x + 13, y + 29, titleMax);
  } else {
    context.fillText(truncateCanvasText(context, node.title, titleMax), x + 13, y + 17, titleMax);
  }

  context.font = '700 ' + subtitleFont + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.fillStyle = node.type === 'check' ? state.color : 'rgba(186, 211, 218, .66)';
  const subtitle = node.type === 'check' || node.type === 'feature' || node.type === 'page' || node.type === 'backend'
    ? (status?.label || (node.type === 'check' ? 'NOT PROBED' : 'CHECKING'))
    : (node.subtitle || '');
  context.fillText(truncateCanvasText(context, subtitle, width - 25), x + 13, y + height - 18, width - 25);

  context.restore();
}

function MapView({ overview, topologyStatuses, topologyBusy, refreshTopology, pageStatuses, openSite, runTest, onTestNode }) {
  const canvasRef = useRef(null);
  const viewportRef = useRef(null);
  const dragRef = useRef(null);
  const viewRef = useRef({ x: 0, y: 0, scale: 0.5 });
  const positionsRef = useRef({});
  const [view, setView] = useState({ x: 0, y: 0, scale: 0.5 });
  const [positions, setPositions] = useState(() => Object.fromEntries(TOPOLOGY_NODES.map(node => [node.id, { x: node.x, y: node.y }])));
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [selectedNodeId, setSelectedNodeId] = useState('deplexo');
  const [hoveredNodeId, setHoveredNodeId] = useState('');
  const [hasCustomLayout, setHasCustomLayout] = useState(false);

  viewRef.current = view;
  positionsRef.current = positions;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const measure = () => setCanvasSize({ width: Math.max(1, viewport.clientWidth), height: Math.max(1, viewport.clientHeight) });
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(viewport);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const fitView = () => setView(fitTopologyView(canvasSize.width, canvasSize.height));
  const zoomBy = amount => setView(current => ({ ...current, scale: Math.max(0.28, Math.min(2.4, current.scale * amount)) }));
  const resetLayout = () => {
    setPositions(Object.fromEntries(TOPOLOGY_NODES.map(node => [node.id, { x: node.x, y: node.y }])));
    setHasCustomLayout(false);
    setSelectedNodeId('deplexo');
    requestAnimationFrame(() => setView(fitTopologyView(canvasSize.width, canvasSize.height)));
  };

  useEffect(() => {
    if (!canvasSize.width || !canvasSize.height) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
    const pixelWidth = Math.round(canvasSize.width * ratio);
    const pixelHeight = Math.round(canvasSize.height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, canvasSize.width, canvasSize.height);
    context.fillStyle = 'rgba(8, 16, 23, .24)';
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);

    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);

    const gridStep = 38;
    context.fillStyle = 'rgba(142, 189, 198, .19)';
    for (let x = 0; x < 1480; x += gridStep) {
      for (let y = 0; y < 1080; y += gridStep) {
        context.beginPath();
        context.arc(x, y, 1.05 / view.scale, 0, Math.PI * 2);
        context.fill();
      }
    }

    const nodeIndex = new Map(TOPOLOGY_NODES.map(node => [node.id, node]));
    for (const node of TOPOLOGY_NODES) {
      if (!node.parentId) continue;
      const parent = nodeIndex.get(node.parentId);
      const parentPosition = positions[parent.id] || parent;
      const childPosition = positions[node.id] || node;
      const parentSize = TOPOLOGY_SIZES[parent.type];
      const childSize = TOPOLOGY_SIZES[node.type];
      const state = topologyState(topologyStatuses[node.id]?.state);
      context.beginPath();
      if (node.type === 'check') {
        const startX = parentPosition.x + parentSize.width;
        const startY = parentPosition.y + parentSize.height / 2;
        const endX = childPosition.x;
        const endY = childPosition.y + childSize.height / 2;
        context.moveTo(startX, startY);
        context.bezierCurveTo(startX + 48, startY, endX - 42, endY, endX, endY);
      } else {
        const startX = parentPosition.x + parentSize.width / 2;
        const startY = parentPosition.y + parentSize.height;
        const endX = childPosition.x + childSize.width / 2;
        const endY = childPosition.y;
        context.moveTo(startX, startY);
        context.bezierCurveTo(startX, startY + 42, endX, endY - 42, endX, endY);
      }
      context.strokeStyle = state.color + '9A';
      context.lineWidth = (node.type === 'page' ? 2.1 : 1.45) / view.scale;
      context.stroke();
      context.beginPath();
      if (node.type === 'check') context.arc(childPosition.x, childPosition.y + childSize.height / 2, 3.4 / view.scale, 0, Math.PI * 2);
      else context.arc(childPosition.x + childSize.width / 2, childPosition.y, 3.4 / view.scale, 0, Math.PI * 2);
      context.fillStyle = state.color;
      context.fill();
    }

    for (const node of TOPOLOGY_NODES) {
      const position = positions[node.id] || node;
      paintCanvasNode(context, node, position, topologyStatuses[node.id], view.scale, selectedNodeId === node.id, hoveredNodeId === node.id);
    }
    context.restore();
  }, [canvasSize, view, positions, topologyStatuses, selectedNodeId, hoveredNodeId]);

  useEffect(() => {
    if (canvasSize.width > 1 && canvasSize.height > 1 && view.scale === 0.5 && view.x === 0 && view.y === 0) {
      setView(fitTopologyView(canvasSize.width, canvasSize.height));
    }
  }, [canvasSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = event => {
      if (event.cancelable) event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const current = viewRef.current;
      const worldX = (localX - current.x) / current.scale;
      const worldY = (localY - current.y) / current.scale;
      const nextScale = Math.max(0.28, Math.min(2.4, current.scale * (event.deltaY < 0 ? 1.12 : 0.89)));
      setView({ scale: nextScale, x: localX - worldX * nextScale, y: localY - worldY * nextScale });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const worldPoint = event => {
    const rect = canvasRef.current.getBoundingClientRect();
    const current = viewRef.current;
    return { x: (event.clientX - rect.left - current.x) / current.scale, y: (event.clientY - rect.top - current.y) / current.scale };
  };

  const findNodeAt = point => {
    for (let index = TOPOLOGY_NODES.length - 1; index >= 0; index -= 1) {
      const node = TOPOLOGY_NODES[index];
      const position = positionsRef.current[node.id] || node;
      const size = TOPOLOGY_SIZES[node.type];
      if (point.x >= position.x && point.x <= position.x + size.width && point.y >= position.y && point.y <= position.y + size.height) return node;
    }
    return null;
  };

  const handlePointerDown = event => {
    if (event.button !== 0) return;
    const point = worldPoint(event);
    const node = findNodeAt(point);
    if (node) {
      setSelectedNodeId(node.id);
      const position = positionsRef.current[node.id] || node;
      dragRef.current = { mode: 'node', nodeId: node.id, pointerX: point.x, pointerY: point.y, startX: position.x, startY: position.y, moved: false };
    } else {
      dragRef.current = { mode: 'pan', clientX: event.clientX, clientY: event.clientY, startX: viewRef.current.x, startY: viewRef.current.y };
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = event => {
    const active = dragRef.current;
    const point = worldPoint(event);
    if (active?.mode === 'node') {
      const dx = point.x - active.pointerX;
      const dy = point.y - active.pointerY;
      if (Math.abs(dx) + Math.abs(dy) > 1) active.moved = true;
      setPositions(current => ({ ...current, [active.nodeId]: { x: active.startX + dx, y: active.startY + dy } }));
      setHasCustomLayout(true);
      return;
    }
    if (active?.mode === 'pan') {
      setView(current => ({ ...current, x: active.startX + event.clientX - active.clientX, y: active.startY + event.clientY - active.clientY }));
      setHoveredNodeId('');
      return;
    }
    setHoveredNodeId(findNodeAt(point)?.id || '');
  };

  const handlePointerUp = () => { dragRef.current = null; };
  const node = TOPOLOGY_NODES.find(item => item.id === selectedNodeId) || TOPOLOGY_NODES[0];
  const nodeStatus = topologyStatuses[node.id] || { state: 'unverified', label: 'NOT PROBED', detail: 'Waiting for the first live check.' };
  const children = TOPOLOGY_NODES.filter(item => item.parentId === node.id);
  const checkCount = TOPOLOGY_NODES.filter(item => item.type === 'check').length;
  const verifiedChecks = TOPOLOGY_NODES.filter(item => item.type === 'check' && ['operational', 'advertised'].includes(topologyStatuses[item.id]?.state)).length;
  return (
    <section className="admin-topology">
      <div className="admin-topology-heading">
        <div><span className="admin-eyebrow">LIVE SYSTEM GRAPH</span><h2>Product topology</h2><p>Follow each product from Deplexo to its main features and individual service checks. Every dot is based on a live response, a declared capability, or an explicitly gated test.</p></div>
        <button type="button" className="admin-button admin-button-primary" onClick={refreshTopology} disabled={topologyBusy}>{topologyBusy ? 'SCANNING FEATURES…' : 'RUN FEATURE SCAN ↻'}</button>
      </div>
      <div className="admin-topology-summary">
        <div><span>REGISTERED ACCOUNTS</span><strong>{overview?.users ?? '—'}</strong></div>
        <div><span>ACTIVE SESSIONS</span><strong>{overview?.activeUsers ?? '—'}</strong></div>
        <div><span>LIVE ROOMS</span><strong>{overview?.activeRooms ?? '—'}</strong></div>
        <div><span>FEATURE CHECKS</span><strong>{verifiedChecks}<small> / {checkCount}</small></strong></div>
      </div>

      <div className="admin-product-previews">
        <div className="admin-product-previews-heading"><div><span className="admin-eyebrow">PRODUCT PAGES</span><h3>Live previews</h3></div><span>REAL PAGES · SAME DEPLOYMENT</span></div>
        <div className="admin-product-preview-grid">
          {SITE_DEFINITIONS.map(site => (
            <SiteNode key={site.id} site={site} status={pageStatuses?.[site.id]} openSite={openSite} runTest={runTest} />
          ))}
        </div>
      </div>
      <AddonTrackTest />

      <div className="admin-canvas-toolbar">
        <div className="admin-canvas-legend">
          <span><i className="is-operational" /> Operational</span>
          <span><i className="is-degraded" /> Degraded</span>
          <span><i className="is-offline" /> Offline</span>
          <span><i className="is-neutral" /> Session / not probed</span>
        </div>
        <div className="admin-canvas-actions">
          <span className="admin-canvas-zoom">{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => zoomBy(0.88)} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => zoomBy(1.14)} aria-label="Zoom in">+</button>
          <button type="button" onClick={fitView}>FIT CANVAS</button>
          <button type="button" onClick={resetLayout}>RESET LAYOUT</button>
          <button type="button" className="is-scan" onClick={refreshTopology} disabled={topologyBusy}>{topologyBusy ? 'SCANNING…' : 'RECHECK ↻'}</button>
        </div>
      </div>

      <div className="admin-topology-workspace">
        <div className="admin-canvas-frame" ref={viewportRef}>
          <canvas
            ref={canvasRef}
            className="admin-topology-canvas"
            aria-label="Interactive architecture canvas. Drag empty space to move the map, drag nodes to rearrange branches, and scroll to zoom."
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onLostPointerCapture={handlePointerUp}
          />
          <div className="admin-canvas-hint"><span>DRAG EMPTY SPACE TO PAN</span><span>DRAG NODES TO REARRANGE</span><span>SCROLL TO ZOOM</span></div>
          <div className="admin-canvas-corner">{TOPOLOGY_NODES.length} NODES · {checkCount} FEATURE CHECKS</div>
          <div className="admin-canvas-noise" />
        </div>

        <aside className="admin-node-inspector">
          <div className="admin-inspector-head">
            <div><span className="admin-eyebrow">NODE INSPECTOR</span><strong>{node.type === 'backend' ? 'Backend' : node.type === 'page' ? 'Product page' : node.type === 'feature' ? 'Feature group' : 'Subfeature'}</strong></div>
            <button type="button" onClick={() => setSelectedNodeId('deplexo')} aria-label="Select Deplexo root">⌂</button>
          </div>
          <div className="admin-inspector-title">
            <h3>{node.title}</h3>
            <span className={'admin-topology-badge state-' + nodeStatus.state}><i />{nodeStatus.label || topologyState(nodeStatus.state).label}</span>
            <p>{node.subtitle || nodeStatus.detail}</p>
            {node.type !== 'backend' && (
              <button type="button" className="admin-button admin-button-primary admin-inspector-test" onClick={() => onTestNode(node)} disabled={topologyBusy}>
                {topologyBusy ? 'RUNNING CHECKS…' : node.type === 'feature' ? 'TEST FEATURE BRANCH' : node.type === 'check' ? 'TEST SUBFEATURE' : 'TEST PAGE + API'}
              </button>
            )}
          </div>
          <div className="admin-inspector-detail">
            <span>CHECK RESULT</span>
            <p>{nodeStatus.detail || 'This node has no independent live probe.'}</p>
            {nodeStatus.endpoint && <div><small>ENDPOINT</small><code>{nodeStatus.endpoint}</code></div>}
            <div className="admin-inspector-metrics">
              <span><small>HTTP</small><strong>{nodeStatus.httpStatus || '—'}</strong></span>
              <span><small>LATENCY</small><strong>{nodeStatus.durationMs != null ? nodeStatus.durationMs + ' ms' : '—'}</strong></span>
            </div>
          </div>
          <div className="admin-inspector-children">
            <span>{children.length ? 'BRANCHES / SUBFEATURES' : 'PARENT BRANCH'}</span>
            {children.length ? children.map(child => {
              const childStatus = topologyStatuses[child.id] || { state: 'unverified', label: 'NOT PROBED' };
              return (
                <div className="admin-inspector-child-row" key={child.id}>
                  <button type="button" className={child.id === selectedNodeId ? 'is-selected' : ''} onClick={() => setSelectedNodeId(child.id)}>
                    <i className={'state-' + childStatus.state} />
                    <span>{child.title}</span>
                    <small>{childStatus.label || topologyState(childStatus.state).label}</small>
                  </button>
                  {child.type !== 'backend' && <button type="button" className="admin-inspector-child-test" onClick={() => onTestNode(child)} disabled={topologyBusy}>TEST</button>}
                </div>
              );
            }) : node.parentId ? (
              <button type="button" onClick={() => setSelectedNodeId(node.parentId)}>
                <i className="state-unverified" /><span>View parent feature</span><small>OPEN</small>
              </button>
            ) : <p className="admin-inspector-empty">Select a page, feature, or subfeature to inspect its branch.</p>}
          </div>
          <div className="admin-inspector-footer">
            <span>{hasCustomLayout ? 'CUSTOM LAYOUT' : 'DEFAULT LAYOUT'}</span>
            <button type="button" onClick={() => setSelectedNodeId(node.parentId || 'deplexo')}>UP ONE LEVEL ↑</button>
          </div>
        </aside>
      </div>

      <div className="admin-topology-footnote">
        <span>LIVE CHECKS RUN FROM THIS BROWSER SESSION.</span>
        <span>SESSION-GATED AND TRACK-DEPENDENT FEATURES ARE LABELLED, NOT ASSUMED HEALTHY.</span>
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
  const [topologyStatuses, setTopologyStatuses] = useState(() => buildTopologyStatuses({}));
  const [topologyBusy, setTopologyBusy] = useState(false);
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

  const refreshTopology = useCallback(async () => {
    setTopologyBusy(true);
    const checkedAt = new Date().toISOString();

    async function probe(endpoint, { method = 'GET', parseJson = true } = {}) {
      const startedAt = performance.now();
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetch(endpoint, {
          method,
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        const payload = parseJson ? await response.json().catch(() => null) : null;
        const durationMs = Math.round(performance.now() - startedAt);
        const state = response.ok
          ? payload?.ok === false || payload?.status === 'bad' ? 'degraded'
            : payload?.status === 'slow' ? 'degraded' : 'operational'
          : response.status >= 500 || response.status === 404 ? 'offline'
            : response.status === 401 ? 'idle' : 'degraded';
        return {
          state,
          httpStatus: response.status,
          durationMs,
          payload,
          endpoint,
          checkedAt,
          error: response.ok ? '' : (payload?.message || payload?.error || 'HTTP ' + response.status)
        };
      } catch (requestError) {
        return {
          state: 'offline',
          httpStatus: null,
          durationMs: Math.round(performance.now() - startedAt),
          payload: null,
          endpoint,
          checkedAt,
          error: requestError?.name === 'AbortError' ? 'Request timed out after 9 seconds.' : (requestError?.message || 'Request failed.')
        };
      } finally {
        window.clearTimeout(timeout);
      }
    }

    const [backend, bitciderPage, bitmonoPage, bitconnectionPage, bitciderApi, monoManifest, monoHealthRaw, connectionHealth, connectionAccount, connectionPasskeys, connectionDirectory] = await Promise.all([
      probe('/api/health'),
      probe('/', { method: 'HEAD', parseJson: false }),
      probe('/bitmono/', { method: 'HEAD', parseJson: false }),
      probe('/bitconnection/', { method: 'HEAD', parseJson: false }),
      probe('/api/status'),
      probe('/bitmono/manifest.json'),
      probe('/api/bitmono/health'),
      probe('/api/bitconnection/health'),
      probe('/api/bitconnection/account'),
      probe('/api/bitconnection/passkeys'),
      probe('/api/bitconnection/rooms/public')
    ]);

    let monoHealth = monoHealthRaw;
    let monoFallbackSearch = false;
    if (monoHealth.httpStatus === 404) {
      monoHealth = await probe('/bitmono/search?q=Daft%20Punk');
      monoFallbackSearch = true;
      if (monoHealth.state === 'operational') {
        const tracks = Array.isArray(monoHealth.payload?.tracks) ? monoHealth.payload.tracks : [];
        const provider = tracks.some(track => String(track?.id || '').startsWith('dzr_')) ? 'deezer' : 'monochrome';
        monoHealth = {
          ...monoHealth,
          payload: {
            ok: tracks.length > 0,
            status: tracks.length ? 'good' : 'bad',
            provider: tracks.length ? provider : null,
            resultCount: tracks.length,
            message: tracks.length ? 'Live search responded through the compatibility route.' : 'The compatibility search returned no tracks.'
          }
        };
        if (!tracks.length) monoHealth.state = 'degraded';
      }
    }

    const bitciderData = bitciderApi.payload || {};
    const ciderConnected = bitciderApi.state === 'operational' && bitciderData.connected === true;
    const relayOnline = ciderConnected && bitciderData.ciderRelay?.online === true;
    const addonUrl = typeof bitciderData.addonUrl === 'string' ? bitciderData.addonUrl : '';
    let addonPath = '';
    let addonManifest = null;
    let addonManifestProbe = null;
    let addonSearchProbe = null;

    if (ciderConnected && addonUrl) {
      try {
        const parsedAddonUrl = new URL(addonUrl, window.location.origin);
        if (/^\/[A-Za-z0-9_-]{1,100}\/manifest\.json$/.test(parsedAddonUrl.pathname)) {
          addonPath = parsedAddonUrl.pathname;
          addonManifestProbe = await probe(addonPath);
          addonManifest = addonManifestProbe.payload;
          addonManifestProbe = {
            ...addonManifestProbe,
            endpoint: '/<personal-key>/manifest.json',
            detail: addonManifestProbe.state === 'operational'
              ? 'The connected account has a personal manifest and the current frontend proxy can reach it.'
              : addonManifestProbe.error
          };
          if (relayOnline && addonManifestProbe.state === 'operational') {
            const searchPath = addonPath.replace(/\/manifest\.json$/, '/search') + '?q=Daft%20Punk';
            addonSearchProbe = await probe(searchPath);
            addonSearchProbe = {
              ...addonSearchProbe,
              endpoint: '/<personal-key>/search?q=Daft+Punk',
              detail: Array.isArray(addonSearchProbe.payload?.tracks) && addonSearchProbe.payload.tracks.length
                ? 'The browser relay returned ' + addonSearchProbe.payload.tracks.length + ' live track result(s).'
                : addonSearchProbe.error || 'The search endpoint responded but did not return tracks.'
            };
            if (addonSearchProbe.state === 'operational' && !(addonSearchProbe.payload?.tracks || []).length) addonSearchProbe.state = 'degraded';
          }
        }
      } catch {
        addonPath = '';
      }
    }

    const probes = {};
    const save = (id, state, label, detail, endpoint, source = null) => {
      probes[id] = {
        state,
        label,
        detail,
        endpoint: endpoint || source?.endpoint || '',
        httpStatus: source?.httpStatus ?? null,
        durationMs: source?.durationMs ?? null,
        checkedAt
      };
    };
    const direct = (id, source, endpoint, detail) => {
      save(
        id,
        source?.state || 'unverified',
        source?.state === 'operational' ? 'OPERATIONAL' : source?.state === 'degraded' ? 'DEGRADED' : source?.state === 'offline' ? 'OFFLINE' : 'NOT PROBED',
        detail || source?.error || 'The endpoint did not return an independent status.',
        endpoint || source?.endpoint,
        source
      );
    };
    const capability = (id, enabled, label, detail, endpoint) => {
      save(id, enabled ? 'advertised' : 'unverified', enabled ? label : 'NOT VERIFIED', enabled ? detail : 'The backend did not advertise this capability.', endpoint);
    };
    const idle = (id, label, detail, endpoint) => save(id, 'idle', label, detail, endpoint);

    save(
      'deplexo',
      backend.state !== 'operational' ? backend.state : backend.payload?.service === 'BitCider' ? 'operational' : 'degraded',
      backend.state !== 'operational' ? 'OFFLINE' : backend.payload?.service === 'BitCider' ? 'OPERATIONAL' : 'IDENTITY MISMATCH',
      backend.payload?.service === 'BitCider'
        ? 'The primary Deplexo API responded with the expected BitCider service identity and API version.'
        : backend.error || 'The endpoint responded, but did not identify itself as the expected BitCider backend.',
      '/api/health',
      backend
    );

    direct('site-bitcider', bitciderPage, '/', bitciderPage.state === 'operational' ? 'The BitCider page returned a successful document response.' : bitciderPage.error);
    direct('site-bitmono', bitmonoPage, '/bitmono/', bitmonoPage.state === 'operational' ? 'The BitMono page returned a successful document response.' : bitmonoPage.error);
    direct('site-bitconnection', bitconnectionPage, '/bitconnection/', bitconnectionPage.state === 'operational' ? 'The BitConnection page returned a successful document response.' : bitconnectionPage.error);

    if (bitciderApi.state !== 'operational') {
      direct('bc-cider-state', bitciderApi, '/api/status', bitciderApi.error);
      direct('bc-browser-relay', bitciderApi, '/api/status', bitciderApi.error);
      direct('bc-account-state', bitciderApi, '/api/status', bitciderApi.error);
      direct('bc-passkeys', bitciderApi, '/api/status', bitciderApi.error);
      direct('bc-encryption', bitciderApi, '/api/status', bitciderApi.error);
      idle('bc-addon-manifest', 'NOT LINKED', 'Link Cider in this browser to provision a personal BitChord manifest.', '/api/status');
      idle('bc-addon-search', 'SESSION REQUIRED', 'A connected Cider account and an active browser relay are required to run a real search.', '/api/status');
      idle('bc-addon-stream', 'TRACK REQUIRED', 'A linked personal add-on and a real track are required to exercise stream resolution.', '/api/status');
      idle('bc-recovery', 'SIGN-IN REQUIRED', 'The account recovery-code inventory is only returned to a signed-in BitCider account.', '/api/status');
      capability('bc-auth-flow', backend.payload?.browserCiderBridgeSupported === true, 'SUPPORTED', 'The backend health contract advertises browser-local Cider authorization and relay support.', '/api/health');
    } else {
      save('bc-cider-state', ciderConnected ? 'operational' : 'idle', ciderConnected ? 'CONNECTED' : 'NOT LINKED', ciderConnected ? 'A personal Cider token and add-on key are attached to this browser session.' : 'No Cider token is connected in this browser session.', '/api/status', bitciderApi);
      save('bc-browser-relay', !ciderConnected ? 'idle' : relayOnline ? 'operational' : 'degraded', !ciderConnected ? 'SESSION REQUIRED' : relayOnline ? 'ONLINE' : 'NOT RESPONDING', !ciderConnected ? 'Link Cider to start the browser-local relay.' : relayOnline ? 'The open BitCider tab is polling and responding to local Cider bridge jobs.' : 'Cider is linked, but the browser relay is not currently reporting an active poll.', '/api/status', bitciderApi);
      save('bc-account-state', bitciderData.account?.authenticated ? 'operational' : 'idle', bitciderData.account?.authenticated ? 'SIGNED IN' : 'SIGNED OUT', bitciderData.account?.authenticated ? 'The BitCider account session is authenticated.' : 'The anonymous browser session is available; no account is currently signed in.', '/api/status', bitciderApi);
      save('bc-passkeys', bitciderData.account?.authenticated ? 'operational' : 'idle', bitciderData.account?.authenticated ? String(bitciderData.passkeyCount || 0) + ' REGISTERED' : 'SIGN-IN REQUIRED', bitciderData.account?.authenticated ? 'The account status endpoint returned its passkey inventory.' : 'Passkey inventory is only returned to an authenticated account.', '/api/status', bitciderApi);
      const recoveryCount = Number(bitciderData.account?.recoveryCodeCount);
      const recoveryReady = bitciderData.account?.authenticated === true && Number.isFinite(recoveryCount);
      save('bc-recovery', !recoveryReady ? 'idle' : recoveryCount > 0 ? 'operational' : 'degraded', !recoveryReady ? 'SIGN-IN REQUIRED' : recoveryCount > 0 ? recoveryCount + ' UNUSED' : 'NO UNUSED CODES', !recoveryReady ? 'The recovery-code inventory requires a signed-in BitCider account.' : recoveryCount > 0 ? 'The account status endpoint reports unused recovery codes.' : 'No unused recovery codes remain for this account. Regenerate them from the account security panel.', '/api/status', bitciderApi);
      save('bc-encryption', bitciderData.tokenEncryptionConfigured ? 'operational' : 'degraded', bitciderData.tokenEncryptionConfigured ? 'DEDICATED KEY READY' : 'VOLUME KEY', bitciderData.tokenEncryptionConfigured ? 'The dedicated Deplexo token-encryption key is configured.' : 'The service is using its persistent-volume fallback key. Configure BITCIDER_ENCRYPTION_KEY for separated key storage.', '/api/status', bitciderApi);
      capability('bc-auth-flow', backend.payload?.browserCiderBridgeSupported === true, 'SUPPORTED', 'The backend health contract advertises browser-local Cider authorization and relay support.', '/api/health');
      if (addonManifestProbe) {
        direct('bc-addon-manifest', addonManifestProbe, '/<personal-key>/manifest.json', addonManifestProbe.detail);
        const personalResources = Array.isArray(addonManifest?.resources) ? addonManifest.resources : [];
        save('bc-addon-stream', personalResources.includes('stream') ? 'advertised' : 'unverified', personalResources.includes('stream') ? 'ROUTE DECLARED' : 'NOT VERIFIED', personalResources.includes('stream') ? 'The personal BitCider manifest declares stream resolution. A real track and connected Cider session are required to verify playback.' : 'The personal manifest did not advertise stream resolution.', '/<personal-key>/manifest.json', addonManifestProbe);
      } else {
        idle('bc-addon-manifest', 'NOT LINKED', 'A personal manifest is created after Cider is linked to this browser.', '/api/status');
        idle('bc-addon-stream', 'TRACK REQUIRED', 'A linked personal add-on and a real track are required to exercise stream resolution.', '/api/status');
      }
      if (addonSearchProbe) {
        direct('bc-addon-search', addonSearchProbe, '/<personal-key>/search?q=Daft+Punk', addonSearchProbe.detail);
      } else {
        idle('bc-addon-search', 'SESSION REQUIRED', 'This probe runs a real Cider catalog search only when the linked browser relay is online.', '/api/status');
      }
    }

    const bitciderManifest = addonManifest || {};
    const bitciderOptions = Array.isArray(bitciderManifest.settings) ? bitciderManifest.settings.flatMap(setting => Array.isArray(setting.options) ? setting.options : []) : [];
    const bitciderAtmos = /dolby\s*atmos/i.test(String(bitciderManifest.description || '')) || bitciderOptions.some(option => /atmos/i.test(String(option.label || option.value || '')));
    capability('bc-renditions', Boolean(addonManifestProbe?.state === 'operational' && bitciderAtmos), 'OPTIONS LISTED', 'The personal manifest advertises supported AAC and Dolby Atmos renditions; actual playback still requires a real track.', '/<personal-key>/manifest.json');

    const manifestPayload = monoManifest.payload || {};
    const monoResources = Array.isArray(manifestPayload.resources) ? manifestPayload.resources : [];
    const monoOptions = Array.isArray(manifestPayload.settings) ? manifestPayload.settings.flatMap(setting => Array.isArray(setting.options) ? setting.options : []) : [];
    save('mono-manifest', monoManifest.state === 'operational' && monoResources.includes('search') && monoResources.includes('stream') ? 'operational' : monoManifest.state, monoManifest.state === 'operational' ? 'SEARCH + STREAM' : (monoManifest.error || 'NOT AVAILABLE'), monoManifest.state === 'operational' ? 'The BitMono manifest advertises both search and stream resources.' : monoManifest.error || 'The BitMono manifest did not advertise the expected resources.', '/bitmono/manifest.json', monoManifest);
    direct('mono-search', monoHealth, monoFallbackSearch ? '/bitmono/search?q=Daft+Punk' : '/api/bitmono/health', monoHealth.payload?.message || (monoHealth.state === 'operational' ? 'The live Monochrome/Deezer song-search pipeline returned a result.' : monoHealth.error));
    const monoProvider = monoHealth.payload?.provider;
    save('mono-primary', monoHealth.state === 'operational' && monoProvider === 'monochrome' ? 'operational' : monoProvider === 'deezer' ? 'degraded' : monoHealth.state === 'offline' ? 'offline' : 'unverified', monoProvider === 'monochrome' ? 'PRIMARY ONLINE' : monoProvider === 'deezer' ? 'FALLBACK IN USE' : 'NOT VERIFIED', monoProvider === 'monochrome' ? 'The primary Monochrome provider returned the live test search.' : monoProvider === 'deezer' ? 'The search pipeline returned results from Deezer because Monochrome did not supply the selected result.' : monoHealth.error || 'A provider-specific live result was not confirmed.', '/api/bitmono/health', monoHealth);
    save('mono-fallback', monoProvider === 'deezer' ? 'operational' : monoProvider === 'monochrome' ? 'idle' : 'unverified', monoProvider === 'deezer' ? 'ACTIVE' : monoProvider === 'monochrome' ? 'STANDBY' : 'NOT VERIFIED', monoProvider === 'deezer' ? 'The Deezer fallback is currently serving the test result.' : monoProvider === 'monochrome' ? 'The primary provider succeeded, so fallback was not needed for this check.' : 'The fallback provider could not be independently confirmed.', '/api/bitmono/health', monoHealth);
    save('mono-stream', monoResources.includes('stream') ? 'advertised' : 'unverified', monoResources.includes('stream') ? 'ROUTE DECLARED' : 'NOT VERIFIED', monoResources.includes('stream') ? 'The addon manifest declares stream resolution. A real track is required to exercise it.' : 'The manifest did not declare stream resolution.', '/bitmono/manifest.json', monoManifest);
    save('mono-cache', 'unverified', 'TRACK REQUIRED', 'The complete-file cache is validated only while resolving and downloading a real track; this console does not download audio as a health check.', 'Track-dependent');
    save('mono-lossless', monoOptions.some(option => /lossless/i.test(String(option.value || '') + ' ' + String(option.label || ''))) ? 'advertised' : 'unverified', monoOptions.some(option => /lossless/i.test(String(option.value || '') + ' ' + String(option.label || ''))) ? 'LOSSLESS LISTED' : 'NOT VERIFIED', 'Lossless choices are declared in the BitMono manifest; an actual stream is needed to verify its delivered codec.', '/bitmono/manifest.json', monoManifest);
    save('mono-hires-atmos', monoOptions.some(option => /hi.?res|atmos/i.test(String(option.value || '') + ' ' + String(option.label || ''))) ? 'advertised' : 'unverified', monoOptions.some(option => /hi.?res|atmos/i.test(String(option.value || '') + ' ' + String(option.label || ''))) ? 'OPTIONS LISTED' : 'NOT VERIFIED', 'Hi-Res and Atmos options are advertised by the manifest; playback output is not inferred from the setting list.', '/bitmono/manifest.json', monoManifest);

    const capabilities = connectionHealth.payload?.capabilities || {};
    direct('conn-account-api', connectionAccount, '/api/bitconnection/account', connectionAccount.state === 'operational' ? (connectionAccount.payload?.authenticated ? 'The BitConnection account endpoint is live and this browser is signed in.' : 'The account endpoint is live; this browser is currently signed out.') : connectionAccount.error);
    const passkeyProtected = connectionPasskeys.httpStatus === 401;
    save('conn-passkeys', passkeyProtected || connectionPasskeys.state === 'operational' ? 'operational' : connectionPasskeys.state, passkeyProtected ? 'AUTH GATED' : connectionPasskeys.state === 'operational' ? 'AVAILABLE' : 'OFFLINE', passkeyProtected ? 'The passkey-listing route is present and correctly requires an authenticated account.' : connectionPasskeys.state === 'operational' ? 'The protected passkey-listing endpoint returned successfully.' : connectionPasskeys.error, '/api/bitconnection/passkeys', connectionPasskeys);
    capability('conn-recovery', capabilities.recoveryCodes === 'enabled', 'DECLARED READY', 'The BitConnection health contract advertises recovery-code support.', '/api/bitconnection/health');
    direct('conn-directory', connectionDirectory, '/api/bitconnection/rooms/public', connectionDirectory.state === 'operational' ? 'The public room directory endpoint is responding with ' + Number(connectionDirectory.payload?.total || 0) + ' open room(s).' : connectionDirectory.error);
    capability('conn-create-room', capabilities.roomCreation === 'enabled', 'DECLARED READY', 'Room creation is advertised; a signed-in account with a completed profile is required to create a real room.', '/api/bitconnection/health');
    capability('conn-playback-sync', Boolean(capabilities.playbackSync), 'DECLARED READY', 'The health contract advertises playback synchronization through BitChord Web.', '/api/bitconnection/health');
    capability('conn-shared-queue', Boolean(capabilities.sharedQueue), 'DECLARED READY', 'The health contract advertises a room-permission-aware shared queue.', '/api/bitconnection/health');
    capability('conn-signaling', String(capabilities.realtimeRooms || '').includes('signaling'), 'SIGNALING DECLARED', 'Realtime polling/signaling is advertised; end-to-end signaling requires an active room.', '/api/bitconnection/health');
    save('conn-ice', capabilities.iceConfiguration ? 'advertised' : 'unverified', capabilities.iceConfiguration ? 'ROOM SCOPED' : 'NOT VERIFIED', capabilities.iceConfiguration ? 'Participant-scoped ICE settings are advertised. The credential endpoint requires an active room participant.' : 'No ICE capability was reported.', '/api/bitconnection/health');
    save('conn-direct-audio', 'unverified', 'BROWSER SESSION', 'Direct WebRTC audio can only be verified while a real host and guest are connected to the same room. Audio is not relayed through Deplexo.', 'Live room required');
    capability('conn-private-access', Boolean(capabilities.privateRoomVerification), 'DECLARED READY', 'Private-room verification is advertised as proximity checks or a host one-time code.', '/api/bitconnection/health');

    setTopologyStatuses(buildTopologyStatuses(probes));
    setPageStatuses(previous => ({
      ...previous,
      bitcider: { ...previous.bitcider, state: bitciderPage.state === 'operational' ? 'online' : bitciderPage.state === 'offline' ? 'offline' : 'warning', label: bitciderPage.state === 'operational' ? 'ONLINE' : bitciderPage.error || 'DEGRADED', httpStatus: bitciderPage.httpStatus, healthStatus: bitciderApi.httpStatus, durationMs: bitciderPage.durationMs, testing: false },
      bitmono: { ...previous.bitmono, state: bitmonoPage.state === 'operational' ? 'online' : bitmonoPage.state === 'offline' ? 'offline' : 'warning', label: bitmonoPage.state === 'operational' ? 'ONLINE' : bitmonoPage.error || 'DEGRADED', httpStatus: bitmonoPage.httpStatus, healthStatus: monoHealth.httpStatus, durationMs: bitmonoPage.durationMs, testing: false },
      bitconnection: { ...previous.bitconnection, state: bitconnectionPage.state === 'operational' ? 'online' : bitconnectionPage.state === 'offline' ? 'offline' : 'warning', label: bitconnectionPage.state === 'operational' ? 'ONLINE' : bitconnectionPage.error || 'DEGRADED', httpStatus: bitconnectionPage.httpStatus, healthStatus: connectionHealth.httpStatus, durationMs: bitconnectionPage.durationMs, testing: false }
    }));
    setTopologyBusy(false);
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
    refreshTopology();
    const dashboardTimer = window.setInterval(() => refreshDashboard().catch(() => {}), 20000);
    const pageTimer = window.setInterval(refreshPageStatuses, 30000);
    const topologyTimer = window.setInterval(refreshTopology, 60000);
    return () => {
      window.clearInterval(dashboardTimer);
      window.clearInterval(pageTimer);
      window.clearInterval(topologyTimer);
    };
  }, [phase, refreshDashboard, refreshPageStatuses, refreshTopology]);

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

  async function runNodeTest(node) {
    setTopologyBusy(true);
    setError('');
    setNotice('Testing ' + node.title + '…');
    const descendants = TOPOLOGY_NODES.filter(candidate => {
      let parentId = candidate.parentId;
      while (parentId) {
        if (parentId === node.id) return true;
        parentId = TOPOLOGY_NODES.find(item => item.id === parentId)?.parentId;
      }
      return false;
    });
    const targets = node.type === 'check'
      ? [node]
      : descendants.filter(candidate => candidate.type === 'check');
    const results = {};
    try {
      if (node.type === 'page') {
        const site = SITE_DEFINITIONS.find(item => item.id === node.id.replace('site-', ''));
        if (site) await runTest(site);
      }
      if (!targets.length && node.type !== 'page') {
        setNotice(node.title + ' has no independently testable child endpoints.');
        return;
      }
      await Promise.all(targets.map(async target => {
        const previous = topologyStatuses[target.id] || {};
        const endpoint = previous.endpoint;
        if (!endpoint || !endpoint.startsWith('/') || endpoint.includes('<personal-key>')) {
          results[target.id] = {
            ...previous,
            checkedAt: new Date().toISOString(),
            detail: (previous.detail || 'No independent HTTP endpoint is available.') + ' This check needs its real user session, track, or active room before it can be exercised safely.'
          };
          return;
        }
        const startedAt = performance.now();
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 9000);
        try {
          const response = await fetch(endpoint, {
            method: target.id.startsWith('site-') ? 'HEAD' : 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            signal: controller.signal
          });
          const payload = target.id.startsWith('site-') ? null : await response.json().catch(() => null);
          const durationMs = Math.round(performance.now() - startedAt);
          const gated = ['idle', 'advertised', 'unverified'].includes(previous.state);
          results[target.id] = {
            ...previous,
            state: response.ok ? (gated ? previous.state : 'operational') : response.status === 401 ? 'idle' : response.status >= 500 || response.status === 404 ? 'offline' : 'degraded',
            label: response.ok ? (gated ? previous.label || 'SESSION / LIVE TEST REQUIRED' : 'OPERATIONAL') : 'HTTP ' + response.status,
            httpStatus: response.status,
            durationMs,
            checkedAt: new Date().toISOString(),
            detail: response.ok
              ? (gated ? (previous.detail || 'This feature is gated.') + ' Its backing endpoint responded successfully, but the feature itself still needs its required session or real resource.' : 'The feature endpoint responded successfully to a live test.')
              : payload?.message || payload?.error || 'The feature endpoint returned HTTP ' + response.status + '.'
          };
        } catch (testError) {
          results[target.id] = {
            ...previous,
            state: 'offline',
            label: 'TEST FAILED',
            durationMs: Math.round(performance.now() - startedAt),
            checkedAt: new Date().toISOString(),
            detail: testError?.name === 'AbortError' ? 'The endpoint timed out after 9 seconds.' : testError.message || 'The endpoint could not be reached.'
          };
        } finally {
          window.clearTimeout(timeout);
        }
      }));
      setTopologyStatuses(current => buildTopologyStatuses({ ...current, ...results }));
      const tested = Object.keys(results).length;
      const blocked = Object.values(results).filter(result => result.label === 'SESSION / LIVE TEST REQUIRED' || result.state === 'idle' || result.state === 'advertised' || result.state === 'unverified').length;
      setNotice(node.title + ': ' + tested + ' check(s) run. ' + blocked + ' still require a real session, track, or active room.');
    } catch (testError) {
      setError(node.title + ': ' + (testError.message || 'Feature test failed.'));
    } finally {
      setTopologyBusy(false);
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
          <div className="admin-console-brand">
            <span className="admin-console-mark">BC</span>
            <div><strong>BITCIDER</strong><small>OWNER CONTROL / PRODUCTION</small></div>
          </div>
          <div className="admin-topbar-state">
            <StatusPill state="online" label="OWNER SESSION" />
            <span>PASSKEY VERIFIED · ONE OWNER SLOT</span>
          </div>
          <div className="admin-topbar-actions">
            <button type="button" className="admin-button admin-button-quiet" onClick={() => { refreshDashboard().catch(() => {}); refreshTopology(); }}>SYNC SYSTEM ↻</button>
            <button type="button" className="admin-button admin-button-quiet" onClick={logout} disabled={busy === 'logout'}>LOCK SESSION</button>
            <button type="button" className="admin-console-close" onClick={onClose} aria-label="Close admin console">×</button>
          </div>
        </header>

        <div className="admin-console-layout">
          <aside className="admin-console-sidebar">
            <div className="admin-sidebar-label">CONTROL ROOM</div>
            {[
              ['map', '⌘', 'System graph', 'Pages + feature health'],
              ['users', '◉', 'Accounts', 'Anonymous moderation'],
              ['bots', '✳', 'Bot factory', 'Test identities'],
              ['diagnostics', '⌁', 'Diagnostics', 'HTTP + API checks']
            ].map(([id, symbol, label, hint], index) => (
              <button key={id} type="button" className={'admin-nav-item' + (tab === id ? ' is-active' : '')} onClick={() => setTab(id)}>
                <span className="admin-nav-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="admin-nav-symbol">{symbol}</span>
                <span className="admin-nav-copy"><strong>{label}</strong><small>{hint}</small></span>
                {tab === id && <i />}
              </button>
            ))}

            <div className="admin-sidebar-spacer" />
            <div className="admin-sidebar-health">
              <div className="admin-sidebar-health-head"><span>PRIMARY BACKEND</span><i /></div>
              <strong>Deplexo</strong>
              <small>Persistent API · main service</small>
              <span className="admin-sidebar-health-foot">3 PRODUCT PAGES CONNECTED</span>
            </div>
            <div className="admin-sidebar-owner">
              <i /><span>OWNER ACCESS</span><small>Fresh passkey required on every console opening.</small>
            </div>
            <div className="admin-sidebar-version">BITCIDER ADMIN · SECURE WORKSPACE</div>
          </aside>

          <main className="admin-console-main">
            {tab === 'map' && <MapView overview={overview} topologyStatuses={topologyStatuses} topologyBusy={topologyBusy} refreshTopology={refreshTopology} pageStatuses={pageStatuses} openSite={page => window.open(page, '_blank', 'noopener,noreferrer')} runTest={runTest} onTestNode={runNodeTest} />}

            {tab === 'users' && (
              <section className="admin-pane">
                <div className="admin-section-heading">
                  <div><span className="admin-eyebrow">ACCOUNT OVERSIGHT</span><h2>Accounts</h2><p>Manage anonymized account records and access state. Usernames, profile data, device names, addresses, and IPs remain hidden.</p></div>
                  <button type="button" className="admin-button admin-button-quiet" onClick={refreshDashboard}>SYNC ACCOUNTS ↻</button>
                </div>
                <div className="admin-user-summary">
                  <div><span>REGISTERED</span><strong>{users.length}</strong></div>
                  <div><span>ACTIVE SESSIONS</span><strong>{users.filter(user => user.active).length}</strong></div>
                  <div><span>SUSPENDED</span><strong>{users.filter(user => user.suspended).length}</strong></div>
                </div>
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
                <p className="admin-privacy-footnote">“Active” means the account made an authenticated request within the last two minutes. These are session-presence estimates, not live network tracking.</p>
              </section>
            )}

            {tab === 'bots' && (
              <section className="admin-pane">
                <div className="admin-section-heading"><div><span className="admin-eyebrow">TEST IDENTITIES</span><h2>Bot factory</h2><p>Create a generated test identity for BitCider, BitConnection, or both products. Generated secrets are only displayed once.</p></div></div>
                <div className="admin-bot-builder">
                  <div className="admin-bot-card-head"><span>NEW BOT IDENTITY</span><StatusPill state="online" label="SERVER GENERATED" /></div>
                  <div className="admin-bot-product-select">
                    <label><span>PRODUCT TARGET</span><select value={botTarget} onChange={event => setBotTarget(event.target.value)}><option value="both">Both products</option><option value="bitcider">BitCider only</option><option value="bitconnection">BitConnection only</option></select></label>
                    <div className="admin-bot-product-hints"><span>BitCider receives an Account Key and password, but no Cider token.</span><span>Paired creation makes separate product records with shared generated sign-in credentials.</span></div>
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
                <div className="admin-section-heading"><div><span className="admin-eyebrow">LIVE SERVICE CHECKS</span><h2>Diagnostics</h2><p>Inspect the page, backing API, latency, and live service response for each product.</p></div><button type="button" className="admin-button admin-button-primary" onClick={runAllTests} disabled={busy === 'tests'}>{busy === 'tests' ? 'TESTING…' : 'RUN ALL TESTS'}</button></div>
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
                <div className="admin-security-note"><strong>ADMIN SECURITY</strong><span>One owner passkey is registered. Bootstrap is consumed. Admin sessions are short-lived, same-site, HttpOnly cookies and require fresh passkey verification whenever admin mode is opened.</span></div>
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
