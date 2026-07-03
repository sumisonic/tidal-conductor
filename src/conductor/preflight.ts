import { createSocket, type Socket } from 'node:dgram'
import { Duration, Effect } from 'effect'
import { decode, encode, numberAt, oscF, oscS, type OscMessage } from '../osc.js'

// preflight — one-command pre-launch check: pnpm preflight [--require-clock]
//
// Checks:
// 1. The listen port (default 127.0.0.1:6011) can be bound (= no Conductor running, port free)
// 2. /ai/ping to the SC snippet (sclang :57120) → /ai/pong comes back on the listen port.
//    Since the pong carries string + float it doubles as a check that the OSC type tags (s/f)
//    get through, and its 3rd argument reports whether the deadman watchdog is running
// 3. Reachability of Tidal :6010 — send /ctrl over a connected UDP socket and watch for ICMP refusal
//    (note: being UDP, "no refusal = probably listening" is only an inference)
// 4. Clock — whether /ai/ctx/cycle arrives within a time limit (informational: plain Tidal only produces a clock while something plays)
//
// Design: each check is a staged async sequence. Completion is guaranteed once via finishOnce — at the
// moment it is called all timers are cleared and listeners removed, so later message/error events never call resume twice.

export interface CheckResult {
  readonly name: string
  readonly ok: boolean
  /** ok, but nothing could be verified (shown as "!"): the clock check when Tidal is silent */
  readonly warn?: boolean
  readonly note: string
}

export interface Endpoint {
  readonly host: string
  readonly port: number
}

const envInt = (name: string, fallback: number): number => {
  const v = process.env[name]
  return v === undefined ? fallback : Number.parseInt(v, 10)
}

const TIDAL: Endpoint = { host: process.env['AI_TIDAL_HOST'] ?? '127.0.0.1', port: envInt('AI_TIDAL_PORT', 6010) }
const SCLANG: Endpoint = { host: process.env['AI_SCLANG_HOST'] ?? '127.0.0.1', port: envInt('AI_SCLANG_PORT', 57120) }
const LISTEN: Endpoint = { host: process.env['AI_LISTEN_HOST'] ?? '127.0.0.1', port: envInt('AI_LISTEN_PORT', 6011) }

/** Decode buf into an OSC message. null if malformed (an unrelated packet during a check must not crash it) */
const tryDecode = (buf: Buffer): OscMessage | null => {
  try {
    return decode(buf)
  } catch {
    return null
  }
}

interface Finisher<A> {
  /** Complete once with value (clear all timers → remove all listeners → close → resume) */
  readonly finish: (value: A) => void
  /** Arm a setTimeout that is reliably cleared on finish */
  readonly arm: (ms: number, onFire: () => void) => void
}

/**
 * Make a finisher that tears the socket down exactly once.
 * When finish is called: clear all armed timers → remove all listeners → socket close → resume.
 * Listeners and timers are disabled first, so a second message/error/timeout never reaches
 * the body of finish, and resume is called only once.
 */
const makeFinisher = <A>(sock: Socket, resume: (effect: Effect.Effect<A>) => void): Finisher<A> => {
  const timers = new Set<NodeJS.Timeout>()
  const finish = (value: A): void => {
    timers.forEach(clearTimeout)
    timers.clear()
    sock.removeAllListeners('message')
    sock.removeAllListeners('error')
    sock.close(() => resume(Effect.succeed(value)))
  }
  const arm = (ms: number, onFire: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t)
      onFire()
    }, ms)
    timers.add(t)
  }
  return { finish, arm }
}

/** Temporarily bind the listen port and check ping → pong against SC */
export const checkScRoundtrip = (
  sc: Endpoint = SCLANG,
  listen: Endpoint = LISTEN,
): Effect.Effect<ReadonlyArray<CheckResult>> =>
  Effect.async<ReadonlyArray<CheckResult>>((resume) => {
    const sock = createSocket({ type: 'udp4' })
    const { finish, arm } = makeFinisher<ReadonlyArray<CheckResult>>(sock, resume)
    const listenName = `listen ${listen.host}:${listen.port}`

    const bound: CheckResult = { name: listenName, ok: true, note: 'free' }

    // ping → pong (2 s)
    arm(2000, () =>
      finish([
        bound,
        {
          name: 'SC ping/pong',
          ok: false,
          note: 'no /ai/pong within 2 s — check that SC is running and conductor.scd is loaded',
        },
      ]),
    )
    const onPong = (buf: Buffer): void => {
      const msg = tryDecode(buf)
      if (msg?.address !== '/ai/pong') return
      const hasS = msg.args.some((a) => a.type === 's')
      const hasF = msg.args.some((a) => a.type === 'f' || a.type === 'd')
      // The pong's 3rd argument (2nd number) is the running state of the deadman watchdog task
      const armed = numberAt(msg, 1)
      finish([
        bound,
        { name: 'SC ping/pong', ok: true, note: 'conductor.scd responded' },
        {
          name: 'OSC type tags (s/f)',
          ok: hasS && hasF,
          note: hasS && hasF ? 'both string and float decoded' : 'a type is missing',
        },
        {
          name: 'deadman watchdog',
          ok: armed === 1,
          note:
            armed === 1 ? 'SC-side watchdog running' : 'watchdog not running — check that conductor.scd is reloaded',
        },
      ])
    }

    sock.once('error', (err) => {
      finish([
        {
          name: listenName,
          ok: false,
          note: `${err.message} (check whether a Conductor is already running)`,
        },
      ])
    })
    sock.on('message', onPong)
    sock.bind({ address: listen.host, port: listen.port, exclusive: true }, () => {
      sock.send(encode({ address: '/ai/ping', args: [] }), sc.port, sc.host)
    })
  })

/**
 * Clock check: bind the listen port and wait for one /ai/ctx/cycle (from the SC snippet's /dirt/play
 * observation). A silent Tidal sends no clock and the Conductor's kickstart covers startup, so "not seen"
 * is a warning (ok, warn) by default; with requireClock (--require-clock) it is a failure. A message
 * that arrives with a non-finite cycle or cps <= 0 is always a failure: the clock source is broken
 */
export const checkClock = (
  listen: Endpoint = LISTEN,
  waitMs = 3000,
  requireClock = false,
): Effect.Effect<CheckResult> =>
  Effect.async<CheckResult>((resume) => {
    const sock = createSocket({ type: 'udp4' })
    const { finish, arm } = makeFinisher<CheckResult>(sock, resume)
    const name = 'clock (/ai/ctx/cycle)'
    sock.once('error', (err) => finish({ name, ok: false, note: err.message }))
    sock.on('message', (buf) => {
      const msg = tryDecode(buf)
      if (msg?.address !== '/ai/ctx/cycle') return
      const cycle = numberAt(msg, 0)
      const cps = numberAt(msg, 1)
      const valid = cycle !== null && Number.isFinite(cycle) && cps !== null && cps > 0
      finish(
        valid
          ? { name, ok: true, note: `seen: cycle ${cycle.toFixed(1)} cps ${cps.toFixed(3)}` }
          : {
              name,
              ok: false,
              note: `invalid clock message (cycle ${cycle ?? '?'} cps ${cps ?? '?'}) — check the clock source (conductor.scd)`,
            },
      )
    })
    sock.bind({ address: listen.host, port: listen.port, exclusive: true }, () => {
      arm(waitMs, () =>
        finish(
          requireClock
            ? { name, ok: false, note: `none within ${waitMs / 1000} s (required by --require-clock)` }
            : {
                name,
                ok: true,
                warn: true,
                note: `none within ${waitMs / 1000} s — unverified (fine if Tidal is silent: play something, or rely on the kickstart)`,
              },
        ),
      )
    })
  })

/** Send a harmless /ctrl to Tidal over a connected UDP socket and watch for ICMP refusal */
export const checkTidalPort = (tidal: Endpoint = TIDAL): Effect.Effect<CheckResult> =>
  Effect.async<CheckResult>((resume) => {
    const sock = createSocket({ type: 'udp4' })
    const { finish, arm } = makeFinisher<CheckResult>(sock, resume)
    const name = `Tidal ${tidal.host}:${tidal.port}`
    const probe = encode({ address: '/ctrl', args: [oscS('ai/preflight'), oscF(0)] })
    sock.once('error', (err: NodeJS.ErrnoException) =>
      finish({
        name,
        ok: false,
        note: err.code === 'ECONNREFUSED' ? 'port refused — check that Tidal (GHCi) is running' : err.message,
      }),
    )
    sock.connect(tidal.port, tidal.host, () => {
      sock.send(probe)
      // The refusal ICMP is usually observed on the 2nd probe. If the socket closes on error,
      // finish clears the armed timers, so no send to a closed socket happens.
      arm(300, () => sock.send(probe))
      arm(800, () =>
        finish({
          name,
          ok: true,
          note: 'no refusal (inferred, since UDP)',
        }),
      )
    })
  })

const report = (results: ReadonlyArray<CheckResult>): boolean => {
  results.forEach((r) => console.log(` ${r.ok ? (r.warn === true ? '!' : '✓') : '✗'} ${r.name} — ${r.note}`))
  return results.every((r) => r.ok)
}

// preflight [--require-clock]: with the flag, "no clock seen" fails instead of warning (for harnesses)
const requireClock = process.argv.includes('--require-clock')

const main = Effect.gen(function* () {
  yield* Effect.sync(() => console.log('[ai] preflight start'))
  const sc = yield* checkScRoundtrip()
  const clock = yield* checkClock(LISTEN, 3000, requireClock)
  const tidal = yield* checkTidalPort().pipe(
    Effect.timeoutTo({
      duration: Duration.seconds(3),
      onTimeout: () => ({ name: `Tidal ${TIDAL.host}:${TIDAL.port}`, ok: false, note: 'timeout' }),
      onSuccess: (r: CheckResult) => r,
    }),
  )
  const ok = report([...sc, clock, tidal])
  yield* Effect.sync(() => {
    console.log(
      ' - Verifying that the deadman actually fires is manual: kill -9 the Conductor → the AI goes silent in about 4 s',
    )
    console.log(ok ? '[ai] preflight OK' : '[ai] preflight FAILED')
    process.exitCode = ok ? 0 : 1
  })
})

// Run the checks only when this file is executed directly (not when imported from tests).
if (process.argv[1]?.endsWith('preflight.ts') || process.argv[1]?.endsWith('preflight.js')) {
  void Effect.runPromise(main)
}
