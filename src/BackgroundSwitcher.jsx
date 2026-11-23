import { lazy, Suspense, useState } from 'react';
import Lightfall from './Lightfall.jsx';
import LineWaves from './LineWaves.jsx';
import AcidSquares from './AcidSquares.jsx';

const Balatro = lazy(() => import('./Balatro.jsx'));
const GradientWaves = lazy(() => import('./GradientWaves.jsx'));
const LaserFlow = lazy(() => import('./LaserFlow.jsx'));
const LightTunnel = lazy(() => import('./LightTunnel.jsx'));
const PrismaticBurst = lazy(() => import('./PrismaticBurst.jsx'));
const SideRays = lazy(() => import('./SideRays.jsx'));
const Silk = lazy(() => import('./Silk.jsx'));
const Topography = lazy(() => import('./Topography.jsx'));
const WebThreads = lazy(() => import('./WebThreads.jsx'));
const HoloMosaic = lazy(() => import('./HoloMosaic.jsx'));
const Grainient = lazy(() => import('./Grainient.jsx'));
const GradientASCII = lazy(() => import('./GradientASCII.jsx'));

const AeroShards = lazy(() => import('./AeroShards.jsx'));


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
  },
  {
    id: 'balatro',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <Balatro
          className="site-waves"
          color1="#fd3f57"
          color2="#ff9bac"
          color3="#210b12"
          contrast={3.6}
          lighting={0.42}
          swirl={0.32}
          speed={0.8}
          rotationSpeed={0.035}
          scale={1}
          detail={5}
          pixelSize={1.4}
          crt={0}
          mouseInteraction
          mouseStrength={0.85}
          clickSwirl
          intro
          lightMode={false}
          opacity={0.86}
          maxDevicePixelRatio={1.5}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'gradient-waves',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <GradientWaves
          className="site-waves"
          horizonColor="#fd3f57"
          waveColor="#ff2b5e"
          crestColor="#ffdce2"
          backgroundColor="transparent"
          lightMode={false}
          speed={0.3}
          amplitude={2.7}
          waveScale={0.65}
          waveRatio={0.92}
          swell={35}
          turbulence={20}
          tilt={64}
          zoom={1}
          height={5.5}
          fogDepth={15}
          relief={1}
          lightAngle={120}
          sheen={0.28}
          brightness={0.95}
          opacity={0.88}
          grain={0.08}
          quality="medium"
          intro
          mouseInteraction
          parallaxStrength={0.46}
          mouseStrength={0.62}
          swellOnClick
          dpr={1.35}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'laser-flow',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <LaserFlow
          className="site-waves"
          beamPosition={0.52}
          surfaceLevel={0.82}
          color="#fd3f57"
          intensity={0.95}
          beamWidth={1.25}
          flare={1.3}
          spread={1.25}
          spill={0.62}
          fog={0.18}
          dust={0.7}
          streaks={1.05}
          dots={0.34}
          pulse={0.5}
          speed={0.52}
          seed={7}
          mouseInteraction
          intro
          theme="dark"
          paused={false}
          dpr={1.25}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'light-tunnel',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <LightTunnel
          className="site-waves"
          cableColor="#fd3f57"
          pulseColor="#ff2b5e"
          tunnelColor="#ff9bac"
          tunnelOpacity={0.12}
          speed={0.075}
          flowDirection="inward"
          pulseSpeed={1.7}
          pulseLength={0.32}
          pulseBlend={0.64}
          pulseWidth={1.05}
          pulseDensity={0.62}
          cableCount={68}
          thickness={0.42}
          rimWidth={0.24}
          waviness={0.42}
          sway={0.52}
          bend={0.48}
          size={1}
          glow={1.1}
          fadeNear={0.38}
          fadeFar={2.2}
          brightness={0.92}
          colorVariance
          grain
          grainIntensity={0.035}
          opacity={0.88}
          mouseInteraction
          mouseStrength={0.085}
          clickSurge
          intro
          variation={7}
          lightMode={false}
          dpr={1.3}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'prismatic-burst',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <PrismaticBurst
          className="site-waves"
          colors={['#fd3f57', '#ff2b5e', '#ff9bac', '#ffdce2']}
          intensity={1.9}
          speed={0.36}
          animationType="rotate3d"
          distort={2.2}
          rayCount={0}
          rayWidth={1.05}
          zoom={1}
          twist={0.16}
          flow={0.18}
          centerFade={1.14}
          grain={0.42}
          glow={0.78}
          mouseInteraction
          mouseStrength={0.42}
          hoverDampness={0.3}
          clickBurst
          intro
          fade={0.08}
          quality="high"
          lightMode={false}
          paused={false}
          dpr={1.2}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'side-rays',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <SideRays
          className="site-waves"
          rayColor1="#fd3f57"
          rayColor2="#ff9bac"
          blend={0.58}
          origin="top-right"
          speed={0.78}
          intensity={1.65}
          spread={2.65}
          density={7}
          sharpness={0.62}
          tilt={-8}
          falloff={1.72}
          glow={1.05}
          saturation={1.08}
          dust={0.2}
          followMouse
          mouseInfluence={0.38}
          intro
          lightMode={false}
          opacity={0.86}
          maxDevicePixelRatio={1.35}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'silk',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <Silk
          className="site-waves"
          speed={2.35}
          scale={1.05}
          color="#fd3f57"
          sheenColor="#ffb5c1"
          noiseIntensity={0.72}
          rotation={-0.16}
          sheen={0.72}
          depth={0.72}
          glow={0.42}
          ripple={0.85}
          wave={0.82}
          variation={11}
          mouseInteraction
          interactionStrength={0.62}
          clickRipple
          intro
          fade={0.06}
          lightMode={false}
          paused={false}
          dpr={1.3}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'topography',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <Topography
          className="site-waves"
          color="#fd3f57"
          lineCount={25}
          lineWidth={1.05}
          majorLines
          elevation={1.05}
          foreground={0.22}
          scale={1.08}
          detail={0.32}
          tilt={34}
          speed={0.075}
          direction="forward"
          morph={0.13}
          glow={0.36}
          depthOfField={0.38}
          fog={0.48}
          brightness={0.9}
          opacity={0.84}
          mouseInteraction
          hoverEffect="lift"
          mouseRadius={1.05}
          mouseStrength={0.46}
          trail={0.28}
          parallax={0.38}
          clickEffect="pulse"
          markers="none"
          glitch={0.025}
          intro
          lightMode={false}
          dpr={1.2}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'web-threads',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <WebThreads
          className="site-waves"
          colors={['#fd3f57', '#ff2b5e', '#ff9bac', '#ffdce2']}
          coreColor="#ffe6eb"
          backgroundColor="transparent"
          lightMode={false}
          threadCount={14}
          speed={0.18}
          frequency={6.2}
          spread={0.22}
          taper={0.7}
          position={0.5}
          pinch={0.5}
          nodes={2}
          angle={-8}
          glow={0.035}
          falloff={0.72}
          thickness={1.35}
          brightness={0.9}
          opacity={0.86}
          depth={0.34}
          pulses={0.16}
          mirror
          shimmer
          fade={0.12}
          grain={0.025}
          intro
          mouseInteraction
          mouseStrength={0.55}
          pulseOnClick
          paused={false}
          dpr={1.25}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'holo-mosaic',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <HoloMosaic
          className="site-waves"
          color="#21080f"
          metalColor="#ff9bac"
          spectrum="pearl"
          tileSize={1.18}
          gap={0.12}
          roundness={0.22}
          bevel={0.62}
          rotation={-12}
          scatter={0.34}
          tilt={0.52}
          swirl={1.25}
          ripple={0.82}
          bands={1.4}
          softness={0.62}
          intensity={1.22}
          saturation={0.82}
          glitter={0.55}
          sheen={1.05}
          grain={0.035}
          speed={0.28}
          variation={19}
          filter="none"
          filterSize={1}
          fade={0.1}
          opacity={0.82}
          intro
          mouseInteraction
          mouseStrength={0.78}
          mouseRadius={0.3}
          flipOnClick
          lightMode={false}
          paused={false}
          dpr={1.2}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'grainient',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <Grainient
          className="site-waves"
          colors={['#16090e', '#4b1020', '#8c1836', '#d9274c', '#fd3f57', '#ff9bac', '#ffdce2']}
          type="linear"
          angle={42}
          bands={1.35}
          speed={0.3}
          flow={0.92}
          scale={1.12}
          softness={0.74}
          silk={0.68}
          grainAmount={0.055}
          grainSize={1.25}
          grainAnimated
          contrast={1.12}
          saturation={1.08}
          variation={31}
          interactive
          stir={0.9}
          clickSwirl
          intro
          lightMode={false}
          dpr={1.2}
          onError={onError}
        />
      </Suspense>
    )
  },
  {
    id: 'gradient-ascii',
    render: ({ onError }) => (
      <Suspense fallback={null}>
        <GradientASCII
          className="site-waves"
          colors={['#16090e', '#561226', '#a51c40', '#fd3f57', '#ff8fab', '#ffe1e7']}
          shape="horizon"
          characters=" .,:;-=+*xX0S8#@"
          cellSize={17}
          density={0.82}
          glyphOpacity={0.94}
          glow={0.42}
          depthOfField={0.2}
          flicker={0.16}
          softness={0.68}
          scale={1.08}
          flow={0.72}
          speed={0.28}
          gradientOpacity={0.78}
          grain={0.035}
          variation={27}
          mouseInteraction
          scrambleRadius={0.095}
          clickEffect="wave"
          intro
          lightMode={false}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
          dpr={1.2}
          onError={onError}
        />
      </Suspense>
    )
  }
];

function secureRandomIndex(length) {
  if (!Number.isSafeInteger(length) || length <= 0) return 0;

  const cryptoProvider = typeof window !== 'undefined' ? window.crypto : null;
  if (!cryptoProvider || typeof cryptoProvider.getRandomValues !== 'function') {
    console.error('[BitCider] Secure browser randomness is unavailable. Using the first registered background as a safe fallback.');
    return 0;
  }

  // Rejection sampling avoids modulo bias, so every registered background
  // has the same probability of being selected.
  const range = 0x1_0000_0000;
  const limit = range - (range % length);
  const sample = new Uint32Array(1);
  let value;

  do {
    cryptoProvider.getRandomValues(sample);
    value = sample[0];
  } while (value >= limit);

  return value % length;
}

function chooseBackground() {
  if (BACKGROUND_REGISTRY.length === 0) return 'lightfall';
  return BACKGROUND_REGISTRY[secureRandomIndex(BACKGROUND_REGISTRY.length)]?.id || 'lightfall';
}

export default function BackgroundSwitcher({ warping = false, mode = 'cider' }) {
  const [backgroundId, setBackgroundId] = useState(() => chooseBackground());

  const selected = BACKGROUND_REGISTRY.find(item => item.id === backgroundId) || BACKGROUND_REGISTRY[0];
  const handleBackgroundError = error => {
    console.warn('[BitCider] The selected animated background is unavailable. Falling back to Lightfall.', error);
    setBackgroundId('lightfall');
  };

  if (mode === 'mono') {
    return (
      <Suspense fallback={null}>
        <Grainient
          className="site-waves"
          colors={['#030303', '#151515', '#343434', '#676767', '#a0a0a0', '#dedede']}
          type="linear"
          angle={42}
          bands={1.25}
          speed={0.22}
          flow={0.82}
          scale={1.08}
          softness={0.76}
          silk={0.7}
          grainAmount={0.045}
          grainSize={1.15}
          grainAnimated
          contrast={1.08}
          saturation={0.16}
          variation={41}
          interactive
          stir={0.7}
          clickSwirl
          intro
          lightMode={false}
          dpr={1.2}
        />
      </Suspense>
    );
  }

  return selected.render({ warping, onError: handleBackgroundError });
}
