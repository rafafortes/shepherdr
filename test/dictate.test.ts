// Talk to type: the recording is turned into a 16 kHz mono wav with ffmpeg and written down with whisper.cpp, nothing
// kept, and a machine without whisper (or its model) says so in words. The audio and whisper are played by the test,
// as a real model is not installed everywhere; the route is the app's own.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApp } from '../server/app.ts'
import { Emitter, type Source, type SourceEvents } from '../server/source.ts'
import { clean, dictate, langOf, MODEL_DIR, MODEL_URL, transcribe, whisperBinary } from '../server/live/dictate.ts'
import { refuse } from '../server/live/settings.ts'
import { DICTATE_CAP, DICTATE_TOO_LONG } from '../shared/dictate.ts'

/** a command of the test's own, standing where ffmpeg or whisper-cli would */
function command(dir: string, name: string, body: string) {
  const f = join(dir, name)
  writeFileSync(f, `#!/bin/bash\n${body}\n`)
  chmodSync(f, 0o755)
  return f
}

const dir = mkdtempSync(join(tmpdir(), 'shepherdr-dictate-test-'))
const model = join(dir, 'ggml-base.bin')
writeFileSync(model, 'not really a model')
/** ffmpeg, played by the test: it says what it was given, and makes the wav it is told to make */
const ffmpeg = command(dir, 'ffmpeg', 'printf "%s\\n" "$@" > "$(dirname "$0")/ffmpeg.args"\n: > "${@: -1}"')
/** ffmpeg on a recording it cannot read */
const brokenFfmpeg = command(dir, 'ffmpeg-broken', 'echo "Invalid data found when processing input" >&2\nexit 1')
const said = command(dir, 'whisper-cli', `printf '\\n [BLANK_AUDIO] hello from a test (music)\\n a second line\\n'`)
const broken = command(dir, 'whisper-broken', 'echo "error: failed to load model from file" >&2\nexit 1')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** a recording of nothing in particular: what a phone's MediaRecorder sends is opus, but the fake ffmpeg takes any */
const recording = () => new Blob([new Uint8Array(2048)], { type: 'audio/webm' })

/** the temporary folders its writing down leaves behind: none may stay */
const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith('shepherdr-dictate-'))

describe('the words whisper writes down', () => {
  test("whisper's own noise goes, its words stay on one line", () => {
    expect(clean('\n [BLANK_AUDIO] hello from a test (music)\n a second line\n')).toBe('hello from a test a second line')
    expect(clean('[MÚSICA]')).toBe('')
    // a spoken parenthesis is a word, not noise
    expect(clean('The budget (2024) went up.')).toBe('The budget (2024) went up.')
  })

  test('the language is what Settings say, or whisper guesses it', () => {
    expect(langOf('Detect it')).toBe('auto')
    expect(langOf('auto')).toBe('auto')
    expect(langOf('Portuguese')).toBe('pt')
    expect(langOf('English')).toBe('en')
    // a code Settings does not offer still goes through as it is
    expect(langOf('es')).toBe('es')
  })

  test('Settings take a language code it does not offer, and refuse nonsense', () => {
    expect(refuse('dictate.language', 'es')).toBeUndefined()
    expect(refuse('dictate.language', 'Portuguese')).toBeUndefined()
    expect(refuse('dictate.language', 'Klingon')).toContain('whisper code')
  })
})

describe('a recording becomes words', () => {
  test('ffmpeg makes 16 kHz mono of it and whisper writes it down, and nothing is kept', async () => {
    const before = leftovers()
    const text = await transcribe(recording(), { binary: said, model, lang: 'auto', ffmpeg })
    expect(text).toBe('hello from a test a second line')
    const args = readFileSync(join(dir, 'ffmpeg.args'), 'utf8').trim().split('\n')
    // the rate and channels whisper.cpp needs, and the wav it reads next
    expect(args[args.indexOf('-ar') + 1]).toBe('16000')
    expect(args[args.indexOf('-ac') + 1]).toBe('1')
    expect(args[args.length - 1]).toEndWith('.wav')
    expect(leftovers()).toEqual(before)
  })

  test('a recording too long for the cap never reaches a command', async () => {
    const big = { size: DICTATE_CAP + 1 } as unknown as Blob
    await expect(transcribe(big, { binary: said, model, lang: 'auto', ffmpeg })).rejects.toThrow(DICTATE_TOO_LONG)
  })

  test('a recording ffmpeg cannot read says so, and keeps nothing', async () => {
    const before = leftovers()
    await expect(transcribe(recording(), { binary: said, model, lang: 'auto', ffmpeg: brokenFfmpeg })).rejects.toThrow(/couldn't be read \(Invalid data/)
    expect(leftovers()).toEqual(before)
  })

  test('whisper failing says so, in its own words', async () => {
    await expect(transcribe(recording(), { binary: broken, model, lang: 'auto', ffmpeg })).rejects.toThrow(/couldn't write it down \(error: failed to load model/)
  })

  test('one recording is written down at a time, so a phone cannot put this host on its knees', async () => {
    const slow = command(dir, 'whisper-slow', 'sleep 1\nprintf " slow words\\n"')
    const ways = { binary: slow, model, lang: 'auto', ffmpeg }
    const both = await Promise.allSettled([transcribe(recording(), ways), transcribe(recording(), ways)])
    expect(both.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const failed = both.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(failed.reason)).toContain('Another recording is being written down')
  }, 20_000)

  test('a screen that goes away stops the writing down and frees the slot', async () => {
    // a real whisper-cli has no children of its own: this one replaces its shell with the sleep, so a kill ends it
    const slow = command(dir, 'whisper-slow2', 'exec sleep 10')
    const gone = new AbortController()
    const p = transcribe(recording(), { binary: slow, model, lang: 'auto', ffmpeg }, gone.signal)
    setTimeout(() => gone.abort(), 150)
    await expect(p).rejects.toThrow(/dropped before it was written down/)
    // nothing holds the machine now
    await expect(transcribe(recording(), { binary: said, model, lang: 'auto', ffmpeg })).resolves.toBe('hello from a test a second line')
  }, 20_000)

  test('a machine without whisper.cpp, or without the model, says what to do about it', async () => {
    await expect(dictate(recording(), model, 'auto', { binary: null })).rejects.toThrow(/sudo apt install whisper\.cpp/)
    const missing = join(dir, 'no-such-model.bin')
    const why = await dictate(recording(), missing, 'auto', { binary: said }).catch((e: Error) => e.message)
    expect(why).toContain(missing)
    expect(why).toContain(MODEL_URL)
    expect(why).toContain(MODEL_DIR)
  })

  test('whisper.cpp is found by the name the Ubuntu archive gives it', () => {
    expect(whisperBinary((n) => (n === 'whisper-cli' ? '/usr/local/bin/whisper-cli' : null))).toBe('/usr/local/bin/whisper-cli')
    // a PATH without it falls back to where it is usually installed, and whatever is found is a file
    for (const found of [whisperBinary(() => null), whisperBinary()]) if (found) expect(existsSync(found)).toBe(true)
  })
})

/** the least a source can be for this route: the rest of the app is the app's own tests' business */
class Plain extends Emitter<SourceEvents> {
  kind = 'demo' as const
  snapshot() {
    return { name: 'x', host: 'h', places: [], tasks: [], automations: {}, artifacts: [], asks: {}, settings: [], user: 'u' }
  }
  chat() {
    return undefined
  }
  async act() {
    return {}
  }
  async artifact() {
    return undefined
  }
  async artifactThumb() {
    return null
  }
  watch() {}
  async upload() {
    return ''
  }
  async attachment() {
    return null
  }
}

/** the real one, without whisper: the recording arrives whole, and its words go back */
class Tells extends Plain {
  heard: Blob | null = null
  async dictate(audio: Blob) {
    this.heard = audio
    if (audio.type === 'audio/refused') throw new Error('Talk to type needs whisper.cpp on the machine that serves Shepherdr.')
    return 'the words from the recording'
  }
}

describe('the route the screen posts its recording to', () => {
  const source = new Tells()
  let server: ReturnType<typeof startApp>
  const url = (s = server) => `http://127.0.0.1:${s.port}/api/dictate`
  const post = (s: ReturnType<typeof startApp>, headers: Record<string, string>, body: Blob = new Blob([new Uint8Array([1, 2, 3])])) =>
    fetch(url(s), { method: 'POST', headers: { 'x-shepherdr': '1', ...headers }, body })
  beforeAll(() => {
    server = startApp({ source: source as unknown as Source, dist: '/nonexistent', port: 0 })
  })
  afterAll(() => server.stop(true))

  test('the recording goes up as it is, and its words come back', async () => {
    const r = await post(server, { 'content-type': 'audio/webm' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ text: 'the words from the recording' })
    expect(source.heard?.size).toBe(3)
  })

  test('a machine that cannot write it down answers with the words the chat shows', async () => {
    const r = await post(server, { 'content-type': 'audio/refused' })
    expect(r.status).toBe(422)
    expect(await r.json()).toEqual({ error: 'Talk to type needs whisper.cpp on the machine that serves Shepherdr.' })
  })

  test('another website cannot post a recording', async () => {
    expect((await post(server, { 'content-type': 'audio/webm', origin: 'https://evil.example' })).status).toBe(403)
  })

  test('a recording over the cap is refused', async () => {
    const big = new Blob([new Uint8Array(DICTATE_CAP + 1)])
    const r = await post(server, { 'content-type': 'audio/webm' }, big)
    expect(r.status).toBe(413)
    expect(((await r.json()) as { error: string }).error).toBe(DICTATE_TOO_LONG)
  })

  test('a server without dictation says so instead of failing', async () => {
    const plain = startApp({ source: new Plain() as unknown as Source, dist: '/nonexistent', port: 0 })
    try {
      const r = await post(plain, { 'content-type': 'audio/webm' })
      expect(r.status).toBe(404)
      expect(((await r.json()) as { error: string }).error).toContain('does not write dictation down')
    } finally {
      plain.stop(true)
    }
  })
})
