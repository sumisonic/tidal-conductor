// NDJSON pattern cases for haskell/ParseBPCheck.hs: one {"kind","pattern"} object per line.
// kind is the Pattern type the real wiring reads the string as: bool (struct), note (nsteps), string (samples names).

type CaseKind = 'bool' | 'note' | 'string'

export interface PatternCase {
  readonly kind: CaseKind
  readonly pattern: string
}

export const toNdjson = (cases: ReadonlyArray<PatternCase>): string =>
  cases.map((c) => JSON.stringify(c)).join('\n') + '\n'

/** Deduplicate and sort per kind (stable output for diffs) */
export const casesOf = (args: {
  readonly boolPats: ReadonlyArray<string>
  readonly notePats: ReadonlyArray<string>
  readonly stringPats?: ReadonlyArray<string>
}): ReadonlyArray<PatternCase> => {
  const uniq = (xs: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(xs)].sort()
  return [
    ...uniq(args.boolPats).map((pattern): PatternCase => ({ kind: 'bool', pattern })),
    ...uniq(args.notePats).map((pattern): PatternCase => ({ kind: 'note', pattern })),
    ...uniq(args.stringPats ?? []).map((pattern): PatternCase => ({ kind: 'string', pattern })),
  ]
}
