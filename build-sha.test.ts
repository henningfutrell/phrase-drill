import { describe, expect, it, vi } from 'vitest'
import { readBuildSha } from './build-sha.ts'

/**
 * The build stamp exists for exactly one situation: she reports a fault over
 * the phone and the answer turns on whether she is running today's code.
 * Until now it answered `unknown` on every deploy that has ever run — the
 * Docker builder image has no `git`, and `.dockerignore` excludes `.git`
 * anyway — so the one question it was built to settle was the one question it
 * could never settle. That is what these tests pin.
 */
describe('readBuildSha', () => {
  it('takes the commit Render injects, so a Docker build without git still identifies itself', () => {
    const sha = readBuildSha({ RENDER_GIT_COMMIT: '0123456789abcdef0123456789abcdef01234567' }, () => {
      throw new Error('git must not be consulted when the platform already said')
    })
    expect(sha).toBe('0123456')
  })

  it('ignores an empty injected commit rather than stamping the build with a blank', () => {
    expect(readBuildSha({ RENDER_GIT_COMMIT: '' }, () => 'abc1234\n')).toBe('abc1234')
    expect(readBuildSha({ RENDER_GIT_COMMIT: '   ' }, () => 'abc1234\n')).toBe('abc1234')
  })

  it('falls back to git for a local build, where the platform variable is absent', () => {
    expect(readBuildSha({}, () => 'def5678\n')).toBe('def5678')
  })

  it('says unknown rather than failing the build when neither source can answer', () => {
    const runGit = vi.fn(() => {
      throw new Error('git: not found')
    })
    expect(readBuildSha({}, runGit)).toBe('unknown')
    expect(runGit).toHaveBeenCalledTimes(1)
  })

  it('says unknown when git answers with nothing, rather than stamping an empty sha', () => {
    expect(readBuildSha({}, () => '\n')).toBe('unknown')
  })
})
