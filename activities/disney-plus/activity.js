let activitySettings = { showArtwork: true };
let lastSerialized = null;
let lastSentAt = 0;
let generation = 0;
let pendingRead = null;
let scheduled = false;
let stopped = false;
let lastMediaIdentity = '';
let previousRouteIdentity = '';
let currentRoute = watchUrl();

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 256);
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value, location.origin);
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048
      ? url.href : '';
  } catch {
    return '';
  }
}

function watchUrl() {
  const url = httpsUrl(location.href);
  if (!url || !/^(?:www\.)?disneyplus\.com$/i.test(location.hostname) ||
      !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:play|video)\/[^/]+\/?$/i.test(location.pathname)) return '';
  const clean = new URL(url);
  clean.search = '';
  clean.hash = '';
  return clean.href;
}

// This function is self-contained because V1 executes it in the page MAIN world.
// Disney's custom element keeps metadata and its content timeline on mediaPlayer.
function readNativePlayer() {
  const element = document.querySelector('disney-web-player');
  const player = element?.mediaPlayer;
  if (!player) return null;
  const metadata = player.mediaPlaybackCriteria?.metadata;
  const timeline = player.timeline?.info;
  const video = document.querySelector('video[id^="hivePlayer"]');
  const tiles = metadata?.images_experience?.standard?.tile || {};
  const tile = Object.entries(tiles)
    .filter(([ratio, image]) => Number(ratio) > 0 && typeof image?.imageId === 'string')
    .sort(([left], [right]) => Math.abs(Number(left) - 1) - Math.abs(Number(right) - 1))[0]?.[1];
  const imageId = tile?.imageId;
  return {
    href: location.href,
    title: String(metadata?.title?.text || '').slice(0, 256),
    subtitle: String(metadata?.subtitle?.text || '').slice(0, 256),
    artwork: imageId && /^[a-z0-9_-]{1,256}$/i.test(imageId)
      ? `https://disney.images.edge.bamgrid.com/ripcut-delivery/v2/variant/disney/${imageId}/compose?format=png&width=600` : '',
    position: Number.isFinite(timeline?.playheadPositionMs) ? timeline.playheadPositionMs / 1000 : null,
    duration: Number.isFinite(timeline?.programDurationMs) ? timeline.programDurationMs / 1000 : null,
    hasVideo: Boolean(video),
    paused: video ? video.paused : null,
    ended: Boolean(video?.ended),
    rate: Number.isFinite(video?.playbackRate) ? video.playbackRate : null,
  };
}

function firstText(selectors, root) {
  for (const selector of selectors) {
    const value = text(root.querySelector(selector)?.textContent);
    if (value) return value;
  }
  return '';
}

function structuredData() {
  const items = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || 'null');
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!item || typeof item !== 'object') continue;
        items.push(item);
        if (item['@graph']) items.push(...(Array.isArray(item['@graph']) ? item['@graph'] : [item['@graph']]));
      }
    } catch {
      // Structured data can be incomplete during SPA navigation.
    }
  }
  return items.find((item) => /TVEpisode|Movie|VideoObject/i.test(String(item?.['@type'] || ''))) || null;
}

function imageUrl(value) {
  if (Array.isArray(value)) return value.map(imageUrl).find(Boolean) || '';
  if (value && typeof value === 'object') return imageUrl(value.url || value.contentUrl || value.src);
  return httpsUrl(value);
}

function number(value, limit = 31536000) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(limit, Math.max(0, value)) : 0;
}

function episodeParts(value) {
  const match = text(value).match(/^S(?:eason\s*)?(\d+)\s*[:,·-]?\s*E(?:pisode\s*)?(\d+)\s*(?:[-–—:·]\s*)?(.*)$/i);
  return match ? { season: number(Number(match[1]), 10000), episode: number(Number(match[2]), 10000), title: text(match[3]) } : null;
}

function collect(native) {
  const currentUrl = watchUrl();
  if (!currentUrl) return null;
  const modern = document.querySelector('disney-web-player');
  const root = modern || document.querySelector('.btm-media-client-element') || document;
  // Disney can also render dummy videos; prefer its named content player.
  const video = document.querySelector('video[id^="hivePlayer"]') ||
    (!modern ? root.querySelector('video') || ChudPresence.media.find() : null);
  if ((!video && !native?.hasVideo) || video?.ended || native?.ended) return null;
  const snapshot = video ? ChudPresence.media.snapshot(video) : null;
  if (snapshot?.ended) return null;
  const structured = structuredData();
  const session = navigator.mediaSession?.metadata;
  const playerTitle = text(native?.title) || firstText([
    '[data-testid="player-title"]', '.title-field', '.btm-media-overlays .title-field',
  ], root);
  const subtitle = text(native?.subtitle) || firstText([
    '[data-testid="player-subtitle"]', '.subtitle-field', '.btm-media-overlays .subtitle-field',
  ], root);
  const parts = episodeParts(subtitle);
  const isEpisode = Boolean(parts || (!playerTitle &&
    (/TVEpisode/i.test(String(structured?.['@type'] || '')) || structured?.partOfSeries)));
  const series = isEpisode ? playerTitle || text(structured?.partOfSeries?.name) || text(session?.artist) : '';
  const title = isEpisode
    ? parts?.title || text(structured?.name) || text(session?.title)
    : playerTitle || text(structured?.name) || text(session?.title);
  if (!title) return null;
  const season = parts?.season || number(Number(structured?.partOfSeason?.seasonNumber), 10000);
  const episode = parts?.episode || number(Number(structured?.episodeNumber), 10000);
  const episodeInfo = [season && `Season ${season}`, episode && `Episode ${episode}`].filter(Boolean).join(', ');
  const artwork = imageUrl(native?.artwork) || imageUrl(structured?.image || structured?.thumbnailUrl) ||
    imageUrl(video?.poster) || imageUrl(session?.artwork);
  const duration = number(native?.duration ?? snapshot?.duration ?? video?.duration);
  const position = number(native?.position ?? snapshot?.currentTime ?? video?.currentTime);
  const paused = native?.paused ?? snapshot?.paused ?? video?.paused ?? true;
  const rate = native?.rate ?? snapshot?.playbackRate ?? video?.playbackRate;
  const ad = Array.from(root.querySelectorAll([
    '[data-testid="ad-overlay"]', '[data-testid="ad-countdown"]',
    '[aria-label="Advertisement"]', '[aria-label*="Skip Ad" i]', '.ad-overlay', '.ad-container',
  ].join(', '))).some((element) => !element.hidden && element.getAttribute?.('aria-hidden') !== 'true' &&
    (typeof element.getClientRects !== 'function' || element.getClientRects().length > 0));
  return {
    kind: isEpisode ? 'episode' : 'movie',
    media: {
      title,
      ...(series ? { series } : {}),
      ...(isEpisode && season ? { season: Math.floor(season) } : {}),
      ...(isEpisode && episode ? { episode: Math.floor(episode) } : {}),
    },
    ...(isEpisode ? { display: { details: title, state: series || episodeInfo } } : {}),
    playback: {
      state: paused ? 'paused' : 'playing',
      position: duration ? Math.min(position, duration) : position,
      duration,
      live: false,
      rate: typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 16 ? rate : 1,
    },
    artwork: activitySettings.showArtwork ? {
      ...(artwork ? { large: artwork } : {}),
      largeText: (isEpisode ? [episodeInfo, title].filter(Boolean).join(' • ') : title).slice(0, 256),
    } : {},
    buttons: [
      { label: 'Watch on Disney+', url: currentUrl },
      { label: 'Open Disney+', url: 'https://www.disneyplus.com/' },
    ],
    visibility: ad ? 'ad' : 'normal',
  };
}

function publish(report) {
  if (stopped || ChudPresence.lifecycle.signal.aborted) return;
  if (report) {
    const identity = JSON.stringify([report.kind, report.media]);
    // SPA routes can change before the player replaces its previous metadata.
    if (identity === previousRouteIdentity) report = null;
    else { previousRouteIdentity = ''; lastMediaIdentity = identity; }
  }
  const serialized = report ? JSON.stringify(report) : '';
  const now = Date.now();
  if (serialized === lastSerialized && now - lastSentAt < 8000) return;
  if (report && now - lastSentAt < 1000) {
    if (!scheduled) {
      scheduled = true;
      ChudPresence.lifecycle.timeout(() => { scheduled = false; tick(); }, 1000 - (now - lastSentAt));
    }
    return;
  }
  lastSerialized = serialized;
  lastSentAt = now;
  if (report) void ChudPresence.report(report).catch(() => {});
  else void ChudPresence.clear().catch(() => {});
}

function tick() {
  if (stopped || ChudPresence.lifecycle.signal.aborted) return;
  if (!watchUrl()) { publish(null); return; }
  if (!ChudPresence.runtime.has('pageExecute')) { publish(collect(null)); return; }
  if (pendingRead) return;
  const token = {};
  pendingRead = token;
  const epoch = generation;
  const href = location.href;
  ChudPresence.page.execute(readNativePlayer).then((native) => {
    if (epoch === generation && href === location.href && (!native || native.href === href)) publish(collect(native));
  }).catch(() => {
    if (epoch === generation && href === location.href) publish(collect(null));
  }).finally(() => {
    if (pendingRead === token) pendingRead = null;
  });
}

const observer = new MutationObserver(tick);
observer.observe(document.documentElement, {
  subtree: true, childList: true, characterData: true, attributes: true,
  attributeFilter: ['class', 'src', 'poster', 'aria-label', 'aria-hidden', 'hidden'],
});
ChudPresence.lifecycle.interval(tick, 2000);
ChudPresence.navigation.onChange(() => {
  const nextRoute = watchUrl();
  if (nextRoute !== currentRoute) previousRouteIdentity = lastMediaIdentity;
  currentRoute = nextRoute;
  generation += 1;
  pendingRead = null;
  lastSerialized = null;
  lastSentAt = 0;
  publish(null);
  // A new route must supply fresh player metadata before it can report.
  tick();
});
ChudPresence.media.onChange(tick);
ChudPresence.settings.onChange(({ settings }) => {
  activitySettings = { ...activitySettings, ...settings };
  lastSerialized = null;
  tick();
});
ChudPresence.settings.getAll().then((settings) => {
  if (stopped) return;
  activitySettings = { ...activitySettings, ...settings };
  tick();
}).catch(() => {});
ChudPresence.lifecycle.onCleanup(() => {
  stopped = true;
  generation += 1;
  observer.disconnect();
  void ChudPresence.clear().catch(() => {});
});
tick();
