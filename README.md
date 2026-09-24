# ChudPresence Activities

This directory is the publish-ready scaffold for the official first-party
`ChudForks/ChudPresence-Activities` repository. Activity API V1 is trusted code
with broad, declared website capabilities for detailed integrations. The
extension owns installation, permissions, presence formatting, credentials,
and Discord publishing. V1 packages are installed from this repository or
through the extension's local Developer mode. A future public/community API may
use a different security model.

## Repository layout

```text
catalog.json
activities/<activity-id>/metadata.json
activities/<activity-id>/activity.js
activities/<activity-id>/icon.png (optional)
schemas/
tools/build-catalog.mjs
tools/generate-api-contract.mjs
tools/chudpresence.mjs
schemas/activity-api-v1.json
schemas/activity-api-v1.d.ts (generated)
package.json
.github/workflows/validate.yml
```

The catalog is generated from package metadata and includes SHA-256 hashes for
metadata, script source, and optional icons. During discovery the extension
resolves the current Git commit, then fetches the catalog and selected package
files from that immutable revision. Installed repository records keep the
revision and verified hashes.
The Library validates catalog host patterns before requesting Firefox site and
network permissions, then downloads the package and checks its hashes and
metadata against the catalog. Firefox may require a first click for `userScripts`
permission and a second click for the declared origins.

`activities/crunchyroll` is the reference video Activity. It exercises generic
reports, presentation settings, SPA navigation, media helpers, DOM observation,
and lifecycle cleanup. `activities/youtube-music` is the reference music
Activity for song, artist, album, artwork, timestamps, settings, and media
state. `activities/67movies` reports the movie or episode playing on 67Movies,
including embedded player progress and The Movie Database artwork.
`activities/kick` reports live streams and recorded videos with Kick's official
site icon. None of these providers needs extension-core special handling.
The Kick icon is the PNG linked as the Apple touch icon by `https://kick.com/`
(`https://kick.com/apple-icon.png?apple-icon.0ldhg5ovdrppx.png`).

## Contribute

1. Add a directory under `activities/` using a permanent lowercase ID.
2. Add `metadata.json` and one self-contained `activity.js` file. Add `icon.png`
   and set `"icon": "icon.png"` in metadata to show a service logo.
3. Target Activity API v1. Use `ChudPresence.report()` and
   `ChudPresence.clear()`; do not call Discord or load remote code.
4. Keep the entry under 512 KB and declare only the HTTPS sites it observes.
   If it uses `ChudPresence.net.fetch()`, declare its HTTPS API patterns in
   metadata `network`; Discord endpoints are reserved for extension core.
5. Increase the Activity's semantic version when any package file changes.
6. Run `node tools/build-catalog.mjs`, then commit the generated catalog.

The workflow checks metadata, source size, JavaScript syntax, catalog hashes,
SDK types, package behavior on synthetic pages, and package version bumps.
The schema and runtime contract are documented in [`ACTIVITY_API.md`](ACTIVITY_API.md).

## Authoring with the SDK

The first-party CLI scaffolds and builds TypeScript Activities:

```sh
npm ci
npm run activity -- new example
npm run activity -- build example
npm run activity -- validate example
npm run activity -- test example
npm run activity -- dev example
```

Import report and metadata types from
`@chudpresence/activity-sdk/types`. The build checks TypeScript, bundles source
and npm dependencies into the package-local `activity.js`, validates the
package, and refreshes `catalog.json`. Watch mode rebuilds on source changes;
use Developer mode's **Reload Activity** action to load each new bundle.
