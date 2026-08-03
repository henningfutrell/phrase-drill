# phrase-drill

French phrase-drill PWA for one person, one iPhone. See `AGENTS.md` for
architecture and constraints, `PRODUCT.md` for what it's for.

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

## Deploy

Served by a Cloudflare Worker: one origin, the built PWA and the
`/api/library/:key` sync API (`docs/sync.md`), storage in R2. Config is
`wrangler.jsonc`, the Worker itself is `worker/`.

```sh
npm run deploy
```

Runs `npm run build && wrangler deploy` — builds `dist/` and publishes it
plus `worker/` in one step. Nothing else to run.

### One-time setup (human step — this repo cannot log in to Cloudflare)

```sh
# 1. Authenticate wrangler with your Cloudflare account (opens a browser).
npx wrangler login

# 2. Create the R2 bucket the Worker stores libraries in. Name must match
#    wrangler.jsonc's r2_buckets[0].bucket_name ("phrase-drill-library").
npx wrangler r2 bucket create phrase-drill-library

# 3. First deploy.
npm run deploy
```

After that, `npm run deploy` alone republishes both the app and the API on
every change.

### Local development against the real Worker

```sh
npx wrangler dev
```

Runs the app and the `/api/library/:key` API against the local Workers
runtime (workerd), with R2 simulated locally — no Cloudflare account or
network access needed for this.
