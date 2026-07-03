# OSC protocol (v1)

tidal-conductor talks to its neighbors only over OSC on UDP. This file is the contract. The
code follows it: `src/conductor/events.ts` (incoming), `src/conductor/conductor.ts` (outgoing),
`integration/supercollider/conductor.scd` and `integration/tidal/Conductor.tidal` (the two hosts).

## Endpoints and defaults

| endpoint                         | default           | Conductor setting                  | host setting                                          |
| -------------------------------- | ----------------- | ---------------------------------- | ----------------------------------------------------- |
| Conductor listen port            | `127.0.0.1:6011`  | `AI_LISTEN_HOST` / `AI_LISTEN_PORT` | `conductorHost` / `conductorPorts` in `conductor.scd` |
| Tidal control listener (`/ctrl`) | `127.0.0.1:6010`  | `AI_TIDAL_HOST` / `AI_TIDAL_PORT`   | `cCtrlListen`, `cCtrlAddr`, `cCtrlPort` (Tidal config) |
| sclang (where `conductor.scd` runs) | `127.0.0.1:57120` | `AI_SCLANG_HOST` / `AI_SCLANG_PORT` | sclang's own port (`NetAddr.langPort`)               |
| notification target              | none              | `AI_NOTIFY=host:port`               | your display                                          |

The Conductor binds `127.0.0.1` by default. The protocol has no authentication, so listening on
another interface (`AI_LISTEN_HOST=0.0.0.0`) is an explicit opt-in for a trusted network only.

## Type conventions

`s` = string, `f` = float32, `i` = int32. Where a message carries a number, the Conductor reads
"the n-th numeric argument" and accepts `f`, `d` (float64) or `i`. A required number that is
missing, NaN or infinite drops the whole message. The one exception is `cps` in `/ai/ctx/cycle`:
missing or non-finite, it reads 0 (an observation the Conductor cannot extrapolate from). The
tags below are what each sender emits.

## Into the Conductor (listen port)

| address         | arguments                        | sender                         | meaning                                                                                                                                                                                                              |
| --------------- | -------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ai/knob`      | `name:s value:f`                 | anything                       | The AI knobs. `density` and `freedom` are clamped to 0..1 (`density` at or below 0.01 is the kill switch); `freeze` is on at >= 0.5; `mark` and `veto` are buttons that fire at >= 0.5. See [wiring.md](wiring.md), section 4. Unknown names are shown in the status line and ignored.        |
| `/ai/ctrl`      | `name:s value:f`                 | anything (optional)            | Mirror of the human performer's own controls. Only the message rate is used: an activity level 0..1 over the last 8 s that makes the AI change less while you are busy. Names and values are not interpreted. |
| `/ai/ctx/cycle` | `cycle:f cps:f`                  | the clock source (`conductor.scd`) | A clock observation: Tidal's absolute cycle and the current cycles per second. Sent whenever the cycle floor changes, to every port in the snippet's `conductorPorts`. A missing `cps` reads 0, which the Conductor cannot extrapolate from.                      |
| `/ai/pong`      | `status:s version:f armed:i`     | `conductor.scd`                | Reply to `/ai/ping`, sent back to the ping's source address. `armed` 1 means the deadman task is running. The float exists so that preflight also proves that `s` and `f` type tags get through. Consumed by `pnpm preflight`, never turned into an event. |

Any other address is ignored. Messages whose required number is missing or non-finite are dropped (see above for `cps`).

## Out of the Conductor

| address         | arguments      | target                 | when                                                                                                                                                               |
| --------------- | -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/ctrl`         | `key:s value:s` | Tidal                  | A slot: `ai/<channel>/<slot>` ← mini-notation string, `~` meaning silence. Written for **every** slot of the manifest at every phrase boundary (missing ones as `~`); also for the first plan of a kickstart (unquantized), for a transition in the last cycle of a phrase (the changed slots only), and as `~` for every slot on kill and on a clean exit. |
| `/ctrl`         | `key:s value:f` | Tidal                  | The density: `ai/<channel>/density` ← 0..1. Written every 2 s (`AI_WALK_INTERVAL_MS`) as the density walk moves (not while frozen or killed), and 0 immediately on kill and on a clean exit. |
| `/ai/heartbeat` | `channel:i`    | sclang                 | Every 1 s. The deadman lease for this channel.                                                                                                                     |
| `/ai/ping`      | none           | sclang                 | Sent by `pnpm preflight` (from the listen port), not by the running Conductor.                                                                          |
| `/ai/status`    | `text:s`       | `AI_NOTIFY` target     | `DEGRADED <intended>-><used>` when a Brain falls back (for example `DEGRADED api->pool`), `OK <used>` when it recovers. Not sent unless `AI_NOTIFY` is set, and never in `blind` mode (it would reveal the assignment). |

On a clean exit (Ctrl-C) the Conductor writes `~` into its slots and 0 into its density before
closing. `pnpm preflight` writes one probe key, `ai/preflight` = 0, to test reachability.

## From `conductor.scd` into Tidal (the deadman)

| address | arguments                                         | when                                                                                                     |
| ------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/ctrl` | `key:s value:s` with `key` = `ai/<ch>/<n>` for n in 1..8 and `value` = `"~"`, then `key:s value:f` with `key` = `ai/<ch>/density` and `value` = 0.0 | A channel's heartbeat is more than 3 s late (fires once, then repeats on the next two ticks unless a heartbeat returns; the next heartbeat re-arms it), and once for channel 1 when the file loads. |

## Key namespace

- `ai/<channel>/<slot>` (string) and `ai/<channel>/density` (float). `channel` is a positive
  integer, default 1. `slot` is 1..8.
- A Conductor writes only the keys of its own channel. Two Conductors on different channels can
  run side by side (each with its own listen port, listed in the snippet's `conductorPorts` so
  that both receive the clock).
- Treat everything under `ai/<channel>/` as owned by that channel's Conductor. The only other
  writer is the deadman in `conductor.scd`, and `resetAI` in Tidal for manual recovery.
- Reserved, not used yet: `ai/<channel>/expiresCycle` for a Tidal-side lease that would make
  the SC deadman optional. Do not put expiry information into the pattern strings.

## Timing contract

- Phrase boundaries are multiples of the plan length (`lengthCycles`, from the manifest's
  `defaultLengthCycles`) in Tidal's absolute cycle count. The phase origin is cycle 0.
- A plan is written `AI_SEND_AHEAD_MS` (default 375 ms) before its boundary so that Tidal's
  process-ahead window (`cProcessAhead`, default 0.3 s) picks it up for the right cycle.
- The Brain is asked `AI_BRAIN_LEAD_MS` (default 5000 ms) before the boundary with a deadline of
  `AI_API_TIMEOUT_MS` (default 4500 ms). If a phrase is shorter than the lead, boundaries are
  skipped until one fits.
- Kickstart: if no clock observation has arrived `AI_KICKSTART_MS` (default 3000 ms) after
  startup, the first plan is written immediately and unquantized; up to three attempts, spaced by
  the same interval, if the clock still does not come. `0` disables it.
- The clock is extrapolated between observations. A silent Tidal does not stop the Conductor
  once it has synced; the status line shows `pll=STALE(Ns)` meanwhile. A cycle that jumps back by
  more than one cycle (`resetCycles`) starts a new epoch: pending plans are dropped and re-planned.

## Compatibility

This is protocol v1. Any change that breaks an existing sender or receiver gets a new version
section here and a CHANGELOG entry, and the integration snippets are updated in the same commit.
