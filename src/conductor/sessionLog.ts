import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Rehearsal mode: session log.
// Records the plan history and the performer's actions as JSONL; the "good moments" (mark)
// are harvested into the pool by scripts/pool-add.ts.

export interface SessionLogger {
  readonly path: string | null
  readonly log: (entry: Record<string, unknown>) => void
}

/** Records nothing (for tests and throwaway runs) */
export const nullLogger: SessionLogger = { path: null, log: () => {} }

export const makeSessionLogger = (dir: string): SessionLogger => {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  return {
    path,
    log: (entry) => {
      appendFileSync(path, JSON.stringify({ ts: Date.now(), ...entry }) + '\n')
    },
  }
}
