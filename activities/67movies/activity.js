let lastSerialized = null;
let lastSentAt = 0;
let activitySettings = { displayOrder: 'series', showArtwork: true };
let metadata = null;
let metadataKey = '';
let metadataRetryAt = 0;
let lastRoute = null;
let cachedKey = '';
let cachedArtwork = '';
let player = { position: 0, duration: 0, playing: false, ended: false, updatedAt: 0 };

const TMDB_API_KEY = 'a46c50a0ccb1bafe2b15665df7fad7e1';
const PLAYER_ORIGINS = new Set([
  'https://111movies.net',
  'https://player.vidlove.cc',
  'https://player.videasy.net',
  'https://vidsuper.net',
]);

function routeFromPath(pathname, prefix = 'watch', allowIncompleteTv = false) {
  const match = String(pathname || '').match(
    new RegExp(`^/${prefix}/(movie|tv)/(\\d+)(?:/(\\d+)/(\\d+))?/?$`, 'i'),
  );
  if (!match) return null;
  const type = match[1].toLowerCase();
  const season = Number(match[3]) || 0;
  const episode = Number(match[4]) || 0;
  if (type === 'tv' && (!season || !episode) && !allowIncompleteTv) return null;
  return {
    type,
    id: match[2],
    season,
    episode,
    key: `${type}:${match[2]}:${season}:${episode}`,
  };
}

function playerFrames() {
  return [...document.querySelectorAll('iframe')].flatMap((frame) => {
    try {
      const url = new URL(frame.src);
      return PLAYER_ORIGINS.has(url.origin) ? [{ frame, url }] : [];
    } catch {
      return [];
    }
  });
}

function playerRouteInfo(pageRoute) {
  if (pageRoute?.type !== 'tv') return null;
  for (const { frame, url } of playerFrames()) {
    const route = routeFromPath(url.pathname, 'embed');
    if (route?.type === pageRoute.type && route.id === pageRoute.id) {
      route.frame = frame;
      return route;
    }
  }
  return null;
}

function historyRoute(pageRoute) {
  const history = readJson('continueWatching');
  if (!history || typeof history !== 'object' || !pageRoute) return null;
  let best = null;
  for (const [key, item] of Object.entries(history)) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type === 'tv' || item.type === 'movie'
      ? item.type
      : key.startsWith('tv-') ? 'tv' : key.startsWith('movie-') ? 'movie' : '';
    if (type !== pageRoute.type) continue;
    if (String(item.id || '') !== pageRoute.id && !key.startsWith(`${type}-${pageRoute.id}`)) continue;
    const season = Number(item.season) || 0;
    const episode = Number(item.episode) || 0;
    if (type === 'tv' && (!season || !episode)) continue;
    const updatedAt = Number(item.updatedAt) || 0;
    if (!best || updatedAt >= best.updatedAt) {
      best = {
        type,
        id: pageRoute.id,
        season,
        episode,
        key: `${type}:${pageRoute.id}:${season}:${episode}`,
        updatedAt,
      };
    }
  }
  return best;
}

function liveRouteInfo() {
  // /watch/movie/{id} is a movie. /watch/tv/{id} is a show; the selected
  // season and episode live in the embed URL or continue-watching history.
  const pageRoute = routeFromPath(location.pathname, 'watch', true);
  if (!pageRoute) return null;
  const embeddedRoute = playerRouteInfo(pageRoute);
  if (embeddedRoute) return embeddedRoute;
  if (pageRoute.type === 'tv' && (!pageRoute.season || !pageRoute.episode)) return historyRoute(pageRoute);
  return pageRoute;
}

function routeInfo() {
  const pageRoute = routeFromPath(location.pathname, 'watch', true);
  // A /movie URL must never keep a previous /tv route, and the reverse.
  if (lastRoute && pageRoute && (lastRoute.type !== pageRoute.type || lastRoute.id !== pageRoute.id)) {
    lastRoute = null;
    if (metadataKey && !metadataKey.startsWith(`${pageRoute.type}:${pageRoute.id}:`)) {
      metadata = null;
      metadataKey = '';
      cachedKey = '';
      cachedArtwork = '';
    }
  }
  const live = liveRouteInfo();
  if (live) {
    lastRoute = live;
    return live;
  }
  // Background tabs often unload the embed. Keep the last route only for this
  // same movie or show, so a pause update does not drop the poster.
  if (document.hidden && lastRoute && pageRoute && lastRoute.type === pageRoute.type && lastRoute.id === pageRoute.id) {
    return lastRoute;
  }
  return null;
}

function rememberArtwork(route, artworkUrl) {
  if (!route?.key || !artworkUrl || (cachedKey === route.key && cachedArtwork === artworkUrl)) return;
  cachedKey = route.key;
  cachedArtwork = artworkUrl;
  void ChudPresence.storage.set('media', {
    key: route.key,
    artwork: artworkUrl,
    title: metadata?.title || '',
    series: metadata?.series || '',
    year: metadata?.year || '',
    seasonLabel: metadata?.seasonLabel || '',
    duration: metadata?.duration || 0,
  }).catch(() => {});
}

function titledPageArtwork(title) {
  const expected = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!expected) return '';
  try {
    for (const img of document.querySelectorAll('img')) {
      if ((img.alt || '').replace(/\s+/g, ' ').trim().toLowerCase() !== expected) continue;
      const found = tmdbImageUrl(img.currentSrc || img.src || '');
      if (found && found.length <= 313) return found;
    }
  } catch {
    return '';
  }
  return '';
}

function artworkFor(route) {
  // Only the poster for this movie or episode. The site logo and leftover
  // recommendation images are what Discord replaces with the question mark.
  const found = image(metadata?.artwork) || titledPageArtwork(metadata?.title || storedTitle(route));
  if (found && found.length <= 313) {
    rememberArtwork(route, found);
    return found;
  }
  return cachedKey === route.key && cachedArtwork.length <= 313 ? cachedArtwork : '';
}

function tmdbImageUrl(value) {
  const text = String(value || '');
  const wrapped = text.match(/image\.tmdb\.org%2Ft%2Fp%2F(?:w\d+|original)%2F([^&?#]+)/i);
  if (wrapped) {
    try {
      return image(`/${decodeURIComponent(wrapped[1])}`);
    } catch {
      return '';
    }
  }
  const direct = text.match(/https:\/\/image\.tmdb\.org\/t\/p\/(?:w\d+|original)\/[^?\s#]+/i);
  return direct ? image(direct[0]) : '';
}

function progressKey(route) {
  return route.type === 'tv'
    ? `progress:t${route.id}:s${route.season}:e${route.episode}`
    : `progress:m${route.id}`;
}

function continueWatchingKey(route) {
  return route.type === 'tv'
    ? `tv-${route.id}-${route.season}-${route.episode}`
    : `movie-${route.id}`;
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function storedProgress(route) {
  const direct = readJson(progressKey(route));
  let watched = Number(direct?.position);
  let duration = Number(direct?.duration);

  if (!(duration > 0)) {
    const history = readJson('continueWatching');
    const saved = history?.[continueWatchingKey(route)]?.progress;
    watched = Number(saved?.watched);
    duration = Number(saved?.duration);
  }

  return {
    position: Number.isFinite(watched) && watched >= 0 ? watched : 0,
    duration: Number.isFinite(duration) && duration > 1 ? duration : 0,
  };
}

function storedTitle(route) {
  const history = readJson('continueWatching');
  const title = history?.[continueWatchingKey(route)]?.title;
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
}

function image(path, size = 'w500') {
  if (typeof path !== 'string' || !path || path.startsWith('data:')) return '';
  try {
    const url = path.startsWith('https://')
      ? new URL(path)
      : new URL(`https://image.tmdb.org/t/p/${size}${path.startsWith('/') ? path : `/${path}`}`);
    return url.protocol === 'https:' ? url.toString().slice(0, 2048) : '';
  } catch {
    return '';
  }
}

function boundedTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, 31_536_000);
}

function pageTmdb(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), 4000);
  return fetch(url, controller ? { signal: controller.signal } : undefined).then(async (response) => {
    if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
    return response.json();
  }).finally(() => clearTimeout(timer));
}

async function tmdb(path) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3/${path}${separator}api_key=${TMDB_API_KEY}&language=en-US`;
  // The extension fetch is failing immediately in the lab (network_error, 0 bytes).
  // The old provider used a page fetch, which returns in about a tenth of a second.
  try {
    const data = await pageTmdb(url);
    if (data && typeof data === 'object') return data;
  } catch {
    // Fall through to the extension fetch when the page blocks the request.
  }
  const response = await ChudPresence.net.fetch(url);
  if (!response?.ok || !response.data || typeof response.data !== 'object') {
    throw new Error(`TMDB HTTP ${response?.status || 0}`);
  }
  return response.data;
}

async function loadMetadata(route) {
  const requestedKey = route.key;
  const refreshing = metadataKey === requestedKey && metadata;
  metadataKey = requestedKey;
  metadataRetryAt = 0;
  // Keep the poster already shown for this title. Clearing it here publishes a
  // title-only report, and a background tab may not get another chance to send
  // the image until the page is focused again.
  if (!refreshing) {
    metadata = cachedKey === requestedKey && cachedArtwork ? {
      title: '',
      series: '',
      year: '',
      seasonLabel: '',
      artwork: cachedArtwork,
      duration: 0,
    } : null;
  }
  try {
    if (route.type === 'movie') {
      const movie = await tmdb(`movie/${route.id}`);
      if (metadataKey !== requestedKey) return;
      metadata = {
        title: movie.title || movie.original_title || storedTitle(route),
        series: '',
        year: movie.release_date?.slice(0, 4) || '',
        seasonLabel: '',
        artwork: image(movie.poster_path || movie.backdrop_path),
        duration: Number(movie.runtime) > 0 ? Number(movie.runtime) * 60 : 0,
      };
    } else {
      const [show, season] = await Promise.all([
        tmdb(`tv/${route.id}`),
        tmdb(`tv/${route.id}/season/${route.season}`),
      ]);
      if (metadataKey !== requestedKey) return;
      const episode = (season.episodes || []).find(
        (item) => Number(item.episode_number) === route.episode,
      );
      const seriesTitle = show.name || show.original_name || storedTitle(route);
      metadata = {
        title: episode?.name || seriesTitle,
        series: seriesTitle,
        year: '',
        seasonLabel: `Season ${route.season}, Episode ${route.episode}`,
        artwork: image(episode?.still_path || show.poster_path || show.backdrop_path),
        duration:
          Number(episode?.runtime) > 0
            ? Number(episode.runtime) * 60
            : Number(show.episode_run_time?.[0]) > 0
              ? Number(show.episode_run_time[0]) * 60
              : 0,
      };
    }
    metadataRetryAt = 0;
  } catch {
    if (metadataKey !== requestedKey) return;
    metadataRetryAt = Date.now() + 3_000;
    const keptArtwork = metadata?.artwork || (cachedKey === requestedKey ? cachedArtwork : '') || titledPageArtwork(storedTitle(route));
    metadata = {
      title: metadata?.title || storedTitle(route),
      series: route.type === 'tv' ? metadata?.series || storedTitle(route) : '',
      year: metadata?.year || '',
      seasonLabel: route.type === 'tv' ? metadata?.seasonLabel || `Season ${route.season}, Episode ${route.episode}` : '',
      artwork: keptArtwork,
      duration: metadata?.duration || 0,
    };
  }
  tick();
}

function ensureMetadata(route) {
  if (route.key !== metadataKey) {
    player = { position: 0, duration: 0, playing: false, ended: false, updatedAt: 0 };
    loadMetadata(route);
    return;
  }
  if (metadataRetryAt && Date.now() >= metadataRetryAt) loadMetadata(route);
}

function normalizedPlayerEvent(event) {
  if (!PLAYER_ORIGINS.has(event.origin) || !event.data) return null;
  const data = event.data;

  if (event.origin === 'https://111movies.net' && typeof data === 'object') {
    return {
      event: String(data.event || '').toLowerCase(),
      position: Number(data.data?.currentTime),
      duration: Number(data.data?.duration),
    };
  }

  if (event.origin === 'https://player.vidlove.cc' && typeof data === 'object') {
    if (data.type === 'MEDIA_DATA' && data.data?.progress) {
      return {
        event: 'timeupdate',
        position: Number(data.data.progress.watched),
        duration: Number(data.data.progress.duration),
      };
    }
    if (data.type === 'WATCH_PROGRESS' && data.data) {
      return {
        event: String(data.data.eventType || 'timeupdate').toLowerCase(),
        position: Number(data.data.currentTime),
        duration: Number(data.data.duration),
      };
    }
    if (data.type === 'PLAYER_EVENT' && data.data) {
      return {
        event: String(data.data.event || '').toLowerCase(),
        position: Number(data.data.currentTime),
        duration: Number(data.data.duration),
      };
    }
  }

  if (event.origin === 'https://player.videasy.net' && typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return {
        event: String(parsed.event || parsed.type || 'timeupdate').toLowerCase(),
        position: Number(parsed.timestamp),
        duration: Number(parsed.duration),
      };
    } catch {
      return null;
    }
  }

  if (event.origin === 'https://vidsuper.net') {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      return {
        event: String(parsed.type || '').toLowerCase(),
        position: Number(parsed.progress),
        duration: Number(parsed.duration),
      };
    } catch {
      return null;
    }
  }

  return null;
}

function onPlayerMessage(event) {
  const route = routeInfo();
  if (!route) return;
  const playerFrame = playerFrames().find(({ url }) => url.origin === event.origin)?.frame;
  if (!playerFrame || event.source !== playerFrame.contentWindow) return;
  const update = normalizedPlayerEvent(event);
  if (!update) return;

  const previousPosition = player.position;
  if (Number.isFinite(update.position) && update.position >= 0) player.position = update.position;
  if (Number.isFinite(update.duration) && update.duration > 1) player.duration = update.duration;

  if (['pause', 'paused', 'ended', 'complete', 'completed'].includes(update.event)) {
    player.playing = false;
    player.ended = update.event !== 'pause' && update.event !== 'paused';
  } else if (['play', 'playing', 'resume', 'timeupdate', 'progress'].includes(update.event)) {
    player.playing =
      update.event !== 'timeupdate' ||
      !Number.isFinite(update.position) ||
      update.position > previousPosition + 0.01 ||
      player.playing;
    player.ended = false;
  }
  player.updatedAt = Date.now();
  tick();
}

function isServiceHost(hostname) {
  return hostname === '67movies.st' || hostname === 'www.67movies.st';
}

function serviceUrl(pathname) {
  try {
    const url = new URL(location.href);
    if (url.protocol !== 'https:' || !isServiceHost(url.hostname)) return '';
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2048);
  } catch {
    return '';
  }
}

function homeUrl() {
  try {
    const url = new URL(location.href);
    if (url.protocol === 'https:' && isServiceHost(url.hostname)) return `${url.origin}/`;
  } catch {
    // Fall back to the canonical service origin.
  }
  return 'https://67movies.st/';
}

function episodeLabel(route, seasonLabel) {
  return seasonLabel || (route.season && route.episode
    ? `Season ${route.season}, Episode ${route.episode}`
    : '');
}

function collect() {
  const route = routeInfo();
  if (!route) return null;
  ensureMetadata(route);

  const stored = storedProgress(route);
  const title = metadata?.title || storedTitle(route);
  if (!title) return null;

  const series = route.type === 'tv' ? metadata?.series || storedTitle(route) || title : '';
  const seasonLabel = route.type === 'tv' ? episodeLabel(route, metadata?.seasonLabel) : '';
  const episodeTitle = route.type === 'tv' ? title : '';
  const seriesFirst = activitySettings.displayOrder !== 'episode';
  const watch = serviceUrl(route.type === 'tv'
    ? `/watch/tv/${route.id}/${route.season}/${route.episode}`
    : `/watch/movie/${route.id}`);
  const home = homeUrl();
  const buttons = [
    watch && { label: route.type === 'movie' ? 'Watch movie' : 'Watch on 67Movies', url: watch },
    home && home !== watch && { label: 'Open 67Movies', url: home },
  ].filter(Boolean).slice(0, 2);
  const artworkUrl = artworkFor(route);
  const show = route.type === 'tv';
  const episodeName = show ? title : '';
  const seriesName = show ? series || episodeName : '';
  // Match the old Chromium provider: shows are series / episode title,
  // movies are title / 67Movies. Season and episode stay on the artwork tooltip.
  const display = show ? {
    details: String(seriesFirst && seriesName ? seriesName : episodeName || seriesName).slice(0, 256),
    state: String(seriesFirst ? episodeName || seasonLabel : seriesName || seasonLabel).slice(0, 256),
  } : {
    details: String(title).slice(0, 256),
    state: '',
  };
  const largeText = show
    ? [seasonLabel, episodeName].filter((part, index, parts) => part && parts.indexOf(part) === index).join(' • ')
    : title;
  const eventFresh = player.updatedAt && Date.now() - player.updatedAt < 8_000;
  const position = boundedTime(player.position || stored.position);
  const duration = boundedTime(player.duration || stored.duration || metadata?.duration || 0);

  return {
    kind: route.type === 'movie' ? 'movie' : 'episode',
    media: {
      title: String(title).slice(0, 256),
      ...(series && route.type === 'tv' ? { series: String(series).slice(0, 256) } : {}),
      ...(route.type === 'tv' && route.season ? { season: route.season } : {}),
      ...(route.type === 'tv' && route.episode ? { episode: route.episode } : {}),
      ...(route.type === 'movie' && metadata?.year ? { subtitle: String(metadata.year).slice(0, 256) } : {}),
      ...(seasonLabel ? { subtitle: String(seasonLabel).slice(0, 256) } : {}),
    },
    display,
    playback: {
      state: player.playing && eventFresh && !player.ended ? 'playing' : 'paused',
      position,
      duration,
      live: false,
      rate: 1,
    },
    artwork: artworkUrl ? {
      large: artworkUrl,
      ...(largeText ? { largeText: String(largeText).slice(0, 256) } : {}),
    } : {},
    buttons,
  };
}

function tick() {
  if (ChudPresence.lifecycle.signal.aborted) return;
  const report = collect();
  const serialized = report ? JSON.stringify(report) : '';
  const now = Date.now();
  if (serialized === lastSerialized && now - lastSentAt < 8000) return;
  const artworkUrl = report?.artwork?.large || '';
  const artworkArrived = Boolean(artworkUrl) && !String(lastSerialized || '').includes(artworkUrl);
  // A background tab can miss the follow-up tick. Don't let the 1s gate drop
  // the first report that actually includes the poster.
  if (report && !artworkArrived && now - lastSentAt < 1000) return;
  lastSerialized = serialized;
  lastSentAt = now;
  if (report) ChudPresence.report(report);
  else ChudPresence.clear();
}

const observer = new MutationObserver(tick);
function observePage() {
  observer.disconnect();
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'hidden'],
  });
}

observePage();
ChudPresence.lifecycle.interval(tick, 2000);
ChudPresence.navigation.onChange(() => {
  lastSerialized = null;
  observePage();
  tick();
});
ChudPresence.dom.observe('iframe', () => tick(), { immediate: true, attributes: true });
ChudPresence.settings.onChange(({ settings }) => {
  activitySettings = { ...activitySettings, ...settings };
  lastSerialized = null;
  tick();
});
ChudPresence.settings.getAll().then((settings) => {
  activitySettings = { ...activitySettings, ...settings };
  tick();
}).catch(() => {});
window.addEventListener('message', onPlayerMessage);
ChudPresence.storage.get('media').then((saved) => {
  if (saved && typeof saved === 'object' && typeof saved.key === 'string' && typeof saved.artwork === 'string' && saved.artwork) {
    cachedKey = saved.key;
    cachedArtwork = saved.artwork;
    if (!metadata && saved.title) {
      metadataKey = saved.key;
      metadata = {
        title: saved.title,
        series: saved.series || '',
        year: saved.year || '',
        seasonLabel: saved.seasonLabel || '',
        artwork: saved.artwork,
        duration: Number(saved.duration) || 0,
      };
    }
    lastSerialized = null;
    tick();
  }
}).catch(() => {});
tick();
ChudPresence.lifecycle.onCleanup(() => {
  observer.disconnect();
  window.removeEventListener('message', onPlayerMessage);
  void ChudPresence.clear().catch(() => {});
});
