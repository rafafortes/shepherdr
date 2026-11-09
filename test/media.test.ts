// A chat's pictures and videos as a tile draws them: a small copy of a big picture, a video's still, and the part of a
// file a player asks for (server/live/media.ts). Kept beside the file in the chat's own inbox, made once.
import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { smaller, span, THUMB_FROM } from '../server/live/media.ts'
import { tmp } from './tmp.ts'

describe('a player asks for part of a file', () => {
  test('a span of it, the end of it, or the whole file', () => {
    expect(span(null, 10)).toBeNull()
    expect(span('', 10)).toBeNull()
    expect(span('bytes=0-0', 10)).toEqual([0, 0])
    expect(span('bytes=3-4', 10)).toEqual([3, 4])
    // past its end: to its last byte
    expect(span('bytes=8-99', 10)).toEqual([8, 9])
    // from the end, as a player asks for the index at the end of an MP4
    expect(span('bytes=-3', 10)).toEqual([7, 9])
    // nothing it can answer
    expect(span('bytes=10-', 10)).toBe('bad')
    expect(span('bytes=-0', 10)).toBe('bad')
    // not a span at all: the whole file
    expect(span('pages=1-2', 10)).toBeNull()
  })
})

describe('a tile gets a small copy', () => {
  const dir = tmp('media')
  const ffmpeg = Bun.which('ffmpeg') !== null

  test('a small picture is its own thumbnail; a GIF that moves and an SVG that scales need none', async () => {
    for (const [name, bytes] of [
      ['small.png', [1, 2, 3]],
      ['moving.gif', new Array(THUMB_FROM + 1).fill(7)],
      ['drawing.svg', new Array(THUMB_FROM + 1).fill(7)],
    ] as const) {
      const at = join(dir, name)
      writeFileSync(at, new Uint8Array(bytes as unknown as number[]))
      expect(await smaller(at, 'thumb')).toBeNull()
    }
    // nothing there
    expect(await smaller(join(dir, 'gone.png'), 'thumb')).toBeNull()
    // a still is for a video only
    writeFileSync(join(dir, 'shot.png'), new Uint8Array([1]))
    expect(await smaller(join(dir, 'shot.png'), 'poster')).toBeNull()
  })

  test.skipIf(!ffmpeg)('a big picture gets one, made once beside it in the chat', async () => {
    const at = join(dir, 'big.png')
    // a real 900×700 picture, past the size a thumbnail is worth one for
    const made = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2f6f4f:s=900x700:d=1', '-vf', 'noise=alls=90:allf=t', '-frames:v', '1', at])
    expect(made.exitCode).toBe(0)
    const thumb = await smaller(at, 'thumb')
    expect(thumb).toBe(`${at}.thumb.jpg`)
    expect(existsSync(thumb!)).toBe(true)
    // twice asks for the same copy, made the first time
    const first = Bun.file(thumb!).lastModified
    expect(await smaller(at, 'thumb')).toBe(thumb)
    expect(Bun.file(thumb!).lastModified).toBe(first)
  })

  test.skipIf(!ffmpeg)("a video's still, taken a moment in, is kept beside it too", async () => {
    const at = join(dir, 'clip.mp4')
    const made = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2f6f4f:s=160x100:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '10', at])
    expect(made.exitCode).toBe(0)
    expect(await smaller(at, 'poster')).toBe(`${at}.poster.jpg`)
    expect(existsSync(`${at}.poster.jpg`)).toBe(true)
    // a video is no thumbnail: a still is what a tile shows of it
    expect(await smaller(at, 'thumb')).toBeNull()
  })

  test('something that is not a picture or a video has no small copy, however big', async () => {
    const at = join(dir, 'big.txt')
    writeFileSync(at, 'x'.repeat(THUMB_FROM + 1))
    expect(await smaller(at, 'thumb')).toBeNull()
    expect(await smaller(at, 'poster')).toBeNull()
  })
})
