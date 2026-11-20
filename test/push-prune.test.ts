// Dead push devices: a subscription that keeps failing or has gone quiet is dropped so later alerts stop paying for
// an outside HTTPS request to a service that no longer answers. The DELETE route lets the browser hand back a device
// it has unsubscribed, without subscribing it again.
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Push } from '../server/push.ts'
import { writeJson, readJson } from '../server/store.ts'
import { startApp } from '../server/app.ts'
import type { Source } from '../server/source.ts'
import { DemoWorld } from '../server/demo/world.ts'

const alert = { id: 'fake', from: 'fake', go: { place: '~' }, title: 'Test', body: 'Only fake delivery', tag: 'test' }
const sub = (id: string) => ({ endpoint: `https://push.example/${id}`, keys: { auth: 'a', p256dh: 'b' } })
const response = { statusCode: 201, body: '', headers: {} }
const DAY = 24 * 60 * 60 * 1000
beforeEach(() => writeJson('push.json', []))

test('ten consecutive failures drop a device, with one log line', async () => {
  const log = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const push = new Push(undefined, async () => {
      throw { statusCode: 503 }
    })
    push.subscribe(sub('a'), 'phone')
    for (let i = 0; i < 9; i++) {
      await push.send(alert)
      expect(push.devices).toEqual(['phone'])
    }
    await push.send(alert)
    expect(push.devices).toEqual([])
    expect(readJson<unknown[]>('push.json', [])).toEqual([])
    expect(log.mock.calls.filter((c) => String(c[0]).includes('Dropping push device'))).toHaveLength(1)
  } finally {
    log.mockRestore()
  }
})

test('a success resets the failure count and refreshes the success timestamp', async () => {
  let fail = true
  const push = new Push(undefined, async () => {
    if (fail) throw { statusCode: 503 }
    return response
  })
  push.subscribe(sub('a'), 'phone')
  for (let i = 0; i < 9; i++) await push.send(alert)
  fail = false
  await push.send(alert) // the streak ends here: lastOk is now, fails is 0
  fail = true
  for (let i = 0; i < 9; i++) await push.send(alert)
  expect(push.devices).toEqual(['phone'])
  const saved = readJson<{ fails: number; lastOk: number }[]>('push.json', [])
  expect(saved[0]?.fails).toBe(9)
  expect(saved[0]?.lastOk).toBeGreaterThan(Date.now() - DAY)
})

test('a subscription that never succeeded is dropped after 30 days on the next send', async () => {
  const log = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    writeJson('push.json', [
      { sub: sub('old'), device: 'old phone', at: Date.now() - 31 * DAY },
      { sub: sub('new'), device: 'new phone', at: Date.now() },
    ])
    const push = new Push(undefined, async (s) => {
      if (s.endpoint.endsWith('/old')) throw { statusCode: 503 }
      return response
    })
    expect(push.devices).toEqual(['old phone', 'new phone'])
    await push.send(alert)
    expect(push.devices).toEqual(['new phone'])
    expect(readJson<unknown[]>('push.json', [])).toHaveLength(1)
    expect(log.mock.calls.filter((c) => String(c[0]).includes('no alert succeeded in 30 days'))).toHaveLength(1)
  } finally {
    log.mockRestore()
  }
})

test('a recent success keeps a device past its subscribe date', async () => {
  writeJson('push.json', [{ sub: sub('old'), device: 'phone', at: Date.now() - 40 * DAY, lastOk: Date.now() }])
  const push = new Push(undefined, async () => response)
  await push.send(alert)
  expect(push.devices).toEqual(['phone'])
  expect(readJson<{ lastOk: number }[]>('push.json', [])[0]?.lastOk ?? 0).toBeGreaterThan(Date.now() - DAY)
})

test('dead endpoints stop being called once dropped (request counter)', async () => {
  let calls = 0
  const push = new Push(undefined, async () => {
    calls++
    throw { statusCode: 503 }
  })
  for (const id of ['a', 'b', 'c']) push.subscribe(sub(id), 'phone')
  const perAlert: number[] = []
  for (let i = 0; i < 30; i++) {
    const before = calls
    await push.send(alert)
    perAlert.push(calls - before)
  }
  // without the prune this would be 30 requests to each of three dead endpoints, 90 in all
  expect(perAlert.slice(0, 10)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3, 3])
  expect(perAlert.slice(10)).toEqual(new Array(20).fill(0))
  expect(calls).toBe(30)
})

describe('DELETE /api/push/subscribe', () => {
  const push = new Push(undefined, async () => response)
  const server = startApp({ source: new DemoWorld() as unknown as Source, dist: '/nonexistent', push, port: 0 })
  const at = `http://127.0.0.1:${server.port}`
  afterAll(() => server.stop(true))

  test('removes only the caller endpoint and refuses a write without the header', async () => {
    push.subscribe(sub('a'), 'phone A')
    push.subscribe(sub('b'), 'phone B')
    const del = (endpoint: string, headers: Record<string, string> = {}) =>
      fetch(`${at}/api/push/subscribe`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-shepherdr': '1', ...headers },
        body: JSON.stringify({ endpoint }),
      })
    expect((await del('https://push.example/a')).status).toBe(200)
    expect(push.devices).toEqual(['phone B'])
    expect(readJson<unknown[]>('push.json', [])).toHaveLength(1)
    const refused = await fetch(`${at}/api/push/subscribe`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', origin: at },
      body: JSON.stringify({ endpoint: 'https://push.example/b' }),
    })
    expect(refused.status).toBe(403)
    expect(push.devices).toEqual(['phone B'])
  })
})
