// The view model's hub and its first extracted module, checked as one: shared/types.ts re-exports the task view model
// from shared/types/task.ts, and every module keeps importing it from the hub (audit 2026-11-18, MAINT-04). A re-export
// that stops carrying one of the names fails the typecheck here instead of somewhere in the screen.
import { describe, expect, test } from 'bun:test'
import { doneNewestFirst, type Snapshot, type Task, type TaskAgent, type TaskRun, type TaskStatus, type Report } from '../shared/types.ts'
import type { Report as MovedReport, Task as MovedTask, TaskAgent as MovedTaskAgent, TaskRun as MovedTaskRun, TaskStatus as MovedTaskStatus } from '../shared/types/task.ts'

/** one type, whichever path it is read by: a name the hub stops re-exporting is `never` here, and cannot be `true` */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** both paths read as one type, name by name: a missing re-export makes its entry `false` and this fails the typecheck */
const same: [Same<Task, MovedTask>, Same<TaskAgent, MovedTaskAgent>, Same<TaskRun, MovedTaskRun>, Same<TaskStatus, MovedTaskStatus>, Same<Report, MovedReport>] = [true, true, true, true, true]

describe('the task view model, read from the hub', () => {
  test('a snapshot typed through the hub holds tasks built from the moved module', () => {
    const run: MovedTaskRun = { provider: 'spark', providerName: 'Spark (local)', model: 'qwen3.8-flash-next', effort: 'high' }
    const status: MovedTaskStatus = 'work'
    const report: MovedReport = { msg: 'Splitting the view model', progress: 50, eta: 5 }
    const agent: MovedTaskAgent = { chat: 'SHE-158/Agent', role: 'agent', cli: 'pi', status, age: '2m', note: 'Working', run }
    const moved: MovedTask = { id: 'SHE-158', name: 'Split shared/types.ts', status, place: 'p:m:shepherdr', age: '2m', agent, report, state: 'Working', on: 'herdr', created: '2026-11-18 10:00' }
    const snapshot: Snapshot = {
      name: 'Shepherdr',
      host: 'this machine',
      places: [],
      machines: [],
      tasks: [moved],
      automations: {},
      artifacts: [],
      asks: {},
      needs: [],
      settings: [],
      user: 'Elias',
    }

    expect(snapshot.tasks.map((t) => t.id)).toEqual(['SHE-158'])
    expect(doneNewestFirst(snapshot.tasks)).toHaveLength(1)
    expect(same).toEqual([true, true, true, true, true])
  })
})
