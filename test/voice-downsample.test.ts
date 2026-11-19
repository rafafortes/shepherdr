// The call's microphone, at the device's rate, down to the 16 kHz the speech service takes: each sample out is the
// mean of the ones it covers, so what the voice band cannot hold is left out instead of folding back onto it, and a
// block straddling two pieces of the microphone's audio is still one block.
import { describe, expect, test } from 'bun:test'
import { toPcm16 } from '../plugins/voice/call.ts'

/** the samples of a piece of 16-bit PCM as numbers */
const pcm = (buf: ArrayBuffer) => [...new Int16Array(buf)]

/** a float sample as the 16-bit integer the call sends, truncated as an Int16Array stores it */
const q = (s: number) => (s < 0 ? Math.trunc(s * 0x8000) : Math.trunc(s * 0x7fff))

/** the whole signal's blocks, one mean per block of `step` samples: what a converter that never had to split it gives */
function blocks(x: Float32Array, step: number): number[] {
  const out: number[] = []
  for (let i = 0; i + step <= x.length; i += step) {
    let sum = 0
    for (let j = i; j < i + step; j++) sum += x[j]
    out.push(sum / step)
  }
  return out
}

/** a sine at `hz` for `n` samples of a `rate` device */
function tone(hz: number, rate: number, n: number, amp = 0.8): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
  return x
}

describe('the microphone down to 16 kHz', () => {
  test('a steady signal stays steady, and one second of it is one second at 16 kHz', () => {
    const down = toPcm16(48000)
    const out = pcm(down(new Float32Array(48000).fill(0.5)))
    expect(out.length).toBe(16000)
    for (const v of out) expect(v).toBe(q(0.5))
  })

  test('each sample out is the mean of the block it covers, not one sample of it', () => {
    const down = toPcm16(48000)
    // three blocks of three: silence, a third loud, full
    const out = pcm(down(Float32Array.from([0, 0, 0, 0.3, 0.3, 0.3, 1, 1, 1])))
    expect(out).toEqual([q(0), q(0.3), q(1)])
    // the block's own mean, not its first sample: a block of two quiet and one loud is a third of the way up
    expect(pcm(toPcm16(48000)(Float32Array.from([0, 0, 0.9])))).toEqual([q(0.3)])
  })

  test('a block split across two pieces of the microphone is still one block', () => {
    const whole = tone(1000, 48000, 3000)
    const expected = blocks(whole, 3).map(q)
    const down = toPcm16(48000)
    const got: number[] = []
    // 100 samples a piece: not a multiple of the 3-sample block, so every piece ends mid-block
    for (let i = 0; i < whole.length; i += 100) got.push(...pcm(down(whole.subarray(i, i + 100))))
    expect(got).toEqual(expected)
    // a piece too short for even one block waits for the rest of it, and nothing is lost or doubled
    const small = toPcm16(48000)
    expect(pcm(small(Float32Array.from([0.2, 0.2])))).toEqual([])
    expect(pcm(small(Float32Array.from([0.2, 0.2])))).toEqual([q(0.2)])
  })

  test('a 1 kHz tone at 48 kHz comes out as the block means of it', () => {
    const whole = tone(1000, 48000, 4800)
    expect(pcm(toPcm16(48000)(whole))).toEqual(blocks(whole, 3).map(q))
  })

  test('a 12 kHz tone, which 16 kHz cannot hold, no longer folds back at full strength', () => {
    const whole = tone(12000, 48000, 4800)
    const naive = Array.from({ length: 1600 }, (_, i) => q(whole[i * 3]))
    const out = pcm(toPcm16(48000)(whole))
    const peak = (xs: number[]) => Math.max(...xs.map(Math.abs))
    // the raw pick every third sample: the tone comes back whole, as a 4 kHz whistle in the voice band
    expect(peak(naive)).toBeGreaterThan(0.75 * 0.8 * 0x7fff)
    // the block mean: a third of it, the plain low-pass's own price
    expect(peak(out)).toBeLessThan(0.4 * 0.8 * 0x7fff)
    expect(peak(out)).toBeGreaterThan(0.25 * 0.8 * 0x7fff)
  })

  test('44.1 kHz keeps its place across pieces too: a second is 16000 samples, steady stays steady', () => {
    const down = toPcm16(44100)
    let n = 0
    const level = new Set<number>()
    // pieces of 4096, as the call's own processor hands them over, of a steady signal
    for (let i = 0; i < 44100; i += 4096) {
      const piece = pcm(down(new Float32Array(Math.min(4096, 44100 - i)).fill(0.25)))
      n += piece.length
      for (const v of piece) level.add(v)
    }
    expect(Math.abs(n - 16000)).toBeLessThanOrEqual(1)
    expect([...level]).toEqual([q(0.25)])
  })
})
