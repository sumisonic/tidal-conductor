import type { Socket } from 'node:dgram'
import { Duration, Effect, Either, Ref, Runtime, Schedule, type Scope } from 'effect'
import { decode, oscF, oscI, oscS, type OscArg } from '../osc.js'
import { aiKey, densityKey, DEFAULT_CHANNEL, SLOTS, type Channel } from './channel.js'
import { describeEvent, toEvent } from './events.js'
import { initialState, isKilled, reduce, type ConductorState } from './state.js'
import { acquireSocket, sendOsc } from './net.js'
import { walkStep } from './walk.js'
import { manifestLabel, type Manifest } from './manifest.js'
import type { FeedbackMap } from './vetoMemory.js'
import { isClockReset, pllEstimate, pllInit, pllLabel, pllResync, pllUsable, type Pll } from './pll.js'
import {
  kickstart,
  onClockReset,
  onPlanReady,
  planTick,
  schedDefaults,
  schedInit,
  type SchedAction,
  type SchedState,
  kickstartDue,
  kickstartExhausted,
  kickstartInit,
  kickstartSettle,
  KICKSTART_MAX_ATTEMPTS,
  type KickstartOutcome,
} from './scheduler.js'
import { makeBrain, type WrappedBrain } from './brain/index.js'
import type { ApiProvider } from './brain/api.js'
import type { BrainMode } from './brain/types.js'
import { historyLabel, phraseRecord, pushPhrase, stampFeedback, type PhraseRecord } from './history.js'
import { makeSessionLogger, nullLogger, type SessionLogger } from './sessionLog.js'

// Conductor — execution layer.
// - Receives the clock (/ai/ctx/cycle), knobs (/ai/knob) and the optional control mirror (/ai/ctrl) on the listen port
// - Sends a single stochastic density walk to /ctrl on a plain timer
// - Sending is structurally restricted to a whitelist (/ctrl + "ai/<channel>/" keys only)
// - Re-arms reservations on a clock rewind (resetCycles)
// - On shutdown (interrupt/SIGINT) silences the channel before closing

export interface NotifyTarget {
  readonly host: string
  readonly port: number
}

export interface ConductorConfig {
  readonly tidalHost: string
  readonly tidalPort: number
  /** Listen bind address. Default 127.0.0.1 (receiving from the LAN is an explicit opt-in) */
  readonly listenHost: string
  readonly listenPort: number
  readonly sclangHost: string
  readonly sclangPort: number
  /** Namespace of the state keys on the Tidal side `ai/<channel>/…`. Default 1 */
  readonly channel: Channel
  /** The manifest fixed at startup. null = no plan generation (density walk only) */
  readonly manifest: Manifest | null
  readonly walkIntervalMs: number
  readonly statusIntervalMs: number
  readonly heartbeatIntervalMs: number
  readonly walkStep: number
  /** Brain mode. Default pool */
  readonly brainMode: BrainMode
  readonly tickMs: number
  readonly poolPaths: ReadonlyArray<string>
  /** api Brain: LLM provider and model (null = provider default) */
  readonly apiProvider: ApiProvider
  readonly apiModel: string | null
  /** Deadline for the real-time Brains (api/local). Default 4500 = lead 5000 − send-ahead 375 − margin 125 */
  readonly apiTimeoutMs: number
  /** Brain request lead (how many ms before the boundary the scheduler asks by. AI_BRAIN_LEAD_MS) */
  readonly brainLeadMs: number
  /** Send-ahead for plans (how many ms before the boundary /ctrl is sent. Match Tidal's cProcessAhead) */
  readonly sendAheadMs: number
  /** hybrid mode: every how many phrases the api Brain takes a turn */
  readonly hybridEvery: number
  /** local Brain (experimental): Ollama's OpenAI-compatible endpoint and model (model name is required) */
  readonly localBaseUrl: string
  readonly localModel: string
  /** Output directory of the session log (null = do not record) */
  readonly sessionsDir: string | null
  /** Persistent feedback context: veto / mark per manifest (already summarized). Injected into the api/local system prompt */
  readonly feedback: FeedbackMap
  /** For blind A/B: hide the Brain name in logs/status as "?" */
  readonly maskBrain: boolean
  /** Notification target for Brain degradation/recovery (/ai/status). null = do not send (default) */
  readonly notify: NotifyTarget | null
  /**
   * Kickstart: if no clock has been observed this many ms after startup, send the first plan
   * unquantized so the AI slots start producing events (and hence a clock). 0 disables
   */
  readonly kickstartMs: number
}

export const defaultConfig: ConductorConfig = {
  tidalHost: '127.0.0.1',
  tidalPort: 6010,
  listenHost: '127.0.0.1',
  listenPort: 6011,
  sclangHost: '127.0.0.1',
  sclangPort: 57120,
  channel: DEFAULT_CHANNEL,
  manifest: null,
  walkIntervalMs: 2000,
  statusIntervalMs: 5000,
  heartbeatIntervalMs: 1000,
  walkStep: 0.12,
  brainMode: 'pool',
  tickMs: 100,
  poolPaths: ['plans/pool.json'],
  apiProvider: 'google',
  apiModel: null,
  apiTimeoutMs: 4500,
  brainLeadMs: 5000,
  sendAheadMs: 375,
  hybridEvery: 4,
  localBaseUrl: 'http://127.0.0.1:11434/v1',
  localModel: '',
  sessionsDir: null,
  feedback: {},
  maskBrain: false,
  notify: null,
  kickstartMs: 3000,
}

/** Estimate of the human performer's activity (auxiliary signal): /ai/ctrl event count over the last 8 s normalized to 0..1 */
const activityLevel = (stamps: ReadonlyArray<number>, nowMs: number): number =>
  Math.min(1, stamps.filter((t) => nowMs - t < 8000).length / 10)

type SendCtrl = (key: string, value: OscArg) => Effect.Effect<void>

/** Send whitelist: /ctrl + keys in this channel's own "ai/<channel>/" namespace only. Anything else is not sent and warned about */
const makeSendCtrl =
  (sock: Socket, config: ConductorConfig): SendCtrl =>
  (key, value) =>
    key.startsWith(`ai/${config.channel}/`)
      ? sendOsc(sock, config.tidalHost, config.tidalPort, {
          address: '/ctrl',
          args: [oscS(key), value],
        })
      : Effect.sync(() => console.warn(`[ai] send refused (whitelist violation): ${key}`))

/** Silence all AI state of the channel: "~" to slots 1..8, 0 to density */
const silenceChannel = (send: SendCtrl, channel: Channel): Effect.Effect<void> =>
  Effect.zipRight(
    Effect.forEach(SLOTS, (n) => send(aiKey(channel, n), oscS('~')), {
      discard: true,
    }),
    send(densityKey(channel), oscF(0)),
  )

const handleDatagram = (
  ref: Ref.Ref<ConductorState>,
  pllRef: Ref.Ref<Pll>,
  schedRef: Ref.Ref<SchedState>,
  activityRef: Ref.Ref<ReadonlyArray<number>>,
  historyRef: Ref.Ref<ReadonlyArray<PhraseRecord>>,
  logger: SessionLogger,
  send: SendCtrl,
  config: ConductorConfig,
  buf: Buffer,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const decoded = Either.try(() => decode(buf))
    if (Either.isLeft(decoded)) {
      yield* Effect.sync(() => console.warn(`[ai] undecodable datagram: ${decoded.left}`))
      return
    }
    const msg = decoded.right
    if (msg.address === '/ai/pong') return // preflight reply
    const event = toEvent(msg)
    if (event === null) {
      yield* Effect.sync(() => console.warn(`[ai] unknown message: ${msg.address}`))
      return
    }
    if (event._tag === 'Cycle') {
      // Each datagram is handled on its own fiber, so rewind detection and resync are done atomically via Ref.modify
      // (even if two Cycle events run concurrently, an older observation never overwrites a newer one afterwards)
      const nowMs = Date.now()
      const reset = yield* Ref.modify(pllRef, (pll) => {
        const isReset = isClockReset(pll, event.cycle, nowMs)
        // An out-of-order observation (slightly behind the estimate) does not resync — keep the latest extrapolation
        const outOfOrder = pll.synced && !isReset && event.cycle < pllEstimate(pll, nowMs) - 0.25
        return [isReset, outOfOrder ? pll : pllResync(pll, event.cycle, event.cps, nowMs)] as const
      })
      // Clock rewind (resetCycles) = new epoch: drop reservations and in-flight requests
      if (reset) {
        yield* Ref.update(schedRef, onClockReset)
        yield* Effect.sync(() =>
          console.log(`[ai] clock rewind detected (→ cycle ${event.cycle.toFixed(1)}) — re-arming reservations`),
        )
      }
    }
    if (event._tag === 'Ctrl') {
      // Timestamp for activity estimation (auxiliary signal for the initiative policy)
      yield* Ref.update(activityRef, (stamps) => [...stamps, Date.now()].slice(-30))
    }
    if (event._tag === 'Knob') {
      // Rehearsal mode: feedback goes to the session log
      yield* Effect.sync(() => logger.log({ type: 'event', event }))
    }
    if (event._tag === 'Knob' && event.name === 'mark' && event.value >= 0.5) {
      // "Good moment" marker: burn the current plan into the log + stamp it into history as a positive example
      const sched = yield* Ref.get(schedRef)
      const st = yield* Ref.get(ref)
      yield* Ref.update(historyRef, (h) => stampFeedback(h, 'mark'))
      yield* Effect.sync(() => {
        console.log('[ai] ★ MARK — current plan recorded')
        logger.log({
          type: 'mark',
          manifest: config.manifest?.id ?? null,
          desire: st.knobDensity,
          plan: sched.current,
        })
      })
    }
    if (event._tag === 'Knob' && event.name === 'veto' && event.value >= 0.5) {
      // Negative feedback (sound continues — the counterpart of mark. Nudges toward a different vocabulary from the next phrase)
      yield* Ref.update(historyRef, (h) => stampFeedback(h, 'veto'))
      yield* Effect.sync(() =>
        console.log('[ai] ✕ VETO — last phrase recorded as a negative example (sound continues)'),
      )
    }
    if (event._tag === 'Knob' && event.name === 'freeze' && event.value >= 0.5)
      // Stamp into history as a hold request (plan progression stops during freeze, so the most recent phrase is the right target)
      yield* Ref.update(historyRef, (h) => stampFeedback(h, 'freeze'))
    const commands = yield* Ref.modify(ref, (st) => {
      const [next, cmds] = reduce(st, event)
      return [cmds, next] as const
    })
    if (event._tag !== 'Cycle') {
      yield* Effect.sync(() => console.log(`[ai] ← ${describeEvent(event)}`))
    }
    yield* Effect.forEach(
      commands,
      (cmd) =>
        Effect.zipRight(
          Effect.zipRight(
            // The kill switch means "the shape that was stopped right away" = stamp into history as a negative example
            cmd.reason === 'kill' ? Ref.update(historyRef, (h) => stampFeedback(h, 'kill')) : Effect.void,
            Effect.sync(() => console.log(`[ai] → forced mute ch${config.channel} (kill switch: density knob 0)`)),
          ),
          silenceChannel(send, config.channel),
        ),
      { discard: true },
    )
  })

const walkLoop = (ref: Ref.Ref<ConductorState>, send: SendCtrl, config: ConductorConfig): Effect.Effect<never> =>
  Effect.repeat(
    Effect.gen(function* () {
      const st = yield* Ref.get(ref)
      // Reflex layer: locked during freeze (hold as-is, send nothing),
      // stay silent while the kill switch (density knob 0) is engaged
      if (st.frozen || isKilled(st)) return
      const desire = st.knobDensity ?? 0.5
      // Yielding margin (halved right after freeze release)
      const center = st.easeTicksLeft > 0 ? desire * 0.5 : desire
      // Freedom knob = "how obedient". Governs both the step size and the speed of tracking:
      // freedom 0 = obedient (small steps, snaps quickly to the desire — effectively a fader)
      // freedom 1 = provocative (large strides, drifts toward the desire only slowly)
      const step = config.walkStep * (0.2 + 1.6 * st.freedom)
      const pull = 0.45 - 0.35 * st.freedom
      const next = yield* walkStep(step, pull)(st.density, center)
      yield* Ref.update(ref, (s) => ({
        ...s,
        density: next,
        easeTicksLeft: Math.max(0, s.easeTicksLeft - 1),
      }))
      yield* send(densityKey(config.channel), oscF(next))
    }),
    Schedule.spaced(Duration.millis(config.walkIntervalMs)),
  ).pipe(Effect.zipRight(Effect.never))

/** Heartbeat of the deadman mechanism: the SC snippet silences this channel after 3 s without one */
const heartbeatLoop = (sock: Socket, config: ConductorConfig): Effect.Effect<never> =>
  Effect.repeat(
    sendOsc(sock, config.sclangHost, config.sclangPort, {
      address: '/ai/heartbeat',
      args: [oscI(config.channel)],
    }),
    Schedule.spaced(Duration.millis(config.heartbeatIntervalMs)),
  ).pipe(Effect.zipRight(Effect.never))

const statusLine = (
  st: ConductorState,
  pll: Pll,
  sched: SchedState,
  brainLabel: string,
  history: ReadonlyArray<PhraseRecord>,
  config: ConductorConfig,
  nowMs: number,
): string =>
  `[ai] ch=${config.channel} density=${st.density.toFixed(2)}` +
  ` desire=${isKilled(st) ? 'KILL' : (st.knobDensity?.toFixed(2) ?? '-')}` +
  ` free=${st.freedom.toFixed(2)}` +
  `${st.frozen ? ' FREEZE' : ''}${st.easeTicksLeft > 0 ? ` ease=${st.easeTicksLeft}` : ''}` +
  ` brain=${brainLabel}` +
  ` hist=${historyLabel(history)}` +
  ` pll=${pllLabel(pll, nowMs)}` +
  ` plan=${sched.current === null ? '-' : `L${sched.current.lengthCycles}${sched.pending === null ? '' : `→@${sched.pending.targetCycle}`}`}` +
  ` manifest=${config.manifest === null ? '-' : manifestLabel(config.manifest)}` +
  ` cycle=${st.cycle?.toFixed(1) ?? '-'} cps=${st.cps?.toFixed(3) ?? '-'}` +
  ` last=${st.lastInput ?? '-'}`

const statusLoop = (
  ref: Ref.Ref<ConductorState>,
  pllRef: Ref.Ref<Pll>,
  schedRef: Ref.Ref<SchedState>,
  brainModeRef: Ref.Ref<string>,
  historyRef: Ref.Ref<ReadonlyArray<PhraseRecord>>,
  config: ConductorConfig,
): Effect.Effect<never> =>
  Effect.repeat(
    Effect.gen(function* () {
      const st = yield* Ref.get(ref)
      const pll = yield* Ref.get(pllRef)
      const sched = yield* Ref.get(schedRef)
      const brainLabel = yield* Ref.get(brainModeRef)
      const history = yield* Ref.get(historyRef)
      yield* Effect.sync(() => console.log(statusLine(st, pll, sched, brainLabel, history, config, Date.now())))
    }),
    Schedule.spaced(Duration.millis(config.statusIntervalMs)),
  ).pipe(Effect.zipRight(Effect.never))

/** Application scheduler loop: run planTick (pure) and execute the Actions. Also owns the kickstart */
const schedLoop = (
  stateRef: Ref.Ref<ConductorState>,
  pllRef: Ref.Ref<Pll>,
  schedRef: Ref.Ref<SchedState>,
  brainModeRef: Ref.Ref<string>,
  degradedRef: Ref.Ref<boolean>,
  activityRef: Ref.Ref<ReadonlyArray<number>>,
  historyRef: Ref.Ref<ReadonlyArray<PhraseRecord>>,
  stoppingRef: Ref.Ref<boolean>,
  logger: SessionLogger,
  brain: WrappedBrain,
  manifest: Manifest,
  send: SendCtrl,
  notify: (msg: string) => Effect.Effect<void>,
  config: ConductorConfig,
): Effect.Effect<never> => {
  const schedCfg = { ...schedDefaults, brainDeadlineMs: config.brainLeadMs, sendAheadMs: config.sendAheadMs }
  const startedMs = Date.now()

  /** Log / SendPatterns / PlanApplied (RequestPlan is handled by the tick, see below) */
  const runSimpleActions = (actions: ReadonlyArray<SchedAction>, cond: ConductorState): Effect.Effect<void> =>
    Effect.forEach(
      actions,
      (action) => {
        if (action._tag === 'Log') return Effect.sync(() => console.log(`[ai] ${action.msg}`))
        if (action._tag === 'SendPatterns')
          return Effect.forEach(action.sends, (s) => send(s.key, oscS(s.value)), { discard: true })
        if (action._tag === 'PlanApplied')
          return Effect.gen(function* () {
            // In-context adaptation: push the applied phrase into the history ring buffer
            const usedMode = yield* Ref.get(brainModeRef)
            yield* Ref.update(historyRef, (h) =>
              pushPhrase(
                h,
                phraseRecord({
                  atCycle: action.targetCycle,
                  desire: cond.knobDensity,
                  usedMode,
                  plan: action.plan,
                }),
              ),
            )
            yield* Effect.sync(() =>
              logger.log({
                type: 'plan',
                manifest: manifest.id,
                desire: cond.knobDensity,
                targetCycle: action.targetCycle,
                plan: action.plan,
              }),
            )
          })
        return Effect.void
      },
      { discard: true },
    )

  /** Brain display and degradation/recovery notification, only for adopted results */
  const afterAdopted = (result: { readonly intended: string; readonly usedMode: string }): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Ref.set(brainModeRef, config.maskBrain ? '?' : result.usedMode)
      // Only notify when "the difference between the intended Brain and the actual one (usedMode)" changes —
      // hybrid's normal pool/api alternation does not fire it. Not sent while blind, since it would leak the answer
      const degraded = result.usedMode !== result.intended
      const prevDegraded = yield* Ref.getAndSet(degradedRef, degraded)
      if (!config.maskBrain && degraded !== prevDegraded)
        yield* notify(degraded ? `DEGRADED ${result.intended}->${result.usedMode}` : `OK ${result.usedMode}`)
    })

  const askBrain = (lengthCycles: 1 | 2 | 4 | 8) =>
    Effect.gen(function* () {
      const cond2 = yield* Ref.get(stateRef)
      const sched2 = yield* Ref.get(schedRef)
      const stamps = yield* Ref.get(activityRef)
      const history = yield* Ref.get(historyRef)
      return yield* brain.nextPlan({
        manifest,
        desire: cond2.knobDensity ?? 0.5,
        freedom: cond2.freedom,
        lengthCycles,
        lastPlan: sched2.current,
        allowTransition: manifest.allowTransition ?? true,
        activity: activityLevel(stamps, Date.now()),
        history,
      })
    })

  /** Always surface failures, defects included (if the fork dies silently, application stops) */
  const daemon = (label: string, work: Effect.Effect<void, Error>) =>
    Effect.forkDaemon(
      work.pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => console.warn(`[ai] ★ ${label} failure (please report): ${cause.toString()}`)),
        ),
      ),
    )

  const ksRef = Ref.unsafeMake(kickstartInit(startedMs, config.kickstartMs))

  /**
   * One kickstart attempt (detached): ask the Brain, then re-read everything that may have changed while
   * it was thinking — a clock (the quantized path takes over), a kill or freeze (the plan must not be
   * written: kill has just silenced the channel), or shutdown (the silence must be the last write)
   */
  const runKickstart = Effect.gen(function* () {
    const result = yield* askBrain(manifest.defaultLengthCycles)
    const nowMs = Date.now()
    const pllNow = yield* Ref.get(pllRef)
    const condNow = yield* Ref.get(stateRef)
    const stopping = yield* Ref.get(stoppingRef)
    const outcome: KickstartOutcome =
      stopping || isKilled(condNow) || condNow.frozen ? 'aborted' : pllUsable(pllNow) ? 'clockArrived' : 'sent'
    yield* Ref.update(ksRef, (ks) => kickstartSettle(ks, outcome, nowMs, config.kickstartMs))
    if (outcome === 'clockArrived') {
      yield* Effect.sync(() => console.log('[ai] kickstart skipped — the clock arrived in the meantime'))
      return
    }
    if (outcome === 'aborted') {
      if (!stopping)
        yield* Effect.sync(() =>
          console.log(
            `[ai] kickstart aborted — ${isKilled(condNow) ? 'kill switch' : 'freeze'} engaged while the Brain was thinking (retried when released)`,
          ),
        )
      return
    }
    const actions = yield* Ref.modify(schedRef, (s) => {
      const [next, acts] = kickstart(s, config.channel, result.plan, manifest)
      return [acts, next] as const
    })
    yield* afterAdopted(result)
    yield* runSimpleActions(actions, condNow)
  })

  return Effect.repeat(
    Effect.gen(function* () {
      const nowMs = Date.now()
      const pll = yield* Ref.get(pllRef)
      const cond = yield* Ref.get(stateRef)

      // Kickstart: still no clock config.kickstartMs after startup (or after the previous attempt) →
      // a plan now, unquantized. Up to KICKSTART_MAX_ATTEMPTS, then a loud hint
      const ks = yield* Ref.get(ksRef)
      if (kickstartDue(ks, pll, cond, nowMs, config.kickstartMs)) {
        yield* Ref.set(ksRef, { ...ks, phase: 'inFlight' as const })
        yield* daemon('kickstart', runKickstart)
      } else if (kickstartExhausted(ks, pll, nowMs)) {
        yield* Ref.set(ksRef, { ...ks, phase: 'done' as const })
        yield* Effect.sync(() =>
          console.warn(
            `[ai] ★ still no clock after ${KICKSTART_MAX_ATTEMPTS} kickstarts — read a slot in a pattern (e.g. d1 $ struct (aiPat 1) $ s "lt"), play something, or check that conductor.scd is loaded and AI_SCLANG_PORT matches sclang`,
          ),
        )
      }

      const actions = yield* Ref.modify(schedRef, (sched) => {
        const [next, acts] = planTick(sched, pll, cond, manifest, nowMs, schedCfg)
        return [acts, next] as const
      })
      yield* runSimpleActions(actions, cond)
      yield* Effect.forEach(
        actions.flatMap((a) => (a._tag === 'RequestPlan' ? [a] : [])),
        (action) =>
          // RequestPlan: the Brain can take seconds, so run it detached as a daemon
          daemon(
            'Brain',
            Effect.gen(function* () {
              const result = yield* askBrain(action.lengthCycles)
              // Acceptance check (generation, deadline) comes first; state, notification and log are updated only when adopted
              // (a stale result must not pollute the Brain display or the degradation notification)
              const pll2 = yield* Ref.get(pllRef)
              const accepted = yield* Ref.modify(schedRef, (s) => {
                const next = onPlanReady(
                  s,
                  config.channel,
                  action.generation,
                  action.targetCycle,
                  result.plan,
                  pll2,
                  Date.now(),
                  schedCfg,
                  manifest,
                )
                return [next !== s, next] as const
              })
              if (!accepted) {
                yield* Effect.sync(() =>
                  console.log(`[ai] Brain result discarded (stale or past deadline) → @${action.targetCycle}`),
                )
                return
              }
              yield* afterAdopted(result)
              yield* Effect.sync(() =>
                console.log(
                  `[ai] Brain(${config.maskBrain ? '?' : result.usedMode}) plan received → @${action.targetCycle}`,
                ),
              )
            }),
          ),
        { discard: true },
      )
    }),
    Schedule.spaced(Duration.millis(config.tickMs)),
  ).pipe(Effect.zipRight(Effect.never))
}

/**
 * Start the Conductor (resident within the Scope). When the Scope is released,
 * the channel is silenced before the socket is closed.
 */
export const startConductor = (config: ConductorConfig): Effect.Effect<void, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const sock = yield* acquireSocket(config.listenHost, config.listenPort)
    const send = makeSendCtrl(sock, config)
    const ref = yield* Ref.make(initialState)
    const pllRef = yield* Ref.make(pllInit)
    const schedRef = yield* Ref.make(schedInit)
    const brainModeRef = yield* Ref.make<string>(config.maskBrain ? '?' : config.brainMode)
    const activityRef = yield* Ref.make<ReadonlyArray<number>>([])
    const historyRef = yield* Ref.make<ReadonlyArray<PhraseRecord>>([])
    const degradedRef = yield* Ref.make(false)
    const brain = yield* makeBrain(config.brainMode, {
      poolPaths: config.poolPaths,
      api: {
        provider: config.apiProvider,
        model: config.apiModel,
        timeoutMs: config.apiTimeoutMs,
        feedback: config.feedback,
      },
      local: {
        baseUrl: config.localBaseUrl,
        model: config.localModel,
        timeoutMs: config.apiTimeoutMs, // the deadline is shared by the real-time Brains
        feedback: config.feedback,
      },
      hybridEvery: config.hybridEvery,
      mask: config.maskBrain,
    })
    const logger = config.sessionsDir === null ? nullLogger : makeSessionLogger(config.sessionsDir)
    if (logger.path !== null) yield* Effect.sync(() => console.log(`[ai] session log: ${logger.path}`))

    // Silencing on release (SIGINT / interrupt) runs before the socket close
    yield* Effect.addFinalizer(() =>
      Effect.zipRight(
        Effect.sync(() => console.log(`[ai] shutdown — silencing ch${config.channel}`)),
        Effect.orDie(silenceChannel(send, config.channel)),
      ),
    )
    // Finalizers run in reverse order: this one runs first, so detached work (kickstart) that finishes
    // during shutdown does not write a plan after the silence
    const stoppingRef = yield* Ref.make(false)
    yield* Effect.addFinalizer(() => Ref.set(stoppingRef, true))

    const runtime = yield* Effect.runtime<never>()
    sock.on('message', (buf) =>
      Runtime.runFork(runtime)(
        handleDatagram(ref, pllRef, schedRef, activityRef, historyRef, logger, send, config, buf),
      ),
    )

    yield* Effect.forkScoped(walkLoop(ref, send, config))
    yield* Effect.forkScoped(statusLoop(ref, pllRef, schedRef, brainModeRef, historyRef, config))
    yield* Effect.forkScoped(heartbeatLoop(sock, config))
    const notify = (msg: string): Effect.Effect<void> =>
      config.notify === null
        ? Effect.void
        : sendOsc(sock, config.notify.host, config.notify.port, {
            address: '/ai/status',
            args: [oscS(msg)],
          })
    if (config.manifest !== null)
      yield* Effect.forkScoped(
        schedLoop(
          ref,
          pllRef,
          schedRef,
          brainModeRef,
          degradedRef,
          activityRef,
          historyRef,
          stoppingRef,
          logger,
          brain,
          config.manifest,
          send,
          notify,
          config,
        ),
      )
    yield* Effect.sync(() =>
      console.log(
        `[ai] Conductor started listen=${config.listenHost}:${config.listenPort} → Tidal ${config.tidalHost}:${config.tidalPort}` +
          ` ch=${config.channel} brain=${config.maskBrain ? '?(blind)' : config.brainMode}` +
          ` manifest=${config.manifest === null ? '(none — density walk only)' : manifestLabel(config.manifest)}`,
      ),
    )
  })
