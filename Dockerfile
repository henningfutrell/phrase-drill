# phrase-drill server (T041) — one container serves the built PWA and the
# API that owns both provider credentials. Two stages: the first has the
# devDependencies needed to build the static PWA (vite, typescript); the
# second ships only the built assets and the server, which has zero npm
# dependencies of its own (node:http, node:sqlite, fetch — all built in).
#
# Node 26 for `node:sqlite` with no experimental flag (server/db.js).

FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DIST_DIR=/app/dist
ENV DB_PATH=/data/phrase-drill.db
COPY --from=builder /app/dist ./dist
COPY server ./server

# The named volume (docker-compose.yml) mounts here — the library database
# is the user's data and outlives the container.
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "server/index.js"]
