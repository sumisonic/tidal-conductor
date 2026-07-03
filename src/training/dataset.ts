import { Effect, Either, Schema } from 'effect'
import { buildPrompt, SYSTEM_PROMPT } from '../conductor/brain/api.js'
import { LOCAL_EXTRA_RULES } from '../conductor/brain/local.js'
import { markBlock, vetoBlock } from '../conductor/vetoMemory.js'
import type { BrainContext } from '../conductor/brain/types.js'
import { uniform, runSeeded } from '../rand.js'
import { renderPatternV1 } from '../render.js'
import type { PhrasePlanV1 } from '../schema.js'
import { phrasePlanV1Schema } from '../schema.js'

// Training data formatting.
// The output is chat-format JSONL readable by mlx-lm / Unsloth ({"messages": [...]}).
//
// The system prompt must match exactly what the local Brain serves in production (SYSTEM_PROMPT + LOCAL_EXTRA_RULES +
// vetoBlock + markBlock) — if the prompt differs between training and inference,
// the fine-tuning gain is cancelled out by the distribution shift.
// Mixing in samples with avoid / liked teaches the skill "follow the list if present / lean toward it"
// (the contents of veto / mark are not baked in — they are swapped at runtime every time, being manifest-specific).

export const trainingSystemPrompt = (avoid: ReadonlyArray<string>, liked: ReadonlyArray<string> = []): string =>
  SYSTEM_PROMPT + LOCAL_EXTRA_RULES + vetoBlock(avoid) + markBlock(liked)

export const TRAINING_SYSTEM_PROMPT = trainingSystemPrompt([])

interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** One line of raw.jsonl. messages (for training) + metadata for validation and aggregation */
export interface RawSample {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly seed: number
  readonly meta: {
    readonly manifest: string
    readonly desire: number
    readonly freedom: number
    readonly historyLen: number
  }
  /** The "shapes to avoid" injected into this sample (empty = equivalent to a session without vetoes) */
  readonly avoid: ReadonlyArray<string>
  /** The "liked shapes" injected into this sample (empty = no marks) */
  readonly liked: ReadonlyArray<string>
  readonly messages: ReadonlyArray<ChatMessage>
  /** For the parseBP gate: struct-like (validated as Pattern Bool) */
  readonly boolPats: ReadonlyArray<string>
  /** For the parseBP gate: nsteps-like (validated as Pattern Note) */
  readonly notePats: ReadonlyArray<string>
}

export const toRawSample = (args: {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly seed: number
  readonly ctx: BrainContext
  readonly avoid: ReadonlyArray<string>
  readonly liked: ReadonlyArray<string>
  readonly plan: PhrasePlanV1
}): RawSample => {
  const rendered = args.plan.slots.flatMap((s) =>
    [s.pattern, ...(s.transition === undefined ? [] : [s.transition])].map((p) => ({
      // The index form of samples is also a numeric sequence = validated as Note
      // (the name form never appears in training data — the model writes only indices)
      note: p.type === 'nsteps' || p.type === 'samples',
      text: renderPatternV1(p),
    })),
  )
  return {
    id: args.id,
    provider: args.provider,
    model: args.model,
    seed: args.seed,
    meta: {
      manifest: args.ctx.manifest.id,
      desire: args.ctx.desire,
      freedom: args.ctx.freedom,
      historyLen: args.ctx.history.length,
    },
    avoid: args.avoid,
    liked: args.liked,
    messages: [
      { role: 'system', content: trainingSystemPrompt(args.avoid, args.liked) },
      { role: 'user', content: buildPrompt(args.ctx) },
      { role: 'assistant', content: JSON.stringify(args.plan) },
    ],
    boolPats: rendered.filter((r) => !r.note).map((r) => r.text),
    notePats: rendered.filter((r) => r.note).map((r) => r.text),
  }
}

/** Deterministic shuffle split. valid takes the head (ratio, rounded up), the rest is train */
export const splitDataset = <T>(
  samples: ReadonlyArray<T>,
  validRatio: number,
  seed: number,
): { readonly train: ReadonlyArray<T>; readonly valid: ReadonlyArray<T> } => {
  const keys = runSeeded(seed, Effect.all(samples.map(() => uniform)))
  const shuffled = samples
    .map((s, i) => ({ s, k: keys[i]! }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.s)
  const nValid = Math.min(samples.length, Math.ceil(samples.length * validRatio))
  return { train: shuffled.slice(nValid), valid: shuffled.slice(0, nValid) }
}

const decodePlan = Schema.decodeUnknownEither(phrasePlanV1Schema)

/** Recover the plan from the assistant message (for aggregation; a broken line gives null) */
export const planOf = (sample: RawSample): PhrasePlanV1 | null => {
  const assistant = sample.messages.find((m) => m.role === 'assistant')
  if (assistant === undefined) return null
  const parsed = Either.try(() => JSON.parse(assistant.content) as unknown)
  if (Either.isLeft(parsed)) return null
  return Either.match(decodePlan(parsed.right), {
    onLeft: () => null,
    onRight: (p) => p,
  })
}

const countBy = <T>(xs: ReadonlyArray<T>, keyOf: (x: T) => string): Readonly<Record<string, number>> =>
  xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [keyOf(x)]: (acc[keyOf(x)] ?? 0) + 1 }), {})

/**
 * Diversity metrics — a watch for the vocabulary collapsing under overfitting.
 * Reported as distributions so that "uncovered regions" are visible
 */
export const metricsOf = (samples: ReadonlyArray<RawSample>) => {
  const plans = samples.map(planOf).filter((p): p is PhrasePlanV1 => p !== null)
  const patterns = plans.flatMap((p) => p.slots.map((s) => s.pattern))
  const euclids = patterns.flatMap((p) => (p.type === 'euclid' ? [p] : []))
  const energyBand = (e: number): string => (e < 1 / 3 ? 'low' : e < 2 / 3 ? 'mid' : 'high')
  return {
    samples: samples.length,
    decodablePlans: plans.length,
    patternTypes: countBy(patterns, (p) => p.type),
    euclidSteps: countBy(euclids, (e) => String(e.steps)),
    energyBands: countBy(plans, (p) => energyBand(p.energy)),
    lengthCycles: countBy(plans, (p) => String(p.lengthCycles)),
    transitionRate:
      plans.length === 0
        ? 0
        : plans.filter((p) => p.slots.some((s) => s.transition !== undefined)).length / plans.length,
    manifests: countBy(samples, (s) => s.meta.manifest),
    // Watch against memorizing slot layouts: the ratio of synthetic manifests (gen-*) and the ratio with avoid
    syntheticManifestRate:
      samples.length === 0 ? 0 : samples.filter((s) => s.meta.manifest.startsWith('gen-')).length / samples.length,
    avoidRate: samples.length === 0 ? 0 : samples.filter((s) => (s.avoid ?? []).length > 0).length / samples.length,
    likedRate: samples.length === 0 ? 0 : samples.filter((s) => (s.liked ?? []).length > 0).length / samples.length,
    historyLens: countBy(samples, (s) => (s.meta.historyLen === 0 ? '0 (set start)' : String(s.meta.historyLen))),
  }
}
