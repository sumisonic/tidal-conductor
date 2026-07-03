import { describe, expect, it } from 'vitest'
import {
  HISTORY_LEN,
  historyLabel,
  phraseRecord,
  pushPhrase,
  stampFeedback,
  type PhraseRecord,
} from '../src/conductor/history.js'
import { buildPrompt } from '../src/conductor/brain/api.js'
import type { BrainContext } from '../src/conductor/brain/types.js'
import type { Manifest } from '../src/conductor/manifest.js'
import { parsePhrasePlanV1 } from '../src/schema.js'

// The pure part of in-context adaptation:
// history ring buffer + stamping the performer's feedback + structuring into the generation prompt.

const plan = parsePhrasePlanV1({
  version: 1,
  energy: 0.5,
  lengthCycles: 4,
  slots: [
    { slot: 1, pattern: { type: 'euclid', pulses: 3, steps: 8 } },
    { slot: 3, pattern: { type: 'nsteps', variants: [[0, '~', 1, '~']] } },
  ],
})

const record = (atCycle: number): PhraseRecord =>
  phraseRecord({
    atCycle,
    desire: 0.5,
    usedMode: 'api',
    plan,
  })

describe('history ring buffer', () => {
  it('phraseRecord summarizes the plan as rendered strings (feedback is null)', () => {
    const r = record(100)
    expect(r.slots).toEqual([
      { slot: 1, pattern: 't(3,8)' },
      { slot: 3, pattern: '0 ~ 1 ~' },
    ])
    expect(r.feedback).toBeNull()
  })

  it('pushPhrase keeps oldest-first order and trims to HISTORY_LEN', () => {
    const h = Array.from({ length: HISTORY_LEN + 5 }, (_, i) => i).reduce(
      (acc, i) => pushPhrase(acc, record(i)),
      [] as ReadonlyArray<PhraseRecord>,
    )
    expect(h.length).toBe(HISTORY_LEN)
    expect(h[0]!.atCycle).toBe(5) // the 5 oldest entries are dropped
    expect(h.at(-1)!.atCycle).toBe(HISTORY_LEN + 4)
  })

  it('stampFeedback stamps the most recent phrase (no-op on empty history)', () => {
    expect(stampFeedback([], 'mark')).toEqual([])
    const h = stampFeedback([record(1), record(2)], 'kill')
    expect(h[0]!.feedback).toBeNull()
    expect(h[1]!.feedback).toBe('kill')
  })

  it('feedback strength: mark > kill > veto > freeze (weaker feedback never overwrites)', () => {
    const marked = stampFeedback([record(1)], 'mark')
    expect(stampFeedback(marked, 'freeze')[0]!.feedback).toBe('mark')
    expect(stampFeedback(marked, 'kill')[0]!.feedback).toBe('mark')
    const vetoed = stampFeedback([record(1)], 'veto')
    expect(stampFeedback(vetoed, 'freeze')[0]!.feedback).toBe('veto')
    expect(stampFeedback(vetoed, 'kill')[0]!.feedback).toBe('kill') // the emergency mute is stronger than veto
    const frozen = stampFeedback([record(1)], 'freeze')
    expect(stampFeedback(frozen, 'kill')[0]!.feedback).toBe('kill')
  })

  it('historyLabel: the hist=N summary (★=mark, ✕=negatives kill+veto)', () => {
    expect(historyLabel([])).toBe('0')
    const h = stampFeedback([...stampFeedback([record(1)], 'mark'), record(2)], 'kill')
    expect(historyLabel(h)).toBe('2★1✕1')
    const withVeto = stampFeedback([...h, record(3)], 'veto')
    expect(historyLabel(withVeto)).toBe('3★1✕2')
  })
})

describe('buildPrompt (structuring for in-context adaptation)', () => {
  const manifest: Manifest = {
    id: 'example',
    defaultLengthCycles: 4,
    slots: [{ slot: 1, generator: 'struct', role: 'perc' }],
  }
  const ctx = (history: ReadonlyArray<PhraseRecord>): BrainContext => ({
    manifest,
    desire: 0.5,
    freedom: 0.5,
    lengthCycles: 4,
    lastPlan: null,
    allowTransition: true,
    activity: 0,
    history,
  })

  it('history appears in the prompt with feedback', () => {
    const h = stampFeedback([record(42)], 'mark')
    const parsed = JSON.parse(buildPrompt(ctx(h))) as {
      manifest: string
      history: ReadonlyArray<{
        cycle: number
        feedback: string | null
        slots: Record<string, string>
      }>
    }
    expect(parsed.manifest).toBe('example')
    expect(parsed.history.length).toBe(1)
    expect(parsed.history[0]!.cycle).toBe(42)
    expect(parsed.history[0]!.feedback).toBe('mark')
    expect(parsed.history[0]!.slots['1']).toBe('t(3,8)')
  })

  it('does not break with empty history (start of the set)', () => {
    const parsed = JSON.parse(buildPrompt(ctx([]))) as { history: unknown[] }
    expect(parsed.history).toEqual([])
  })
})
