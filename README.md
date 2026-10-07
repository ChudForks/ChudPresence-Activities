# ChudPresence Activities

The official first-party Activity catalog, packages, API contract, and authoring
tools for [ChudPresence Activities](https://github.com/ChudForks/ChudPresence-Activities).
This is a separate Git repository; in the Chromium Activity Lab workspace it is
checked out as `ChudPresence-Activities/` beside the lab's extension code.

Activity API V1 runs trusted code with declared website and network access. The
extension owns installation, permissions, presence formatting, credentials,
and Discord publishing. Packages install from this repository through the
Activity Library or from local files through Developer mode. The same packages
serve the Chromium lab's isolated `USER_SCRIPT` runtime. A future
public/community API may use a different security model.

## Repository layout

```text
catalog.json
activities/<activity-id>/metadata.json
activities/<activity-id>/activity.js
activities/<activity-id>/icon.png (optional)
presence-assets/                       shared Discord artwork
schemas/activity-api-v1.json           canonical API contract
schemas/activity.schema.json          generated metadata schema
schemas/activity-report.schema.json   generated report schema
schemas/activity-contract.generated.js
schemas/activity-api-v1.d.ts           generated SDK types
tools/build-catalog.mjs
tools/generate-api-contract.mjs
tools/chudpresence.mjs
tools/check-version-bumps.mjs
tools/official-activities.test.mjs
tools/chudpresence.test.mjs
package.json
.github/workflows/validate.yml
```

`presence-assets/` holds shared Discord images, such as play and pause badges.
Activities reference those raw URLs. They are not downloaded with an Activity
package.
The catalog is generated from package metadata and includes SHA-256 hashes for
metadata, script source, and optional icons. During discovery the extension
resolves the current Git commit, then fetches the catalog and selected package
files from that immutable revision. Installed repository records keep the
revision and verified hashes.
The Library validates catalog host patterns before requesting declared site and
network access, then downloads the package and checks its hashes and metadata
against the catalog. Chromium requires **Allow User Scripts** on the extension's
details page (or Developer mode on older supported versions). Firefox may
request `userScripts` permission separately from the declared origins.

## Current catalog

The checked-in catalog contains seven API v1 packages. This snapshot was checked
on October 2, 2026; `catalog.json` and each package's `metadata.json` are the
source for later versions and permission declarations.

| Activity | Version | Reports and behavior |
| --- | --- | --- |
| [67Movies](activities/67movies) | 1.0.3 | Movies and episodes, embedded player progress, TMDB metadata and artwork, retained artwork in background tabs |
| [Crunchyroll](activities/crunchyroll) | 1.0.8 | Anime episodes and movies, display order and artwork settings, SPA navigation and media observation |
| [Hulu](activities/hulu) | 1.0.9 | Watch-page movies and episodes, early metadata, episode artwork and timelines, detail-page discovery with retry backoff |
| [Kick](activities/kick) | 1.0.1 | Live channels and recorded videos, playback state, service links and artwork |
| [Twitch](activities/twitch) | 1.0.1 | Live channels and recorded videos, playback state, service links and artwork |
| [YouTube](activities/youtube) | 1.0.2 | Videos, Shorts and live streams, page-player inspection, advertisement clearing and stale-player protection |
| [YouTube Music](activities/youtube-music) | 1.0.9 | Songs, artist or album display, clickable song/byline/cover links, pause artwork and a 1.25-second grace for transient player changes |

67Movies declares `https://api.themoviedb.org/*` network access. Hulu declares
`/series/*` and `/movie/*` on `hulu.com` and `www.hulu.com`; it reads those
same-origin detail pages directly first, then falls back to
`ChudPresence.net.fetch()` when the page request fails or lacks the needed
metadata. Hulu runs only on `/watch/*`. The other packages declare no external
network bridge permissions. All current packages use the default top-frame
scope; 67Movies reads embed routes and validates player messages from its top
page rather than installing an Activity inside the embedded player.

These packages report through the generic API without Activity-ID-specific
formatting in extension core. The Chromium lab includes a copy of YouTube for
first-install defaults; it remains removable in the Library. This repository's
catalog and package updates are independent of refreshing that bundled copy.

Checked-in service icon sources include the PNG from
[YouTube's official brand site](https://brand.youtube/).
The Kick icon is the PNG linked as the Apple touch icon by `https://kick.com/`
(`https://kick.com/apple-icon.png?apple-icon.0ldhg5ovdrppx.png`).
The Twitch icon is the purple Glitch PNG from Twitch's press center
(`https://www.twitch.tv/p/press-center/assets/media/glitch.zip`).
The Hulu icon was taken from Hulu's official App Store listing.

## Contribute

1. Add a directory under `activities/` using a permanent lowercase ID.
2. Add `metadata.json` and one self-contained `activity.js` file. Add `icon.png`
   and set `"icon": "icon.png"` in metadata to show a service logo.
3. Target Activity API v1. Use `ChudPresence.report()` and
   `ChudPresence.clear()`; do not call Discord or load remote code.
4. Keep `activity.js` at most 512 KiB and declare only the HTTPS sites it observes.
   If it uses `ChudPresence.net.fetch()`, declare its HTTPS API patterns in
   metadata `network`; Discord endpoints are reserved for extension core.
5. Increase the Activity's semantic version when any package file changes.
6. Run `node tools/build-catalog.mjs`, then commit the generated catalog.

The workflow checks metadata, source size, JavaScript syntax, catalog hashes,
SDK types, package behavior on synthetic pages, and package version bumps.
The schema and runtime contract are documented in [`ACTIVITY_API.md`](ACTIVITY_API.md).

## Authoring with the SDK

Use Node.js 20 or newer and install the repository's tooling with `npm ci`.
The private SDK package exposes metadata and report types through
`@chudpresence/activity-sdk/types`; it is used from this checkout rather than
installed as a published runtime library.

The CLI can create a TypeScript Activity with `src/index.ts` and a `tests/`
directory. Replace the example HTTPS match and edit the source and tests before
building it:

```sh
npm ci
npm run activity -- new example
# Edit activities/example/metadata.json, src/index.ts, and tests/.
npm run activity -- build example
npm run activity -- validate example
npm run activity -- test example
npm run activity -- dev example
```

The build checks TypeScript, bundles source and npm dependencies into one
package-local `activity.js`, validates the package, and refreshes `catalog.json`.
The current esbuild target is Firefox 115 and the output is a browser IIFE.
Watch mode rebuilds source dependencies. To apply a changed local bundle,
reselect its package files in Developer mode and use **Load local Activity**.
**Reload Activity** reruns the source already stored by the extension; it does
not reread files from disk. The CLI does not install or reload the extension.

The seven checked-in official packages are authored directly as `activity.js`,
without `src/` or per-package `tests/` directories. Validate one with
`npm run activity -- validate youtube`; exercise their synthetic-page tests
with `npm test`. The CLI's `build`, `dev`, and `test` commands require the
corresponding scaffold source or test directory.

## Validation and generated files

Run the existing local checks before submitting changes:

```sh
npm ci
npm test
npm run typecheck
npm run check:contract
npm run check:catalog
node tools/check-version-bumps.mjs
```

CI also runs `node --check` on every `activities/*/activity.js`. The version gate
compares committed package changes with `HEAD^` by default; use
`--base=<git-ref>` to choose a different comparison base. Documentation-only
changes do not require an Activity version bump, but metadata changes do.

`schemas/activity-api-v1.json` is the canonical contract. After changing it,
run `node tools/generate-api-contract.mjs` and commit its generated schemas,
runtime constants, and TypeScript types. When this repository sits beside the
Chromium lab's `extension/`, the generator also refreshes the lab's mirrored
contract and schema files. It can run independently in a standalone checkout.
`tools/build-catalog.mjs` hashes text with LF line endings to match the bytes
served from Git even in a Windows checkout.

As of October 2, 2026, the suite passes 25 top-level tests, and SDK typechecking,
contract generation checks, all seven JavaScript syntax checks, and catalog
validation pass. The default version-bump check currently fails: the latest
commit changes Crunchyroll and Hulu metadata categories from `streaming` to
`video` without raising versions 1.0.8 and 1.0.9. Those package versions must
increase before that comparison passes. These results cover local synthetic
tests and validation, not a new live-browser verification of the services.

The SDK conformance test creates and removes a temporary Activity and rebuilds
the catalog during cleanup. `npm test` can therefore change only the catalog's
`generatedAt` timestamp even when packages are unchanged; review that generated
diff before committing it.
