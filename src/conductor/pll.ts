// PLL-style clock (pure layer).
//
// Resyncs on the cycle/cps sent by the clock source (the SC snippet etc.) and extrapolates
// from the wall clock in between. Applying /ctrl and the "send 0.35–0.40 s ahead of the boundary"
// for plan application are based on this estimate.
//
// - A backward jump in cycle (resetCycles) simply makes the resync the new reference. The scheduler
//   detects it via isClockReset and re-arms its reservations (new epoch)
// - When observations stop arriving (hush, long rests) the clock is STALE but still usable: the estimate
//   keeps extrapolating with the last cps, indefinitely. Plans written meanwhile count as applied even if
//   nothing is audible — the Conductor cannot know. A tempo change during silence shows up at the next
//   observation as a jump: forward (faster) is an ordinary resync, backward by more than one cycle
//   (slower) is handled as a rewind. Only a clock that was never seen (UNSYNC) blocks scheduling

export interface Pll {
  readonly synced: boolean
  /** Last observed cycle value */
  readonly cycle: number
  readonly cps: number
  /** Observation time (ms) */
  readonly atMs: number
}

export const pllInit: Pll = {
  synced: false,
  cycle: 0,
  cps: 0,
  atMs: 0,
}

/** Resync on a cycle/cps event */
export const pllResync = (pll: Pll, cycle: number, cps: number, nowMs: number): Pll => ({
  synced: true,
  cycle,
  cps: cps > 0 ? cps : pll.cps,
  atMs: nowMs,
})

/** Current estimated cycle (wall-clock extrapolation) */
export const pllEstimate = (pll: Pll, nowMs: number): number => pll.cycle + ((nowMs - pll.atMs) / 1000) * pll.cps

/** Whether the clock has gone quiet (no observation for maxSilenceMs), never synced, or cps is unknown */
export const pllStale = (pll: Pll, nowMs: number, maxSilenceMs = 5000): boolean =>
  !pll.synced || pll.cps <= 0 || nowMs - pll.atMs > maxSilenceMs

/**
 * Whether the clock can be used for scheduling: synced at least once with a known cps.
 * A quiet clock (stale) still counts — the estimate keeps extrapolating with the last cps, so a
 * silent Tidal (hush, long rests) does not stop the phrase machinery. The next observation resyncs;
 * a jump of more than one cycle is handled as a rewind (isClockReset)
 */
export const pllUsable = (pll: Pll): boolean => pll.synced && pll.cps > 0

/** Status label: UNSYNC (never seen a clock) / sync / STALE(Ns) (extrapolating through silence) */
export const pllLabel = (pll: Pll, nowMs: number): string =>
  !pllUsable(pll) ? 'UNSYNC' : pllStale(pll, nowMs) ? `STALE(${Math.round((nowMs - pll.atMs) / 1000)}s)` : 'sync'

/**
 * Whether the clock was rewound (resetCycles etc.): a reset if the new observation is more than
 * 1 cycle behind the estimate. Ordinary jitter (extrapolation vs. observation differs by less than 1 cycle) is not a reset
 */
export const isClockReset = (pll: Pll, cycle: number, nowMs: number): boolean =>
  pll.synced && cycle < pllEstimate(pll, nowMs) - 1

/** Remaining time (ms) until targetCycle. Negative if already past */
export const msUntilCycle = (pll: Pll, targetCycle: number, nowMs: number): number =>
  pll.cps <= 0 ? Number.POSITIVE_INFINITY : ((targetCycle - pllEstimate(pll, nowMs)) / pll.cps) * 1000

/**
 * Next phrase boundary: multiples of lengthCycles on the absolute cycle (phase origin is 0).
 * If estimate sits exactly on a boundary, returns the next one. Works for negative cycles too
 * ("the first multiple after estimate"), since Math.ceil rounds toward 0 and avoids the sign problem of the remainder
 */
export const nextBoundary = (lengthCycles: number, estimate: number): number => {
  const k = Math.ceil(estimate / lengthCycles)
  const b = k * lengthCycles + 0 // + 0 normalizes -0 to +0 (Math.ceil(-0.6) = -0)
  return b > estimate ? b : b + lengthCycles
}
