import { readFileSync } from 'node:fs'
import { Effect, Either, Ref, Schema } from 'effect'
import { liftPlanV0, phrasePlanSchema, phrasePlanV1Schema, type PhrasePlanV1, type SlotPlanV1 } from '../../schema.js'
import { pick } from '../../rand.js'
import { offlineBrain } from './offline.js'
import type { Brain, BrainContext } from './types.js'

// pool Brain: selection from a stock of pre-generated, verified plans.
// No network, no LLM nondeterminism (rehearsal and the show share the same vocabulary). The default Brain of the public release.
// Sources: (a) the bundled plans/pool.json (v0 format = each slot carries a role),
//          (b) "good moments" from rehearsal (grown by scripts/pool-add.ts; v1 + roles).
// Selection uses metadata (energy band) + cooldown (avoiding recently used entries).

/** pool entry: a plan (v1) plus slot number → role word (kick/hat/snare/perc etc.) */
export interface PoolEntry {
  readonly id: string
  readonly band: number
  readonly aim: string
  readonly plan: PhrasePlanV1
  readonly roles: Readonly<Record<number, string>>
}

const decodeV0 = Schema.decodeUnknownEither(phrasePlanSchema)
const decodeV1 = Schema.decodeUnknownEither(phrasePlanV1Schema)

const rawEntrySchema = Schema.Struct({
  band: Schema.Number.pipe(Schema.between(0, 1)),
  aim: Schema.String,
  plan: Schema.Unknown,
  /** Role map for v1 entries (pool-add derives it from the manifest roles). v0 uses the role inside the plan */
  roles: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})
type RawEntry = Schema.Schema.Type<typeof rawEntrySchema>
const decodeRawEntry = Schema.decodeUnknownEither(rawEntrySchema)

/** Read a plan entry (v0 is lifted, v1 is used as is) and its role map */
const decodeEntry = (entry: RawEntry): { plan: PhrasePlanV1; roles: Readonly<Record<number, string>> } | null => {
  const v1 = decodeV1(entry.plan)
  if (Either.isRight(v1)) {
    const roles = Object.fromEntries(
      Object.entries(entry.roles ?? {}).map(([slot, role]) => [Number.parseInt(slot, 10), role] as const),
    )
    return { plan: v1.right, roles }
  }
  const v0 = decodeV0(entry.plan)
  if (Either.isLeft(v0)) return null
  return {
    plan: liftPlanV0(v0.right),
    roles: Object.fromEntries(v0.right.slots.map((s) => [s.slot, s.role] as const)),
  }
}

/** Load a plan file (v0/v1 may be mixed) into the pool. Unreadable or malformed entries are dropped with a warning */
export const loadPool = (path: string, idPrefix = 'pool'): ReadonlyArray<PoolEntry> => {
  const raw = Either.try(() => JSON.parse(readFileSync(path, 'utf8')) as unknown)
  if (Either.isLeft(raw) || !Array.isArray(raw.right)) {
    console.warn(`[ai] cannot read pool (${path}) — skipping`)
    return []
  }
  return raw.right.flatMap((item: unknown, i) => {
    const entry = decodeRawEntry(item)
    if (Either.isLeft(entry)) {
      console.warn(`[ai] pool entry ${idPrefix}-${i} is malformed — skipping`)
      return []
    }
    const decoded = decodeEntry(entry.right)
    return decoded === null
      ? []
      : [{ id: `${idPrefix}-${i}`, band: entry.right.band, aim: entry.right.aim, ...decoded }]
  })
}

/** Synonyms of role words (words that appear in manifest role descriptions) */
const ROLE_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  kick: ['kick', 'bd', 'bass drum'],
  snare: ['snare', 'sn', 'sd'],
  hat: ['hat', 'hh', 'hihat', 'hi-hat'],
  perc: ['perc', 'percussion'],
  bass: ['bass'],
  stab: ['stab', 'chord'],
  noise: ['noise'],
}

/** Split a role description into words (only alphanumeric runs count as words; "hi-hat" becomes hi and hat) */
const wordsOf = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w !== ''),
  )

/**
 * Does a manifest role description match a pool role word? Matching is word-based
 * ("kicker" does not match kick; "sn" matches snare only when it appears as a word).
 * Negation ("no hat") is not detected — role descriptions are assumed to be written in the affirmative (documented)
 */
export const roleMatches = (specRole: string, poolRole: string): boolean => {
  const words = wordsOf(specRole)
  const aliases = ROLE_ALIASES[poolRole.toLowerCase()] ?? [poolRole.toLowerCase()]
  return aliases.some((a) => a.split(/[^a-z0-9]+/).every((w) => words.has(w)))
}

const STRUCT_TYPES: ReadonlySet<string> = new Set(['euclid', 'grid', 'silence'])

/**
 * Map a pool plan onto the manifest slots by role match (struct slots only).
 * Does not depend on array position — reads the entry's roles (for v0, the role inside the plan).
 * A source pattern that is not struct-like (euclid/grid/silence) is not mapped (no type mismatch is introduced).
 * Unmatched slots and nsteps/samples slots are null (filled by offline generation — on the nextPlan side)
 */
export const mapToManifest = (ctx: BrainContext, entry: PoolEntry): ReadonlyArray<SlotPlanV1 | null> =>
  ctx.manifest.slots.map((spec) => {
    if (spec.generator !== 'struct') return null
    const source = entry.plan.slots.find((s) => {
      const role = entry.roles[s.slot]
      return role !== undefined && roleMatches(spec.role, role) && STRUCT_TYPES.has(s.pattern.type)
    })
    return source === undefined ? null : { slot: spec.slot, pattern: source.pattern }
  })

export const makePoolBrain = (paths: ReadonlyArray<string>): Effect.Effect<Brain> =>
  Effect.gen(function* () {
    const pool = paths.flatMap((p, i) => loadPool(p, `pool${i}`))
    const recent = yield* Ref.make<ReadonlyArray<string>>([])
    console.log(`[ai] pool: loaded ${pool.length} plans (${paths.length} sources)`)
    const nextPlan = (ctx: BrainContext): Effect.Effect<PhrasePlanV1, Error> =>
      Effect.gen(function* () {
        if (pool.length === 0) return yield* Effect.fail(new Error('pool is empty'))
        const used = yield* Ref.get(recent)
        // Keep the top entries by energy-band proximity, excluding the cooldown set (last 3)
        const ranked = [...pool].sort((a, b) => Math.abs(a.band - ctx.desire) - Math.abs(b.band - ctx.desire))
        const candidates = ranked.slice(0, 8).filter((e) => !used.includes(e.id))
        const chosen = candidates.length > 0 ? yield* pick(candidates) : ranked[0]!
        yield* Ref.update(recent, (r) => [chosen.id, ...r].slice(0, 3))
        // Map onto the manifest. If not a single struct slot is filled, the pool counts as failed (formal degradation to offline).
        // If only some are filled, the rest (role mismatch, nsteps, etc.) are filled by offline generation and the fill ratio is logged
        const mapped = mapToManifest(ctx, chosen)
        const structSlots = ctx.manifest.slots.filter((s) => s.generator === 'struct').length
        const mappedCount = mapped.filter((m) => m !== null).length
        if (mappedCount === 0)
          return yield* Effect.fail(new Error(`no pool entry matches the manifest roles (${structSlots} struct slots)`))
        if (mappedCount < structSlots)
          console.log(`[ai] pool: mapped ${mappedCount}/${structSlots} struct slots, filling the rest with offline`)
        const filler = yield* offlineBrain.nextPlan(ctx)
        const slots = ctx.manifest.slots.map((spec, i) => {
          const fromPool = mapped[i]
          if (fromPool !== null && fromPool !== undefined) return fromPool
          return filler.slots.find((s) => s.slot === spec.slot)!
        })
        return {
          version: 1 as const,
          energy: chosen.band,
          lengthCycles: ctx.lengthCycles,
          slots,
        }
      })
    return { mode: 'pool', nextPlan }
  })
