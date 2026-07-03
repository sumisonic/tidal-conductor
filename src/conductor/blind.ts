import type { BrainMode } from './brain/types.js'

// Pair balancing for blind A/B (pure part).
// The contest pair defaults to api vs pool and is changeable via AI_BLIND_PAIR.
// Only the lines of the "current pair" in blind-log are counted: an even count means the
// first run of a new round (coin), an odd count the second run (the opposite of the first) —
// structurally ruling out same-mode contests.
//
// Pairs are identified by the pairKey stamped on the log line. Matching by mode name alone is
// not enough: a mode such as pool can belong to several pairs over time, and lines from another
// pair would pollute the parity and allow same-mode contests. Lines without a pairKey are not counted.

export type BlindPair = readonly [BrainMode, BrainMode]

export const DEFAULT_BLIND_PAIR: BlindPair = ['api', 'pool']

const isMode = (s: string): s is BrainMode =>
  s === 'api' || s === 'pool' || s === 'offline' || s === 'local' || s === 'hybrid'

export const parseBlindPair = (v: string | undefined): BlindPair => {
  const parts = (v ?? '').split(',').map((s) => s.trim())
  const [a, b] = [parts[0] ?? '', parts[1] ?? '']
  return parts.length === 2 && isMode(a) && isMode(b) && a !== b ? [a, b] : DEFAULT_BLIND_PAIR
}

/** Normalized pair name stamped on the log (independent of the order given in AI_BLIND_PAIR) */
export const pairKey = (pair: BlindPair): string => [...pair].sort().join(',')

/** Decide this run's mode from the blind-log lines ("<ts> <mode> <pairKey>") and a coin flip */
export const pickBlind = (lines: ReadonlyArray<string>, pair: BlindPair, coin: boolean): BrainMode => {
  const key = pairKey(pair)
  const inPair = lines
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[2] === key)
    .map((parts) => parts[1] ?? '')
    .filter((m) => m === pair[0] || m === pair[1])
  if (inPair.length % 2 === 1) return inPair.at(-1) === pair[0] ? pair[1] : pair[0]
  return coin ? pair[0] : pair[1]
}
