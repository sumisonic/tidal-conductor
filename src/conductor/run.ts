import { randomInt } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Either, Exit, Fiber } from 'effect'
import { defaultConfig, startConductor, type NotifyTarget } from './conductor.js'
import { API_KEY_ENV, hasApiKey, parseApiProvider, type ApiProvider } from './brain/api.js'
import { pairKey, parseBlindPair, pickBlind } from './blind.js'
import { isChannel } from './channel.js'
import { readHostPort, readInt, readMs, readPort } from './env.js'
import { loadManifestFile } from './manifest.js'
import { collectFeedback, mergeFeedback, parseFeedbackFile, summarizeFeedback, type FeedbackMap } from './vetoMemory.js'
import type { BrainMode } from './brain/types.js'

// Conductor entry point: pnpm conductor --manifest <path>
//
// Required:
//   --manifest <path> or AI_MANIFEST=<path>   the manifest (JSON) fixed at startup
// Overridable via environment variables:
//   AI_BRAIN=pool|offline|api|hybrid|local|blind (default pool)
//   AI_PROVIDER=google|anthropic|openai (the LLM for api. Default google)
//   AI_BRAIN_MODEL (model override for api. Unset = the provider's default)
//   AI_LOCAL_URL / AI_LOCAL_MODEL (local. The model name is required — experimental)
//   AI_HYBRID_EVERY (hybrid: every how many phrases the api Brain takes a turn. Default 4)
//   AI_CHANNEL (namespace of the Tidal-side keys ai/<channel>/…. Default 1)
//   AI_TIDAL_HOST / AI_TIDAL_PORT / AI_LISTEN_HOST / AI_LISTEN_PORT / AI_SCLANG_HOST / AI_SCLANG_PORT
//   AI_WALK_INTERVAL_MS / AI_SEND_AHEAD_MS (default 375 — match Tidal's cProcessAhead)
//   AI_KICKSTART_MS (default 3000: send the first plan unquantized if no clock arrives by then; 0 disables)
//   AI_BRAIN_LEAD_MS (Brain request lead. Default 5000) / AI_API_TIMEOUT_MS (Brain deadline.
//     Default 4500 = lead − send-ahead 375 − margin 125. Warns when lead − deadline < 500 ms)
//   AI_NOTIFY=host:port (/ai/status target for Brain degradation/recovery. Not sent by default)
//   AI_VETO_MEMORY (=0 disables the persistent feedback context) /
//   AI_VETO_MEMORY_N (number of vetos, default 12) / AI_MARK_MEMORY_N (number of marks, default 8)
//   AI_POOL_EXTRA=plans/candidates.json (mix unscreened candidates into the pool — rehearsal only)
// api/hybrid need each vendor's standard env key (see .env.example).
//
// AI_BRAIN=blind: for A/B trials. Picks from the contest pair (default api vs pool; AI_BLIND_PAIR=pool,offline etc.)
// with pair balancing, and hides it in logs as brain=?. The answer is sealed into sessions/blind-log.txt
// on exit (do not open it until scoring is done).

const env = (name: string): string | undefined => process.env[name]

/** Invalid environment variables refuse startup (never run silently with NaN or out-of-range values) */
const must = <A>(r: Either.Either<A, string>): A => {
  if (Either.isLeft(r)) {
    console.error(`[ai] ${r.left}`)
    process.exit(1)
  }
  return r.right
}
const envInt = (name: string, fallback: number): number => must(readMs(env, name, fallback))
const envPort = (name: string, fallback: number): number => must(readPort(env, name, fallback))

const argAfter = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const blindLogPath = join(pkgRoot, 'sessions', 'blind-log.txt')

const blindLogLines = (): ReadonlyArray<string> =>
  existsSync(blindLogPath)
    ? readFileSync(blindLogPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
    : []

const BRAIN_MODES: ReadonlyArray<string> = ['pool', 'offline', 'api', 'hybrid', 'local', 'blind']

const resolveBrain = (): {
  mode: BrainMode
  blind: boolean
  provider: ApiProvider
} => {
  const v = process.env['AI_BRAIN']
  if (v !== undefined && !BRAIN_MODES.includes(v)) {
    console.error(`[ai] AI_BRAIN must be one of ${BRAIN_MODES.join('|')}: ${v}`)
    process.exit(1)
  }
  const providerRaw = process.env['AI_PROVIDER']
  const provider = parseApiProvider(providerRaw)
  if (providerRaw !== undefined && provider !== providerRaw) {
    console.error(`[ai] AI_PROVIDER must be one of google|anthropic|openai: ${providerRaw}`)
    process.exit(1)
  }
  if (v === 'blind') {
    const pair = parseBlindPair(process.env['AI_BLIND_PAIR'])
    return {
      // The blind A/B tiebreak is intentionally non-deterministic (fairness of the experimental assignment).
      // The project's runSeeded is deterministic and counterproductive here, so node:crypto is used.
      mode: pickBlind(blindLogLines(), pair, randomInt(2) === 0),
      blind: true,
      provider,
    }
  }
  return {
    mode:
      v === 'pool' || v === 'api' || v === 'hybrid' || v === 'local' || v === 'offline' ? v : defaultConfig.brainMode,
    blind: false,
    provider,
  }
}

const brain = resolveBrain()

if (brain.blind && !hasApiKey(brain.provider)) {
  // Without the api key in blind mode every api turn degrades to pool, making it effectively
  // pool vs pool and breaking the experiment itself — refuse to start
  console.error(
    `[ai] blind aborted: ${API_KEY_ENV[brain.provider]} is not set (api would always degrade, so the comparison is meaningless)`,
  )
  process.exit(1)
}

if (!brain.blind && (brain.mode === 'api' || brain.mode === 'hybrid') && !hasApiKey(brain.provider))
  console.warn(`[ai] ★ ${API_KEY_ENV[brain.provider]} is not set — api turns will degrade to pool when called`)

const localModel = process.env['AI_LOCAL_MODEL'] ?? ''
if (brain.mode === 'local' && localModel === '') {
  console.error(
    '[ai] AI_BRAIN=local requires AI_LOCAL_MODEL (the Ollama model name) — local is experimental and has no default model',
  )
  process.exit(1)
}

// manifest (required): one is fixed at startup
const manifestArg = argAfter('--manifest') ?? process.env['AI_MANIFEST']
if (manifestArg === undefined) {
  console.error('[ai] usage: pnpm conductor --manifest <manifest.json> (or AI_MANIFEST=<path>)')
  process.exit(1)
}
const manifestPath = resolve(manifestArg)
const manifestResult = loadManifestFile(manifestPath)
if (Either.isLeft(manifestResult)) {
  console.error(`[ai] cannot read manifest: ${manifestResult.left}`)
  process.exit(1)
}
const manifest = manifestResult.right

const channel = must(readInt(env, 'AI_CHANNEL', defaultConfig.channel, { min: 1, max: 1_000_000 }))
if (!isChannel(channel)) {
  console.error(`[ai] AI_CHANNEL must be an integer >= 1: ${process.env['AI_CHANNEL']}`)
  process.exit(1)
}
const notify: NotifyTarget | null = must(readHostPort(env, 'AI_NOTIFY'))

// Persistent feedback context: two layers — the distilled file plans/feedback.json (kept in plans/, commit it to persist;
// grown after rehearsals with pnpm feedback-add) merged with a reconstruction from the last 30 session
// logs, summarized per manifest and injected into the Brain's system prompt as "shapes to avoid" / "shapes that were liked".
// AI_VETO_MEMORY=0 disables both; AI_VETO_MEMORY_N / AI_MARK_MEMORY_N set the counts
// (default 12 / 8 — the lists are kept small in consideration of small models' instruction following)
const feedback: FeedbackMap = ((): FeedbackMap => {
  if (process.env['AI_VETO_MEMORY'] === '0') return {}
  const filePath = join(pkgRoot, 'plans', 'feedback.json')
  const distilled = existsSync(filePath) ? parseFeedbackFile(readFileSync(filePath, 'utf8')) : {}
  const dir = join(pkgRoot, 'sessions')
  const lines = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'))
        .sort() // file name = ISO timestamp → lexical order = chronological
        .slice(-30)
        .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    : []
  return summarizeFeedback(
    mergeFeedback(distilled, collectFeedback(lines)),
    envInt('AI_VETO_MEMORY_N', 12),
    envInt('AI_MARK_MEMORY_N', 8),
  )
})()
const fbThis = feedback[manifest.id]
if (fbThis !== undefined && fbThis.veto.length + fbThis.mark.length > 0)
  console.log(
    `[ai] feedback memory: ${manifest.id} (veto ${fbThis.veto.length}/mark ${fbThis.mark.length}) (disable with AI_VETO_MEMORY=0)`,
  )

const config = {
  ...defaultConfig,
  tidalHost: process.env['AI_TIDAL_HOST'] ?? defaultConfig.tidalHost,
  tidalPort: envPort('AI_TIDAL_PORT', defaultConfig.tidalPort),
  listenHost: process.env['AI_LISTEN_HOST'] ?? defaultConfig.listenHost,
  listenPort: envPort('AI_LISTEN_PORT', defaultConfig.listenPort),
  sclangHost: process.env['AI_SCLANG_HOST'] ?? defaultConfig.sclangHost,
  sclangPort: envPort('AI_SCLANG_PORT', defaultConfig.sclangPort),
  channel,
  manifest,
  walkIntervalMs: envInt('AI_WALK_INTERVAL_MS', defaultConfig.walkIntervalMs),
  brainMode: brain.mode,
  maskBrain: brain.blind,
  poolPaths: [
    join(pkgRoot, 'plans', 'pool.json'),
    // Rehearsal-only candidates (unscreened plans). Mixed in only when AI_POOL_EXTRA is set —
    // mark the good ones → pool-add promotes them to the official stock
    ...(process.env['AI_POOL_EXTRA'] === undefined ? [] : [resolve(process.env['AI_POOL_EXTRA'])]),
  ],
  apiProvider: brain.provider,
  apiModel: process.env['AI_BRAIN_MODEL'] ?? null,
  apiTimeoutMs: envInt('AI_API_TIMEOUT_MS', defaultConfig.apiTimeoutMs),
  brainLeadMs: envInt('AI_BRAIN_LEAD_MS', defaultConfig.brainLeadMs),
  sendAheadMs: envInt('AI_SEND_AHEAD_MS', defaultConfig.sendAheadMs),
  kickstartMs: envInt('AI_KICKSTART_MS', defaultConfig.kickstartMs),
  hybridEvery: must(readInt(env, 'AI_HYBRID_EVERY', defaultConfig.hybridEvery, { min: 0, max: 1000 })),
  localBaseUrl: process.env['AI_LOCAL_URL'] ?? defaultConfig.localBaseUrl,
  localModel,
  sessionsDir: join(pkgRoot, 'sessions'),
  feedback,
  notify,
}

// Consistency of lead and deadline: if the Brain answers right at the lead, the plan misses the
// send window and is discarded — warn when the margin drops below 500 ms
if (config.brainLeadMs - config.apiTimeoutMs < 500)
  console.warn(
    `[ai] ★ lead ${config.brainLeadMs}ms − Brain deadline ${config.apiTimeoutMs}ms < 500ms — ` +
      'late plans will be discarded (review AI_BRAIN_LEAD_MS / AI_API_TIMEOUT_MS)',
  )

const fiber = Effect.runFork(Effect.scoped(Effect.zipRight(startConductor(config), Effect.never)))

// Surface startup failure (port in use, cannot bind, defect during initialization) with exit code 1.
// Termination by interrupt (SIGINT/SIGTERM) is normal
void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
  if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
    console.error(`[ai] Conductor failed to start: ${Cause.pretty(exit.cause).split('\n')[0]}`)
    process.exitCode = 1
  }
})

// SIGINT/SIGTERM → interrupt the fiber → Scope release (silence → socket close)
;(['SIGINT', 'SIGTERM'] as const).forEach((sig) =>
  process.once(sig, () => {
    void Effect.runPromise(Fiber.interrupt(fiber)).finally(() => {
      if (brain.blind) {
        // The answer is sealed: appended to a file, never printed to the terminal.
        // pairKey is stamped — the identifier pickBlind uses to count only lines of the same pair
        appendFileSync(
          blindLogPath,
          `${new Date().toISOString()} ${brain.mode} ${pairKey(parseBlindPair(process.env['AI_BLIND_PAIR']))}\n`,
        )
        console.log(
          '[ai] blind finished — the answer was appended to sessions/blind-log.txt (do not open until scoring is done)',
        )
      }
      process.exit(0)
    })
  }),
)
