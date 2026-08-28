import { describe, expect, it } from 'vitest'
import { LINE_MAX_CHARS, splitPassageIntoLines, type Line } from './line'
import { createPassage, setPassageText } from './passage'

function linesOf(text: string): readonly Line[] {
  return splitPassageIntoLines(createPassage('pg1', 'Notes', text))
}

function textsOf(lines: readonly Line[]): string[] {
  return lines.map((line) => line.text)
}

/**
 * A run of exactly `length` characters with word breaks throughout, ending on
 * a letter — a trailing space would be trimmed away and the length assertions
 * with it.
 */
function words(length: number): string {
  const filled = 'mot '.repeat(Math.ceil(length / 4)).slice(0, length)
  return filled.endsWith(' ') ? `${filled.slice(0, -1)}x` : filled
}

describe('splitPassageIntoLines — nothing to read', () => {
  it('yields no Lines for empty text', () => {
    expect(linesOf('')).toEqual([])
  })

  it('yields no Lines for whitespace-only text', () => {
    expect(linesOf('   \n\t\n  ')).toEqual([])
  })
})

describe('splitPassageIntoLines — sentence boundaries', () => {
  it('keeps one sentence as one Line, trimmed', () => {
    expect(textsOf(linesOf('  Bonjour tout le monde.  '))).toEqual([
      'Bonjour tout le monde.',
    ])
  })

  it('does not break a many-word sentence that has no terminator at all', () => {
    expect(textsOf(linesOf('Bonjour tout le monde'))).toEqual([
      'Bonjour tout le monde',
    ])
  })

  it.each(['.', '!', '?', '…'])(
    'treats %s as a sentence terminator, keeping it with the Line it ends',
    (terminator) => {
      expect(textsOf(linesOf(`Un${terminator} Deux${terminator} Trois`))).toEqual([
        `Un${terminator}`,
        `Deux${terminator}`,
        'Trois',
      ])
    },
  )

  it('ends a Line at a terminator sitting at end-of-text, with no whitespace after it', () => {
    expect(textsOf(linesOf('Bonjour.'))).toEqual(['Bonjour.'])
    expect(textsOf(linesOf('Un. Deux!'))).toEqual(['Un.', 'Deux!'])
  })

  it('swallows a whole run of whitespace after a terminator', () => {
    expect(textsOf(linesOf('Un.    Deux.'))).toEqual(['Un.', 'Deux.'])
  })

  it('keeps a run of terminators together on the Line they end', () => {
    expect(textsOf(linesOf('Quoi ?! Rien.'))).toEqual(['Quoi ?!', 'Rien.'])
  })

  it('keeps the French space before a terminator inside its own Line', () => {
    expect(textsOf(linesOf('Ça va ? Merci.'))).toEqual(['Ça va ?', 'Merci.'])
  })

  /**
   * Documented, accepted limitation. The rule is purely lexical — a terminator
   * counts only when whitespace follows it — so a decimal point survives
   * (a digit follows it) while an abbreviation does not: "M. Dupont" becomes
   * two Lines. Fixing the abbreviation case needs a per-language abbreviation
   * list, a dictionary this app has no reason to carry, and the cost of
   * getting it wrong is one short extra Line the user taps past; the user can also just
   * put the sentence on its own line. Asserted rather than glossed over so a
   * future change to the rule shows up here as a decision, not a surprise.
   */
  it('keeps a decimal point mid-sentence, but does split an abbreviation followed by a space', () => {
    expect(textsOf(linesOf('Il coûte 3.5 euros.'))).toEqual([
      'Il coûte 3.5 euros.',
    ])
    expect(textsOf(linesOf('M. Dupont arrive.'))).toEqual([
      'M.',
      'Dupont arrive.',
    ])
  })
})

describe('splitPassageIntoLines — newlines', () => {
  it('splits on a newline, and the newline belongs to no Line', () => {
    expect(textsOf(linesOf('Premier vers\nSecond vers'))).toEqual([
      'Premier vers',
      'Second vers',
    ])
  })

  it('produces no empty Line for the blank lines between paragraphs', () => {
    expect(textsOf(linesOf('Un.\n\n\nDeux.'))).toEqual(['Un.', 'Deux.'])
  })
})

describe('splitPassageIntoLines — the LINE_MAX_CHARS cap', () => {
  it('leaves a piece of exactly LINE_MAX_CHARS characters as one Line', () => {
    const sentence = words(LINE_MAX_CHARS)

    expect(sentence).toHaveLength(LINE_MAX_CHARS)
    expect(textsOf(linesOf(sentence))).toEqual([sentence])
  })

  it('splits a piece one character over the cap — the boundary is inclusive', () => {
    expect(textsOf(linesOf('a'.repeat(LINE_MAX_CHARS + 1)))).toEqual([
      'a'.repeat(LINE_MAX_CHARS),
      'a',
    ])
  })

  it('uses a word break sitting exactly at the cap', () => {
    const sentence = words(LINE_MAX_CHARS)

    expect(textsOf(linesOf(`${sentence} suite`))).toEqual([sentence, 'suite'])
  })

  it('splits a piece over the cap at the last word break at or before the cap', () => {
    const head = words(LINE_MAX_CHARS - 3)

    const lines = textsOf(linesOf(`${head} suite`))

    expect(lines).toEqual([head, 'suite'])
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LINE_MAX_CHARS)
    }
  })

  it('cuts exactly at the cap when the capped window holds no whitespace at all', () => {
    const run = 'a'.repeat(LINE_MAX_CHARS + 50)

    expect(textsOf(linesOf(run))).toEqual([
      'a'.repeat(LINE_MAX_CHARS),
      'a'.repeat(50),
    ])
  })

  /**
   * The guard against a cut that consumes nothing. After a cut the remainder
   * begins with the whitespace the cut landed on, so a window whose *only*
   * whitespace is that leading character has no break point of its own and
   * has to fall back to the hard cap.
   */
  it('makes progress when the only whitespace left in the window is the one the previous cut landed on', () => {
    const lines = textsOf(linesOf(`aa ${'b'.repeat(LINE_MAX_CHARS + 100)}`))

    expect(lines).toEqual([
      'aa',
      'b'.repeat(LINE_MAX_CHARS - 1),
      'b'.repeat(101),
    ])
  })

  it('does not count the whitespace a sentence split left behind against the cap', () => {
    const sentence = `${words(LINE_MAX_CHARS - 1)}.`

    expect(sentence).toHaveLength(LINE_MAX_CHARS)
    expect(textsOf(linesOf(`Un. ${sentence}`))).toEqual(['Un.', sentence])
  })

  /**
   * Three cuts, only one of which can land on a word break — the shape a
   * pasted URL inside a paragraph produces. Pins that the cap is measured
   * from the current part's start rather than from an absolute offset, which
   * a single-cut case cannot tell apart.
   */
  it('measures the cap from the start of each part, cutting at a break where there is one and at the cap where there is not', () => {
    const lines = textsOf(linesOf(`${'a'.repeat(400)} ${'b'.repeat(400)}`))

    expect(lines).toEqual([
      'a'.repeat(LINE_MAX_CHARS),
      'a'.repeat(100),
      'b'.repeat(LINE_MAX_CHARS - 1),
      'b'.repeat(101),
    ])
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LINE_MAX_CHARS)
    }
  })
})

describe('splitPassageIntoLines — Line identity', () => {
  it('prefixes every Line id with its Passage id — a Line has no identity of its own', () => {
    const lines = splitPassageIntoLines(
      createPassage('pg-42', 'Notes', 'Un. Deux.'),
    )

    expect(lines.map((line) => line.id)).toEqual(['pg-42#0', 'pg-42#1'])
  })

  it('numbers ids contiguously from 0 over the final list, after every split', () => {
    const lines = linesOf(`Un.\n\nDeux. ${'a'.repeat(LINE_MAX_CHARS + 50)}`)

    expect(lines.map((line) => line.id)).toEqual([
      'pg1#0',
      'pg1#1',
      'pg1#2',
      'pg1#3',
    ])
  })

  it('returns only trimmed, non-empty text', () => {
    const lines = linesOf('  Un.  \n\n   \n  Deux !  \n')

    expect(textsOf(lines)).toEqual(['Un.', 'Deux !'])
    for (const line of lines) {
      expect(line.text).toBe(line.text.trim())
      expect(line.text.length).toBeGreaterThan(0)
    }
  })

  it('re-derives every Line from the current text — a Line is derived, never authored', () => {
    const before = createPassage('pg1', 'Notes', 'Un. Deux.')
    const after = setPassageText(before, 'Trois.')

    expect(textsOf(splitPassageIntoLines(before))).toEqual(['Un.', 'Deux.'])
    expect(textsOf(splitPassageIntoLines(after))).toEqual(['Trois.'])
  })
})
