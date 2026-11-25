import { lazy, Suspense, useEffect, useState } from 'react';
import './bitconnection.css';

const Grainient = lazy(() => import('./Grainient.jsx'));
const ENTRY_KEY = 'bitconnection.entry-transition.v1';

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

export default function BitConnection() {
  const [apiState, setApiState] = useState('checking');
  const [showHostInfo, setShowHostInfo] = useState(false);
  const [entryStage, setEntryStage] = useState(initialEntryStage);

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

      // Two complete flame sweeps give the new page time to finish painting beneath the black cover.
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
        <p className="bitconnection-intro">
          Start a listening party from your BitChord Web player and bring everyone into the same moment.
        </p>
        <div className="bitconnection-actions">
          <button className="bitconnection-create-button" type="button" onClick={() => setShowHostInfo(true)}>
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

      {showHostInfo && (
        <div className="bitconnection-dialog-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setShowHostInfo(false);
        }}>
          <section className="bitconnection-host-dialog" role="dialog" aria-modal="true" aria-labelledby="bitconnection-host-title">
            <div className="bitconnection-dialog-eyebrow">HOST A LISTENING PARTY</div>
            <h2 id="bitconnection-host-title">Your room starts with you.</h2>
            <p>
              Hosts need a BitConnection account. The account setup and room-creation service are the next backend pieces being connected to Deplexo.
            </p>
            <button type="button" onClick={() => setShowHostInfo(false)}>Got it</button>
          </section>
        </div>
      )}

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
