const KICK_ORIGIN = 'https://kick.com';
const RESERVED_ROUTES = new Set([
  'auth', 'browse', 'categories', 'category', 'clips', 'dashboard', 'following',
  'login', 'register', 'search', 'settings', 'subscriptions', 'video', 'videos',
]);

let lastSerialized = null;
let lastSentAt = 0;

function textOf(element) {
  return (element?.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstText(selectors) {
  for (const selector of selectors) {
    const value = textOf(document.querySelector(selector));
    if (value) return value;
  }
  return '';
}

function meta(name) {
  return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || '';
}

function httpsUrl(value, base = location.href) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString().slice(0, 2048) : '';
  } catch {
    return '';
  }
}

function channelName() {
  const first = location.pathname.match(/^\/([^/?#]+)/)?.[1] || '';
  return first && !RESERVED_ROUTES.has(first.toLowerCase()) ? first : '';
}

function isVodRoute() {
  const path = location.pathname.toLowerCase();
  return path.startsWith('/video/') || path.includes('/videos/') ||
    path.includes('/clips/') || new URLSearchParams(location.search).has('clip');
}

function videoObjectTitle() {
  const find = (value) => {
    if (!value || typeof value !== 'object') return '';
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.includes('VideoObject') && typeof value.name === 'string') return value.name.trim();
    for (const child of Object.values(value)) {
      if (!child || typeof child !== 'object') continue;
      const title = Array.isArray(child) ? child.map(find).find(Boolean) : find(child);
      if (title) return title;
    }
    return '';
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const title = find(JSON.parse(script.textContent || 'null'));
      if (title) return title;
    } catch {
      // Pages may temporarily contain incomplete structured data.
    }
  }
  return '';
}

function mediaSession() {
  const metadata = navigator.mediaSession?.metadata;
  const image = Array.isArray(metadata?.artwork)
    ? [...metadata.artwork].reverse().map((item) => httpsUrl(item?.src)).find(Boolean) || ''
    : '';
  return {
    title: String(metadata?.title || '').trim(),
    artist: String(metadata?.artist || '').trim(),
    image,
  };
}

function streamTitle(vod, session) {
  const title = firstText(vod ? [
    '[data-testid="video-title"]', '[data-testid="vod-title"]',
    '[data-testid="clip-title"]', 'h1',
  ] : [
    '[data-testid="livestream-title"]', '[data-testid="stream-title"]',
    '.channel-header h1',
  ]);
  if (title) return title;
  if (vod) {
    const structured = videoObjectTitle();
    if (structured) return structured;
  }
  return (session.title || meta('og:title') || document.title || '')
    .replace(/\s*(?:[-|]\s*)?Kick(?:\.com)?$/i, '')
    .replace(/^Kick(?:\.com)?\s*[-|]\s*/i, '')
    .trim();
}

function collect() {
  const channel = channelName();
  const vod = isVodRoute();
  if (!channel && !vod) return null;

  const video = document.querySelector('video[data-testid="video-player"], .vjs-tech, .video-js video, video') ||
    ChudPresence.media.find();
  const snapshot = video ? ChudPresence.media.snapshot(video) : null;
  const liveBadge = document.querySelector(
    '[data-testid="live-badge"], [data-testid="livestream-badge"], [data-testid="stream-is-live"], .live-badge',
  );
  const live = !vod && Boolean(video?.duration === Infinity ||
    (!Number.isFinite(video?.duration) && liveBadge));
  if (!video && !live) return null;

  const session = mediaSession();
  const title = streamTitle(vod, session).slice(0, 256);
  if (!title) return null;
  const creator = (channel || session.artist).slice(0, 256);
  const pageUrl = new URL(location.href);
  pageUrl.hash = '';
  const watchUrl = httpsUrl(pageUrl.toString());
  const channelUrl = channel ? httpsUrl(`${KICK_ORIGIN}/${encodeURIComponent(channel)}`) : '';
  const image = session.image || httpsUrl(meta('og:image'));
  const position = Number.isFinite(snapshot?.currentTime) ? snapshot.currentTime : video?.currentTime;
  const duration = Number.isFinite(snapshot?.duration) ? snapshot.duration : video?.duration;
  const playing = snapshot?.playing === true || Boolean(video && !video.paused && !video.ended);
  const rate = Number.isFinite(snapshot?.playbackRate) ? snapshot.playbackRate : video?.playbackRate;

  return {
    kind: live ? 'stream' : 'video',
    media: {
      title,
      ...(creator ? { creator, channel: creator } : {}),
    },
    playback: {
      state: playing ? 'playing' : 'paused',
      position: Number.isFinite(position) && position >= 0 ? position : 0,
      duration: !live && Number.isFinite(duration) && duration > 0 ? duration : 0,
      live,
      rate: Number.isFinite(rate) && rate >= 0 && rate <= 16 ? rate : 1,
    },
    display: { details: title, state: creator },
    artwork: image ? { large: image, largeText: title } : {},
    buttons: [
      watchUrl && { label: 'Watch on Kick', url: watchUrl },
      channelUrl && channelUrl !== watchUrl && { label: 'Visit channel', url: channelUrl },
    ].filter(Boolean),
    visibility: 'normal',
  };
}

function tick() {
  if (ChudPresence.lifecycle.signal.aborted) return;
  const report = collect();
  const serialized = report ? JSON.stringify(report) : '';
  const now = Date.now();
  if (serialized === lastSerialized && now - lastSentAt < 8000) return;
  if (report && now - lastSentAt < 1000) return;
  lastSerialized = serialized;
  lastSentAt = now;
  if (report) ChudPresence.report(report);
  else ChudPresence.clear();
}

const observer = new MutationObserver(tick);
observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class', 'content', 'src'],
});
ChudPresence.lifecycle.interval(tick, 2000);
ChudPresence.navigation.onChange(() => {
  lastSerialized = null;
  lastSentAt = 0;
  tick();
});
ChudPresence.media.onChange(tick);
ChudPresence.dom.observe('video', tick);
document.addEventListener('play', tick, true);
document.addEventListener('pause', tick, true);
document.addEventListener('loadedmetadata', tick, true);
document.addEventListener('durationchange', tick, true);
ChudPresence.lifecycle.onCleanup(() => {
  observer.disconnect();
  document.removeEventListener('play', tick, true);
  document.removeEventListener('pause', tick, true);
  document.removeEventListener('loadedmetadata', tick, true);
  document.removeEventListener('durationchange', tick, true);
  void ChudPresence.clear().catch(() => {});
});
tick();
