import { describe, expect, it } from 'vitest'
import { toEvent } from '../src/conductor/events.js'
import { initialState, reduce, type ConductorState, type InEvent } from '../src/conductor/state.js'
import { oscF, oscS } from '../src/osc.js'

const run = (events: ReadonlyArray<InEvent>): readonly [ConductorState, ReadonlyArray<string>] =>
  events.reduce<readonly [ConductorState, ReadonlyArray<string>]>(
    ([st, log], ev) => {
      const [next, cmds] = reduce(st, ev)
      return [next, [...log, ...cmds.map((c) => `${c._tag}:${c.reason}`)]]
    },
    [initialState, []],
  )

describe('reduce: clock and control mirror', () => {
  it('keeps cycle/cps', () => {
    const [st] = run([{ _tag: 'Cycle', cycle: 132.0, cps: 0.542 }])
    expect(st.cycle).toBe(132.0)
    expect(st.cps).toBe(0.542)
  })

  it('/ai/ctrl moves are only recorded for display and do not change state', () => {
    const [st, cmds] = run([{ _tag: 'Ctrl', key: 'fader1', value: 0.25 }])
    expect(st.lastInput).toBe('fader1=0.25')
    expect(st.density).toBe(0)
    expect(cmds).toEqual([])
  })
})

describe('reduce: knob semantics', () => {
  it('the density knob is the desire (reversion center) and does not write the walk value directly', () => {
    const [st] = run([{ _tag: 'Knob', name: 'density', value: 0.8 }])
    expect(st.knobDensity).toBe(0.8)
    expect(st.density).toBe(0) // walk value unchanged (still the initial value)
  })

  it('the density knob is clamped to [0,1]', () => {
    const [st] = run([{ _tag: 'Knob', name: 'density', value: 1.5 }])
    expect(st.knobDensity).toBe(1)
  })

  it('kill switch: fires the forced mute once on the falling edge to knob 0', () => {
    const [st, cmds] = run([
      { _tag: 'Knob', name: 'density', value: 0.6 },
      { _tag: 'Knob', name: 'density', value: 0 },
      { _tag: 'Knob', name: 'density', value: 0 }, // repeated CC — does not fire again
    ])
    expect(cmds).toEqual(['Silence:kill'])
    expect(st.density).toBe(0)
  })

  it('fires the kill even when knob 0 arrives right after startup (not received → 0)', () => {
    const [, cmds] = run([{ _tag: 'Knob', name: 'density', value: 0 }])
    expect(cmds).toEqual(['Silence:kill'])
  })

  it('releasing the kill switch emits no command (the walk recovers naturally)', () => {
    const [st, cmds] = run([
      { _tag: 'Knob', name: 'density', value: 0 },
      { _tag: 'Knob', name: 'density', value: 0.7 },
    ])
    expect(cmds).toEqual(['Silence:kill'])
    expect(st.knobDensity).toBe(0.7)
  })

  it('the freedom knob is kept as the step-size scale', () => {
    const [st] = run([{ _tag: 'Knob', name: 'freedom', value: 0.9 }])
    expect(st.freedom).toBe(0.9)
  })

  it('freeze: ON at >= 0.5, the yielding margin starts on the falling edge of release', () => {
    const [on] = run([{ _tag: 'Knob', name: 'freeze', value: 1 }])
    expect(on.frozen).toBe(true)
    expect(on.easeTicksLeft).toBe(0)
    const [released] = run([
      { _tag: 'Knob', name: 'freeze', value: 1 },
      { _tag: 'Knob', name: 'freeze', value: 0 },
    ])
    expect(released.frozen).toBe(false)
    expect(released.easeTicksLeft).toBeGreaterThan(0)
  })

  it('an unknown knob name is display-only and does not change state', () => {
    const [st] = run([{ _tag: 'Knob', name: 'mystery', value: 0.5 }])
    expect(st.knobDensity).toBeNull()
    expect(st.freedom).toBe(0.5)
    expect(st.frozen).toBe(false)
  })
})

describe('toEvent: OSC → InEvent', () => {
  it('/ai/ctx/cycle', () => {
    expect(toEvent({ address: '/ai/ctx/cycle', args: [oscF(12), oscF(0.5)] })).toEqual({
      _tag: 'Cycle',
      cycle: 12,
      cps: 0.5,
    })
  })

  it('/ai/ctrl (optional control mirror)', () => {
    expect(toEvent({ address: '/ai/ctrl', args: [oscS('vol1'), oscF(0.8)] })).toEqual({
      _tag: 'Ctrl',
      key: 'vol1',
      value: 0.8,
    })
  })

  it('/ai/knob', () => {
    expect(toEvent({ address: '/ai/knob', args: [oscS('density'), oscF(0.3)] })).toEqual({
      _tag: 'Knob',
      name: 'density',
      value: 0.3,
    })
  })

  it('null when a number is not finite (NaN or Infinity never reach the state)', () => {
    expect(toEvent({ address: '/ai/knob', args: [oscS('density'), oscF(Number.NaN)] })).toBeNull()
    expect(toEvent({ address: '/ai/ctx/cycle', args: [oscF(Number.POSITIVE_INFINITY), oscF(0.5)] })).toBeNull()
    // a non-finite cps is treated as unknown (0), the cycle itself is kept
    expect(toEvent({ address: '/ai/ctx/cycle', args: [oscF(12), oscF(Number.NaN)] })).toEqual({
      _tag: 'Cycle',
      cycle: 12,
      cps: 0,
    })
  })

  it('null when arguments are missing', () => {
    expect(toEvent({ address: '/ai/knob', args: [oscS('density')] })).toBeNull()
    expect(toEvent({ address: '/ai/ctx/cycle', args: [] })).toBeNull()
  })

  it('legacy protocol addresses (/ai/ot, /ai/ctx/player, /ai/ctx/song) and unknown addresses are null', () => {
    expect(toEvent({ address: '/ai/ot', args: [oscS('t1a'), oscF(0.5)] })).toBeNull()
    expect(toEvent({ address: '/ai/ctx/player', args: [oscS('P0')] })).toBeNull()
    expect(toEvent({ address: '/ai/ctx/song', args: [oscS('x:scene:main')] })).toBeNull()
    expect(toEvent({ address: '/unknown', args: [] })).toBeNull()
  })
})
