import { describe, expect, it } from 'vitest'
import { Effect, Either, Schema } from 'effect'
import { phrasePlanV1Schema, liftPlanV0, phrasePlanSchema } from '../src/schema.js'
import { renderPlanV1, SAFE_PATTERN_RE } from '../src/render.js'
import { runSeeded } from '../src/rand.js'
import { offlineBrain } from '../src/conductor/brain/offline.js'
import { loadPool, makePoolBrain, mapToManifest, roleMatches, type PoolEntry } from '../src/conductor/brain/pool.js'
import { acceptPlan, conformToContext, makeBrain } from '../src/conductor/brain/index.js'
import type { BrainContext } from '../src/conductor/brain/types.js'
import type { Manifest } from '../src/conductor/manifest.js'
import { readFileSync } from 'node:fs'

const decodeV1 = Schema.decodeUnknownSync(phrasePlanV1Schema)

const manifest: Manifest = {
  id: 'example',
  defaultLengthCycles: 4,
  slots: [
    { slot: 1, generator: 'struct', role: 'perc (lt)' },
    { slot: 2, generator: 'struct', role: 'hat (hh27)' },
    { slot: 3, generator: 'nsteps', role: 'hat sample index', nRange: [0, 7] },
  ],
}

const ctx = (over: Partial<BrainContext> = {}): BrainContext => ({
  manifest,
  desire: 0.5,
  freedom: 0.5,
  lengthCycles: 4,
  lastPlan: null,
  allowTransition: true,
  activity: 0,
  history: [],
  ...over,
})

describe('offline brain', () => {
  it('generates a schema-valid, render-safe plan for any seed', () => {
    Array.from({ length: 50 }, (_, i) => i + 1).forEach((seed) => {
      const plan = runSeeded(seed, offlineBrain.nextPlan(ctx()))
      decodeV1(plan)
      renderPlanV1(plan).forEach((slot) => {
        expect(slot.pattern).toMatch(SAFE_PATTERN_RE)
        if (slot.transition !== null) expect(slot.transition).toMatch(SAFE_PATTERN_RE)
      })
      expect(plan.lengthCycles).toBe(4)
      expect(plan.slots.map((s) => s.slot)).toEqual([1, 2, 3])
    })
  })

  it('nsteps slots use indices within nRange', () => {
    Array.from({ length: 30 }, (_, i) => i + 1).forEach((seed) => {
      const plan = runSeeded(seed, offlineBrain.nextPlan(ctx()))
      const nslot = plan.slots.find((s) => s.slot === 3)!
      expect(nslot.pattern.type).toBe('nsteps')
      if (nslot.pattern.type === 'nsteps') {
        nslot.pattern.variants.flat().forEach((c) => {
          if (c !== '~') {
            expect(c).toBeGreaterThanOrEqual(0)
            expect(c).toBeLessThanOrEqual(7)
          }
        })
      }
    })
  })

  it('can keep continuity when lastPlan is given (valid for all seeds)', () => {
    const last = runSeeded(1, offlineBrain.nextPlan(ctx()))
    Array.from({ length: 20 }, (_, i) => i + 1).forEach((seed) => {
      const plan = runSeeded(seed, offlineBrain.nextPlan(ctx({ lastPlan: last })))
      decodeV1(plan)
    })
  })
})

describe('pool brain', () => {
  const poolPath = 'plans/pool.json'

  it('loads the bundled 24 plans (v0) lifted to v1, with role words', () => {
    const pool = loadPool(poolPath)
    expect(pool.length).toBe(24)
    pool.forEach((e) => {
      decodeV1(e.plan)
      renderPlanV1(e.plan).forEach((s) => expect(s.pattern).toMatch(SAFE_PATTERN_RE))
      expect(e.roles).toEqual({ 1: 'kick', 2: 'hat', 3: 'snare', 4: 'perc' })
    })
  })

  it('roleMatches: matches role descriptions word by word (with synonyms; no false positives on partial matches)', () => {
    expect(roleMatches('hat (hh27) — 16th-note feel', 'hat')).toBe(true)
    expect(roleMatches('closed hh, offbeat', 'hat')).toBe(true)
    expect(roleMatches('hi-hat', 'hat')).toBe(true)
    expect(roleMatches('perc (lt)', 'perc')).toBe(true)
    expect(roleMatches('bd support', 'kick')).toBe(true)
    expect(roleMatches('shaker', 'hat')).toBe(false)
    expect(roleMatches('kicker', 'kick')).toBe(false)
    expect(roleMatches('snappy texture', 'snare')).toBe(false)
    expect(roleMatches('sd ghost notes', 'snare')).toBe(true)
  })

  it('mapToManifest: maps by role match, independent of array position', () => {
    const [entry] = loadPool(poolPath)
    // Even with the manifest order reversed from the pool order (kick, hat, snare, perc), roles line up
    const reversed: Manifest = {
      id: 'r',
      defaultLengthCycles: 4,
      slots: [
        { slot: 1, generator: 'struct', role: 'perc' },
        { slot: 2, generator: 'struct', role: 'snare' },
        { slot: 3, generator: 'struct', role: 'hat' },
        { slot: 4, generator: 'struct', role: 'kick' },
        { slot: 5, generator: 'struct', role: 'shaker' }, // no match
        { slot: 6, generator: 'nsteps', role: 'kick n', nRange: [0, 3] }, // not struct
      ],
    }
    const mapped = mapToManifest(ctx({ manifest: reversed }), entry!)
    const v0slot = (role: string) => entry!.plan.slots.find((s) => entry!.roles[s.slot] === role)!.pattern
    expect(mapped[0]).toEqual({ slot: 1, pattern: v0slot('perc') })
    expect(mapped[1]).toEqual({ slot: 2, pattern: v0slot('snare') })
    expect(mapped[2]).toEqual({ slot: 3, pattern: v0slot('hat') })
    expect(mapped[3]).toEqual({ slot: 4, pattern: v0slot('kick') })
    expect(mapped[4]).toBeNull()
    expect(mapped[5]).toBeNull()
  })

  it('does not map a v1 entry whose source is not struct-like (no type mismatch is introduced)', () => {
    const entry: PoolEntry = {
      id: 'v1-0',
      band: 0.5,
      aim: 'x',
      plan: {
        version: 1,
        energy: 0.5,
        lengthCycles: 4,
        slots: [
          { slot: 1, pattern: { type: 'nsteps', variants: [[0, 1]] } },
          { slot: 2, pattern: { type: 'euclid', pulses: 3, steps: 8 } },
        ],
      },
      roles: { 1: 'hat', 2: 'perc' },
    }
    const mapped = mapToManifest(ctx(), entry)
    // slot 1 (perc) ← source slot 2 (perc, euclid) is mapped
    expect(mapped[0]).toEqual({ slot: 1, pattern: { type: 'euclid', pulses: 3, steps: 8 } })
    // slot 2 (hat) ← source slot 1 (hat, nsteps) is not struct-like, so it is not mapped
    expect(mapped[1]).toBeNull()
    expect(mapped[2]).toBeNull()
  })

  it('fails the pool when no role matches, and the degradation chain falls to offline', async () => {
    const noMatch: Manifest = {
      id: 'nomatch',
      defaultLengthCycles: 4,
      slots: [{ slot: 1, generator: 'struct', role: 'shaker' }],
    }
    const direct = runSeeded(
      3,
      Effect.gen(function* () {
        const brain = yield* makePoolBrain([poolPath])
        return yield* Effect.either(brain.nextPlan(ctx({ manifest: noMatch })))
      }),
    )
    expect(direct._tag).toBe('Left')
    const chained = await Effect.runPromise(
      Effect.gen(function* () {
        const brain = yield* makeBrain('pool', {
          poolPaths: [poolPath],
          api: { provider: 'google', model: null, timeoutMs: 1000 },
          local: { baseUrl: 'http://127.0.0.1:1/v1', model: 'test', timeoutMs: 1000 },
          hybridEvery: 4,
          mask: false,
        })
        return yield* brain.nextPlan(ctx({ manifest: noMatch }))
      }),
    )
    expect(chained.intended).toBe('pool')
    expect(chained.usedMode).toBe('offline')
  })

  it('maps onto the manifest and fills nsteps slots and unmatched slots with offline generation', () => {
    const result = runSeeded(
      42,
      Effect.gen(function* () {
        const brain = yield* makePoolBrain([poolPath])
        return yield* brain.nextPlan(ctx({ desire: 0.25 }))
      }),
    )
    decodeV1(result)
    expect(result.slots.map((s) => s.slot)).toEqual([1, 2, 3])
    expect(result.slots[2]!.pattern.type).toBe('nsteps')
    // low-energy desire → a plan from the nearby band (0.25) is chosen
    expect(result.energy).toBeCloseTo(0.25)
  })

  it('warns with an empty pool on an unreadable path, and nextPlan fails (degradation path)', () => {
    const outcome = runSeeded(
      1,
      Effect.gen(function* () {
        const brain = yield* makePoolBrain(['/no/such/file.json'])
        return yield* Effect.either(brain.nextPlan(ctx()))
      }),
    )
    expect(outcome._tag).toBe('Left')
  })
})

describe('liftPlanV0', () => {
  it('v0 (bars/rhythm) → v1 (lengthCycles/pattern)', () => {
    const raw = JSON.parse(readFileSync('plans/pool.json', 'utf8')) as ReadonlyArray<{ readonly plan: unknown }>
    const v0 = Schema.decodeUnknownSync(phrasePlanSchema)(raw[0]?.plan)
    const v1 = liftPlanV0(v0)
    expect(v1.version).toBe(1)
    expect(v1.lengthCycles).toBe(v0.bars)
    expect(v1.slots.length).toBe(v0.slots.length)
  })
})

describe('acceptance contract (the wrapper shared by every chain)', () => {
  const base = runSeeded(5, offlineBrain.nextPlan(ctx({ allowTransition: true })))

  it('normalizes lengthCycles to the request and strips transitions when allowTransition=false', () => {
    const wrongLength = { ...base, lengthCycles: 8 as const }
    const conformed = conformToContext(ctx({ lengthCycles: 2, allowTransition: false }), wrongLength)
    expect(conformed.lengthCycles).toBe(2)
    conformed.slots.forEach((s) => expect(s.transition).toBeUndefined())
    // when allowed, transitions are kept
    const kept = conformToContext(ctx({ lengthCycles: 4, allowTransition: true }), base)
    expect(kept.slots.some((s) => s.transition !== undefined)).toBe(base.slots.some((s) => s.transition !== undefined))
  })

  it('a manifest mismatch (nsteps in a struct slot) is an Error and leads to degradation', () => {
    const bad = {
      ...base,
      slots: [{ slot: 1, pattern: { type: 'nsteps' as const, variants: [[0, 1]] } }],
    }
    const r = Effect.runSync(Effect.either(acceptPlan(ctx(), bad)))
    expect(Either.isLeft(r)).toBe(true)
    expect(Either.isRight(Effect.runSync(Effect.either(acceptPlan(ctx(), base))))).toBe(true)
  })
})

describe('offline mutate and missing slots', () => {
  it('generates slots missing from lastPlan individually from their declaration (never reuses the replacement slot pattern)', () => {
    const kit: Manifest = {
      id: 'kit',
      defaultLengthCycles: 4,
      slots: [
        { slot: 1, generator: 'struct', role: 'perc' },
        { slot: 2, generator: 'samples', role: 'kit', vocab: ['bd:0', 'sn:0'] },
        { slot: 3, generator: 'nsteps', role: 'n', nRange: [0, 3] },
      ],
    }
    // a lastPlan that omits slots 2 and 3
    const partial = decodeV1({
      version: 1,
      energy: 0.5,
      lengthCycles: 4,
      slots: [{ slot: 1, pattern: { type: 'euclid', pulses: 3, steps: 8 } }],
    })
    Array.from({ length: 40 }, (_, i) => i + 1).forEach((seed) => {
      const plan = runSeeded(seed, offlineBrain.nextPlan(ctx({ manifest: kit, lastPlan: partial })))
      const t = (n: number) => plan.slots.find((s) => s.slot === n)!.pattern.type
      expect(['euclid', 'grid', 'silence']).toContain(t(1))
      expect(['samples', 'silence']).toContain(t(2))
      expect(['nsteps', 'silence']).toContain(t(3))
    })
  })
})
