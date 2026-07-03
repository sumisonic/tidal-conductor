import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSONSchema } from 'effect'
import { manifestSchema } from '../src/conductor/manifest.js'
import { phrasePlanSchema, phrasePlanV1Schema } from '../src/schema.js'

// Derive JSON Schema from the Effect Schema definitions (pnpm emit-schema).
// Uses: (a) the structured-output contract for the Brain (api mode), (b) an aid for people writing manifests / pools.
// The schema definitions (src/schema.ts, src/conductor/manifest.ts) are the single source of truth —
// what is emitted here is always a derived artifact.
//
// Note: Schema.filter refinements with no JSON Schema representation (pulses <= steps, etc.) do not
// appear in the output. LLM output must always be double-validated with parsePhrasePlanV1.

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'phrase-plan-v0.schema.json'),
  JSON.stringify(JSONSchema.make(phrasePlanSchema), null, 2) + '\n',
)
writeFileSync(
  join(outDir, 'phrase-plan-v1.schema.json'),
  JSON.stringify(JSONSchema.make(phrasePlanV1Schema), null, 2) + '\n',
)
writeFileSync(join(outDir, 'manifest.schema.json'), JSON.stringify(JSONSchema.make(manifestSchema), null, 2) + '\n')
console.log('wrote schema/phrase-plan-v0.schema.json / phrase-plan-v1.schema.json / manifest.schema.json')
