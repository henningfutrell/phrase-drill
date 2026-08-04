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
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DIST_DIR=/app/dist
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY scripts/useradd.mjs ./scripts/useradd.mjs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

EXPOSE 8080
CMD ["node", "server/index.js"]
