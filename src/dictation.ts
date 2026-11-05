// Talk to type: the microphone is recorded where it is, and a meter on it draws the wave. On Done the recording goes to
// the machine that serves Shepherdr, which writes it down with whisper.cpp and sends the words back into the box to
// edit; Cancel drops it. Nothing is written down in the browser, so a phone writes down as well as a computer does.
//
// It is the browser's own recording (MediaRecorder), not the browser's speech recognition: that one types nothing at
// all on Android Chrome, and nothing can be asked of it beforehand to know whether it works. A recording needs no such
// guess, and a server that can't write it down says why in the screen, in words.
import { levelOf, meter, TALKING, type Sample } from './meter.ts'

export interface Dictation {
  /** stop recording; the words still being written down come in, then the end callback gets them */
  finish(): void
  /** stop recording and drop what was said */
  cancel(): void
}

let current: Dictation | null = null
let level: AnalyserNode | null = null

/** whether this browser can record and send a voice at all: a microphone it may use, and MediaRecorder */
export function canDictate() {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

/** for the wave: how loud you are right now */
export function dictSample(): Sample {
  const l = levelOf(level)
  return { level: l, who: l > TALKING ? 'you' : null }
}

/** what the recording is sent as, the best this browser makes (Android Chrome: webm with opus) */
function recordType() {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type
    } catch {
      /* not every browser answers */
    }
  }
  return ''
}

/** Starts recording. `end` gets what was said when it finishes, or null when cancelled or when nothing was heard, with
 *  why in `failure` when it couldn't be written down. */
export function dictate(end: (text: string | null, failure?: string) => void): Dictation {
  current?.cancel()
  let state: 'on' | 'finishing' | 'over' = 'on'
  let mic: MediaStream | null = null
  let ctx: AudioContext | null = null
  let rec: MediaRecorder | null = null
  let type = ''
  const chunks: Blob[] = []
  const close = (text: string | null, failure?: string) => {
    if (state === 'over') return
    state = 'over'
    mic?.getTracks().forEach((t) => t.stop())
    ctx?.close().catch(() => undefined)
    level = null
    if (current === self) current = null
    end(text, failure)
  }
  /** the recording, sent to the machine that serves Shepherdr: the words come back, or why there are none */
  const writeDown = async () => {
    const audio = new Blob(chunks, { type: type || 'audio/webm' })
    let said: { text?: string; error?: string } | null = null
    try {
      const r = await fetch('api/dictate', { method: 'POST', headers: { 'x-shepherdr': '1', 'content-type': audio.type }, body: audio })
      said = (await r.json()) as { text?: string; error?: string }
    } catch {
      return close(null, "Couldn't reach Shepherdr to write it down.")
    }
    if (said?.error) return close(null, said.error)
    const text = (said?.text ?? '').trim()
    if (!text) return close(null, 'Nothing was heard in that recording. Try again, closer to the microphone.')
    close(text)
  }
  /** stop the recorder; what is left of it is written down once the recorder says it stopped */
  const send = () => {
    if (!rec || rec.state === 'inactive') return close('')
    rec.onstop = () => void writeDown()
    rec.stop()
  }
  const self: Dictation = {
    finish() {
      if (state !== 'on') return
      state = 'finishing'
      // the microphone may still be opening: the recorder sends as soon as it is there, so a Done pressed at once is
      // still written down instead of dropped
      if (rec) send()
    },
    cancel() {
      if (state === 'over') return
      if (rec && rec.state !== 'inactive') {
        rec.onstop = null
        rec.stop()
      }
      close(null)
    },
  }
  current = self
  navigator.mediaDevices
    ?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then((stream) => {
      if (state === 'over') return stream.getTracks().forEach((t) => t.stop())
      mic = stream
      ctx = new AudioContext()
      level = meter(ctx)
      ctx.createMediaStreamSource(stream).connect(level)
      type = recordType()
      try {
        rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream)
      } catch {
        return close(null, "This browser couldn't record your voice.")
      }
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      rec.start(1000)
      // Done came while the microphone was opening: it records from here and stops at once
      if (state === 'finishing') send()
    })
    .catch(() => close(null, 'The microphone is off for Shepherdr: allow it in the browser to talk to type.'))
  return self
}
