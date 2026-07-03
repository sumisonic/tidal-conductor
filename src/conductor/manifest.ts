import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Either, Schema } from 'effect'
import { SAFE_SAMPLE_NAME_RE } from '../render.js'
import type { PhrasePlanV1 } from '../schema.js'

// AI slot manifest: the Conductor's only unit of configuration.
// From the aiPat slot number alone the Brain cannot know "what is allowed in this slot".
// Paired with the wiring on the Tidal side (the aiPat calls), the manifest declares what each slot means.
// No notion of song — one manifest is fixed at startup and is immutable while running.

const nIndexSchema = Schema.Number.pipe(Schema.int(), Schema.between(0, 127))

const slotSpecSchema = Schema.Struct({
  slot: Schema.Number.pipe(Schema.int(), Schema.between(1, 8)),
  /** struct = rhythmic structure (t/~), nsteps = a sequence of sample indices,
   * samples = a mixed-sample sequence (vocab index → name conversion) */
  generator: Schema.Literal('struct', 'nsteps', 'samples'),
  /** Description for the Brain (role / timbre hints). Also used for the pool's role mapping (words like kick/hat/snare/perc) */
  role: Schema.String,
  /** Index range [min, max] for nsteps (the range that actually exists in the sample bank, min <= max). nsteps needs exactly one of nRange / nSet */
  nRange: Schema.optional(
    Schema.Tuple(nIndexSchema, nIndexSchema).pipe(
      Schema.filter(([lo, hi]) => lo <= hi || 'nRange must be [min, max] in order (min <= max)'),
    ),
  ),
  /** Allowed index set for nsteps (a sparse value domain such as a scale set). Exclusive with nRange */
  nSet: Schema.optional(Schema.Array(nIndexSchema).pipe(Schema.minItems(1), Schema.maxItems(16))),
  /** Sample name list for samples (plan indices refer to this ordering).
   * The character set of names is constrained at declaration — the LLM never writes them, but this is the safety basis of the sent string */
  vocab: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.pattern(SAFE_SAMPLE_NAME_RE))).pipe(Schema.minItems(1), Schema.maxItems(64)),
  ),
}).pipe(
  Schema.filter(
    (s) => s.nRange === undefined || s.nSet === undefined || 'nRange and nSet are exclusive (write only one of them)',
  ),
  Schema.filter(
    (s) =>
      s.generator !== 'nsteps' ||
      s.nRange !== undefined ||
      s.nSet !== undefined ||
      'an nsteps slot requires nRange or nSet (the manifest declares the allowed values; no implicit default)',
  ),
  Schema.filter(
    (s) =>
      s.generator === 'nsteps' ||
      (s.nRange === undefined && s.nSet === undefined) ||
      'nRange and nSet are only allowed on nsteps slots',
  ),
  Schema.filter(
    (s) => s.generator !== 'samples' || s.vocab !== undefined || 'a samples slot requires vocab (the sample name list)',
  ),
  Schema.filter((s) => s.generator === 'samples' || s.vocab === undefined || 'vocab is only allowed on samples slots'),
)

/** Stable ID: the key of the persistent veto/mark memory. Lowercase alphanumerics and hyphens only (the display name is name) */
const MANIFEST_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export const manifestSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(MANIFEST_ID_RE)),
  /** Display name (optional; id is displayed when absent) */
  name: Schema.optional(Schema.String),
  /** Declaration of the overall mood (optional). Passed to the Brain prompt as style. When absent the field is omitted from the prompt entirely */
  style: Schema.optional(Schema.String),
  defaultLengthCycles: Schema.Literal(1, 2, 4, 8),
  /** Whether the Brain may produce transitions (announced fills). Default true */
  allowTransition: Schema.optional(Schema.Boolean),
  slots: Schema.Array(slotSpecSchema).pipe(Schema.minItems(1), Schema.maxItems(8)),
}).pipe(
  Schema.filter((m) => new Set(m.slots.map((s) => s.slot)).size === m.slots.length || 'slot numbers must be unique'),
)

export type SlotSpec = Schema.Schema.Type<typeof slotSpecSchema>
export type Manifest = Schema.Schema.Type<typeof manifestSchema>

// Unknown fields (legacy song / styles etc.) are errors — silently dropping them leads to
// "I wrote it but it has no effect" accidents (matches additionalProperties: false in the generated JSON Schema)
const decodeManifest = Schema.decodeUnknownEither(manifestSchema, { onExcessProperty: 'error' })

export const manifestLabel = (m: Manifest): string => m.name ?? m.id

const OK_TYPES: Readonly<Record<SlotSpec['generator'], ReadonlyArray<string>>> = {
  struct: ['euclid', 'grid', 'silence'],
  nsteps: ['nsteps', 'silence'],
  samples: ['samples', 'silence'],
}

/** Enumerate the numeric cells (nsteps / samples indices) in a pattern */
const indexCells = (p: PhrasePlanV1['slots'][number]['pattern']): ReadonlyArray<number> =>
  p.type === 'nsteps' || p.type === 'samples' ? p.variants.flatMap((v) => v.filter((c): c is number => c !== '~')) : []

/** Check indices for deviation from the declared value domain (nRange / nSet / vocab) */
const valueViolations = (spec: SlotSpec, p: PhrasePlanV1['slots'][number]['pattern']): ReadonlyArray<string> => {
  const cells = indexCells(p)
  if (spec.generator === 'samples' && p.type === 'samples') {
    const size = spec.vocab?.length ?? 0
    return cells
      .filter((c) => c >= size)
      .map((c) => `slot ${spec.slot}: samples value ${c} is outside the vocab range (0..${size - 1})`)
  }
  if (spec.generator === 'nsteps' && p.type === 'nsteps') {
    if (spec.nSet !== undefined) {
      const set = new Set(spec.nSet)
      return cells
        .filter((c) => !set.has(c))
        .map((c) => `slot ${spec.slot}: nsteps value ${c} is outside nSet [${spec.nSet!.join(',')}]`)
    }
    if (spec.nRange !== undefined) {
      const [lo, hi] = spec.nRange
      return cells
        .filter((c) => c < lo || c > hi)
        .map((c) => `slot ${spec.slot}: nsteps value ${c} is outside nRange [${lo},${hi}]`)
    }
  }
  return []
}

/**
 * Consistency check between a plan and the manifest's slot declarations. null = consistent.
 * The schema cannot constrain the combination of pattern type and slot — when nsteps (a numeric
 * sequence) lands on a struct slot, the Bool parse in the actual wiring fails and the slot goes silent.
 * Values are checked as well as types: an nsteps value outside nRange / nSet, or a samples index
 * outside vocab, degrades the plan — one philosophy of "type + value".
 * Slots missing from the plan are not violations here — they are filled with "~" at send time
 * (scheduler.renderSends), so the previous phrase's pattern never lingers
 */
export const planManifestMismatch = (plan: PhrasePlanV1, manifest: Manifest): string | null => {
  const specOf = new Map(manifest.slots.map((s) => [s.slot, s] as const))
  const bad = plan.slots.flatMap((s) => {
    const spec = specOf.get(s.slot)
    if (spec === undefined) return [`slot ${s.slot} is not declared in the manifest`]
    return [s.pattern, ...(s.transition === undefined ? [] : [s.transition])].flatMap((p) =>
      OK_TYPES[spec.generator].includes(p.type)
        ? valueViolations(spec, p)
        : [`slot ${s.slot} (${spec.generator}) got ${p.type}`],
    )
  })
  return bad.length === 0 ? null : bad.join(', ')
}

/** Read a single manifest file (schema violation is Left) */
export const loadManifestFile = (path: string): Either.Either<Manifest, string> => {
  const raw = Either.try(() => JSON.parse(readFileSync(path, 'utf8')) as unknown)
  if (Either.isLeft(raw)) return Either.left(`${path}: cannot read (${String(raw.left)})`)
  return Either.mapLeft(decodeManifest(raw.right), (e) => `${path}: schema violation — ${String(e)}`)
}

/** Read every *.json in a directory (invalid ones are warned about and dropped). For batch use such as training data generation */
export const loadManifests = (dir: string): ReadonlyArray<Manifest> =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const result = loadManifestFile(join(dir, f))
      if (Either.isLeft(result)) {
        console.warn(`[ai] manifest ${basename(f)} ignored: schema violation`)
        return []
      }
      return [result.right]
    })
