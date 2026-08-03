# phrase-drill

French phrase-drill PWA for one person, one iPhone. See `AGENTS.md` for
architecture and constraints, `PRODUCT.md` for what it's for, `docs/server.md`
for the server (T041) that owns both provider credentials and her library.

## Develop

```sh
npm run dev
```

## Test / lint / build

```sh
npm test
npm run lint
npm run build
```

## Run the server locally

```sh
docker compose up --build
```

No cloud account needed. Speech and Scan return "not configured" until
`ELEVENLABS_API_KEY`/`ANTHROPIC_API_KEY` are set (a `.env` file next to
`docker-compose.yml`, git-ignored). Full detail, endpoints, and the Coolify
deploy path: `docs/server.md`.

## Deploy the static build (GitHub Pages)

```sh
npm run deploy
```

Runs `scripts/deploy.sh`: builds the app and publishes `dist/` to the
`gh-pages` branch, served at `https://henningfutrell.github.io/phrase-drill/`.
This is the PWA's own static assets only — it does not deploy the server; see
`docs/server.md` for that.

- Built assets and manifest use a relative base (`vite.config.ts`), so the
  same build works served from a project sub-path (Pages) or a domain root
  (the Docker/Coolify server, `server/static.js`) with no separate build.
- `gh-pages` also hosts `spike/`, an unrelated device diagnostic cited as
  evidence elsewhere — the script preserves it and replaces everything else
  at the branch root with the fresh build.
- No `gh-pages` npm package: not already a dependency, and not worth adding
  for a one-command `git`-shaped publish. The script is plain `/usr/bin/git`
  via a throwaway worktree.
