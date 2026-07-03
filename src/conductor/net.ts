import { createSocket, type Socket } from 'node:dgram'
import { Effect, type Scope } from 'effect'
import { encode, type OscMessage } from '../osc.js'

// UDP socket acquisition/release and OSC sending (IO layer).

/**
 * Bind host:port exclusively. Default is 127.0.0.1 (no injection from the LAN is accepted).
 * EADDRINUSE becomes a clear "another Conductor is running" error
 */
export const acquireSocket = (host: string, port: number): Effect.Effect<Socket, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.async<Socket, Error>((resume) => {
      const sock = createSocket({ type: 'udp4' })
      sock.once('error', (err: NodeJS.ErrnoException) =>
        resume(
          Effect.fail(
            err.code === 'EADDRINUSE'
              ? new Error(`${host}:${port} is in use — check whether another Conductor is already running`)
              : new Error(err.message),
          ),
        ),
      )
      sock.bind({ address: host, port, exclusive: true }, () => {
        sock.removeAllListeners('error')
        sock.on('error', (e) => console.error(`[ai] socket error: ${e.message}`))
        resume(Effect.succeed(sock))
      })
    }),
    (sock) =>
      Effect.async<void>((resume) => {
        sock.close(() => resume(Effect.void))
      }),
  )

export const sendOsc = (sock: Socket, host: string, port: number, msg: OscMessage): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    sock.send(encode(msg), port, host, () => resume(Effect.void))
  })
