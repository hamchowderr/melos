# ISRC lookup fixtures

Raw, unmodified JSON responses from Deezer and MusicBrainz, recorded on 2026-10-30 with `User-Agent: Melos/0.1 ( admin@otakusolutions.io )`.

The found ISRC is `GBDUW0000059` (Daft Punk, "Harder, Better, Faster, Stronger"), read from `https://api.deezer.com/track/3135556`. The missing ISRC is `QZZZZ9999999`.

| File | URL | HTTP status | Recorded |
|---|---|---|---|
| `deezer-track-isrc-found.json` | https://api.deezer.com/track/isrc:GBDUW0000059 | 200 | 2026-10-30 |
| `deezer-track-isrc-missing.json` | https://api.deezer.com/track/isrc:QZZZZ9999999 | 200 (body is a `DataException` error, code 800) | 2026-10-30 |
| `deezer-album.json` | https://api.deezer.com/album/302127 | 200 | 2026-10-30 |
| `musicbrainz-isrc-found.json` | https://musicbrainz.org/ws/2/isrc/GBDUW0000059?fmt=json&inc=artist-credits+releases+work-rels | 200 | 2026-10-30 |
| `musicbrainz-isrc-missing.json` | https://musicbrainz.org/ws/2/isrc/QZZZZ9999999?fmt=json&inc=artist-credits+releases+work-rels | 404 | 2026-10-30 |
| `musicbrainz-work.json` | https://musicbrainz.org/ws/2/work/fb670a7d-4e22-3f65-8d3f-7cf2c29c6601?fmt=json | 200 | 2026-10-30 |

Deezer returns HTTP 200 for an unknown ISRC; the miss is signalled only by the `error` object in the body.
