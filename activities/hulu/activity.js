let lastSerialized = null;
let lastSentAt = 0;
let activitySettings = { showArtwork: true };
const EPISODE_DATA_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];
let episodeData = null;
let episodeDataKey = '';
let episodeDataSeriesUrl = '';
let episodeDataRequestKey = '';
let episodeDataRequestUrl = '';
let episodeDataRequestToken = 0;
let episodeDataAttempts = 0;
let episodeDataNextRetryAt = 0;
let episodeDataStatus = 'idle';

function textOf(element) {
  return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstText(selectors, root = document) {
  for (const selector of selectors) {
    const value = textOf(root.querySelector(selector));
    if (value) return value;
  }
  return '';
}

function metaContent(names) {
  for (const name of names) {
    const element = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    const value = element?.content?.trim();
    if (value) return value;
  }
  return '';
}

function imageUrl(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = imageUrl(item);
      if (found) return found;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    return imageUrl(value.url || value.contentUrl || value.src || '');
  }
  if (typeof value !== 'string' || !value || value.startsWith('data:')) return '';
  try {
    const url = new URL(value, location.origin);
    return url.protocol === 'https:' ? url.toString().slice(0, 2048) : '';
  } catch {
    return '';
  }
}

function jsonLdItems() {
  const items = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || 'null');
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of roots) {
        if (!item || typeof item !== 'object') continue;
        items.push(item);
        if (item['@graph']) {
          items.push(...(Array.isArray(item['@graph']) ? item['@graph'] : [item['@graph']]));
        }
      }
    } catch {
      // Hulu can expose incomplete structured data while its watch page loads.
    }
  }
  return items;
}

function jsonLd() {
  const items = jsonLdItems();
  return items.find((item) => {
    const type = Array.isArray(item['@type']) ? item['@type'].join(' ') : String(item['@type'] || '');
    return /TVEpisode|Movie|VideoObject/i.test(type) || item.episodeNumber != null ||
      item.partOfSeries || item.partOfSeason;
  }) || items[0] || null;
}

function currentPlayerLabel() {
  const root = document.querySelector('#web-player-app') || document;
  for (const element of root.querySelectorAll('[aria-label]')) {
    const label = element.getAttribute('aria-label') || '';
    if (/^you are watching\b/i.test(label)) return label;
  }
  return firstText([
    '[data-testid="current-media-info"]',
    '[class*="current-media-info"]',
    '[class*="currentMediaInfo"]',
  ], root);
}

function cleanEpisodeTitle(value) {
  return String(value || '')
    .replace(/^\((?:sub|dub)\)\s*/i, '')
    .replace(/\s+For more actions,.*$/i, '')
    .replace(/\s*[•·]\s*(?:TV\s?-?(?:Y7|Y|G|PG|14|MA)|PG-?13|NC-17|R|G|PG)\s*$/i, '')
    .replace(/\s+(?:TV\s?-?(?:Y7|Y|G|PG|14|MA)|PG-?13|NC-17|R|G|PG)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanPlayerLabel(value) {
  return String(value || '')
    .replace(/^You are watching\s*[-:]\s*/i, '')
    .replace(/\s+For more actions,.*$/i, '')
    .replace(/\s*[•·]\s*(?:TV\s?-?(?:Y7|Y|G|PG|14|MA)|PG-?13|NC-17|R|G|PG)\s*$/i, '')
    .replace(/\s+(?:TV\s?-?(?:Y7|Y|G|PG|14|MA)|PG-?13|NC-17|R|G|PG)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCurrentMedia(value) {
  const cleaned = cleanPlayerLabel(value);
  const match = cleaned.match(/^(.*?)\s+S(?:eason\s*)?(\d+)\s*E(?:pisode\s*)?(\d+)(?:\s*(?:[-–—:]\s*)?([\s\S]*))?$/i);
  if (!match) return { title: cleaned, series: '', season: 0, episode: 0, isEpisode: false };
  const episodeTitle = String(match[4] || '')
    .replace(/^\((?:sub|dub)\)\s*/i, '')
    .trim();
  return {
    title: episodeTitle,
    series: match[1].trim().replace(/\s*[-–—:]\s*$/, ''),
    season: Number(match[2]) || 0,
    episode: Number(match[3]) || 0,
    isEpisode: true,
  };
}

function playerMetadata(root) {
  const label = currentPlayerLabel();
  const parsed = parseCurrentMedia(label);
  const series = firstText([
    '[data-testid="player-metadata"] .PlayerMetadata__titleText',
    '.PlayerMetadata__titleText',
  ], root) || parsed.series;
  const seasonEpisode = firstText([
    '[data-testid="player-metadata"] .PlayerMetadata__seasonEpisodeText',
    '.PlayerMetadata__seasonEpisodeText',
  ], root);
  const numbers = seasonEpisode.match(/\bS(?:eason\s*)?(\d+)\s*E(?:pisode\s*)?(\d+)\b/i);
  const title = cleanEpisodeTitle(firstText([
    '[data-testid="player-metadata"] .PlayerMetadata__subTitleText',
    '.PlayerMetadata__subTitleText',
  ], root)) || parsed.title;
  return {
    label,
    title,
    series,
    season: Number(numbers?.[1]) || parsed.season,
    episode: Number(numbers?.[2]) || parsed.episode,
    isEpisode: Boolean(numbers || parsed.isEpisode || (series && title)),
  };
}

function timeline(root) {
  const element = root.querySelector('[aria-label="Timeline"][aria-valuenow], .Timeline__slider[aria-valuenow]');
  const position = Number(element?.getAttribute?.('aria-valuenow'));
  const duration = Number(element?.getAttribute?.('aria-valuemax'));
  if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration <= 0) return null;
  return { position: Math.min(position, duration), duration };
}

function comparableText(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pageArtwork(title, series) {
  const wantedTitle = comparableText(title);
  const wantedSeries = comparableText(series);
  let seriesFallback = '';
  for (const element of document.querySelectorAll('img')) {
    const alt = comparableText(element.alt);
    const source = imageUrl(element.currentSrc || element.src);
    if (!source || !alt) continue;
    if (wantedTitle && alt.includes(wantedTitle)) return source;
    if (!seriesFallback && wantedSeries && alt.includes(wantedSeries)) seriesFallback = source;
  }
  return seriesFallback;
}

function huluSeriesPageUrl(series, artwork) {
  const name = String(series || '').trim();
  if (!name) return '';
  const wanted = comparableText(name);
  let seriesId = '';
  for (const element of document.querySelectorAll('a[href*="/series/"]')) {
    const href = huluUrl(element.href || element.getAttribute?.('href'));
    const id = href.match(/\/series\/(?:[^/?#]*-)?([a-f0-9-]{36})(?:[/?#]|$)/i)?.[1] || '';
    if (!id) continue;
    const label = comparableText([
      textOf(element),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.querySelector?.('img')?.alt,
    ].filter(Boolean).join(' '));
    if (label && (label.includes(wanted) || wanted.includes(label))) {
      seriesId = id;
      break;
    }
  }
  if (!seriesId) {
    seriesId = String(artwork || '').match(/\/artwork\/([a-f0-9-]{36})(?:[/?#]|$)/i)?.[1] || '';
  }
  if (!seriesId || seriesId === currentEpisodeId()) return '';
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `https://www.hulu.com/series/${slug}-${seriesId}` : '';
}

function currentEpisodeId() {
  return location.pathname.match(/^\/watch\/([a-f0-9-]{36})(?:\/|$)/i)?.[1] || '';
}

function decodedJsonField(record, name) {
  const escaped = record.match(new RegExp(`"${name}":"((?:\\\\.|[^"\\\\])*)"`))?.[1];
  if (escaped === undefined) return '';
  try {
    return JSON.parse(`"${escaped}"`);
  } catch {
    return '';
  }
}

function episodeDataFromPage(html, episodeId) {
  const marker = `"id":"${episodeId}"`;
  const start = String(html || '').indexOf(marker);
  if (start < 0) return null;
  const record = String(html).slice(start, start + 8192);
  const type = decodedJsonField(record, 'type');
  const rawTitle = decodedJsonField(record, 'name');
  const series = decodedJsonField(record, 'seriesName');
  const path = record.match(/"horizontalHero":\{"path":"((?:\\.|[^"])*)"/)?.[1];
  if (type !== 'episode' || !rawTitle || !series || !path) return null;
  let decodedPath = '';
  try {
    decodedPath = JSON.parse(`"${path}"`);
  } catch {
    return null;
  }
  const url = imageUrl(decodedPath);
  if (!url || !/(^|\.)img\d*\.hulu\.com$/i.test(new URL(url).hostname)) return null;
  const sized = new URL(url);
  sized.searchParams.set('operations', JSON.stringify([
    { resize: '600x600|max' },
    { format: 'webp' },
  ]));
  return {
    id: episodeId,
    title: cleanEpisodeTitle(rawTitle),
    series,
    season: Number(record.match(/"season":(\d+)/)?.[1]) || 0,
    episode: Number(record.match(/"number":(\d+)/)?.[1]) || 0,
    duration: Number(record.match(/"duration":(\d+(?:\.\d+)?)/)?.[1]) || 0,
    artwork: sized.toString(),
  };
}

function pageSeriesText(seriesUrl) {
  // The extension bridge calls fetch from the service worker. A stored fetch
  // reference throws "Illegal invocation" there, and the series page is
  // same-origin with the watch page, so read it here first.
  if (typeof fetch !== 'function') return Promise.reject(new Error('Page fetch is unavailable.'));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = typeof setTimeout === 'function' ? setTimeout(() => controller?.abort(), 3000) : 0;
  return fetch(seriesUrl, {
    credentials: 'omit',
    redirect: 'follow',
    ...(controller ? { signal: controller.signal } : {}),
  }).then((response) => {
    if (!response?.ok || typeof response.text !== 'function') {
      throw new Error('Hulu series page was not readable.');
    }
    return response.text();
  }).finally(() => {
    if (typeof clearTimeout === 'function') clearTimeout(timer);
  });
}

function extensionSeriesText(seriesUrl) {
  return ChudPresence.net.fetch(seriesUrl, { responseType: 'text', timeoutMs: 3000 }).then((response) => {
    if (!response?.ok || typeof response.data !== 'string') {
      throw new Error('Hulu series page request failed.');
    }
    return response.data;
  });
}

function seriesPageText(seriesUrl, episodeId) {
  return pageSeriesText(seriesUrl).then((html) => {
    if (episodeDataFromPage(html, episodeId)) return html;
    return extensionSeriesText(seriesUrl);
  }, () => extensionSeriesText(seriesUrl));
}

function ensureEpisodeData(seriesUrl) {
  const episodeId = currentEpisodeId();
  if (!episodeId || !seriesUrl) return;
  if (episodeDataKey !== episodeId || episodeDataSeriesUrl !== seriesUrl) {
    episodeDataRequestToken += 1;
    episodeDataRequestKey = '';
    episodeDataRequestUrl = '';
    episodeData = null;
    episodeDataKey = episodeId;
    episodeDataSeriesUrl = seriesUrl;
    episodeDataStatus = 'idle';
    episodeDataAttempts = 0;
    episodeDataNextRetryAt = 0;
  }
  if (episodeDataStatus === 'ready' || episodeDataRequestKey === episodeId ||
      Date.now() < episodeDataNextRetryAt) return;
  episodeDataRequestKey = episodeId;
  episodeDataRequestUrl = seriesUrl;
  const requestToken = ++episodeDataRequestToken;
  episodeDataAttempts += 1;
  episodeDataStatus = 'loading';
  seriesPageText(seriesUrl, episodeId).then((html) => {
    if (episodeDataRequestToken !== requestToken || episodeDataRequestKey !== episodeId ||
        episodeDataRequestUrl !== seriesUrl) return;
    episodeDataKey = episodeId;
    episodeData = episodeDataFromPage(html, episodeId);
    episodeDataStatus = episodeData ? 'ready' : 'failed';
    episodeDataNextRetryAt = episodeData ? 0 : Date.now() +
      EPISODE_DATA_RETRY_DELAYS_MS[Math.min(episodeDataAttempts - 1, EPISODE_DATA_RETRY_DELAYS_MS.length - 1)];
    lastSerialized = null;
    tick();
  }).catch(() => {
    if (episodeDataRequestToken !== requestToken || episodeDataRequestKey !== episodeId ||
        episodeDataRequestUrl !== seriesUrl) return;
    episodeDataKey = episodeId;
    episodeData = null;
    episodeDataStatus = 'failed';
    episodeDataNextRetryAt = Date.now() +
      EPISODE_DATA_RETRY_DELAYS_MS[Math.min(episodeDataAttempts - 1, EPISODE_DATA_RETRY_DELAYS_MS.length - 1)];
    lastSerialized = null;
    tick();
  }).finally(() => {
    if (episodeDataRequestToken === requestToken && episodeDataRequestKey === episodeId &&
        episodeDataRequestUrl === seriesUrl) {
      episodeDataRequestKey = '';
      episodeDataRequestUrl = '';
    }
  });
}

function parseIsoDuration(value) {
  const match = typeof value === 'string' && value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
}

function isHuluWatchPage() {
  return /(^|\.)hulu\.com$/i.test(location.hostname) && /^\/watch\//i.test(location.pathname);
}

function huluUrl(value) {
  try {
    const url = new URL(value, location.origin);
    if (url.protocol !== 'https:' || !/(^|\.)hulu\.com$/i.test(url.hostname)) return '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2048);
  } catch {
    return '';
  }
}

function watchUrl() {
  return isHuluWatchPage() ? huluUrl(location.href) : '';
}

function isAdvertisement(root) {
  return Boolean(root.querySelector([
    '[aria-label*="Advertisement" i]',
    '[aria-label*="Skip Ad" i]',
    '[data-testid="ad"]',
    '[data-testid^="ad-"]',
    '[class*="ad-overlay" i]',
    '[class*="ad-container" i]',
    '[class*="ad-break" i]',
  ].join(', ')));
}

function mediaSession() {
  const metadata = navigator.mediaSession?.metadata;
  return {
    title: String(metadata?.title || '').trim(),
    series: String(metadata?.artist || '').trim(),
    artwork: imageUrl(metadata?.artwork),
  };
}

function episodeLabel(season, episode) {
  if (season && episode) return `Season ${season}, Episode ${episode}`;
  if (episode) return `Episode ${episode}`;
  if (season) return `Season ${season}`;
  return '';
}

function collect() {
  if (!isHuluWatchPage()) return null;
  const episodeId = currentEpisodeId();
  const root = document.querySelector('#web-player-app') || document;
  const video = root.querySelector('video') || ChudPresence.media.find();
  const snapshot = video ? ChudPresence.media.snapshot(video) : null;
  const player = playerMetadata(root);
  const label = player.label;
  const structured = jsonLd();
  const structuredType = Array.isArray(structured?.['@type'])
    ? structured['@type'].join(' ')
    : String(structured?.['@type'] || '');
  const structuredSeries = String(structured?.partOfSeries?.name || '').trim();
  const structuredSeason = Number(structured?.partOfSeason?.seasonNumber) || 0;
  const structuredEpisode = Number(structured?.episodeNumber) || 0;
  const session = mediaSession();
  const metaArtwork = metaContent(['og:image', 'twitter:image']);
  const seriesHint = player.series || structuredSeries || session.series ||
    metaContent(['og:title', 'twitter:title']).replace(/\s*[|·-]\s*Hulu\s*$/i, '').trim();
  const seriesArtwork = pageArtwork('', seriesHint) || imageUrl(metaArtwork) ||
    imageUrl(structured?.image) || imageUrl(structured?.thumbnailUrl);
  ensureEpisodeData(huluSeriesPageUrl(seriesHint, seriesArtwork));
  const remote = episodeDataKey === episodeId ? episodeData : null;
  const isEpisode = Boolean(remote) || player.isEpisode || /TVEpisode/i.test(structuredType) ||
    Boolean(structuredSeries || structuredEpisode || structuredSeason);
  const isMovie = !isEpisode && /Movie/i.test(structuredType);
  const series = isEpisode
    ? player.series || remote?.series || structuredSeries || session.series
    : '';
  const season = player.season || remote?.season || structuredSeason;
  const episode = player.episode || remote?.episode || structuredEpisode;
  const title = (isEpisode
    ? player.title || remote?.title || String(structured?.name || '').trim() || session.title
    : String(structured?.name || '').trim() || player.title || session.title || metaContent(['og:title', 'twitter:title']))
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || (!video && !label && !structured && !remote)) return null;

  const kind = isEpisode ? 'episode' : (isMovie || label ? 'movie' : 'video');
  const currentUrl = watchUrl();
  const homeUrl = 'https://www.hulu.com/';
  const seriesName = series.slice(0, 256);
  const episodeName = title.slice(0, 256);
  const episodeInfo = episodeLabel(season, episode);
  const artwork = remote?.artwork || imageUrl(structured?.image) || imageUrl(structured?.thumbnailUrl) ||
    imageUrl(metaArtwork) || imageUrl(video?.poster) || pageArtwork(episodeName, seriesName) || session.artwork;
  const playerTimeline = timeline(root);
  const position = playerTimeline
    ? playerTimeline.position
    : Number.isFinite(snapshot?.currentTime)
      ? snapshot.currentTime
    : Number.isFinite(video?.currentTime) ? video.currentTime : 0;
  const videoDuration = Number.isFinite(snapshot?.duration) && snapshot.duration > 0
    ? snapshot.duration
    : Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : 0;
  const duration = playerTimeline?.duration || videoDuration || remote?.duration || parseIsoDuration(structured?.duration);
  const playing = snapshot?.playing === true || Boolean(video && !video.paused && !video.ended) ||
    navigator.mediaSession?.playbackState === 'playing';
  const rate = Number.isFinite(snapshot?.playbackRate) ? snapshot.playbackRate
    : Number.isFinite(video?.playbackRate) ? video.playbackRate : 1;
  const ad = isAdvertisement(root);

  return {
    kind,
    media: {
      title: episodeName,
      ...(seriesName && isEpisode ? { series: seriesName } : {}),
      ...(season && isEpisode ? { season } : {}),
      ...(episode && isEpisode ? { episode } : {}),
      ...(isMovie && structured?.datePublished ? { subtitle: String(structured.datePublished).slice(0, 4) } : {}),
    },
    ...(isEpisode ? {
      // Discord has only two visible text rows. Keep the episode title prominent,
      // put the series beneath it, and retain season/episode as structured media.
      display: {
        details: episodeName,
        state: seriesName || episodeInfo,
      },
    } : {}),
    playback: {
      state: playing ? 'playing' : 'paused',
      position: Math.max(0, position) || 0,
      duration: Math.max(0, duration) || 0,
      live: false,
      rate: Number.isFinite(rate) && rate >= 0 && rate <= 16 ? rate : 1,
    },
    artwork: activitySettings.showArtwork ? {
      ...(artwork ? { large: artwork } : {}),
      largeText: isEpisode ? [episodeInfo, episodeName].filter(Boolean).join(' • ') : episodeName,
    } : {},
    buttons: [
      currentUrl && { label: 'Watch on Hulu', url: currentUrl },
      homeUrl && { label: 'Open Hulu', url: homeUrl },
    ].filter(Boolean).slice(0, 2),
    visibility: ad ? 'ad' : 'normal',
  };
}

function tick() {
  if (ChudPresence.lifecycle.signal.aborted) return;
  const report = collect();
  if (report === undefined) return;
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
function observePlayer() {
  observer.disconnect();
  observer.observe(document.querySelector('#web-player-app') || document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'class', 'content', 'poster', 'src'],
  });
}

observePlayer();
ChudPresence.lifecycle.interval(tick, 2000);
ChudPresence.navigation.onChange(() => {
  lastSerialized = null;
  lastSentAt = 0;
  episodeData = null;
  episodeDataKey = '';
  episodeDataSeriesUrl = '';
  episodeDataRequestKey = '';
  episodeDataRequestUrl = '';
  episodeDataRequestToken += 1;
  episodeDataAttempts = 0;
  episodeDataNextRetryAt = 0;
  episodeDataStatus = 'idle';
  observePlayer();
  tick();
});
ChudPresence.media.onChange(tick);
ChudPresence.dom.observe('#web-player-app', () => {
  observePlayer();
  tick();
}, { immediate: true });
document.addEventListener('play', tick, true);
document.addEventListener('pause', tick, true);
document.addEventListener('loadedmetadata', tick, true);
document.addEventListener('durationchange', tick, true);
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
  document.removeEventListener('play', tick, true);
  document.removeEventListener('pause', tick, true);
  document.removeEventListener('loadedmetadata', tick, true);
  document.removeEventListener('durationchange', tick, true);
  void ChudPresence.clear().catch(() => {});
});
