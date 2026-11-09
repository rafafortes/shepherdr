// A chat's pictures and videos as a tile draws them: a small copy of a big picture for its thumbnail, and a still for a
// video's poster, each made once beside the file in the chat's own inbox and kept there with it (deleting the chat takes
// both away). A machine with no ffmpeg makes none, and the tile shows what it has.
//
// A video is played part at a time (Range), so a phone starts it before it has all of it and seeks without downloading
// it again (server/app.ts, `attachment`).
import { randomUUID } from 'node:crypto'
import { isImage, isVideo } from '../../shared/files.ts'
import { run } from './box.ts'
import { existsSync, renameSync, rmSync, statSync } from './mfs.ts'

/** smaller than this, a picture is its own thumbnail */
export const THUMB_FROM = 200 * 1024
/** a thumbnail's longest side: well past the chat's biggest tile (352 px across, a phone's own pixels), so it stays
 *  sharp on a dense screen */
export const THUMB_SIDE = 640

/** what a tile asks for instead of the whole file */
export type Small = 'thumb' | 'poster'

/** a range header's one span of a file `size` bytes long: [start, end] (end included), "bad" when it can't be met, or
 *  null for none (the whole file) */
export function span(range: string | null | undefined, size: number): [number, number] | 'bad' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((range ?? '').trim())
  if (!m || (!m[1] && !m[2])) return null
  let start: number
  let end: number
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  return start > end || start >= size ? 'bad' : [start, end]
}

/** la presence of a tool on the machine the file lives on: asked once, the same answer after */
const tools = new Map<string, boolean>()
export async function hasTool(tool: string) {
  let known = tools.get(tool)
  if (known === undefined) {
    known = (await run(['/bin/sh', '-c', `command -v ${tool} >/dev/null 2>&1`], { timeoutMs: 10_000 })).code === 0
    tools.set(tool, known)
  }
  return known
}

/** a tile's small copy of a picture, or a still of a video, that could not be made here, by path, size and time: a tile
 *  asks again on every redraw, and ffmpeg would run again each time for the same answer */
const noCopy = new Map<string, string>()

/**
 * The small copy of a picture (want "thumb") or a video's still (want "poster"), by the path, size and time it was made
 * from; null when it isn't worth one (a small picture, a GIF that moves, an SVG that scales) or none can be made here.
 * Kept beside the file (`<name>.thumb.jpg`), so it goes when the chat's inbox does.
 */
export async function smaller(path: string, want: Small): Promise<string | null> {
  if (!existsSync(path)) return null
  const st = statSync(path)
  if (!st.isFile()) return null
  if (want === 'thumb' && (!isImage(path) || st.size < THUMB_FROM || /\.(gif|svg)$/i.test(path))) return null
  if (want === 'poster' && !isVideo(path)) return null
  const out = `${path}.${want}.jpg`
  if (existsSync(out) && statSync(out).mtimeMs >= st.mtimeMs) return out
  const key = `${path}\0${st.size}\0${st.mtimeMs}\0${want}`
  if (noCopy.has(key)) return null
  if (!(await hasTool('ffmpeg'))) return null
  const scale = `scale='min(${THUMB_SIDE},iw)':'min(${THUMB_SIDE},ih)':force_original_aspect_ratio=decrease`
  // its own name for the half-written file: two tiles asking at once never write into each other
  const tmp = `${out}.${randomUUID().slice(0, 8)}.tmp.jpg`
  // a still is taken a little into the video, past a fade-in; a very short one falls back to its first frame
  const cut = want === 'poster' ? ['-ss', '0.5'] : []
  const frame = ['-frames:v', '1', '-vf', scale, '-q:v', '4', tmp]
  // ffmpeg's own answer: 0 it made one, 124 it ran out of time (a busy machine: worth asking again later), any other
  // number it cannot read this file (a name that isn't what it says), which nothing here makes any better
  const made = async (args: string[]) => (await run(['ffmpeg', '-v', 'error', '-y', ...args], { timeoutMs: 20_000 })).code
  const first = await made([...cut, '-i', path, ...frame])
  const code = first === 0 || cut.length === 0 ? first : await made(['-i', path, ...frame])
  if (code !== 0 || !existsSync(tmp)) {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
    if (code !== 124) {
      if (noCopy.size > 500) noCopy.clear()
      noCopy.set(key, '')
    }
    return null
  }
  renameSync(tmp, out)
  return out
}
