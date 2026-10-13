let lastSerialized = null;
let lastSentAt = -Infinity;
let reportTimerPending = false;
let clock = null;
let activitySettings = { showArtwork: true };
const MAX_SECONDS = 31_536_000;
const PAUSE_ARTWORK_URL = 'https://raw.githubusercontent.com/ChudForks/ChudPresence-Activities/main/presence-assets/pause.png';

function textOf(node) {
  return String(node?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 256);
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, location.origin);
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048
      ? url.href : '';
  } catch {
    return '';
  }
}

function serviceLink(value, track = false) {
  const safe = httpsUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  if (!['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname)) return '';
  // Never publish private sharing tokens or private-track routes.
  if (url.searchParams.has('secret_token') || /\/s-[\w-]+(?:\/|$)/.test(url.pathname)) return '';
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== (track ? 2 : 1)) return '';
  if (track && ['sets', 'tracks', 'albums', 'likes', 'reposts', 'followers', 'following'].includes(parts[1])) return '';
  url.hostname = 'soundcloud.com';
  url.search = '';
  url.hash = '';
  return url.href;
}

function clockText(node) {
  // SoundCloud also includes a screen-reader sentence in the same container.
  const value = textOf(node?.querySelector('[aria-hidden="true"]') || node);
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(value)) return null;
  const seconds = value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return seconds <= MAX_SECONDS ? seconds : null;
}

function timeline(bar) {
  const progress = bar.querySelector('.playbackTimeline__progressWrapper');
  const positionText = progress?.getAttribute('aria-valuenow');
  const durationText = progress?.getAttribute('aria-valuemax');
  const position = positionText?.trim() ? Number(positionText)
    : clockText(bar.querySelector('.playbackTimeline__timePassed'));
  const duration = durationText?.trim() ? Number(durationText)
    : clockText(bar.querySelector('.playbackTimeline__duration'));
  return {
    position: Number.isFinite(position) && position >= 0 && position <= MAX_SECONDS ? position : null,
    duration: Number.isFinite(duration) && duration > 0 && duration <= MAX_SECONDS ? duration : 0,
  };
}

function playbackTiming(identity, timing, playing) {
  const now = Date.now();
  if (!clock || clock.identity !== identity || clock.position !== timing.position ||
      clock.duration !== timing.duration || clock.playing !== playing) {
    clock = { identity, ...timing, playing, at: now };
  }
  let position = timing.position ?? 0;
  // Background tabs can stop rendering the progress bar while audio continues.
  // Anchor to the last observed value; visible progress and seeks stay authoritative.
  if (document.hidden && playing && timing.position !== null && timing.duration > 0) {
    position += Math.max(0, now - clock.at) / 1000;
  }
  return { position: timing.duration > 0 ? Math.min(timing.duration, position) : position,
    duration: timing.duration };
}

function artworkUrl(bar, title) {
  const artwork = bar.querySelector('.playbackSoundBadge__avatar .image__full');
  const background = artwork?.style?.backgroundImage || artwork?.getAttribute('style') || '';
  const backgroundUrl = background.match(/url\(\s*["']?(.*?)["']?\s*\)/i)?.[1] || '';
  const image = bar.querySelector('.playbackSoundBadge__avatar img');
  let url = httpsUrl(backgroundUrl || image?.currentSrc || image?.src || '');
  if (!url) {
    // The badge can lag behind Media Session during a queue transition.
    const metadata = navigator.mediaSession?.metadata;
    if (String(metadata?.title || '').trim() === title) {
      let size = -1;
      for (const item of metadata.artwork || []) {
        const safe = httpsUrl(item.src);
        const width = parseInt(item.sizes, 10) || 0;
        if (safe && width >= size) { url = safe; size = width; }
      }
    }
  }
  // The web player uses tiny thumbnails; SoundCloud's CDN provides t500x500.
  if (url) {
    const parsed = new URL(url);
    if (/^i\d+\.sndcdn\.com$/.test(parsed.hostname)) {
      parsed.pathname = parsed.pathname.replace(/-t\d+x\d+(\.[a-z0-9]+)$/i, '-t500x500$1');
      url = parsed.href;
    }
  }
  return url;
}

function collect() {
  const bar = document.querySelector('.playControls');
  if (!bar || !bar.classList.contains('m-visible') || bar.getAttribute('aria-hidden') === 'true' ||
      bar.matches('.m-ad, .is-ad, .ad-playing') ||
      bar.querySelector('.playbackSoundBadge.m-ad, .playbackSoundBadge.is-ad')) {
    clock = null;
    return null;
  }
  const titleLink = bar.querySelector('.playbackSoundBadge__titleLink');
  const trackUrl = serviceLink(titleLink?.href, true);
  const title = (titleLink?.getAttribute('title')?.trim() ||
    textOf(titleLink?.querySelector('[aria-hidden="true"]') || titleLink)).slice(0, 256);
  const control = bar.querySelector('.playControls__play');
  if (!trackUrl || !title || !control) { clock = null; return null; }
  const artistLink = bar.querySelector('.playbackSoundBadge__lightLink');
  const artist = (artistLink?.getAttribute('title')?.trim() || textOf(artistLink)).slice(0, 256);
  const artistUrl = serviceLink(artistLink?.href);
  // Use the player's language-independent class, rather than Media Session's
  // potentially stale playbackState or localized button labels.
  const playing = control.classList.contains('playing');
  const timing = timeline(bar);
  if (!playing && timing.duration > 0 && timing.position >= timing.duration) {
    clock = null;
    return null;
  }
  const playback = playbackTiming(trackUrl, timing, playing);
  const image = activitySettings.showArtwork ? artworkUrl(bar, title) : '';
  return {
    kind: 'song',
    media: { title, ...(artist ? { artist } : {}) },
    display: { details: title, detailsUrl: trackUrl, state: artist,
      ...(artistUrl ? { stateUrl: artistUrl } : {}) },
    playback: { state: playing ? 'playing' : 'paused', ...playback, live: false, rate: 1 },
    // Empty text suppresses Discord's album line instead of repeating the song.
    artwork: image ? { large: image, largeUrl: trackUrl, largeText: '',
      ...(!playing ? { small: PAUSE_ARTWORK_URL, smallText: 'Paused' } : {}) } : {},
    buttons: [{ label: 'Listen on SoundCloud', url: trackUrl },
      ...(artistUrl ? [{ label: 'View artist', url: artistUrl }] : [])],
    visibility: 'normal',
  };
}

function tick() {
  if (ChudPresence.lifecycle.signal.aborted) return;
  const report = collect();
  const serialized = report ? JSON.stringify(report) : '';
  const now = Date.now();
  if (serialized === lastSerialized && now - lastSentAt < 8000) return;
  // Coalesce bursts of progress/DOM events to stay within V1's request budget.
  // Identity, pause, artwork, and clear changes should be sent immediately.
  const previous = lastSerialized ? JSON.parse(lastSerialized) : null;
  const sameTrack = previous && report && previous.display.detailsUrl === report.display.detailsUrl;
  const samePresentation = sameTrack && previous.playback.state === report.playback.state &&
    JSON.stringify({ ...previous, playback: null }) === JSON.stringify({ ...report, playback: null });
  if (samePresentation && now - lastSentAt < 1000) {
    if (!reportTimerPending) {
      reportTimerPending = true;
      ChudPresence.lifecycle.timeout(() => { reportTimerPending = false; tick(); }, 1000 - (now - lastSentAt));
    }
    return;
  }
  lastSerialized = serialized;
  lastSentAt = now;
  if (report) void ChudPresence.report(report).catch(() => {});
  else void ChudPresence.clear().catch(() => {});
}

const observer = new MutationObserver(tick);
function observePlayer() {
  observer.disconnect();
  observer.observe(document.querySelector('.playControls') || document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'href', 'title', 'style', 'src', 'aria-hidden', 'aria-valuenow', 'aria-valuemax'],
  });
}
observePlayer();
ChudPresence.lifecycle.interval(tick, 2000);
ChudPresence.navigation.onChange(() => { observePlayer(); tick(); });
ChudPresence.media.onChange(tick);
ChudPresence.dom.observe('.playControls', () => { observePlayer(); tick(); }, { immediate: true });
document.addEventListener('visibilitychange', tick);
ChudPresence.settings.onChange(({ settings }) => {
  activitySettings = { ...activitySettings, ...settings };
  tick();
});
ChudPresence.settings.getAll().then((settings) => {
  activitySettings = { ...activitySettings, ...settings };
  tick();
}).catch(() => {});
ChudPresence.lifecycle.onCleanup(() => {
  observer.disconnect();
  document.removeEventListener('visibilitychange', tick);
  void ChudPresence.clear().catch(() => {});
});
tick();
