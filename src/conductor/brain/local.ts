import { generateText, Output } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Duration, Effect } from 'effect'
import type { PhrasePlanV1 } from '../../schema.js'
import { buildPrompt, makePlanSchemaCache, SYSTEM_PROMPT } from './api.js'
import { planManifestMismatch } from '../manifest.js'
import { feedbackBlocks, mergedAvoid, sanitizePlanAvoid, type FeedbackMap } from '../vetoMemory.js'
import type { Brain, BrainContext } from './types.js'

// local Brain (experimental): on-device generation through Ollama's OpenAI-compatible endpoint.
// The point is that "the side that proposes new material" survives a network outage.
// Prompt, output contract and double validation are shared with the api Brain (single source of truth).
// Quality and latency are for you to measure; if the deadline is missed, the caller degrades to pool.
// No model or weights are distributed with this repository: point AI_LOCAL_MODEL at a model you
// trained with the recipe in training/README.md.

export interface LocalBrainConfig {
  /** Ollama's OpenAI-compatible endpoint (default http://127.0.0.1:11434/v1) */
  readonly baseUrl: string
  readonly model: string
  readonly timeoutMs: number
  /** Shared "shapes to avoid" (used by the api-smoke veto-compliance test). Omitted = nothing injected */
  readonly avoid?: ReadonlyArray<string>
  /** Per-manifest feedback. Only ctx.manifest.id's block is injected */
  readonly feedback?: FeedbackMap
}

export const LOCAL_DEFAULT_URL = 'http://127.0.0.1:11434/v1'
// There is deliberately no default model name: local is experimental and AI_LOCAL_MODEL is required.

// Small models trip over schema filters that have no JSON Schema form. Spell out the violations
// seen on hardware (all-rest nsteps, etc.) and show one valid example (local only).
// Exported because the training data (training/) must be built with exactly the production prompt
// (a train/inference prompt mismatch cancels out the fine-tuning).
export const LOCAL_EXTRA_RULES = `

Hard rules (violations fail validation):
- Include every slot declared in the manifest in slots.
- For a slot whose generator is struct use only euclid/grid/silence;
  for nsteps only nsteps/silence;
  for samples only samples/silence (mixing them discards the whole plan).
- nsteps values must lie within nRange (or, if nSet is given, be members of nSet).
- samples values must be indexes no greater than that slot's maxIndex
  (read the declared maxIndex; never assume a familiar value such as 7 — exceeding it discards the whole plan).
- A grid/nsteps/samples made only of "~" is invalid; use {"type":"silence"} for silence.
- transition may be omitted (when in doubt, leave it out).
- Every row of variants must have the same length (8 or 16 recommended).
Example output (shape only; choose values for the context. Slot 4 is a samples slot with maxIndex 2):
{"version":1,"energy":0.5,"lengthCycles":4,"slots":[
{"slot":1,"pattern":{"type":"euclid","pulses":3,"steps":8,"rotation":[0,2]}},
{"slot":2,"pattern":{"type":"grid","variants":[["x","~","x","~","x","~","x","~"]]}},
{"slot":3,"pattern":{"type":"nsteps","variants":[[0,"~",1,"~",2,"~",0,"~"]]}},
{"slot":4,"pattern":{"type":"samples","variants":[[0,"~",2,"~",1,"~",2,"~"]]}}]}`

export const makeLocalBrain = (config: LocalBrainConfig): Brain => {
  const provider = createOpenAICompatible({
    name: 'ollama',
    baseURL: config.baseUrl,
    // Ollama accepts JSON Schema enforcement (response_format) on /v1 as well.
    // Without this flag the SDK sends no schema and free-form text keeps failing validation.
    supportsStructuredOutputs: true,
  })
  // Per-manifest schema: Ollama compiles integer maximums into the grammar, so out-of-range
  // indexes become physically impossible to generate (verified on hardware)
  const planSchemaOf = makePlanSchemaCache(false)
  const label = `local brain(${config.model} @ ${config.baseUrl})`
  // Same order as the training data (src/training/dataset.ts): SYSTEM + small-model rules +
  // veto block (+ preferred shapes). Constant for the whole run, so the prefix cache holds
  const systemFor = (id: string): string =>
    SYSTEM_PROMPT + LOCAL_EXTRA_RULES + feedbackBlocks(config.avoid ?? [], config.feedback?.[id])
  const nextPlan = (ctx: BrainContext): Effect.Effect<PhrasePlanV1, Error> =>
    Effect.tryPromise({
      try: async (signal) => {
        const res = await generateText({
          model: provider(config.model),
          output: Output.object({
            schema: planSchemaOf(ctx.manifest),
            name: 'phrase_plan',
            description: 'Rhythm plan for the next phrase',
          }),
          system: systemFor(ctx.manifest.id),
          prompt: buildPrompt(ctx),
          maxOutputTokens: 1500,
          abortSignal: signal,
        })
        // Manifest consistency (nsteps in a struct slot, etc.): 1B-class models trip over this often
        const mismatch = planManifestMismatch(res.output, ctx.manifest)
        if (mismatch !== null) throw new Error(`manifest mismatch: ${mismatch}`)
        // Vetoed shapes are not left to the model's self-restraint: a vetoed transition is removed
        // (partial degradation); a vetoed main pattern discards the whole plan
        const sanitized = sanitizePlanAvoid(
          res.output,
          mergedAvoid(config.avoid ?? [], config.feedback?.[ctx.manifest.id]),
        )
        if (sanitized === null) throw new Error('avoid violation (a vetoed shape in a main pattern; plan discarded)')
        if (sanitized !== res.output)
          console.warn('[ai] removed a vetoed transition (partial degradation; the main plan is kept)')
        return sanitized
      },
      catch: (e) => new Error(`${label}: ${e}`),
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(config.timeoutMs),
        onTimeout: () => new Error(`${label}: deadline exceeded (${config.timeoutMs}ms)`),
      }),
    )
  return { mode: 'local', nextPlan }
}
