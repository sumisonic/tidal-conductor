import { describe, expect, it } from 'vitest'
import { parsePhrasePlanV1, type PhrasePlanV1 } from '../src/schema.js'
import type { Manifest } from '../src/conductor/manifest.js'
import { initialState, type ConductorState } from '../src/conductor/state.js'
import { pllInit, pllResync } from '../src/conductor/pll.js'
import {
  kickstart,
  kickstartDue,
  kickstartExhausted,
  kickstartInit,
  kickstartSettle,
  KICKSTART_MAX_ATTEMPTS,
  onClockReset,
  onPlanReady,
  planTick,
  renderSends,
  schedDefaults,
  schedInit,
  type SchedState,
} from '../src/conductor/scheduler.js'

// Fixed scenario: cycle 100 @ t=10s, cps 0.5 (1 cycle = 2 s).
// Phrase length 4 → boundary 104 is at real time t=18s (phase origin is absolute cycle 0).
// On hardware cycle events keep arriving and the PLL keeps resyncing, so the tests
// also use a PLL "already resynced at that time" (never let it go stale).

const pllAt = (nowMs: number) => pllResync(pllInit, 100 + (nowMs - 10_000) * 0.0005, 0.5, nowMs)
const pll = pllAt(10_000)

const manifest: Manifest = {
  id: 'example',
  defaultLengthCycles: 4,
  slots: [
    { slot: 1, generator: 'struct', role: 'perc' },
    { slot: 2, generator: 'struct', role: 'hat' },
    { slot: 3, generator: 'nsteps', role: 'hat n', nRange: [0, 7] },
  ],
}

const playing: ConductorState = initialState

const plan: PhrasePlanV1 = parsePhrasePlanV1({
  version: 1,
  energy: 0.5,
  lengthCycles: 4,
  slots: [
    {
      slot: 1,
      pattern: { type: 'euclid', pulses: 3, steps: 8 },
      transition: { type: 'euclid', pulses: 5, steps: 8 },
    },
    { slot: 2, pattern: { type: 'grid', variants: [['x', '~', 'x', '~']] } },
    { slot: 3, pattern: { type: 'nsteps', variants: [[0, '~', 3, 1]] } },
  ],
})

const tickAt = (sched: SchedState, nowMs: number, cond: ConductorState = playing) =>
  planTick(sched, pllAt(nowMs), cond, manifest, nowMs, schedDefaults)

describe('planTick', () => {
  it('emits RequestPlan for the boundary reachable within the deadline (multiple of the absolute cycle)', () => {
    const [st, actions] = tickAt(schedInit, 10_000)
    expect(st.generation).toBe(0)
    const req = actions.find((a) => a._tag === 'RequestPlan')
    expect(req).toMatchObject({ targetCycle: 104, lengthCycles: 4, generation: 0 })
  })

  it('skips a boundary inside the lead (default 5 s) and aims for the next one', () => {
    // t=15.5s: 2.5 s to boundary 104 < 5 s → aim for 108
    const [, actions] = tickAt(schedInit, 15_500)
    const req = actions.find((a) => a._tag === 'RequestPlan')
    expect(req).toMatchObject({ targetCycle: 108 })
  })

  it('re-requests for the same boundary are suppressed and the debounce works', () => {
    const [st1, a1] = tickAt(schedInit, 10_000)
    expect(a1.some((a) => a._tag === 'RequestPlan')).toBe(true)
    const [, a2] = tickAt(st1, 10_100) // the very next tick
    expect(a2.some((a) => a._tag === 'RequestPlan')).toBe(false)
  })

  it('a synced but quiet clock keeps scheduling on extrapolation (silence does not stop the phrase machinery)', () => {
    // last observation at t=0, cps 0.5; at t=10s the clock is stale (5 s rule) but still usable
    const quiet = pllResync(pllInit, 100, 0.5, 0)
    const [, actions] = planTick(schedInit, quiet, playing, manifest, 10_000, schedDefaults)
    expect(actions.find((a) => a._tag === 'RequestPlan')).toMatchObject({ targetCycle: 108 })
  })

  it('never synced: nothing is scheduled', () => {
    const [st, actions] = planTick(schedInit, pllInit, playing, manifest, 10_000, schedDefaults)
    expect(st).toBe(schedInit)
    expect(actions).toEqual([])
  })

  it('onPlanReady → SendPatterns in the send window (0.375 s ahead), transition reserved for the last cycle', () => {
    const [st1] = tickAt(schedInit, 10_000)
    const ready = onPlanReady(st1, 1, 0, 104, plan, pll, 11_000, schedDefaults, manifest)
    expect(ready.pending?.targetCycle).toBe(104)
    // Still outside the window (t=17s → 1 s left)
    const [st2, a2] = tickAt(ready, 17_000)
    expect(a2.some((a) => a._tag === 'SendPatterns')).toBe(false)
    // Inside the window (t=17.7s → 300 ms left)
    const [st3, a3] = tickAt(st2, 17_700)
    const send = a3.find((a) => a._tag === 'SendPatterns')
    expect(send).toBeDefined()
    expect(send!._tag === 'SendPatterns' && send!.sends).toEqual([
      { key: 'ai/1/1', value: 't(3,8)' },
      { key: 'ai/1/2', value: 't ~ t ~' },
      { key: 'ai/1/3', value: '0 ~ 3 1' },
    ])
    expect(st3.current).toEqual(plan)
    // The transition is held for the last cycle (104 + 4 - 1 = 107) as a reservation separate from the main plan
    expect(st3.pending).toBeNull()
    expect(st3.pendingTransition?.targetCycle).toBe(107)
    expect(st3.pendingTransition?.sends).toEqual([{ key: 'ai/1/1', value: 't(5,8)' }])
    // At t=23.7s (300 ms before 107) the transition is sent and the reservation is cleared (the request proceeds separately)
    const [st4, a4] = tickAt({ ...st3, requestedFor: 108 }, 23_700)
    const send2 = a4.find((a) => a._tag === 'SendPatterns')
    expect(send2!._tag === 'SendPatterns' && send2!.sends).toEqual([{ key: 'ai/1/1', value: 't(5,8)' }])
    expect(st4.pendingTransition).toBeNull()
  })

  it('while a transition is reserved, the next phrase is still requested and applied, and the fill does not linger into the next phrase', () => {
    // Main plan applied at 104 → fill reserved for 107. Meanwhile a request for 108 goes out and the new plan is applied at 108
    const [st1] = tickAt(schedInit, 10_000)
    const ready = onPlanReady(st1, 1, 0, 104, plan, pll, 11_000, schedDefaults, manifest)
    const [applied, aApplied] = tickAt(ready, 17_700)
    expect(aApplied.filter((a) => a._tag === 'PlanApplied')).toHaveLength(1)
    expect(applied.pendingTransition?.targetCycle).toBe(107)
    expect(applied.pending).toBeNull()
    // The next tick while the fill is reserved (t=18.1s, 7.9 s to boundary 108 > lead 5 s) emits a request for 108
    const [requested, aReq] = tickAt({ ...applied, lastRequestMs: 0 }, 18_100)
    expect(aReq.find((a) => a._tag === 'RequestPlan')).toMatchObject({ targetCycle: 108 })
    // Accept the next plan (main reservation and fill reservation coexist)
    const next = parsePhrasePlanV1({
      version: 1,
      energy: 0.3,
      lengthCycles: 4,
      slots: [{ slot: 1, pattern: { type: 'euclid', pulses: 2, steps: 8 } }],
    })
    const ready2 = onPlanReady(requested, 1, 0, 108, next, pllAt(18_200), 18_200, schedDefaults, manifest)
    expect(ready2.pending?.targetCycle).toBe(108)
    expect(ready2.pendingTransition?.targetCycle).toBe(107)
    // t=23.7s: fill sent (no PlanApplied)
    const [afterFill, aFill] = tickAt(ready2, 23_700)
    expect(aFill.find((a) => a._tag === 'SendPatterns')).toMatchObject({ sends: [{ key: 'ai/1/1', value: 't(5,8)' }] })
    expect(aFill.some((a) => a._tag === 'PlanApplied')).toBe(false)
    expect(afterFill.pendingTransition).toBeNull()
    // t=25.7s (300 ms before 108): the new main plan is applied and no fill remains
    const [, aNext] = tickAt(afterFill, 25_700)
    expect(aNext.find((a) => a._tag === 'SendPatterns')).toMatchObject({
      sends: [
        { key: 'ai/1/1', value: 't(2,8)' },
        { key: 'ai/1/2', value: '~' },
        { key: 'ai/1/3', value: '~' },
      ],
    })
    expect(aNext.filter((a) => a._tag === 'PlanApplied')).toHaveLength(1)
  })

  it('at high cps where a phrase is shorter than the lead, skips as many boundaries as needed to satisfy the lead', () => {
    // cps 2 (0.5 s per cycle), L=4 → 2 s per phrase. cycle 100 at t=0. Lead 5 s → 104 (2s) and 108 (4s) are out, 112 (6s)
    const fast = pllResync(pllInit, 100, 2, 10_000)
    const [, actions] = planTick(schedInit, fast, playing, manifest, 10_000, schedDefaults)
    expect(actions.find((a) => a._tag === 'RequestPlan')).toMatchObject({ targetCycle: 112 })
  })

  it('discards a Brain result from a different generation (stale plan after a clock rewind)', () => {
    const reset = onClockReset(schedInit)
    expect(reset.generation).toBe(1)
    const ready = onPlanReady(reset, 1, 0, 104, plan, pll, 11_000, schedDefaults, manifest)
    expect(ready.pending).toBeNull()
  })

  it('onClockReset drops reservations and requests but keeps the sounding current', () => {
    const [st1] = tickAt(schedInit, 10_000)
    const ready = onPlanReady(st1, 1, 0, 104, plan, pll, 11_000, schedDefaults, manifest)
    const [applied] = tickAt(ready, 17_700)
    const reset = onClockReset(applied)
    expect(reset.pending).toBeNull()
    expect(reset.pendingTransition).toBeNull()
    expect(reset.requestedFor).toBeNull()
    expect(reset.current).toEqual(plan)
    expect(reset.generation).toBe(applied.generation + 1)
  })

  it('late Brain results and different generations are discarded, returning the same state by reference (used for acceptance)', () => {
    const [st1] = tickAt(schedInit, 10_000)
    expect(onPlanReady(st1, 1, 0, 104, plan, pllAt(17_800), 17_800, schedDefaults, manifest)).toBe(st1)
    expect(onPlanReady(st1, 1, 99, 104, plan, pll, 11_000, schedDefaults, manifest)).toBe(st1)
    expect(onPlanReady(st1, 1, 0, 104, plan, pll, 11_000, schedDefaults, manifest)).not.toBe(st1)
  })

  it('stops plan progression during kill switch / freeze', () => {
    const [st1] = tickAt(schedInit, 10_000)
    const ready = onPlanReady(st1, 1, 0, 104, plan, pll, 11_000, schedDefaults, manifest)
    const killed: ConductorState = { ...playing, knobDensity: 0 }
    const [st2, a2] = planTick(ready, pllAt(17_700), killed, manifest, 17_700, schedDefaults)
    expect(st2.pending).toBeNull()
    expect(a2.some((a) => a._tag === 'SendPatterns')).toBe(false)
    const frozen: ConductorState = { ...playing, frozen: true }
    const [, a3] = planTick(ready, pllAt(17_700), frozen, manifest, 17_700, schedDefaults)
    expect(a3.some((a) => a._tag === 'SendPatterns')).toBe(false)
  })

  it('sendAheadMs is configurable', () => {
    const cfg = { ...schedDefaults, sendAheadMs: 1000 }
    const [st1] = planTick(schedInit, pllAt(10_000), playing, manifest, 10_000, cfg)
    const ready = onPlanReady(st1, 1, 0, 104, plan, pll, 11_000, cfg, manifest)
    // 900 ms left: outside the window with the default (375) but inside with 1000
    const [, actions] = planTick(ready, pllAt(17_100), playing, manifest, 17_100, cfg)
    expect(actions.some((a) => a._tag === 'SendPatterns')).toBe(true)
  })
})

describe('renderSends', () => {
  const kitManifest: Manifest = {
    id: 'kit',
    defaultLengthCycles: 4,
    slots: [{ slot: 1, generator: 'samples', role: 'kit', vocab: ['bd:0', 'sn:0'] }],
  }
  const kitPlan = parsePhrasePlanV1({
    version: 1,
    energy: 0.5,
    lengthCycles: 4,
    slots: [{ slot: 1, pattern: { type: 'samples', variants: [[0, '~', 1]] } }],
  })

  it('samples slots are sent in vocab name form', () => {
    expect(renderSends(1, kitPlan, 100, kitManifest).sends).toEqual([{ key: 'ai/1/1', value: 'bd:0 ~ sn:0' }])
  })

  it('the channel goes into the key namespace', () => {
    expect(renderSends(3, kitPlan, 100, kitManifest).sends[0]!.key).toBe('ai/3/1')
  })

  it('manifest slots absent from the plan are explicitly cleared with "~" (no lingering)', () => {
    const partial = parsePhrasePlanV1({
      version: 1,
      energy: 0.5,
      lengthCycles: 4,
      slots: [{ slot: 2, pattern: { type: 'euclid', pulses: 3, steps: 8 } }],
    })
    expect(renderSends(1, partial, 100, manifest).sends).toEqual([
      { key: 'ai/1/2', value: 't(3,8)' },
      { key: 'ai/1/1', value: '~' },
      { key: 'ai/1/3', value: '~' },
    ])
  })
})

describe('kickstart', () => {
  it('applies the plan unquantized, fills missing slots with "~", records current and applies once at cycle 0', () => {
    const [st, actions] = kickstart(schedInit, 1, plan, manifest)
    expect(st.current).toEqual(plan)
    expect(st.pending).toBeNull()
    expect(st.pendingTransition).toBeNull()
    const send = actions.find((a) => a._tag === 'SendPatterns')
    expect(send!._tag === 'SendPatterns' && send!.sends.map((s) => s.key)).toEqual(['ai/1/1', 'ai/1/2', 'ai/1/3'])
    expect(actions.find((a) => a._tag === 'PlanApplied')).toMatchObject({ targetCycle: 0 })
    expect(actions.some((a) => a._tag === 'RequestPlan')).toBe(false)
  })
})

describe('kickstart state machine', () => {
  const unsynced = pllInit
  const synced = pllResync(pllInit, 100, 0.5, 10_000)
  const ks0 = kickstartInit(0, 3000)

  it('is due only after kickstartMs, without a clock, and not while killed or frozen', () => {
    expect(kickstartDue(ks0, unsynced, initialState, 2999, 3000)).toBe(false)
    expect(kickstartDue(ks0, unsynced, initialState, 3000, 3000)).toBe(true)
    expect(kickstartDue(ks0, synced, initialState, 3000, 3000)).toBe(false)
    expect(kickstartDue(ks0, unsynced, { ...initialState, knobDensity: 0 }, 3000, 3000)).toBe(false)
    expect(kickstartDue(ks0, unsynced, { ...initialState, frozen: true }, 3000, 3000)).toBe(false)
    expect(kickstartDue(ks0, unsynced, initialState, 3000, 0)).toBe(false) // disabled
    expect(kickstartDue({ ...ks0, phase: 'inFlight' }, unsynced, initialState, 3000, 3000)).toBe(false)
  })

  it('a sent attempt counts and re-arms after kickstartMs; the clock arriving ends it', () => {
    const sent = kickstartSettle({ ...ks0, phase: 'inFlight' }, 'sent', 3100, 3000)
    expect(sent).toEqual({ phase: 'idle', attempts: 1, dueMs: 6100 })
    expect(kickstartDue(sent, unsynced, initialState, 6099, 3000)).toBe(false)
    expect(kickstartDue(sent, unsynced, initialState, 6100, 3000)).toBe(true)
    expect(kickstartSettle({ ...sent, phase: 'inFlight' }, 'clockArrived', 6200, 3000).phase).toBe('done')
  })

  it('an abort (kill/freeze while the Brain was thinking) re-arms without counting', () => {
    const aborted = kickstartSettle({ ...ks0, phase: 'inFlight' }, 'aborted', 3100, 3000)
    expect(aborted).toEqual({ phase: 'idle', attempts: 0, dueMs: 6100 })
    expect(kickstartDue(aborted, unsynced, initialState, 6100, 3000)).toBe(true)
  })

  it('gives up after KICKSTART_MAX_ATTEMPTS and reports exhaustion once the last attempt had its time', () => {
    const spent = Array.from({ length: KICKSTART_MAX_ATTEMPTS }, (_, i) => i).reduce(
      (ks, i) => kickstartSettle({ ...ks, phase: 'inFlight' }, 'sent', 3000 * (i + 1), 3000),
      ks0,
    )
    expect(spent.attempts).toBe(KICKSTART_MAX_ATTEMPTS)
    expect(kickstartDue(spent, unsynced, initialState, 100_000, 3000)).toBe(false)
    expect(kickstartExhausted(spent, unsynced, spent.dueMs - 1)).toBe(false)
    expect(kickstartExhausted(spent, unsynced, spent.dueMs)).toBe(true)
    expect(kickstartExhausted(spent, synced, spent.dueMs)).toBe(false)
    expect(kickstartExhausted({ ...spent, phase: 'done' }, unsynced, spent.dueMs)).toBe(false)
  })
})
