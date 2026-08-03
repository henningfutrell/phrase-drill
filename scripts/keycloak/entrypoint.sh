#!/bin/sh
# Keycloak's --import-realm reads a static file — it does not expand env
# vars itself. `redirectUris` must not ship as `https://*/*` (open-redirect
# surface, T043), so the real value lives in `APP_REDIRECT_URI` (compose
# env, safe localhost default) and this script substitutes it into the
# committed template before Keycloak ever reads the file. Runs on every
# boot; harmless when the realm already exists (KC_IMPORT_REALM upserts).
set -e

mkdir -p /opt/keycloak/data/import
REDIRECT_URI_PATTERN="${APP_REDIRECT_URI:-http://localhost:8080/*}"
# sed, not envsubst: the Keycloak base image is not guaranteed to carry
# gettext, and this is one literal substitution.
sed "s#\${REDIRECT_URI_PATTERN}#${REDIRECT_URI_PATTERN}#g" \
  /opt/keycloak/realm-template.json \
  > /opt/keycloak/data/import/phrase-drill-realm.json

exec /opt/keycloak/bin/kc.sh start --import-realm
