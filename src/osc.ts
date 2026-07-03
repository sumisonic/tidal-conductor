import { match } from 'ts-pattern'

// Minimal OSC 1.0 codec (single messages only, no bundles).
// The only type tags that appear on this path (SC ⇄ Conductor ⇄ Tidal) are i / f / s / d,
// so it is implemented fully typed with no external dependency.

export type OscArg =
  | { readonly type: 'i'; readonly value: number }
  | { readonly type: 'f'; readonly value: number }
  | { readonly type: 'd'; readonly value: number }
  | { readonly type: 's'; readonly value: string }

export interface OscMessage {
  readonly address: string
  readonly args: ReadonlyArray<OscArg>
}

export const oscS = (value: string): OscArg => ({ type: 's', value })
export const oscF = (value: number): OscArg => ({ type: 'f', value })
export const oscI = (value: number): OscArg => ({ type: 'i', value })

const pad4 = (n: number): number => (n + 3) & ~3

/** OSC string: NUL-terminated + zero-padded to a 4-byte boundary */
const encodeString = (s: string): Buffer => {
  const raw = Buffer.from(s, 'utf8')
  const buf = Buffer.alloc(pad4(raw.length + 1))
  raw.copy(buf)
  return buf
}

const encodeArg = (arg: OscArg): Buffer =>
  match(arg)
    .with({ type: 'i' }, ({ value }) => {
      const b = Buffer.alloc(4)
      b.writeInt32BE(value | 0)
      return b
    })
    .with({ type: 'f' }, ({ value }) => {
      const b = Buffer.alloc(4)
      b.writeFloatBE(value)
      return b
    })
    .with({ type: 'd' }, ({ value }) => {
      const b = Buffer.alloc(8)
      b.writeDoubleBE(value)
      return b
    })
    .with({ type: 's' }, ({ value }) => encodeString(value))
    .exhaustive()

export const encode = (msg: OscMessage): Buffer =>
  Buffer.concat([
    encodeString(msg.address),
    encodeString(',' + msg.args.map((a) => a.type).join('')),
    ...msg.args.map(encodeArg),
  ])

/** Read an OSC string: [value, next offset] */
const readString = (buf: Buffer, offset: number): readonly [string, number] => {
  const end = buf.indexOf(0, offset)
  const stop = end === -1 ? buf.length : end
  return [buf.toString('utf8', offset, stop), offset + pad4(stop - offset + 1)]
}

export const decode = (buf: Buffer): OscMessage => {
  const [address, afterAddress] = readString(buf, 0)
  if (address === '#bundle') throw new Error('OSC bundles are not supported')
  if (!address.startsWith('/')) throw new Error(`invalid address: ${address}`)
  const [tags, afterTags] = readString(buf, afterAddress)
  if (!tags.startsWith(',')) throw new Error(`invalid type tag string: ${tags}`)
  const result = [...tags.slice(1)].reduce<{
    readonly offset: number
    readonly args: ReadonlyArray<OscArg>
  }>(
    (acc, tag) =>
      match(tag)
        .with('i', () => ({
          offset: acc.offset + 4,
          args: [...acc.args, oscI(buf.readInt32BE(acc.offset))],
        }))
        .with('f', () => ({
          offset: acc.offset + 4,
          args: [...acc.args, oscF(buf.readFloatBE(acc.offset))],
        }))
        .with('d', () => ({
          offset: acc.offset + 8,
          args: [...acc.args, { type: 'd' as const, value: buf.readDoubleBE(acc.offset) }],
        }))
        .with('s', () => {
          const [s, next] = readString(buf, acc.offset)
          return { offset: next, args: [...acc.args, oscS(s)] }
        })
        .otherwise(() => {
          throw new Error(`unsupported type tag: ${tag}`)
        }),
    { offset: afterTags, args: [] },
  )
  return { address, args: result.args }
}

/** The first string argument (null if none) */
export const firstString = (msg: OscMessage): string | null =>
  msg.args.find((a): a is OscArg & { type: 's' } => a.type === 's')?.value ?? null

/** The n-th numeric argument (i/f/d are treated alike; null if none) */
export const numberAt = (msg: OscMessage, index: number): number | null => {
  const numeric = msg.args.filter((a) => a.type !== 's')
  return numeric[index]?.value ?? null
}
