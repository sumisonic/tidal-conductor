// Channel: the namespace for state keys on the Tidal side.
// Key convention: `ai/<channel>/<slot>` and `ai/<channel>/density`. channel is a positive integer, default 1.
// The first Conductor only handles a single channel, but the protocol allows several
// Conductors to coexist (each on its own channel), so the channel is always part of the key.

export type Channel = number

export const DEFAULT_CHANNEL: Channel = 1

export const isChannel = (n: number): n is Channel => Number.isInteger(n) && n >= 1

export const SLOTS: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8]

/** `ai/<channel>/<key>` */
export const aiKey = (channel: Channel, key: string | number): string => `ai/${channel}/${key}`

export const densityKey = (channel: Channel): string => aiKey(channel, 'density')
