import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './bitconnection-party.css';
import { qrcodegen } from './qrcodegen';


function Icon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  const paths = {
    previous: <><path d="M6 5v14" /><path d="m19 5-9 7 9 7z" /></>,
    next: <><path d="M18 5v14" /><path d="m5 5 9 7-9 7z" /></>,
    play: <path d="m8 5 12 7-12 7z" />,
    pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
    repeat: <><path d="m17 2 4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" /><path d="m7 22-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></>,
    shuffle: <><path d="m18 14 4 4-4 4" /><path d="m18 2 4 4-4 4" /><path d="M2 18h2.5a6 6 0 0 0 4.24-1.76l6.52-6.48A6 6 0 0 1 19.5 8H22" /><path d="M2 6h2.5a6 6 0 0 1 4.24 1.76" /><path d="m14 16 1.26 1.24A6 6 0 0 0 19.5 19H22" /></>,
    waveform: <><path d="M3 10v4" /><path d="M7 6v12" /><path d="M11 3v18" /><path d="M15 7v10" /><path d="M19 5v14" /><path d="M23 10v4" /></>,
    volume: <><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    gif: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M8 9h3v3H8zM16 9h-2v6h2M14 12h2" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    browser: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>,
    music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    crown: <><path d="m2 8 5 4 5-8 5 8 5-4-2 12H4z" /><path d="M4 20h16" /></>,
    grip: <><path d="M9 5v14M15 5v14" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>
  };
  return <svg {...common}>{paths[name] || <circle cx="12" cy="12" r="8" />}</svg>;
}

function PartyQrCode({ value }) {
  const qr = useMemo(() => {
    if (!value) return null;
    try {
      return qrcodegen.QrCode.encodeText(String(value), qrcodegen.QrCode.Ecc.MEDIUM);
    } catch {
      return null;
    }
  }, [value]);

  const path = useMemo(() => {
    if (!qr) return '';
    const segments = [];
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.getModule(x, y)) segments.push(`M${x} ${y}h1v1h-1z`);
      }
    }
    return segments.join('');
  }, [qr]);

  if (!qr) return null;
  const extent = qr.size + 8;
  return (
    <svg
      className="bc-party-room-qr"
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={`QR code containing room code ${value}`}
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#fff" />
      <path d={path} fill="#160a10" transform="translate(4 4)" />
    </svg>
  );
}

function avatarFor(person) {
  if (person?.avatarDataUrl) return <img src={person.avatarDataUrl} alt="" />;
  return <span>{String(person?.username || '?').trim().slice(0, 1).toUpperCase()}</span>;
}

function trackArtwork(track) {
  if (track?.thumbnailUrl) return track.thumbnailUrl;
  if (track?.artwork) return track.artwork;
  if (track?.videoId) return 'https://i.ytimg.com/vi/' + encodeURIComponent(track.videoId) + '/hqdefault.jpg';
  return '';
}

const APPLE_AUDIO_VARIANT_LABELS = {
  'dolby-atmos': 'Dolby Atmos',
  'hi-res-lossless': 'Hi-Res Lossless',
  'lossless': 'Lossless',
  'dolby-audio': 'Dolby Audio',
  'lossy-stereo': 'Lossy Stereo'
};

function qualityLabel(track) {
  const value = String(track?.audioQuality || track?.quality || '').toLowerCase();
  if (value.includes('atmos') || value.includes('joc')) return { label: 'DOLBY ATMOS', src: 'https://mus-api.palabokmagtiis.workers.dev/icons/Dolby%20Atmos.svg' };
  if (value.includes('hi-res') || value.includes('hi res') || value.includes('high-resolution')) return { label: 'HI-RES LOSSLESS', src: 'https://mus-api.palabokmagtiis.workers.dev/icons/Hi-Res%20Lossless.svg' };
  if (value.includes('lossless')) return { label: 'LOSSLESS', src: 'https://mus-api.palabokmagtiis.workers.dev/icons/LOSSLESS.svg' };
  return null;
}


function ttmlTimeToSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?ms$/i.test(raw)) return Number(raw.slice(0, -2)) / 1000;
  if (/^\d+(?:\.\d+)?s$/i.test(raw)) return Number(raw.slice(0, -1));
  const parts = raw.split(':');
  if (parts.length === 3 && parts.every(part => /^\d+(?:\.\d+)?$/.test(part))) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return null;
}

function parseAppleTtml(ttml) {
  if (typeof DOMParser !== 'function' || typeof ttml !== 'string' || !ttml.trim()) return [];
  try {
    const document = new DOMParser().parseFromString(ttml, 'application/xml');
    if (document.getElementsByTagName('parsererror').length) return [];
    const paragraphs = [
      ...document.getElementsByTagNameNS('*', 'p'),
      ...document.getElementsByTagName('p')
    ];
    const seen = new Set();
    return paragraphs.map((paragraph, index) => {
      if (seen.has(paragraph)) return null;
      seen.add(paragraph);
      const text = String(paragraph.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const begin = ttmlTimeToSeconds(paragraph.getAttribute('begin'));
      const end = ttmlTimeToSeconds(paragraph.getAttribute('end'));
      return {
        id: 'apple-ttml-' + index,
        text,
        startSeconds: begin ?? 0,
        endSeconds: end ?? (begin == null ? 0 : begin + 4)
      };
    }).filter(Boolean).sort((left, right) => left.startSeconds - right.startSeconds);
  } catch {
    return [];
  }
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
}

function PartyRoomExperience({
  room,
  roomState,
  session,
  role = 'guest',
  onRoomState = () => {},
  onLeave = () => {},
  audioRef,
  hostAudioState = 'idle',
  hostAudioError = '',
  onStartHostAudio = () => {},
  onStopHostAudio = () => {},
  audioBlocked = false,
  onResumeAudio = () => {},
  onPlayBitMonoTrack = async () => {},
  onControlBitMono = async () => {},
  onSeekBitMono = async () => {},
  onPlayAppleMusicTrack = async () => {},
  onSearchAppleMusicCatalog = async () => [],
  appleMusicPlaybackStatus = 'checking',
  appleMusicPlaybackError = '',
  onControlAppleMusic = async () => {},
  onSeekAppleMusic = async () => {}
}) {
  const [activeTab, setActiveTab] = useState('lyrics');
  const [volume, setVolume] = useState(1);
  const [draft, setDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [gifOpen, setGifOpen] = useState(false);
  const [gifQuery, setGifQuery] = useState('');
  const [gifResults, setGifResults] = useState([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifError, setGifError] = useState('');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState('');
  const [browserMessage, setBrowserMessage] = useState('');
  const [browserRecommendations, setBrowserRecommendations] = useState([]);
  const [browserAppleConnected, setBrowserAppleConnected] = useState(false);
  const [bitMonoSearches, setBitMonoSearches] = useState({});
  const [bitMonoLoading, setBitMonoLoading] = useState({});
  const [browserQuery, setBrowserQuery] = useState('');
  const [browserSearchResults, setBrowserSearchResults] = useState([]);
  const [browserSearchBusy, setBrowserSearchBusy] = useState(false);
  const [browserSearchError, setBrowserSearchError] = useState('');
  const [appleCatalogQuery, setAppleCatalogQuery] = useState('');
  const [appleCatalogResults, setAppleCatalogResults] = useState([]);
  const [appleCatalogBusy, setAppleCatalogBusy] = useState(false);
  const [appleCatalogError, setAppleCatalogError] = useState('');
  const [appleCatalogFormatFilter, setAppleCatalogFormatFilter] = useState('all');
  const [appleMusicEmbed, setAppleMusicEmbed] = useState(null);
  const [bitMonoPrepared, setBitMonoPrepared] = useState({});
  const [bitMonoPrepareBusy, setBitMonoPrepareBusy] = useState({});
  const [appleMusicLyrics, setAppleMusicLyrics] = useState([]);
  const [appleMusicLyricsError, setAppleMusicLyricsError] = useState('');
  const [appleMusicLyricsLoading, setAppleMusicLyricsLoading] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [memberBusy, setMemberBusy] = useState('');
  const [playbackMessage, setPlaybackMessage] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptionSupported, setTranscriptionSupported] = useState(true);
  const [progressSeconds, setProgressSeconds] = useState(0);
  const chatEndRef = useRef(null);
  const composerRef = useRef(null);
  const recognitionRef = useRef(null);
  const draggedQueueIdRef = useRef('');

  const participants = roomState?.participants || [];
  const currentParticipant = roomState?.participant;
  const isHost = currentParticipant ? currentParticipant.role === 'host' : role === 'host';
  const playback = roomState?.playbackState || {};
  const track = playback.track || null;
  const queue = roomState?.queue || [];
  const queueSettings = roomState?.queueSettings || { loop: false, shuffle: false, autoMix: false };
  const chat = roomState?.chat || [];
  const duration = Number(track?.durationSeconds || 0);
  const isPlaying = Boolean(playback.isPlaying);
  const art = trackArtwork(track);
  const quality = qualityLabel(track);
  const filteredAppleCatalogResults = useMemo(() => appleCatalogFormatFilter === 'all'
    ? appleCatalogResults
    : appleCatalogResults.filter(item => item.audioVariants?.includes(appleCatalogFormatFilter)), [appleCatalogResults, appleCatalogFormatFilter]);
  const appleMusicSongId = String(track?.appleMusicSongId || '');
  const appleMusicStorefront = /^[a-z]{2}$/.test(String(track?.appleMusicStorefront || '')) ? String(track.appleMusicStorefront) : 'us';
  const roomName = room?.roomName || roomState?.room?.roomName || 'Listening Party';
  const roomCode = room?.roomCode || roomState?.room?.roomCode || '';
  const allowPlayback = isHost || !room?.ownerOnlyControls;
  const allowQueue = allowPlayback;
  const currentId = currentParticipant?.participantId || session?.participantId;

  useEffect(() => {
    if (audioRef?.current) audioRef.current.volume = volume;
    window.dispatchEvent(new CustomEvent('bitconnection:local-volume', { detail: { roomId: room?.roomId, volume } }));
  }, [volume, audioRef, room?.roomId]);

  useEffect(() => {
    const base = Number(playback.positionSeconds || 0);
    setProgressSeconds(base);
    if (!isPlaying) return undefined;
    const startedAt = playback.updatedAt ? Date.parse(playback.updatedAt) : 0;
    const timer = window.setInterval(() => {
      const current = base + (startedAt > 0 ? Math.max(0, (Date.now() - startedAt) / 1000) : 0);
      setProgressSeconds(Math.min(duration || Number.MAX_SAFE_INTEGER, current));
    }, 500);
    return () => window.clearInterval(timer);
  }, [playback.positionSeconds, playback.updatedAt, isPlaying, duration]);


  useEffect(() => {
    let active = true;
    setAppleMusicLyrics([]);
    setAppleMusicLyricsError('');
    if (!/^[0-9]{1,20}$/.test(appleMusicSongId)) {
      setAppleMusicLyricsLoading(false);
      return () => { active = false; };
    }
    setAppleMusicLyricsLoading(true);
    async function loadAppleMusicLyrics() {
      try {
        const accountResponse = await fetch('/api/bitconnection/account', {
          credentials: 'same-origin', cache: 'no-store'
        });
        const account = await accountResponse.json().catch(() => ({}));
        if (!accountResponse.ok) throw new Error(account.message || 'Could not check your Apple Music account.');
        let identityHeaders = {};
        if (account.bitCiderAccountAvailable) {
          const ciderHeaders = { 'X-BitConnection-Identity': 'bitcider' };
          const ciderResponse = await fetch('/api/bitconnection/account', {
            headers: ciderHeaders, credentials: 'same-origin', cache: 'no-store'
          });
          const ciderAccount = await ciderResponse.json().catch(() => ({}));
          if (ciderResponse.ok && ciderAccount.authenticated) identityHeaders = ciderHeaders;
        }
        const query = new URLSearchParams({ songId: appleMusicSongId, storefront: appleMusicStorefront });
        const response = await fetch('/api/bitconnection/account/providers/apple-music/lyrics?' + query, {
          headers: identityHeaders, credentials: 'same-origin', cache: 'no-store'
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'Apple Music TTML lyrics are unavailable.');
        const lines = parseAppleTtml(payload.ttml || '');
        if (!active) return;
        setAppleMusicLyrics(lines);
        if (!lines.length) setAppleMusicLyricsError('Apple Music returned TTML that could not be parsed into timed lines.');
      } catch (error) {
        if (active) setAppleMusicLyricsError(error.message || 'Apple Music lyrics could not be loaded.');
      } finally {
        if (active) setAppleMusicLyricsLoading(false);
      }
    }
    loadAppleMusicLyrics();
    return () => { active = false; };
  }, [appleMusicSongId, appleMusicStorefront]);

  useEffect(() => {
    if (!session?.getState) return undefined;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const state = await session.getState();
        if (active) onRoomState(state);
      } catch {
        // The transport reports its own connection failures. A quiet state refresh should not replace it.
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(refresh, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session, onRoomState]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [chat.length, activeTab]);

  useEffect(() => () => {
    try { recognitionRef.current?.stop?.(); } catch { /* Recognition may already be stopped. */ }
  }, []);

  const membersById = useMemo(() => new Map(participants.map(person => [person.participantId, person])), [participants]);

  async function refreshState() {
    if (!session?.getState) return;
    const state = await session.getState();
    onRoomState(state);
  }

  async function runPlaybackAction(action) {
    if (!allowPlayback) return;
    setPlaybackMessage('');
    try {
      window.dispatchEvent(new CustomEvent('bitconnection:playback-control', {
        detail: { roomId: room?.roomId, action, track }
      }));
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({
          type: 'BITCONNECTION_PARTY_PLAYBACK_CONTROL',
          roomId: room?.roomId,
          action,
          track
        }, window.location.origin);
      }
      if (track?.source === 'apple-music' && track?.playbackMode === 'embed') {
        if (!isHost) throw new Error('Only the host can control the Apple Music embedded player.');
        setPlaybackMessage('Use the Apple Music player in the Browser panel for playback controls.');
      } else if (track?.source === 'apple-music') {
        if (!isHost) throw new Error('Only the host can control the Apple Music playback session.');
        await onControlAppleMusic(action);
        setPlaybackMessage('Apple Music playback control updated.');
      } else if (track?.source === 'bitmono') {
        if (!isHost) throw new Error('Only the host can control the active Bit Mono audio stream.');
        if (action === 'next' || action === 'previous') {
          setPlaybackMessage('Queue-based next and previous playback will be connected in the next player pass.');
          return;
        }
        await onControlBitMono(action);
        setPlaybackMessage('Bit Mono playback control updated.');
      } else {
        if (action === 'toggle') await session?.updatePlayback?.({ isPlaying: !isPlaying });
        setPlaybackMessage('Party playback state was sent. Direct BitChord source controls still need the player bridge.');
      }
    } catch (error) {
      setPlaybackMessage(error.message || 'Could not update party playback.');
    }
  }

  async function seekTo(value) {
    const next = Math.max(0, Math.min(duration || 86400, Number(value) || 0));
    if (track?.source === 'apple-music' && track?.playbackMode === 'embed') {
      setPlaybackMessage('Use the Apple Music player in the Browser panel to seek.');
      return;
    }
    setProgressSeconds(next);
    try {
      if (track?.source === 'apple-music' && isHost) await onSeekAppleMusic(next);
      else if (track?.source === 'bitmono' && isHost) await onSeekBitMono(next);
      else await session?.updatePlayback?.({ positionSeconds: next });
      window.dispatchEvent(new CustomEvent('bitconnection:playback-control', {
        detail: { roomId: room?.roomId, action: 'seek', positionSeconds: next }
      }));
    } catch (error) {
      setPlaybackMessage(error.message || 'Could not update the shared timeline.');
    }
  }

  async function updateQueueSettings(next) {
    setQueueBusy(true);
    try {
      const result = await session.updateQueue({
        action: 'settings',
        settings: {
          loop: next.loop ?? Boolean(queueSettings.loop),
          shuffle: next.shuffle ?? Boolean(queueSettings.shuffle),
          autoMix: false
        }
      });
      await refreshState();
      if (result?.ok) setPlaybackMessage('');
    } catch (error) {
      setPlaybackMessage(error.message || 'Could not update queue settings.');
    } finally {
      setQueueBusy(false);
    }
  }

  async function moveQueueItem(queueItemId, index) {
    setQueueBusy(true);
    try {
      await session.updateQueue({ action: 'move', queueItemId, index });
      await refreshState();
    } catch (error) {
      setPlaybackMessage(error.message || 'Could not move that song.');
    } finally {
      setQueueBusy(false);
    }
  }

  async function removeQueueItem(queueItemId) {
    setQueueBusy(true);
    try {
      await session.updateQueue({ action: 'remove', queueItemId });
      await refreshState();
    } catch (error) {
      setPlaybackMessage(error.message || 'Could not remove that song.');
    } finally {
      setQueueBusy(false);
    }
  }

  async function sendMessage(payload = {}) {
    if (!session?.sendChat || chatBusy) return;
    const text = String(payload.text ?? draft).trim();
    if (!text && !payload.imageDataUrl && !payload.imageUrl) return;
    setChatBusy(true);
    setChatError('');
    try {
      await session.sendChat({ text, ...(payload.imageDataUrl ? { imageDataUrl: payload.imageDataUrl } : {}), ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}) });
      setDraft('');
      setSelectedImage(null);
      await refreshState();
      composerRef.current?.focus?.();
    } catch (error) {
      setChatError(error.message || 'Could not send your message.');
    } finally {
      setChatBusy(false);
    }
  }

  async function chooseChatImage(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setChatError('Choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > 512 * 1024) {
      setChatError('Images must be 512 KB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setSelectedImage(typeof reader.result === 'string' ? reader.result : null);
      setChatError('');
    };
    reader.onerror = () => setChatError('The selected image could not be read.');
    reader.readAsDataURL(file);
  }

  async function searchGifs(event) {
    event?.preventDefault?.();
    setGifLoading(true);
    setGifError('');
    try {
      const query = new URLSearchParams({ q: gifQuery.trim() || 'music reaction' });
      const response = await fetch('/api/bitconnection/gifs/search?' + query.toString(), {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'GIPHY search is unavailable.');
      setGifResults(Array.isArray(payload.gifs) ? payload.gifs : []);
    } catch (error) {
      setGifError(error.message || 'Could not search GIFs.');
    } finally {
      setGifLoading(false);
    }
  }

  async function pickGif(gif) {
    setGifOpen(false);
    await sendMessage({ imageUrl: gif.url });
  }

  function startVoiceTranscription() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setTranscriptionSupported(false);
      setChatError('Voice transcription is not available in this browser. You can still type a message.');
      return;
    }
    if (isRecording) {
      recognitionRef.current?.stop?.();
      setIsRecording(false);
      return;
    }
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    recognition.onresult = event => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const line = event.results[index][0]?.transcript || '';
        if (event.results[index].isFinal) finalText += line;
        else interim += line;
      }
      setDraft((finalText + (interim ? ' ' + interim : '')).trim());
    };
    recognition.onerror = event => {
      setIsRecording(false);
      setChatError(event.error === 'not-allowed' ? 'Allow microphone access to transcribe a message.' : 'Voice transcription stopped.');
    };
    recognition.onend = () => setIsRecording(false);
    setIsRecording(true);
    try { recognition.start(); } catch (error) {
      setIsRecording(false);
      setChatError(error.message || 'Could not start voice transcription.');
    }
  }

  async function moderateMember(person, action) {
    if (!session?.moderateMember || memberBusy) return;
    setMemberBusy(person.participantId + ':' + action);
    setPlaybackMessage('');
    try {
      await session.moderateMember(person.participantId, action);
      await refreshState();
      if (action === 'promote' && person.participantId === currentId) {
        setPlaybackMessage('You are now the host. Start sharing your BitChord tab audio to host the party stream.');
      }
    } catch (error) {
      setPlaybackMessage(error.message || 'That member action failed.');
    } finally {
      setMemberBusy('');
    }
  }

  function handleQueueDrop(targetId) {
    const sourceId = draggedQueueIdRef.current;
    draggedQueueIdRef.current = '';
    if (!sourceId || sourceId === targetId) return;
    const from = queue.findIndex(item => item.queueItemId === sourceId);
    const to = queue.findIndex(item => item.queueItemId === targetId);
    if (from < 0 || to < 0) return;
    void moveQueueItem(sourceId, to);
  }



  async function loadAppleMusicBrowser() {
    setBrowserLoading(true);
    setBrowserError('');
    setBrowserMessage('');
    setBrowserRecommendations([]);
    setBrowserAppleConnected(false);
    try {
      const accountResponse = await fetch('/api/bitconnection/account', {
        credentials: 'same-origin', cache: 'no-store'
      });
      const account = await accountResponse.json().catch(() => ({}));
      if (!accountResponse.ok) throw new Error(account.message || 'Could not check your BitAccount session.');

      let identityHeaders = {};
      let identityAccount = account;
      if (account.bitCiderAccountAvailable) {
        const linkedHeaders = { 'X-BitConnection-Identity': 'bitcider' };
        const linkedResponse = await fetch('/api/bitconnection/account', {
          headers: linkedHeaders, credentials: 'same-origin', cache: 'no-store'
        });
        const linkedAccount = await linkedResponse.json().catch(() => ({}));
        if (linkedResponse.ok && linkedAccount.authenticated) {
          identityHeaders = linkedHeaders;
          identityAccount = linkedAccount;
        }
      }
      if (!identityAccount.authenticated) {
        setBrowserMessage('Sign in to BitAccount Center to see your personal Apple Music recommendations.');
        return;
      }

      const statusResponse = await fetch('/api/bitconnection/account/providers/apple-music', {
        headers: identityHeaders, credentials: 'same-origin', cache: 'no-store'
      });
      const status = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(status.message || 'Could not check the Apple Music connection.');
      setBrowserAppleConnected(Boolean(status.connected));
      if (!status.connected) {
        setBrowserMessage('Connect Apple Music in BitAccount Center to load subscriber-backed TTML lyrics and any available recommendations.');
        return;
      }
      if (status.recommendationsConfigured === false) {
        setBrowserMessage('Apple Music is connected for TTML lyrics. The optional personalized recommendation feed needs a separate Apple Developer token; Bit Mono search below is still available.');
        return;
      }

      const response = await fetch('/api/bitconnection/account/providers/apple-music/recommendations', {
        headers: identityHeaders, credentials: 'same-origin', cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Apple Music recommendations could not be loaded.');
      setBrowserRecommendations(Array.isArray(payload.recommendations) ? payload.recommendations : []);
      setBrowserAppleConnected(true);
      if (!payload.recommendations?.length) setBrowserMessage('Apple Music did not return any recommendations for this account yet.');
    } catch (error) {
      setBrowserError(error.message || 'Could not load Apple Music recommendations.');
    } finally {
      setBrowserLoading(false);
    }
  }


  async function searchAppleCatalog(event) {
    event.preventDefault();
    const query = appleCatalogQuery.trim();
    if (!query || appleCatalogBusy) return;
    setAppleCatalogBusy(true);
    setAppleCatalogError('');
    setAppleCatalogResults([]);
    try {
      const tracks = await onSearchAppleMusicCatalog(query);
      setAppleCatalogResults(Array.isArray(tracks) ? tracks.slice(0, 25) : []);
      if (!tracks?.length) setAppleCatalogError('No Apple Music catalog songs matched that search.');
    } catch (error) {
      setAppleCatalogError(error.message || 'Apple Music catalog search failed.');
    } finally {
      setAppleCatalogBusy(false);
    }
  }

  async function searchBitMonoCatalog(event) {
    event?.preventDefault?.();
    const query = browserQuery.trim();
    if (!query || browserSearchBusy) return;
    setBrowserSearchBusy(true);
    setBrowserSearchError('');
    setBrowserSearchResults([]);
    try {
      const response = await fetch('/bitmono/search?' + new URLSearchParams({ q: query }), {
        credentials: 'same-origin', cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Bit Mono search is unavailable.');
      setBrowserSearchResults(Array.isArray(payload.tracks) ? payload.tracks.slice(0, 30) : []);
      if (!payload.tracks?.length) setBrowserSearchError('No Bit Mono matches were found for that search.');
    } catch (error) {
      setBrowserSearchError(error.message || 'Could not search Bit Mono.');
    } finally {
      setBrowserSearchBusy(false);
    }
  }

  async function prepareBitMonoTrack(track) {
    const id = String(track?.id || '');
    if (!/^(?:mono_|dzr_)[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    setBitMonoPrepareBusy(previous => ({ ...previous, [id]: true }));
    setPlaybackMessage('');
    try {
      const response = await fetch('/bitmono/stream/' + encodeURIComponent(id) + '?quality=auto', {
        credentials: 'same-origin', cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || 'Bit Mono could not prepare this track.');
      const resolved = new URL(payload.url || '', window.location.origin);
      if (!resolved.pathname.startsWith('/bitmono/audio/')) {
        throw new Error('Bit Mono returned an invalid audio cache URL.');
      }
      const stream = {
        url: resolved.pathname + resolved.search,
        track: {
          trackId: id,
          title: String(track.title || '').slice(0, 180),
          artist: String(track.artist || '').slice(0, 180),
          durationSeconds: Number(track.duration || track.durationSeconds || 0),
          thumbnailUrl: String(track.artworkURL || track.thumbnailUrl || track.artwork || ''),
          audioQuality: String(payload.audioQuality || track.audioQuality || 'LOSSLESS'),
          ...( /^[0-9]{1,20}$/.test(String(track.appleMusicSongId || '')) ? { appleMusicSongId: String(track.appleMusicSongId) } : {}),
          ...( /^[a-z]{2}$/.test(String(track.appleMusicStorefront || '').toLowerCase()) ? { appleMusicStorefront: String(track.appleMusicStorefront).toLowerCase() } : {})
        },
        format: String(payload.format || track.format || ''),
        quality: String(payload.audioQuality || track.audioQuality || ''),
        mimeType: String(payload.mimeType || '')
      };
      if (!stream.track.title || !stream.track.artist || !Number.isFinite(stream.track.durationSeconds) || stream.track.durationSeconds <= 0) {
        throw new Error('Bit Mono returned incomplete track metadata.');
      }
      setBitMonoPrepared(previous => ({ ...previous, [id]: stream }));
      setPlaybackMessage('Bit Mono audio is prepared and ready for the host.');
    } catch (error) {
      setPlaybackMessage(error.message || 'Could not prepare this Bit Mono track.');
    } finally {
      setBitMonoPrepareBusy(previous => ({ ...previous, [id]: false }));
    }
  }

  async function addBitMonoTrackToQueue(track) {
    const durationSeconds = Number(track.duration || track.durationSeconds || 0);
    try {
      await session.updateQueue({
        action: 'add',
        track: {
          source: 'bitmono',
          id: track.id,
          title: track.title,
          artist: track.artist,
          durationSeconds,
          artworkURL: track.artworkURL || track.thumbnailUrl || '',
          audioQuality: track.audioQuality || track.quality || '',
          ...( /^[0-9]{1,20}$/.test(String(track.appleMusicSongId || '')) ? { appleMusicSongId: String(track.appleMusicSongId) } : {}),
          ...( /^[a-z]{2}$/.test(String(track.appleMusicStorefront || '').toLowerCase()) ? { appleMusicStorefront: String(track.appleMusicStorefront).toLowerCase() } : {})
        }
      });
      await refreshState();
      setPlaybackMessage('Added to the shared queue.');
    } catch (error) {
      setPlaybackMessage(error.message || 'Could not add that Bit Mono track to the queue.');
    }
  }

  async function playRecommendedAppleMusicItem(item) {
    if (!isHost) {
      setPlaybackMessage('Only the host can start Apple Music playback for this party.');
      return;
    }
    if (!/^[0-9]{1,20}$/.test(String(item?.id || item?.appleMusicSongId || ''))) {
      setPlaybackMessage('This item does not include a playable Apple Music catalog song ID.');
      return;
    }
    setQueueBusy(true);
    setPlaybackMessage(appleMusicPlaybackStatus === 'ready'
      ? 'Opening Apple Music authorization and starting the full-length track…'
      : 'Opening Apple Music’s embedded player…');
    try {
      const result = await onPlayAppleMusicTrack(item);
      if (result?.playbackMode === 'embed' && result.embedUrl) {
        setAppleMusicEmbed({
          url: result.embedUrl,
          title: String(item.title || 'Apple Music track'),
          artist: String(item.artist || '')
        });
        setPlaybackMessage('Press Play in the Apple Music player below. Share this browser tab to send its audio to party guests.');
      } else {
        setAppleMusicEmbed(null);
        setPlaybackMessage('Apple Music is playing through MusicKit. Start tab-audio sharing to include party guests.');
      }
    } catch (error) {
      setPlaybackMessage(error.message || 'Apple Music could not start this track.');
    } finally {
      setQueueBusy(false);
    }
  }

  async function startPreparedBitMonoTrack(track) {
    const prepared = bitMonoPrepared[String(track.id || '')];
    if (!prepared) return;
    if (!isHost) {
      setPlaybackMessage('Only the host can start a Bit Mono stream for everyone.');
      return;
    }
    try {
      setQueueBusy(true);
      await onPlayBitMonoTrack(prepared.track, prepared.url, prepared.mimeType);
      setPlaybackMessage('Bit Mono is now playing for the party.');
    } catch (error) {
      setPlaybackMessage(error.message || 'Could not start Bit Mono playback.');
    } finally {
      setQueueBusy(false);
    }
  }

  function openBrowser() {
    setBrowserOpen(true);
    void loadAppleMusicBrowser();
  }

  async function searchRecommendationInBitMono(item) {
    const key = String(item?.id || item?.title || '').slice(0, 180);
    if (!key) return;
    setBitMonoLoading(previous => ({ ...previous, [key]: true }));
    setBitMonoSearches(previous => ({ ...previous, [key]: null }));
    try {
      const query = [item.title, item.artist].filter(Boolean).join(' ');
      const response = await fetch('/bitmono/search?' + new URLSearchParams({ q: query }), {
        credentials: 'same-origin', cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Bit Mono search is unavailable.');
      const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
      const appleMusicSongId = item.type === 'songs' && /^[0-9]{1,20}$/.test(String(item.id || '')) ? String(item.id) : '';
      let appleMusicStorefront = 'us';
      try {
        const segments = new URL(item.url).pathname.split('/').filter(Boolean);
        if (/^[a-z]{2}$/i.test(segments[0] || '')) appleMusicStorefront = segments[0].toLowerCase();
      } catch { /* Default to the US storefront when the catalog URL is absent. */ }
      const matchedTracks = tracks.map(track => ({
        ...track,
        ...(appleMusicSongId ? { appleMusicSongId, appleMusicStorefront } : {})
      }));
      setBitMonoSearches(previous => ({ ...previous, [key]: { tracks: matchedTracks, error: '' } }));
    } catch (error) {
      setBitMonoSearches(previous => ({ ...previous, [key]: { tracks: [], error: error.message || 'Bit Mono search failed.' } }));
    } finally {
      setBitMonoLoading(previous => ({ ...previous, [key]: false }));
    }
  }

  const lyrics = appleMusicLyrics.length
    ? appleMusicLyrics
    : Array.isArray(roomState?.lyrics?.lines) ? roomState.lyrics.lines : [];
  const appleTimedLineIndex = appleMusicLyrics.findIndex(line => (
    progressSeconds >= Number(line.startSeconds || 0)
    && progressSeconds < Number(line.endSeconds || Number.MAX_SAFE_INTEGER)
  ));
  const currentLyricIndex = appleMusicLyrics.length
    ? appleTimedLineIndex >= 0 ? appleTimedLineIndex
      : progressSeconds >= Number(appleMusicLyrics[appleMusicLyrics.length - 1]?.startSeconds || 0)
        ? appleMusicLyrics.length - 1 : -1
    : Number.isInteger(roomState?.lyrics?.currentIndex) ? roomState.lyrics.currentIndex : -1;

  return (
    <main className="bc-party-room" data-role={isHost ? 'host' : 'guest'}>
      <section className="bc-party-room-share" aria-label="Room code and QR code">
          <div className="bc-party-room-code-copy">
            <span className="bc-party-room-code-label">ROOM CODE</span>
            <div className="bc-party-room-code-row">
              <strong className="bc-party-room-code-value">{roomCode || '--------'}</strong>
              {roomCode && (
                <button className="bc-party-copy-code" type="button" onClick={() => navigator.clipboard?.writeText(roomCode).catch(() => {})}>
                  <Icon name="copy" size={14}/>Copy code
                </button>
              )}
            </div>
            <small>Enter this code in BitChord or scan the QR code to read it.</small>
          </div>
          <div className="bc-party-room-qr-wrap">
            {roomCode ? <PartyQrCode value={roomCode}/> : <div className="bc-party-room-qr-placeholder" aria-hidden="true"/>}
            <span>ROOM QR</span>
          </div>
        </section>

      <section className="bc-party-playback-panel" aria-label="Playback">
        <div className="bc-party-left-heading">
          <span className="bc-party-live-dot" />
          <span>{isHost ? 'HOSTING PARTY' : 'LISTENING TOGETHER'}</span>
        </div>
        <div className="bc-party-artwork-wrap">
          {art ? <img className="bc-party-artwork" src={art} alt={track?.title ? 'Album artwork for ' + track.title : 'Album artwork'} /> : <div className="bc-party-artwork bc-party-artwork-empty"><Icon name="waveform" size={52}/></div>}
        </div>
        <div className="bc-party-track-copy">
          <strong title={track?.title || ''}>{track?.title || 'Waiting for the next track'}</strong>
          <span title={track?.artist || ''}>{track?.artist || 'Your party soundtrack starts here'}</span>
        </div>
        <div className="bc-party-timeline">
          <input
            type="range"
            min="0"
            max={Math.max(duration, 1)}
            value={Math.min(progressSeconds, Math.max(duration, 1))}
            onChange={event => setProgressSeconds(Number(event.target.value))}
            onPointerUp={() => void seekTo(progressSeconds)}
            onKeyUp={() => void seekTo(progressSeconds)}
            aria-label="Playback position"
            disabled={!duration || (track?.source === 'apple-music' && (!isHost || track?.playbackMode === 'embed'))}
          />
          <div><span>{formatTime(progressSeconds)}</span><span>{formatTime(duration)}</span></div>
        </div>
        {track?.source === 'apple-music' ? (
          <div className="bc-party-quality bc-party-quality-apple" aria-label="Apple Music audio formats available for this song">
            <span className="bc-party-quality-caption">AVAILABLE FORMATS</span>
            {track.audioVariants?.length
              ? track.audioVariants.map(variant => <span className="bc-party-format-chip" key={variant}>{APPLE_AUDIO_VARIANT_LABELS[variant] || variant}</span>)
              : <span className="bc-party-quality-note">Apple did not return format availability for this track.</span>}
            <span className="bc-party-quality-note">Apple selects the active format using its playback settings, device support and network conditions.</span>
          </div>
        ) : (
          <div className="bc-party-quality" aria-label={quality?.label || 'Source audio format not reported'}>{quality?.src ? <img src={quality.src} alt={quality.label} title={quality.label}/> : <><span className="bc-party-quality-mark" />BITCHORD WEB AUDIO</>}</div>
        )}
        <div className="bc-party-transport-controls">
          <button type="button" onClick={() => void runPlaybackAction('previous')} disabled={!allowPlayback || (track?.source === 'apple-music' && (!isHost || track?.playbackMode === 'embed'))} aria-label="Previous track" title="Previous track"><Icon name="previous" size={23}/></button>
          <button className="bc-party-play-toggle" type="button" onClick={() => void runPlaybackAction('toggle')} disabled={!allowPlayback || (track?.source === 'apple-music' && (!isHost || track?.playbackMode === 'embed'))} aria-label={isPlaying ? 'Pause' : 'Play'} title={isPlaying ? 'Pause' : 'Play'}><Icon name={isPlaying ? 'pause' : 'play'} size={25}/></button>
          <button type="button" onClick={() => void runPlaybackAction('next')} disabled={!allowPlayback || (track?.source === 'apple-music' && (!isHost || track?.playbackMode === 'embed'))} aria-label="Next track" title="Next track"><Icon name="next" size={23}/></button>
        </div>
        <div className="bc-party-volume">
          <Icon name="volume" size={17}/>
          <input type="range" min="0" max="1" step="0.01" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="Volume" disabled={track?.playbackMode === 'embed'}/> 
          <span>{Math.round(volume * 100)}%</span>
        </div>
        {audioBlocked && !isHost && <button className="bc-party-resume-audio" type="button" onClick={onResumeAudio}>Tap to enable party audio</button>}
        {isHost && (
          <div className="bc-party-host-audio">
            <div className="bc-party-host-audio-status">
              <span className={hostAudioState === 'streaming' ? 'is-live' : ''}/>
              {hostAudioState === 'streaming' ? 'BitChord tab audio is being shared' : 'Share the BitChord Web tab to start party audio'}
            </div>
            {hostAudioError && <p role="alert">{hostAudioError}</p>}
            {hostAudioState === 'streaming'
              ? <button type="button" onClick={onStopHostAudio}>Stop audio sharing</button>
              : <button type="button" onClick={onStartHostAudio} disabled={hostAudioState === 'requesting'}>{hostAudioState === 'requesting' ? 'Opening tab picker…' : 'Share BitChord tab audio'}</button>}
          </div>
        )}
        {playbackMessage && <div className="bc-party-inline-status" role="status">{playbackMessage}</div>}
        <button className="bc-party-leave" type="button" onClick={onLeave}>Leave party</button>
      </section>

      <section className="bc-party-content-panel" aria-label="Party content">
        <header className="bc-party-content-heading">
          <div>
            <span className="bc-party-eyebrow">{isHost ? 'HOSTING' : 'JOINED'} · LISTENING PARTY</span>
            <h1>{roomName}</h1>
          </div>
          <div className="bc-party-header-actions">
            <div className="bc-party-member-count"><span/>{participants.length} members</div>
          </div>
        </header>

  

        <div className={'bc-party-tab-content is-' + activeTab}>
          {activeTab === 'lyrics' && (
            <section className="bc-party-lyrics" aria-label="Lyrics">
              {lyrics.length ? (
                <div className="bc-party-lyrics-list">
                  {lyrics.map((line, index) => (
                    <p key={line.id || index} className={index === currentLyricIndex ? 'is-current' : index < currentLyricIndex ? 'is-past' : ''}>{line.text || line}</p>
                  ))}
                </div>
              ) : (
                <div className="bc-party-lyrics-empty">
                  <Icon name="waveform" size={40}/>
                  <strong>{appleMusicLyricsLoading ? 'Fetching Apple Music TTML lyrics…' : appleMusicLyricsError && appleMusicSongId ? 'Apple Music lyrics unavailable' : 'Lyrics will appear here'}</strong>
                  <span>{appleMusicLyricsLoading ? 'Checking the connected subscriber token for word- and line-timed lyrics.' : appleMusicLyricsError && appleMusicSongId ? appleMusicLyricsError : appleMusicSongId ? 'Apple Music did not return timed lyrics for this track.' : 'Connect BitChord’s synchronized lyrics feed or play a matched Apple Music recommendation to load subscriber-backed TTML.'}</span>
                </div>
              )}
            </section>
          )}

          {activeTab === 'queue' && (
            <section className="bc-party-queue">
              <div className="bc-party-queue-actions">
                <button type="button" className={queueSettings.loop ? 'is-active' : ''} onClick={() => void updateQueueSettings({ loop: !queueSettings.loop })} disabled={queueBusy} aria-pressed={Boolean(queueSettings.loop)}><Icon name="repeat" size={17}/>Loop</button>
                <button type="button" className={queueSettings.shuffle ? 'is-active' : ''} onClick={() => void updateQueueSettings({ shuffle: !queueSettings.shuffle })} disabled={queueBusy} aria-pressed={Boolean(queueSettings.shuffle)}><Icon name="shuffle" size={17}/>Shuffle</button>
                <button type="button" className="is-automix" disabled title="Server-side ONNX AutoMix is not installed on this deployment"><Icon name="waveform" size={17}/>AutoMix <small>Unavailable</small></button>
              </div>
              <div className="bc-party-queue-list">
                {queue.length ? queue.map((item, index) => {
                  const addedBy = membersById.get(item.addedByParticipantId);
                  const image = trackArtwork(item);
                  return (
                    <article className="bc-party-queue-card" key={item.queueItemId} draggable={allowQueue && !queueBusy} onDragStart={() => { draggedQueueIdRef.current = item.queueItemId; }} onDragOver={event => event.preventDefault()} onDrop={() => handleQueueDrop(item.queueItemId)}>
                      <div className="bc-party-queue-cover">
                        {image ? <img src={image} alt=""/> : <Icon name="waveform" size={22}/>}
                        <span className="bc-party-queue-added-by">{avatarFor(addedBy)}</span>
                      </div>
                      <div className="bc-party-queue-copy"><strong>{item.title}</strong><span>{item.artist}</span><small>Added by {addedBy?.username || 'a party member'}</small></div>
                      {allowQueue && <button className="bc-party-queue-remove" type="button" onClick={() => void removeQueueItem(item.queueItemId)} aria-label={'Remove ' + item.title} title="Remove from queue"><Icon name="close" size={16}/></button>}
                      <button className="bc-party-queue-grip" type="button" disabled={!allowQueue || queueBusy} aria-label={'Queue position ' + (index + 1)} title="Drag this song to change its position"><Icon name="grip" size={23}/></button>
                    </article>
                  );
                }) : <div className="bc-party-queue-empty"><Icon name="waveform" size={34}/><strong>Nothing queued yet</strong><span>Add songs from BitChord Web to build the party queue.</span></div>}
              </div>
              <p className="bc-party-small-note">{allowQueue ? 'Drag a song card to change its position.' : 'The host controls this queue.'}</p>
            </section>
          )}

          {activeTab === 'chat' && (
            <section className="bc-party-chat">
              <div className="bc-party-chat-messages" aria-live="polite">
                {chat.length ? chat.map(message => (
                  <article className={'bc-party-chat-message' + (message.participantId === currentId ? ' is-own' : '')} key={message.messageId}>
                    <div className="bc-party-avatar">{avatarFor({ username: message.username, avatarDataUrl: message.avatarDataUrl })}</div>
                    <div className="bc-party-chat-message-body">
                      <div className="bc-party-chat-meta"><strong>{message.username}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>
                      {message.text && <p>{message.text}</p>}
                      {message.imageDataUrl && <img className="bc-party-chat-image" src={message.imageDataUrl} alt="Image shared in party chat"/>}
                      {message.imageUrl && <img className="bc-party-chat-image" src={message.imageUrl} alt={message.imageType === 'gif' ? 'GIF shared in party chat' : 'Image shared in party chat'}/>}
                    </div>
                  </article>
                )) : <div className="bc-party-chat-empty">The room is quiet. Start the conversation.</div>}
                <div ref={chatEndRef}/>
              </div>
              {chatError && <div className="bc-party-chat-error" role="alert">{chatError}</div>}
              {selectedImage && <div className="bc-party-image-preview"><img src={selectedImage} alt="Ready to send"/><button type="button" onClick={() => setSelectedImage(null)} aria-label="Remove selected image"><Icon name="close" size={15}/></button></div>}
              <form className="bc-party-composer" onSubmit={event => { event.preventDefault(); void sendMessage({ text: draft, ...(selectedImage ? { imageDataUrl: selectedImage } : {}) }); }}>
                <textarea ref={composerRef} value={draft} onChange={event => setDraft(event.target.value)} rows="1" maxLength="1000" placeholder="Message the party…" aria-label="Message the party"/>
                <div className="bc-party-composer-tools">
                  <div>
                    <button type="button" onClick={() => { setGifOpen(true); setGifError(''); }} aria-label="Choose a GIF" title="GIF"><Icon name="gif" size={19}/></button>
                    <label className="bc-party-file-button" aria-label="Attach an image" title="Image only"><Icon name="image" size={18}/><input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseChatImage}/></label>
                    <button type="button" onClick={startVoiceTranscription} className={isRecording ? 'is-recording' : ''} aria-label="Transcribe voice to text" title={transcriptionSupported ? 'Voice to text' : 'Voice transcription unavailable'}><Icon name="mic" size={18}/></button>
                  </div>
                  <button className="bc-party-send" type="submit" disabled={chatBusy || (!draft.trim() && !selectedImage)} aria-label="Send message"><Icon name="send" size={17}/></button>
                </div>
              </form>
              <div className="bc-party-composer-footnote">{isRecording ? 'Listening… speak your message' : 'Images only · Voice is transcribed into editable text'}</div>

              {gifOpen && createPortal(
                <div className="bc-party-gif-overlay" role="dialog" aria-modal="true" aria-label="GIF picker">
                  <div className="bc-party-gif-picker">
                    <div className="bc-party-gif-heading"><strong>Find a GIF</strong><button type="button" onClick={() => setGifOpen(false)} aria-label="Close GIF picker"><Icon name="close"/></button></div>
                    <form className="bc-party-gif-search" onSubmit={searchGifs}><input value={gifQuery} onChange={event => setGifQuery(event.target.value)} placeholder="Search GIFs"/><button type="submit" disabled={gifLoading}>{gifLoading ? 'Searching…' : 'Search'}</button></form>
                    {gifError && <p className="bc-party-chat-error">{gifError}</p>}
                    <div className="bc-party-gif-results">
                      {gifResults.map(gif => <button type="button" key={gif.id} onClick={() => void pickGif(gif)}><img src={gif.preview} alt="Choose GIF"/></button>)}
                    </div>
                    <small>Powered by GIPHY</small>
                  </div>
                </div>,
                document.body
              )}
            </section>
          )}

          {activeTab === 'members' && (
            <section className="bc-party-members">
              {participants.map(person => (
                <article className="bc-party-member-card" key={person.participantId}>
                  <div className="bc-party-avatar">{avatarFor(person)}</div>
                  <div className="bc-party-member-copy"><strong>{person.username}</strong><span>{person.role === 'host' ? 'Host' : person.status === 'connected' ? 'Listening now' : 'Reconnecting'}{person.participantId === currentId ? ' · You' : ''}</span></div>
                  {person.role === 'host' && <span className="bc-party-host-badge"><Icon name="crown" size={13}/>HOST</span>}
                  {isHost && person.participantId !== currentId && person.role !== 'host' && (
                    <div className="bc-party-member-actions">
                      <button type="button" onClick={() => void moderateMember(person, 'promote')} disabled={Boolean(memberBusy)} title="Promote to host"><Icon name="crown" size={15}/></button>
                      <button type="button" onClick={() => void moderateMember(person, 'kick')} disabled={Boolean(memberBusy)} title="Kick from party">Kick</button>
                      <button type="button" onClick={() => void moderateMember(person, 'ban')} disabled={Boolean(memberBusy) || !person.canBan} title={person.canBan ? 'Ban from party' : 'A persistent ban needs this member to sign in'}>Ban</button>
                    </div>
                  )}
                </article>
              ))}
            </section>
          )}
        </div>

        <nav className="bc-party-tab-bar" aria-label="Party sections">
          {[
            { id: 'lyrics', label: 'Lyrics', symbol: '≋' },
            { id: 'queue', label: 'Queue', symbol: '☷' },
            { id: 'chat', label: 'Chat', symbol: '◌' },
            { id: 'members', label: 'Members', symbol: '◎' }
          ].map(tab => (
            <button type="button" key={tab.id} className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setActiveTab(tab.id)} aria-current={activeTab === tab.id ? 'page' : undefined}>
              <span>{tab.symbol}</span>{tab.label}{tab.id === 'chat' && chat.length > 0 ? <small>{chat.length > 99 ? '99+' : chat.length}</small> : null}
            </button>
          ))}
        </nav>
      </section>

      {createPortal(
        <button className="bc-party-browser-button" type="button" onClick={openBrowser} aria-haspopup="dialog" aria-expanded={browserOpen}>
          <Icon name="browser" size={18}/><span>Browser</span>
        </button>,
        document.body
      )}
      {browserOpen && createPortal(
        <div className="bc-party-browser-overlay" role="dialog" aria-modal="true" aria-label="Apple Music Browser" onMouseDown={event => { if (event.target === event.currentTarget) setBrowserOpen(false); }}>
          <section className="bc-party-browser-panel">
            <header className="bc-party-browser-heading">
              <div>
                <span>APPLE MUSIC · PERSONALIZED FOR YOU</span>
                <h2>Browser</h2>
                <p>Your Apple Music recommendations, with Bit Mono catalogue matches.</p>
              </div>
              <button type="button" onClick={() => setBrowserOpen(false)} aria-label="Close Browser"><Icon name="close" size={20}/></button>
            </header>
            <div className="bc-party-browser-toolbar">
              <span className={browserAppleConnected ? 'is-connected' : ''}><i/>{browserAppleConnected ? 'APPLE MUSIC CONNECTED' : 'APPLE MUSIC'}</span>
              <button type="button" onClick={() => void loadAppleMusicBrowser()} disabled={browserLoading}><Icon name="repeat" size={14}/>{browserLoading ? 'Loading…' : 'Refresh'}</button>
            </div>
            {appleMusicPlaybackStatus === 'ready' && (
              <div className="bc-party-inline-status" role="status">Direct Apple Music playback is ready in this browser.</div>
            )}
            {appleMusicPlaybackStatus === 'checking' && (
              <div className="bc-party-inline-status" role="status">Initializing Apple's direct playback engine…</div>
            )}
            {appleMusicPlaybackStatus === 'embed-ready' && (
              <div className="bc-party-inline-status" role="status">No developer token is configured. Apple’s embedded player can still play full songs when you sign in to Apple Music inside the player.</div>
            )}
            {appleMusicPlaybackStatus === 'unavailable' && (
              <div className="bc-party-inline-status" role="status">{appleMusicPlaybackError || 'MusicKit is unavailable. Apple’s embedded player remains available for full songs.'}</div>
            )}
            {appleMusicEmbed && (
              <section className="bc-party-apple-embed" aria-label="Apple Music player">
                <header>
                  <div><strong>{appleMusicEmbed.title}</strong><small>{appleMusicEmbed.artist || 'Apple Music'}</small></div>
                  <button type="button" onClick={() => setAppleMusicEmbed(null)} aria-label="Close Apple Music player"><Icon name="close" size={17}/></button>
                </header>
                <iframe
                  title={'Apple Music player — ' + appleMusicEmbed.title}
                  src={appleMusicEmbed.url}
                  width="100%"
                  height="175"
                  frameBorder="0"
                  allow="autoplay *; encrypted-media *; fullscreen *; clipboard-write"
                  loading="lazy"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
                <p>Sign in to Apple Music in the player for full-length playback. The host must share this browser tab for party guests to hear it.</p>
              </section>
            )}
            <form className="bc-party-browser-search" onSubmit={searchAppleCatalog}>
              <Icon name="music" size={17}/>
              <input value={appleCatalogQuery} onChange={event => setAppleCatalogQuery(event.target.value)} placeholder="Search the Apple Music catalog…" aria-label="Search Apple Music catalog"/>
              <button type="submit" disabled={appleCatalogBusy || !appleCatalogQuery.trim()}>{appleCatalogBusy ? 'Searching…' : 'Search Apple Music'}</button>
            </form>
            {appleCatalogResults.length > 0 && appleCatalogResults.some(item => item.audioVariants?.length) && (
              <div className="bc-party-browser-format-filter">
                <label htmlFor="bc-apple-format-filter">FILTER BY AVAILABLE FORMAT</label>
                <select id="bc-apple-format-filter" value={appleCatalogFormatFilter} onChange={event => setAppleCatalogFormatFilter(event.target.value)}>
                  <option value="all">All formats</option>
                  <option value="dolby-atmos">Dolby Atmos</option>
                  <option value="hi-res-lossless">Hi-Res Lossless</option>
                  <option value="lossless">Lossless</option>
                  <option value="dolby-audio">Dolby Audio</option>
                </select>
                <small>Filters by Apple's reported track availability, not the active stream format.</small>
              </div>
            )}
            {(appleCatalogResults.length > 0 || appleCatalogError) && (
              <section className="bc-party-browser-search-results">
                <div className="bc-party-browser-search-title">APPLE MUSIC RESULTS {filteredAppleCatalogResults.length ? '· ' + filteredAppleCatalogResults.length + (filteredAppleCatalogResults.length !== appleCatalogResults.length ? ' / ' + appleCatalogResults.length : '') : ''}</div>
                {appleCatalogError && <p>{appleCatalogError}</p>}
                {appleCatalogResults.length > 0 && filteredAppleCatalogResults.length === 0 && <p>No Apple Music search results advertise this format.</p>}
                {filteredAppleCatalogResults.map(item => {
                  const id = String(item.id || '');
                  return (
                    <article className="bc-party-browser-search-track" key={id}>
                      {item.artworkUrl ? <img src={item.artworkUrl.replace('{w}', '160').replace('{h}', '160')} alt="" loading="lazy"/> : <span className="bc-party-browser-track-fallback"><Icon name="music" size={16}/></span>}
                      <div className="bc-party-browser-track-copy">
                        <strong>{item.title}</strong>
                        <small>{[item.artist, item.album].filter(Boolean).join(' · ')}</small>
                        <span className="bc-party-format-list">
                          {item.audioVariants?.length
                            ? item.audioVariants.map(variant => <span className="bc-party-format-chip" key={variant}>{APPLE_AUDIO_VARIANT_LABELS[variant] || variant}</span>)
                            : <span className="bc-party-quality-note">Format availability not reported</span>}
                        </span>
                      </div>
                      <div className="bc-party-browser-search-actions">
                        <button type="button" onClick={() => void playRecommendedAppleMusicItem(item)} disabled={!isHost || queueBusy}>{queueBusy ? 'Starting…' : 'Play full song'}</button>
                      </div>
                    </article>
                  );
                })}
              </section>
            )}
            <form className="bc-party-browser-search" onSubmit={searchBitMonoCatalog}>
              <Icon name="browser" size={17}/>
              <input value={browserQuery} onChange={event => setBrowserQuery(event.target.value)} placeholder="Search songs in Bit Mono…" aria-label="Search Bit Mono songs"/>
              <button type="submit" disabled={browserSearchBusy || !browserQuery.trim()}>{browserSearchBusy ? 'Searching…' : 'Search Bit Mono'}</button>
            </form>
            {(browserSearchResults.length > 0 || browserSearchError) && (
              <section className="bc-party-browser-search-results">
                <div className="bc-party-browser-search-title">BIT MONO RESULTS {browserSearchResults.length ? '· ' + browserSearchResults.length : ''}</div>
                {browserSearchError && <p>{browserSearchError}</p>}
                {browserSearchResults.map(item => {
                  const id = String(item.id || '');
                  const prepared = bitMonoPrepared[id];
                  return (
                    <article className="bc-party-browser-search-track" key={id}>
                      {item.artworkURL ? <img src={item.artworkURL} alt="" loading="lazy"/> : <span className="bc-party-browser-track-fallback"><Icon name="music" size={16}/></span>}
                      <div><strong>{item.title}</strong><small>{[item.artist, item.album, item.audioQuality].filter(Boolean).join(' · ')}</small></div>
                      <div className="bc-party-browser-search-actions">
                        <button type="button" onClick={() => void addBitMonoTrackToQueue(item)}>Queue</button>
                        {!prepared
                          ? <button type="button" onClick={() => void prepareBitMonoTrack(item)} disabled={Boolean(bitMonoPrepareBusy[id])}>{bitMonoPrepareBusy[id] ? 'Preparing…' : 'Prepare'}</button>
                          : <button type="button" onClick={() => void startPreparedBitMonoTrack(item)} disabled={!isHost || queueBusy}>{isHost ? 'Play in party' : 'Host only'}</button>}
                      </div>
                    </article>
                  );
                })}
              </section>
            )}
            {browserLoading && <div className="bc-party-browser-state"><span className="bc-party-browser-spinner"/><strong>Loading your recommendations</strong><small>Checking your connected Apple Music account</small></div>}
            {!browserLoading && browserError && <div className="bc-party-browser-state is-error"><strong>Could not load Browser</strong><small>{browserError}</small><button type="button" onClick={() => void loadAppleMusicBrowser()}>Try again</button></div>}
            {!browserLoading && !browserError && browserMessage && (
              <div className="bc-party-browser-state">
                <strong>{browserAppleConnected ? 'No recommendations yet' : 'Connect Apple Music'}</strong>
                <small>{browserMessage}</small>
                {!browserAppleConnected && <button type="button" onClick={() => window.open('/bitconnection/?account=1', 'bitconnection-account', 'popup=yes,width=920,height=760,resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no')}>Open BitAccount Center <Icon name="more" size={14}/></button>}
              </div>
            )}
            {!browserLoading && !browserError && browserRecommendations.length > 0 && (
              <div className="bc-party-browser-recommendations">
                {browserRecommendations.map((recommendation, index) => (
                  <article className="bc-party-browser-recommendation" key={recommendation.id || index}>
                    <div className="bc-party-browser-recommendation-head">
                      {recommendation.artworkUrl
                        ? <img src={recommendation.artworkUrl} alt="" loading="lazy"/>
                        : <span className="bc-party-browser-art-fallback"><Icon name="waveform" size={21}/></span>}
                      <div><span>RECOMMENDED FOR YOU</span><strong>{recommendation.title}</strong>{recommendation.description && <small>{recommendation.description}</small>}</div>
                    </div>
                    {recommendation.items?.length > 0 && (
                      <div className="bc-party-browser-track-list">
                        {recommendation.items.map((item, itemIndex) => {
                          const key = String(item.id || item.title || itemIndex).slice(0, 180);
                          const search = bitMonoSearches[key];
                          return (
                            <div className="bc-party-browser-track" key={key}>
                              {item.artworkUrl ? <img src={item.artworkUrl} alt="" loading="lazy"/> : <span className="bc-party-browser-track-fallback"><Icon name="music" size={16}/></span>}
                              <div><strong>{item.title}</strong><small>{[item.artist, item.album].filter(Boolean).join(' · ')}</small></div>
                              {item.type === 'songs' && /^[0-9]{1,20}$/.test(String(item.id || '')) && (
                                <button type="button" onClick={() => void playRecommendedAppleMusicItem(item)} disabled={!isHost || queueBusy} title={isHost ? 'Play the full-length song through Apple Music' : 'Only the host can start Apple Music playback'}>
                                  {queueBusy ? 'Starting…' : 'Play Apple Music'}
                                </button>
                              )}
                              <button type="button" onClick={() => void searchRecommendationInBitMono(item)} disabled={Boolean(bitMonoLoading[key])}>{bitMonoLoading[key] ? 'Searching…' : search ? 'Search again' : 'Find in Bit Mono'}</button>
                              {search && (
                                <div className="bc-party-browser-mono-results">
                                  {search.error
                                    ? <small className="is-error">{search.error}</small>
                                    : search.tracks.length
                                      ? search.tracks.slice(0, 4).map(track => {
                                          const id = String(track.id || '');
                                          const prepared = bitMonoPrepared[id];
                                          return (
                                            <div className="bc-party-browser-mono-result" key={id}>
                                              <span><strong>{track.title}</strong><small>{track.artist}{track.audioQuality ? ' · ' + track.audioQuality : ''}</small></span>
                                              <div>
                                                <button type="button" onClick={() => void addBitMonoTrackToQueue(track)}>Queue</button>
                                                {!prepared
                                                  ? <button type="button" onClick={() => void prepareBitMonoTrack(track)} disabled={Boolean(bitMonoPrepareBusy[id])}>{bitMonoPrepareBusy[id] ? 'Preparing…' : 'Prepare'}</button>
                                                  : <button type="button" onClick={() => void startPreparedBitMonoTrack(track)} disabled={!isHost || queueBusy}>{isHost ? 'Play' : 'Host only'}</button>}
                                              </div>
                                            </div>
                                          );
                                        })
                                      : <small>No Bit Mono matches were found.</small>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </article>
                ))}
                <p className="bc-party-browser-footnote">Play Apple Music catalog songs directly through MusicKit, or find a compatible Bit Mono source. For party audio, the host can share this browser tab.</p>
              </div>
            )}
          </section>
        </div>,
        document.body
      )}
    </main>
  );
}

export default PartyRoomExperience;
