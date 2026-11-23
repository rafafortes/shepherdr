// SHE-191: a 360 px phone's task row fits about 30 characters, so every prompt that asks for a task title or a status
// line asks for at most 30, with examples. The asked length is not a stored one: titles up to 32 are still accepted and
// a longer status is still cut at 40, so an older agent's line still draws.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ROW_MAX, STATUS_MAX, TITLE_MAX } from '../shared/types.ts'

const { checkTitle, fitStatus } = await import('../server/live/engine/engine.ts')
const root = join(import.meta.dir, '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

describe('titles and status lines are asked for at most 30 characters', () => {
  test('the ask is 30; what is stored stays 32 for titles and 40 for status lines', () => {
    expect(ROW_MAX).toBe(30)
    expect(TITLE_MAX).toBe(32)
    expect(STATUS_MAX).toBe(40)
    // refuse nothing new: a 32-char title is still accepted, a longer one is still refused
    expect(checkTitle('x'.repeat(TITLE_MAX))).toHaveLength(TITLE_MAX)
    expect(() => checkTitle('x'.repeat(TITLE_MAX + 1))).toThrow(`${TITLE_MAX} at most`)
    // a status line older agents write past the ask still draws, cut at the word
    expect(fitStatus('Fixing two failing tests')).toBe('Fixing two failing tests')
    expect(fitStatus('Rebasing onto main and running every check again')).toBe('Rebasing onto main and running every')
    expect(fitStatus('Rebasing onto main and running every check again').length).toBeLessThanOrEqual(STATUS_MAX)
  })

  test('the task agent skill asks for 30 in its status line and its needs-you reason, with examples', () => {
    const skill = read('skill/shepherdr-agent/SKILL.md')
    expect(skill).toContain('"<at most 30\n   characters, e.g.')
    expect(skill).toContain('("Running the full tests", not "Rebasing onto main, then running the whole test suite")')
    expect(skill).toContain('still cut at 40 characters for an agent using the old wording')
    expect(skill).toContain('before you ask, set your status line to why, at most 30 characters')
    expect(skill).toContain('e.g. "Needs a go for a screenshot", not "Waiting for the person to say whether I can take the window"')
    expect(skill).not.toContain('at most 40 characters')
    expect(skill).not.toContain('uncut')
  })

  test('the coordinator skill asks for 30-char titles, with examples', () => {
    const skill = read('skill/shepherdr-coordinator/SKILL.md')
    expect(skill).toContain('Ask for a title of at most 30 characters, about')
    expect(skill).toContain('("Fix login redirect loop"),')
    expect(skill).toContain('("Fix the login redirect loop after a session times out")')
    expect(skill).toContain('32 characters are still accepted')
    expect(skill).toContain('Every title asked for is at most 30 characters')
    expect(skill).not.toContain('The title fits 32 characters')
  })

  test('the docs describe the ask of 30 and the cut of 40 without claiming agents are told 40', () => {
    const doc = read('docs/tasks.md')
    expect(doc).toContain('agents are asked for\n  30, about what a 360 px phone row gives')
    expect(doc).toContain('asked for at most 30 characters ("Fixing the two failing tests"')
    expect(doc).toContain('asked for at most 30 characters for a 360 px phone row; a longer line is cut at 40 characters')
    expect(doc).toContain("are asked for at most 30 characters, about what a 360 px phone's task row gives; 32 are still accepted")
    expect(doc).toContain("longer than 40 characters is cut at a word, so an older agent's longer line still draws")
    expect(doc).not.toContain('and the agent is told so')
  })

  test('every good example fits the ask, and every bad one does not', () => {
    for (const good of ['Fixing two failing tests', 'Running the full tests', 'Needs a go for a screenshot', 'Fix login redirect loop']) expect(good.length).toBeLessThanOrEqual(ROW_MAX)
    for (const bad of ['Rebasing onto main, then running the whole test suite', 'Waiting for the person to say whether I can take the window', 'Fix the login redirect loop after a session times out'])
      expect(bad.length).toBeGreaterThan(ROW_MAX)
  })
})
