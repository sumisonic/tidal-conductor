import { Schema } from 'effect'

// Plan schema v0 — the output contract of a Brain (api / pool / offline / local).
//
// Core of the safety design:
// The LLM never writes mini-notation strings directly. It outputs only structured values, and
// the deterministic pure functions in render.ts take full responsibility for converting them to mini-notation.
// Any value that passes this schema renders to a string that is guaranteed to pass parseBP
// (guaranteed by the property tests in test/ and the real-parser check via scripts/emit-pattern-cases.ts + haskell/ParseBPCheck.hs).
//
// Why Effect Schema: a single definition yields the type, the validation, and the JSON Schema
// (used as the structured-output contract of the api Brain) all at once.

const rotationValue = Schema.Number.pipe(Schema.int(), Schema.between(0, 15))

/** Euclidean rhythm: t(pulses,steps) / t(pulses,steps,rot) / t(pulses,steps,<r1 r2 ...>) */
export const euclidSchema = Schema.Struct({
  type: Schema.Literal('euclid'),
  pulses: Schema.Number.pipe(Schema.int(), Schema.between(1, 16)),
  steps: Schema.Number.pipe(Schema.int(), Schema.between(2, 16)),
  rotation: Schema.optional(
    Schema.Union(rotationValue, Schema.Array(rotationValue).pipe(Schema.minItems(2), Schema.maxItems(4))),
  ),
}).pipe(Schema.filter((e) => e.pulses <= e.steps || 'pulses must be <= steps'))

const cellSchema = Schema.Literal('x', '~')
const stepSchema = Schema.Union(cellSchema, Schema.Array(cellSchema).pipe(Schema.minItems(2), Schema.maxItems(4)))
const variantSchema = Schema.Array(stepSchema).pipe(Schema.minItems(2), Schema.maxItems(32))

/**
 * Step grid: "x ~ [x x] ~" form.
 * With multiple variants, <v1 v2 ...> alternates per cycle (variation within a phrase).
 */
const gridSchema = Schema.Struct({
  type: Schema.Literal('grid'),
  variants: Schema.Array(variantSchema).pipe(Schema.minItems(1), Schema.maxItems(4)),
}).pipe(
  Schema.filter(
    (g) =>
      g.variants.every((v) => v.length === g.variants[0]!.length) || 'all variants must have the same number of steps',
  ),
  Schema.filter((g) => g.variants.some(hasHit) || 'a grid whose variants are all silent must use silence instead'),
)

/** Explicit silence (a declaration that the slot is left empty) */
const silenceSchema = Schema.Struct({
  type: Schema.Literal('silence'),
})

const indexVariantSchemaFor = (hi: number) =>
  Schema.Array(Schema.Union(Schema.Number.pipe(Schema.int(), Schema.between(0, hi)), Schema.Literal('~'))).pipe(
    Schema.minItems(2),
    Schema.maxItems(32),
  )

/**
 * Derived schema with a parameterized nsteps upper bound.
 * For grammar constraints at generation time — llama.cpp/Ollama compile an integer maximum into the grammar,
 * so passing an upper bound narrowed from the manifest declaration (nRange/nSet) makes out-of-range values physically unwritable.
 * Acceptance-time validation always uses the static schema (default 127 = same as before)
 */
const nstepsSchemaFor = (hi: number) =>
  Schema.Struct({
    type: Schema.Literal('nsteps'),
    variants: Schema.Array(indexVariantSchemaFor(hi)).pipe(Schema.minItems(1), Schema.maxItems(4)),
  }).pipe(
    Schema.filter(
      (g) =>
        g.variants.every((v) => v.length === g.variants[0]!.length) ||
        'all variants must have the same number of steps',
    ),
    Schema.filter(
      (g) => g.variants.some((v) => v.some((c) => c !== '~')) || 'an nsteps that is all rests must use silence instead',
    ),
  )

/**
 * Sample index sequence (v1): "0 3 ~ 1" form, passed to # n.
 * Rhythm changes from struct alone are easily buried inside a dense existing track,
 * while timbre (index) changes are far more audible.
 * With multiple variants, <v1 v2 ...> alternates per cycle.
 */

export const rhythmSchema = Schema.Union(euclidSchema, gridSchema, silenceSchema)

/** Derived schema with a parameterized samples upper bound (same intent as nstepsSchemaFor) */
const samplesSchemaFor = (hi: number) =>
  Schema.Struct({
    type: Schema.Literal('samples'),
    variants: Schema.Array(indexVariantSchemaFor(hi)).pipe(Schema.minItems(1), Schema.maxItems(4)),
  }).pipe(
    Schema.filter(
      (g) =>
        g.variants.every((v) => v.length === g.variants[0]!.length) ||
        'all variants must have the same number of steps',
    ),
    Schema.filter(
      (g) => g.variants.some((v) => v.some((c) => c !== '~')) || 'a samples that is all rests must use silence instead',
    ),
  )

/**
 * Mixed sample sequence: a type that builds a sequence of sample names such as "bd sn bd lt".
 * The LLM writes only an **index sequence** (same shape as nsteps); conversion to names is done by
 * the manifest vocab declaration + the renderer (renderSamplesNames) —
 * structurally preventing typos and unloaded names. Timing is as before:
 * "one cycle divided evenly by the element count" (4/8/16 elements = quarter/eighth/sixteenth notes).
 * With multiple variants, <v1 v2 ...> alternates per cycle
 */

/** Value bounds of the generation contract (for the dynamic schema). Default = the same loose upper bounds as the static schema */
export interface PlanBounds {
  readonly nMax: number
  readonly sampleMax: number
}

/** v1 slot pattern: structure (euclid/grid), timbre (nsteps), mixed samples (samples), silence */
const patternV1SchemaFor = (bounds: PlanBounds) =>
  Schema.Union(
    euclidSchema,
    gridSchema,
    nstepsSchemaFor(bounds.nMax),
    samplesSchemaFor(bounds.sampleMax),
    silenceSchema,
  )

/** Role of a slot in a v0 pool plan. The pool maps it onto manifest slots by matching role words (brain/pool.ts) */
const roleSchema = Schema.Literal('kick', 'snare', 'hat', 'perc', 'bass', 'stab', 'noise')

const slotPlanSchema = Schema.Struct({
  slot: Schema.Number.pipe(Schema.int(), Schema.between(1, 8)),
  role: roleSchema,
  rhythm: rhythmSchema,
})

export const phrasePlanSchema = Schema.Struct({
  version: Schema.Literal(0),
  /** Energy feel of the phrase, 0 (sparse) to 1 (dense). A generation-time directive, not used for performance */
  energy: Schema.Number.pipe(Schema.between(0, 1)),
  /** Lifetime of the plan (in cycles). Not part of the mini-notation — the Conductor uses it as the replacement period */
  bars: Schema.Literal(1, 2, 4),
  slots: Schema.Array(slotPlanSchema).pipe(Schema.minItems(1), Schema.maxItems(8)),
}).pipe(
  Schema.filter((p) => new Set(p.slots.map((s) => s.slot)).size === p.slots.length || 'slot numbers must be unique'),
)

/** Standard lineup for A/B comparison — shared by both generators and the LLM so that rhythm is the only variable */
export const CORE_ROLES = ['kick', 'hat', 'snare', 'perc'] as const

// --- Plan v1: lengthCycles + nsteps + transition (announced fill) ---

const slotPlanV1SchemaFor = (bounds: PlanBounds) => {
  const pattern = patternV1SchemaFor(bounds)
  return Schema.Struct({
    slot: Schema.Number.pipe(Schema.int(), Schema.between(1, 8)),
    pattern,
    /**
     * Replacement for the last cycle of the phrase (announced fill).
     * The AI → human counterpart of the "declaration" a human session makes
     * one bar before a change. When omitted, the last cycle also plays pattern
     */
    transition: Schema.optional(pattern),
  })
}

/**
 * Generation contract narrowed by per-manifest value bounds (for grammar constraints at generation time only).
 * Do not use it for acceptance-time validation (validation uses the static phrasePlanV1Schema = the loose side,
 * and strict per-slot value checks are the job of planManifestMismatch)
 */
export const phrasePlanV1SchemaFor = (bounds: PlanBounds) =>
  Schema.Struct({
    version: Schema.Literal(1),
    /** Energy feel of the phrase, 0 (sparse) to 1 (dense) */
    energy: Schema.Number.pipe(Schema.between(0, 1)),
    /** Phrase length (in cycles). The quantization unit of application boundaries */
    lengthCycles: Schema.Literal(1, 2, 4, 8),
    slots: Schema.Array(slotPlanV1SchemaFor(bounds)).pipe(Schema.minItems(1), Schema.maxItems(8)),
  }).pipe(
    Schema.filter((p) => new Set(p.slots.map((s) => s.slot)).size === p.slots.length || 'slot numbers must be unique'),
  )

export const phrasePlanV1Schema = phrasePlanV1SchemaFor({
  nMax: 127,
  sampleMax: 63,
})

export type Euclid = Schema.Schema.Type<typeof euclidSchema>
export type Grid = Schema.Schema.Type<typeof gridSchema>
export type Nsteps = Schema.Schema.Type<ReturnType<typeof nstepsSchemaFor>>
export type Samples = Schema.Schema.Type<ReturnType<typeof samplesSchemaFor>>
export type Rhythm = Schema.Schema.Type<typeof rhythmSchema>
export type PatternV1 = Schema.Schema.Type<ReturnType<typeof patternV1SchemaFor>>
export type Role = Schema.Schema.Type<typeof roleSchema>
export type PhrasePlan = Schema.Schema.Type<typeof phrasePlanSchema>
export type SlotPlanV1 = Schema.Schema.Type<ReturnType<typeof slotPlanV1SchemaFor>>
export type PhrasePlanV1 = Schema.Schema.Type<typeof phrasePlanV1Schema>

/** unknown → PhrasePlanV1. Throws ParseError on schema violation */
export const parsePhrasePlanV1 = Schema.decodeUnknownSync(phrasePlanV1Schema)

/**
 * Lift a v0 plan (the initial pool supply) to v1.
 * bars → lengthCycles, rhythm → pattern (no transition)
 */
export const liftPlanV0 = (plan: PhrasePlan): PhrasePlanV1 =>
  parsePhrasePlanV1({
    version: 1,
    energy: plan.energy,
    lengthCycles: plan.bars,
    slots: plan.slots.map((s) => ({ slot: s.slot, pattern: s.rhythm })),
  })

type Step = Schema.Schema.Type<typeof stepSchema>

/** unknown → PhrasePlan. Throws ParseError on schema violation */
export const parsePhrasePlan = Schema.decodeUnknownSync(phrasePlanSchema)

function hasHit(variant: ReadonlyArray<Step>): boolean {
  return variant.some((s) => (Array.isArray(s) ? s.includes('x') : s === 'x'))
}
