import { describe, expect, it } from 'vitest'
import {
  createPassage,
  renamePassage,
  setPassageText,
  type Passage,
} from './passage'

const notes: Passage = {
  id: 'pg1',
  name: 'Le Petit Prince',
  text: 'Bonjour. Ça va ?',
}

describe('createPassage', () => {
  it('is a name and a text under a caller-supplied id — the domain has no I/O', () => {
    expect(createPassage('pg1', 'Le Petit Prince', 'Bonjour. Ça va ?')).toEqual(
      notes,
    )
  })

  it('accepts empty text — a Passage the user has named but not yet typed into is still a Passage', () => {
    expect(createPassage('pg2', 'Journal', '')).toEqual({
      id: 'pg2',
      name: 'Journal',
      text: '',
    })
  })
})

describe('renamePassage', () => {
  it('replaces the name, leaving id and text alone', () => {
    expect(renamePassage(notes, 'Le Petit Prince, ch. 1')).toEqual({
      id: 'pg1',
      name: 'Le Petit Prince, ch. 1',
      text: 'Bonjour. Ça va ?',
    })
  })

  it('returns a new object and never mutates the input', () => {
    const renamed = renamePassage(notes, 'Autre')

    expect(renamed).not.toBe(notes)
    expect(notes).toEqual({
      id: 'pg1',
      name: 'Le Petit Prince',
      text: 'Bonjour. Ça va ?',
    })
  })
})

describe('setPassageText', () => {
  it('replaces the text wholesale, leaving id and name alone', () => {
    expect(setPassageText(notes, 'Trois. Quatre.')).toEqual({
      id: 'pg1',
      name: 'Le Petit Prince',
      text: 'Trois. Quatre.',
    })
  })

  it('returns a new object and never mutates the input', () => {
    const rewritten = setPassageText(notes, 'Autre chose.')

    expect(rewritten).not.toBe(notes)
    expect(notes).toEqual({
      id: 'pg1',
      name: 'Le Petit Prince',
      text: 'Bonjour. Ça va ?',
    })
  })
})
