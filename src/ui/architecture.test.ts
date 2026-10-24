import { describe, expect, it } from 'vitest'

// AGENTS.md: only App.tsx/main.tsx may import from both domain/ and adapters/*.
// A screen that needs an adapter's type declares its own plain mirror; the
// composition root is where TypeScript checks the two still agree.
const sources = import.meta.glob<string>(['./*.ts', './*.tsx', '!./*.test.ts', '!./*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('src/ui architecture', () => {
  it('reads every screen file', () => {
    expect(Object.keys(sources)).toContain('./DrillScreen.tsx')
  })

  it('imports nothing from src/adapters', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /from\s+['"]\.\.\/adapters\//.test(text))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
