import type { PhrasePlanV1 } from '../schema.js'
import { renderPlanV1WithVocab } from '../render.js'
import { aiKey, type Channel } from './channel.js'
import type { Manifest } from './manifest.js'
import { isKilled, type ConductorState } from './state.js'
import { msUntilCycle, nextBoundary, pllEstimate, pllUsable, type Pll } from './pll.js'

// Application scheduler (pure layer).
// Implemented as the pure function planTick, which receives the time (nowMs) and the PLL as arguments;
// the execution layer (conductor.ts) just calls it every 100 ms and executes the resulting Actions.
//
// Timing conventions:
// - Plans are sent sendAheadMs before the phrase boundary (default 375 ms — assumes Tidal's
//   cProcessAhead ≈ 0.3 s. Environments that change it in BootTidal should match via AI_SEND_AHEAD_MS)
// - The Brain is asked at least the lead ahead of the application boundary. Boundaries that fall short of
//   the lead are skipped, as many as needed (even at high cps where a phrase is shorter than the lead,
//   the next reachable boundary is chosen).
//   The lead defaults to 5 s (adjustable via AI_BRAIN_LEAD_MS / ConductorConfig.brainLeadMs)
// - Brain calls are debounced by 2 s and tracked by generation (a clock rewind discards stale plans)
// - Phrase boundaries are multiples of lengthCycles on the absolute cycle
// - The transition (announced fill) is held as a reservation separate from the main plan. Even while a fill
//   is reserved, the request and reservation of the next phrase's main plan proceed (the fill does not
//   linger into the next phrase)

interface Send {
  readonly key: string
  readonly value: string
}

/** Send reservation for the main plan */
export interface PendingApply {
  readonly targetCycle: number
  readonly sends: ReadonlyArray<Send>
  /** Transition (announced fill) sent on the last cycle of the phrase (empty if none) */
  readonly transitionSends: ReadonlyArray<Send>
  readonly plan: PhrasePlanV1
}

/** Send reservation for the transition (sent on the last cycle, after the main plan is applied) */
interface PendingTransition {
  readonly targetCycle: number
  readonly sends: ReadonlyArray<Send>
}

export interface SchedState {
  /** Incremented on every clock rewind (resetCycles). Used to detect stale in-flight Brain results */
  readonly generation: number
  readonly pending: PendingApply | null
  readonly pendingTransition: PendingTransition | null
  readonly current: PhrasePlanV1 | null
  readonly requestedFor: number | null
  readonly lastRequestMs: number
}

export const schedInit: SchedState = {
  generation: 0,
  pending: null,
  pendingTransition: null,
  current: null,
  requestedFor: null,
  lastRequestMs: 0,
}

export type SchedAction =
  | {
      readonly _tag: 'RequestPlan'
      readonly generation: number
      readonly targetCycle: number
      readonly lengthCycles: 1 | 2 | 4 | 8
    }
  | { readonly _tag: 'SendPatterns'; readonly sends: ReadonlyArray<Send> }
  | {
      /** For the session log: the main plan was applied (not emitted for transition sends) */
      readonly _tag: 'PlanApplied'
      readonly plan: PhrasePlanV1
      readonly targetCycle: number
    }
  | { readonly _tag: 'Log'; readonly msg: string }

export interface SchedConfig {
  readonly sendAheadMs: number // 375
  readonly brainDeadlineMs: number // default 5000 = request lead (overridden by AI_BRAIN_LEAD_MS)
  readonly brainDebounceMs: number // 2000
}

export const schedDefaults: SchedConfig = {
  sendAheadMs: 375,
  brainDeadlineMs: 5000,
  brainDebounceMs: 2000,
}

/**
 * Convert the plan returned by the Brain into a send reservation. The manifest is used to resolve the
 * vocab (index → sample name) of samples slots.
 * Manifest slots absent from the plan are sent "~" to clear them explicitly — even if the Brain omits a
 * slot, the previous phrase's pattern does not linger (structural safety).
 * samples without a vocab fall back to "~" (never fabricate a name)
 */
export const renderSends = (
  channel: Channel,
  plan: PhrasePlanV1,
  targetCycle: number,
  manifest: Manifest,
): PendingApply => {
  const vocabOf = (slot: number): ReadonlyArray<string> | undefined =>
    manifest.slots.find((s) => s.slot === slot)?.vocab
  const rendered = renderPlanV1WithVocab(plan, vocabOf)
  const renderedSlots = new Set(rendered.map((r) => r.slot))
  const missing = manifest.slots.filter((s) => !renderedSlots.has(s.slot)).map((s) => s.slot)
  return {
    targetCycle,
    plan,
    sends: [
      ...rendered.map((r) => ({ key: aiKey(channel, r.slot), value: r.pattern })),
      ...missing.map((slot) => ({ key: aiKey(channel, slot), value: '~' })),
    ],
    transitionSends: rendered.flatMap((r) =>
      r.transition === null ? [] : [{ key: aiKey(channel, r.slot), value: r.transition }],
    ),
  }
}

type Tick = readonly [SchedState, ReadonlyArray<SchedAction>]

/** Clock rewind (new epoch): drop reservations and requests, bump the generation. current (what is sounding) is kept */
export const onClockReset = (sched: SchedState): SchedState => ({
  ...sched,
  generation: sched.generation + 1,
  pending: null,
  pendingTransition: null,
  requestedFor: null,
})

/**
 * The first boundary that satisfies the lead (brainDeadlineMs). If b0 falls short, advance by as many
 * boundaries as the shortfall divided by the phrase length (not just one, but as many as needed)
 */
const targetBoundary = (pll: Pll, b0: number, L: number, nowMs: number, deadlineMs: number): number => {
  const wait = msUntilCycle(pll, b0, nowMs)
  if (wait > deadlineMs) return b0
  const phraseMs = (L / pll.cps) * 1000
  const k = Math.floor((deadlineMs - wait) / phraseMs) + 1
  return b0 + k * L
}

export const planTick = (
  sched: SchedState,
  pll: Pll,
  cond: ConductorState,
  manifest: Manifest,
  nowMs: number,
  cfg: SchedConfig,
): Tick => {
  // Never synced (or cps unknown): nothing can be scheduled. A quiet-but-synced clock keeps going on extrapolation
  if (!pllUsable(pll)) return [sched, []]

  const estimate = pllEstimate(pll, nowMs)

  // While the kill switch or freeze is engaged, plan progression stops (kill has already been silenced by the reducer)
  if (isKilled(cond) || cond.frozen) return [{ ...sched, pending: null, pendingTransition: null }, []]

  // Transition send (independent of the main plan. Send once inside the window; discard if missed by a lot)
  const [afterFill, fillActions]: Tick = ((): Tick => {
    if (sched.pendingTransition === null) return [sched, []]
    const wait = msUntilCycle(pll, sched.pendingTransition.targetCycle, nowMs)
    if (wait <= -1000)
      return [
        { ...sched, pendingTransition: null },
        [{ _tag: 'Log', msg: 'missed the transition boundary — discarded' }],
      ]
    if (wait <= cfg.sendAheadMs)
      return [
        { ...sched, pendingTransition: null },
        [
          { _tag: 'Log', msg: `transition @${sched.pendingTransition.targetCycle}` },
          { _tag: 'SendPatterns', sends: sched.pendingTransition.sends },
        ],
      ]
    return [sched, []]
  })()

  const L = afterFill.current?.lengthCycles ?? manifest.defaultLengthCycles

  // Main send phase: send the reserved plan once it enters the send window
  if (afterFill.pending !== null) {
    const wait = msUntilCycle(pll, afterFill.pending.targetCycle, nowMs)
    if (wait <= -1000) {
      // Missed by a lot (clock jump etc.) — discard and aim for the next one
      return [
        { ...afterFill, pending: null },
        [...fillActions, { _tag: 'Log', msg: 'missed the application boundary — discarded' }],
      ]
    }
    if (wait <= cfg.sendAheadMs) {
      const p = afterFill.pending
      const fill: PendingTransition | null =
        p.transitionSends.length > 0 && p.plan.lengthCycles > 1
          ? { targetCycle: p.targetCycle + p.plan.lengthCycles - 1, sends: p.transitionSends }
          : null
      return [
        { ...afterFill, pending: null, pendingTransition: fill, current: p.plan },
        [
          ...fillActions,
          { _tag: 'Log', msg: `plan applied @${p.targetCycle} (${p.sends.length} slots)` },
          { _tag: 'SendPatterns', sends: p.sends },
          { _tag: 'PlanApplied', plan: p.plan, targetCycle: p.targetCycle },
        ],
      ]
    }
    return [afterFill, fillActions]
  }

  // Request phase: call the Brain aiming at the first boundary reachable within the lead
  const target = targetBoundary(pll, nextBoundary(L, estimate), L, nowMs, cfg.brainDeadlineMs)
  const debounced = nowMs - afterFill.lastRequestMs < cfg.brainDebounceMs
  if (afterFill.requestedFor === target || debounced) return [afterFill, fillActions]
  return [
    { ...afterFill, requestedFor: target, lastRequestMs: nowMs },
    [
      ...fillActions,
      {
        _tag: 'RequestPlan',
        generation: afterFill.generation,
        targetCycle: target,
        lengthCycles: L,
      },
    ],
  ]
}

/**
 * Receive the Brain's result (check generation and deadline, then convert into a reservation).
 * If not accepted, the same state is returned as-is (the caller can decide acceptance by reference identity)
 */
export const onPlanReady = (
  sched: SchedState,
  channel: Channel,
  generation: number,
  targetCycle: number,
  plan: PhrasePlanV1,
  pll: Pll,
  nowMs: number,
  cfg: SchedConfig,
  manifest: Manifest,
): SchedState => {
  if (generation !== sched.generation) return sched // different generation = stale
  if (msUntilCycle(pll, targetCycle, nowMs) <= cfg.sendAheadMs) return sched // too late
  return {
    ...sched,
    pending: renderSends(channel, plan, targetCycle, manifest),
  }
}

/**
 * Kickstart (startup without a clock): plain Tidal only produces clock observations (/dirt/play)
 * while something plays, and the AI slots themselves are silent until the first plan arrives —
 * a chicken-and-egg. When no clock has been seen for kickstartMs after startup, the first plan is
 * sent immediately and unquantized; the AI slots then produce events, the clock starts flowing
 * and the next phrase is quantized normally. The plan is recorded as applied at cycle 0
 * (unknown); no transition is scheduled because no boundary is known
 */
export const kickstart = (sched: SchedState, channel: Channel, plan: PhrasePlanV1, manifest: Manifest): Tick => {
  const rendered = renderSends(channel, plan, 0, manifest)
  return [
    { ...sched, current: plan, pending: null, pendingTransition: null },
    [
      {
        _tag: 'Log',
        msg: `kickstart — no clock after startup, applying the first plan unquantized (${rendered.sends.length} slots)`,
      },
      { _tag: 'SendPatterns', sends: rendered.sends },
      { _tag: 'PlanApplied', plan, targetCycle: 0 },
    ],
  ]
}

// --- Kickstart bookkeeping (pure) ---

/**
 * idle: may fire when due. inFlight: the Brain has been asked. done: no longer needed (a clock was
 * seen while the Brain was thinking) or given up (attempts exhausted). A kill/freeze that arrives
 * while the Brain is thinking aborts the attempt without counting it; it is retried once released
 */
export interface KickstartState {
  readonly phase: 'idle' | 'inFlight' | 'done'
  readonly attempts: number
  /** Not before this wall-clock time (ms) */
  readonly dueMs: number
}

/** A plan that makes no events, or a slot nobody reads, produces no clock: retry a few times, then give up loudly */
export const KICKSTART_MAX_ATTEMPTS = 3

export const kickstartInit = (startedMs: number, kickstartMs: number): KickstartState => ({
  phase: 'idle',
  attempts: 0,
  dueMs: startedMs + kickstartMs,
})

/** Whether a kickstart attempt should start now (kickstartMs 0 disables the mechanism) */
export const kickstartDue = (
  ks: KickstartState,
  pll: Pll,
  cond: ConductorState,
  nowMs: number,
  kickstartMs: number,
): boolean =>
  kickstartMs > 0 &&
  ks.phase === 'idle' &&
  ks.attempts < KICKSTART_MAX_ATTEMPTS &&
  !pllUsable(pll) &&
  !isKilled(cond) &&
  !cond.frozen &&
  nowMs >= ks.dueMs

/** Every attempt was made, the last one has had its time, and there is still no clock: report once */
export const kickstartExhausted = (ks: KickstartState, pll: Pll, nowMs: number): boolean =>
  ks.phase === 'idle' && ks.attempts >= KICKSTART_MAX_ATTEMPTS && !pllUsable(pll) && nowMs >= ks.dueMs

export type KickstartOutcome = 'sent' | 'clockArrived' | 'aborted'

/** Settle an attempt: sent counts and re-arms; aborted (kill/freeze/shutdown) re-arms without counting; clockArrived ends it */
export const kickstartSettle = (
  ks: KickstartState,
  outcome: KickstartOutcome,
  nowMs: number,
  kickstartMs: number,
): KickstartState =>
  outcome === 'clockArrived'
    ? { ...ks, phase: 'done' }
    : outcome === 'aborted'
      ? { ...ks, phase: 'idle', dueMs: nowMs + kickstartMs }
      : { phase: 'idle', attempts: ks.attempts + 1, dueMs: nowMs + kickstartMs }
