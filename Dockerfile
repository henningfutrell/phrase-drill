# phrase-drill server (T041/T043) — one container serves the built PWA and
# the API that owns both provider credentials. Two stages: the first has
# the devDependencies needed to build the static PWA (vite, typescript);
# the second ships only the built assets and the server, whose only npm
# dependency is `pg` (Postgres — server/db.js).
#
# The PWA is a static build baked once, so the Keycloak client config it
# needs (issuer URL, realm, client id — all public, no secret) is baked in
# at build time via Vite's `VITE_`-prefixed env vars, themselves supplied
# as Docker build ARGs from docker-compose.yml's `build.args`.

FROM node:26-alpine AS builder
WORKDIR /app
ARG VITE_KEYCLOAK_URL
ARG VITE_KEYCLOAK_REALM
ARG VITE_KEYCLOAK_CLIENT_ID
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ENV VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

EXPOSE 8080
CMD ["node", "server/index.js"]
