// @vitest-environment node
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * A dry run of `cutover.sh`: the real script, with every tool it reaches a
 * service through (`psql`, `pg_dump`, `pg_restore`, `node`, `curl`) replaced
 * on PATH by a stub that records its arguments and answers from canned
 * values. Nothing here can reach Render or Supabase: the stubs answer every
 * call, and the URLs point at `.invalid` hosts, which never resolve, in case
 * one did not.
 */
const SCRIPT = new URL('./cutover.sh', import.meta.url).pathname

const ENV = {
  RENDER_EXTERNAL_URL: 'postgresql://render.invalid/app',
  SUPABASE_DB_URL: 'postgresql://supabase.invalid/postgres',
  SUPABASE_URL: 'https://supabase.invalid',
  SUPABASE_SECRET_KEY: 'stub-secret',
  SUPABASE_PUBLISHABLE_KEY: 'stub-publishable',
}

/**
 * One stub for every tool. Each call appends `tool<TAB>args` to `$STUB_LOG`.
 * The answers come from STUB_* variables so a test can change one fact —
 * a bucket that is missing, a Render that changed — and leave the rest.
 */
const STUB = `#!/usr/bin/env bash
tool=$(basename "$0")
printf '%s\\t%s\\n' "$tool" "$*" >> "$STUB_LOG"
args="$*"
case "$tool" in
  pg_dump)
    case "$args" in --version) echo "pg_dump (PostgreSQL) $STUB_PG_MAJOR.0"; exit 0 ;; esac
    exit 0 ;;
  pg_restore|node) exit 0 ;;
  curl)
    case "$args" in
      */storage/v1/bucket/*) printf '%s' "$STUB_BUCKET_CODE" ;;
      */rest/v1/*) printf '%s\\n%s' "$STUB_REST_BODY" "$STUB_REST_CODE" ;;
      *) echo "unexpected curl: $args" >&2; exit 99 ;;
    esac ;;
  psql)
    case "$args" in
      *"SELECT (SELECT count(*) FROM libraries) ||"*)
        n=$(grep -c 'FROM libraries) ||' "$STUB_LOG")
        if [ "$n" -gt 1 ]; then echo "$STUB_FINGERPRINT_AFTER"; else echo "$STUB_FINGERPRINT_BEFORE"; fi ;;
      *"FROM pg_tables"*) printf 'clips\\nlibraries\\nlibrary_versions\\n' ;;
      *"LEFT JOIN auth.users"*) echo "$STUB_ORPHANS" ;;
      *"SELECT count(*) FROM libraries"*) echo 0 ;;
      *"FROM users WHERE id"*) echo "$STUB_RENDER_USER" ;;
      *"FROM auth.users WHERE id"*) echo 1 ;;
      *"current_database()"*) echo postgres ;;
      *005_verify.sql*) echo "libraries|1|abc" ;;
    esac
    exit 0 ;;
esac
`

let dir
let workdir
let stubLog

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cutover-dry-run-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const tool of ['psql', 'pg_dump', 'pg_restore', 'node', 'curl']) {
    writeFileSync(join(bin, tool), STUB)
    chmodSync(join(bin, tool), 0o755)
  }
  workdir = join(dir, 'work')
  stubLog = join(dir, 'calls.log')
  writeFileSync(stubLog, '')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(args, { env = ENV, stub = {} } = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      HOME: dir,
      STUB_LOG: stubLog,
      STUB_PG_MAJOR: '18',
      STUB_BUCKET_CODE: '200',
      STUB_REST_CODE: '401',
      STUB_REST_BODY: '{}',
      STUB_FINGERPRINT_BEFORE: '1/100/2/3',
      STUB_FINGERPRINT_AFTER: '1/100/2/3',
      STUB_RENDER_USER: '1',
      STUB_ORPHANS: '0',
      ...stub,
      ...env,
    },
  })
  const calls = readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tool, args] = line.split('\t')
      return { tool, args }
    })
  // After preflight the script sends stderr to stdout through its log
  // (`exec > >(tee ...) 2>&1`), so a refusal can be on either: read both.
  return { status: result.status, output: result.stdout + result.stderr, calls }
}

/**
 * The steps the run announced, in order: `step` prints a blank line, then
 * `== <step>`. 002_data.sh prints `== ` lines of its own with no blank line
 * before them; they are not steps of the cutover.
 */
const steps = (output) => {
  const lines = output.split('\n')
  return lines
    .filter((line, i) => line.startsWith('== ') && lines[i - 1] === '')
    .map((line) => line.slice(3))
}

/** Each call, named by what it does, so the order reads as the README "Order". */
function actions(calls) {
  return calls.map(({ tool, args }) => {
    if (tool === 'psql') {
      const file = args.match(/-f \S*\/(\d{3}_\w+\.sql)/)
      if (file)
        return `${args.includes('render.invalid') ? 'render' : 'supabase'} ${file[1]}`
      if (args.includes('DROP TABLE')) return 'drop app tables'
      if (args.includes('FROM libraries) ||')) return 'render fingerprint'
      if (args.includes('LEFT JOIN auth.users')) return 'count orphans'
      return 'psql query'
    }
    if (tool === 'node') return `node ${args.replace(/^\S*\/scripts\//, '')}`
    if (tool === 'curl')
      return args.includes('/rest/v1/') ? 'REST probe' : 'bucket probe'
    return `${tool}${args === '--version' ? ' --version' : ''}`
  })
}

describe('cutover.sh — arguments', () => {
  it.each([
    [[], '--workdir is required'],
    [['--workdir'], '--workdir needs a value'],
    [['--workdir', 'w', '--bogus'], 'unknown argument: --bogus'],
    [
      ['--workdir', 'w', '--user-email', 'a@example.test'],
      '--user-email and --user-id go together',
    ],
    [
      ['--workdir', 'w', '--user-id', 'u1'],
      '--user-email and --user-id go together',
    ],
  ])('refuses %j before it calls anything', (args, message) => {
    const { status, output, calls } = run(args)
    expect(status).not.toBe(0)
    expect(output).toContain(message)
    expect(calls).toEqual([])
  })

  it.each(Object.keys(ENV))(
    'refuses with %s unset, and calls nothing',
    (name) => {
      const env = { ...ENV, [name]: '' }
      const { status, output, calls } = run(['--workdir', workdir, '--yes'], {
        env,
      })
      expect(status).toBe(2)
      expect(output).toContain(`${name} is unset`)
      expect(calls).toEqual([])
      expect(existsSync(workdir), 'no workdir made').toBe(false)
    },
  )
})

describe('cutover.sh — preflight refusals, before anything is dropped', () => {
  it('refuses a pg_dump older than 18', () => {
    const { status, output, calls } = run(['--workdir', workdir, '--yes'], {
      stub: { STUB_PG_MAJOR: '17' },
    })
    expect(status).toBe(2)
    expect(output).toContain('pg_dump 17: need 18 or newer')
    expect(actions(calls)).not.toContain('drop app tables')
  })

  it('refuses when the clips bucket is missing', () => {
    const { status, output, calls } = run(['--workdir', workdir, '--yes'], {
      stub: { STUB_BUCKET_CODE: '404' },
    })
    expect(status).toBe(2)
    expect(output).toContain('bucket clips: HTTP 404')
    expect(actions(calls)).not.toContain('drop app tables')
  })
})

describe('cutover.sh — a full run', () => {
  it('runs the README "Order" steps in order and exits 0', () => {
    const { status, output, calls } = run(['--workdir', workdir, '--yes'])
    expect(status).toBe(0)
    expect(steps(output)).toEqual([
      'preflight',
      'drop the Supabase app tables (Storage objects and Auth users are kept)',
      '001 schema, then 004 RLS before any data',
      '002 data',
      '003 fixup',
      '005 verify: Render and Supabase must be identical',
      'clips: manifest, copy, verify',
      'auth users',
      'finalize, verify, sweep',
      'RLS again, and the publishable key must be refused',
      'Render unchanged during the run',
    ])
    const order = actions(calls).filter((a) => a !== 'psql query')
    expect(order).toEqual([
      'pg_dump --version',
      'bucket probe',
      'render fingerprint',
      'drop app tables',
      'supabase 001_schema.sql',
      'supabase 004_rls.sql',
      'pg_dump',
      'pg_restore',
      'supabase 003_fixup.sql',
      'render 005_verify.sql',
      'supabase 005_verify.sql',
      'node clips-to-storage.mjs --manifest',
      'node clips-to-storage.mjs',
      'node clips-to-storage.mjs --verify-only',
      'node auth-user-create.mjs --map-from-render',
      'count orphans',
      'node clips-to-storage.mjs --finalize',
      'node clips-to-storage.mjs --verify-only',
      'node clips-to-storage.mjs --sweep',
      'supabase 004_rls.sql',
      'REST probe',
      'REST probe',
      'REST probe',
      'REST probe',
      'render fingerprint',
    ])
    expect(output).toContain('CUTOVER DATA PHASE DONE')
  })

  it('reads Render only: every write goes to the Supabase URL', () => {
    const { calls } = run(['--workdir', workdir, '--yes'])
    const writes = calls.filter(
      ({ tool, args }) =>
        tool === 'pg_restore' || /DROP|-f \S*\/00[134]_/.test(args),
    )
    expect(writes.length).toBeGreaterThan(0)
    for (const { args } of writes) {
      expect(args).toContain('supabase.invalid')
      expect(args).not.toContain('render.invalid')
    }
  })

  it('adds TLS to URLs that carry no sslmode', () => {
    const { calls } = run(['--workdir', workdir, '--yes'])
    const urls = calls
      .filter(({ tool }) => tool === 'psql')
      .map(({ args }) => args)
    expect(
      urls.some(
        (a) =>
          a.includes(
            'supabase.invalid/postgres?sslmode=verify-full&sslrootcert=',
          ) && a.includes('server/certs/supabase-prod-ca.crt'),
      ),
    ).toBe(true)
    expect(
      urls.some((a) => a.includes('render.invalid/app?sslmode=require')),
    ).toBe(true)
  })

  it('writes its log into the workdir', () => {
    run(['--workdir', workdir, '--yes'])
    const log = readFileSync(
      join(
        workdir,
        readdirSync(workdir).find((f) => f.startsWith('cutover-')),
      ),
      'utf8',
    )
    expect(log).toContain('== preflight')
  })

  it('creates their auth user only when it is a Render users.id, and keeps one that exists', () => {
    const ok = run([
      '--workdir',
      workdir,
      '--yes',
      '--user-email',
      'them@example.test',
      '--user-id',
      'u1',
    ])
    expect(ok.status).toBe(0)
    expect(ok.output).toContain('their auth user u1 already exists: kept')

    writeFileSync(stubLog, '')
    const unknown = run(
      [
        '--workdir',
        workdir,
        '--yes',
        '--user-email',
        'them@example.test',
        '--user-id',
        'u9',
      ],
      { stub: { STUB_RENDER_USER: '0' } },
    )
    expect(unknown.status).toBe(1)
    expect(unknown.output).toContain('--user-id u9 is not a Render users.id')
  })
})

describe('cutover.sh — refusals after the data phase', () => {
  it('fails when a table is readable with the publishable key', () => {
    const { status, output } = run(['--workdir', workdir, '--yes'], {
      stub: { STUB_REST_CODE: '200' },
    })
    expect(status).toBe(1)
    expect(output).toContain(
      'REST libraries: HTTP 200 — readable with the publishable key',
    )
  })

  it('counts 503 PGRST002 as refused: the Data API is off', () => {
    const { status, output } = run(['--workdir', workdir, '--yes'], {
      stub: {
        STUB_REST_CODE: '503',
        STUB_REST_BODY:
          '{"code":"PGRST002","details":null,"hint":null,"message":"Could not query the database for the schema cache. Retrying."}',
      },
    })
    expect(status).toBe(0)
    expect(output).toContain('REST libraries: HTTP 503 (refused)')
    expect(output).toContain('CUTOVER DATA PHASE DONE')
  })

  it('fails on a 503 that is not PGRST002: an outage is not a refusal', () => {
    const { status, output } = run(['--workdir', workdir, '--yes'], {
      stub: { STUB_REST_CODE: '503', STUB_REST_BODY: 'Service Unavailable' },
    })
    expect(status).toBe(1)
    expect(output).toContain(
      'REST libraries: HTTP 503 — readable with the publishable key',
    )
  })

  it('fails when Render changed during the run', () => {
    const { status, output } = run(['--workdir', workdir, '--yes'], {
      stub: { STUB_FINGERPRINT_AFTER: '1/101/2/3' },
    })
    expect(status).toBe(1)
    expect(output).toContain(
      'Render changed during the run (1/100/2/3 -> 1/101/2/3)',
    )
  })

  it('exits 3 when a library has no auth user: data done, account pending', () => {
    const { status, output } = run(['--workdir', workdir, '--yes'], {
      stub: { STUB_ORPHANS: '1' },
    })
    expect(status).toBe(3)
    expect(output).toContain('DATA DONE, USER ACCOUNT PENDING')
  })
})
