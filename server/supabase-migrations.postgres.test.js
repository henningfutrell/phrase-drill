// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

/**
 * `supabase/migrations/` against a real Postgres: the hardening is only
 * worth something if Postgres refuses what it says it refuses.
 *
 * Opt-in. It needs a Postgres where it may CREATE DATABASE and CREATE ROLE:
 * the local Supabase stack, or a throwaway container.
 *
 *   MIGRATIONS_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   npx vitest run server/supabase-migrations.postgres.test.js
 *
 * It works in a scratch database it creates and drops. A fresh database has
 * no `auth` schema, so it stands in a minimal `auth.uid()` that reads the
 * same `request.jwt.claim.sub` setting as Supabase's, and makes the `anon`
 * and `authenticated` roles when the cluster has none.
 */
const url = process.env.MIGRATIONS_DATABASE_URL
const migrationsDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url))
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
const hardening = migrations.find((name) => name.endsWith('_security_hardening.sql'))
const sql = (name) => readFileSync(join(migrationsDir, name), 'utf8')

const USER_A = '00000000-0000-4000-8000-00000000000a'
const USER_B = '00000000-0000-4000-8000-00000000000b'
const USER_C = '00000000-0000-4000-8000-00000000000c'
const TABLES = ['libraries', 'library_versions', 'clips', 'clip_jobs']
const CACHE_ROWS = {
  clips: (hash) => `INSERT INTO clips VALUES ('${hash}', 'p', 'audio/mpeg', 1, 1, 1, 1)`,
  clip_jobs: (hash) => `INSERT INTO clip_jobs VALUES ('${hash}', 'p', 'm', 'v', 'en', 't', 'done', 1, 1, 1, 1, NULL, 1, 1)`,
}

describe.skipIf(!url)('supabase/migrations against a real Postgres', () => {
  const database = `migrations_${randomBytes(4).toString('hex')}`
  let admin
  let db

  /** Runs `fn` in a transaction as `role`, with `sub` as the access token's user, and always rolls back. */
  async function as(role, sub, fn) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      if (sub) await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub])
      await client.query(`SET LOCAL ROLE ${role}`)
      return await fn(client)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  const reapplyHardening = () => db.query(sql(hardening))

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url })
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$`)
    await admin.query(`CREATE DATABASE ${database}`)
    const scratch = new URL(url)
    scratch.pathname = `/${database}`
    db = new pg.Pool({ connectionString: scratch.toString() })
    await db.query(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
        AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated;
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      -- What Supabase grants by default, so the hardening has something to revoke.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    `)
    for (const name of migrations) await db.query(sql(name))
    await db.query(`INSERT INTO libraries VALUES ($1, '{}', 1), ($2, '{}', 1)`, [USER_A, USER_B])
    await db.query(`INSERT INTO library_versions (library_key, data, updated_at, archived_at) VALUES ($1, '{}', 1, 1), ($2, '{}', 1, 1)`, [USER_A, USER_B])
    await db.query(CACHE_ROWS.clips('h1'))
    await db.query(CACHE_ROWS.clip_jobs('h1'))
  })

  afterAll(async () => {
    await db?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin?.end()
  })

  for (const role of ['anon', 'authenticated']) {
    for (const table of TABLES) {
      it(`refuses ${role} on ${table}`, async () => {
        await expect(as(role, USER_A, (c) => c.query(`SELECT * FROM ${table}`))).rejects.toMatchObject({ code: '42501' })
      })
    }
  }

  it('keeps the owner (the server) able to read and write', async () => {
    const { rows } = await db.query('SELECT library_key FROM libraries ORDER BY library_key')
    expect(rows.map((r) => r.library_key)).toEqual([USER_A, USER_B])
  })

  it('scopes a granted read to the user’s own library, as a second wall', async () => {
    const own = await as('postgres', null, async (c) => {
      await c.query('GRANT SELECT ON libraries, library_versions TO authenticated')
      await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USER_A])
      await c.query('SET LOCAL ROLE authenticated')
      const libraries = await c.query('SELECT library_key FROM libraries')
      const versions = await c.query('SELECT library_key FROM library_versions')
      return [...libraries.rows, ...versions.rows].map((r) => r.library_key)
    })
    expect(own).toEqual([USER_A, USER_A])
  })

  /** Runs `fn` as `authenticated` with `sub` as the user, after granting the API roles every table privilege. */
  const asGrantedUser = (sub, fn) =>
    as('postgres', null, async (c) => {
      await c.query(`GRANT ALL ON ${TABLES.join(', ')} TO authenticated`)
      await c.query('GRANT ALL ON SEQUENCE library_versions_id_seq TO authenticated')
      await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub])
      await c.query('SET LOCAL ROLE authenticated')
      return fn(c)
    })

  it('lets a granted user write their own library rows', async () => {
    const counts = await asGrantedUser(USER_A, async (c) => [
      (await c.query(`UPDATE libraries SET data = 'mine' WHERE library_key = $1`, [USER_A])).rowCount,
      (await c.query(`INSERT INTO library_versions (library_key, data, updated_at, archived_at) VALUES ($1, '{}', 2, 2)`, [USER_A])).rowCount,
      (await c.query(`UPDATE library_versions SET data = 'mine' WHERE library_key = $1`, [USER_A])).rowCount,
      (await c.query(`DELETE FROM library_versions WHERE library_key = $1`, [USER_A])).rowCount,
      (await c.query(`DELETE FROM libraries WHERE library_key = $1`, [USER_A])).rowCount,
    ])
    expect(counts).toEqual([1, 1, 2, 2, 1])
  })

  it('hides another user’s library rows from a granted user', async () => {
    const counts = await asGrantedUser(USER_B, async (c) => [
      (await c.query(`SELECT 1 FROM libraries WHERE library_key = $1`, [USER_A])).rowCount,
      (await c.query(`SELECT 1 FROM library_versions WHERE library_key = $1`, [USER_A])).rowCount,
      (await c.query(`UPDATE libraries SET data = 'theirs' WHERE library_key = $1`, [USER_A])).rowCount,
      (await c.query(`UPDATE library_versions SET data = 'theirs' WHERE library_key = $1`, [USER_A])).rowCount,
      (await c.query(`DELETE FROM libraries WHERE library_key = $1`, [USER_A])).rowCount,
      (await c.query(`DELETE FROM library_versions WHERE library_key = $1`, [USER_A])).rowCount,
    ])
    expect(counts).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('refuses a granted user a row in another user’s name', async () => {
    await expect(
      asGrantedUser(USER_B, (c) => c.query(`INSERT INTO libraries VALUES ($1, '{}', 1)`, [USER_C])),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      asGrantedUser(USER_B, (c) =>
        c.query(`INSERT INTO library_versions (library_key, data, updated_at, archived_at) VALUES ($1, '{}', 1, 1)`, [USER_A]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      asGrantedUser(USER_B, (c) => c.query(`UPDATE libraries SET library_key = $1 WHERE library_key = $2`, [USER_C, USER_B])),
    ).rejects.toMatchObject({ code: '42501' })
  })

  for (const table of ['clips', 'clip_jobs']) {
    it(`keeps the shared ${table} cache closed to a granted user`, async () => {
      const counts = await asGrantedUser(USER_A, async (c) => [
        (await c.query(`SELECT 1 FROM ${table}`)).rowCount,
        (await c.query(`UPDATE ${table} SET created_at = 2`)).rowCount,
        (await c.query(`DELETE FROM ${table}`)).rowCount,
      ])
      expect(counts).toEqual([0, 0, 0])
      await expect(
        asGrantedUser(USER_A, (c) => c.query(CACHE_ROWS[table]('h2'))),
      ).rejects.toMatchObject({ code: '42501' })
    })
  }

  it('refuses to finish when a public table has RLS on and no policy', async () => {
    await db.query('CREATE TABLE public.policyless (id int); ALTER TABLE public.policyless ENABLE ROW LEVEL SECURITY')
    try {
      await expect(reapplyHardening()).rejects.toThrow(/table policyless has RLS on and no policy/)
    } finally {
      await db.query('DROP TABLE public.policyless')
    }
  })

  it('is idempotent', async () => {
    await expect(reapplyHardening()).resolves.toBeDefined()
  })

  it('refuses to finish when a public function is SECURITY DEFINER', async () => {
    await db.query(`CREATE FUNCTION public.definer() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = '' AS 'SELECT 1'`)
    try {
      await expect(reapplyHardening()).rejects.toThrow(/security hardening refused: function definer\(\) is SECURITY DEFINER/)
    } finally {
      await db.query('DROP FUNCTION public.definer()')
    }
  })

  it('refuses to finish when a public function has no fixed search_path', async () => {
    await db.query(`CREATE FUNCTION public.loose() RETURNS int LANGUAGE sql AS 'SELECT 1'`)
    try {
      await expect(reapplyHardening()).rejects.toThrow(/function loose\(\) has no fixed search_path/)
    } finally {
      await db.query('DROP FUNCTION public.loose()')
    }
  })

  it('refuses to finish when a public table has RLS off', async () => {
    await db.query('CREATE TABLE public.unguarded (id int)')
    try {
      await expect(reapplyHardening()).rejects.toThrow(/table unguarded has RLS off/)
    } finally {
      await db.query('DROP TABLE public.unguarded')
    }
  })
})
