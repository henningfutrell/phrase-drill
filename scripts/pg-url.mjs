/**
 * Connection-string handling shared by `backup.mjs` and `restore-drill.mjs`
 * (T054). Neither script ever passes a Postgres URL containing a password
 * as a child-process argument or a log field — a `ps aux` snapshot or a log
 * line could catch it. `sanitizedUriWithDatabase` strips the password from
 * the URI (keeping host/port/user/query-string, e.g. `sslmode=require`,
 * intact) and swaps in whichever database the caller wants; `parsePgUrl`
 * pulls the *decoded* password out separately, for `PGPASSWORD` — libpq
 * compares it literally, not against the URL-encoded form.
 */

/** @returns {{ password: string, database: string }} */
export function parsePgUrl(databaseUrl) {
  const url = new URL(databaseUrl)
  return {
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  }
}

/**
 * Same host/port/user/query-string as `databaseUrl`, password removed,
 * database replaced with `database`. For a URI handed to a *child process*
 * as an argument (`pg_dump -d <uri>`, `psql <uri>`) — argv is visible to
 * `ps`, so the password travels separately via `PGPASSWORD` instead (see
 * `parsePgUrl`).
 */
export function sanitizedUriWithDatabase(databaseUrl, database) {
  const url = new URL(databaseUrl)
  url.password = ''
  url.pathname = `/${database}`
  return url.toString()
}

/**
 * Same as `sanitizedUriWithDatabase`, but keeps the password. Only safe for
 * an **in-process** connection (`new pg.Pool({ connectionString })`) — `pg`
 * parses the whole connection string itself, and passing `password` as a
 * separate config field alongside a passwordless `connectionString` does
 * not merge the way one would expect (`pg`'s own URL parsing wins and
 * leaves the password unset — reproduced while building this script).
 * Never pass this to `child_process.spawn` as an argument.
 */
export function uriWithDatabase(databaseUrl, database) {
  const url = new URL(databaseUrl)
  url.pathname = `/${database}`
  return url.toString()
}
