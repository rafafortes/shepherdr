// pi's catalog as the operator's has it for the two providers nothing in the demo uses: nvidia and amd-tokenlab, both in
// pi's enabledModels. Tests call piOffers() where they want them, and its result when they are done: pi's settings are
// read from a folder of the test's own, never the real ones, and the catalog is the test's (the demo asks no CLI in tests).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setModels, type CliModels } from '../server/live/models.ts'
import { tmp } from './tmp.ts'

export const NV = 'nvidia/mistralai/mistral-large-4-1t-a52b'
export const AMD = 'amd-tokenlab/Qwen3.8-27B'

/** pi's list with the two providers, and one model it does not enable (it is listed, not offered) */
const PI: CliModels = { models: [NV, AMD, 'spark/qwen3'].map((id) => ({ id, label: id, efforts: [] })), efforts: ['off', 'low'] }

/** pi's catalog and its enabledModels from now on; the function gives back what was there before */
export function piOffers(): () => void {
  const dir = tmp('pi-offers')
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: [NV, AMD] }))
  const was = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  setModels('pi', PI)
  return () => {
    setModels('pi', undefined)
    if (was === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = was
  }
}
