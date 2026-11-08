# Charles Hamilton Player — standalone test build

The endless Charles Hamilton player (THE LISTENERS board, tripcode-style
listener profiles, fractional scoring) as a self-hosted app: one Bun
process serves the React client and the `/actions` API from the same
origin, backed by its own SQLite database. Not linked to
charleshamilton.app.

The catalog (1,218 tracks across 100 projects) streams from the public
R2 bucket; the track list lives in `client/src/catalog.ts`.

## Run it locally (one command chain)

```bash
bun install
bun run build
bun start            # http://localhost:3000  (PORT env to change)
```

The database starts empty at `data/app.db` (created on first run from
the Drizzle migrations in `drizzle/`; set `DB_PATH` to move it). The
board is empty until the first listener claims a name.

## Deploy (any host that runs a Bun/Node process with a disk)

A `Dockerfile` is included (oven/bun base image):

- **Fly.io**: `fly launch --dockerfile Dockerfile` then
  `fly volumes create player_data --size 1` and mount it at `/app/data`
  in `fly.toml` so the SQLite board survives deploys.
- **Render**: New > Web Service > Docker, attach a persistent disk
  mounted at `/app/data`.
- **Railway**: deploy from this repo with the Dockerfile, add a volume
  mounted at `/app/data`.

The only runtime requirements: Bun >= 1.3, a writable directory for the
SQLite file, and the `PORT` env var the host assigns (read
automatically).

## Layout

- `client/` — the player's React client (unmodified from the app build)
- `server/src/` — the server actions, schema, and privileged password
  handlers (unmodified; Argon2id via Bun.password)
- `drizzle/` — SQLite migrations, applied by the bootstrap at boot
- `standalone/server.ts` — the standalone host: static file serving,
  `POST /actions` dispatch with the host ctx the actions expect
  (Drizzle/bun-sqlite DB, privileged-handler executor)
- `standalone/build-client.mjs` — the client bundler (same Bun.build
  config the original SDK build used)
- `vendor/space-sdk/` — the `@hatch/space-sdk` package the app imports,
  vendored so the repo installs without the Muse platform
