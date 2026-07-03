import { Either, Schema } from 'effect'
import { phrasePlanV1Schema, type PhrasePlanV1 } from '../schema.js'
import type { Manifest } from './manifest.js'

// Rehearsal mode: pure layer converting mark entries of a session log into pool entry form.
// The CLI is scripts/pool-add.ts.

export interface PoolEntryJson {
  readonly band: number
  readonly aim: string
  readonly plan: PhrasePlanV1
  /** Slot number → role word (stamped from the manifest's role. Used for the pool's role mapping) */
  readonly roles: Readonly<Record<string, string>>
}

const decodeV1 = Schema.decodeUnknownEither(phrasePlanV1Schema)

/** Extract the marked plans from a session log (JSONL lines) */
export const extractMarks = (
  lines: ReadonlyArray<string>,
  sessionName: string,
  manifest: Manifest | null = null,
): ReadonlyArray<PoolEntryJson> =>
  lines
    .filter((l) => l.trim() !== '')
    .flatMap((line) => {
      const parsed = Either.try(() => JSON.parse(line) as Record<string, unknown>)
      if (Either.isLeft(parsed)) return []
      const e = parsed.right
      if (e['type'] !== 'mark' || e['plan'] === null) return []
      const plan = decodeV1(e['plan'])
      if (Either.isLeft(plan)) return []
      const desire = typeof e['desire'] === 'number' ? e['desire'] : 0.5
      const roles = Object.fromEntries((manifest?.slots ?? []).map((s) => [String(s.slot), s.role] as const))
      return [
        {
          band: Math.round(desire * 100) / 100,
          aim: `session ${sessionName} ${String(e['manifest'] ?? '?')}`,
          plan: plan.right,
          roles,
        },
      ]
    })

/** Merge with the existing pool (duplicate plan contents are excluded) */
export const mergePool = (
  existing: ReadonlyArray<PoolEntryJson>,
  added: ReadonlyArray<PoolEntryJson>,
): ReadonlyArray<PoolEntryJson> => {
  const seen = new Set(existing.map((e) => JSON.stringify(e.plan)))
  return [
    ...existing,
    ...added.filter((e) => {
      const key = JSON.stringify(e.plan)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ]
}
