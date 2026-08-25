import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { createRootRenderer, type ReactRootLike } from './root-renderer'

interface Recorded {
  containers: Element[]
  rendered: ReactNode[]
}

function fakeCreateRoot(recorded: Recorded): (container: Element) => ReactRootLike {
  return (container) => {
    recorded.containers.push(container)
    return {
      render(children: ReactNode) {
        recorded.rendered.push(children)
      },
    }
  }
}

describe('createRootRenderer', () => {
  it('constructs exactly one root across repeated renders and renders each time in order', () => {
    const recorded: Recorded = { containers: [], rendered: [] }
    const container = { nodeName: 'DIV' } as unknown as Element
    const render = createRootRenderer(container, fakeCreateRoot(recorded))

    render('first')
    render('second')

    expect(recorded.containers).toHaveLength(1)
    expect(recorded.containers[0]).toBe(container)
    expect(recorded.rendered).toEqual(['first', 'second'])
  })

  it('does not construct the root until the first render', () => {
    const recorded: Recorded = { containers: [], rendered: [] }
    const container = { nodeName: 'DIV' } as unknown as Element

    createRootRenderer(container, fakeCreateRoot(recorded))

    expect(recorded.containers).toHaveLength(0)
  })
})
