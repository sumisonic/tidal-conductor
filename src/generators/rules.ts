import { Effect } from 'effect'
import { match } from 'ts-pattern'
import type { PhrasePlan, Rhythm, Role } from '../schema.js'
import { CORE_ROLES, parsePhrasePlan } from '../schema.js'
import { chance, pick, randInt, runSeeded, uniform } from '../rand.js'

// Rule-based generator. It has no corpus behind it; it only carries genre common sense (kick on
// the downbeat, hat on the offbeat, snare on the backbeat) as templates. Today it is a pattern
// source for the parseBP sweep and the tests; it started life as the yardstick an LLM had to beat
// ("if it cannot beat this, there is no point in using an LLM").

type Cell = 'x' | '~'
type Step = Cell | readonly Cell[]
type Template = readonly Step[]

const G = (s: string): Template =>
  s.split(' ').map((tok): Step => (tok.length > 1 ? (tok.split('') as Cell[]) : (tok as Cell)))
// Notation: in "x ~ x ~" each character is one step; a run like "xx" is a subdivision

const KICK_TEMPLATES: readonly Template[] = [
  G('x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~'), // four-on-the-floor
  G('x ~ ~ ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~'), // half
  G('x ~ ~ ~ ~ ~ x ~ ~ ~ x ~ ~ ~ ~ ~'), // broken
  G('x ~ ~ x ~ ~ x ~ ~ ~ x ~ ~ ~ ~ ~'), // syncopated
]

const SNARE_TEMPLATES: readonly Template[] = [
  G('~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ x ~ ~ ~'), // backbeat
  G('~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ x ~ ~ x'), // trailing ghost
  G('~ ~ ~ ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~'), // half-time
]

const HAT_RHYTHMS: readonly Rhythm[] = [
  { type: 'grid', variants: [G('~ x ~ x ~ x ~ x')] }, // 8th-note offbeat
  { type: 'grid', variants: [G('~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~')] }, // 16th-note offbeat
  { type: 'euclid', pulses: 11, steps: 16 },
  { type: 'euclid', pulses: 7, steps: 16 },
]

const PERC_RHYTHMS: readonly Rhythm[] = [
  { type: 'euclid', pulses: 3, steps: 8 },
  { type: 'euclid', pulses: 5, steps: 16 },
  { type: 'euclid', pulses: 7, steps: 16, rotation: 2 },
  { type: 'euclid', pulses: 3, steps: 8, rotation: [0, 3] },
]

const BASS_TEMPLATES: readonly Template[] = [
  G('x ~ ~ ~ ~ ~ ~ x ~ ~ x ~ ~ ~ ~ ~'),
  G('x ~ ~ x ~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~'),
  G('~ ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ x ~'),
]

const STAB_RHYTHMS: readonly Rhythm[] = [
  { type: 'euclid', pulses: 2, steps: 16, rotation: 3 },
  { type: 'euclid', pulses: 1, steps: 8, rotation: [4, 4, 4, 3] },
  { type: 'grid', variants: [G('~ ~ ~ x ~ ~ ~ ~'), G('~ ~ ~ x ~ ~ x ~')] },
]

/** Keep the first hit and thin out by turning one other hit into a rest */
const thinOut = (steps: Template): Effect.Effect<Template> =>
  Effect.gen(function* () {
    const hits = steps.flatMap((s, i) => (s === 'x' && i > 0 ? [i] : []))
    if (hits.length <= 1) return steps
    const idx = yield* pick(hits)
    return steps.map((s, i): Step => (i === idx ? '~' : s))
  })

/** Turn one rest into a hit to add a ghost note */
const addGhost = (steps: Template): Effect.Effect<Template> =>
  Effect.gen(function* () {
    const rests = steps.flatMap((s, i) => (s === '~' ? [i] : []))
    if (rests.length === 0) return steps
    const idx = yield* pick(rests)
    return steps.map((s, i): Step => (i === idx ? 'x' : s))
  })

/** Draw a template, then thin it at low energy or add to it at high energy to steer the density */
const gridOf = (templates: readonly Template[], energy: number): Effect.Effect<Rhythm> =>
  Effect.gen(function* () {
    const base = yield* pick(templates)
    const thinned = energy < 0.35 ? yield* thinOut(base) : base
    const ghosted = energy > 0.75 ? yield* addGhost(thinned) : thinned
    return { type: 'grid', variants: [ghosted] } as const
  })

const noiseRhythm: Effect.Effect<Rhythm> = Effect.gen(function* () {
  const silent = yield* chance(0.5)
  if (silent) return { type: 'silence' } as const
  const steps = yield* randInt(8, 16)
  return { type: 'euclid', pulses: 1, steps } as const
})

const rhythmFor = (role: Role, energy: number): Effect.Effect<Rhythm> =>
  match(role)
    .with('kick', () => gridOf(KICK_TEMPLATES, energy))
    .with('snare', () => gridOf(SNARE_TEMPLATES, energy))
    .with('hat', () => pick(HAT_RHYTHMS))
    .with('perc', () => pick(PERC_RHYTHMS))
    .with('bass', () => gridOf(BASS_TEMPLATES, energy))
    .with('stab', () => pick(STAB_RHYTHMS))
    .with('noise', () => noiseRhythm)
    .exhaustive()

export const rulesPlan = (seed: number, roles: readonly Role[] = CORE_ROLES): PhrasePlan =>
  runSeeded(
    seed,
    Effect.gen(function* () {
      const energy = yield* uniform
      const slots = yield* Effect.forEach(roles, (role, i) =>
        Effect.map(rhythmFor(role, energy), (rhythm) => ({
          slot: i + 1,
          role,
          rhythm,
        })),
      )
      const bars = yield* pick([2, 4] as const)
      return parsePhrasePlan({ version: 0, energy, bars, slots })
    }),
  )
