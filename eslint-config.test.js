// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

/**
 * `tsconfig.app.json` pins `lib` to ES2023, and `Promise.withResolvers` is
 * ES2024: `tsc -b` refuses it with TS2550, and the one phone's Safari version
 * is not recorded. The lint rule says so at the call site, with the way out,
 * so nobody has to find the conflict again.
 */
describe('eslint config', () => {
  const eslint = new ESLint({ cwd: import.meta.dirname })

  async function messagesFor(code) {
    const [result] = await eslint.lintText(code, { filePath: 'src/example.ts' })
    return result.messages.map((message) => message.message)
  }

  it('refuses Promise.withResolvers and names the executor form instead', async () => {
    const messages = await messagesFor('export const pending = Promise.withResolvers<void>()\n')
    expect(messages).toEqual([expect.stringContaining('new Promise((resolve, reject) => …)')])
  })

  it('takes the executor form', async () => {
    const messages = await messagesFor('export const pending = new Promise<void>((resolve) => resolve())\n')
    expect(messages).toEqual([])
  })
})
