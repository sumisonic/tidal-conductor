import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// GHCi's `:script` treats a decoding error while reading a line like end-of-file and stops
// SILENTLY (GHCi.UI fileLoop), and under a C/POSIX locale (the Nix sandbox on Linux, some CI
// images) any non-ASCII byte is such an error. The first CI run lost every definition of
// Conductor.tidal to an em dash in a comment. The files GHCi loads, and the fixtures piped into
// the runner's stdin, therefore stay pure ASCII.
const guarded: ReadonlyArray<string> = [
  'integration/tidal/Conductor.tidal',
  'haskell/AiPatSpec.tidal',
  ...readdirSync('haskell/fixtures')
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => join('haskell/fixtures', f)),
]

describe('files read by GHCi under an unknown locale are ASCII', () => {
  guarded.forEach((path) => {
    it(path, () => {
      const text = readFileSync(path, 'utf8')
      const offenders = [...text].filter((c) => c.charCodeAt(0) > 0x7f)
      expect(offenders, `non-ASCII characters in ${path}: ${[...new Set(offenders)].join(' ')}`).toEqual([])
    })
  })
})
