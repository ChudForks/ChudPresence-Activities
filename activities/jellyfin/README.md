# Jellyfin (V1)

Requires ChudPresence 2.1.3 or newer. Install the Activity, open Jellyfin Web,
and choose **Enable Jellyfin on this site** in its popup service settings.
Alternatively, add the server base URL in Activity Library. A reverse-proxy
prefix is supported, for example `https://media.example.com/jellyfin/`.
HTTP LAN servers such as `http://192.168.1.10:8096/` are also supported.

Installation starts no page scripts. Execution is limited to servers the user
adds, with exact protocol, port, and base-path checks in addition to browser
host permissions. Disabling or removing the Activity stops detection. Saved
server locations stay local and survive Activity updates.

Movies, episodes (including specials), music, live TV, and optional foreground
browsing presence use structured V1 reports. Playback comes from this tab's
media element; session lookup matches its Jellyfin user and device only. The
integration supports Jellyfin Web, not standalone clients or remote players.

The existing Jellyfin Web login is reused in memory. No manual API key is
required. Public server identity is verified before authenticated metadata
requests. Login tokens are sent only as authorization headers to the current
approved server and are never included in reports, buttons, or artwork URLs.

Use the standard ChudPresence controls for paused presence, artwork, progress,
buttons, and status display. Activity Library additionally offers browsing,
privacy, category, and plot-summary settings.

Discord can load artwork only from public HTTPS addresses, so posters on a
local/LAN server cannot be shown directly. Artwork is chosen in this order,
moving to the next step whenever one has no image:

1. **Use posters from public HTTPS servers** (on by default) links the poster
   directly, token-free, when the server uses HTTPS on a public domain or
   public IP address and Jellyfin reports that the item has a poster. LAN,
   loopback, link-local, carrier-NAT, `.local`/`.lan`/`.home.arpa`-style, and
   `*.ts.net` addresses skip this step. Discord loads the image from your
   server, so the server address appears in the artwork URL. The poster must
   be reachable without a login proxy and use a certificate Discord trusts.
2. Public cover lookups, which upload nothing:
   - Music with a MusicBrainz release ID in Jellyfin (from file tags or the
     MusicBrainz metadata provider) uses the album's public
     [Cover Art Archive](https://coverartarchive.org/) front cover. Only that
     release ID is sent to `musicbrainz.org`, to confirm a front cover exists.
   - Movies and shows with a TMDB ID in Jellyfin (Jellyfin's default metadata
     provider) use the public [TMDB](https://www.themoviedb.org/) poster.
     Episodes and seasons use their series' poster. When Jellyfin stored only
     an IMDb ID (movies and shows) or a TVDB ID (shows), TMDB's find lookup
     converts it. Only that ID, the shared ChudPresence TMDB API key, and
     `language=en-US` are sent to `api.themoviedb.org`. This product uses the
     TMDB API but is not endorsed or certified by TMDB.
3. **Upload artwork from your server to Litterbox** (off by default) reads the
   album, series, or movie poster from your Jellyfin server and uploads that
   image to [Litterbox](https://litterbox.catbox.moe/), a temporary public file
   host. The result is a public link that expires after 24 hours and is shown
   only while playing. The image is read without your login token. Media
   titles and account details are not uploaded. Anyone with the link can view
   the image until it expires.
4. Otherwise, the Jellyfin logo is shown.

**Always show the Jellyfin logo** skips every step above. Browsing presence
never uploads. Privacy mode always shows the logo.

The PNG icon and fallback logo are the Jellyfin project's official
[web icon](https://github.com/jellyfin/jellyfin-ux/blob/master/branding/web/icon-transparent.png).
Jellyfin names and branding belong to the Jellyfin project; see its
[branding guidance](https://jellyfin.org/docs/general/contributing/branding/).
Presentation was informed by
[PreMiD's Jellyfin activity](https://github.com/PreMiD/Activities/tree/main/websites/J/Jellyfin);
this package uses the ChudPresence V1 runtime and report contract.
