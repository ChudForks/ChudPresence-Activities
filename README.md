# ChudPresence Activities

This directory is the publish-ready scaffold for the separate public
`ChudForks/ChudPresence-Activities` GitHub repository. Each Activity is an isolated
website observer package; the ChudPresence extension owns installation,
permissions, presence formatting, and Discord publishing.

## Repository layout

```text
catalog.json
activities/<activity-id>/metadata.json
activities/<activity-id>/activity.js
activities/<activity-id>/icon.png (optional)
schemas/
tools/build-catalog.mjs
.github/workflows/validate.yml
```

The catalog is generated from package metadata and includes SHA-256 hashes for
metadata, script source, and optional icons. The extension fetches only the catalog during
discovery, then downloads and verifies a package after a user chooses Install.

## Contribute

1. Add a directory under `activities/` using a permanent lowercase ID.
2. Add `metadata.json` and one self-contained `activity.js` file. Add `icon.png`
   and set `"icon": "icon.png"` in metadata to show a service logo.
3. Target Activity API v1. Use `ChudPresence.report()` and
   `ChudPresence.clear()`; do not call Discord or load remote code.
4. Keep the entry under 512 KB and declare only the HTTPS sites it observes.
5. Run `node tools/build-catalog.mjs`, then commit the generated catalog.

The workflow checks metadata, source size, JavaScript syntax, and catalog hashes.
The schema and runtime contract are documented in [`ACTIVITY_API.md`](ACTIVITY_API.md).
