import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The mutation gate (T043) exists to answer a question line coverage cannot:
// do the domain's tests actually FAIL when the domain's behaviour changes?
// Coverage says a line ran. A surviving mutant says a line ran and nothing
// cared what it did.
//
// This file locks the gate's contract, not its score. Three things can rot
// silently and each one turns the gate into decoration: the scope drifting
// off the domain, the break threshold being removed so a red run exits 0,
// and the npm script vanishing. A run that reports a score nobody can fail
// is worse than no run, because it reads as assurance.

const rootDir = path.dirname(fileURLToPath(import.meta.url))

type StrykerConfig = {
  mutate?: string[]
  thresholds?: { high?: number; low?: number; break?: number | null }
  testRunner?: string
}

function readStrykerConfig(): StrykerConfig {
  return JSON.parse(
    readFileSync(path.join(rootDir, 'stryker.config.json'), 'utf-8'),
  ) as StrykerConfig
}

describe('mutation gate configuration', () => {
  it('is scoped to the domain, and that scope resolves to real source files', () => {
    const { mutate } = readStrykerConfig()
    expect(mutate).toBeDefined()

    // Every positive pattern targets the domain. Mutating adapters or React
    // screens is a deliberate later widening (T043 notes), not an accident.
    const positives = mutate!.filter((p) => !p.startsWith('!'))
    expect(positives.length).toBeGreaterThan(0)
    for (const pattern of positives) {
      expect(pattern).toMatch(/^src\/domain\//)
    }

    // The scope pointing at nothing is the failure that looks like success:
    // Stryker reports 100% when it mutates zero files.
    const exclude = mutate!
      .filter((p) => p.startsWith('!'))
      .map((p) => p.slice(1))
    const matched = globSync(positives, { cwd: rootDir, exclude })
    expect(matched.length).toBeGreaterThan(0)

    // Tests and test-support are excluded — mutating a test proves nothing.
    for (const file of matched) {
      expect(file).not.toMatch(/\.test\.ts$/)
      expect(file).not.toMatch(/test-support/)
    }
  })

  it('breaks the build below a threshold, rather than reporting a score nobody can fail', () => {
    const { thresholds } = readStrykerConfig()
    expect(thresholds?.break).toBeTypeOf('number')
    expect(thresholds!.break!).toBeGreaterThan(0)
    // `high`/`low` only colour the report. `break` is the only field that
    // changes the exit code, so it is the only one worth asserting hard.
    expect(thresholds!.break!).toBeLessThanOrEqual(100)
  })

  it('runs the real vitest suite, not a second parallel definition of the tests', () => {
    expect(readStrykerConfig().testRunner).toBe('vitest')
  })

  it('keeps its own sandbox out of the ordinary test run', async () => {
    // Found while wiring the gate: Stryker's sandbox is a full copy of the
    // repo with the source deliberately broken, so an un-excluded
    // `.stryker-tmp` makes `npm test` collect the suite twice — 451 tests
    // became 900, half of them asserting against mutated code. It passed,
    // which is the dangerous part. A failed run leaves the directory behind,
    // so this is not self-healing.
    const { default: config } = (await import('./vite.config')) as {
      default: { test?: { exclude?: string[] } }
    }
    expect(config.test?.exclude).toContain('.stryker-tmp/**')
  })

  it('is reachable as an npm script', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(rootDir, 'package.json'), 'utf-8'),
    ) as { scripts?: Record<string, string> }
    expect(pkg.scripts?.['test:mutation']).toMatch(/stryker run/)
  })
})
