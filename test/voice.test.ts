// A voice call and talk to type, as a phone and a computer draw them: the chat box itself turns into the call or the
// recorder, with no bar above it. Built, served and opened in a real browser with a pretend microphone, a pretend voice
// agent and a pretend machine that writes recordings down. Skipped where no browser is installed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, BrowserContextOptions, Page } from 'playwright-core'
import { startApp } from '../server/app.ts'
import { DemoWorld } from '../server/demo/world.ts'
import type { Source } from '../server/source.ts'
import { launch } from './chromium.ts'
import { builtScreen } from './web.ts'

const browser: Browser | null = await launch()
let server: ReturnType<typeof startApp> | null = null

beforeAll(async () => {
  if (!browser) return
  server = startApp({ source: new DemoWorld() as unknown as Source, dist: await builtScreen(), port: 0 })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})

/** the voice agent's socket and the browser's speech recognition, played by the test */
function pretend() {
  const Native = WebSocket
  const w = window as unknown as Record<string, unknown>
  class Call {
    static OPEN = 1
    readyState = 1
    binaryType = 'arraybuffer'
    onmessage: ((e: { data: unknown }) => void) | null = null
    send(d: unknown) {
      if (!(d instanceof ArrayBuffer)) return
      // how loud each piece of your voice is that goes to the voice agent
      let peak = 0
      for (const x of new Int16Array(d)) peak = Math.max(peak, Math.abs(x))
      ;(w.sent as number[]).push(peak)
    }
    close() {}
  }
  w.sent = []
  // the order the microphone and the audio start in
  w.order = []
  const md = navigator.mediaDevices
  const ask = md.getUserMedia.bind(md)
  // the microphone stays closed until the test opens it: a Done pressed the instant it opens is its own case below
  w.held = null
  w.openMic = null
  w.holdMic = () => {
    w.held = new Promise<void>((open) => (w.openMic = open))
  }
  md.getUserMedia = async (c) => {
    const held = w.held as Promise<void> | null
    if (held) await held
    const s = await ask(c)
    ;(w.order as string[]).push('mic')
    return s
  }
  const Audio = AudioContext
  w.AudioContext = class extends Audio {
    constructor(o?: AudioContextOptions) {
      super(o)
      ;(w.order as string[]).push('audio')
    }
  }
  w.WebSocket = new Proxy(Native, {
    construct(T, args) {
      if (!String(args[0]).includes('/api/voice')) return new T(...(args as [string]))
      const c = new Call()
      w.call = c
      return c
    },
  })
  w.say = (state: string) => (w.call as Call).onmessage?.({ data: JSON.stringify({ type: 'state', state }) })
  // the agent speaks: two seconds of a tone
  w.speak = () => {
    const pcm = new Int16Array(32000)
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 8) * 12000
    ;(w.call as Call).onmessage?.({ data: pcm.buffer })
  }
}

const url = () => `http://127.0.0.1:${server!.port}/?place=vm-str/home`
const box = '[data-composer]'

/** what the machine that serves Shepherdr answers when the recording goes up: its words, or why it has none */
type Answer = { text?: string; error?: string }

async function open(opts: BrowserContextOptions, answer: Answer = { text: 'the rest of it' }) {
  const ctx = await browser!.newContext({ permissions: ['microphone'], ...opts })
  await ctx.addInitScript(pretend)
  /** how many recordings went up to be written down: one with no audio at all must never be one of them */
  let uploads = 0
  // whisper takes a moment: the box says what it is doing meanwhile
  await ctx.route('**/api/dictate', async (route) => {
    uploads += 1
    await new Promise((r) => setTimeout(r, 150))
    const body = JSON.stringify(answer.error ? { error: answer.error } : { text: answer.text ?? '' })
    await route.fulfill({ status: answer.error ? 422 : 200, contentType: 'application/json', body })
  })
  const page = await ctx.newPage()
  await page.goto(url())
  await page.waitForSelector(`${box} textarea`)
  return { ctx, page, answer, uploads: () => uploads }
}

/** everything the composer shows above its box */
const above = (page: Page) => page.$eval(box, (b) => b.previousElementSibling?.textContent ?? '')

/** the recorder's first piece of audio comes a second in (its timeslice), as it does for someone speaking: a Done
 *  pressed the instant the microphone opens has nothing to send, which is its own case below */
const aMomentOfSpeech = (page: Page) => page.waitForTimeout(1500)

describe.skipIf(!browser)('a voice call lives in the chat box', () => {
  test('the box turns into the call: no typing, the wave, what it is doing, a timer, Mute and End', async () => {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const pill = (await page.$eval(box, (b) => b.getBoundingClientRect().height)) as number
    await page.tap('button[aria-label="Voice call"]')
    await page.waitForSelector(`${box} button[aria-label="End call"]`)
    expect(await page.$(`${box} textarea`)).toBeNull()
    expect(await page.$(`${box} canvas[aria-label^="Voice call with"]`)).not.toBeNull()
    expect(await page.textContent(`${box} [role=status]`)).toBe('Connecting')
    // no bar above the box any more
    expect(await above(page)).not.toContain('Voice agent')
    // the box keeps its one-line height and round ends
    expect(Math.abs((await page.$eval(box, (b) => b.getBoundingClientRect().height)) - pill)).toBeLessThan(1)
    await page.evaluate(() => (window as unknown as { say(s: string): void }).say('listening'))
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'Listening', `${box} [role=status]`)
    await page.evaluate(() => (window as unknown as { say(s: string): void }).say('thinking'))
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'Thinking', `${box} [role=status]`)
    await page.evaluate(() => (window as unknown as { speak(): void }).speak())
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'Speaking', `${box} [role=status]`)
    expect(await page.textContent(`${box} p`)).toMatch(/\d:\d\d$/)
    // mute shows on the button and in the state once the agent is done
    await page.tap(`${box} button[aria-label="Mute"]`)
    expect(await page.getAttribute(`${box} button[aria-label="Unmute"]`, 'aria-pressed')).toBe('true')
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'Muted', `${box} [role=status]`, { timeout: 5000 })
    await page.tap(`${box} button[aria-label="End call"]`)
    await page.waitForSelector(`${box} textarea`)
    await ctx.close()
  }, 30_000)

  test('your voice reaches the voice agent: the microphone starts before the audio, and Mute stops it', async () => {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const sent = () => page.evaluate(() => (window as unknown as { sent: number[] }).sent)
    await page.tap('button[aria-label="Voice call"]')
    // the pretend microphone beeps: some of what is sent is loud, not silence
    await page.waitForFunction(() => (window as unknown as { sent: number[] }).sent.some((p) => p > 1000), null, { timeout: 5000 })
    // an iPhone sends silence when the audio starts before the microphone
    expect(await page.evaluate(() => (window as unknown as { order: string[] }).order)).toEqual(['mic', 'audio'])
    await page.tap(`${box} button[aria-label="Mute"]`)
    await page.waitForTimeout(150)
    const muted = (await sent()).length
    await page.waitForTimeout(600)
    expect((await sent()).length).toBe(muted)
    await page.tap(`${box} button[aria-label="Unmute"]`)
    await page.waitForFunction((n) => (window as unknown as { sent: number[] }).sent.length > n, muted, { timeout: 5000 })
    await ctx.close()
  }, 30_000)

  test('Mute looks like a mute: a struck-through mic and Muted while muted, not the talk to type mic', async () => {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const talk = await page.$eval(`${box} button[aria-label="Talk to type"]`, (b) => [b.innerHTML, getComputedStyle(b).backgroundColor])
    await page.tap('button[aria-label="Voice call"]')
    const mute = `${box} button[aria-label="Mute"]`
    await page.waitForSelector(mute)
    expect(await page.getAttribute(mute, 'aria-pressed')).toBe('false')
    // filled, unlike the bare talk to type mic
    expect(await page.$eval(mute, (b) => getComputedStyle(b).backgroundColor)).not.toBe(talk[1])
    await page.evaluate(() => (window as unknown as { say(s: string): void }).say('listening'))
    await page.tap(mute)
    const unmute = `${box} button[aria-label="Unmute"]`
    expect(await page.getAttribute(unmute, 'aria-pressed')).toBe('true')
    expect(await page.$eval(unmute, (b) => b.innerHTML)).not.toBe(talk[0])
    expect(await page.textContent(`${box} [role=status]`)).toBe('Muted')
    // still Muted while the agent thinks: a muted call never says it is listening
    await page.evaluate(() => (window as unknown as { say(s: string): void }).say('thinking'))
    await page.waitForTimeout(300)
    expect(await page.textContent(`${box} [role=status]`)).toBe('Muted')
    await ctx.close()
  }, 30_000)

  test('on a computer V calls, M mutes, T does nothing, V again ends', async () => {
    const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } })
    await page.keyboard.press('v')
    await page.waitForSelector(`${box} button[aria-label="End call"]`)
    await page.keyboard.press('m')
    await page.waitForSelector(`${box} button[aria-label="Unmute"][aria-pressed=true]`)
    // T on a call doesn't start talk to type: the call keeps the box
    await page.keyboard.press('t')
    await page.waitForTimeout(200)
    expect(await page.$(`${box} button[aria-label=Cancel]`)).toBeNull()
    expect(await page.$(`${box} button[aria-label="End call"]`)).not.toBeNull()
    await page.keyboard.press('v')
    await page.waitForSelector(`${box} textarea`)
    await ctx.close()
  }, 30_000)
})

describe.skipIf(!browser)('talk to type records in the chat box', () => {
  test('recording shows Cancel, the time, the wave and Done; Done puts the words in the box to edit', async () => {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await page.fill(`${box} textarea`, 'Before')
    await page.tap(`${box} button[aria-label="Talk to type"]`)
    await page.waitForSelector(`${box} button[aria-label^="Done"]`)
    expect(await page.$(`${box} textarea`)).toBeNull()
    expect(await page.$(`${box} button[aria-label=Cancel]`)).not.toBeNull()
    expect(await page.$(`${box} canvas[aria-label="Your voice"]`)).not.toBeNull()
    expect(await page.textContent(`${box} p`)).toMatch(/0:0\d$/)
    expect(await above(page)).toBe('')
    await aMomentOfSpeech(page)
    await page.tap(`${box} button[aria-label^="Done"]`)
    // the words are written down on the machine that serves Shepherdr: the box says so while it happens
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'Writing it down', `${box} p [role=status]`)
    await page.waitForSelector(`${box} textarea`)
    expect(await page.inputValue(`${box} textarea`)).toBe('Before the rest of it')
    // Cancel drops what it heard
    await page.tap(`${box} button[aria-label="Talk to type"]`)
    await page.waitForSelector(`${box} button[aria-label=Cancel]`)
    await page.tap(`${box} button[aria-label=Cancel]`)
    await page.waitForSelector(`${box} textarea`)
    expect(await page.inputValue(`${box} textarea`)).toBe('Before the rest of it')
    await ctx.close()
  }, 30_000)

  test('a machine that cannot write it down says why in the chat, and the box keeps what you had typed', async () => {
    const why = 'Talk to type needs whisper.cpp on the machine that serves Shepherdr: run `sudo apt install whisper.cpp` there.'
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { error: why })
    await page.fill(`${box} textarea`, 'Before')
    await page.tap(`${box} button[aria-label="Talk to type"]`)
    await page.waitForSelector(`${box} button[aria-label^="Done"]`)
    await aMomentOfSpeech(page)
    await page.tap(`${box} button[aria-label^="Done"]`)
    await page.waitForSelector('[data-topbar]')
    expect(await page.textContent('[data-topbar]')).toContain(why)
    expect(await page.inputValue(`${box} textarea`)).toBe('Before')
    await page.tap('[data-topbar] button[aria-label="Close"]')
    expect(await page.$('[data-topbar]')).toBeNull()
    await ctx.close()
  }, 30_000)

  test('Done pressed while the microphone is still opening says nothing was heard, and the box comes back to type in', async () => {
    const { ctx, page, uploads } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await page.fill(`${box} textarea`, 'Before')
    // the microphone is held closed, so Done really does come while it is still opening: no audio exists to write down
    await page.evaluate(() => (window as unknown as { holdMic(): void }).holdMic())
    await page.tap(`${box} button[aria-label="Talk to type"]`)
    await page.waitForSelector(`${box} button[aria-label^="Done"]`)
    await page.tap(`${box} button[aria-label^="Done"]`)
    // Done is handled (the button is spent) before the microphone opens: nothing of the recording can be heard
    await page.waitForSelector(`${box} button[aria-label^="Done"][disabled]`)
    await page.evaluate(() => (window as unknown as { openMic(): void }).openMic())
    await page.waitForSelector('[data-topbar]', { timeout: 10_000 })
    expect(await page.textContent('[data-topbar]')).toContain('Nothing was heard in that recording')
    // the box comes back to type in, with the draft it had, and nothing went up to be written down
    await page.waitForSelector(`${box} textarea`, { timeout: 10_000 })
    expect(await page.inputValue(`${box} textarea`)).toBe('Before')
    expect(uploads()).toBe(0)
    // the cursor is back in the box, where it was
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', null, { timeout: 10_000 })
    await ctx.close()
  }, 30_000)

  test('a long draft keeps its height when the box comes back from recording', async () => {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1} of a long draft.`).join(' ')
    const withWords = `${long} the rest of it`
    const height = () => page.$eval(`${box} textarea`, (t) => t.getBoundingClientRect().height)
    // what it looks like once the words are in, before it is recorded: Cancel keeps it, Done comes back to it
    await page.fill(`${box} textarea`, withWords)
    const done = await height()
    expect(done).toBeGreaterThan(150)
    await page.fill(`${box} textarea`, long)
    const tall = await height()
    const steps: [string, string, number][] = [
      ['button[aria-label="Talk to type"]', 'button[aria-label=Cancel]', tall],
      ['button[aria-label="Talk to type"]', 'button[aria-label^="Done"]', done],
    ]
    for (const [start, stop, want] of steps) {
      await page.tap(`${box} ${start}`)
      await page.waitForSelector(`${box} ${stop}`)
      await aMomentOfSpeech(page)
      await page.tap(`${box} ${stop}`)
      await page.waitForSelector(`${box} textarea`)
      await page.waitForTimeout(50)
      expect(Math.abs((await height()) - want)).toBeLessThan(1)
    }
    await ctx.close()
  }, 30_000)

  test('on a computer T records, Enter puts it in with the cursor after it, Esc drops it', async () => {
    const { ctx, page, answer } = await open({ viewport: { width: 1280, height: 800 } })
    answer.text = 'Ship it'
    await page.keyboard.press('t')
    await page.waitForSelector(`${box} button[aria-label^="Done"]`)
    await aMomentOfSpeech(page)
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${box} textarea`)
    expect(await page.inputValue(`${box} textarea`)).toBe('Ship it')
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
    await page.keyboard.press('Escape')
    await page.keyboard.press('t')
    await page.waitForSelector(`${box} button[aria-label=Cancel]`)
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${box} textarea`)
    expect(await page.inputValue(`${box} textarea`)).toBe('Ship it')
    await ctx.close()
  }, 30_000)

  test('the cursor comes back right after the words: at the end, or where you were typing', async () => {
    const caret = (page: Page) =>
      page.$eval(`${box} textarea`, (t) => [document.activeElement === t, (t as HTMLTextAreaElement).selectionStart, (t as HTMLTextAreaElement).selectionEnd])
    for (const opts of [{ viewport: { width: 1280, height: 800 } }, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]) {
      const { ctx, page, answer } = await open(opts)
      const talk = async (said: string) => {
        answer.text = said
        await page.click(`${box} button[aria-label="Talk to type"]`)
        await page.waitForSelector(`${box} button[aria-label^="Done"]`)
        await aMomentOfSpeech(page)
        await page.click(`${box} button[aria-label^="Done"]`)
        await page.waitForSelector(`${box} textarea`)
        await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
      }
      await page.fill(`${box} textarea`, 'Hello world')
      await talk('there')
      expect(await page.inputValue(`${box} textarea`)).toBe('Hello world there')
      expect(await caret(page)).toEqual([true, 17, 17])
      // in the middle: the words go where the cursor was, with a space either side, and the cursor right after them
      await page.$eval(`${box} textarea`, (t) => (t as HTMLTextAreaElement).setSelectionRange(5, 5))
      await talk('big')
      expect(await page.inputValue(`${box} textarea`)).toBe('Hello big world there')
      expect(await caret(page)).toEqual([true, 9, 9])
      // what you had selected gives way to them
      await page.$eval(`${box} textarea`, (t) => (t as HTMLTextAreaElement).setSelectionRange(6, 9))
      await talk('small')
      expect(await page.inputValue(`${box} textarea`)).toBe('Hello small world there')
      expect(await caret(page)).toEqual([true, 11, 11])
      // a long draft scrolls to show the cursor at its end
      await page.fill(`${box} textarea`, Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1} of a long draft.`).join(' '))
      await page.$eval(`${box} textarea`, (t) => (t as HTMLTextAreaElement).setSelectionRange(0, 0))
      await page.$eval(`${box} textarea`, (t) => (t.scrollTop = 0))
      await page.$eval(`${box} textarea`, (t) => (t as HTMLTextAreaElement).blur())
      await talk('The end')
      expect(await page.inputValue(`${box} textarea`)).toEndWith('long draft. The end')
      await page.waitForFunction((sel) => {
        const t = document.querySelector(sel) as HTMLTextAreaElement
        return t.scrollTop + t.clientHeight >= t.scrollHeight - 1
      }, `${box} textarea`)
      await ctx.close()
    }
  }, 30_000)

  test('with reduced motion the red dot holds still', async () => {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
    await page.click(`${box} button[aria-label="Talk to type"]`)
    await page.waitForSelector(`${box} button[aria-label=Cancel]`)
    expect(await page.$eval(`${box} p > span[aria-hidden]`, (d) => getComputedStyle(d).animationName)).toBe('none')
    await ctx.close()
  }, 30_000)
})
