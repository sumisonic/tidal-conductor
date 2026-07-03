import { generateText, jsonSchema, Output } from 'ai'
import { google } from '@ai-sdk/google'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { Duration, Effect, Either, JSONSchema, Schema } from 'effect'
import { match } from 'ts-pattern'
import { phrasePlanV1Schema, phrasePlanV1SchemaFor, type PhrasePlanV1, type PlanBounds } from '../../schema.js'
import { renderPlanV1 } from '../../render.js'
import { planManifestMismatch, type Manifest } from '../manifest.js'
import { feedbackBlocks, mergedAvoid, sanitizePlanAvoid, type FeedbackMap } from '../vetoMemory.js'
import type { Brain, BrainContext } from './types.js'

// api Brain: real-time generation through an LLM API.
// The Vercel AI SDK abstracts the provider (google/anthropic/openai) and absorbs the
// differences between the three structured-output mechanisms (responseSchema / tool use / json_schema).
// The output contract is one JSON Schema derived from the Effect Schema (single source of truth),
// double-checked on receipt with parsePhrasePlanV1 (some filters have no JSON Schema form).
// Deadline overruns, API outages and missing keys are handled by the caller (index.ts),
// which degrades to pool → offline.

export type ApiProvider = 'google' | 'anthropic' | 'openai'

export const parseApiProvider = (v: string | undefined): ApiProvider =>
  v === 'anthropic' || v === 'openai' || v === 'google' ? v : 'google'

/** Each provider's standard env var (same names the AI SDK reads). Missing = warned at startup, degraded on call */
export const API_KEY_ENV: Readonly<Record<ApiProvider, string>> = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
}

/** Default model per provider (a low-latency tier, chosen for the ~4.5 s deadline; override with AI_BRAIN_MODEL) */
export const API_DEFAULT_MODEL: Readonly<Record<ApiProvider, string>> = {
  google: 'gemini-2.5-flash',
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4.1-mini',
}

export const hasApiKey = (provider: ApiProvider): boolean => (process.env[API_KEY_ENV[provider]] ?? '') !== ''

const modelFor = (provider: ApiProvider, model: string) =>
  match(provider)
    .with('google', () => google(model))
    .with('anthropic', () => anthropic(model))
    .with('openai', () => openai(model))
    .exhaustive()

/**
 * Provider options for the latency discipline (deadline ≈ 4.5 s).
 * gemini-2.5 models have "thinking" enabled by default; it eats the output-token budget and
 * turned into 8–10 s + "No output" in the smoke test, so it is switched off explicitly.
 */
const providerOptionsFor = (provider: ApiProvider) =>
  match(provider)
    .with('google', () => ({
      google: {
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      },
    }))
    .with('anthropic', () => ({}))
    .with('openai', () => ({}))
    .exhaustive()

const PLAN_JSON_SCHEMA = JSONSchema.make(phrasePlanV1Schema)

// Validation on receipt always uses the static (looser) schema; only the generation grammar is narrowed per manifest
const decodePlan = Schema.decodeUnknownEither(phrasePlanV1Schema)

/**
 * Narrow the generation contract's value ranges from the manifest declarations.
 * llama.cpp/Ollama compile integer `maximum` into the grammar, so out-of-range indexes become
 * physically impossible to generate (verified on hardware). The schema is one per plan, so the
 * bound is the manifest's largest allowed value (a coarse bound); per-slot strictness is still
 * enforced by planManifestMismatch. Slots without a declared range fall back to the loose default.
 */
export const planBoundsFor = (manifest: Manifest): PlanBounds => {
  const nMaxes = manifest.slots
    .filter((s) => s.generator === 'nsteps')
    .map((s) => (s.nSet !== undefined ? Math.max(...s.nSet) : s.nRange !== undefined ? s.nRange[1] : 127))
  const sampleMaxes = manifest.slots.filter((s) => s.generator === 'samples').map((s) => (s.vocab?.length ?? 64) - 1)
  return {
    nMax: nMaxes.length > 0 ? Math.max(...nMaxes) : 127,
    sampleMax: sampleMaxes.length > 0 ? Math.max(...sampleMaxes) : 63,
  }
}

const isNumericEnum = (v: unknown): v is ReadonlyArray<number> =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number')

/**
 * Google's legacy response_schema only accepts string enum values (numeric enums return HTTP 400).
 * Rewrite numeric enums into "integer/number type + allowed values in the description".
 * Strictness is preserved by the double validation on receipt (parsePhrasePlanV1), so this is safe.
 */
export const toGoogleSafeSchema = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(toGoogleSafeSchema)
  if (typeof node !== 'object' || node === null) return node
  const o = node as Readonly<Record<string, unknown>>
  const nums = o['enum']
  const rewritten = isNumericEnum(nums)
    ? {
        ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'enum')),
        type: nums.every((n) => Number.isInteger(n)) ? 'integer' : 'number',
        description: [o['description'], `allowed values: ${nums.join(' | ')}`]
          .filter((d): d is string => typeof d === 'string' && d !== '')
          .join(' — '),
      }
    : o
  return Object.fromEntries(Object.entries(rewritten).map(([k, v]) => [k, toGoogleSafeSchema(v)]))
}

/** Schema for the AI SDK: JSON Schema (generation contract) + Effect Schema (double validation on receipt).
 * Shared with the local Brain (googleSafe = false). With bounds, the generation contract's index
 * maximums are narrowed per manifest (validation stays static = the loose side) */
export const makePlanSchema = (googleSafe: boolean, bounds?: PlanBounds) => {
  const jsonContract = bounds === undefined ? PLAN_JSON_SCHEMA : JSONSchema.make(phrasePlanV1SchemaFor(bounds))
  return jsonSchema<PhrasePlanV1>((googleSafe ? toGoogleSafeSchema(jsonContract) : jsonContract) as never, {
    validate: (value) =>
      Either.match(decodePlan(value), {
        onLeft: (e) => ({
          success: false as const,
          error: new Error(String(e)),
        }),
        onRight: (v) => ({ success: true as const, value: v }),
      }),
  })
}

/** Cached per-manifest schema builder (the manifest is fixed for the whole run) */
export const makePlanSchemaCache = (googleSafe: boolean) => {
  const cache = new Map<string, ReturnType<typeof makePlanSchema>>()
  return (manifest: Manifest) => {
    const hit = cache.get(manifest.id)
    if (hit !== undefined) return hit
    const made = makePlanSchema(googleSafe, planBoundsFor(manifest))
    cache.set(manifest.id, made)
    return made
  }
}

const STYLE_RULES = `
- Keep euclid denominators to 8 or 16. Prefer alternating rotations [a,b] over a fixed rotation.
- When raising density, keep the placement regular rather than adding scattered hits.
- Snare-like roles stay sparse. Build development with alternating variants or a transition (the announced fill on the last cycle).
- Do not create too many moments where every slot hits at once; the offsets are the point.
- When allowTransition is false, do not include transitions.
- When humanActivity is high (the human is busy with the controls), change less from lastPlan.
- history lists this session's recent phrases, oldest first. Reading feedback:
  mark = the performer liked this shape (you may develop its vocabulary),
  kill = a shape after which the performer stopped playback immediately (avoid similar shapes for a while),
  veto = the performer rejected this shape (the sound continues; move to a different vocabulary next),
  freeze = a request for stillness (change little right after).
  Without feedback, lean towards the flow so far (tonight's vocabulary) while trying new shapes
  within desire and freedom; the further into the set, the more you lean on the flow.`

// BPM is intentionally absent from the prompt: patterns are written cycle-relative, so a
// tempo-independent description is the correct one.
export const SYSTEM_PROMPT =
  `You are a session musician in a TidalCycles live set. Return the rhythm plan (JSON) for the next phrase. ` +
  `Follow each slot's generator and role (struct = rhythm structure, ` +
  `nsteps = an index sequence within nRange/nSet, samples = an index sequence into vocab; never write names). ` +
  `desire is the target density; freedom is how far you may deviate (when low, move only slightly from lastPlan).` +
  STYLE_RULES

/** Generation prompt (exported for tests). history is the source of in-context adaptation.
 * style is omitted when the manifest has none (undefined is dropped by JSON.stringify) */
export const buildPrompt = (ctx: BrainContext): string =>
  JSON.stringify({
    manifest: ctx.manifest.id,
    style: ctx.manifest.style,
    // samples slots get an explicit maxIndex: asking a small model to count the vocab array makes
    // it write an out-of-range index about one time in ten. Give it a field it can read without counting.
    slots: ctx.manifest.slots.map((s) => (s.vocab === undefined ? s : { ...s, maxIndex: s.vocab.length - 1 })),
    desire: ctx.desire,
    freedom: ctx.freedom,
    lengthCycles: ctx.lengthCycles,
    allowTransition: ctx.allowTransition,
    humanActivity: ctx.activity,
    history: ctx.history.map((h) => ({
      cycle: h.atCycle,
      desire: h.desire,
      by: h.usedMode,
      feedback: h.feedback,
      slots: Object.fromEntries(h.slots.map((s) => [s.slot, s.pattern])),
    })),
    lastPlanRendered:
      ctx.lastPlan === null
        ? null
        : renderPlanV1(ctx.lastPlan).map((s) => ({
            slot: s.slot,
            pattern: s.pattern,
          })),
  })

export interface ApiBrainConfig {
  readonly provider: ApiProvider
  /** null = the provider's default model (API_DEFAULT_MODEL) */
  readonly model: string | null
  readonly timeoutMs: number
  /**
   * Shared "shapes to avoid" (used by the api-smoke veto-compliance test). Omitted = nothing injected.
   * The format is owned by vetoBlock.
   */
  readonly avoid?: ReadonlyArray<string>
  /**
   * Per-manifest feedback: veto / mark summarised at startup from the distilled file and the
   * session logs. Only ctx.manifest.id's block is added to the system prompt, so the text stays
   * constant for the whole run (keeps prefix caching effective). Omitted = nothing injected.
   */
  readonly feedback?: FeedbackMap
  /**
   * Strict mode for training-data generation: an avoid violation is rejected as a whole even when
   * it is only in a transition (no partial degradation). Training on the lenient behaviour would
   * make "drop the fill" look like a correct answer and push the model towards timidity.
   */
  readonly strictAvoid?: boolean
}

export const resolveApiModel = (config: ApiBrainConfig): string => config.model ?? API_DEFAULT_MODEL[config.provider]

export const makeApiBrain = (config: ApiBrainConfig): Brain => {
  const model = resolveApiModel(config)
  const label = `api brain(${config.provider}/${model})`
  // Per-manifest system prompt: shared avoid + that manifest's veto/mark
  const systemFor = (id: string): string => SYSTEM_PROMPT + feedbackBlocks(config.avoid ?? [], config.feedback?.[id])
  // Per-manifest schema: narrow the value ranges in the grammar
  const planSchemaOf = makePlanSchemaCache(config.provider === 'google')
  const nextPlan = (ctx: BrainContext): Effect.Effect<PhrasePlanV1, Error> =>
    Effect.tryPromise({
      try: async (signal) => {
        const res = await generateText({
          model: modelFor(config.provider, model),
          output: Output.object({
            schema: planSchemaOf(ctx.manifest),
            name: 'phrase_plan',
            description: 'Rhythm plan for the next phrase',
          }),
          system: systemFor(ctx.manifest.id),
          prompt: buildPrompt(ctx),
          maxOutputTokens: 1500,
          providerOptions: providerOptionsFor(config.provider),
          abortSignal: signal,
        })
        // Manifest consistency (e.g. nsteps in a struct slot) cannot be expressed in the schema; violations degrade
        const mismatch = planManifestMismatch(res.output, ctx.manifest)
        if (mismatch !== null) throw new Error(`manifest mismatch: ${mismatch}`)
        // Vetoed shapes are not left to the model's self-restraint: a vetoed transition is removed
        // (partial degradation); a vetoed main pattern discards the whole plan
        const sanitized = sanitizePlanAvoid(
          res.output,
          mergedAvoid(config.avoid ?? [], config.feedback?.[ctx.manifest.id]),
        )
        if (sanitized === null) throw new Error('avoid violation (a vetoed shape in a main pattern; plan discarded)')
        if (sanitized !== res.output) {
          if (config.strictAvoid === true) throw new Error('avoid violation (transition; discarded in strict mode)')
          console.warn('[ai] removed a vetoed transition (partial degradation; the main plan is kept)')
        }
        return sanitized
      },
      catch: (e) => new Error(`${label}: ${e}`),
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(config.timeoutMs),
        onTimeout: () => new Error(`${label}: deadline exceeded (${config.timeoutMs}ms)`),
      }),
    )
  // mode must be exactly "api" (the conductor compares it with config.brainMode for degradation notices)
  return { mode: 'api', nextPlan }
}
