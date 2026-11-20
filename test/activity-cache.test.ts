// The activity sheet cached one answer per turn, output and job ever opened, and polled a live one on an interval
// (PERFC-06). The cache is now capped and a chat's answers go when its sheet closes, while a row still on screen asks
// again. A stub browser and a stub fetch stand in for the tab and the server; the cache is the real one in the plugin.
import { expect, mock, test } from 'bun:test'

const noop = () => {}
const storage = { getItem: () => null, setItem: noop, removeItem: noop }
Object.assign(globalThis, {
  location: { search: '', href: 'http://localhost/', pathname: '/', reload: noop },
  localStorage: storage,
  sessionStorage: storage,
  innerWidth: 1280,
  history: { state: null, replaceState: noop, pushState: noop },
  document: { head: { innerHTML: '' }, activeElement: null, visibilityState: 'visible', addEventListener: noop, removeEventListener: noop, querySelector: () => null },
  addEventListener: noop,
  dispatchEvent: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  WebSocket: class {
    readyState = 0
    send = noop
    close = noop
  },
  navigator: { userAgent: 'node' },
})

const activity = await import('../plugins/chat/activity.tsx')

/** answer every ask with an empty turn, so the cache fills through the same fetch path the screen uses */
const withFetch = async (body: object, run: () => Promise<void>) => {
  const real = globalThis.fetch
  globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = real
  }
}

test('closing a chat from its sheet forgets only that chat’s answers', async () => {
  await withFetch({ steps: [] }, async () => {
    await activity.ask('p:m:a', 'turn', 't1')
    await activity.ask('p:m:a', 'output', 'o1')
    await activity.ask('p:m:b', 'turn', 't2')
    expect(activity.activityHas('p:m:a|turn|t1')).toBe(true)
    expect(activity.activityHas('p:m:a|output|o1')).toBe(true)
    expect(activity.activityHas('p:m:b|turn|t2')).toBe(true)

    activity.openJobs({ chat: 'p:m:a' })
    activity.openJobs(null)

    expect(activity.activityHas('p:m:a|turn|t1')).toBe(false)
    expect(activity.activityHas('p:m:a|output|o1')).toBe(false)
    expect(activity.activityHas('p:m:b|turn|t2')).toBe(true)
  })
})

test('the answer cache never holds more than the cap, dropping the oldest first', async () => {
  await withFetch({ steps: [] }, async () => {
    for (let i = 0; i <= activity.GOT_CAP; i++) await activity.ask('p:m:c', 'turn', `t${i}`)
    // cap+1 questions went out, but only cap answers are kept, and the very first one was the one dropped
    expect(activity.activityCacheSize()).toBe(activity.GOT_CAP)
    expect(activity.activityHas('p:m:c|turn|t0')).toBe(false)
    expect(activity.activityHas(`p:m:c|turn|t${activity.GOT_CAP}`)).toBe(true)
  })
})
