# Wiring: plain TidalCycles + SuperDirt + tidal-conductor

tidal-conductor is a separate process. It talks to Tidal and SuperCollider only over OSC, so
nothing in your Tidal or SuperDirt setup has to change beyond loading two snippets.

```
                                             any OSC sender ──/ai/knob, /ai/ctrl──►┐
                                                                                   │
   Tidal ──/dirt/play──► SuperDirt (sclang :57120)          Conductor (127.0.0.1:6011)
     ▲                     │ conductor.scd                       │
     │                     ├──/ai/ctx/cycle ─────────────────────►│  clock
     │                     ◄──/ai/heartbeat <channel> ────────────┤  1/s
     │                     ◄──/ai/ping ── /ai/pong ──────────────►│  preflight
     └──── /ctrl ai/<channel>/<slot>, ai/<channel>/density ◄──────┘  plans (127.0.0.1:6010)
                     ◄──── /ctrl … "~" / 0 ── (deadman) ── conductor.scd
```

## 1. Tidal: load the reader functions

`integration/tidal/Conductor.tidal` defines `aiPat`, `aiPatOn`, `aiF`, `aiFOn`, `resetAI`,
`resetAIOn`. Load it after your BootTidal (in GHCi: `:script /path/to/Conductor.tidal`, or
copy its contents into your boot file). Then read the slots in your patterns:

```haskell
d1 $ struct (aiPat 1) $ s "lt"                 -- slot 1 as a rhythm (Pattern Bool)
d2 $ s "hh27" # n (aiPat 3)                    -- slot 3 as sample indexes (Pattern Note)
d3 $ s (aiPat 4)                               -- slot 4 as a samples slot (Pattern String; needs a manifest with one, e.g. smoke-kit.json)
d4 $ degradeBy (1 - aiF 1 "density") $ s "hh*16"   -- the density knob (1 = all hits)
```

- Slots read `~` (silence) until the Conductor sends something, and density reads its default.
  Your set works without the Conductor.
- A broken string in a slot silences that slot only (whole-domain `parseBP`), never the stream.
- Requirements: Tidal ≥ 1.9 (`parseBP`, `cS`, `cF`, `innerJoin`). The file is two GHCi blocks:
  the readers need nothing from your boot file; `resetAI`/`resetAIOn` (second block) need
  `setS`/`setF` from BootTidal (1.10: exported by `Sound.Tidal.Boot`; 1.9: `setS = streamSetS
  tidal`, `setF = streamSetF tidal` in the default boot file). A custom boot without them loses
  only the reset helpers. If you paste the file into your own boot, keep the `:{ ... :}` blocks
  as separate blocks (not inside a `let`).
- A reader evaluated on its own in GHCi needs a type (`aiPat 1 :: Pattern Bool`); inside
  `struct`, `n` or `s` it is inferred.
- The Conductor writes through Tidal's control listener, `127.0.0.1:6010` by default
  (`cCtrlListen`, `cCtrlAddr`, `cCtrlPort` in your Tidal config). Change `AI_TIDAL_HOST` /
  `AI_TIDAL_PORT` if yours differs.
- No Tidal installed, or you want to try it on exactly the tested version? This repository's
  flake provides GHC + Tidal 1.10.1 and the packaged boot file:

  ```sh
  BOOT="$(nix develop -c ghc-pkg field tidal data-dir | tail -n1 | sed 's/data-dir: //')/BootTidal.hs"
  nix develop -c ghci -ghci-script "$BOOT"     # then :script integration/tidal/Conductor.tidal
  ```

  The banner `[TidalCycles version 1.10.1]` and `Listening for external controls on
  127.0.0.1:6010` confirm that the boot file was loaded; without it, `:script` fails with
  `Not in scope: type constructor or class 'Pattern'`.

## 2. SuperCollider: load the snippet

`integration/supercollider/conductor.scd` is self-contained. Load it once, e.g. at the end of
your startup file (after SuperDirt is the recommended order, not a requirement; reloading it is
safe):

```supercollider
"/path/to/tidal-conductor/integration/supercollider/conductor.scd".load;
```

It does three things:

- **Clock.** It watches Tidal's `/dirt/play` messages (every event carries `cycle` and `cps`) and
  forwards `/ai/ctx/cycle cycle cps` to the Conductor whenever the cycle floor changes. The
  Conductor extrapolates between messages, so a silent Tidal (`hush`, long rests) does not stop
  it once it has synced. The next event resyncs; a jump backwards of more than one cycle
  (`resetCycles`) is treated as a new epoch.
- **Deadman.** The Conductor sends `/ai/heartbeat <channel>` every second. If a channel's
  heartbeat stops for 3 s (crash, `kill -9`), the snippet writes `~` into that channel's slots
  1..8 and `0` into its density directly through Tidal's `/ctrl`, so the last AI pattern does not
  play forever, and repeats the write on the next two ticks (UDP) unless a heartbeat returns. It
  is armed from the moment the file loads: channel 1 is cleared once at load, and every channel
  that has ever sent a heartbeat is cleared when it goes quiet. The watchdog runs on sclang's
  SystemClock; it cannot help if sclang itself hangs.
- **Ping.** Answers `/ai/ping` with `/ai/pong "ok" 1.0 <armed>` to the sender, for `pnpm preflight`.

Ports are variables at the top of the file: `conductorPorts` (default `[6011]`; add one entry per
extra Conductor process, since the clock is sent to every port in the list) and Tidal
`127.0.0.1:6010`.

**Check sclang's own port.** The Conductor sends heartbeats and pings to `AI_SCLANG_PORT`
(default 57120). sclang normally listens there, but if another sclang or a leftover `scsynth`
already holds 57120 it silently moves to 57121 and the deadman never sees a heartbeat. Evaluate
`NetAddr.langPort` in SuperCollider; if it is not 57120, either free the port or set
`AI_SCLANG_PORT` to match. `pnpm preflight` only confirms that *something* answered the ping, so
do this check when several SuperCollider setups live on one machine.

## 3. Conductor

```sh
pnpm preflight                                   # SC ping/pong, deadman armed, clock, Tidal port
pnpm conductor --manifest manifests/example.json # default Brain: pool (no API key, no model)
```

`pnpm preflight` prints `✓` for a verified check, `!` for one it could not verify (the clock while
Tidal is silent) and `✗` for a failure; `--require-clock` turns the `!` into a failure for scripts.

- **Startup without a clock.** Plain Tidal only produces `/dirt/play` (and therefore a clock)
  while something plays, and the AI slots themselves are silent until the first plan arrives.
  The Conductor breaks the loop with a *kickstart*: if no clock has been seen 3 s after startup
  (`AI_KICKSTART_MS`), it sends the first plan immediately, unquantized. The AI slots start
  producing events, the clock starts flowing, and from the next phrase boundary on plans are
  quantized normally. If the clock still does not come (nothing reads the slots, or the plan
  happened to be all rests) it tries twice more, then prints a hint. You can also just have
  something playing before you start it. A kill or freeze that arrives while the kickstart plan
  is being prepared cancels it.
- **Stopping.** Ctrl-C silences the channel before exiting. If the Conductor dies without
  cleaning up, the SC deadman does it within about 4 s. If both are gone, evaluate `resetAI` in
  Tidal.
- **Status line** (every 5 s): `pll=sync` (clock fresh), `pll=STALE(12s)` (extrapolating
  through silence), `pll=UNSYNC` (never seen a clock — kickstart will fire, or play something).
  While STALE the Conductor keeps writing plans on the extrapolated grid and records them as
  applied; it cannot tell a `hush` from a stopped SuperCollider. A tempo change during the
  silence is picked up at the next event: faster is a plain resync, slower by more than a cycle
  is handled like a rewind (pending plans are re-planned).

## 4. Knobs and buttons

Send `/ai/knob <name> <0..1>` to the Conductor's listen port from anything that can send OSC
(a MIDI→OSC bridge, a controller app, another program). Names:

| name      | kind   | meaning |
|-----------|--------|---------|
| `density` | knob   | target density. The AI aims for it (how obediently depends on `freedom`). **at or below 0.01 it is the kill switch** (0 from any controller): every slot goes silent immediately |
| `freedom` | knob   | 0 = obedient (density follows the wish within seconds), 0.5 = default, 1 = provocative (the wish is only a hint) |
| `freeze`  | toggle | ≥ 0.5 = hold the current state (a lock, not a mute). After release the AI stays restrained for a few ticks |
| `mark`    | button | "this was good": records the current plan (positive feedback; `pnpm pool-add` can promote it into the pool) |
| `veto`    | button | "not this shape": negative feedback, the sound continues; the next phrase moves to a different vocabulary |

Optional: mirror your other controls as `/ai/ctrl <name> <0..1>`; the Conductor uses the
activity level (how busy you are) as a hint to change less while you are playing.

Optional: `AI_NOTIFY=host:port` sends `/ai/status "DEGRADED api->pool"` / `"OK pool"` when a
Brain falls back or recovers, for a display of your choice.

## Troubleshooting

- **A slot is silent although the status line shows plans being applied.** Check, in this
  order: (1) a sample name your bank does not have: SuperDirt only logs `no synth or sample
  named 'x' could be found` and plays nothing, and the names in your patterns (`s "lt"`) and in
  a manifest's `vocab` are never checked against the bank; list what is loaded with
  `~dirt.soundLibrary.buffers.keys.asArray.sort.postln` in SuperCollider and pick from that
  (the examples use `lt`, `hh27`, `bd`, `sn`, `hh` and `perc` from the standard Dirt-Samples);
  (2) the pattern reads the slot in a different form than the manifest declares (a `struct`
  slot inside `n`, an `nsteps` slot inside `struct`); (3) the Conductor runs with
  `AI_CHANNEL` other than 1 but the pattern uses `aiPat` (channel 1) instead of `aiPatOn`;
  (4) you loaded `Conductor.tidal` but have not evaluated a pattern that reads the slot yet.
- **`pll=UNSYNC` stays after the kickstarts.** Nothing reads the slots yet (evaluate a pattern
  that uses `aiPat`), or SuperDirt is not receiving on the port Tidal sends to.
- **preflight: `SC ping/pong` fails.** `conductor.scd` is not loaded, or sclang is not on 57120
  (see "Check sclang's own port" above). If the Conductor's listen port is not 6011, the
  snippet's `conductorPorts` must list the port you use, or the clock never arrives.
- **Loading `Conductor.tidal` fails with `Not in scope: ... Pattern`.** Your boot file was not
  loaded; check for the `[TidalCycles version ...]` banner first.

## Timing notes

- Plans are sent 375 ms before the phrase boundary by default: Tidal's default process-ahead
  window (`cProcessAhead`, 0.3 s) plus a margin for the scheduler's tick. If you changed
  `cProcessAhead` or the frame timespan, set `AI_SEND_AHEAD_MS` to the new window plus the same
  margin; too small and a plan can miss the first part of its cycle or land a cycle late.
- The Brain is asked at least 5 s before the boundary (`AI_BRAIN_LEAD_MS`). At very high cps a
  phrase can be shorter than the lead; the scheduler then skips boundaries until one fits.
- Phrase boundaries are multiples of the plan length in absolute cycles (`lengthCycles`, from the
  manifest's `defaultLengthCycles`).
