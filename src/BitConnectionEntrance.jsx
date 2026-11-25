import { useEffect, useRef, useState } from 'react';
import './bitconnection-entrance.css';

const REVEAL_KEY = 'bitconnection.konami-unlocked.v1';
const KONAMI_CODE = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'b', 'a', 'Enter'
];

function hasBeenUnlocked() {
  try {
    return window.sessionStorage.getItem(REVEAL_KEY) === '1';
  } catch {
    return false;
  }
}

export default function BitConnectionEntrance() {
  const [unlocked, setUnlocked] = useState(hasBeenUnlocked);
  const [transition, setTransition] = useState(null);
  const sequenceRef = useRef([]);
  const navigationTimerRef = useRef(null);
  const navigationStartedRef = useRef(false);

  useEffect(() => {
    function handleKeyDown(event) {
      if (unlocked || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      )) {
        sequenceRef.current = [];
        return;
      }

      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const candidate = [...sequenceRef.current, key];
      while (candidate.length && !KONAMI_CODE.slice(0, candidate.length).every((expected, index) => candidate[index] === expected)) {
        candidate.shift();
      }
      sequenceRef.current = candidate;

      if (candidate.length !== KONAMI_CODE.length) return;
      sequenceRef.current = [];
      setUnlocked(true);
      try { window.sessionStorage.setItem(REVEAL_KEY, '1'); } catch {}

      const site = document.querySelector('.site-shell');
      if (site) {
        site.classList.remove('bitconnection-unlock-shake');
        void site.offsetWidth;
        site.classList.add('bitconnection-unlock-shake');
        window.setTimeout(() => site.classList.remove('bitconnection-unlock-shake'), 720);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [unlocked]);

  useEffect(() => () => {
    if (navigationTimerRef.current) window.clearTimeout(navigationTimerRef.current);
  }, []);

  function launchBitConnection(event) {
    event.preventDefault();
    if (navigationStartedRef.current) return;
    navigationStartedRef.current = true;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const x = Number.isFinite(event.clientX) ? event.clientX : width / 2;
    const y = Number.isFinite(event.clientY) ? event.clientY : height / 2;
    const farthestCorner = Math.max(
      Math.hypot(x, y),
      Math.hypot(width - x, y),
      Math.hypot(x, height - y),
      Math.hypot(width - x, height - y)
    );
    const diameter = Math.ceil(farthestCorner * 2.1);

    try {
      window.sessionStorage.setItem('bitconnection.entry-transition.v1', JSON.stringify({
        startedAt: Date.now(),
        originX: x,
        originY: y
      }));
    } catch {}

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      window.location.assign('/bitconnection/');
      return;
    }

    setTransition({ x, y, diameter });
    navigationTimerRef.current = window.setTimeout(() => {
      window.location.assign('/bitconnection/');
    }, 820);
  }

  return (
    <>
      <a
        className={`bitconnection-footer-link ${unlocked ? 'is-revealed' : ''}`}
        href="/bitconnection/"
        onClick={launchBitConnection}
        aria-hidden={!unlocked}
        tabIndex={unlocked ? 0 : -1}
      >
        BitConnection
      </a>
      {transition && (
        <div className="bitconnection-launch-cover" aria-hidden="true">
          <span
            className="bitconnection-launch-circle"
            style={{
              left: transition.x,
              top: transition.y,
              width: transition.diameter,
              height: transition.diameter
            }}
          />
        </div>
      )}
    </>
  );
}
