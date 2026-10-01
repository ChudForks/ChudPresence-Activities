let lastSerialized = null;
let lastSentAt = 0;
let lastPlaybackState = 'none';
let pendingState = '';
let pendingStateSince = 0;
let activitySettings = { showAlbum: true, showArtwork: true, displayMode: 'artist' };
// Expanding the player can briefly remove its title or pause the media element.
const TRANSIENT_STATE_MS = 1250;
const PAUSE_ARTWORK_URL = 'https://raw.githubusercontent.com/ChudForks/ChudPresence-Activities/main/presence-assets/pause.png';

function textOf(node) {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim();
}

function parseClock(value) {
  if (!value) return 0;
  const parts = String(value).trim().split(':').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseTimeInfo(value) {
  const [left, right] = String(value || '').replace(/\s+/g, ' ').trim().split('/');
  return { position: parseClock(left), duration: parseClock(right) };
}

function videoIdFromHref(href) {
  if (!href) return '';
  try {
    return new URL(href, location.origin).searchParams.get('v') || '';
  } catch {
    return String(href).match(/[?&]v=([\w-]{11})/)?.[1] || '';
  }
}

function videoIdFromThumb(src) {
  return String(src || '').match(/\/vi\/([\w-]{11})\//)?.[1] || '';
}

function artistSearchUrl(artist) {
  const query = String(artist || '').replace(/\s+/g, ' ').trim();
  if (!query) return '';
  const url = new URL('https://music.youtube.com/search');
  url.searchParams.set('q', query);
  return url.toString();
}

function musicLink(anchor) {
  if (!anchor?.href) return '';
  try {
    const url = new URL(anchor.href, location.origin);
    return url.protocol === 'https:' && url.hostname === 'music.youtube.com' &&
      !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function bestArtwork(sessionArt, fallback) {
  const list = Array.isArray(sessionArt) ? sessionArt : [];
  let best = '';
  let bestSize = -1;
  for (const item of list) {
    if (!item?.src || !item.src.startsWith('https:') || item.src.length > 2048) continue;
    const size = Number.parseInt(String(item.sizes || '').split('x')[0], 10) || 0;
    if (size >= bestSize) {
      best = item.src;
      bestSize = size;
    }
  }
  return best || (fallback?.startsWith('https:') && fallback.length <= 2048 ? fallback : '') || '';
}

function isAd() {
  return Boolean(
    document.querySelector('.ytmusic-player-bar.advertisement') ||
    document.querySelector('.ad-showing') ||
    document.querySelector('ytmusic-player-bar[is-advertisement]'),
  );
}

function isPlaying(video) {
  if (video && !video.paused && !video.ended) return true;
  if (navigator.mediaSession?.playbackState === 'playing') return true;
  const button = document.querySelector(
    '#play-pause-button, ytmusic-player-bar #play-pause-button, ytmusic-player-bar .play-pause-button',
  );
  const label = `${button?.getAttribute('title') || ''} ${button?.getAttribute('aria-label') || ''}`.toLowerCase();
  if (label.includes('pause')) return true;
  return false;
}

function collect() {
  if (isAd()) return null;
  const bar = document.querySelector('ytmusic-player-bar');
  const video = document.querySelector('video') || ChudPresence.media.find();
  const mediaSnapshot = video ? ChudPresence.media.snapshot(video) : null;
  const sessionMetadata = navigator.mediaSession?.metadata;
  const metadata = sessionMetadata ? {
    title: sessionMetadata.title || '',
    artist: sessionMetadata.artist || '',
    album: sessionMetadata.album || '',
    artwork: [...(sessionMetadata.artwork || [])].map((item) => ({ src: item.src, sizes: item.sizes || '' })),
  } : {};
  const title = textOf(bar?.querySelector('.title')) || metadata.title || '';
  if (!title) return null;

  const bylineLinks = [...(bar?.querySelectorAll('.byline a, .subtitle a') || [])]
    .map(textOf).filter(Boolean);
  const artist = metadata.artist || bylineLinks[0] || textOf(bar?.querySelector('.byline, .subtitle')) || '';
  const rawAlbum = metadata.album || bylineLinks[1] || '';
  const album = rawAlbum && !rawAlbum.toLowerCase().includes((title.split('(')[0] || '').trim().toLowerCase())
    ? rawAlbum
    : '';
  const linkedByline = [...(bar?.querySelectorAll('.byline a, .subtitle a') || [])];
  const artistUrl = musicLink(linkedByline[0]);
  const albumUrl = album ? musicLink(linkedByline.find((link) =>
    textOf(link).toLowerCase() === album.toLowerCase())) : '';
  const image = bar?.querySelector('img.image, .image img, .thumbnail-image-wrapper img');
  const artwork = bestArtwork(metadata.artwork, image?.currentSrc || image?.src || '');
  const videoId = new URLSearchParams(location.search).get('v') ||
    videoIdFromHref(bar?.querySelector('a.yt-simple-endpoint[href*="watch"]')?.href) ||
    videoIdFromHref(bar?.querySelector('.title')?.closest('a')?.href) ||
    videoIdFromHref(image?.closest('a')?.href) ||
    videoIdFromHref(document.querySelector('link[rel="canonical"]')?.href) ||
    videoIdFromHref(document.querySelector('ytmusic-player a[href*="watch"]')?.href) ||
    videoIdFromThumb(image?.src) || '';
  const times = parseTimeInfo(textOf(bar?.querySelector('.time-info')));
  const position = times.duration > 0
    ? times.position
    : Number.isFinite(mediaSnapshot?.currentTime) ? mediaSnapshot.currentTime
      : Number.isFinite(video?.currentTime) ? video.currentTime : 0;
  const duration = times.duration > 0
    ? times.duration
    : Number.isFinite(mediaSnapshot?.duration) && mediaSnapshot.duration > 0 ? mediaSnapshot.duration
      : Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : 0;
  const displayArtist = activitySettings.displayMode === 'album' && activitySettings.showAlbum
    ? album || artist
    : artist;

  const url = videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` : location.href;
  const songUrl = videoId ? url : '';
  const stateUrl = displayArtist === album && album ? albumUrl : artistUrl;
  const buttons = [{ label: 'Play on YouTube Music', url }];
  const searchUrl = artistSearchUrl(artist);
  if (searchUrl) buttons.push({ label: 'Search artist', url: searchUrl });
  const playing = Boolean(mediaSnapshot?.playing || isPlaying(video));
  return {
    kind: 'song',
    media: { title, ...(artist ? { artist } : {}), ...(album ? { album } : {}) },
    display: {
      details: title,
      state: displayArtist || '',
      ...(songUrl ? { detailsUrl: songUrl } : {}),
      ...(stateUrl ? { stateUrl } : {}),
    },
    playback: {
      state: playing ? 'playing' : 'paused',
      position,
      duration,
      live: false,
      rate: Number.isFinite(mediaSnapshot?.playbackRate) ? mediaSnapshot.playbackRate : Number.isFinite(video?.playbackRate) ? video.playbackRate : 1,
    },
    artwork: activitySettings.showArtwork ? {
      ...(artwork ? { large: artwork } : {}),
      ...(artwork && (album ? albumUrl : artistUrl) ? { largeUrl: album ? albumUrl : artistUrl } : {}),
      ...(album ? { largeText: album } : {}),
      ...(!playing && artwork ? { small: PAUSE_ARTWORK_URL, smallText: 'Paused' } : {}),
    } : {},
    buttons,
  };
}

function tick() {
  if (ChudPresence.lifecycle.signal.aborted) return;
  const report = collect();
  const now = Date.now();
  const nextState = report?.playback.state || 'none';
  const uncertainState = !isAd() && lastPlaybackState !== 'none' &&
    (!report || (lastPlaybackState === 'playing' && nextState === 'paused'))
    ? nextState : '';
  if (uncertainState) {
    if (pendingState !== uncertainState) {
      pendingState = uncertainState;
      pendingStateSince = now;
      ChudPresence.lifecycle.timeout(tick, TRANSIENT_STATE_MS);
    }
    if (now - pendingStateSince < TRANSIENT_STATE_MS) return;
  } else {
    pendingState = '';
  }
  const serialized = report ? JSON.stringify(report) : '';
  if (serialized === lastSerialized && now - lastSentAt < 8000) return;
  if (report && nextState === lastPlaybackState && now - lastSentAt < 1000) return;
  pendingState = '';
  lastSerialized = serialized;
  lastSentAt = now;
  lastPlaybackState = nextState;
  if (report) ChudPresence.report(report);
  else ChudPresence.clear();
}

const observer = new MutationObserver(tick);
function observePlayerBar() {
  observer.disconnect();
  observer.observe(document.querySelector('ytmusic-player-bar') || document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
}

observePlayerBar();
ChudPresence.lifecycle.interval(tick, 2000);
ChudPresence.navigation.onChange(() => {
  lastSerialized = null;
  observePlayerBar();
  tick();
});
ChudPresence.media.onChange(() => tick());
ChudPresence.dom.observe('ytmusic-player-bar', () => {
  observePlayerBar();
  tick();
}, { immediate: true });
ChudPresence.settings.onChange(({ settings }) => {
  activitySettings = { ...activitySettings, ...settings };
  lastSerialized = null;
  tick();
});
ChudPresence.settings.getAll().then((settings) => {
  activitySettings = { ...activitySettings, ...settings };
  tick();
}).catch(() => {});
tick();
ChudPresence.lifecycle.onCleanup(() => {
  observer.disconnect();
  void ChudPresence.clear().catch(() => {});
});
