#!/bin/sh
# One Postgres instance, two logical databases (T043 db.js doc comment):
# `phrase_drill` for the app's own table, `keycloak` for Keycloak's own
# schema. Runs once, only against an empty data directory — the official
# postgres image executes everything in /docker-entrypoint-initdb.d/ on
# first boot only, never again once /var/lib/postgresql/data is non-empty.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE keycloak;
  GRANT ALL PRIVILEGES ON DATABASE keycloak TO "$POSTGRES_USER";
EOSQL
