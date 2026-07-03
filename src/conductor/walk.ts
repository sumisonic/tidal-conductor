import { Effect } from 'effect'
import { uniform } from '../rand.js'
import { clamp01 } from './state.js'

// Stochastic walk: the only "autonomy" of Conductor v0.
// Adds uniform noise of ±step and a weak mean reversion toward center to the
// current density, then clamps to [0,1].
//
// - center is the density desire knob (reflex layer). 0.5 when the knob has not been received
// - The mean reversion is a correction from hardware logs: the naive walk kept bouncing off
//   the wall at 0 after a reset and stayed nearly silent for minutes. With a weak reversion it
//   does not stick to the edges but drifts around the center, occasionally swinging sparse/dense
// The minimal fluctuation until the Brain (plan generation) takes over.

export const walkStep =
  (step: number, pull = 0.15) =>
  (density: number, center = 0.5): Effect.Effect<number> =>
    Effect.map(uniform, (r) => clamp01(density + (r * 2 - 1) * step + pull * (center - density)))
