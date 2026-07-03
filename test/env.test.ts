import { describe, expect, it } from 'vitest'
import { Either } from 'effect'
import { readHostPort, readInt, readMs, readPort } from '../src/conductor/env.js'

const envOf =
  (vars: Record<string, string>) =>
  (name: string): string | undefined =>
    vars[name]

describe('env: strict reading of environment variables', () => {
  it('unset gives the fallback, integers pass through', () => {
    expect(readPort(envOf({}), 'P', 6010)).toEqual(Either.right(6010))
    expect(readPort(envOf({ P: '7000' }), 'P', 6010)).toEqual(Either.right(7000))
    expect(readMs(envOf({ M: '0' }), 'M', 100)).toEqual(Either.right(0))
  })

  it('"123abc", empty string, decimals, negatives and out-of-range are Left', () => {
    expect(Either.isLeft(readPort(envOf({ P: '123abc' }), 'P', 1))).toBe(true)
    expect(Either.isLeft(readPort(envOf({ P: '' }), 'P', 1))).toBe(true)
    expect(Either.isLeft(readPort(envOf({ P: '1.5' }), 'P', 1))).toBe(true)
    expect(Either.isLeft(readPort(envOf({ P: '0' }), 'P', 1))).toBe(true)
    expect(Either.isLeft(readPort(envOf({ P: '65536' }), 'P', 1))).toBe(true)
    expect(Either.isLeft(readMs(envOf({ M: '-1' }), 'M', 1))).toBe(true)
    expect(Either.isLeft(readInt(envOf({ H: '1001' }), 'H', 4, { min: 0, max: 1000 }))).toBe(true)
  })

  it('host:port is null when unset or empty; malformed or port out of range is Left', () => {
    expect(readHostPort(envOf({}), 'N')).toEqual(Either.right(null))
    expect(readHostPort(envOf({ N: '' }), 'N')).toEqual(Either.right(null))
    expect(readHostPort(envOf({ N: '127.0.0.1:7772' }), 'N')).toEqual(Either.right({ host: '127.0.0.1', port: 7772 }))
    expect(Either.isLeft(readHostPort(envOf({ N: '7772' }), 'N'))).toBe(true)
    expect(Either.isLeft(readHostPort(envOf({ N: 'host:' }), 'N'))).toBe(true)
    expect(Either.isLeft(readHostPort(envOf({ N: 'host:70000' }), 'N'))).toBe(true)
  })
})
