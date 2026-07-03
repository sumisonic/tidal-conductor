import { match } from 'ts-pattern'
import { firstString, numberAt, type OscMessage } from '../osc.js'
import type { InEvent } from './state.js'

// Conversion of OSC messages arriving on the listen port into InEvent (pure layer).
//
// Received addresses (sender):
// - /ai/ctx/cycle  cycle cps   (clock source: the SC snippet etc.)
// - /ai/ctrl       name value  (optional: mirror of the human performer's controller moves — feeds activity estimation)
// - /ai/knob       name value  (AI-only knobs — density / freedom / freeze / mark / veto)
// - /ai/pong       ...         (SC snippet: preflight reply — not turned into an event)

/** The n-th numeric argument, or null when missing or not finite (a NaN must never reach the PLL or a knob) */
const finiteAt = (msg: OscMessage, index: number): number | null => {
  const n = numberAt(msg, index)
  return n !== null && Number.isFinite(n) ? n : null
}

export const toEvent = (msg: OscMessage): InEvent | null =>
  match(msg.address)
    .with('/ai/ctx/cycle', () => {
      const cycle = finiteAt(msg, 0)
      const cps = finiteAt(msg, 1)
      return cycle === null ? null : ({ _tag: 'Cycle', cycle, cps: cps ?? 0 } as const)
    })
    .with('/ai/ctrl', () => {
      const key = firstString(msg)
      const value = finiteAt(msg, 0)
      return key === null || value === null ? null : ({ _tag: 'Ctrl', key, value } as const)
    })
    .with('/ai/knob', () => {
      const name = firstString(msg)
      const value = finiteAt(msg, 0)
      return name === null || value === null ? null : ({ _tag: 'Knob', name, value } as const)
    })
    .otherwise(() => null)

export const describeEvent = (event: InEvent): string =>
  match(event)
    .with({ _tag: 'Cycle' }, (e) => `cycle ${e.cycle.toFixed(1)}`)
    .with({ _tag: 'Ctrl' }, (e) => `ctrl ${e.key}=${e.value.toFixed(2)}`)
    .with({ _tag: 'Knob' }, (e) => `knob ${e.name}=${e.value.toFixed(2)}`)
    .exhaustive()
