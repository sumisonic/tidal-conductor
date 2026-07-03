import { createSocket, type Socket } from 'node:dgram'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Effect, Either, Fiber } from 'effect'
import { decode, encode, firstString, numberAt, oscF, oscS, type OscMessage } from '../src/osc.js'
import { defaultConfig, startConductor, type ConductorConfig } from '../src/conductor/conductor.js'
import { loadManifestFile } from '../src/conductor/manifest.js'

// Integration test: start the Conductor on real UDP sockets, stand up a
// fake Tidal (receiver) and a fake SC (sender), and verify every path.

const bindEphemeral = (): Promise<{ sock: Socket; port: number }> =>
  new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4' })
    sock.bind({ port: 0, address: '127.0.0.1' }, () => resolve({ sock, port: sock.address().port }))
  })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const testConfig = (over: Partial<ConductorConfig>): ConductorConfig => ({
  ...defaultConfig,
  statusIntervalMs: 60_000,
  brainMode: 'offline',
  tickMs: 25,
  apiTimeoutMs: 1000,
  localBaseUrl: 'http://127.0.0.1:1/v1',
  localModel: 'test',
  ...over,
})

describe('conductor integration (real UDP)', () => {
  const received: OscMessage[] = []
  const heartbeats: OscMessage[] = []
  const fixtures: {
    fakeTidal?: Socket
    fakeSclang?: Socket
    sender?: Socket
    conductorPort?: number
    fiber?: Fiber.RuntimeFiber<void, Error>
  } = {}

  const sendToConductor = (msg: OscMessage): void => {
    fixtures.sender!.send(encode(msg), fixtures.conductorPort!, '127.0.0.1')
  }

  beforeAll(async () => {
    const fakeTidal = await bindEphemeral()
    fakeTidal.sock.on('message', (buf) => received.push(decode(buf)))
    const fakeSclang = await bindEphemeral()
    fakeSclang.sock.on('message', (buf) => heartbeats.push(decode(buf)))
    // Grab one free port and use it as the Conductor's listen port
    const probe = await bindEphemeral()
    const conductorPort = probe.port
    await new Promise<void>((resolve) => probe.sock.close(() => resolve()))

    const config = testConfig({
      tidalPort: fakeTidal.port,
      listenPort: conductorPort,
      sclangPort: fakeSclang.port,
      channel: 2,
      manifest: null, // density walk only
      walkIntervalMs: 40,
      heartbeatIntervalMs: 50,
      walkStep: 0.2,
    })
    fixtures.fakeTidal = fakeTidal.sock
    fixtures.fakeSclang = fakeSclang.sock
    fixtures.sender = (await bindEphemeral()).sock
    fixtures.conductorPort = conductorPort
    fixtures.fiber = Effect.runFork(Effect.scoped(Effect.zipRight(startConductor(config), Effect.never)))
    await sleep(100)
  })

  afterAll(async () => {
    await Effect.runPromise(Fiber.interrupt(fixtures.fiber!))
    await new Promise<void>((r) => fixtures.fakeTidal!.close(() => r()))
    await new Promise<void>((r) => fixtures.fakeSclang!.close(() => r()))
    await new Promise<void>((r) => fixtures.sender!.close(() => r()))
  })

  it('every send is /ctrl + the own channel ai/2/ namespace (whitelist)', async () => {
    await sleep(150)
    expect(received.length).toBeGreaterThan(0)
    received.forEach((msg) => {
      expect(msg.address).toBe('/ctrl')
      expect(firstString(msg)).toMatch(/^ai\/2\//)
    })
  })

  it('the density walk is sent periodically to the density key', async () => {
    received.length = 0
    await sleep(200)
    const walks = received.filter((m) => firstString(m) === 'ai/2/density')
    expect(walks.length).toBeGreaterThan(1)
  })

  it('kill switch: density knob 0 sends "~" to all slots + density 0, and the walk stays silent afterwards', async () => {
    received.length = 0
    sendToConductor({
      address: '/ai/knob',
      args: [oscS('density'), oscF(0)],
    })
    await sleep(120)
    const keys = received.map((m) => firstString(m))
    ;[1, 2, 3, 4, 5, 6, 7, 8].forEach((n) => expect(keys).toContain(`ai/2/${n}`))
    const zeroReset = received.find((m) => firstString(m) === 'ai/2/density' && numberAt(m, 0) === 0)
    expect(zeroReset).toBeDefined()
    received.length = 0
    await sleep(200)
    // No density sends at all while killed
    const densitySends = received.filter((m) => firstString(m)?.endsWith('/density') ?? false)
    expect(densitySends).toEqual([])
  })

  it('releasing the kill switch resumes the walk toward the desire', async () => {
    sendToConductor({
      address: '/ai/knob',
      args: [oscS('density'), oscF(0.8)],
    })
    await sleep(300)
    const walks = received.filter((m) => firstString(m) === 'ai/2/density')
    expect(walks.length).toBeGreaterThan(1)
  })

  it('freeze locks the walk and release resumes it', async () => {
    sendToConductor({
      address: '/ai/knob',
      args: [oscS('freeze'), oscF(1)],
    })
    await sleep(120)
    received.length = 0
    await sleep(200)
    expect(received).toEqual([]) // nothing is sent while locked
    sendToConductor({
      address: '/ai/knob',
      args: [oscS('freeze'), oscF(0)],
    })
    await sleep(250)
    const walks = received.filter((m) => firstString(m) === 'ai/2/density')
    expect(walks.length).toBeGreaterThan(1)
  })

  it('the deadman heartbeat is sent periodically to SC with the channel number', async () => {
    heartbeats.length = 0
    await sleep(250)
    const beats = heartbeats.filter((m) => m.address === '/ai/heartbeat')
    expect(beats.length).toBeGreaterThanOrEqual(2)
    beats.forEach((b) => expect(numberAt(b, 0)).toBe(2))
  })

  it('legacy protocol messages (/ai/ctx/player etc.) are ignored and nothing is sent', async () => {
    sendToConductor({ address: '/ai/knob', args: [oscS('freeze'), oscF(1)] })
    await sleep(100)
    received.length = 0
    sendToConductor({ address: '/ai/ctx/player', args: [oscS('P0')] })
    sendToConductor({ address: '/ai/ctx/song', args: [oscS('x:scene:main')] })
    await sleep(150)
    expect(received).toEqual([])
    sendToConductor({ address: '/ai/knob', args: [oscS('freeze'), oscF(0)] })
  })
})

describe('conductor integration (full plan application path)', () => {
  it('feeding the clock → the offline Brain plan is sent quantized to every manifest slot', async () => {
    const received: OscMessage[] = []
    const fakeTidal = await bindEphemeral()
    fakeTidal.sock.on('message', (buf) => received.push(decode(buf)))
    const fakeSclang = await bindEphemeral()
    const probe = await bindEphemeral()
    const conductorPort = probe.port
    await new Promise<void>((r) => probe.sock.close(() => r()))
    const sender = await bindEphemeral()

    const manifest = loadManifestFile('manifests/example.json')
    if (Either.isLeft(manifest)) throw new Error(manifest.left)
    const config = testConfig({
      tidalPort: fakeTidal.port,
      listenPort: conductorPort,
      sclangPort: fakeSclang.port,
      channel: 2,
      manifest: manifest.right,
      walkIntervalMs: 60_000, // stop the walk and observe plan sends only
      heartbeatIntervalMs: 60_000,
    })
    const fiber = Effect.runFork(Effect.scoped(Effect.zipRight(startConductor(config), Effect.never)))
    await sleep(100)

    const sendTo = (msg: OscMessage): void => {
      sender.sock.send(encode(msg), conductorPort, '127.0.0.1')
    }
    // Feed cycle at cps=2 (500 ms per cycle)
    const t0 = Date.now()
    const feeder = setInterval(() => {
      const cycle = 100 + ((Date.now() - t0) / 1000) * 2
      sendTo({
        address: '/ai/ctx/cycle',
        args: [oscF(cycle), oscF(2)],
      })
    }, 100)

    // Phrase length 4 cycles = 2 s. With a 5 s lead the first application comes ≈6–7 s after startup. Wait 9 s
    await sleep(9000)
    clearInterval(feeder)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await sleep(100) // wait for the shutdown silencing (finalizer) datagrams to arrive
    await new Promise<void>((r) => fakeTidal.sock.close(() => r()))
    await new Promise<void>((r) => fakeSclang.sock.close(() => r()))
    await new Promise<void>((r) => sender.sock.close(() => r()))

    // Patterns other than "~" were sent to the 3 manifest slots (channel 2)
    const bySlot = (n: number): OscMessage[] =>
      received.filter(
        (m) =>
          m.address === '/ctrl' &&
          firstString(m) === `ai/2/${n}` &&
          m.args.some((a) => a.type === 's' && a.value !== `ai/2/${n}` && a.value !== '~'),
      )
    expect(bySlot(1).length).toBeGreaterThan(0)
    expect(bySlot(2).length).toBeGreaterThan(0)
    expect(bySlot(3).length).toBeGreaterThan(0)
    // The whole channel is silenced on shutdown: the last value of slots 1..8 is "~", the last density is 0
    const lastOf = (key: string) => [...received].reverse().find((m) => firstString(m) === key)
    ;[1, 2, 3, 4, 5, 6, 7, 8].forEach((n) =>
      expect(lastOf(`ai/2/${n}`)?.args.some((a) => a.type === 's' && a.value === '~')).toBe(true),
    )
    expect(numberAt(lastOf('ai/2/density')!, 0)).toBe(0)
  }, 20_000)
})

describe('conductor integration (kickstart)', () => {
  it('with no clock at all, the first plan is sent unquantized after kickstartMs', async () => {
    const received: OscMessage[] = []
    const fakeTidal = await bindEphemeral()
    fakeTidal.sock.on('message', (buf) => received.push(decode(buf)))
    const fakeSclang = await bindEphemeral()
    const probe = await bindEphemeral()
    const conductorPort = probe.port
    await new Promise<void>((r) => probe.sock.close(() => r()))

    const manifest = loadManifestFile('manifests/example.json')
    if (Either.isLeft(manifest)) throw new Error(manifest.left)
    const config = testConfig({
      tidalPort: fakeTidal.port,
      listenPort: conductorPort,
      sclangPort: fakeSclang.port,
      manifest: manifest.right,
      walkIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      kickstartMs: 300,
    })
    const fiber = Effect.runFork(Effect.scoped(Effect.zipRight(startConductor(config), Effect.never)))
    await sleep(1200)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await sleep(100)
    await new Promise<void>((r) => fakeTidal.sock.close(() => r()))
    await new Promise<void>((r) => fakeSclang.sock.close(() => r()))

    const patternSends = (n: number) =>
      received.filter(
        (m) =>
          firstString(m) === `ai/1/${n}` &&
          m.args.some((a) => a.type === 's' && a.value !== `ai/1/${n}` && a.value !== '~'),
      )
    expect(patternSends(1).length).toBeGreaterThan(0)
    expect(patternSends(2).length).toBeGreaterThan(0)
    expect(patternSends(3).length).toBeGreaterThan(0)
  }, 10_000)

  it('the kill switch engaged before the kickstart keeps it from writing any pattern', async () => {
    const received: OscMessage[] = []
    const fakeTidal = await bindEphemeral()
    fakeTidal.sock.on('message', (buf) => received.push(decode(buf)))
    const fakeSclang = await bindEphemeral()
    const probe = await bindEphemeral()
    const conductorPort = probe.port
    await new Promise<void>((r) => probe.sock.close(() => r()))

    const manifest = loadManifestFile('manifests/example.json')
    if (Either.isLeft(manifest)) throw new Error(manifest.left)
    const config = testConfig({
      tidalPort: fakeTidal.port,
      listenPort: conductorPort,
      sclangPort: fakeSclang.port,
      manifest: manifest.right,
      walkIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      kickstartMs: 300,
    })
    const fiber = Effect.runFork(Effect.scoped(Effect.zipRight(startConductor(config), Effect.never)))
    await sleep(100)
    const knob = await bindEphemeral()
    knob.sock.send(encode({ address: '/ai/knob', args: [oscS('density'), oscF(0)] }), conductorPort, '127.0.0.1')
    await sleep(1200)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await sleep(100)
    knob.sock.close()
    await new Promise<void>((r) => fakeTidal.sock.close(() => r()))
    await new Promise<void>((r) => fakeSclang.sock.close(() => r()))

    const patternSends = received.filter(
      (m) =>
        firstString(m)?.startsWith('ai/1/') === true &&
        m.args.some((a) => a.type === 's' && !a.value.startsWith('ai/1/') && a.value !== '~'),
    )
    expect(patternSends).toEqual([])
    // the kill itself was applied: density 0 reached Tidal
    expect(received.some((m) => firstString(m) === 'ai/1/density' && numberAt(m, 0) === 0)).toBe(true)
  }, 10_000)
})
