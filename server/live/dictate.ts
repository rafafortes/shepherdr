// Talk to type, on the machine that has the microphone's audio: this machine. The recording (whatever the phone's
// browser made of it) becomes a 16 kHz mono wav with ffmpeg, and whisper.cpp writes it down. Nothing is kept: both
// files live in a temporary folder that goes as the words come back.
//
// It takes a multilingual model (ggml-base.bin, not a .en one), so the same setting writes down Portuguese and
// English: whisper is told the language from Settings, or works it out itself (auto).
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { cpus, homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DICTATE_CAP, DICTATE_TOO_LONG, type DictateWays } from '../../shared/dictate.ts'
import { excerpt } from '../../shared/excerpt.ts'

/** where the model lives unless Settings says elsewhere: the human's own share folder, outside the repository */
export const MODEL_DIR = join(homedir(), '.local', 'share', 'shepherdr-whisper')
export const MODEL = join(MODEL_DIR, 'ggml-base.bin')
export const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'

/** whisper.cpp's command, by the names it ships as on PATH, then where the Ubuntu archive and Homebrew put it */
const NAMES = ['whisper-cli', 'whisper-cpp-cpu']
const PLACES = ['/usr/bin/whisper-cli', '/usr/local/bin/whisper-cli', join(homedir(), '.local', 'bin', 'whisper-cli'), '/opt/homebrew/bin/whisper-cli']

/** whisper.cpp's command here, or null */
export function whisperBinary(which = (n: string) => Bun.which(n)): string | null {
  for (const n of NAMES) {
    const p = which(n)
    if (p) return p
  }
  return PLACES.find((p) => existsSync(p)) ?? null
}

/** `~/…` as the human's home, as Settings writes paths */
export const homePath = (p: string) => p.trim().replace(/^~(?=\/|$)/, homedir())

/** the languages Settings may name, by their whisper code; anything else is taken as a code already */
const LANGS: Record<string, string> = {
  auto: 'auto',
  'detect it': 'auto',
  english: 'en',
  portuguese: 'pt',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  dutch: 'nl',
}

/** the language flag whisper is given: its own guess (auto) unless Settings pick one */
export function langOf(v: string): string {
  const w = v.trim().toLowerCase()
  return LANGS[w] ?? (w || 'auto')
}

/** whisper's own noise in brackets ((music), [BLANK_AUDIO]) is dropped; one line of words is what comes back */
const NOISE = /\b(music|laughter|applause|silence|inaudible|blank_audio)\b/i

export function clean(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/\[[^\]]*\]/g, ' ')
        // a spoken parenthesis ("the budget (2024)") stays: only whisper's own noise words go
        .replace(/\(([^)]*)\)/g, (whole, inside: string) => (NOISE.test(inside) ? ' ' : whole)),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const run = (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => ({ out, err, code }))
}

/** the recording as 16 kHz mono wav, as whisper.cpp wants it */
export async function toWav(audio: Blob, into: string, ffmpeg: string): Promise<void> {
  await Bun.write(join(into, 'audio'), audio)
  const r = await run([ffmpeg, '-loglevel', 'error', '-nostdin', '-y', '-i', join(into, 'audio'), '-ar', '16000', '-ac', '1', join(into, 'audio.wav')])
  if (r.code !== 0) throw new Error(`That recording couldn't be read${why(r.err)}.`)
}

/** the last line of what a command said, for a message the screen shows */
const why = (err: string) => {
  const last = err.trim().split('\n').filter(Boolean).pop()
  return last ? ` (${excerpt(last, 160)})` : ''
}

/** what a recording says, written down here; throws with words for the screen when it can't be */
export async function transcribe(audio: Blob, ways: DictateWays): Promise<string> {
  if (audio.size > DICTATE_CAP) throw new Error(DICTATE_TOO_LONG)
  const ffmpeg = Bun.which('ffmpeg')
  if (!ffmpeg) throw new Error('Talk to type needs ffmpeg on this machine: sudo apt install ffmpeg.')
  const dir = mkdtempSync(join(tmpdir(), 'shepherdr-dictate-'))
  try {
    await toWav(audio, dir, ffmpeg)
    const threads = Math.min(8, cpus().length)
    const r = await run([ways.binary, '-m', ways.model, '-f', join(dir, 'audio.wav'), '-l', ways.lang, '-nt', '-np', '-t', String(threads)])
    if (r.code !== 0) throw new Error(`whisper.cpp couldn't write it down${why(r.err)}.`)
    return clean(r.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** words from a recording, with whisper.cpp as this machine has it: the model Settings name, the language Settings
 *  say. Why it can't is said in words the screen can show as they are. */
export async function dictate(audio: Blob, model: string, language: string, binary = whisperBinary()): Promise<string> {
  if (!binary)
    throw new Error('Talk to type needs whisper.cpp on the machine that serves Shepherdr: run `sudo apt install whisper.cpp` there (its command is whisper-cli).')
  const file = homePath(model)
  if (!existsSync(file))
    throw new Error(`Talk to type needs its model file, and ${file} isn't there: download ${MODEL_URL} into ${MODEL_DIR} (Settings → Dictation → Model).`)
  return transcribe(audio, { binary, model: file, lang: langOf(language) })
}
