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
const was = process.env.PATH ?? ''
/** the fake ffmpeg first on PATH: what a recording is turned into is the test's own, and it says what it was given */
command(dir, 'ffmpeg', 'printf "%s\\n" "$@" > "$(dirname "$0")/ffmpeg.args"\nif [ -n "$FFMPEG_FAILS" ]; then echo "Invalid data found when processing input" >&2; exit 1; fi\n: > "${@: -1}"')
process.env.PATH = `${dir}:${was}`
const said = command(dir, 'whisper-cli', `printf '\\n [BLANK_AUDIO] hello from a test (music)\\n a second line\\n'`)
const broken = command(dir, 'whisper-broken', 'echo "error: failed to load model from file" >&2\nexit 1')

afterAll(() => {
  process.env.PATH = was
  rmSync(dir, { recursive: true, force: true })
})

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
})

describe('a recording becomes words', () => {
  test('ffmpeg makes 16 kHz mono of it and whisper writes it down, and nothing is kept', async () => {
    const before = leftovers()
    const text = await transcribe(recording(), { binary: said, model, lang: 'auto' })
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
    await expect(transcribe(big, { binary: said, model, lang: 'auto' })).rejects.toThrow(DICTATE_TOO_LONG)
  })

  test('a recording ffmpeg cannot read says so, and keeps nothing', async () => {
    const before = leftovers()
    process.env.FFMPEG_FAILS = '1'
    try {
      await expect(transcribe(recording(), { binary: said, model, lang: 'auto' })).rejects.toThrow(/couldn't be read \(Invalid data/)
    } finally {
      delete process.env.FFMPEG_FAILS
    }
    expect(leftovers()).toEqual(before)
  })

  test('whisper failing says so, in its own words', async () => {
    await expect(transcribe(recording(), { binary: broken, model, lang: 'auto' })).rejects.toThrow(/couldn't write it down \(error: failed to load model/)
  })

  test('a machine without whisper.cpp, or without the model, says what to do about it', async () => {
    await expect(dictate(recording(), model, 'auto', null)).rejects.toThrow(/sudo apt install whisper\.cpp/)
    const missing = join(dir, 'no-such-model.bin')
    const why = await dictate(recording(), missing, 'auto', said).catch((e: Error) => e.message)
    expect(why).toContain(missing)
    expect(why).toContain(MODEL_URL)
    expect(why).toContain(MODEL_DIR)
  })

  test('whisper.cpp is found by the name the Ubuntu archive gives it', () => {
    expect(whisperBinary((n) => (n === 'whisper-cli' ? '/usr/bin/whisper-cli' : null))).toBe('/usr/bin/whisper-cli')
    expect(whisperBinary(() => null)).toBeNull()
    // wherever it is on this machine, it is a file that exists
    const found = whisperBinary()
    if (found) expect(existsSync(found)).toBe(true)
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
