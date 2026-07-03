import { describe, expect, it } from 'vitest'
import { FastCheck as fc } from 'effect'
import { decode, encode, firstString, numberAt, oscF, oscI, oscS, type OscMessage } from '../src/osc.js'

describe('osc golden', () => {
  it('/ctrl (s, f) — same shape as SC sendMsg', () => {
    const buf = encode({
      address: '/ctrl',
      args: [oscS('ai/ch1/density'), oscF(0.5)],
    })
    // address 8 bytes + tags ",sf" 4 bytes + string 16 bytes + float 4 bytes
    expect(buf.length).toBe(8 + 4 + 16 + 4)
    expect(buf.subarray(0, 6).toString()).toBe('/ctrl\0')
    expect(buf.subarray(8, 11).toString()).toBe(',sf')
    const decoded = decode(buf)
    expect(decoded.address).toBe('/ctrl')
    expect(firstString(decoded)).toBe('ai/ch1/density')
    expect(numberAt(decoded, 0)).toBeCloseTo(0.5)
  })

  it('message with no arguments (/ai/ping)', () => {
    const decoded = decode(encode({ address: '/ai/ping', args: [] }))
    expect(decoded).toEqual({ address: '/ai/ping', args: [] })
  })

  it('int argument (same shape as an integer sendMsg from SC)', () => {
    const decoded = decode(encode({ address: '/ai/test', args: [oscS('knob'), oscI(3)] }))
    expect(numberAt(decoded, 0)).toBe(3)
  })

  it('rejects bundles', () => {
    const bundle = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8)])
    expect(() => decode(bundle)).toThrow('bundle')
  })
})

describe('osc property', () => {
  const argArb = fc.oneof(
    fc
      .string({ minLength: 0, maxLength: 32, unit: 'grapheme-ascii' })
      .filter((s) => !s.includes('\0'))
      .map(oscS),
    fc.float({ noNaN: true, noDefaultInfinity: true }).map((n) => oscF(Math.fround(n))),
    fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }).map(oscI),
  )
  const msgArb = fc.record({
    address: fc
      .string({ minLength: 1, maxLength: 24, unit: 'grapheme-ascii' })
      .filter((s) => !s.includes('\0'))
      .map((s) => '/' + s),
    args: fc.array(argArb, { maxLength: 6 }),
  })

  it('encode → decode roundtrip', () => {
    fc.assert(
      fc.property(msgArb, (msg: OscMessage) => {
        const decoded = decode(encode(msg))
        expect(decoded.address).toBe(msg.address)
        expect(decoded.args.length).toBe(msg.args.length)
        decoded.args.forEach((arg, idx) => {
          const orig = msg.args[idx]!
          expect(arg.type).toBe(orig.type)
          expect(arg.value).toEqual(orig.value)
        })
      }),
      { numRuns: 300 },
    )
  })

  it('encode is always on a 4-byte boundary', () => {
    fc.assert(
      fc.property(msgArb, (msg: OscMessage) => {
        expect(encode(msg).length % 4).toBe(0)
      }),
      { numRuns: 200 },
    )
  })
})
