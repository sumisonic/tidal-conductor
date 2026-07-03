import { describe, expect, it } from 'vitest'
import { planManifestMismatch, type Manifest } from '../src/conductor/manifest.js'
import { runSeeded } from '../src/rand.js'
import { SAFE_PATTERN_RE } from '../src/render.js'
import { metricsOf, planOf, splitDataset, toRawSample, TRAINING_SYSTEM_PROMPT } from '../src/training/dataset.js'
import { contextAt, randomPlanV1 } from '../src/training/sampler.js'
import { buildPrompt, SYSTEM_PROMPT } from '../src/conductor/brain/api.js'
import { LOCAL_EXTRA_RULES } from '../src/conductor/brain/local.js'
import { HISTORY_LEN } from '../src/conductor/history.js'

// Pure parts of the synthetic data pipeline.
// Training data quality assurance lives here — defects (manifest mismatch, unsafe patterns,
// nondeterminism) are crushed before generation. The path that calls the teacher API (gen-training-data)
// rides on the api Brain's existing checks (double schema validation + manifest consistency).

const manifest: Manifest = {
  id: 'test-set',
  defaultLengthCycles: 4,
  slots: [
    { slot: 1, generator: 'struct', role: 'perc — sparse euclid' },
    { slot: 2, generator: 'struct', role: 'hat — steady ticking' },
    { slot: 3, generator: 'nsteps', role: 'hat sample selection', nRange: [0, 7] },
  ],
} as Manifest

const manifests = [manifest]
const SEEDS = Array.from({ length: 60 }, (_, i) => i)

describe('sampler: randomPlanV1', () => {
  it('is always consistent with the manifest slot declarations (60 seeds)', () => {
    SEEDS.forEach((seed) => {
      const plan = runSeeded(seed, randomPlanV1(manifest, { desire: 0.5, allowTransition: true }))
      expect(planManifestMismatch(plan, manifest)).toBeNull()
    })
  })

  it('keeps nsteps within nRange and energy within 0..1 (60 seeds)', () => {
    SEEDS.forEach((seed) => {
      const plan = runSeeded(seed, randomPlanV1(manifest, { desire: 0.9, allowTransition: false }))
      expect(plan.energy).toBeGreaterThanOrEqual(0)
      expect(plan.energy).toBeLessThanOrEqual(1)
      plan.slots.forEach((s) => {
        ;[s.pattern, ...(s.transition === undefined ? [] : [s.transition])]
          .filter((p) => p.type === 'nsteps')
          .forEach((p) => {
            ;(p as { variants: ReadonlyArray<ReadonlyArray<number | '~'>> }).variants
              .flat()
              .filter((c): c is number => c !== '~')
              .forEach((n) => {
                expect(n).toBeGreaterThanOrEqual(0)
                expect(n).toBeLessThanOrEqual(7)
              })
          })
      })
    })
  })

  it('adds no transition when allowTransition is false (60 seeds)', () => {
    SEEDS.forEach((seed) => {
      const plan = runSeeded(seed, randomPlanV1(manifest, { desire: 0.5, allowTransition: false }))
      plan.slots.forEach((s) => expect(s.transition).toBeUndefined())
    })
  })
})

describe('sampler: contextAt', () => {
  it('the same (seed, index) gives the same context; a different index gives a different one', () => {
    const a = contextAt(manifests, { desirePool: [] }, 1000, 5)
    const b = contextAt(manifests, { desirePool: [] }, 1000, 5)
    const c = contextAt(manifests, { desirePool: [] }, 1000, 6)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c))
  })

  it('range and structure invariants (60 indices)', () => {
    SEEDS.forEach((i) => {
      const ctx = contextAt(manifests, { desirePool: [0.4, 0.6] }, 42, i)
      expect(ctx.desire).toBeGreaterThanOrEqual(0)
      expect(ctx.desire).toBeLessThanOrEqual(1)
      expect(ctx.freedom).toBeGreaterThanOrEqual(0)
      expect(ctx.freedom).toBeLessThanOrEqual(1)
      expect(ctx.activity).toBeGreaterThanOrEqual(0)
      expect(ctx.activity).toBeLessThanOrEqual(1)
      expect(ctx.history.length).toBeLessThanOrEqual(HISTORY_LEN)
      expect([1, 2, 4, 8]).toContain(ctx.lengthCycles)
      // every rendered pattern in the history uses the parseBP-safe alphabet
      ctx.history.flatMap((h) => h.slots.map((s) => s.pattern)).forEach((p) => expect(p).toMatch(SAFE_PATTERN_RE))
      // when there is history, lastPlan is the plan of the most recent phrase
      if (ctx.history.length > 0) expect(ctx.lastPlan).not.toBeNull()
    })
  })

  it('mixes in a share of set-start (empty history) contexts', () => {
    const empty = SEEDS.filter((i) => contextAt(manifests, { desirePool: [] }, 7, i).history.length === 0)
    expect(empty.length).toBeGreaterThan(0)
  })
})

describe('dataset', () => {
  const sampleAt = (i: number) => {
    const ctx = contextAt(manifests, { desirePool: [] }, 3, i)
    const plan = runSeeded(i, randomPlanV1(manifest, { desire: ctx.desire, allowTransition: ctx.allowTransition }))
    return toRawSample({
      id: `t-${i}`,
      provider: 'google',
      model: 'test',
      seed: 3,
      ctx,
      avoid: [],
      liked: [],
      plan,
    })
  }

  it('system matches the local Brain production prompt exactly', () => {
    expect(TRAINING_SYSTEM_PROMPT).toBe(SYSTEM_PROMPT + LOCAL_EXTRA_RULES)
    const s = sampleAt(0)
    expect(s.messages[0]).toEqual({
      role: 'system',
      content: SYSTEM_PROMPT + LOCAL_EXTRA_RULES,
    })
    expect(s.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
  })

  it('recovers the plan from assistant, and classifies patterns into bool/note correctly', () => {
    SEEDS.slice(0, 20).forEach((i) => {
      const s = sampleAt(i)
      const plan = planOf(s)
      expect(plan).not.toBeNull()
      // slot 3 is declared nsteps — nsteps patterns go only into notePats
      ;[...s.boolPats, ...s.notePats].forEach((p) => expect(p).toMatch(SAFE_PATTERN_RE))
      const nstepsCount = plan!.slots.flatMap((sl) =>
        [sl.pattern, ...(sl.transition === undefined ? [] : [sl.transition])].filter((p) => p.type === 'nsteps'),
      ).length
      expect(s.notePats.length).toBe(nstepsCount)
    })
  })

  it('splitDataset is deterministic and splits everything without duplication', () => {
    const xs = SEEDS.map((i) => `x${i}`)
    const a = splitDataset(xs, 0.1, 7)
    const b = splitDataset(xs, 0.1, 7)
    expect(a).toEqual(b)
    expect(a.valid.length).toBe(Math.ceil(xs.length * 0.1))
    expect([...a.train, ...a.valid].sort()).toEqual([...xs].sort())
    expect(splitDataset(xs, 0.1, 8)).not.toEqual(a)
  })

  it('metricsOf counts distributions', () => {
    const samples = SEEDS.slice(0, 30).map(sampleAt)
    const m = metricsOf(samples)
    expect(m.samples).toBe(30)
    expect(m.decodablePlans).toBe(30)
    const totalPatterns = Object.values(m.patternTypes).reduce((a, b) => a + b, 0)
    expect(totalPatterns).toBe(30 * manifest.slots.length)
    expect(m.transitionRate).toBeGreaterThanOrEqual(0)
    expect(m.transitionRate).toBeLessThanOrEqual(1)
  })
})

describe('buildPrompt: style', () => {
  const ctxOf = (m: Manifest) => ({
    manifest: m,
    desire: 0.5,
    freedom: 0.5,
    lengthCycles: 4 as const,
    lastPlan: null,
    allowTransition: true,
    activity: 0,
    history: [],
  })
  const styled = { ...manifest, style: 'dub-leaning' } as Manifest

  it('includes style', () => {
    const p = JSON.parse(buildPrompt(ctxOf(styled))) as Record<string, unknown>
    expect(p.style).toBe('dub-leaning')
    expect(p.manifest).toBe('test-set')
  })

  it('omits the key entirely when not declared', () => {
    const p = JSON.parse(buildPrompt(ctxOf(manifest))) as Record<string, unknown>
    expect('style' in p).toBe(false)
  })
})

describe('buildPrompt: maxIndex', () => {
  const kitManifest: Manifest = {
    id: 'kit',
    defaultLengthCycles: 4,
    slots: [
      { slot: 1, generator: 'struct', role: 'perc' },
      { slot: 2, generator: 'samples', role: 'kit', vocab: ['bd:0', 'sn:0', 'hat:0'] },
    ],
  }

  it('only samples slots get maxIndex (= vocab length - 1)', () => {
    const p = JSON.parse(
      buildPrompt({
        manifest: kitManifest,
        desire: 0.5,
        freedom: 0.5,
        lengthCycles: 4,
        lastPlan: null,
        allowTransition: true,
        activity: 0,
        history: [],
      }),
    ) as { slots: ReadonlyArray<Record<string, unknown>> }
    expect(p.slots[0]).not.toHaveProperty('maxIndex')
    expect(p.slots[1]).toMatchObject({ generator: 'samples', maxIndex: 2 })
  })
})
