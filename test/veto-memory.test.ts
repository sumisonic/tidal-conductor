import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { SYSTEM_PROMPT } from '../src/conductor/brain/api.js'
import { LOCAL_EXTRA_RULES } from '../src/conductor/brain/local.js'
import { manifestSchema, planManifestMismatch } from '../src/conductor/manifest.js'
import {
  addToFeedback,
  collectFeedback,
  feedbackBlocks,
  markBlock,
  mergeFeedback,
  parseFeedbackFile,
  sanitizePlanAvoid,
  summarizeFeedback,
  summarizePatterns,
  vetoBlock,
  violatesAvoid,
} from '../src/conductor/vetoMemory.js'
import { runSeeded } from '../src/rand.js'
import { SAFE_PATTERN_RE } from '../src/render.js'
import { parsePhrasePlanV1, type PhrasePlanV1 } from '../src/schema.js'
import { trainingSystemPrompt } from '../src/training/dataset.js'
import { FAVORITE_SHAPES, hardTrainingAt, randomManifest, randomPlanV1, trainingAt } from '../src/training/sampler.js'

// Feedback memory (persistent veto/mark).
// Key properties: log reconstruction is correct / the block format is identical in training and
// production / synthetic manifests are diverse enough to break layout memorisation.

const euclidPlan = (pulses: number): PhrasePlanV1 =>
  parsePhrasePlanV1({
    version: 1,
    energy: 0.5,
    lengthCycles: 4,
    slots: [{ slot: 1, pattern: { type: 'euclid', pulses, steps: 8 } }],
  })

const planLine = (plan: PhrasePlanV1, manifest: string | null = 's'): string =>
  JSON.stringify({
    ts: 1,
    type: 'plan',
    manifest,
    desire: 0.5,
    targetCycle: 4,
    plan,
  })

const markLine = (plan: PhrasePlanV1 | null, manifest: string | null = 's'): string =>
  JSON.stringify({ ts: 2, type: 'mark', manifest, desire: 0.5, plan })

const knobLine = (name: string, value: number): string =>
  JSON.stringify({ ts: 2, type: 'event', event: { _tag: 'Knob', name, value } })

describe('collectFeedback (per-manifest reconstruction from logs)', () => {
  it('a veto records the preceding plan entry under its manifest id', () => {
    const lines = [planLine(euclidPlan(3)), knobLine('veto', 1)]
    expect(collectFeedback(lines)).toEqual({
      s: { veto: ['t(3,8)'], mark: [] },
    })
  })

  it('a veto before any plan, or a plan without a veto, yields nothing', () => {
    expect(collectFeedback([knobLine('veto', 1)])).toEqual({})
    expect(collectFeedback([planLine(euclidPlan(3))])).toEqual({})
  })

  it('a mark entry carries plan and manifest id, so it is recorded directly', () => {
    expect(collectFeedback([markLine(euclidPlan(5))])).toEqual({
      s: { veto: [], mark: ['t(5,8)'] },
    })
  })

  it('plans / marks without a manifest id cannot be attributed and are dropped', () => {
    // a plan without an id is not the target of a later veto either (no fallback to an older plan)
    const lines = [
      planLine(euclidPlan(3)),
      planLine(euclidPlan(5), null),
      knobLine('veto', 1),
      markLine(euclidPlan(4), null),
      markLine(null),
    ]
    expect(collectFeedback(lines)).toEqual({})
  })

  it('freeze, knob mark and broken lines are ignored', () => {
    const lines = [planLine(euclidPlan(3)), knobLine('mark', 1), knobLine('freeze', 1), '{broken json']
    expect(collectFeedback(lines)).toEqual({})
  })

  it('a veto always targets the latest plan and is split per manifest (chronological tracking)', () => {
    const lines = [
      planLine(euclidPlan(3), 'set-a'),
      knobLine('veto', 1),
      planLine(euclidPlan(5), 'set-b'),
      planLine(euclidPlan(4), 'set-b'),
      knobLine('veto', 1),
    ]
    expect(collectFeedback(lines)).toEqual({
      'set-a': { veto: ['t(3,8)'], mark: [] },
      'set-b': { veto: ['t(4,8)'], mark: [] },
    })
  })

  it('silent slots (~) are not collected', () => {
    const silent = parsePhrasePlanV1({
      version: 1,
      energy: 0.5,
      lengthCycles: 4,
      slots: [{ slot: 1, pattern: { type: 'silence' } }],
    })
    expect(collectFeedback([planLine(silent), knobLine('veto', 1)])).toEqual({})
  })
})

describe('summarizePatterns (summary)', () => {
  it('most frequent first, newest on ties', () => {
    expect(summarizePatterns(['a', 'b', 'a', 'c', 'a', 'b'], 2)).toEqual(['a', 'b'])
    expect(summarizePatterns(['x', 'y'], 1)).toEqual(['y'])
  })

  it('truncates to n (0 = empty)', () => {
    expect(summarizePatterns(['a', 'b', 'c'], 0)).toEqual([])
  })
})

describe('two-layer merge (distilled file + log reconstruction)', () => {
  it('mergeFeedback concatenates older (distilled) then newer (log)', () => {
    const merged = mergeFeedback(
      { 'set-a': { veto: ['old'], mark: ['m1'] } },
      { 'set-a': { veto: ['new'], mark: [] }, 'set-b': { veto: ['b'], mark: [] } },
    )
    expect(merged).toEqual({
      'set-a': { veto: ['old', 'new'], mark: ['m1'] },
      'set-b': { veto: ['b'], mark: [] },
    })
  })

  it('summarizeFeedback truncates veto/mark per manifest with separate counts', () => {
    const summarized = summarizeFeedback({ 'set-a': { veto: ['a', 'b', 'a'], mark: ['x', 'y'] } }, 2, 1)
    expect(summarized['set-a']?.veto).toEqual(['a', 'b'])
    expect(summarized['set-a']?.mark).toEqual(['y'])
  })

  it('addToFeedback is idempotent (importing the same log twice adds nothing)', () => {
    const add = { 'set-a': { veto: ['v1'], mark: ['m1'] } }
    const once = addToFeedback({}, add)
    const twice = addToFeedback(once, add)
    expect(twice).toEqual({ 'set-a': { veto: ['v1'], mark: ['m1'] } })
    // keeps the existing order and appends only new entries
    const more = addToFeedback(twice, {
      'set-a': { veto: ['v1', 'v2'], mark: [] },
    })
    expect(more['set-a']?.veto).toEqual(['v1', 'v2'])
  })

  it('parseFeedbackFile keeps whatever is readable in a malformed file', () => {
    expect(parseFeedbackFile('{broken')).toEqual({})
    expect(parseFeedbackFile('{"set-a":{"veto":["v",1],"mark":"x"}}')).toEqual({
      'set-a': { veto: ['v'], mark: [] },
    })
    expect(parseFeedbackFile('{"set-a":[]}')).toEqual({
      'set-a': { veto: [], mark: [] },
    })
  })
})

describe('vetoBlock / markBlock (single source of truth for the format)', () => {
  it('an empty list yields an empty string (same prompt shape as a session without feedback)', () => {
    expect(vetoBlock([])).toBe('')
    expect(markBlock([])).toBe('')
    expect(feedbackBlocks([], undefined)).toBe('')
  })

  it('the training system prompt and the production local system prompt use the same formula', () => {
    const avoid = ['t(3,8)', '0 ~ 1 ~']
    const liked = ['t(5,16)']
    expect(trainingSystemPrompt(avoid)).toBe(SYSTEM_PROMPT + LOCAL_EXTRA_RULES + vetoBlock(avoid))
    // with liked as well, same order: SYSTEM + LOCAL_EXTRA + veto + mark
    expect(trainingSystemPrompt(avoid, liked)).toBe(
      SYSTEM_PROMPT + LOCAL_EXTRA_RULES + vetoBlock(avoid) + markBlock(liked),
    )
    expect(vetoBlock(avoid)).toContain('- t(3,8)')
    expect(vetoBlock(avoid)).toContain('Shapes to avoid')
    expect(markBlock(['0 ~ 1 ~'])).toContain('Preferred shapes')
    expect(markBlock(['0 ~ 1 ~'])).toContain('- 0 ~ 1 ~')
  })

  it('feedbackBlocks = shared avoid merged with per-manifest veto + preferred shapes (api/local)', () => {
    expect(feedbackBlocks(['a'], { veto: ['b'], mark: ['c'] })).toBe(vetoBlock(['a', 'b']) + markBlock(['c']))
    // a manifest without feedback gets only the shared avoid list (no extra block)
    expect(feedbackBlocks(['a'], undefined)).toBe(vetoBlock(['a']))
  })
})

describe('violatesAvoid (compliance check)', () => {
  it('detects violations by exact match on the rendered result', () => {
    expect(violatesAvoid(euclidPlan(3), ['t(3,8)'])).toBe(true)
    expect(violatesAvoid(euclidPlan(3), ['t(5,8)'])).toBe(false)
    expect(violatesAvoid(euclidPlan(3), [])).toBe(false)
  })
})

const decodeManifest = Schema.decodeUnknownSync(manifestSchema)

describe('randomManifest (against layout memorisation)', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i)

  it('always passes the schema and has at least one struct slot', () => {
    seeds.forEach((seed) => {
      const m = runSeeded(seed, randomManifest)
      expect(() => decodeManifest(m)).not.toThrow()
      expect(m.slots.some((s) => s.generator === 'struct')).toBe(true)
      m.slots
        .filter((s) => s.generator === 'nsteps')
        .forEach((s) =>
          // exactly one of nRange / nSet is always declared
          expect(s.nRange !== undefined || s.nSet !== undefined).toBe(true),
        )
    })
  })

  it('layouts (generator order) are diverse enough', () => {
    const layouts = new Set(
      seeds.map((seed) =>
        runSeeded(seed, randomManifest)
          .slots.map((s) => s.generator)
          .join(','),
      ),
    )
    expect(layouts.size).toBeGreaterThanOrEqual(5)
  })
})

describe('randomManifest: samples / nSet', () => {
  const seeds = Array.from({ length: 120 }, (_, i) => i)
  const slots = seeds.flatMap((seed) => runSeeded(seed, randomManifest).slots)

  it('mixes samples slots (with vocab) and nSet slots', () => {
    expect(slots.some((s) => s.generator === 'samples' && s.vocab !== undefined)).toBe(true)
    expect(slots.some((s) => s.nSet !== undefined)).toBe(true)
    slots.forEach((s) => {
      if (s.generator === 'samples') expect(s.vocab).toBeDefined()
      // nRange and nSet are mutually exclusive
      expect(s.nRange !== undefined && s.nSet !== undefined).toBe(false)
    })
  })

  it('randomPlanV1 is consistent with the manifest including value checks (by construction)', () => {
    seeds.forEach((seed) => {
      const m = runSeeded(seed, randomManifest)
      const plan = runSeeded(seed + 1000, randomPlanV1(m, { desire: 0.5, allowTransition: true }))
      expect(planManifestMismatch(plan, m)).toBeNull()
    })
  })
})

describe('trainingAt (training samples)', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i)
  const real = [
    decodeManifest({
      id: 'real-set',
      defaultLengthCycles: 4,
      slots: [
        { slot: 1, generator: 'struct', role: 'perc' },
        { slot: 2, generator: 'nsteps', role: 'n', nRange: [0, 7] },
      ],
    }),
  ]

  it('is deterministic; avoid / liked contain only parseBP-safe non-silent patterns', () => {
    seeds.forEach((i) => {
      const a = trainingAt(real, { desirePool: [] }, 5, i)
      const b = trainingAt(real, { desirePool: [] }, 5, i)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      ;[...a.avoid, ...a.liked].forEach((p) => {
        expect(p).toMatch(SAFE_PATTERN_RE)
        expect(p).not.toBe('~')
      })
    })
  })

  it('mixes synthetic and real manifests, with and without avoid / liked', () => {
    const samples = seeds.map((i) => trainingAt(real, { desirePool: [] }, 5, i))
    expect(samples.some((s) => s.ctx.manifest.id.startsWith('gen-'))).toBe(true)
    expect(samples.some((s) => s.ctx.manifest.id === 'real-set')).toBe(true)
    expect(samples.some((s) => s.avoid.length > 0)).toBe(true)
    expect(samples.some((s) => s.avoid.length === 0)).toBe(true)
    expect(samples.some((s) => s.liked.length > 0)).toBe(true)
    expect(samples.some((s) => s.liked.length === 0)).toBe(true)
  })
})

describe('randomManifest: style / allowTransition (both present and absent are taught)', () => {
  it('across 60 seeds: style present and absent, allowTransition=false present, ids follow the rule', () => {
    const ms = Array.from({ length: 60 }, (_, i) => runSeeded(i, randomManifest))
    expect(ms.some((m) => m.style !== undefined)).toBe(true)
    expect(ms.some((m) => m.style === undefined)).toBe(true)
    expect(ms.some((m) => m.allowTransition === false)).toBe(true)
    ms.forEach((m) => expect(m.id).toMatch(/^gen-[0-9]{3}$/))
  })
})

describe('sanitizePlanAvoid (veto check on receipt — partial degradation)', () => {
  const planWith = (transition?: unknown): PhrasePlanV1 =>
    parsePhrasePlanV1({
      version: 1,
      energy: 0.5,
      lengthCycles: 4,
      slots: [
        {
          slot: 1,
          pattern: { type: 'euclid', pulses: 3, steps: 8 },
          ...(transition === undefined ? {} : { transition }),
        },
        { slot: 2, pattern: { type: 'grid', variants: [['x', '~', 'x', '~']] } },
      ],
    })

  it('returns the same plan (same reference) when nothing is violated', () => {
    const p = planWith()
    expect(sanitizePlanAvoid(p, ['t(5,8)'])).toBe(p)
    expect(sanitizePlanAvoid(p, [])).toBe(p)
  })

  it('drops a vetoed transition and keeps the main plan', () => {
    const p = planWith({ type: 'grid', variants: [['x', '~', 'x', '~', 'x', '~', 'x', '~']] })
    // veto the transition that renders as "t ~ t ~ t ~ t ~"
    const out = sanitizePlanAvoid(p, ['t ~ t ~ t ~ t ~'])
    expect(out).not.toBeNull()
    expect(out!.slots[0]!.transition).toBeUndefined()
    expect(out!.slots[0]!.pattern).toEqual(p.slots[0]!.pattern)
    expect(out!.slots[1]).toBe(p.slots[1])
  })

  it('returns null when a main pattern is vetoed (discard → degrade)', () => {
    expect(sanitizePlanAvoid(planWith(), ['t(3,8)'])).toBeNull()
    expect(sanitizePlanAvoid(planWith(), ['t ~ t ~'])).toBeNull() // slot 2's grid
  })
})

describe('hardTrainingAt (hard cases — favourite × avoid × transition)', () => {
  const seeds = Array.from({ length: 80 }, (_, i) => i)
  const samples = seeds.map((i) => hardTrainingAt([], { desirePool: [] }, 9, i))
  const favorites = new Set<string>(FAVORITE_SHAPES)

  it('is deterministic and pinned to contexts where transitions appear (allowTransition=true)', () => {
    seeds.slice(0, 10).forEach((i) => {
      const a = hardTrainingAt([], { desirePool: [] }, 9, i)
      const b = hardTrainingAt([], { desirePool: [] }, 9, i)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    })
    samples.forEach((s) => expect(s.ctx.allowTransition).toBe(true))
  })

  it('mixes direct hits (favourites on the list) and contrast examples (none on the list)', () => {
    const withFav = samples.filter((s) => s.avoid.some((p) => favorites.has(p)))
    const contrast = samples.filter((s) => !s.avoid.some((p) => favorites.has(p)))
    // direct hits are the majority, but contrast examples always exist (without them the model learns a blanket ban)
    expect(withFav.length).toBeGreaterThan(contrast.length)
    expect(contrast.length).toBeGreaterThan(0)
  })
})
