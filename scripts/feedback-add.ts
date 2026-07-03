import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addToFeedback, collectFeedback, parseFeedbackFile, type FeedbackMap } from '../src/conductor/vetoMemory.js'

// Fold the veto / mark collected during a rehearsal into the distilled feedback file:
//   pnpm feedback-add sessions/session-2026-….jsonl
// plans/feedback.json lives in plans/ (not gitignored: commit it if it should persist) — unlike session logs (ignored, and only the latest 30 are read
// at startup) it persists as feedback that was kept on purpose. Keyed by manifest id.
// Idempotent: importing the same log twice does not duplicate entries (same approach as pool-add).

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sessionPath = process.argv[2]
if (sessionPath === undefined) {
  console.error('Usage: pnpm feedback-add <session-log.jsonl>')
  process.exit(1)
}

const collected = collectFeedback(readFileSync(sessionPath, 'utf8').split('\n'))
const countOf = (map: FeedbackMap): number =>
  Object.values(map).reduce((n, fb) => n + fb.veto.length + fb.mark.length, 0)
if (countOf(collected) === 0) {
  console.log('no veto / mark found')
  process.exit(0)
}

const filePath = join(pkgRoot, 'plans', 'feedback.json')
const base: FeedbackMap = existsSync(filePath) ? parseFeedbackFile(readFileSync(filePath, 'utf8')) : {}
const merged = addToFeedback(base, collected)
writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n')
Object.entries(collected).forEach(([id, fb]) => console.log(`${id}: veto ${fb.veto.length} / mark ${fb.mark.length}`))
console.log(`→ added ${countOf(merged) - countOf(base)} to plans/feedback.json (total ${countOf(merged)})`)
