# phrase-drill server (T041/T050) — one container serves the built PWA and
# the API that owns both provider credentials and login. Two stages: the
# first has the devDependencies needed to build the static PWA (vite,
# typescript); the second ships only the built assets and the server, whose
# only npm dependency is `pg` (Postgres — server/db.js).

FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The commit this image is built from, for the Diagnostics build stamp
# (build-sha.ts). Render injects RENDER_GIT_COMMIT into every Docker build,
# but only into an ARG the Dockerfile declares — undeclared, it is silently
# dropped, which is why the stamp read `unknown` on every deploy this app has
# ever had. Declared here rather than at the top of the stage on purpose: it
# changes on every commit, so an earlier position would invalidate the layer
# cache for `npm ci` on every deploy. Empty for a plain `docker build`, which
# build-sha.ts then answers with git or `unknown`.
ARG RENDER_GIT_COMMIT
# The device's Supabase project URL and publishable key, baked into the bundle
# (the build fails without them). Both are public by design: row-level
# security and a disabled Data API are what protect the data, not these.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DIST_DIR=/app/dist
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY scripts/useradd.mjs ./scripts/useradd.mjs
# clip-delete imports describeTarget from useradd.mjs, copied above; the rest
# of what it needs is server/.
COPY scripts/clip-delete.mjs ./scripts/clip-delete.mjs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

EXPOSE 8080
CMD ["node", "server/index.js"]
