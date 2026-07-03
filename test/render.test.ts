import { describe, expect, it } from 'vitest'
import { Arbitrary, FastCheck as fc, Schema } from 'effect'
import {
  euclidSchema,
  parsePhrasePlanV1,
  phrasePlanSchema,
  rhythmSchema,
  type PhrasePlan,
  type Rhythm,
} from '../src/schema.js'
import {
  renderPatternV1,
  renderPlan,
  renderPlanV1WithVocab,
  renderRhythm,
  renderSamplesNames,
  SAFE_PATTERN_RE,
  SAFE_SAMPLE_NAME_RE,
  SAFE_SAMPLES_PATTERN_RE,
} from '../src/render.js'
import { randomPlan } from '../src/generators/random.js'
import { rulesPlan } from '../src/generators/rules.js'

const decodeRhythm = Schema.decodeUnknownSync(rhythmSchema)
const decodePlan = Schema.decodeUnknownSync(phrasePlanSchema)

// golden: pins the schema → mini-notation mapping (a change here is an intentional change)
describe('renderRhythm golden', () => {
  it('euclid basic form', () => {
    expect(renderRhythm({ type: 'euclid', pulses: 3, steps: 8 })).toBe('t(3,8)')
  })
  it('euclid with rotation', () => {
    expect(renderRhythm({ type: 'euclid', pulses: 6, steps: 16, rotation: 3 })).toBe('t(6,16,3)')
  })
  it('euclid with alternating rotation (same shape as (1,8,<4 4 4 3>) from a real track)', () => {
    expect(
      renderRhythm({
        type: 'euclid',
        pulses: 1,
        steps: 8,
        rotation: [4, 4, 4, 3],
      }),
    ).toBe('t(1,8,<4 4 4 3>)')
  })
  it('grid with a single variant', () => {
    expect(
      renderRhythm({
        type: 'grid',
        variants: [['x', '~', ['x', 'x'], '~']],
      }),
    ).toBe('t ~ [t t] ~')
  })
  it('grid with multiple variants alternates per cycle', () => {
    expect(
      renderRhythm({
        type: 'grid',
        variants: [
          ['x', '~'],
          ['x', 'x'],
        ],
      }),
    ).toBe('<[t ~] [t t]>')
  })
  it('silence', () => {
    expect(renderRhythm({ type: 'silence' })).toBe('~')
  })
})

// grid is built constructively so it satisfies the schema constraints (all variants same length, no all-rest).
// Arbitrary.make(gridSchema) can fail to generate under the filter's rejection sampling, hence hand-written.
type Cell = 'x' | '~'
type Step = Cell | Cell[]

const cellArb = fc.constantFrom<Cell>('x', '~')
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: cellArb },
  { weight: 1, arbitrary: fc.array(cellArb, { minLength: 2, maxLength: 4 }) },
)

const hasHit = (steps: ReadonlyArray<Step>): boolean =>
  steps.some((s) => (Array.isArray(s) ? s.includes('x') : s === 'x'))

/** All-silent variants violate the schema, so guarantee one hit at the head via a pure map */
const ensureHit = (variants: Step[][]): Step[][] =>
  variants.some(hasHit)
    ? variants
    : variants.map((v, vi) => (vi === 0 ? v.map((s, si): Step => (si === 0 ? 'x' : s)) : v))

const gridArb = fc
  .record({
    len: fc.integer({ min: 2, max: 32 }),
    nVariants: fc.integer({ min: 1, max: 4 }),
  })
  .chain(({ len, nVariants }) =>
    fc
      .array(fc.array(stepArb, { minLength: len, maxLength: len }), {
        minLength: nVariants,
        maxLength: nVariants,
      })
      .map((variants) => ({ type: 'grid' as const, variants: ensureHit(variants) })),
  )

// euclid derives its arbitrary from the schema (Effect Schema's Arbitrary integration)
const euclidArb = Arbitrary.make(euclidSchema)

const rhythmArb: fc.Arbitrary<Rhythm> = fc.oneof(
  euclidArb,
  gridArb,
  fc.constant({ type: 'silence' as const }),
) as fc.Arbitrary<Rhythm>

/** Check bracket balance with reduce (carrying the stack of open brackets immutably) */
const balanced = (s: string): boolean => {
  const close: Record<string, string> = { ')': '(', ']': '[', '>': '<' }
  const result = [...s].reduce<{ ok: boolean; stack: ReadonlyArray<string> }>(
    (acc, ch) =>
      !acc.ok
        ? acc
        : ch === '(' || ch === '[' || ch === '<'
          ? { ok: true, stack: [...acc.stack, ch] }
          : ch in close
            ? acc.stack.at(-1) === close[ch]
              ? { ok: true, stack: acc.stack.slice(0, -1) }
              : { ok: false, stack: acc.stack }
            : acc,
    { ok: true, stack: [] },
  )
  return result.ok && result.stack.length === 0
}

describe('renderRhythm property', () => {
  it('any rhythm that passed the schema renders only safe tokens', () => {
    fc.assert(
      fc.property(rhythmArb, (r) => {
        decodeRhythm(r) // precondition: schema-valid
        const out = renderRhythm(r)
        expect(out).toMatch(SAFE_PATTERN_RE)
        expect(balanced(out)).toBe(true)
        expect(out.trim().length).toBeGreaterThan(0)
      }),
      { numRuns: 500 },
    )
  })

  it('determinism: same input, same output', () => {
    fc.assert(
      fc.property(rhythmArb, (r) => {
        expect(renderRhythm(r)).toBe(renderRhythm(structuredClone(r)))
      }),
      { numRuns: 200 },
    )
  })
})

describe('generators', () => {
  const gens: ReadonlyArray<[string, (seed: number) => PhrasePlan]> = [
    ['random', (s) => randomPlan(s)],
    ['rules', (s) => rulesPlan(s)],
  ]

  gens.forEach(([name, gen]) => {
    it(`${name}: schema-valid and render-safe for any seed`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
          const plan = decodePlan(gen(seed))
          renderPlan(plan).forEach((slot) => {
            expect(slot.pattern).toMatch(SAFE_PATTERN_RE)
            expect(balanced(slot.pattern)).toBe(true)
          })
        }),
        { numRuns: 300 },
      )
    })

    it(`${name}: reproducible with a fixed seed`, () => {
      expect(gen(42)).toEqual(gen(42))
      expect(JSON.stringify(gen(1))).not.toBe(JSON.stringify(gen(2)))
    })
  })
})

// --- samples type ---

describe('samples type rendering', () => {
  const kit = ['kit_bd:0', 'kit_sn:0', 'kit_hat:1']

  it('index form (for prompts and memory): same shape as nsteps', () => {
    expect(renderPatternV1({ type: 'samples', variants: [[0, '~', 2, 1]] })).toBe('0 ~ 2 1')
  })

  it('name form (for the real wiring): converted to a vocab name sequence, variants alternate as <[...] [...]>', () => {
    expect(renderSamplesNames({ type: 'samples', variants: [[0, '~', 2, 1]] }, kit)).toBe(
      'kit_bd:0 ~ kit_hat:1 kit_sn:0',
    )
    expect(
      renderSamplesNames(
        {
          type: 'samples',
          variants: [
            [0, 1],
            [1, '~'],
          ],
        },
        kit,
      ),
    ).toBe('<[kit_bd:0 kit_sn:0] [kit_sn:0 ~]>')
  })

  it('an index outside the vocab range falls to ~ (structural safety — never fabricates a name)', () => {
    expect(renderSamplesNames({ type: 'samples', variants: [[0, 9]] }, kit)).toBe('kit_bd:0 ~')
  })

  it('renderPlanV1WithVocab: only samples slots use name form; silence when the vocab cannot be resolved', () => {
    const plan = parsePhrasePlanV1({
      version: 1,
      energy: 0.5,
      lengthCycles: 4,
      slots: [
        { slot: 1, pattern: { type: 'euclid', pulses: 3, steps: 8 } },
        { slot: 2, pattern: { type: 'samples', variants: [[0, 1]] } },
        { slot: 3, pattern: { type: 'samples', variants: [[0, 1]] } },
      ],
    })
    const rendered = renderPlanV1WithVocab(plan, (slot) => (slot === 2 ? kit : undefined))
    expect(rendered).toEqual([
      { slot: 1, pattern: 't(3,8)', transition: null },
      { slot: 2, pattern: 'kit_bd:0 kit_sn:0', transition: null },
      { slot: 3, pattern: '~', transition: null },
    ])
  })

  it('name form satisfies SAFE_SAMPLES_PATTERN_RE, vocab names satisfy SAFE_SAMPLE_NAME_RE', () => {
    kit.forEach((n) => expect(n).toMatch(SAFE_SAMPLE_NAME_RE))
    expect('bd sn').not.toMatch(SAFE_SAMPLE_NAME_RE)
    expect('bd$0').not.toMatch(SAFE_SAMPLE_NAME_RE)
    expect(renderSamplesNames({ type: 'samples', variants: [[0, '~', 1]] }, kit)).toMatch(SAFE_SAMPLES_PATTERN_RE)
  })
})
