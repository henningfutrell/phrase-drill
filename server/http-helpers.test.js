// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { readBody, PayloadTooLargeError } from './http-helpers.js'

function fakeReq() {
  const req = new EventEmitter()
  req.resume = () => req.emit('resumed')
  return req
}

describe('readBody', () => {
  it('resolves with the concatenated body under the cap', async () => {
    const req = fakeReq()
    const promise = readBody(req, { maxBytes: 100 })
    req.emit('data', Buffer.from('hello '))
    req.emit('data', Buffer.from('world'))
    req.emit('end')
    const body = await promise
    expect(body.toString('utf8')).toBe('hello world')
  })

  it('rejects with PayloadTooLargeError once the cap is exceeded, and drains without destroying the connection', async () => {
    const req = fakeReq()
    let resumed = false
    req.on('resumed', () => (resumed = true))
    const promise = readBody(req, { maxBytes: 5 })
    req.emit('data', Buffer.from('123456'))
    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(resumed).toBe(true)
  })

  it('rejects on a request error', async () => {
    const req = fakeReq()
    const promise = readBody(req, { maxBytes: 100 })
    req.emit('error', new Error('boom'))
    await expect(promise).rejects.toThrow('boom')
  })
})
