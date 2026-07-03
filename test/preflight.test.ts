import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { checkClock, checkScRoundtrip, checkTidalPort } from '../src/conductor/preflight.js'
import { decode, encode, oscF, oscI, oscS, type OscMessage } from '../src/osc.js'

// Integration tests for preflight.
// Stand up a fake SC / fake Tidal on real UDP and verify that the staged async checks
// "finish exactly once and are robust to duplicates and reordering".
// Passing listen port 0 makes the OS assign an ephemeral port, so the fake SC just
// replies to the ping's source (rinfo) and the reply reaches preflight.

const bindEphemeral = (): Promise<{ sock: Socket; port: number }> =>
  new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4' })
    sock.bind({ port: 0 }, () => resolve({ sock, port: sock.address().port }))
  })

/**
 * Start a fake SC. onPing controls the reply to /ai/ping.
 * Pass a callback returning the array of OscMessages to send back (empty = no reply).
 */
const startFakeSc = async (handlers: {
  onPing: () => ReadonlyArray<OscMessage>
}): Promise<{ port: number; pingCount: () => number; close: () => void }> => {
  const { sock, port } = await bindEphemeral()
  const counts = { ping: 0 }
  sock.on('message', (buf: Buffer, rinfo: RemoteInfo) => {
    const msg = decode(buf)
    const reply = (m: OscMessage): void => {
      sock.send(encode(m), rinfo.port, rinfo.address)
    }
    if (msg.address === '/ai/ping') {
      counts.ping += 1
      handlers.onPing().forEach(reply)
    }
  })
  return {
    port,
    pingCount: () => counts.ping,
    close: () => sock.close(),
  }
}

// Same shape as the production conductor.scd: /ai/pong "ok" 1.0 armed
// (string + 2 numbers. numberAt(msg, 1) = 2nd number = armed)
const pong = (armed: number): OscMessage => ({
  address: '/ai/pong',
  args: [oscS('ok'), oscF(1.0), oscI(armed)],
})

const run = <A>(e: Effect.Effect<A>): Promise<A> => Effect.runPromise(e)

const byName = (results: ReadonlyArray<{ name: string; ok: boolean }>, name: string) =>
  results.find((r) => r.name === name)

const EPHEMERAL = { host: '127.0.0.1', port: 0 }

describe('preflight checkScRoundtrip', () => {
  it('happy path: pong(armed) makes every check ok', async () => {
    const sc = await startFakeSc({ onPing: () => [pong(1)] })
    const results = await run(checkScRoundtrip({ host: '127.0.0.1', port: sc.port }, EPHEMERAL))
    sc.close()

    expect(byName(results, 'SC ping/pong')?.ok).toBe(true)
    expect(byName(results, 'OSC type tags (s/f)')?.ok).toBe(true)
    expect(byName(results, 'deadman watchdog')?.ok).toBe(true)
    expect(sc.pingCount()).toBe(1)
  })

  it('deadman not running: armed=0 makes only the watchdog check ok:false', async () => {
    const sc = await startFakeSc({ onPing: () => [pong(0)] })
    const results = await run(checkScRoundtrip({ host: '127.0.0.1', port: sc.port }, EPHEMERAL))
    sc.close()

    expect(byName(results, 'SC ping/pong')?.ok).toBe(true)
    expect(byName(results, 'deadman watchdog')?.ok).toBe(false)
  })

  it('pong timeout: ping/pong is ok:false when SC does not respond', async () => {
    const sc = await startFakeSc({ onPing: () => [] })
    const results = await run(checkScRoundtrip({ host: '127.0.0.1', port: sc.port }, EPHEMERAL))
    sc.close()

    expect(byName(results, 'SC ping/pong')?.ok).toBe(false)
  }, 4000)

  it('duplicate pong and unrelated OSC: two pongs in a row yield one result set, an earlier unrelated OSC is ignored', async () => {
    const sc = await startFakeSc({
      onPing: () => [{ address: '/ai/ctx/cycle', args: [oscF(0), oscF(1)] }, pong(1), pong(1)],
    })
    const results = await run(checkScRoundtrip({ host: '127.0.0.1', port: sc.port }, EPHEMERAL))
    sc.close()

    expect(results.filter((r) => r.name === 'SC ping/pong')).toHaveLength(1)
    expect(byName(results, 'SC ping/pong')?.ok).toBe(true)
  })
})

describe('preflight checkTidalPort', () => {
  it('happy path: with a listener present there is no refusal and ok:true', async () => {
    const fakeTidal = await bindEphemeral()
    const seen: OscMessage[] = []
    fakeTidal.sock.on('message', (buf) => seen.push(decode(buf)))

    const r = await run(checkTidalPort({ host: '127.0.0.1', port: fakeTidal.port }))
    fakeTidal.sock.close()

    expect(r.name).toBe(`Tidal 127.0.0.1:${fakeTidal.port}`)
    expect(r.ok).toBe(true)
    // The probe arrives at least once (the 2nd one comes 300 ms later)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]?.address).toBe('/ctrl')
  }, 3000)
})

describe('preflight checkClock', () => {
  it('reports the first /ai/ctx/cycle it sees', async () => {
    const probe = await bindEphemeral()
    const port = probe.port
    await new Promise<void>((r) => probe.sock.close(() => r()))
    const pending = Effect.runPromise(checkClock({ host: '127.0.0.1', port }, 3000))
    await new Promise((r) => setTimeout(r, 100))
    const sender = await bindEphemeral()
    sender.sock.send(encode({ address: '/ai/ctx/cycle', args: [oscF(12.5), oscF(0.5)] }), port, '127.0.0.1')
    const r = await pending
    sender.sock.close()
    expect(r.ok).toBe(true)
    expect(r.note).toContain('cycle 12.5')
  }, 8000)

  it('warns (ok, unverified) when nothing arrives', async () => {
    const r = await Effect.runPromise(checkClock({ host: '127.0.0.1', port: 0 }, 200))
    expect(r.ok).toBe(true)
    expect(r.warn).toBe(true)
    expect(r.note).toContain('none within')
  })

  it('fails when nothing arrives and the clock is required', async () => {
    const r = await Effect.runPromise(checkClock({ host: '127.0.0.1', port: 0 }, 200, true))
    expect(r.ok).toBe(false)
    expect(r.warn).toBeUndefined()
  })

  it('fails on a clock message with cps 0 (broken clock source)', async () => {
    const probe = await bindEphemeral()
    const port = probe.port
    await new Promise<void>((r) => probe.sock.close(() => r()))
    const pending = Effect.runPromise(checkClock({ host: '127.0.0.1', port }, 3000))
    await new Promise((r) => setTimeout(r, 100))
    const sender = await bindEphemeral()
    sender.sock.send(encode({ address: '/ai/ctx/cycle', args: [oscF(12.5), oscF(0)] }), port, '127.0.0.1')
    const r = await pending
    sender.sock.close()
    expect(r.ok).toBe(false)
    expect(r.note).toContain('invalid clock message')
  }, 8000)
})
