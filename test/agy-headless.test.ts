// Shepherdr's own headless runs of agy: the probe that asks a primary whether its provider answers (return.ts) and the
// advisor's read-only run (advisor.ts). Both run `agy -p … --output-format json --mode plan` in a folder of Shepherdr's
// own; the answer is JSON ({conversation_id, status, response, error}) and its conversation is kept out of the chat
// finder (headless.json). A fake `agy` on PATH stands in for the CLI: what FAKE_AGY_MODE says it answers, its arguments
// written down, and its folder reported in its answer.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agyHeadlessDir, headlessOutcome, keepHeadless } from '../server/live/agy.ts'
import { adviceArgs, canAdvise, runAdvisor } from '../server/live/advisor.ts'
import { canProbe, oneShot, probeHarness } from '../server/live/return.ts'
import { reviewerWords } from '../server/live/prompts.ts'
import { parseAgy, setModels } from '../server/live/models.ts'
import { home, readJson } from '../server/store.ts'
import { tmp } from './tmp.ts'

const ASK = 'Reply with only the two letters: ok'
const LISTED = parseAgy('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-9\tGemini 9')
const bin = tmp('agy-headless-bin')
const args = join(tmp('agy-headless-args'), 'args')
const path = process.env.PATH
const savedMode = process.env.FAKE_AGY_MODE

writeFileSync(
  join(bin, 'agy'),
  `#!/bin/sh
echo "$@" > '${args}'
case "$FAKE_AGY_MODE" in
  ok) printf '{"conversation_id":"conv-run","status":"SUCCESS","response":"%s"}\\n' "$PWD" ;;
  error) printf '{"conversation_id":"conv-err","status":"ERROR","error":"invalid model selection"}\\n' ;;
  bare) printf '{}\\n' ;;
  junk) echo 'not json at all' ;;
  late) printf '{"conversation_id":"conv-late","status":"SUCCESS","response":"late"}\\n'; exit 2 ;;
  hang) exec sleep 30 ;;
esac
`,
)
chmodSync(join(bin, 'agy'), 0o755)

beforeAll(() => {
  setModels('agy', LISTED)
  process.env.PATH = `${bin}:${path}`
})

afterAll(() => {
  setModels('agy', undefined)
  process.env.PATH = path
  if (savedMode === undefined) delete process.env.FAKE_AGY_MODE
  else process.env.FAKE_AGY_MODE = savedMode
})

const mode = (m: string) => (process.env.FAKE_AGY_MODE = m)
const argsSeen = () => readFileSync(args, 'utf8').trim()

describe('the headless runs: their flags', () => {
  test('a probe is a plan-mode run that answers in JSON, its model with its effort in the id', () => {
    expect(oneShot({ kind: 'agy' })).toEqual(['agy', '-p', ASK, '--output-format', 'json', '--mode', 'plan'])
    expect(oneShot({ kind: 'agy', model: 'gemini-3.8-flash', effort: 'high' })).toEqual(['agy', '-p', ASK, '--model', 'gemini-3.8-flash-high', '--output-format', 'json', '--mode', 'plan'])
    expect(oneShot({ kind: 'agy', model: 'gemini-9', effort: 'low' })).toEqual(['agy', '-p', ASK, '--model', 'gemini-9', '--output-format', 'json', '--mode', 'plan'])
    expect(canProbe('agy')).toBe(true)
  })

  test('an advisor run is the same plan-mode run, its prompt as the word after -p; an unknown effort takes the default variant', () => {
    expect(adviceArgs({ kind: 'agy', model: 'gemini-3.8-flash', effort: 'low' }, 'Which?')).toEqual({
      cmd: ['agy', '-p', 'Which?', '--model', 'gemini-3.8-flash-low', '--output-format', 'json', '--mode', 'plan'],
    })
    expect(adviceArgs({ kind: 'agy' }, 'Which?')).toEqual({ cmd: ['agy', '-p', 'Which?', '--output-format', 'json', '--mode', 'plan'] })
    // this list has no medium variant: the lowest one stands for a model given no effort it has
    expect(adviceArgs({ kind: 'agy', model: 'gemini-3.8-flash', effort: 'max' }, 'x')!.cmd).toContain('gemini-3.8-flash-low')
    expect(canAdvise('agy')).toBe(true)
  })

  test('a reviewer that is Antigravity is named in words, its headless run and its subagent', () => {
    expect(reviewerWords({ kind: 'agy', model: 'gemini-3.8-flash', effort: 'high' })).toBe(
      'a headless Antigravity run (agy -p … --mode plan --model …) or an Antigravity subagent (model gemini-3.8-flash, high effort)',
    )
    expect(reviewerWords({ kind: 'agy' })).toBe('a headless Antigravity run (agy -p … --mode plan --model …) or an Antigravity subagent (its default model and effort)')
  })
})

describe('the answer of a headless run', () => {
  test('its words when it ends well, and its conversation kept out of the chat finder', () => {
    const dir = tmp('agy-headless-answer')
    keepHeadless('conv-kept', dir)
    expect(readJson<string[]>('agy/headless.json', [], dir)).toEqual(['conv-kept'])
    expect(headlessOutcome(JSON.stringify({ conversation_id: 'conv-ok', status: 'SUCCESS', response: 'ok' }), 0)).toEqual({ ok: true, said: 'ok' })
    expect(readJson<string[]>('agy/headless.json', [], home())).toContain('conv-ok')
  })

  test('an error says so: its error, or its status when it names none; a run that ends badly is no answer, even with SUCCESS', () => {
    expect(headlessOutcome(JSON.stringify({ status: 'ERROR', error: 'invalid model selection' }), 0)).toEqual({ ok: false, said: 'invalid model selection' })
    expect(headlessOutcome(JSON.stringify({ status: 'ERROR' }), 0)).toEqual({ ok: false, said: 'ERROR' })
    expect(headlessOutcome('{}', 0)).toEqual({ ok: false, said: 'the run failed' })
    expect(headlessOutcome(JSON.stringify({ status: 'SUCCESS', response: 'late' }), 2)).toEqual({ ok: false, said: 'late' })
    expect(headlessOutcome(JSON.stringify({ status: 'SUCCESS' }), 0)).toEqual({ ok: true, said: '' })
  })

  test('an answer that is no JSON, or no object, is said as it is, and fails', () => {
    expect(headlessOutcome('not json', 0)).toEqual({ ok: false, said: 'not an agy answer: not json' })
    expect(headlessOutcome('', 1)).toEqual({ ok: false, said: 'not an agy answer: ' })
    expect(headlessOutcome('null', 0).ok).toBe(false)
  })

  test('the kept ids are the last 200, each once', () => {
    const dir = tmp('agy-headless-kept')
    for (let i = 0; i < 205; i++) keepHeadless(`c-${i}`, dir)
    keepHeadless('c-204', dir)
    const kept = readJson<string[]>('agy/headless.json', [], dir)
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe('c-5')
    expect(kept.at(-1)).toBe('c-204')
  })

  test("the folder of the runs is made in Shepherdr's home, and is there after a second call", () => {
    const dir = tmp('agy-headless-dir')
    expect(agyHeadlessDir(dir)).toBe(join(dir, 'agy', 'headless'))
    expect(agyHeadlessDir(dir)).toBe(join(dir, 'agy', 'headless'))
  })
})

describe('the probe and the advisor run the fake agy', () => {
  test("a probe that gets SUCCESS is ok, in Shepherdr's folder, its id kept", async () => {
    mode('ok')
    const r = await probeHarness({ kind: 'agy', model: 'gemini-3.8-flash', effort: 'high' })
    expect(r).toEqual({ ok: true, said: agyHeadlessDir() })
    expect(argsSeen()).toBe(`-p ${ASK} --model gemini-3.8-flash-high --output-format json --mode plan`)
    expect(readJson<string[]>('agy/headless.json', [], home())).toContain('conv-run')
  })

  test('a probe that gets an error says it, and is not ok; a run that exits badly is not ok even with SUCCESS; a bare answer too', async () => {
    mode('error')
    expect(await probeHarness({ kind: 'agy' })).toEqual({ ok: false, said: 'invalid model selection' })
    mode('late')
    expect(await probeHarness({ kind: 'agy' })).toEqual({ ok: false, said: 'late' })
    mode('bare')
    expect(await probeHarness({ kind: 'agy' })).toEqual({ ok: false, said: 'the run failed' })
  })

  test('a probe whose answer is no JSON is a failed probe that says what it got', async () => {
    mode('junk')
    expect(await probeHarness({ kind: 'agy' })).toEqual({ ok: false, said: 'not an agy answer: not json at all' })
  })

  test('a probe that hangs is killed at its limit', async () => {
    mode('hang')
    expect(await probeHarness({ kind: 'agy' }, 200)).toEqual({ ok: false, said: 'timed out' })
  }, 15_000)

  test("an advisor's words are the run's response, in the folder of the work; its errors are said", async () => {
    const cwd = tmp('agy-headless-work')
    mode('ok')
    expect(await runAdvisor({ kind: 'agy', model: 'gemini-3.8-flash', effort: 'low' }, 'Which store?', cwd)).toEqual({ ok: true, out: cwd })
    expect(argsSeen()).toBe('-p Which store? --model gemini-3.8-flash-low --output-format json --mode plan')
    mode('error')
    expect(await runAdvisor({ kind: 'agy' }, 'Which store?', cwd)).toEqual({ ok: false, out: 'invalid model selection' })
    mode('junk')
    expect((await runAdvisor({ kind: 'agy' }, 'Which store?', cwd)).ok).toBe(false)
  })

  test('an advisor run that hangs is given up on at its limit', async () => {
    mode('hang')
    expect(await runAdvisor({ kind: 'agy' }, 'Which?', tmp('agy-headless-work'), 200)).toEqual({ ok: false, out: 'timed out' })
  }, 15_000)
})
