import type { Effect } from 'effect'
import type { PhrasePlanV1 } from '../../schema.js'
import type { Manifest } from '../manifest.js'
import type { PhraseRecord } from '../history.js'

// Brain interface.
// The Conductor (execution layer) calls it at least the lead (default 5 s, AI_BRAIN_LEAD_MS)
// ahead of a phrase boundary to obtain the plan for the next phrase. Pluggable: api / offline / pool / local.

export interface BrainContext {
  readonly manifest: Manifest
  /** Density desire (knob, 0..1) */
  readonly desire: number
  /** Freedom knob (0..1) — how far the plan may deviate from the desire and the context */
  readonly freedom: number
  readonly lengthCycles: 1 | 2 | 4 | 8
  readonly lastPlan: PhrasePlanV1 | null
  /** Whether transitions (announced fills) are allowed (manifest.allowTransition, default true) */
  readonly allowTransition: boolean
  /**
   * Estimated human activity (0..1, /ai/ctrl event density over the last 8 s).
   * An **auxiliary signal** in the initiative policy — declarations (freeze/knobs) come first.
   * High = the human is actively operating → the AI keeps changes modest (backs off). Always 0 when not wired
   */
  readonly activity: number
  /**
   * Session history (last N phrases, oldest first) — the source of in-context adaptation.
   * mark = positive example / kill = negative example / freeze = request to hold still.
   * offline/pool currently ignore it (api/local Brains read it as generation context)
   */
  readonly history: ReadonlyArray<PhraseRecord>
}

export interface Brain {
  readonly mode: string
  readonly nextPlan: (ctx: BrainContext) => Effect.Effect<PhrasePlanV1, Error>
}

/** A plan that passed through the degradation chain, plus its provenance (used by the conductor for status/notification) */
export interface BrainResult {
  readonly plan: PhrasePlanV1
  /** The Brain intended for this phrase (in hybrid, api/pool alternate by turn) */
  readonly intended: string
  /** The Brain that actually produced the plan (differs from intended if degraded) */
  readonly usedMode: string
}

export type BrainMode = 'api' | 'offline' | 'pool' | 'local' | 'hybrid'
