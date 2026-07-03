# Design

This document records the decisions behind tidal-conductor and why they were made. Read
[protocol.md](protocol.md) for the exact OSC contract and [wiring.md](wiring.md) for how to
connect it.

## 1. What it is

A **session musician for TidalCycles**: a separate process (the *Conductor*) that keeps
producing short rhythm plans, renders them to mini-notation and writes them into a handful of
state keys in your running Tidal. Your own patterns read those keys (`aiPat 1`, `aiF 1
"density"`) and decide what they mean musically. You steer it with five knobs (density,
freedom, freeze, mark, veto) from any OSC sender.

Three parts:

| part                                        | language              | job                                                                                              |
| ------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| Conductor (`src/conductor`)                 | TypeScript, Effect    | clock, scheduler, knobs, Brains, rendering, feedback memory                                      |
| Tidal reader (`integration/tidal`)          | Haskell (Tidal)       | `aiPat` / `aiF` / `resetAI`: read the keys safely, never crash the stream                        |
| SC snippet (`integration/supercollider`)    | sclang                | clock source from `/dirt/play`, deadman that silences a channel when the Conductor disappears    |

The Conductor never generates audio and never links against Tidal or SuperCollider. Everything
crosses process boundaries as OSC.

## 2. Constraints that shaped everything

- **Plain TidalCycles + SuperDirt.** Nothing in your Tidal or SC setup has to change beyond
  loading two files. No custom boot, no player system, no hardware.
- **Tidal only reads, the Conductor owns the state.** Slots default to `~` and density to its
  reader default, so a set works unchanged without a Conductor. A broken string silences one
  slot for one phrase, never the stream (`parseBP` in its total form, not `parseBP_E`).
- **Fail safe, never fail loud.** Invalid Brain output is never applied: the chain falls back to
  the next Brain (the last one, `offline`, cannot fail), a slot the plan omits is written as
  `~`, and if the process dies the SC deadman writes `~` within about 4 s.
- **Deterministic where it matters.** All randomness goes through a seeded generator
  (`runSeeded`); the renderer's output is checked against the real `parseBP` in CI.

## 3. One manifest, fixed at startup

A *manifest* declares up to eight slots, each with a generator kind (`struct`, `nsteps`,
`samples`), a role description for the Brain, and value bounds (`nRange`, `nSet`, `vocab`).
It is the whole configuration, and it does not change while the Conductor runs:

- The acceptance contract stays simple: every slot a plan names must be declared in the manifest
  with a matching kind and values, every declared slot is written every phrase (omitted ones as
  `~`), and nothing is left over from a previous configuration.
- The persistent feedback memory (veto/mark) is keyed by the manifest's stable `id`, so different
  manifests never share or pollute each other's memory.
- There is no second layer of configuration (set lists, scenes, sections): the knobs shape
  density over time, and a restart switches manifests.

## 4. Channels

Keys are namespaced as `ai/<channel>/<slot>` and `ai/<channel>/density`. One Conductor process
serves one channel (default 1). The namespace exists because the same key read as `Pattern Bool`
by one stream and as `Pattern Note` by another produces silent nonsense; giving two slot
layouts two channels keeps them apart (the reader itself is polymorphic and cannot stop you from
reading one key in two types), and two Conductors can run side by side. Serving several
channels from one process is outside this version; the protocol already allows it.

## 5. Clock

Plain Tidal shares no cycle counter with the outside world: Link (Tidal 1.10) carries tempo and
phase but not the cycle number, and is not network-enabled by default. The only reliable
observation of the absolute cycle is the `cycle` field that every `/dirt/play` message carries.
The SC snippet forwards it as `/ai/ctx/cycle cycle cps` whenever the cycle floor changes.

That anchor has a gap: it exists only while something plays. The Conductor therefore treats
observations as corrections to a phase-locked estimate and **keeps extrapolating through
silence** once it has synced (`hush`, long rests). The status line shows how stale the last
observation is (`pll=sync`, `pll=STALE(12s)`, `pll=UNSYNC`). A cycle that jumps back by more
than one cycle (`resetCycles`) starts a new epoch: pending plans are dropped and re-planned
against the new count. A late observation between a quarter cycle and one cycle behind the
estimate is treated as out of order and ignored; further back it is a rewind.

Indefinite extrapolation is a deliberate availability choice. The Conductor cannot distinguish a
`hush` from a stopped SuperCollider or a dead network path, so it keeps writing plans on the
extrapolated grid and records them as *applied* (written), whether or not anything was audible;
the feedback memory therefore may contain plans nobody heard. A tempo change during the silence
shows up at the next observation as a jump: forward is a plain resync, backward by more than a
cycle is handled as a rewind. A bounded stale time would be the alternative; it is not implemented.

A second gap is startup: the AI slots are silent until the first plan, and with nothing else
playing there is no clock to quantize the first plan against. The **kickstart** breaks the loop:
if no observation arrives within `AI_KICKSTART_MS` (3 s) the first plan is written immediately,
unquantized; from the first boundary on everything is quantized normally. If the clock still
does not come (nothing reads the slots yet, or the plan was all rests) it retries twice more at
the same interval, then prints a hint and stops. A kill or freeze that arrives while the Brain
is preparing the kickstart plan cancels the attempt (the attempt is re-armed for when the knob
is released), and a plan is never written after the shutdown silence.

## 6. Scheduler

- Phrase boundaries are multiples of `lengthCycles` in absolute cycles, with cycle 0 as the phase
  origin.
- A plan is requested from the Brain `AI_BRAIN_LEAD_MS` before the boundary and written
  `AI_SEND_AHEAD_MS` before it, matching Tidal's process-ahead window. If the lead does not fit
  into one phrase (high cps, long Brain), the target boundary skips ahead as many boundaries as
  needed instead of arriving late.
- A phrase's *transition* (an announced fill in the last cycle) is a separate reservation from the
  next plan, so a fill never blocks the next request.
- Every slot of the manifest is written at every boundary; a slot the Brain omitted is written
  as `~`. No stale pattern can outlive a phrase.
- `freeze` holds the current state: the scheduler drops its reservations and writes nothing new
  until release, so whatever is playing keeps playing; `density` at or below 0.01 is the kill switch and silences
  immediately, outside the phrase grid.

## 7. Brains and the degradation chain

| mode      | chain                       | notes                                                                                          |
| --------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `pool`    | pool → offline              | **default**. Curated plans from `plans/pool.json` mapped onto the manifest by role. No network. |
| `offline` | offline                     | Rule-based generator. Cannot fail.                                                             |
| `api`     | api → pool → offline        | An LLM through the Vercel AI SDK (Google, Anthropic or OpenAI). Needs a key.                    |
| `hybrid`  | pool, with an api turn every N phrases | Cheap variety on top of the pool.                                                   |
| `local`   | local → pool → offline      | An Ollama model. **Experimental**; a model name is required and no weights are distributed.   |
| `blind`   | api vs pool, hidden         | A/B trial mode; the assignment is sealed into a log until scoring.                              |

All Brains share one **acceptance contract**, enforced by the chain wrapper, not by each Brain:

1. the plan is normalized to the request (`lengthCycles` as requested; transitions stripped if
   the manifest disallows them);
2. every slot the plan names must be declared in the manifest, with the matching kind and values
   inside the declared bounds (`nRange`, `nSet`, `vocab`), otherwise the plan counts as a failure
   and the chain moves on; a slot the plan omits is not a failure, it is written as `~`;
3. degradation is announced on the terminal and, optionally, as `/ai/status`.

The pool maps entries by **role words**: a pool slot tagged `hat` lands on the manifest slot
whose `role` text contains `hat`, `hh` or `hi-hat` as whole words, wherever it is in the list.
Only structural patterns (euclid, grid, silence) are mapped; `nsteps` and `samples` slots are
regenerated by the offline rules each time, and a manifest that no pool entry fits at all makes
the pool fail (and degrade) rather than play something unrelated.

The LLM never writes sample names. A `samples` slot receives indexes into the manifest's
`vocab`, which the renderer turns into names; the name character set is constrained at
declaration time. That is the safety basis of every string that reaches Tidal.

The LLM Brains carry a **house style** in `STYLE_RULES` (`src/conductor/brain/api.ts`): sparse
snare-like roles, offbeat-oriented placement, regular rather than scattered density changes, and
euclid denominators of 8 or 16, which is a 4/4 grid. The offline rules and the training sampler
share the same bias. It is deliberate, not neutral: the manifest's `style` sentence is added on
top of it, and changing the rules themselves means retraining any local model.

## 8. Knobs, memory and feedback

- `density` is a *wish*: the Conductor runs a slow random walk with mean reversion toward it
  and writes the walked value to Tidal every 2 s. `freedom` scales the step size (0 = obedient,
  1 = the wish is only a hint).
- `mark` and `veto` are feedback on the current plan. Both are logged per session; `veto` also
  pushes the next phrase away from the vetoed shape. `pnpm feedback-add` distills a session's
  marks and vetos into `plans/feedback.json` (keyed by manifest id), and the Brains receive a
  compact "shapes to avoid / preferred shapes" block built from it. `pnpm pool-add` promotes
  marked plans into the pool.

## 9. Deadman in SuperCollider

Something has to outlive the Conductor process to clean up after it, and SuperCollider is
already there. The snippet keeps a per-channel heartbeat table and silences a channel that has
been quiet for 3 s by writing `~` and 0 straight into Tidal's `/ctrl` listener. It is armed from
the moment the file loads (so a Conductor that crashed before its first heartbeat, or before
the file was loaded, is still cleaned up on the next load), fires once per outage and repeats
the write on the next two ticks because UDP does not guarantee delivery. It runs on sclang's
SystemClock, so it does not depend on the application's main thread; a hung sclang is the one
failure it cannot cover. The clock is sent to every Conductor listed in the snippet
(`conductorPorts`) and the pong goes back to whoever pinged, so several Conductor processes can
share one SuperCollider. `e2e/run.sh` kills the Conductor with `kill -9` and asserts that the
slots read `~` afterwards.

## 10. Local models

No LoRA weights are distributed and no public model is currently qualified for real-time use.
The training directory is a **recipe**: it generates data from your own manifests with a
teacher API, gates it with the real `parseBP`, and fine-tunes a small base model. The prompt
constants (`SYSTEM_PROMPT`, `LOCAL_EXTRA_RULES`, the veto/mark block format) are part of the
training distribution: change them and the recipe has to be re-run. The author has exercised the
recipe only with an earlier version of the prompts and on Google Colab; nobody has run it with the
prompts in this repository yet, which is why it is a recipe and not a promise.

## 11. Verification

- Unit and property tests (vitest, fast-check) for the pure layers: state, scheduler, PLL,
  renderer, Brains, pool mapping, manifests, env parsing.
- **The real parser is the oracle.** `haskell/ParseBPCheck.hs` is a fixed runner that feeds
  rendered patterns to Tidal's `parseBP` and evaluates four cycles. `pnpm verify:patterns`
  generates about 2,500 cases from both generators, the pool and the offline Brain; the
  committed golden set (`haskell/fixtures/golden.ndjson`) runs inside `nix flake check`.
- **The reader is specified in Tidal itself.** `haskell/AiPatSpec.tidal` injects state directly
  (`setS` would be invisible to `queryArc`) and checks `aiPat` / `aiF` / `resetAI` semantics,
  including a broken slot stacked with a valid one in the same query.
- **Headless end-to-end.** `e2e/run.sh` boots sclang with a real SuperDirt (two channels, the
  sample library loaded, driven without a GUI), a real GHCi with Tidal, and the Conductor, then
  asserts kickstart, quantized boundaries, extrapolation through a long `hush`, rewind on
  `resetCycles`, and the deadman after `kill -9`. It needs a local SuperCollider and is run by
  hand, not in CI.
- The tested tuple is stated in the README (Tidal 1.10.1 / GHC 9.10.3 / nixpkgs revision) and
  pinned by the flake; the flake refuses to build with any other Tidal version.
