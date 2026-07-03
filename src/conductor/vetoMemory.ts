import { Either, Schema } from 'effect'
import { renderPlanV1 } from '../render.js'
import { phrasePlanV1Schema, type PhrasePlanV1 } from '../schema.js'

// Feedback memory: persistent veto / mark context, per manifest.
// veto is the one piece of feedback a performer can give by reflex during a live set (mark is
// cognitively unrealistic mid-performance, but it can be pressed in rehearsal and is used as a
// positive example). Past sessions' vetoes and marks are reconstructed and injected into the
// system prompt as "shapes to avoid" / "preferred shapes" — effective from the next session with
// zero retraining.
//
// Memory is keyed by manifest id and injected only for that manifest.
//
// Two layers: the distilled file plans/feedback.json (kept in plans/, commit it to persist; grown after rehearsal with
// `pnpm feedback-add`) ∪ a reconstruction of the last 30 session logs (always) → mergeFeedback → summarizeFeedback.
//
// The block format is shared with training-data generation (training/) so that the prompt at
// training time matches the prompt at inference time.
//
// Log structure: a veto event carries no plan (it stamps the most recent phrase in the history),
// so we walk the type:"plan" entries in order and treat the plan current at the time of the veto
// as "the vetoed shape". type:"mark" entries carry the plan and the manifest id themselves.

const decodePlan = Schema.decodeUnknownEither(phrasePlanV1Schema)

export interface ManifestFeedback {
  readonly veto: ReadonlyArray<string>
  readonly mark: ReadonlyArray<string>
}

/** manifest id → veto / mark observed for it (pattern strings, chronological) */
export type FeedbackMap = Readonly<Record<string, ManifestFeedback>>

const emptyFeedback: ManifestFeedback = { veto: [], mark: [] }

/** Rendered patterns of a plan (transitions included, silence "~" excluded) */
const patternsOf = (plan: PhrasePlanV1): ReadonlyArray<string> =>
  renderPlanV1(plan)
    .flatMap((s) => [s.pattern, ...(s.transition === null ? [] : [s.transition])])
    .filter((p) => p !== '~')

const appendTo = (
  map: FeedbackMap,
  id: string,
  kind: 'veto' | 'mark',
  patterns: ReadonlyArray<string>,
): FeedbackMap => {
  if (patterns.length === 0) return map
  const fb = map[id] ?? emptyFeedback
  return { ...map, [id]: { ...fb, [kind]: [...fb[kind], ...patterns] } }
}

/**
 * Reconstruct per-manifest veto / mark from session-log lines, in order.
 * A veto targets the preceding type:"plan" entry (which also provides the manifest id; plans
 * without an id cannot be attributed and are skipped). kill (density 0) is not included: it may
 * mean "stop now" rather than "bad shape".
 */
export const collectFeedback = (lines: ReadonlyArray<string>): FeedbackMap =>
  lines
    .filter((l) => l.trim() !== '')
    .reduce<{
      readonly last: {
        readonly plan: PhrasePlanV1
        readonly id: string
      } | null
      readonly map: FeedbackMap
    }>(
      (acc, line) => {
        const parsed = Either.try(() => JSON.parse(line) as Record<string, unknown>)
        if (Either.isLeft(parsed)) return acc
        const e = parsed.right
        if (e['type'] === 'plan') {
          const plan = decodePlan(e['plan'])
          return Either.isRight(plan) && typeof e['manifest'] === 'string'
            ? { ...acc, last: { plan: plan.right, id: e['manifest'] } }
            : { ...acc, last: null }
        }
        if (e['type'] === 'mark') {
          const plan = decodePlan(e['plan'])
          return Either.isRight(plan) && typeof e['manifest'] === 'string'
            ? {
                ...acc,
                map: appendTo(acc.map, e['manifest'], 'mark', patternsOf(plan.right)),
              }
            : acc
        }
        const ev = e['event'] as Record<string, unknown> | undefined
        const isVeto =
          e['type'] === 'event' &&
          ev !== undefined &&
          ev['_tag'] === 'Knob' &&
          ev['name'] === 'veto' &&
          typeof ev['value'] === 'number' &&
          ev['value'] >= 0.5
        return isVeto && acc.last !== null
          ? {
              ...acc,
              map: appendTo(acc.map, acc.last.id, 'veto', patternsOf(acc.last.plan)),
            }
          : acc
      },
      { last: null, map: {} },
    ).map

/**
 * Summarise: most frequent first (vetoed/marked repeatedly = strong), newest first on ties,
 * at most n. Small lists on purpose: 1B-class models follow short instructions better
 */
export const summarizePatterns = (patterns: ReadonlyArray<string>, n: number): ReadonlyArray<string> => {
  const stats = patterns.reduce<ReadonlyMap<string, { readonly count: number; readonly lastIdx: number }>>(
    (m, p, i) => new Map(m).set(p, { count: (m.get(p)?.count ?? 0) + 1, lastIdx: i }),
    new Map(),
  )
  return [...stats.entries()]
    .sort(([, a], [, b]) => b.count - a.count || b.lastIdx - a.lastIdx)
    .slice(0, Math.max(0, n))
    .map(([p]) => p)
}

/**
 * Merge the two layers: distilled file (older) then log reconstruction (newer).
 * summarizePatterns' "newest on ties" then favours the log side (recent observations)
 */
export const mergeFeedback = (older: FeedbackMap, newer: FeedbackMap): FeedbackMap => {
  const ids = new Set([...Object.keys(older), ...Object.keys(newer)])
  return Object.fromEntries(
    [...ids].map((id) => {
      const a = older[id] ?? emptyFeedback
      const b = newer[id] ?? emptyFeedback
      return [id, { veto: [...a.veto, ...b.veto], mark: [...a.mark, ...b.mark] }] as const
    }),
  )
}

/** Summarise veto / mark per manifest (defaults 12 / 8, see the env vars in run.ts) */
export const summarizeFeedback = (map: FeedbackMap, vetoN: number, markN: number): FeedbackMap =>
  Object.fromEntries(
    Object.entries(map).map(([id, fb]) => [
      id,
      {
        veto: summarizePatterns(fb.veto, vetoN),
        mark: summarizePatterns(fb.mark, markN),
      },
    ]),
  )

/**
 * Append to the distilled file (pnpm feedback-add): only patterns not already present are added
 * at the end — idempotent (importing the same log twice adds nothing)
 */
export const addToFeedback = (base: FeedbackMap, add: FeedbackMap): FeedbackMap => {
  const appendNew = (xs: ReadonlyArray<string>, ys: ReadonlyArray<string>): ReadonlyArray<string> =>
    ys.reduce<ReadonlyArray<string>>((acc, y) => (acc.includes(y) ? acc : [...acc, y]), xs)
  const ids = new Set([...Object.keys(base), ...Object.keys(add)])
  return Object.fromEntries(
    [...ids].map((id) => {
      const a = base[id] ?? emptyFeedback
      const b = add[id] ?? emptyFeedback
      return [id, { veto: appendNew(a.veto, b.veto), mark: appendNew(a.mark, b.mark) }] as const
    }),
  )
}

/**
 * Read plans/feedback.json (the distilled file). It may be hand-edited, so a malformed file is
 * not fatal: whatever is readable is used
 */
export const parseFeedbackFile = (json: string): FeedbackMap => {
  const parsed = Either.try(() => JSON.parse(json) as unknown)
  if (Either.isLeft(parsed) || typeof parsed.right !== 'object' || parsed.right === null || Array.isArray(parsed.right))
    return {}
  const strings = (v: unknown): ReadonlyArray<string> =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return Object.fromEntries(
    Object.entries(parsed.right as Record<string, unknown>).map(([id, fb]) => [
      id,
      typeof fb === 'object' && fb !== null && !Array.isArray(fb)
        ? {
            veto: strings((fb as Record<string, unknown>)['veto']),
            mark: strings((fb as Record<string, unknown>)['mark']),
          }
        : emptyFeedback,
    ]),
  )
}

/**
 * The "shapes to avoid" block, appended to the system prompt.
 * **The one format shared with training-data generation (src/training/dataset.ts)**. An empty list yields ''
 */
export const vetoBlock = (avoid: ReadonlyArray<string>): string =>
  avoid.length === 0
    ? ''
    : `\n\nShapes to avoid (the performer rejected these before; do not use the same or near-identical patterns):\n` +
      avoid.map((p) => `- ${p}`).join('\n')

/**
 * The "preferred shapes" block, the positive counterpart of veto.
 * Training teaches how to read the field, not its contents (they are manifest-specific). An empty list yields ''
 */
export const markBlock = (liked: ReadonlyArray<string>): string =>
  liked.length === 0
    ? ''
    : `\n\nPreferred shapes (the performer liked these with this manifest; you may lean on this vocabulary):\n` +
      liked.map((p) => `- ${p}`).join('\n')

/**
 * The effective avoid list: shared avoid (smoke tests) + this manifest's vetoes.
 * Prompt injection (feedbackBlocks) and validation on receipt (sanitizePlanAvoid) use the same
 * list — the model's self-restraint is not trusted (measured compliance was about 88%)
 */
export const mergedAvoid = (avoid: ReadonlyArray<string>, fb: ManifestFeedback | undefined): ReadonlyArray<string> => [
  ...avoid,
  ...(fb?.veto ?? []),
]

/**
 * The feedback part of the system prompt (shared by api/local): the merged avoid list followed by
 * the preferred shapes. Constant for the whole run, so the prefix cache holds
 */
export const feedbackBlocks = (avoid: ReadonlyArray<string>, fb: ManifestFeedback | undefined): string =>
  vetoBlock(mergedAvoid(avoid, fb)) + markBlock(fb?.mark ?? [])

/**
 * Veto check on receipt:
 * - if only a transition (announced fill) is a vetoed shape, drop that transition and keep the
 *   main plan (**partial degradation** — musically cheaper than discarding everything)
 * - if a main pattern is a vetoed shape, return null (discard the whole plan → degradation chain)
 */
export const sanitizePlanAvoid = (plan: PhrasePlanV1, avoid: ReadonlyArray<string>): PhrasePlanV1 | null => {
  if (avoid.length === 0) return plan
  const set = new Set(avoid)
  const rendered = new Map(renderPlanV1(plan).map((r) => [r.slot, r] as const))
  if (
    plan.slots.some((s) => {
      const p = rendered.get(s.slot)!.pattern
      return p !== '~' && set.has(p)
    })
  )
    return null
  const slots = plan.slots.map((s) => {
    const t = rendered.get(s.slot)!.transition
    return s.transition !== undefined && t !== null && set.has(t) ? { slot: s.slot, pattern: s.pattern } : s
  })
  return slots.every((s, i) => s === plan.slots[i]) ? plan : { ...plan, slots }
}

/** Does the plan violate the avoid list? (exact match on the rendered result) */
export const violatesAvoid = (plan: PhrasePlanV1, avoid: ReadonlyArray<string>): boolean => {
  const set = new Set(avoid)
  return patternsOf(plan).some((p) => set.has(p))
}
