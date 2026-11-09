// An agent's own picture and video in the chat: sent with `shepherdr attach`, taken into the chat's inbox, and drawn in
// place as the person's own attachments are — a picture tile with its caption above it, a video tile with a still that
// plays in place, both light on a phone (a thumbnail, a poster, the file in parts).
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, settled, until } from './layout.ts'

const { browser, world, url } = await layout()

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
)

/** the agent's own messages, as `shepherdr attach` posts them: the caption, then each file a message of its own */
function sent(id: string) {
  const at = Date.now()
  world.files['~/inbox/home/ag1-shot.png'] = () => new Blob([new Uint8Array(png)], { type: 'image/png' })
  world.files['~/inbox/home/ag2-big.png'] = () => new Blob([new Uint8Array(png)], { type: 'image/png' })
  world.chats['p:vm-str:~'].messages.push(
    { id: `${id}-words`, who: 'agent', text: 'The keyboard up, and the button above it:', at },
    { id: `${id}-shot`, who: 'agent', file: { name: 'shot.png', path: '~/inbox/home/ag1-shot.png' }, at },
    // the demo world's own clip (a second of a flat frame) and the still beside it: a video that really plays
    { id: `${id}-clip`, who: 'agent', file: { name: 'upload-page.mp4', path: '~/inbox/lv/mf1a2e-upload-page.mp4' }, at },
    // two sent together: an album, on the agent's side
    { id: `${id}-a`, who: 'agent', file: { name: 'a.png', path: '~/inbox/home/ag1-shot.png' }, at: at + 5 },
    { id: `${id}-b`, who: 'agent', file: { name: 'b.png', path: '~/inbox/home/ag2-big.png' }, at: at + 5 },
  )
}

const open = async (width = 390) => {
  const page = await browser!.newPage({ viewport: { width, height: 844 }, hasTouch: width < 1024 })
  await page.goto(url())
  await page.getByRole('textbox', { name: /Message/ }).waitFor()
  return page
}

describe.skipIf(!browser)("an agent's pictures and videos in its chat", () => {
  test('a picture shows in place, with the agent\'s caption above it, at a thumbnail a phone can afford', async () => {
    sent('pic')
    const page = await open()
    const tile = page.locator('[data-msg="pic-shot"], [data-msg="pic-shot:0"]').first()
    await tile.waitFor()
    const img = tile.locator('img')
    await img.waitFor()
    // the small copy is what a tile loads, never the whole picture
    expect(await img.getAttribute('src')).toContain('thumb=1')
    // it really drew: its pixels came through the chat's own file route
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
    // the caption is the message above it, in the agent's own words
    const words = page.locator('[data-msg="pic-words"] [data-text]')
    expect(await words.textContent()).toBe('The keyboard up, and the button above it:')
    // the agent's side, where its replies are
    expect(await tile.getAttribute('data-you')).toBeNull()
    // a tap opens it full screen, as one the person sent
    await tile.locator('button[aria-label^="Open "]').click()
    await page.getByRole('dialog').or(page.locator('img[alt="shot.png"]')).first().waitFor()
    // nothing spills off a phone's width
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
    await page.close()
  }, 30_000)

  test('a video is a tile with its still, and it plays in place', async () => {
    sent('clip')
    const page = await open()
    const video = page.locator('[data-msg="clip-clip"], [data-msg="clip-clip:0"]').first().locator('video')
    await video.waitFor()
    // a still first, so the tile is not a black box before a tap
    expect(await video.getAttribute('poster')).toContain('poster=1')
    const origin = new URL(url()).origin
    const poster = await page.request.get(`${origin}/${(await video.getAttribute('poster'))!}`)
    expect(poster.status()).toBe(200)
    expect(poster.headers()['content-type']).toBe('image/jpeg')
    // the person's own controls, in place, and its name under it with a way to keep the file
    expect(await video.getAttribute('controls')).not.toBeNull()
    expect(await video.getAttribute('playsinline')).not.toBeNull()
    const cell = page.locator('[data-msg="clip-clip"], [data-msg="clip-clip:0"]').first()
    expect(await cell.textContent()).toContain('upload-page.mp4')
    expect(await cell.getByRole('link', { name: 'Download upload-page.mp4' }).count()).toBe(1)
    // the file itself is served a part at a time, so a long clip is not downloaded whole to look at it
    const src = await video.locator('source').first().getAttribute('src')
    const part = await page.request.get(`${origin}/${src!}`, { headers: { range: 'bytes=0-1' } })
    expect(part.status()).toBe(206)
    expect(part.headers()['content-range']).toMatch(/^bytes 0-1\/\d+$/)
    // it really plays: its frames come through, a part at a time
    await video.evaluate(async (v: HTMLVideoElement) => {
      v.muted = true
      await v.play().catch(() => undefined)
    })
    const played = await until(
      async () => video.evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, w: v.videoWidth })),
      (s) => s.t > 0.1 && s.w > 0,
      8000,
    )
    expect(played.t).toBeGreaterThan(0.1)
    await video.evaluate((v: HTMLVideoElement) => v.pause())
    await page.close()
  }, 30_000)

  test('two pictures an agent sent together lie side by side, and a tap opens the one tapped', async () => {
    sent('pair')
    const page = await open()
    const album = page.getByRole('group', { name: '2 pictures' }).last()
    await album.waitFor()
    await settled(page)
    expect(await album.locator('img').count()).toBe(2)
    // on the agent's side of the chat, and one row wide as two tiles
    const chat = await page.locator('[data-messages]').boundingBox()
    const box = await album.boundingBox()
    expect(box!.x).toBeLessThan(chat!.x + chat!.width / 2)
    expect(box!.width).toBeGreaterThan(120)
    // a tap opens that one of the two, full screen
    await album.locator('button[aria-label="Open b.png"]').click()
    const viewer = page.getByRole('dialog').or(page.locator('img[alt="b.png"]')).first()
    await viewer.waitFor()
    await page.close()
  }, 30_000)
})
