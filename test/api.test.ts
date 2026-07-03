import { describe, expect, it } from 'vitest'
import { Effect, Either, JSONSchema, Schema } from 'effect'
import {
  API_DEFAULT_MODEL,
  API_KEY_ENV,
  makeApiBrain,
  parseApiProvider,
  planBoundsFor,
  resolveApiModel,
  toGoogleSafeSchema,
  type ApiProvider,
} from '../src/conductor/brain/api.js'
import { chainFor } from '../src/conductor/brain/index.js'
import type { Brain } from '../src/conductor/brain/types.js'
import { loadManifestFile, manifestSchema, planManifestMismatch, type Manifest } from '../src/conductor/manifest.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePhrasePlanV1, phrasePlanV1Schema, phrasePlanV1SchemaFor } from '../src/schema.js'

// Tests for the pure parts of the api Brain.
// The network path (actually calling nextPlan) is not covered here —
// connectivity is verified with pnpm api-smoke (requires an API key).

const PROVIDERS: ReadonlyArray<ApiProvider> = ['google', 'anthropic', 'openai']

const stub = (mode: string): Brain => ({
  mode,
  nextPlan: () => Effect.die('stub'),
})

describe('api brain (pure parts)', () => {
  it('parseApiProvider: defaults to google, and unknown values also fall back to google', () => {
    expect(parseApiProvider(undefined)).toBe('google')
    expect(parseApiProvider('mistral')).toBe('google')
    PROVIDERS.forEach((p) => expect(parseApiProvider(p)).toBe(p))
  })

  it('default model and key env are defined for all 3 providers', () => {
    PROVIDERS.forEach((p) => {
      expect(API_DEFAULT_MODEL[p]).toBeTruthy()
      expect(API_KEY_ENV[p]).toMatch(/_API_KEY$/)
    })
  })

  it('resolveApiModel: null means the provider default, an explicit value wins', () => {
    expect(resolveApiModel({ provider: 'google', model: null, timeoutMs: 1 })).toBe(API_DEFAULT_MODEL['google'])
    expect(resolveApiModel({ provider: 'google', model: 'gemini-x', timeoutMs: 1 })).toBe('gemini-x')
  })

  it("mode is exactly 'api' (the conductor compares it with brainMode to notify degradation)", () => {
    PROVIDERS.forEach((p) => expect(makeApiBrain({ provider: p, model: null, timeoutMs: 1000 }).mode).toBe('api'))
  })

  it('the output contract JSON Schema is flat (no $ref/$defs — compatible with structured output of all 3 providers)', () => {
    const s = JSON.stringify(JSONSchema.make(phrasePlanV1Schema))
    expect(s).not.toContain('$ref')
    expect(s).not.toContain('$defs')
  })

  it('toGoogleSafeSchema: removes numeric enums and keeps the allowed values in description (works around Google 400)', () => {
    const collectNumericEnums = (node: unknown): ReadonlyArray<unknown> =>
      Array.isArray(node)
        ? node.flatMap(collectNumericEnums)
        : typeof node !== 'object' || node === null
          ? []
          : Object.entries(node).flatMap(([k, v]) =>
              k === 'enum' && Array.isArray(v) && v.some((x) => typeof x === 'number') ? [v] : collectNumericEnums(v),
            )
    const original = JSONSchema.make(phrasePlanV1Schema)
    // the original schema has numeric enums (version / lengthCycles)...
    expect(collectNumericEnums(original).length).toBeGreaterThan(0)
    // ...after conversion there are none, and the allowed values move to the description
    const safe = toGoogleSafeSchema(original)
    expect(collectNumericEnums(safe)).toEqual([])
    expect(JSON.stringify(safe)).toContain('allowed values: 1 | 2 | 4 | 8')
    // string enums (grid x/~ etc.) are preserved
    expect(JSON.stringify(safe)).toContain('"enum"')
  })
})

describe('planManifestMismatch (slot type consistency — the defense at Brain acceptance)', () => {
  const manifest: Manifest = {
    id: 't',
    defaultLengthCycles: 4,
    slots: [
      { slot: 1, generator: 'struct', role: 'perc' },
      { slot: 3, generator: 'nsteps', role: 'n', nRange: [0, 7] },
    ],
  }
  const plan = (slots: ReadonlyArray<unknown>) => parsePhrasePlanV1({ version: 1, energy: 0.5, lengthCycles: 4, slots })

  it('a consistent plan (silence is fine in either slot) gives null', () => {
    expect(
      planManifestMismatch(
        plan([
          { slot: 1, pattern: { type: 'euclid', pulses: 3, steps: 8 } },
          { slot: 3, pattern: { type: 'silence' } },
        ]),
        manifest,
      ),
    ).toBeNull()
  })

  it('nsteps in a struct slot → violation (a Bool parse failure in the real wiring = source of silence; surfaced with a 1B model on hardware)', () => {
    expect(
      planManifestMismatch(plan([{ slot: 1, pattern: { type: 'nsteps', variants: [[4, 7]] } }]), manifest),
    ).toContain('slot 1')
  })

  it('euclid in an nsteps slot → violation', () => {
    expect(
      planManifestMismatch(plan([{ slot: 3, pattern: { type: 'euclid', pulses: 3, steps: 8 } }]), manifest),
    ).toContain('slot 3')
  })

  it('a slot not declared in the manifest → violation', () => {
    expect(planManifestMismatch(plan([{ slot: 2, pattern: { type: 'silence' } }]), manifest)).toContain('slot 2')
  })

  it('type violations in transition are detected too', () => {
    expect(
      planManifestMismatch(
        plan([
          {
            slot: 1,
            pattern: { type: 'euclid', pulses: 3, steps: 8 },
            transition: { type: 'nsteps', variants: [[0, 1]] },
          },
        ]),
        manifest,
      ),
    ).toContain('slot 1')
  })
})

describe('planManifestMismatch (value consistency)', () => {
  const manifest: Manifest = {
    id: 't',
    defaultLengthCycles: 4,
    slots: [
      { slot: 1, generator: 'nsteps', role: 'range', nRange: [0, 7] },
      { slot: 2, generator: 'nsteps', role: 'set', nSet: [0, 2, 7] },
      { slot: 3, generator: 'samples', role: 'kit', vocab: ['bd:0', 'sn:0', 'hat:0'] },
      { slot: 4, generator: 'nsteps', role: 'free' },
    ],
  }
  const plan = (slots: ReadonlyArray<unknown>) => parsePhrasePlanV1({ version: 1, energy: 0.5, lengthCycles: 4, slots })

  it('within range (nRange / nSet / vocab) gives null', () => {
    expect(
      planManifestMismatch(
        plan([
          { slot: 1, pattern: { type: 'nsteps', variants: [[0, 7, '~']] } },
          { slot: 2, pattern: { type: 'nsteps', variants: [[2, '~', 7]] } },
          { slot: 3, pattern: { type: 'samples', variants: [[0, '~', 2]] } },
        ]),
        manifest,
      ),
    ).toBeNull()
  })

  it('an nsteps value outside nRange → violation', () => {
    expect(
      planManifestMismatch(plan([{ slot: 1, pattern: { type: 'nsteps', variants: [[0, 8]] } }]), manifest),
    ).toContain('nRange')
  })

  it('an nsteps value outside nSet → violation (rejected even within range if not in the set)', () => {
    expect(
      planManifestMismatch(plan([{ slot: 2, pattern: { type: 'nsteps', variants: [[0, 3]] } }]), manifest),
    ).toContain('nSet')
  })

  it('a samples index outside the vocab range → violation', () => {
    expect(
      planManifestMismatch(plan([{ slot: 3, pattern: { type: 'samples', variants: [[0, 3]] } }]), manifest),
    ).toContain('vocab')
  })

  it('nsteps in a samples slot / samples in an nsteps slot → type violation', () => {
    expect(
      planManifestMismatch(plan([{ slot: 3, pattern: { type: 'nsteps', variants: [[0, 1]] } }]), manifest),
    ).toContain('slot 3')
    expect(
      planManifestMismatch(plan([{ slot: 1, pattern: { type: 'samples', variants: [[0, 1]] } }]), manifest),
    ).toContain('slot 1')
  })

  it('an nsteps slot without nRange/nSet has no value check (backward compatible)', () => {
    expect(
      planManifestMismatch(plan([{ slot: 4, pattern: { type: 'nsteps', variants: [[0, 63]] } }]), manifest),
    ).toBeNull()
  })

  it('value violations in transition are detected too', () => {
    expect(
      planManifestMismatch(
        plan([
          {
            slot: 2,
            pattern: { type: 'nsteps', variants: [[0, 2]] },
            transition: { type: 'nsteps', variants: [[5, 5]] },
          },
        ]),
        manifest,
      ),
    ).toContain('nSet')
  })
})

describe('slotSpec schema (declaration rules for nSet / vocab)', () => {
  const decode = Schema.decodeUnknownEither(manifestSchema)
  const base = { id: 't', defaultLengthCycles: 4 as const }

  it('declaring both nRange and nSet is a schema error', () => {
    const r = decode({
      ...base,
      slots: [{ slot: 1, generator: 'nsteps', role: 'n', nRange: [0, 7], nSet: [0, 2] }],
    })
    expect(Either.isLeft(r)).toBe(true)
  })

  it('samples requires vocab, and vocab is not allowed on anything but samples', () => {
    expect(Either.isLeft(decode({ ...base, slots: [{ slot: 1, generator: 'samples', role: 'kit' }] }))).toBe(true)
    expect(
      Either.isLeft(
        decode({
          ...base,
          slots: [{ slot: 1, generator: 'struct', role: 'p', vocab: ['bd:0'] }],
        }),
      ),
    ).toBe(true)
  })

  it('vocab names are constrained to a character set (whitespace or symbols are rejected at declaration)', () => {
    expect(
      Either.isLeft(
        decode({
          ...base,
          slots: [{ slot: 1, generator: 'samples', role: 'kit', vocab: ['bd sn'] }],
        }),
      ),
    ).toBe(true)
    expect(
      Either.isRight(
        decode({
          ...base,
          slots: [
            {
              slot: 1,
              generator: 'samples',
              role: 'kit',
              vocab: ['bd:0', 'my_kit_ch'],
            },
          ],
        }),
      ),
    ).toBe(true)
  })
})

describe('chainFor (degradation chain composition)', () => {
  const pool = stub('pool')
  const api = stub('api')
  const local = stub('local')
  const modes = (chain: readonly Brain[]): ReadonlyArray<string> => chain.map((b) => b.mode)

  it('api → pool → offline', () => {
    expect(modes(chainFor('api', pool, api, local))).toEqual(['api', 'pool', 'offline'])
  })

  it('pool → offline', () => {
    expect(modes(chainFor('pool', pool, api, local))).toEqual(['pool', 'offline'])
  })

  it('offline stands alone (last line of defense)', () => {
    expect(modes(chainFor('offline', pool, api, local))).toEqual(['offline'])
  })

  it('local → pool → offline (the foundation is always pool)', () => {
    expect(modes(chainFor('local', pool, api, local))).toEqual(['local', 'pool', 'offline'])
  })
})

describe('planBoundsFor / dynamic schema (narrowing the generation contract bounds)', () => {
  it('derives the manifest upper bounds from nRange / nSet / vocab (coarse bound = the largest value allowed in the manifest)', () => {
    expect(
      planBoundsFor({
        id: 't',
        defaultLengthCycles: 4,
        slots: [
          { slot: 1, generator: 'nsteps', role: 'a', nRange: [0, 4] },
          { slot: 2, generator: 'nsteps', role: 'b', nSet: [0, 2, 7] },
          { slot: 3, generator: 'samples', role: 'kit', vocab: ['a:0', 'b:0', 'c:0'] },
        ],
      }),
    ).toEqual({ nMax: 7, sampleMax: 2 })
  })

  it('an nsteps without a declared range restores the loose default (127); absent types keep the default', () => {
    expect(
      planBoundsFor({
        id: 't',
        defaultLengthCycles: 4,
        slots: [
          { slot: 1, generator: 'nsteps', role: 'free' },
          { slot: 2, generator: 'struct', role: 'p' },
        ],
      }),
    ).toEqual({ nMax: 127, sampleMax: 63 })
  })

  it('the narrowed schema JSON carries the narrowed maximum (the substance of the grammar constraint)', () => {
    const json = JSON.stringify(JSONSchema.make(phrasePlanV1SchemaFor({ nMax: 5, sampleMax: 2 })))
    expect(json).toContain('"maximum":5')
    expect(json).toContain('"maximum":2')
    // the static schema (acceptance-time validation) is unchanged
    const staticJson = JSON.stringify(JSONSchema.make(phrasePlanV1Schema))
    expect(staticJson).toContain('"maximum":127')
    expect(staticJson).toContain('"maximum":63')
  })
})

describe('manifest schema (id / name / style / allowTransition)', () => {
  const decode = Schema.decodeUnknownEither(manifestSchema)
  const slots = [{ slot: 1, generator: 'struct', role: 'perc' }]

  it('id is lowercase alphanumerics and hyphens only; name / style / allowTransition are optional', () => {
    expect(Either.isRight(decode({ id: 'my-set-2', defaultLengthCycles: 4, slots }))).toBe(true)
    expect(
      Either.isRight(
        decode({ id: 'x', name: 'My Set', style: 'dub', allowTransition: false, defaultLengthCycles: 4, slots }),
      ),
    ).toBe(true)
    expect(Either.isLeft(decode({ id: 'My Set', defaultLengthCycles: 4, slots }))).toBe(true)
    expect(Either.isLeft(decode({ id: '-x', defaultLengthCycles: 4, slots }))).toBe(true)
    expect(Either.isLeft(decode({ defaultLengthCycles: 4, slots }))).toBe(true)
  })

  it('the legacy format (song / styles.scenes) is rejected', () => {
    expect(Either.isLeft(decode({ song: 'x', defaultLengthCycles: 4, slots }))).toBe(true)
  })

  it('unknown fields are an error when loading the file (not silently dropped)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-manifest-'))
    const path = join(dir, 'm.json')
    writeFileSync(
      path,
      JSON.stringify({ id: 'x', defaultLengthCycles: 4, slots, song: 'legacy', styles: { scenes: [] } }),
    )
    expect(Either.isLeft(loadManifestFile(path))).toBe(true)
    writeFileSync(path, JSON.stringify({ id: 'x', defaultLengthCycles: 4, slots }))
    expect(Either.isRight(loadManifestFile(path))).toBe(true)
  })

  it('an nsteps slot declares exactly one of nRange / nSet, and other generators may declare neither', () => {
    const manifest = (slot: Record<string, unknown>) => decode({ id: 'x', defaultLengthCycles: 4, slots: [slot] })
    expect(Either.isLeft(manifest({ slot: 1, generator: 'nsteps', role: 'n' }))).toBe(true)
    expect(Either.isRight(manifest({ slot: 1, generator: 'nsteps', role: 'n', nRange: [0, 7] }))).toBe(true)
    expect(Either.isRight(manifest({ slot: 1, generator: 'nsteps', role: 'n', nSet: [0, 2] }))).toBe(true)
    expect(Either.isLeft(manifest({ slot: 1, generator: 'nsteps', role: 'n', nRange: [0, 7], nSet: [0] }))).toBe(true)
    expect(Either.isLeft(manifest({ slot: 1, generator: 'struct', role: 'p', nRange: [0, 7] }))).toBe(true)
    expect(Either.isLeft(manifest({ slot: 1, generator: 'samples', role: 's', vocab: ['bd'], nSet: [0] }))).toBe(true)
    expect(Either.isRight(manifest({ slot: 1, generator: 'samples', role: 's', vocab: ['bd'] }))).toBe(true)
  })

  it('nRange is rejected unless in [min, max] order', () => {
    const withRange = (nRange: [number, number]) =>
      decode({ id: 'x', defaultLengthCycles: 4, slots: [{ slot: 1, generator: 'nsteps', role: 'n', nRange }] })
    expect(Either.isLeft(withRange([7, 0]))).toBe(true)
    expect(Either.isRight(withRange([0, 7]))).toBe(true)
  })
})
