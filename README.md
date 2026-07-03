# tidal-conductor

An AI session musician for [TidalCycles](https://tidalcycles.org). A separate process, the
*Conductor*, keeps generating short rhythm plans and writes them into a few state keys of your
running Tidal session, phrase by phrase, quantized to the cycle. Your own patterns decide what
those keys mean (`struct (aiPat 1)`, `n (aiPat 3)`, `s (aiPat 4)`), and you steer the whole
thing with five knobs from any OSC sender. It needs nothing but plain TidalCycles + SuperDirt.

**Status: alpha.** It runs end to end in the author's setup (macOS, Tidal 1.10.1, SuperDirt)
and has a manually run headless end-to-end test, but it has not been used in a performance on
plain Tidal yet and nobody else has run it. Expect rough edges.

**Maintenance.** This is a published snapshot of a tool I built for my own sets, shared as is.
Please post bug reports and questions as issues. I answer when I can, but I'd recommend forking
rather than waiting for me.

## How it works

```
   Tidal ──/dirt/play──► SuperDirt (sclang)              Conductor (127.0.0.1:6011)
     ▲                     │ conductor.scd                     │
     │                     ├──/ai/ctx/cycle ───────────────────►│  clock
     │                     ◄──/ai/heartbeat ────────────────────┤  deadman lease, 1/s
     └──── /ctrl ai/1/<slot>, ai/1/density ◄───────────────────┘  plans, every phrase
                                                  ▲  /ai/knob density | freedom | freeze | mark | veto
```

- The Conductor never makes sound and never links against Tidal or SuperCollider; everything
  crosses process boundaries as OSC.
- Slots read `~` until a plan arrives, so your set works without the Conductor. A broken string
  silences one slot for one phrase, never the stream.
- If the Conductor dies, a watchdog in SuperCollider silences its slots within about 4 s.
- Plans come from a *Brain*. The default, `pool`, picks from a curated set of plans and needs
  no network, key or model. An LLM (`api`) or a local model (`local`, experimental) can replace
  it, and every Brain falls back to the next one when it fails.

## Requirements

- TidalCycles with SuperDirt. Written against the 1.9 API and verified on 1.10.1 only (see
  Verification).
- Node 22 and pnpm 10. `mise.toml` pins the tested versions; `mise install` sets them up.
- Only for the verification suite: Nix (the flake pins GHC + Tidal), or a GHC with the `tidal`
  package on PATH.

## Quick start

```sh
git clone https://github.com/sumisonic/tidal-conductor
cd tidal-conductor
mise install                    # or provide Node 22 + pnpm 10 yourself
pnpm install --frozen-lockfile
```

1. **SuperCollider.** Load the snippet once SuperDirt is running (the end of your startup file
   is a good place):

   ```supercollider
   "/path/to/tidal-conductor/integration/supercollider/conductor.scd".load;
   ```

2. **Tidal.** Load the readers after your boot file:

   ```
   :script /path/to/tidal-conductor/integration/tidal/Conductor.tidal
   ```

3. **Check the wiring, then start the Conductor** with the example manifest:

   ```sh
   pnpm preflight
   pnpm conductor --manifest manifests/example.json
   ```

4. **Read the slots in Tidal.** The example manifest has two rhythm slots and one
   sample-index slot:

   ```haskell
   d1 $ struct (aiPat 1) $ s "lt"
   d2 $ struct (aiPat 2) $ s "hh27" # n (aiPat 3)
   d3 $ degradeBy (1 - aiF 1 "density") $ s "hh*16"
   ```

   The order of steps 3 and 4 does not matter: with nothing else playing, the Conductor writes
   its first plan 3 s after startup (there is no clock yet), and that plan stays in Tidal's state
   until a pattern reads it. Once the slots produce events the clock syncs, and from then on a
   new plan arrives every 4 cycles.

5. **Steer it.** Send `/ai/knob <name> <0..1>` to `127.0.0.1:6011` from any OSC sender:
   `density`, `freedom`, `freeze`, `mark`, `veto`. `density` at or below 0.01 is the kill switch.

All of this in detail, including timing and troubleshooting: [docs/wiring.md](docs/wiring.md).

## Manifests

A manifest declares the slots: which exist, what each one is for, and which values are
allowed. It is the only configuration unit and is fixed when the Conductor starts. Format and
fields: [manifests/README.md](manifests/README.md).

## Brains

| `AI_BRAIN`       | what it is                                                                                                   | needs                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | --------------------- |
| `pool` (default) | curated plans from `plans/pool.json`, mapped onto your manifest by role                                      | nothing               |
| `offline`        | a rule-based generator; never fails                                                                          | nothing               |
| `api`            | an LLM through the Vercel AI SDK (`AI_PROVIDER=google`, `anthropic` or `openai`); falls back to `pool`        | an API key in `.env`  |
| `hybrid`         | `pool`, with an `api` turn every N phrases (`AI_HYBRID_EVERY`)                                               | an API key            |
| `local`          | an Ollama model (`AI_LOCAL_MODEL` is required). **Experimental**; the training recipe is unverified with the current prompts | a model you trained   |
| `blind`          | an A/B trial of two Brains (default pair `api` vs `pool`, `AI_BLIND_PAIR` to change) with the assignment hidden until you score it | an API key for the default pair; startup is refused without one |

**No model weights are distributed**, and no public model is currently qualified for real-time
use. `training/` is a recipe for building your own local Brain from your own manifests:
[training/README.md](training/README.md). The `pool` Brain is what the author uses and tests.

## Environment variables

With the default `pool` Brain only the manifest is required (`local` needs `AI_LOCAL_MODEL`,
`api` / `hybrid` / `blind` need an API key). The pnpm scripts read a `.env` next to
`package.json` (see `.env.example`). The full list is at the top of `src/conductor/run.ts`. The
ones you are most likely to touch:

| variable                            | default                     | meaning                                                                          |
| ----------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `AI_MANIFEST`                       | required (or `--manifest`)  | the manifest file                                                                |
| `AI_BRAIN`                          | `pool`                      | the Brain, see above                                                             |
| `AI_CHANNEL`                        | `1`                         | key namespace `ai/<channel>/…`; one channel per Conductor process                |
| `AI_TIDAL_HOST` / `AI_TIDAL_PORT`   | `127.0.0.1` / `6010`        | Tidal's `/ctrl` listener                                                         |
| `AI_SCLANG_HOST` / `AI_SCLANG_PORT` | `127.0.0.1` / `57120`       | where `conductor.scd` runs (sclang's own port)                                   |
| `AI_LISTEN_HOST` / `AI_LISTEN_PORT` | `127.0.0.1` / `6011`        | the Conductor's own port. No authentication: keep it on loopback                 |
| `AI_SEND_AHEAD_MS`                  | `375`                       | how early a plan is written before its boundary (match Tidal's `cProcessAhead`)  |
| `AI_KICKSTART_MS`                   | `3000`                      | first plan without a clock after this long; `0` disables                         |
| `AI_NOTIFY`                         | unset                       | `host:port` that receives `/ai/status` when a Brain falls back or recovers       |

## Verification

Two independent gates run in CI (`.github/workflows/ci.yml`) on pushes to `main` and
`feature/**` and on every pull request:

- Node: `pnpm check` (eslint + tsc), `pnpm knip`, `pnpm format:check`, `pnpm test` (vitest).
- Tidal: the renderer's output goes through the **real** `parseBP` of TidalCycles.
  `nix flake check` runs the `aiPat` specification (`haskell/AiPatSpec.tidal`, in GHCi) and the
  committed golden cases; `pnpm verify:patterns` regenerates a sweep of about 2,500 patterns,
  including what the real wiring writes, and checks it with the fixed runner
  `haskell/ParseBPCheck.hs`. Both need a GHC with the `tidal` package, which `nix develop`
  provides.

A headless end-to-end scenario, `e2e/run.sh` (SuperDirt + GHCi + the Conductor: kickstart,
quantized phrases, extrapolation through `hush`, `resetCycles`, the deadman after `kill -9`),
runs by hand on a machine with SuperCollider. It is written for macOS; on Linux point `SCLANG`
at your sclang binary.

Tested with: Tidal 1.10.1 / GHC 9.10.3 / nixpkgs `ed142ab1b3a0` (flake.lock). The full set,
including the end-to-end run with SuperCollider, on macOS aarch64; the Nix checks and the
generated sweep also on Linux x86_64 in CI. Nobody has run the Conductor with a real
SuperCollider on Linux yet. Tidal 1.9 has not been tested.

## Current scope

Not in this version: several channels in one process (run one Conductor per
channel instead), switching manifests while running (restart instead), a Tidal-side lease that
would make the SuperCollider snippet optional, a Link-based clock, Tidal 1.9 in CI, and a bounded
stale time for the clock. Not planned: publishing to npm, distributing model weights.

## Documentation

- [docs/wiring.md](docs/wiring.md): connecting Tidal, SuperCollider and the knobs; timing notes.
- [docs/protocol.md](docs/protocol.md): the OSC contract (v1).
- [docs/design.md](docs/design.md): the decisions and why they were made.
- [AGENTS.md](AGENTS.md): conventions and checks for contributors and coding agents.
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).

## License

MIT. See LICENSE and NOTICE. TidalCycles, SuperCollider and SuperDirt are GPL-licensed host
software that this program talks to over OSC; nothing of theirs is redistributed here.
