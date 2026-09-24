let lastSerialized = null;
let lastSentAt = 0;
let lastProbeAt = 0;
let generation = 0;
let probing = false;

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

function firstHref(selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.href;
    if (value) return value;
  }
  return '';
}

function videoIdFromHref(href) {
  try {
    return new URL(href, location.origin).searchParams.get('v') || '';
  } catch {
    return '';
  }
}

function videoIdFromPath() {
  const queryId = new URLSearchParams(location.search).get('v');
  if (queryId) return queryId;
  return location.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1] || '';
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, location.origin);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString().slice(0, 2048) : '';
  } catch {
    return '';
  }
}

function mainVideo() {
  return document.querySelector('#movie_player video.html5-main-video') ||
    document.querySelector('#shorts-player video.html5-main-video') ||
    document.querySelector('#movie_player video') ||
    document.querySelector('#shorts-player video') ||
    document.querySelector('ytd-miniplayer video.html5-main-video') ||
    document.querySelector('ytd-player video.html5-main-video') ||
    ChudPresence.media.find();
}

function watchTitle(shorts) {
  return firstText(shorts ? [
    'ytd-reel-player-overlay-renderer h2', 'yt-reel-player-header-renderer h2',
    'ytd-reel-video-renderer[is-active] h2', '#shorts-player .ytp-title-link',
  ] : [
    'ytd-watch-metadata h1 yt-formatted-string', '#title h1 yt-formatted-string',
    'h1.ytd-watch-metadata yt-formatted-string', 'h1.ytd-watch-metadata',
    '.ytp-title-link', 'ytd-miniplayer .miniplayer-title',
    'ytd-miniplayer yt-formatted-string', 'ytd-miniplayer .ytp-miniplayer-video-title',
  ]);
}

function channelName() {
  return firstText([
    '#owner #channel-name a', 'ytd-video-owner-renderer #channel-name a',
    'ytd-video-owner-renderer ytd-channel-name a', '#upload-info #channel-name a',
    'ytd-channel-name a', 'ytd-reel-player-overlay-renderer ytd-channel-name a',
    'yt-reel-channel-bar-view-model a', 'ytd-reel-player-header-renderer a',
  ]);
}

function channelUrl() {
  const href = firstHref([
    '#owner #channel-name a', 'ytd-video-owner-renderer #channel-name a',
    'ytd-video-owner-renderer ytd-channel-name a', '#upload-info #channel-name a',
    'ytd-channel-name a', 'yt-reel-channel-bar-view-model a',
    'ytd-reel-player-header-renderer a',
  ]);
  const safe = httpsUrl(href);
  if (!safe) return '';
  const url = new URL(safe);
  if (url.hostname !== 'youtube.com' && url.hostname !== 'www.youtube.com') return '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function bestArtwork(items, fallback) {
  let best = '';
  let bestScore = -1;
  for (const item of Array.isArray(items) ? items : []) {
    const src = httpsUrl(item?.src);
    if (!src) continue;
    const score = parseInt(String(item?.sizes || '').split('x')[0], 10) || 0;
    if (score >= bestScore) {
      best = src;
      bestScore = score;
    }
  }
  return best || fallback;
}

function isAd() {
  const player = document.querySelector('#movie_player, #shorts-player, .html5-video-player');
  return Boolean(player?.classList?.contains('ad-showing') ||
    player?.classList?.contains('ad-interrupting') ||
    document.querySelector(
      '.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-module .ytp-ad-player-overlay, ytd-ad-slot-renderer.ad-showing',
    ));
}

function domLive(video) {
  const flexy = document.querySelector('ytd-watch-flexy');
  const liveFlag = flexy?.getAttribute?.('is-live-video');
  if (flexy?.hasAttribute?.('is-live-video') && liveFlag !== 'false') return true;
  return video?.duration === Infinity;
}

function pageTitle() {
  const title = (document.title || '').replace(/\s+-\s+YouTube$/i, '').trim();
  return ['youtube', 'home', 'shorts'].includes(title.toLowerCase()) ? '' : title;
}

async function playerSnapshot() {
  if (!ChudPresence.runtime.has('pageExecute')) return null;
  return ChudPresence.page.execute(() => {
    const player = document.querySelector('#movie_player, #shorts-player, .html5-video-player');
    if (!player) return null;
    const result = { videoId: '', title: '', author: '', position: 0, duration: 0,
      state: null, live: false, ad: false };
    try {
      result.ad = Boolean(player.classList?.contains('ad-showing') ||
        player.classList?.contains('ad-interrupting') ||
        player.querySelector?.('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout'));
      const data = player.getVideoData?.();
      result.videoId = String(data?.video_id || data?.videoId || '');
      result.title = String(data?.title || '');
      result.author = String(data?.author || data?.ownerName || '');
      const position = player.getCurrentTime?.();
      const duration = player.getDuration?.();
      if (Number.isFinite(position) && position >= 0) result.position = position;
      if (Number.isFinite(duration) && duration > 0) result.duration = duration;
      const state = player.getPlayerState?.();
      if (Number.isInteger(state)) result.state = state;
      const response = player.getPlayerResponse?.() || player.getPresentingPlayerResponse?.();
      const details = response?.videoDetails;
      const sameVideo = !details?.videoId || !result.videoId || details.videoId === result.videoId;
      if (sameVideo) result.live = details?.isLive === true ||
        response?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true;
      if (!result.live) result.live = data?.isLive === true || data?.is_live === true;
    } catch {
      // The player can be replaced while YouTube navigates.
    }
    return result;
  });
}

function collect(page) {
  const video = mainVideo();
  const snapshot = video ? ChudPresence.media.snapshot(video) : null;
  const session = navigator.mediaSession;
  const metadata = session?.metadata;
  const shorts = location.pathname.startsWith('/shorts/');
  if (page?.ad || isAd()) return null;

  const routeId = videoIdFromPath();
  const playerId = page?.videoId || '';
  if (routeId && playerId && routeId !== playerId) return null;
  const videoId = playerId || routeId ||
    document.querySelector('ytd-watch-flexy')?.getAttribute?.('video-id') ||
    videoIdFromHref(document.querySelector('link[rel="canonical"]')?.href) ||
    videoIdFromHref(document.querySelector('a.ytp-title-link')?.href) || '';
  if (!/^[\w-]{11}$/.test(videoId)) return null;

  const title = (page?.title || metadata?.title || watchTitle(shorts) || pageTitle()).trim().slice(0, 256);
  if (!title) return null;
  const creator = (page?.author || metadata?.artist || channelName() || '').trim().slice(0, 256);
  const videoDuration = Number.isFinite(snapshot?.duration) ? snapshot.duration : video?.duration;
  const live = page?.live === true || video?.duration === Infinity || (!page && domLive(video));
  const duration = live ? 0 : page?.duration || (Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 0);
  const videoPosition = Number.isFinite(snapshot?.currentTime) ? snapshot.currentTime : video?.currentTime;
  const position = Number.isFinite(page?.position) && page.position > 0
    ? page.position : Number.isFinite(videoPosition) && videoPosition >= 0 ? videoPosition : 0;
  const playing = Boolean(video && !video.paused && !video.ended) ||
    (!video || !video.ended) && (page?.state === 1 || page?.state === 3 ||
      (!video && session?.playbackState === 'playing'));
  const fallbackImage = httpsUrl(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
  const image = bestArtwork(metadata?.artwork, fallbackImage);
  const watchUrl = shorts
    ? `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`
    : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const channel = channelUrl();
  const rate = Number.isFinite(snapshot?.playbackRate) ? snapshot.playbackRate : video?.playbackRate;

  return {
    kind: live ? 'stream' : 'video',
    media: { title, ...(creator ? { creator, channel: creator } : {}) },
    playback: {
      state: playing ? 'playing' : 'paused',
      position: Math.min(31_536_000, Math.max(0, position)),
      duration: Math.min(31_536_000, Math.max(0, duration)),
      live,
      rate: Number.isFinite(rate) && rate >= 0 && rate <= 16 ? rate : 1,
    },
    display: { details: title, state: creator },
    artwork: image ? { large: image, largeText: title } : {},
    buttons: [
      { label: shorts ? 'Watch Short' : 'Watch on YouTube', url: watchUrl },
      channel && { label: 'View channel', url: channel },
    ].filter(Boolean),
    visibility: 'normal',
  };
}

function send(report) {
  const serialized = report ? JSON.stringify(report) : '';
  const now = Date.now();
  if (serialized === lastSerialized && now - lastSentAt < 8000) return;
  if (report && now - lastSentAt < 1000) return;
  lastSerialized = serialized;
  lastSentAt = now;
  if (report) ChudPresence.report(report);
  else ChudPresence.clear();
}

async function tick() {
  if (ChudPresence.lifecycle.signal.aborted || probing) return;
  const now = Date.now();
  if (now - lastProbeAt < 750) return;
  lastProbeAt = now;
  const currentGeneration = generation;
  probing = true;
  let page = null;
  try { page = await playerSnapshot(); } catch { /* DOM and MediaSession remain available. */ }
  probing = false;
  if (ChudPresence.lifecycle.signal.aborted || currentGeneration !== generation) return;
  send(collect(page));
}

const observer = new MutationObserver(() => { void tick(); });
function bindObserver() {
  observer.disconnect();
  const nodes = [
    document.querySelector('#movie_player'), document.querySelector('#shorts-player'),
    document.querySelector('ytd-watch-flexy'), document.querySelector('ytd-watch-metadata'),
    document.querySelector('ytd-miniplayer'), document.querySelector('ytd-player'),
    document.querySelector('ytd-reel-video-renderer[is-active]'),
  ].filter(Boolean);
  for (const node of nodes.length ? nodes : [document.documentElement]) {
    observer.observe(node, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'title', 'aria-label', 'href', 'src', 'hidden', 'video-id'] });
  }
}

function onNavigation() {
  generation += 1;
  lastProbeAt = 0;
  lastSentAt = 0;
  lastSerialized = null;
  bindObserver();
  void tick();
}

bindObserver();
ChudPresence.lifecycle.interval(() => { void tick(); }, 2000);
ChudPresence.navigation.onChange(onNavigation);
ChudPresence.media.onChange(() => { void tick(); });
ChudPresence.dom.observe('#movie_player video, #shorts-player video, ytd-miniplayer video',
  () => { void tick(); });
document.addEventListener('yt-navigate-finish', onNavigation);
document.addEventListener('yt-page-data-updated', onNavigation);
for (const event of ['play', 'pause', 'loadedmetadata', 'durationchange']) {
  document.addEventListener(event, tick, true);
}
ChudPresence.lifecycle.onCleanup(() => {
  observer.disconnect();
  document.removeEventListener('yt-navigate-finish', onNavigation);
  document.removeEventListener('yt-page-data-updated', onNavigation);
  for (const event of ['play', 'pause', 'loadedmetadata', 'durationchange']) {
    document.removeEventListener(event, tick, true);
  }
  void ChudPresence.clear().catch(() => {});
});
void tick();
