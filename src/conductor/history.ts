import type { PhrasePlanV1 } from '../schema.js'
import { renderPlanV1 } from '../render.js'

// Ring buffer of session history.
// This is how "learning in real time" is realized: in-context adaptation. Weight updates are
// impossible during a live set, so the recent phrases (plan summary + the performer's feedback)
// are included in every generation context, pulling the output toward "tonight's flow" as the set goes on.
// Meaning of the performer's feedback: mark = positive example, kill = negative example (including the
// emergency mute), veto = negative example (sound continues), freeze = request to hold still.
// History starts empty at startup, and only one manifest is active per run, so no separation is needed.

export type Feedback = 'mark' | 'kill' | 'veto' | 'freeze'

export interface PhraseRecord {
  readonly atCycle: number
  readonly desire: number | null
  /** Which Brain proposed it (so the api Brain can look back at whether its own proposals were accepted) */
  readonly usedMode: string
  readonly slots: ReadonlyArray<{
    readonly slot: number
    readonly pattern: string
  }>
  readonly feedback: Feedback | null
}

/** Number of phrases retained. Tune together with granularity based on measurements (risk: prompt bloat → latency) */
export const HISTORY_LEN = 12

export const phraseRecord = (args: {
  readonly atCycle: number
  readonly desire: number | null
  readonly usedMode: string
  readonly plan: PhrasePlanV1
}): PhraseRecord => ({
  atCycle: args.atCycle,
  desire: args.desire,
  usedMode: args.usedMode,
  slots: renderPlanV1(args.plan).map((s) => ({
    slot: s.slot,
    pattern: s.pattern,
  })),
  feedback: null,
})

export const pushPhrase = (history: ReadonlyArray<PhraseRecord>, record: PhraseRecord): ReadonlyArray<PhraseRecord> =>
  [...history, record].slice(-HISTORY_LEN)

/** Strength of feedback: mark (explicit positive) > kill (negative incl. emergency mute) > veto (negative) > freeze (hold).
 * Weaker feedback never overwrites stronger */
const RANK: Readonly<Record<Feedback, number>> = {
  mark: 4,
  kill: 3,
  veto: 2,
  freeze: 1,
}

/** Stamp the performer's feedback onto the most recent phrase (no-op on empty history) */
export const stampFeedback = (
  history: ReadonlyArray<PhraseRecord>,
  feedback: Feedback,
): ReadonlyArray<PhraseRecord> => {
  const last = history.at(-1)
  return last === undefined || (last.feedback !== null && RANK[last.feedback] >= RANK[feedback])
    ? history
    : [...history.slice(0, -1), { ...last, feedback }]
}

/** Summary for the status line: hist=N (★=mark, ✕=negatives kill+veto) */
export const historyLabel = (history: ReadonlyArray<PhraseRecord>): string => {
  const marks = history.filter((h) => h.feedback === 'mark').length
  const negs = history.filter((h) => h.feedback === 'kill' || h.feedback === 'veto').length
  return `${history.length}${marks > 0 ? `★${marks}` : ''}${negs > 0 ? `✕${negs}` : ''}`
}
