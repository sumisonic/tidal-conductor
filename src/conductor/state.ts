import { match } from 'ts-pattern'

// Conductor state model (pure layer).
//
// - The Conductor is the single owner of the AI state. The Tidal side only reads it
// - No notion of song or player. One manifest is fixed at startup, and the state is
//   determined by the knobs and the clock alone
// - Density knob 0 is the kill switch: on the falling edge it fires a one-shot silencing of all slots

export interface ConductorState {
  /** Current value of the stochastic walk (sent to the density key) */
  readonly density: number
  /**
   * Density desire knob (/ai/knob density). Acts as the mean-reversion center of the walk.
   * null = knob not yet received (treated as center 0.5). 0 is the kill switch (forced ceiling 0)
   */
  readonly knobDensity: number | null
  /** Freedom knob (/ai/knob freedom). Scales the step size of the walk. Default 0.5 */
  readonly freedom: number
  /** Freeze knob (/ai/knob freeze >= 0.5 is ON). A lock, not a mute */
  readonly frozen: boolean
  /** "Yielding margin" after freeze release: remaining walk ticks (stay conservative while > 0) */
  readonly easeTicksLeft: number
  readonly cycle: number | null
  readonly cps: number | null
  /** For display: the last observed input */
  readonly lastInput: string | null
}

export type InEvent =
  | { readonly _tag: 'Cycle'; readonly cycle: number; readonly cps: number }
  /** /ai/ctrl — mirror of the human performer's controls (auxiliary signal for activity estimation; optional wiring) */
  | { readonly _tag: 'Ctrl'; readonly key: string; readonly value: number }
  | { readonly _tag: 'Knob'; readonly name: string; readonly value: number }

/** Instruction to the execution layer: silence all slots via the kill switch */
type Command = { readonly _tag: 'Silence'; readonly reason: 'kill' }

/** Density knob values at or below this count as the kill switch (forced ceiling 0) */
const KILL_EPS = 0.01

/** Number of walk ticks to resume conservatively after freeze release (2 s/tick × 8 ≈ 2 phrases) */
const EASE_TICKS = 8

export const initialState: ConductorState = {
  density: 0,
  knobDensity: null,
  freedom: 0.5,
  frozen: false,
  easeTicksLeft: 0,
  cycle: null,
  cps: null,
  lastInput: null,
}

/** Whether the kill switch is engaged (density knob sits at 0) */
export const isKilled = (state: ConductorState): boolean => state.knobDensity !== null && state.knobDensity <= KILL_EPS

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

type Step = readonly [ConductorState, ReadonlyArray<Command>]

export const reduce = (state: ConductorState, event: InEvent): Step =>
  match<InEvent, Step>(event)
    .with({ _tag: 'Cycle' }, ({ cycle, cps }) => [{ ...state, cycle, cps }, []])
    .with({ _tag: 'Ctrl' }, ({ key, value }) => [{ ...state, lastInput: `${key}=${value.toFixed(2)}` }, []])
    .with({ _tag: 'Knob' }, ({ name, value }) =>
      match<string, Step>(name)
        .with('density', () => {
          // Reflex layer: the desired density is the mean-reversion center of the walk. 0 is the kill switch
          // (forced ceiling 0 — fires silencing of all slots on the falling edge)
          const v = clamp01(value)
          const killing = v <= KILL_EPS && !isKilled(state)
          const next: ConductorState = {
            ...state,
            knobDensity: v,
            density: v <= KILL_EPS ? 0 : state.density,
            lastInput: `knob:density=${v.toFixed(2)}`,
          }
          return [next, killing ? [{ _tag: 'Silence', reason: 'kill' }] : []]
        })
        .with('freedom', () => [
          {
            ...state,
            freedom: clamp01(value),
            lastInput: `knob:freedom=${clamp01(value).toFixed(2)}`,
          },
          [],
        ])
        .with('freeze', () => {
          // A lock, not a mute. The falling edge of release starts the yielding margin
          const on = value >= 0.5
          const releasing = state.frozen && !on
          return [
            {
              ...state,
              frozen: on,
              easeTicksLeft: releasing ? EASE_TICKS : state.easeTicksLeft,
              lastInput: `knob:freeze=${on ? 'ON' : 'OFF'}`,
            },
            [],
          ]
        })
        .otherwise(() => [{ ...state, lastInput: `knob:${name}=${value.toFixed(2)}` }, []]),
    )
    .exhaustive()
