let lastSerialized = null;
let lastSentAt = 0;
let activitySettings = { displayOrder: 'series', showArtwork: true };

function textOf(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
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
    const href = document.querySelector(selector)?.href;
    if (href) return href;
  }
  return '';
}

function metaContent(names) {
  for (const name of names) {
    const element = document.querySelector(
      `meta[property="${name}"], meta[name="${name}"]`,
    );
    const value = element?.content?.trim();
    if (value) return value;
  }
  return '';
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
        if (item['@graph']) items.push(...(Array.isArray(item['@graph']) ? item['@graph'] : [item['@graph']]));
      }
    } catch {
      // Crunchyroll may expose incomplete JSON-LD while navigating.
    }
  }
  return items;
}

function jsonLd() {
  const items = jsonLdItems();
  return items.find((item) => {
    const type = String(item['@type'] || '');
    return type.includes('TVEpisode') || type.includes('Movie') || type.includes('VideoObject') ||
      item.episodeNumber != null || item.partOfSeries || item.partOfSeason;
  }) || items[0] || null;
}

function parsePageTitle(value) {
  const title = String(value || '').trim();
  const episode = title.match(/^(.*?)\s+Episode\s+(\d+)\s*[-–:]\s*(.+)$/i);
  if (episode) {
    return { series: episode[1].trim(), episode: episode[3].trim(), season: 0, number: Number(episode[2]) || 0 };
  }
  const short = title.match(/^(.*?)\s+(?:S(\d+)\s*)?E(\d+)\s*[-–:]\s*(.+)$/i);
  if (short) {
    return {
      series: short[1].trim(), episode: short[4].trim(),
      season: Number(short[2]) || 0, number: Number(short[3]) || 0,
    };
  }
  return { series: title, episode: '', season: 0, number: 0 };
}

function stripEpisodePrefix(value) {
  const title = String(value || '').trim();
  const prefixed = title.match(/^(?:S(\d+)\s*)?E(\d+)(?:\s*[—\-–:]\s*(.+))?$/i);
  if (prefixed) {
    return { name: (prefixed[3] || '').trim(), season: Number(prefixed[1]) || 0, number: Number(prefixed[2]) || 0 };
  }
  const words = title.match(/^Episode\s+(\d+)(?:\s*[—\-–:]\s*(.+))?$/i);
  if (words) return { name: (words[2] || '').trim(), season: 0, number: Number(words[1]) || 0 };
  return { name: title.replace(/\s+-\s+/g, ' — '), season: 0, number: 0 };
}

function episodeLabel(seasonName, seasonNumber, episodeNumber) {
  const name = String(seasonName || '').trim();
  if (name && /\bepisode\s+\d+\b/i.test(name)) return name;
  const season = Number(seasonNumber) || 0;
  const episode = Number(episodeNumber) || 0;
  const episodeText = episode ? `Episode ${episode}` : '';
  if (name && episodeText) return `${name}, ${episodeText}`;
  if (name) return name;
  if (season && episodeText) return `Season ${season}, ${episodeText}`;
  if (episodeText) return episodeText;
  return season ? `Season ${season}` : '';
}

function parseIsoDuration(value) {
  const match = typeof value === 'string' && value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
}

function mediaIdFromPath() {
  return location.pathname.match(/\/watch\/([A-Za-z0-9]+)/)?.[1] || '';
}

function isWatchPage() {
  return /\/watch\//.test(location.pathname || '');
}

function pageTitle() {
  return (document.title || '')
    .replace(/\s+[|\-–]\s+Watch on Crunchyroll\s*$/i, '')
    .replace(/\s+[|\-–]\s+Crunchyroll\s*$/i, '')
    .replace(/^Watch\s+/i, '')
    .trim();
}

function safeCrunchyrollUrl(value) {
  try {
    const url = new URL(value, location.origin);
    if (url.protocol !== 'https:' || !/(^|\.)crunchyroll\.com$/i.test(url.hostname)) return '';
    return url.toString().slice(0, 2048);
  } catch {
    return '';
  }
}

function seriesUrl() {
  const href = firstHref([
    'a.show-title-link',
    '.show-title-link',
    '.erc-current-media-info a[href*="/series/"]',
    'a[href*="/series/"]',
  ]);
  if (!href) return '';
  try {
    const url = new URL(href, location.origin);
    if (!/(^|\.)crunchyroll\.com$/i.test(url.hostname)) return '';
    url.search = '';
    url.hash = '';
    return safeCrunchyrollUrl(url.toString());
  } catch {
    return '';
  }
}

function watchUrl(mediaId) {
  try {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    if (mediaId) url.pathname = `/watch/${encodeURIComponent(mediaId)}`;
    return safeCrunchyrollUrl(url.toString());
  } catch {
    return '';
  }
}

function imageUrl(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = imageUrl(item);
      if (found) return found;
    }
    return '';
  }
  if (value && typeof value === 'object') return imageUrl(value.url || value.contentUrl || value.src || '');
  if (typeof value !== 'string' || !value || value.startsWith('data:')) return '';
  try {
    const url = new URL(value, location.origin);
    return url.protocol === 'https:' ? url.toString().slice(0, 2048) : '';
  } catch {
    return '';
  }
}

function findVideo() {
  return document.querySelector(
    '#player-container video, video[id^="bitmovinplayer-video"], #player0, #player_html5_api, .video-player video, video',
  );
}

function isPlaying(video, mediaSnapshot) {
  if (mediaSnapshot?.playing) return true;
  if (video && !video.paused && !video.ended) return true;
  return navigator.mediaSession?.playbackState === 'playing';
}

function isAd(video, episodeDuration, duration) {
  if (document.querySelector([
    '#vilosAdsContainer', '.vilos-ad', '[class*="ads-overlay"]', '[class*="ad-overlay"]',
    '[class*="preroll"]', '[data-testid="ad" i]', '[data-testid^="ad-" i]',
    '[data-testid$="-ad" i]', '[data-testid*="advert" i]', '[aria-label*="Advertisement" i]',
    '[aria-label*="Skip Ad" i]',
  ].join(', '))) return true;
  const videoDuration = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : 0;
  return Boolean(episodeDuration > 90 && duration > 0 && (videoDuration || duration) < 75);
}

function collect() {
  if (!isWatchPage()) return null;
  const video = findVideo() || ChudPresence.media.find();
  const mediaSnapshot = video ? ChudPresence.media.snapshot(video) : null;
  const ld = jsonLd();
  const parsed = parsePageTitle(pageTitle());
  const ldType = String(ld?.['@type'] || '');
  const movie = /Movie/i.test(ldType) && !ld?.episodeNumber && !ld?.partOfSeason;

  const series = firstText([
    'a.show-title-link h4', '.show-title-link h4', 'a.show-title-link', '.show-title-link',
    '.erc-current-media-info a[href*="/series/"]', 'a[href*="/series/"] h4',
  ]) || ld?.partOfSeries?.name || parsed.series || '';
  const rawEpisode = firstText([
    '.erc-current-media-info h1.title', '.erc-current-media-info h1', 'h1.title',
    '[data-t="current-media-info"] h1',
  ]) || ld?.name || parsed.episode || '';
  const stripped = stripEpisodePrefix(rawEpisode);
  const season = Number(ld?.partOfSeason?.seasonNumber) || stripped.season || parsed.season || 0;
  const episode = Number(ld?.episodeNumber) || stripped.number || parsed.number || 0;
  const episodeTitle = stripped.name || parsed.episode || '';
  const seasonName = !movie && ld?.partOfSeason?.name && ld.partOfSeason.name !== series
    ? ld.partOfSeason.name
    : '';
  const title = movie
    ? series || episodeTitle || ld?.name || parsed.series || pageTitle()
    : episodeTitle || series || pageTitle();
  const mediaId = mediaIdFromPath() ||
    String(ld?.identifier || ld?.['@id'] || '').match(/\/watch\/([A-Za-z0-9]+)/)?.[1] || '';
  const artwork = imageUrl(metaContent(['og:image', 'twitter:image'])) ||
    imageUrl(ld?.image) || imageUrl(ld?.thumbnailUrl) || imageUrl(video?.poster);

  const videoPosition = Number.isFinite(video?.currentTime) ? video.currentTime : NaN;
  const videoDuration = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : NaN;
  const episodeDuration = parseIsoDuration(ld?.duration);
  let duration = Number.isFinite(videoDuration) ? videoDuration : episodeDuration;
  let position = Number.isFinite(videoPosition) ? videoPosition : 0;
  if (isAd(video, episodeDuration, duration)) {
    duration = episodeDuration || duration;
    if (duration > 90 && Number.isFinite(videoDuration) && videoDuration < 75) position = 0;
  }

  if (!title || (!mediaId && !episodeTitle && !series)) return null;
  const url = watchUrl(mediaId);
  const seriesLink = seriesUrl();
  const buttons = [
    url && { label: movie ? 'Watch movie' : 'Watch on Crunchyroll', url },
    !movie && seriesLink && seriesLink !== url && { label: 'View series', url: seriesLink },
  ].filter(Boolean).slice(0, 2);

  const isAdvertisement = isAd(video, episodeDuration, duration);
  return {
    kind: movie ? 'movie' : 'episode',
    display: movie ? undefined : {
      details: activitySettings.displayOrder === 'series' && series ? series : (episodeTitle || series || title),
      state: activitySettings.displayOrder === 'series' && series
        ? (episodeLabel(seasonName, season, episode) || episodeTitle || title)
        : (series || ''),
    },
    media: {
      title: String(title).slice(0, 256),
      ...(series && !movie ? { series: String(series).slice(0, 256) } : {}),
      ...(seasonName && !movie ? { subtitle: String(seasonName).slice(0, 256) } : {}),
    },
    playback: {
      state: isPlaying(video, mediaSnapshot) ? 'playing' : 'paused',
      position: Math.max(0, Number.isFinite(mediaSnapshot?.currentTime) ? mediaSnapshot.currentTime : position) || 0,
      duration: Math.max(0, Number.isFinite(mediaSnapshot?.duration) && mediaSnapshot.duration > 0 ? mediaSnapshot.duration : duration) || 0,
      live: false,
      rate: Number.isFinite(mediaSnapshot?.playbackRate) ? mediaSnapshot.playbackRate : Number.isFinite(video?.playbackRate) ? video.playbackRate : 1,
    },
    artwork: activitySettings.showArtwork ? {
      ...(artwork ? { large: artwork } : {}),
      ...(title ? {
        largeText: String(title).slice(0, 256),
      } : {}),
    } : {},
    buttons,
    visibility: isAdvertisement ? 'ad' : 'normal',
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
function observePlayer() {
  observer.disconnect();
  observer.observe(
    document.querySelector('#player-container, .erc-current-media-info, main, [data-t="watch-page"]') || document.documentElement,
    { subtree: true, childList: true, characterData: true, attributes: true },
  );
}

observePlayer();
ChudPresence.lifecycle.interval(tick, 2000);
ChudPresence.navigation.onChange(() => {
  lastSerialized = null;
  observePlayer();
  tick();
});
ChudPresence.media.onChange(() => tick());
ChudPresence.dom.observe('#player-container video, video', () => tick(), { immediate: true });
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
document.addEventListener('play', tick, true);
function onPause(event) {
  if (event.target?.paused === false) return;
  tick();
}
document.addEventListener('pause', onPause, true);
ChudPresence.lifecycle.onCleanup(() => {
  observer.disconnect();
  document.removeEventListener('play', tick, true);
  document.removeEventListener('pause', onPause, true);
  void ChudPresence.clear().catch(() => {});
});
