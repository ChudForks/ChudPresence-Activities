# Anikoto

Activity API V1 package for `anikototv.to`. It shows the current anime episode
or movie, poster, play/pause state, seeking, playback speed, and progress.
Display order and artwork are configurable in the Activity settings.
When there is no current video, it shows **Browsing Anikoto** while the page
is visible and its browser window has focus. Switching tabs or focusing
another window clears that browsing presence. Paused episodes keep their
playback presence, including when the tab is in the background.
Browsing shows the site's logo, forces the compact status to **Playing Anikoto**,
and omits the second text line. These report-only overrides leave saved
series/episode preferences in effect for playback. The artwork setting still
controls the browsing logo.

Load `metadata.json`, `activity.js`, and `icon.png` together through
**Activity Library → Developer → Load local Activity**. Approve the declared
Anikoto and MegaPlay website access. Version **1.0.3** requires Activity Lab
**2.0.4** for V1 navigation handoff and the shared V1/V2 display controls. Reload/update the extension,
then reimport the Activity's three files. No network bridge permissions are used.
The catalog must be published before the package appears in remote Discover.

Navigation within Anikoto keeps the last presence for up to four seconds while
the new document starts reporting. This avoids dropping and reapplying the
presence when clicking links or submitting a search. SPA route changes replace
the report directly. Leaving Anikoto or closing the tab clears immediately;
a stalled page clears when the four-second handoff expires.

The package runs throughout Anikoto and in matching MegaPlay frames. Only the
Anikoto top frame publishes reports. The player relays ordinary media snapshots
to its direct parent after a handshake; the parent checks the message origin,
source frame, and current player token. A new episode, changed embed, iframe
reload, missing player, completed video, or expired playback sample removes the
old playback presence and falls back to browsing when the tab is active.
Standalone MegaPlay pages and unrelated embeds do not report.
The package never sends player controls or changes playback.

The selected episode and its URL supply episode metadata. The static page title
and Open Graph title are deliberately ignored: during inspection the Brave tab
was playing Episode 9 while both static titles described Episode 12. Seasons
are not inferred from episode numbers or anime titles. Movie detection uses the
watch page's `Type: Movie` field.

On October 15, 2026, Brave inspection confirmed that SUB's HD-1, HD-2, and
Vidstream-2 use `megaplay.buzz/stream/…`; Vidstream-1 uses
`megaplay.buzz/videojs/stream/…`. Both player routes are supported, as are
ordinary videos directly inside Anikoto's `#player`. Other third-party player
hosts are outside the declared playback scope; an active Anikoto page can still
show its browsing presence.

`icon.png` is the service's own PNG favicon from
`https://anikototv.to/AnikotoTheme/assets/images/favicon.png`. Poster artwork
comes from the current watch page. Paused playback uses the catalog's shared
pause badge.
Browsing also uses that public favicon URL as its Discord large image.

Package tests and the browser smoke helper are optional local files ignored by
Git; they are absent from a fresh checkout. With those files present, run the
package fixtures from the repository root:

```sh
node --test activities/anikoto/tests/activity.test.mjs
npm run activity -- validate anikoto
```

The fixtures cover the observed page selectors and timeline, misleading static
titles, frame/message validation, pause/seek/rate changes, ads and completion,
episode changes, iframe reload/removal, stale samples, movie/direct-video
playback, focused browsing, visibility/focus changes, playback priority,
settings, cleanup, and the V1 request budget. Browser verification is
recorded separately from synthetic fixture coverage.

The optional browser smoke check uses Playwright and the local Chromium lab
extension. It creates a disposable profile and a temporary copy of the
extension with fixture-host permissions, intercepts all website requests, and
plays a generated silent media fixture. It does not use an existing browser
profile, contact Discord, or modify the workspace extension. From this
repository, run:

```sh
node activities/anikoto/tools/browser-smoke.mjs
```

Install Playwright locally or set `CHUDPRESENCE_TEST_NODE_MODULES` to a directory
containing it. `CHUDPRESENCE_LAB_ROOT` can locate an independently checked-out
lab; `CHUDPRESENCE_TEST_BROWSER` can select a Chromium browser that supports
loading unpacked extensions. The default on Windows is Edge.

Recorded fixture checks cover native child-frame playback, pause/seek/rate,
replay and episode changes, focused browsing, shared V1/V2 presentation controls,
and version 1.0.3 navigation handoff against extension 2.0.4. Delayed link/form
responses retain presence until replacement or a fixed four-second deadline;
leaving scope and closing the tab clear promptly. SPA route changes replace
reports without an intermediate clear. These checks use synthetic site responses;
installed live playback and Discord publication still need verification.
