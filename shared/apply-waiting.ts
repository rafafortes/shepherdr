// The Settings whose change can apply to the tasks already created and still waiting (Settings' question "Apply to the
// tasks already created?", apply-to-waiting, shepherdr set … --apply-waiting). A task agent's keys (task.agent, task.model,
// task.effort) change the CLI a waiting task starts on; a reviewer's (reviewer.*, the backup reviewers' keys too) change
// the reviewer its brief's Settings block names. The advisor's applies at once: each question is advised with the
// advisor Settings name when it is asked, so no waiting task has anything to take.

/** the task agent's keys: a waiting task starts on what they name */
export const TASK_AGENT_KEYS = ['task.agent', 'task.model', 'task.effort']

/** the reviewer's keys: the primary reviewer, and each backup reviewer of the chain with its model and effort */
export const REVIEWER_KEYS = [
  'reviewer.agent',
  'reviewer.model',
  'reviewer.effort',
  'reviewer.fallback',
  'reviewer.fallbackModel',
  'reviewer.fallbackEffort',
  ...[2, 3, 4, 5].flatMap((n) => [`reviewer.fallback${n}`, `reviewer.fallback${n}Model`, `reviewer.fallback${n}Effort`]),
]

/** which waiting tasks a change of this key reaches: the task agent's, or the reviewer's; undefined for any other key */
export function waitingKind(key: string): 'agent' | 'reviewer' | undefined {
  if (TASK_AGENT_KEYS.includes(key)) return 'agent'
  if (REVIEWER_KEYS.includes(key)) return 'reviewer'
  return undefined
}

/** the answer for an advisor's key: it applies at once already, so nothing waits to change */
export const ADVISOR_AT_ONCE = 'advisor.* applies at once: every question is advised with the advisor Settings name when it is asked, running tasks included, so there is no waiting task to change.'
