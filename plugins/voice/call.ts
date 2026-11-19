// The call's audio: the microphone streams to the server, which talks with the voice agent (a realtime speech
// service); its spoken replies come back and play here. The call itself is not saved anywhere.
import { levelOf, meter, TALKING, type Sample } from '@client/meter.ts'

let ws: WebSocket | null = null
let mic: MediaStream | null = null
let ctx: AudioContext | null = null
let node: ScriptProcessorNode | null = null
let muted = false
let playAt = 0
/** meters on your microphone and on the agent's voice */
let yours: AnalyserNode | null = null
let theirs: AnalyserNode | null = null
/** what the call is doing, besides the agent speaking (which the playing audio tells) */
let phase: 'connecting' | 'listening' | 'thinking' = 'connecting'
let phaseAt = 0
/** the last spoken lines, for the pill's captions; display-only, never saved */
let captions: { id: number; who: 'agent' | 'you'; text: string }[] = []
let captionSeq = 0

const RATE = 16000

/** The microphone's own rate down to the 16 kHz the speech service takes, piece by piece: each sample out is the mean
 *  of the ones it covers, a plain low-pass (at 48 kHz, two thirds of what is just above 8 kHz still gets through, a
 *  third by 12 kHz and a twelfth by 15 kHz, against all of it folding back before), its place carried from one piece
 *  to the next. */
export function toPcm16(rate: number) {
  const step = rate / RATE
  /** where the next sample out starts among this piece's samples */
  let pos = 0
  /** what a piece left over: shorter than the next block, so it waits for the rest of it */
  let carry = new Float32Array(0)
  return (input: Float32Array): ArrayBuffer => {
    const x = carry.length ? Float32Array.from([...carry, ...input]) : input
    const out = new Int16Array(Math.ceil((x.length - pos) / step) + 1)
    let n = 0
    while (pos + step <= x.length) {
      const a = Math.max(0, Math.floor(pos))
      const b = Math.min(x.length, Math.floor(pos + step))
      let sum = 0
      for (let i = a; i < b; i++) sum += x[i]
      const s = Math.max(-1, Math.min(1, b > a ? sum / (b - a) : (x[a] ?? 0)))
      out[n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      pos += step
    }
    const keep = Math.floor(pos)
    carry = x.slice(keep)
    pos -= keep
    return out.slice(0, n).buffer
  }
}

function play(buf: ArrayBuffer) {
  if (!ctx) return void waiting.push(buf)
  const pcm = new Int16Array(buf)
  const audio = ctx.createBuffer(1, pcm.length, RATE)
  const ch = audio.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000
  const src = ctx.createBufferSource()
  src.buffer = audio
  src.connect(theirs ?? ctx.destination)
  playAt = Math.max(playAt, ctx.currentTime)
  src.start(playAt)
  playAt += audio.duration
  sources.push(src)
  src.onended = () => (sources = sources.filter((x) => x !== src))
}

let sources: AudioBufferSourceNode[] = []
/** the agent's first words, when they come before the microphone is through */
let waiting: ArrayBuffer[] = []

export async function startCall(chatKey: string, onError: (message: string) => void = () => undefined) {
  stopCall()
  const url = new URL(`api/voice?chat=${encodeURIComponent(chatKey)}`, location.href)
  url.protocol = url.protocol.replace('http', 'ws')
  ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      phase = 'listening'
      return play(e.data)
    }
    const m = JSON.parse(String(e.data)) as { type: string; message?: string; state?: typeof phase; who?: 'agent' | 'you'; text?: string }
    if (m.type === 'state' && m.state) {
      phase = m.state
      phaseAt = Date.now()
    }
    // words the service heard and said, for the pill: no history, just the last couple of lines
    if (m.type === 'caption' && m.who && m.text) captions = [...captions, { id: ++captionSeq, who: m.who, text: m.text }].slice(-2)
    // you talked over it: what it was about to say is dropped
    if (m.type === 'interrupt') {
      sources.forEach((s) => s.stop())
      sources = []
      waiting = []
      playAt = 0
      phase = 'listening'
    }
    if (m.type === 'error') onError(m.message ?? 'The voice call could not start.')
  }
  // The microphone first, then the audio: an iPhone sets its sound up for playing only when the audio comes first,
  // and the microphone then sends silence. Its voice waits until the audio is there.
  const call = ws
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch {
    /* no microphone (or no permission): the call shows, nothing is heard */
  }
  // the call ended while the phone asked for the microphone
  if (ws !== call) return stream?.getTracks().forEach((t) => t.stop())
  const c = (ctx = new AudioContext())
  c.resume().catch(() => undefined)
  theirs = meter(c)
  theirs.connect(c.destination)
  if (stream) {
    mic = stream
    const src = c.createMediaStreamSource(stream)
    yours = meter(c)
    src.connect(yours)
    node = c.createScriptProcessor(4096, 1, 1)
    const down = toPcm16(c.sampleRate)
    node.onaudioprocess = (e) => {
      if (muted || ws?.readyState !== WebSocket.OPEN) return
      ws.send(down(e.inputBuffer.getChannelData(0)))
    }
    src.connect(node)
    node.connect(c.destination)
  }
  waiting.splice(0).forEach(play)
}

export function muteCall(on: boolean) {
  muted = on
}

/** what the call is doing now: the agent speaking whenever its voice is still playing */
export function callPhase(): 'connecting' | 'listening' | 'thinking' | 'speaking' {
  if (ctx && playAt > ctx.currentTime + 0.05) return 'speaking'
  // thinking that never led to words goes back to listening
  if (phase === 'thinking' && Date.now() - phaseAt > 20000) return 'listening'
  return phase
}

/** the last lines said on the call, newest last, for the pill's captions */
export function callCaptions(): { id: number; who: 'agent' | 'you'; text: string }[] {
  return captions
}

/** for the wave: whoever is louder right now, the agent first (your mic hears it a little too) */
export function callSample(): Sample {
  const agent = levelOf(theirs)
  const you = muted ? 0 : levelOf(yours)
  if (agent > TALKING && agent >= you * 0.8) return { level: agent, who: 'agent' }
  if (you > TALKING) return { level: you, who: 'you' }
  return { level: Math.max(agent, you), who: null }
}

export function stopCall() {
  node?.disconnect()
  mic?.getTracks().forEach((t) => t.stop())
  ctx?.close().catch(() => undefined)
  ws?.close()
  node = null
  mic = null
  ctx = null
  ws = null
  yours = null
  theirs = null
  sources = []
  waiting = []
  playAt = 0
  muted = false
  phase = 'connecting'
  captions = []
}
