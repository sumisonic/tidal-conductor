import { match } from 'ts-pattern'
import type { Euclid, Grid, Nsteps, PatternV1, PhrasePlan, PhrasePlanV1, Rhythm, Samples } from './schema.js'

// Renderer — plan (structured JSON) → mini-notation (Boolean structure pattern).
//
// Deterministic pure functions. The output alphabet is only t ~ [ ] ( ) < > , digits and whitespace, and
// for any input that passed the schema, the returned string is guaranteed to pass parseBP.
// The output can be passed straight to struct / aiPat.

/** Rendering result of one slot */
export interface RenderedSlot {
  readonly slot: number
  readonly role: string
  /** parseBP-safe mini-notation. Silence is "~" */
  readonly pattern: string
}

export const renderRhythm = (rhythm: Rhythm): string =>
  match(rhythm)
    .with({ type: 'euclid' }, renderEuclid)
    .with({ type: 'grid' }, renderGrid)
    .with({ type: 'silence' }, () => '~')
    .exhaustive()

const renderEuclid = (e: Euclid): string =>
  match(e.rotation)
    .with(undefined, () => `t(${e.pulses},${e.steps})`)
    .when(
      (r): r is number => typeof r === 'number',
      (r) => `t(${e.pulses},${e.steps},${r})`,
    )
    .otherwise((rs) => `t(${e.pulses},${e.steps},<${rs.join(' ')}>)`)

const renderGrid = (g: Grid): string => {
  const variants = g.variants.map((v) =>
    v
      .map((step) => (Array.isArray(step) ? `[${step.map(renderCell).join(' ')}]` : renderCell(step as 'x' | '~')))
      .join(' '),
  )
  return variants.length === 1 ? variants[0]! : `<${variants.map((v) => `[${v}]`).join(' ')}>`
}

const renderCell = (cell: 'x' | '~'): string => (cell === 'x' ? 't' : '~')

export const renderPlan = (plan: PhrasePlan): ReadonlyArray<RenderedSlot> =>
  plan.slots.map((s) => ({
    slot: s.slot,
    role: s.role,
    pattern: renderRhythm(s.rhythm),
  }))

// --- v1: nsteps + transition ---

const renderNsteps = (g: Nsteps): string => {
  const variants = g.variants.map((v) => v.map((c) => (c === '~' ? '~' : String(c))).join(' '))
  return variants.length === 1 ? variants[0]! : `<${variants.map((v) => `[${v}]`).join(' ')}>`
}

// The samples type is rendered in index form (same shape as nsteps) —
// prompts, history, and veto/mark memory keep the index sequence the LLM wrote, and
// conversion to name form (renderSamplesNames) happens only right before sending (scheduler)
export const renderPatternV1 = (pattern: PatternV1): string =>
  match(pattern)
    .with({ type: 'nsteps' }, renderNsteps)
    .with({ type: 'samples' }, (s) => renderNsteps({ ...s, type: 'nsteps' }))
    .otherwise((r) => renderRhythm(r))

/**
 * samples type: convert an index sequence to a sequence of the vocab (sample names) declared in the manifest.
 * "0 ~ 1" → "bd:0 ~ sn:1". Acceptance-time checks (planManifestMismatch) guarantee the indices are
 * within the vocab range — should one be out of range anyway, it becomes "~" (structural safety)
 */
export const renderSamplesNames = (s: Samples, vocab: ReadonlyArray<string>): string => {
  const variants = s.variants.map((v) => v.map((c) => (c === '~' ? '~' : (vocab[c] ?? '~'))).join(' '))
  return variants.length === 1 ? variants[0]! : `<${variants.map((v) => `[${v}]`).join(' ')}>`
}

/** One v1 slot: the body plus an optional last-cycle replacement (announced fill) */
export interface RenderedSlotV1 {
  readonly slot: number
  readonly pattern: string
  readonly transition: string | null
}

export const renderPlanV1 = (plan: PhrasePlanV1): ReadonlyArray<RenderedSlotV1> =>
  plan.slots.map((s) => ({
    slot: s.slot,
    pattern: renderPatternV1(s.pattern),
    transition: s.transition === undefined ? null : renderPatternV1(s.transition),
  }))

/**
 * Rendering for the real wiring: samples slots are converted to vocab name sequences.
 * A samples slot whose vocab cannot be resolved falls back to "~" (silence)
 */
export const renderPlanV1WithVocab = (
  plan: PhrasePlanV1,
  vocabOf: (slot: number) => ReadonlyArray<string> | undefined,
): ReadonlyArray<RenderedSlotV1> => {
  const renderOne = (p: PatternV1, slot: number): string => {
    if (p.type !== 'samples') return renderPatternV1(p)
    const vocab = vocabOf(slot)
    return vocab === undefined ? '~' : renderSamplesNames(p, vocab)
  }
  return plan.slots.map((s) => ({
    slot: s.slot,
    pattern: renderOne(s.pattern, s.slot),
    transition: s.transition === undefined ? null : renderOne(s.transition, s.slot),
  }))
}

/** Character set the renderer output must stay within (the shared basis of the property tests and the GHCi check) */
export const SAFE_PATTERN_RE = /^[t~\s[\]()<>,0-9]+$/

/** Sample names allowed in a manifest vocab (structurally constrained at declaration time — the safety basis of the sent string).
 * e.g. "kit_bd:0" / "kit_fm_ch" (omitting :n = index 0) */
export const SAFE_SAMPLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(:\d{1,3})?$/

/** Character set the name-form rendering of samples must stay within (paired with the GHCi Pattern String check) */
export const SAFE_SAMPLES_PATTERN_RE = /^[A-Za-z0-9_:~\s[\]<>]+$/
