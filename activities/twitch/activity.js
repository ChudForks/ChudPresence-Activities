const TWITCH_ORIGIN = 'https://www.twitch.tv';
const RESERVED_ROUTES = new Set([
  'clip', 'clips', 'directory', 'downloads', 'following', 'jobs', 'login',
  'moderator', 'p', 'search', 'settings', 'store', 'subscriptions', 'videos',
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
  return path.startsWith('/videos/') || path.includes('/video/') ||
    new URLSearchParams(location.search).has('video');
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

function cleanPageTitle(value) {
  return String(value || '')
    .replace(/\s*(?:-\s*)?Twitch$/i, '')
    .replace(/^Twitch\s*-\s*/i, '')
    .trim();
}

function isChannelLiveLabel(value) {
  return /\s*-\s*Live on Twitch\s*$/i.test(String(value || ''));
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
      // Twitch may expose incomplete structured data during navigation.
    }
  }
  return '';
}

function vodTitle(channel, session) {
  const title = firstText([
    '[data-a-target="video-title"]', '[data-a-target="video-title-link"]',
    '[data-a-target="video-title"] h1', '[data-a-target="video-title"] h2',
  ]) || videoObjectTitle();
  if (title) return title;
  if (session.title && !isChannelLiveLabel(session.title)) return session.title;
  const heading = firstText(['h2[data-a-target="stream-title"]']);
  if (heading && !isChannelLiveLabel(heading)) return heading;
  const metadataTitle = meta('og:title');
  const source = !isChannelLiveLabel(metadataTitle) ? metadataTitle : document.title;
  if (isChannelLiveLabel(source)) return '';
  const pageTitle = cleanPageTitle(source);
  if (!pageTitle || !channel) return pageTitle;
  const escapedChannel = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return pageTitle.replace(new RegExp(`\\s*-\\s*${escapedChannel}\\s*$`, 'i'), '').trim();
}

function streamTitle(session) {
  return session.title || firstText([
    '[data-a-target="stream-title"]', 'h2[data-a-target="stream-title"]',
  ]) || cleanPageTitle(meta('og:title'));
}

function collect() {
  const channel = channelName();
  const vodRoute = isVodRoute();
  if (!channel && !vodRoute) return null;
  const video = document.querySelector('video[data-a-target="player-video"], .video-player video, video') ||
    ChudPresence.media.find();
  const snapshot = video ? ChudPresence.media.snapshot(video) : null;
  const vod = vodRoute || (Number.isFinite(video?.duration) && video.duration > 0);
  const liveBadge = document.querySelector(
    '[data-a-target="stream-title"], [data-a-target="player-live-badge"], [data-test-selector="live-indicator"]',
  );
  const live = !vod && Boolean(video?.duration === Infinity ||
    (channel && !Number.isFinite(video?.duration) && liveBadge));
  if (!video && !live) return null;

  const session = mediaSession();
  const title = (vod ? vodTitle(channel, session) : streamTitle(session)).slice(0, 256);
  if (!title) return null;
  const creator = (channel || session.artist).slice(0, 256);
  const pageUrl = new URL(location.href);
  pageUrl.hash = '';
  const watchUrl = httpsUrl(pageUrl.toString());
  const channelUrl = channel ? httpsUrl(`${TWITCH_ORIGIN}/${encodeURIComponent(channel)}`) : '';
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
      watchUrl && { label: 'Watch on Twitch', url: watchUrl },
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
