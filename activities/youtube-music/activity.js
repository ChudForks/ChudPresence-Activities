let lastSerialized = null;
let lastSentAt = 0;
let lastPlaybackState = 'none';
let pendingState = '';
let pendingStateSince = 0;
let lastTrackIdentity = '';
let timingIdentity = '';
let previousBarTiming = null;
let previousMediaTiming = null;
let staleBarTiming = null;
let staleMediaTiming = null;
let previousPlayerTiming = null;
let previousSeekTiming = null;
let songClock = null;
let confirmedReport = null;
let confirmedAt = 0;
let probing = false;
let probeAgain = false;
let probeTimerPending = false;
let reportTimerPending = false;
let lastProbeAt = -Infinity;
let generation = 0;
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
  return { position: /^\d+(?::\d+)*$/.test(left?.trim() || '') ? parseClock(left) : null,
    duration: parseClock(right) };
}

function seekTiming() {
  const slider = document.querySelector('#progress-bar');
  const positionText = slider?.getAttribute('aria-valuenow');
  const durationText = slider?.getAttribute('aria-valuemax');
  if (!positionText?.trim() || !durationText?.trim()) return null;
  const position = Number(positionText);
  const duration = Number(durationText);
  return Number.isFinite(position) && position >= 0 && Number.isFinite(duration) &&
    duration > 0 && position <= duration ? { position, duration } : null;
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

function playerSnapshot() {
  return ChudPresence.page.execute(() => {
    const player = document.querySelector('#movie_player') ||
      document.querySelector('ytmusic-player')?.playerApi;
    if (!player) return null;
    const data = player.getVideoData?.();
    const response = player.getPlayerResponse?.() || player.getPresentingPlayerResponse?.();
    const details = response?.videoDetails;
    const videoId = String(data?.video_id || data?.videoId || details?.videoId || '');
    if (!videoId) return null;
    const playerDuration = player.getDuration?.();
    const metadataDuration = !details?.videoId || details.videoId === videoId
      ? Number(details?.lengthSeconds) : 0;
    const position = player.getCurrentTime?.();
    // Missing or mismatched metadata is not evidence that playback restarted.
    return {
      videoId,
      title: String(data?.title || details?.title || ''),
      responseVideoId: String(details?.videoId || ''),
      metadataDuration: Number.isFinite(metadataDuration) && metadataDuration > 0 ? metadataDuration : 0,
      duration: Number.isFinite(playerDuration) && playerDuration > 0 ? playerDuration : 0,
      position: Number.isFinite(position) && position >= 0 ? position : null,
    };
  });
}

function currentTiming(timing, stale) {
  return Number.isFinite(timing.position) && timing.duration > 0 && (!stale || timing.duration !== stale.duration ||
    timing.position < stale.position - 1 || (timing.position <= 1 && stale.position <= 1));
}

function songTiming(identity, seek, media) {
  const mediaPosition = media.position;
  if (!songClock || songClock.identity !== identity) {
    if (!seek) return songClock ? null : undefined;
    if (timingIdentity && identity !== timingIdentity) {
      const previous = keepConfirmedReport()?.playback;
      const individualClock = Number.isFinite(mediaPosition) && Math.abs(mediaPosition - seek.position) < 2 &&
        Math.abs(media.duration - seek.duration) < 2 && (seek.duration !== previous?.duration ||
          mediaPosition < songClock?.mediaPosition - 2);
      const nextOffset = songClock && songClock.offset !== null ? songClock.offset + songClock.duration : null;
      const nextClock = Number.isFinite(mediaPosition) && nextOffset !== null &&
        Math.abs(mediaPosition - seek.position - nextOffset) < 2;
      const carriedPosition = seek.position > 1 && previous && (
        Math.abs(seek.position - previous.position) <= 2 ||
        (previousSeekTiming && Math.abs(seek.position - previousSeekTiming.position) <= 2));
      // Updating aria-valuemax does not make the still-old aria-valuenow current.
      // Wait for a reset/different elapsed clock or an independently aligned media timeline.
      if ((!currentTiming(seek, previousSeekTiming) || carriedPosition) && !individualClock && !nextClock) return null;
    }
    songClock = { identity, duration: seek.duration,
      offset: Number.isFinite(mediaPosition) ? mediaPosition - seek.position : null,
      mediaPosition, position: seek.position, mediaAt: Date.now() };
    previousSeekTiming = seek;
    return seek;
  }

  const freshSeek = seek?.duration === songClock.duration ? seek : null;
  if (!Number.isFinite(mediaPosition)) return freshSeek || null;
  if (songClock.offset === null) {
    if (!freshSeek) return null;
    songClock.offset = mediaPosition - freshSeek.position;
  }
  let position = mediaPosition - songClock.offset;
  const elapsed = Math.max(0, Date.now() - songClock.mediaAt) / 1000 * (media.playing ? media.rate : 0);
  const jumped = mediaPosition - songClock.mediaPosition > elapsed + 2;
  if (freshSeek && Math.abs(position - freshSeek.position) >= 2) {
    const reset = Number.isFinite(songClock.mediaPosition) && mediaPosition < songClock.mediaPosition - 2;
    const restarted = freshSeek.position <= 1 && previousSeekTiming?.position > 1;
    const advancing = freshSeek.position > previousSeekTiming?.position;
    // A queued song can reset the slider before the current audio ends. A real
    // repeat either resets the media clock or crosses this song's end boundary.
    const newTimeline = position < -1 && (freshSeek.position !== previousSeekTiming?.position ||
      previousSeekTiming?.position <= 1);
    if (advancing || (reset && (freshSeek.position < previousSeekTiming?.position - 1 || newTimeline)) ||
        (restarted && position >= songClock.duration)) {
      songClock.offset = mediaPosition - freshSeek.position;
      position = freshSeek.position;
    } else if (jumped) {
      // A media timeline switch is not elapsed listening time. Keep advancing
      // a frozen slider from the last confirmed song position across that switch.
      position = Math.min(songClock.duration, songClock.position + elapsed);
      songClock.offset = mediaPosition - position;
    }
  } else if (!freshSeek && jumped) {
    position = Math.min(songClock.duration, songClock.position + elapsed);
    songClock.offset = mediaPosition - position;
  }
  if (position < -1) return null;
  songClock.mediaPosition = mediaPosition;
  songClock.position = Math.max(0, Math.min(songClock.duration, position));
  songClock.mediaAt = Date.now();
  if (freshSeek && Math.abs(position - freshSeek.position) < 2) previousSeekTiming = freshSeek;
  return { position: Math.max(0, Math.min(songClock.duration, position)), duration: songClock.duration };
}

function playbackTiming(identity, barTiming, mediaTiming, page) {
  // YTM's gapless video can expose a cumulative playlist timeline whose duration
  // grows as the next songs buffer. The seek slider is relative to this song.
  // Calibrate once, then advance from the audio clock even if background DOM freezes.
  const song = songTiming(identity, seekTiming(), mediaTiming);
  if (song !== undefined) {
    if (song) timingIdentity = identity;
    return song;
  }
  const changing = Boolean(timingIdentity && identity !== timingIdentity);
  const oldBar = changing ? previousBarTiming : staleBarTiming;
  const oldMedia = changing ? previousMediaTiming : staleMediaTiming;
  const barCurrent = currentTiming(barTiming, oldBar);
  const mediaCurrent = currentTiming(mediaTiming, oldMedia);
  let timing = null;
  let playerTiming = null;
  if (page?.videoId) {
    if (page.videoId !== identity) return null;
    playerTiming = { position: page.position, duration: page.duration };
    const previous = previousPlayerTiming || previousMediaTiming || previousBarTiming;
    if (changing && previous?.duration > 0 && (
      (page.responseVideoId && page.responseVideoId !== identity) ||
      (page.metadataDuration > 0 && Math.abs(page.duration - page.metadataDuration) >= 2) ||
      !currentTiming(playerTiming, previous)
    )) return null;
    if (currentTiming(playerTiming, null)) {
      timing = playerTiming;
      // Page-player data can preload while the current audio clock still advances.
      if (!changing && mediaCurrent && Math.abs(playerTiming.position - mediaTiming.position) >= 2) {
        timing = mediaTiming;
        playerTiming = null;
      }
    }
  }
  // Background rendering can freeze the bar while audio and media events continue.
  if (!timing) timing = document.hidden && mediaCurrent ? mediaTiming
    : barCurrent ? barTiming : mediaCurrent ? mediaTiming : null;
  if (!timing && confirmedReport?.playback.duration > 0) return null;
  timingIdentity = identity;
  staleBarTiming = barCurrent ? null : oldBar;
  staleMediaTiming = mediaCurrent ? null : oldMedia;
  if (barCurrent) previousBarTiming = barTiming;
  if (mediaCurrent) previousMediaTiming = mediaTiming;
  if (playerTiming && currentTiming(playerTiming, null)) previousPlayerTiming = playerTiming;
  return timing || { position: 0, duration: 0 };
}

function keepConfirmedReport() {
  if (!confirmedReport) return null;
  const playback = confirmedReport.playback;
  const elapsed = playback.state === 'playing' ? Math.max(0, Date.now() - confirmedAt) / 1000 * playback.rate : 0;
  return { ...confirmedReport, playback: { ...playback,
    position: playback.duration > 0 ? Math.min(playback.duration, playback.position + elapsed) : playback.position } };
}

function collect(page) {
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
  let title = textOf(bar?.querySelector('.title')) || metadata.title || '';
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
  // The home/search route can stay unchanged while songs play, and its canonical
  // link can retain a previous song. Only current player links identify playback.
  const videoId = videoIdFromHref(bar?.querySelector('.title')?.closest?.('a')?.href) ||
    videoIdFromHref(bar?.querySelector('a.yt-simple-endpoint[href*="watch"]')?.href) ||
    videoIdFromHref(document.querySelector('ytmusic-player a[href*="watch"]')?.href) ||
    videoIdFromHref(image?.closest?.('a')?.href) || videoIdFromThumb(image?.currentSrc || image?.src) ||
    new URLSearchParams(location.search).get('v') || page?.videoId || '';
  const identity = videoId || `${title}\n${artist}`;
  if (page?.videoId && page.videoId !== videoId) return keepConfirmedReport();
  if (confirmedReport && identity !== timingIdentity && title === confirmedReport.media.title) {
    if (page?.title && metadata.title === page.title) title = metadata.title;
    else if (!page?.title || page.title !== title) return keepConfirmedReport();
  }
  const times = parseTimeInfo(textOf(bar?.querySelector('.time-info')));
  const mediaTiming = {
    position: Number.isFinite(mediaSnapshot?.currentTime) ? mediaSnapshot.currentTime
      : Number.isFinite(video?.currentTime) ? video.currentTime : null,
    duration: Number.isFinite(mediaSnapshot?.duration) && mediaSnapshot.duration > 0 ? mediaSnapshot.duration
      : Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : 0,
    playing: Boolean(mediaSnapshot?.playing || isPlaying(video)),
    rate: Number.isFinite(mediaSnapshot?.playbackRate) ? mediaSnapshot.playbackRate
      : Number.isFinite(video?.playbackRate) ? video.playbackRate : 1,
  };
  if (confirmedReport && identity === timingIdentity && (video?.ended || video?.readyState === 0) &&
      ((Number.isFinite(page?.position) && page.position < confirmedReport.playback.position - 2) ||
       (songClock?.identity === identity && songClock.offset !== null && Number.isFinite(mediaTiming.position) &&
        mediaTiming.position - songClock.offset < confirmedReport.playback.position - 2))) {
    return keepConfirmedReport();
  }
  const timing = playbackTiming(identity, times, mediaTiming, page);
  if (!timing) return keepConfirmedReport();
  const { position, duration } = timing;
  const displayArtist = activitySettings.displayMode === 'album' && activitySettings.showAlbum
    ? album || artist
    : artist;

  const url = videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` : location.href;
  const songUrl = videoId ? url : '';
  const stateUrl = displayArtist === album && album ? albumUrl : artistUrl;
  const buttons = [{ label: 'Play on YouTube Music', url }];
  const searchUrl = artistSearchUrl(artist);
  if (searchUrl) buttons.push({ label: 'Search artist', url: searchUrl });
  const playing = mediaTiming.playing;
  const report = {
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
      rate: mediaTiming.rate,
    },
    artwork: activitySettings.showArtwork ? {
      ...(artwork ? { large: artwork } : {}),
      ...(artwork && (album ? albumUrl : artistUrl) ? { largeUrl: album ? albumUrl : artistUrl } : {}),
      ...(album ? { largeText: album } : {}),
      ...(!playing && artwork ? { small: PAUSE_ARTWORK_URL, smallText: 'Paused' } : {}),
    } : {},
    buttons,
  };
  confirmedReport = report;
  confirmedAt = Date.now();
  return report;
}

function send(report) {
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
  const identity = report?.display.detailsUrl || report?.media.title || '';
  if (serialized === lastSerialized && now - lastSentAt < 8000) return;
  if (report && identity === lastTrackIdentity && nextState === lastPlaybackState && now - lastSentAt < 1000) {
    if (!reportTimerPending) {
      reportTimerPending = true;
      ChudPresence.lifecycle.timeout(() => { reportTimerPending = false; tick(); }, 1000 - (now - lastSentAt));
    }
    return;
  }
  pendingState = '';
  lastSerialized = serialized;
  lastSentAt = now;
  lastPlaybackState = nextState;
  lastTrackIdentity = identity;
  if (report) ChudPresence.report(report);
  else ChudPresence.clear();
}

function tick() {
  if (ChudPresence.lifecycle.signal.aborted) return;
  if (!ChudPresence.runtime.has('pageExecute')) {
    send(collect(null));
    return;
  }
  if (probing) {
    probeAgain = true;
    return;
  }
  const delay = 750 - (Date.now() - lastProbeAt);
  if (delay > 0) {
    if (!probeTimerPending) {
      probeTimerPending = true;
      ChudPresence.lifecycle.timeout(() => { probeTimerPending = false; tick(); }, delay);
    }
    return;
  }
  probing = true;
  lastProbeAt = Date.now();
  const currentGeneration = generation;
  playerSnapshot().catch(() => null).then((page) => {
    if (!ChudPresence.lifecycle.signal.aborted && currentGeneration === generation) send(collect(page));
  }).finally(() => {
    probing = false;
    if (probeAgain) {
      probeAgain = false;
      tick();
    }
  });
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
  generation += 1;
  lastProbeAt = -Infinity;
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
