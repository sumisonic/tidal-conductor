import { describe, expect, it } from 'vitest'
import {
  isClockReset,
  msUntilCycle,
  nextBoundary,
  pllEstimate,
  pllInit,
  pllResync,
  pllStale,
  pllUsable,
  pllLabel,
} from '../src/conductor/pll.js'

describe('pll', () => {
  const pll = pllResync(pllInit, 100, 0.5, 10_000) // cycle 100 @ t=10s, 2 s per cycle

  it('extrapolation: 4 s later is cycle 102', () => {
    expect(pllEstimate(pll, 14_000)).toBeCloseTo(102)
  })

  it('stale: unsynced, cps unknown, 5 s of silence', () => {
    expect(pllStale(pllInit, 0)).toBe(true)
    expect(pllStale(pllResync(pllInit, 1, 0, 0), 0)).toBe(true)
    expect(pllStale(pll, 14_999)).toBe(false)
    expect(pllStale(pll, 15_001)).toBe(true)
  })

  it('msUntilCycle: boundary 104 is at t=18s', () => {
    expect(msUntilCycle(pll, 104, 10_000)).toBeCloseTo(8000)
    expect(msUntilCycle(pll, 104, 18_500)).toBeCloseTo(-500)
  })

  it('nextBoundary: multiples of the absolute cycle. Next one when on a boundary; never goes backwards even for negative cycles', () => {
    expect(nextBoundary(4, 101.2)).toBe(104)
    expect(nextBoundary(4, 104)).toBe(108)
    expect(nextBoundary(4, 0)).toBe(4)
    expect(nextBoundary(4, -2.5)).toBe(0)
    expect(nextBoundary(4, -4)).toBe(0)
    expect(nextBoundary(8, 3)).toBe(8)
  })

  it('isClockReset: only an observation more than 1 cycle behind the estimate counts as a rewind', () => {
    expect(isClockReset(pll, 0, 14_000)).toBe(true) // resetCycles
    expect(isClockReset(pll, 101.5, 14_000)).toBe(false) // jitter (0.5 behind the estimate of 102)
    expect(isClockReset(pll, 102.3, 14_000)).toBe(false)
    expect(isClockReset(pllInit, 0, 0)).toBe(false) // unsynced is not a reset
  })

  it('usable = synced with a known cps; the label distinguishes UNSYNC / sync / STALE', () => {
    expect(pllUsable(pllInit)).toBe(false)
    expect(pllUsable(pllResync(pllInit, 1, 0, 0))).toBe(false)
    expect(pllUsable(pll)).toBe(true)
    expect(pllLabel(pllInit, 0)).toBe('UNSYNC')
    expect(pllLabel(pll, 12_000)).toBe('sync')
    expect(pllLabel(pll, 30_000)).toBe('STALE(20s)')
  })

  it('tempo change during silence: faster resyncs forward, slower by more than a cycle is a rewind', () => {
    const synced = pllResync(pllInit, 100, 0.5, 0)
    // 20 s of silence at the last known 0.5 cps: the estimate reaches 110
    expect(pllEstimate(synced, 20_000)).toBeCloseTo(110)
    // Tidal was set to 1 cps meanwhile: the observation (120) is ahead — an ordinary resync, no reset
    expect(isClockReset(synced, 120, 20_000)).toBe(false)
    expect(pllEstimate(pllResync(synced, 120, 1, 20_000), 21_000)).toBeCloseTo(121)
    // Tidal was set to 0.25 cps meanwhile: the observation (105) is 5 cycles behind — handled as a rewind
    expect(isClockReset(synced, 105, 20_000)).toBe(true)
    // A small lag (less than one cycle behind) is jitter, not a rewind
    expect(isClockReset(synced, 109.5, 20_000)).toBe(false)
  })
})
