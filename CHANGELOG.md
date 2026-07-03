# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) once there is a release.

## [Unreleased]

First version.

### Added

- The Conductor (`pnpm conductor --manifest <file>`): manifest-driven slots (`struct`, `nsteps`,
  `samples`) written to `ai/<channel>/<slot>` and `ai/<channel>/density` through Tidal's `/ctrl`
  listener, one channel per process, every declared slot written every phrase (omitted ones as
  `~`).
- Brains with a degradation chain: `pool` (default, curated plans mapped by role words), `offline`
  (rules, never fails), `api` (Google / Anthropic / OpenAI through the Vercel AI SDK), `hybrid`,
  `local` (Ollama, experimental, model name required, no weights distributed) and `blind` (A/B
  trials). One acceptance contract for all of them: length normalization, transition stripping,
  manifest mismatch counts as a failure.
- Clock: PLL on `/ai/ctx/cycle`, extrapolation through silence, clock-reset epochs, and a
  kickstart for starting without a clock (`AI_KICKSTART_MS`, three attempts, canceled by
  kill/freeze/shutdown).
- Scheduler: phrase boundaries on the absolute cycle, plans written `AI_SEND_AHEAD_MS` ahead,
  transitions (announced fills) as a separate reservation.
- Knobs over OSC (`density`, `freedom`, `freeze`, `mark`, `veto`), an optional control mirror
  (`/ai/ctrl`), persistent veto/mark memory keyed by manifest id, `pnpm pool-add` and
  `pnpm feedback-add`.
- `integration/tidal/Conductor.tidal`: `aiPat`, `aiPatOn`, `aiF`, `aiFOn`, `resetAI`, `resetAIOn`
  (Tidal 1.9 API surface; tested on 1.10.1).
- `integration/supercollider/conductor.scd`: clock source from `/dirt/play`, per-channel deadman
  armed from load with repeated sends, ping/pong for preflight, clock fan-out to several
  Conductors.
- `pnpm preflight` (`--require-clock` makes a missing clock fail instead of warning).
- Verification: fixed Haskell runner `haskell/ParseBPCheck.hs` (fails closed on malformed or
  empty input), generated case sweep (`pnpm verify:patterns`, pipefail), `aiPat` specification
  in GHCi (`pnpm verify:aipat`), Nix flake pinning Tidal 1.10.1, GitHub Actions, headless
  end-to-end harness (`e2e/run.sh`).
- Documentation: README, design, protocol (OSC v1), wiring, manifests, and the training
  recipe (unverified with the current prompts; Colab or a CUDA machine).
- Strict configuration: invalid numbers, ports, `host:port`, Brain or provider names refuse
  startup; an `nsteps` slot declares exactly one of `nRange` / `nSet`; listeners bind
  `127.0.0.1` unless `AI_LISTEN_HOST` says otherwise; non-finite OSC numbers are dropped.
