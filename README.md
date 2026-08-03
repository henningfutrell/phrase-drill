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

```sh
npm run deploy
```

Runs `scripts/deploy.sh`: builds the app and publishes `dist/` to the
`gh-pages` branch, served at `https://henningfutrell.github.io/phrase-drill/`.

- Built under the `/phrase-drill/` sub-path (`vite.config.ts` `base`) because
  Pages serves this repo from a project path, not a domain root.
- `gh-pages` also hosts `spike/`, an unrelated device diagnostic cited as
  evidence elsewhere — the script preserves it and replaces everything else
  at the branch root with the fresh build.
- No `gh-pages` npm package: not already a dependency, and not worth adding
  for a one-command `git`-shaped publish. The script is plain `/usr/bin/git`
  via a throwaway worktree.
