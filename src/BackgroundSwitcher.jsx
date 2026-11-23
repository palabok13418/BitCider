import { lazy, Suspense, useEffect, useState } from 'react';
import Lightfall from './Lightfall.jsx';
import LineWaves from './LineWaves.jsx';
import AcidSquares from './AcidSquares.jsx';

const AeroShards = lazy(() => import('./AeroShards.jsx'));

const LAST_BACKGROUND_KEY = 'bitcider.background.last.v1';

// Add each new background component here. The picker automatically includes it.
const BACKGROUND_REGISTRY = [
  {
    id: 'lightfall',
    render: ({ warping }) => (
      <Lightfall
        className="site-waves"
        colors={['#fd3f57', '#ff2b5e', '#ff9bac']}
        backgroundColor="#ff2b5e"
        speed={0.23}
        streakCount={3}
        streakWidth={1}
        streakLength={1.2}
        glow={0.9}
        density={0.72}
        twinkle={0.3}
        zoom={3}
        backgroundGlow={0.1}
        headGlow={0.65}
        depth={0.5}
        bloom={0.35}
        opacity={0.68}
        mouseInteraction={false}
        holdToWarp={false}
        warping={warping}
        intro={false}
        fade={0.35}
        dpr={1.5}
      />
    )
  },
  {
    id: 'line-waves',
    render: () => (
      <LineWaves
        className="site-waves"
        color1="#fd3f57"
        color2="#ff2b5e"
        color3="#ff9bac"
        speed={0.3}
        lineCount={72}
        lineWidth={1.3}
        glow={0.6}
        brightness={0.86}
        highlight={1}
        highlightWidth={1}
        warpIntensity={1}
        warpScale={1}
        rotation={-33}
        enableMouseInteraction
        mouseInfluence={2}
        clickRipple
        intro
        opacity={0.82}
        maxDevicePixelRatio={1.75}
      />
    )
  },
  {
    id: 'acid-squares',
    render: () => (
      <AcidSquares
        color="#12080a"
        accentColor="#fd3f57"
        secondaryColor="#ff9bac"
        tileSize={1}
        gap={0.12}
        roundness={0.25}
        softness={0.5}
        bulge={0.3}
        rotation={35}
        gloss={0.72}
        waves={1}
        waveScale={1}
        speed={0.6}
        shape="square"
        pulse={1}
        pulseSpeed={0.45}
        pulseSpacing={1}
        pulseWidth={1}
        pulseOrigin="center"
        brightness={1}
        lighting="split"
        tilt={0.7}
        zoom={1}
        depth={10}
        grain={0.08}
        fade={0.04}
        opacity={0.92}
        intro
        mouseInteraction
        hoverEffect="press"
        mouseStrength={1}
        mouseRadius={0.35}
        pulseOnClick
        detail="medium"
        dpr={1.25}
      />
    )
  },
  {
    id: 'aero-shards',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <AeroShards
          className="site-waves"
          shardColor="#fd3f57"
          accentColor="#ff9bac"
          backgroundColor="transparent"
          lightMode={false}
          placement="full"
          material="glass"
          count={950}
          shardSize={1}
          spread={1}
          twist={1}
          billow={1}
          speed={0.8}
          scale={1}
          depthOfField={0.75}
          glow={0.32}
          grain={0.05}
          vignette={0.24}
          intro
          mouseInteraction
          mouseStrength={0.55}
          markers="plus"
          pulseOnClick
          holdToGather
          parallax={0.5}
          dpr={1.25}
          onError={onError}
        />
      </Suspense>
    )
  }
];

function chooseBackground() {
  let previous = '';
  try {
    previous = window.localStorage.getItem(LAST_BACKGROUND_KEY) || '';
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }

  const available = BACKGROUND_REGISTRY.filter(item => item.id !== previous);
  const choices = available.length ? available : BACKGROUND_REGISTRY;
  return choices[Math.floor(Math.random() * choices.length)]?.id || BACKGROUND_REGISTRY[0].id;
}

export default function BackgroundSwitcher({ warping = false }) {
  const [backgroundId, setBackgroundId] = useState(() => chooseBackground());

  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_BACKGROUND_KEY, backgroundId);
    } catch {
      // Background selection still works when storage is unavailable.
    }
  }, [backgroundId]);

  const selected = BACKGROUND_REGISTRY.find(item => item.id === backgroundId) || BACKGROUND_REGISTRY[0];
  const handleAeroError = error => {
    console.warn('[BitCider] AeroShards is unavailable. Falling back to Lightfall.', error);
    setBackgroundId('lightfall');
  };

  return selected.render({ warping, onError: handleAeroError });
}
