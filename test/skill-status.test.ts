// The shared task-agent skill asks for the status cadence in words; every harness gets these words in its brief.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const skill = await Bun.file(join(import.meta.dir, '..', 'skill', 'shepherdr-agent', 'SKILL.md')).text()

describe('a task agent reports its status', () => {
  test('at the start, each natural step and at least every 5 minutes — its own discipline, never a nag from Shepherdr', () => {
    expect(skill).toContain('at least every 5 minutes while you work')
    expect(skill).toContain('that cadence is your own discipline')
    expect(skill).toContain('Shepherdr never interrupts you to')
    expect(skill).toContain('Keep it one short line')
  })
  test('revises --left honestly, says when it is a revision, and says what to do with nothing new', () => {
    expect(skill).toContain('revise it honestly')
    expect(skill).toContain('revision reads as a revision')
    expect(skill).toContain('marks')
    expect(skill).toContain('older than 5 minutes as older')
    expect(skill).toContain("don't repeat the same line")
    expect(skill).toContain('still on X, n minutes in')
  })
})
