import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { offlineBrain } from '../src/conductor/brain/offline.js'
import { loadPool } from '../src/conductor/brain/pool.js'
import { extractMarks, mergePool } from '../src/conductor/poolGrow.js'
import type { Manifest } from '../src/conductor/manifest.js'
import type { BrainContext } from '../src/conductor/brain/types.js'
import { parsePhrasePlanV1 } from '../src/schema.js'
import { runSeeded } from '../src/rand.js'

const manifest: Manifest = {
  id: 'example',
  defaultLengthCycles: 4,
  slots: [
    { slot: 1, generator: 'struct', role: 'perc' },
    { slot: 2, generator: 'struct', role: 'hat' },
  ],
}

const ctx = (over: Partial<BrainContext> = {}): BrainContext => ({
  manifest,
  desire: 0.7,
  freedom: 0.5,
  lengthCycles: 4,
  lastPlan: null,
  allowTransition: true,
  activity: 0,
  history: [],
  ...over,
})

describe('offline brain and transition', () => {
  it('emits no transition when allowTransition=false', () => {
    Array.from({ length: 40 }, (_, i) => i + 1).forEach((seed) => {
      const plan = runSeeded(seed, offlineBrain.nextPlan(ctx({ allowTransition: false })))
      plan.slots.forEach((s) => expect(s.transition).toBeUndefined())
    })
  })
})

describe('rehearsal mode (growing the pool)', () => {
  const plan = parsePhrasePlanV1({
    version: 1,
    energy: 0.6,
    lengthCycles: 4,
    slots: [{ slot: 1, pattern: { type: 'euclid', pulses: 3, steps: 8 } }],
  })

  it('extractMarks: converts only mark entries into pool form and stamps the manifest role words', () => {
    const lines = [
      JSON.stringify({ type: 'event', event: { _tag: 'Cycle' } }),
      JSON.stringify({
        type: 'mark',
        manifest: 'example',
        desire: 0.6,
        plan,
      }),
      JSON.stringify({ type: 'mark', plan: null }), // a mark before any plan was applied is dropped
      'not json',
    ]
    const marks = extractMarks(lines, 's1', manifest)
    expect(marks.length).toBe(1)
    expect(marks[0]!.band).toBe(0.6)
    expect(marks[0]!.aim).toContain('example')
    expect(marks[0]!.roles).toEqual({ '1': 'perc', '2': 'hat' })
  })

  it('mergePool: appends while excluding duplicate plan contents', () => {
    const entry = { band: 0.6, aim: 'a', plan, roles: {} }
    const merged = mergePool([entry], [entry, { ...entry, aim: 'b' }])
    expect(merged.length).toBe(1)
  })

  it('the pool brain can read v1 entries (with roles)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-pool-'))
    const path = join(dir, 'pool.json')
    writeFileSync(path, JSON.stringify([{ band: 0.6, aim: 'test', plan, roles: { '1': 'perc' } }]))
    const pool = loadPool(path, 'grown')
    expect(pool.length).toBe(1)
    expect(pool[0]!.plan).toEqual(plan)
    expect(pool[0]!.roles).toEqual({ 1: 'perc' })
  })
})
