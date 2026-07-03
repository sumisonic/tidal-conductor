import { Either } from 'effect'

// Strict reading of environment variables (pure layer). "123abc", empty strings and out-of-range values never pass silently.

export type EnvReader = (name: string) => string | undefined

const INT_RE = /^-?\d+$/

/** Integer (min..max). Unset = fallback. Invalid = Left with a message */
export const readInt = (
  env: EnvReader,
  name: string,
  fallback: number,
  range: { readonly min: number; readonly max: number },
): Either.Either<number, string> => {
  const raw = env(name)
  if (raw === undefined) return Either.right(fallback)
  if (!INT_RE.test(raw.trim())) return Either.left(`${name} must be an integer: ${JSON.stringify(raw)}`)
  const n = Number.parseInt(raw.trim(), 10)
  return n < range.min || n > range.max
    ? Either.left(`${name} must be within ${range.min}..${range.max}: ${n}`)
    : Either.right(n)
}

export const readPort = (env: EnvReader, name: string, fallback: number): Either.Either<number, string> =>
  readInt(env, name, fallback, { min: 1, max: 65535 })

/** Non-negative integer such as milliseconds */
export const readMs = (env: EnvReader, name: string, fallback: number): Either.Either<number, string> =>
  readInt(env, name, fallback, { min: 0, max: Number.MAX_SAFE_INTEGER })

/** "host:port" form (empty or unset = null) */
export const readHostPort = (
  env: EnvReader,
  name: string,
): Either.Either<{ readonly host: string; readonly port: number } | null, string> => {
  const raw = env(name)
  if (raw === undefined || raw.trim() === '') return Either.right(null)
  const idx = raw.lastIndexOf(':')
  const host = idx === -1 ? '' : raw.slice(0, idx).trim()
  const portStr = idx === -1 ? '' : raw.slice(idx + 1).trim()
  if (host === '' || !INT_RE.test(portStr))
    return Either.left(`${name} must be in host:port form: ${JSON.stringify(raw)}`)
  const port = Number.parseInt(portStr, 10)
  return port < 1 || port > 65535
    ? Either.left(`${name} port must be within 1..65535: ${port}`)
    : Either.right({ host, port })
}
