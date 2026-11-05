// Talk to type: the microphone is recorded where it is, and a meter on it draws the wave. On Done the recording goes to
// the machine that serves Shepherdr, which writes it down with whisper.cpp and sends the words back into the box to
// edit; Cancel drops it. Nothing is written down in the browser, so a phone writes down as well as a computer does.
//
// It is the browser's own recording (MediaRecorder), not the browser's speech recognition: that one types nothing at
// all on Android Chrome, and nothing can be asked of it beforehand to know whether it works. A recording needs no such
// guess, and a server that can't write it down says why in the screen, in words.
import { levelOf, meter, TALKING, type Sample } from './meter.ts'

/** what the chat says when a recording holds no audio at all, so nothing is written down */
const NOTHING_HEARD = 'Nothing was heard in that recording. Try again, closer to the microphone.'

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
  /** the upload in flight: Cancel abandons it, and Shepherdr stops writing that recording down when its screen goes */
  let sending: AbortController | null = null
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
    // nothing was recorded (Done pressed the instant the microphone opened): no upload of nothing to pay for
    if (!audio.size) return close(null, NOTHING_HEARD)
    let r: Response
    sending = new AbortController()
    try {
      r = await fetch('api/dictate', { method: 'POST', headers: { 'x-shepherdr': '1', 'content-type': audio.type }, body: audio, signal: sending.signal })
    } catch (e) {
      // cancelled on purpose: the screen already went back to its box
      if ((e as Error)?.name === 'AbortError') return close(null)
      return close(null, "Couldn't reach Shepherdr to write it down.")
    } finally {
      sending = null
    }
    // a proxy in front may answer instead of Shepherdr (a body too big for it, a refused sign-in)
    let said: { text?: string; error?: string } = {}
    try {
      said = (await r.json()) as typeof said
    } catch {
      /* not words: what came back is the status below */
    }
    if (said.error) return close(null, said.error)
    if (!r.ok) return close(null, `Shepherdr couldn't write that recording down (${r.status}${r.statusText ? ` ${r.statusText}` : ''}).`)
    const text = (said.text ?? '').trim()
    if (!text) return close(null, NOTHING_HEARD)
    close(text)
  }
  /** stop the recorder; what is left of it is written down once the recorder says it stopped */
  const send = () => {
    // the recorder is gone already (it stopped itself): whatever it did catch is still worth writing down
    if (!rec || rec.state === 'inactive') return chunks.length ? void writeDown() : close(null, NOTHING_HEARD)
    rec.onstop = () => void writeDown()
    rec.stop()
  }
  const self: Dictation = {
    finish() {
      if (state !== 'on') return
      state = 'finishing'
      // the microphone may still be opening: it heard nothing by now, so the box says so as soon as it opens instead
      // of writing a sliver of nothing down
      if (rec) send()
    },
    cancel() {
      if (state === 'over') return
      // whatever the recorder is doing, nothing of this recording is written down: a stop already asked for sends
      // nothing either
      if (rec) {
        rec.onstop = null
        if (rec.state !== 'inactive') rec.stop()
      }
      sending?.abort()
      close(null)
    },
  }
  current = self
  navigator.mediaDevices
    ?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then((stream) => {
      // Done or Cancel came while the microphone was still opening: it heard nothing, so no recorder starts and
      // nothing is written down (Cancel's screen has already gone back to its box, where close does nothing)
      if (state !== 'on') {
        stream.getTracks().forEach((t) => t.stop())
        return close(null, NOTHING_HEARD)
      }
      mic = stream
      // the recorder, not only the microphone: a browser that won't record says so instead of failing silently
      try {
        ctx = new AudioContext()
        level = meter(ctx)
        ctx.createMediaStreamSource(stream).connect(level)
        type = recordType()
        rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
        rec.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data)
        }
        rec.onerror = () => close(null, "This browser's recorder stopped before the end of the recording.")
        rec.start(1000)
      } catch {
        return close(null, "This browser couldn't record your voice.")
      }
    })
    .catch((e: Error) =>
      close(
        null,
        e?.name === 'NotAllowedError'
          ? 'The microphone is off for Shepherdr: allow it in the browser to talk to type.'
          : "This browser couldn't open the microphone.",
      ),
    )
  return self
}
