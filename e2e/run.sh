#!/usr/bin/env bash
# Headless end-to-end scenario: SuperDirt (sclang) + Tidal 1.10 (GHCi) + the Conductor, all on one machine.
# Verifies, in order: preflight, kickstart without a clock, quantized phrases, extrapolation through a
# 40 s hush, clock rewind on resetCycles, and the SC deadman clearing Tidal's state after kill -9.
#
# Requirements: SuperCollider with SuperDirt + Dirt-Samples, and a GHC with the tidal package —
# either on PATH or through a flake given as NIX_FLAKE (e.g. NIX_FLAKE=. for this repo's flake).
# Written and run on macOS; SCLANG defaults to the app bundle's binary. On Linux: SCLANG=$(command -v sclang).
# Everything runs on explicit ports so it cannot collide with another sclang/scsynth on the machine:
#   E2E_SC_PORT (sclang + SuperDirt, default 57130), Tidal's /ctrl port stays 6010, Conductor 6011.
# Only processes started by this script are ever signalled (PIDs are tracked; nothing is killed by name).
# Logs land in E2E_OUT (default ./e2e/out, gitignored). Takes about three minutes.
set -u; shopt -s nullglob
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${E2E_OUT:-$REPO/e2e/out}"; mkdir -p "$OUT"; rm -f "$OUT"/*.log
SC_PORT="${E2E_SC_PORT:-57130}"
SCLANG="${SCLANG:-/Applications/SuperCollider.app/Contents/MacOS/sclang}"
NODE_BIN="$(mise which node 2>/dev/null || command -v node)"   # the real binary, so kill -9 hits node itself
run() { if [ -n "${NIX_FLAKE:-}" ]; then nix develop --no-update-lock-file "$NIX_FLAKE" -c "$@"; else "$@"; fi }
cd "$REPO"

SC=""; SCSYNTH=""; TIDAL=""; CONDUCTOR=""
cleanup() {
  [ -n "$CONDUCTOR" ] && kill -9 "$CONDUCTOR" 2>/dev/null
  [ -n "$TIDAL" ] && { pkill -P "$TIDAL" 2>/dev/null; kill "$TIDAL" 2>/dev/null; }
  [ -n "$SCSYNTH" ] && kill "$SCSYNTH" 2>/dev/null
  [ -n "$SC" ] && kill "$SC" 2>/dev/null
  return 0
}
trap cleanup EXIT

# 1. SuperCollider (headless, explicit language port)
E2E_REPO="$REPO" E2E_SC_PORT="$SC_PORT" "$SCLANG" -u "$SC_PORT" e2e/sc.scd > "$OUT/sc.log" 2>&1 &
SC=$!
for i in {1..60}; do grep -q "E2E SC READY" "$OUT/sc.log" && break; sleep 1; done
grep -q "E2E SC READY" "$OUT/sc.log" || { echo "SC did not become ready"; tail -20 "$OUT/sc.log"; exit 1; }
SCSYNTH="$(pgrep -P "$SC" -x scsynth || true)"                  # the server this sclang booted (not any other)
echo "SC ready ($i s; sclang $SC, scsynth ${SCSYNTH:-?})"

# 2. Tidal: the packaged BootTidal.hs with the SuperDirt target pointed at our sclang port
PACKAGED="$(run bash -c 'ghc-pkg field tidal data-dir | sed "s/data-dir: //"' | tail -n1)/BootTidal.hs"
sed "s|^tidalInst <- mkTidal\$|tidalInst <- mkTidalWith [(superdirtTarget { oPort = $SC_PORT }, [superdirtShape])] defaultConfig|" "$PACKAGED" > "$OUT/BootTidal.hs"
(
  echo ':script integration/tidal/Conductor.tidal'
  echo 'putStrLn "E2E TIDAL READY"'
  sleep 14                                                       # preflight window (before the Conductor takes :6011)
  echo 'd1 $ struct (aiPat 1) $ s "lt"'                          # AI-only patterns, nothing else: the Conductor must kickstart
  echo 'd2 $ s "hh27" # n (aiPat 3)'
  echo 'putStrLn "E2E PATTERNS EVALUATED"'
  sleep 12
  echo 'putStrLn "E2E STATE AFTER KICKSTART"'; echo 'getState "ai/1/1" >>= print'
  sleep 18
  echo 'putStrLn "E2E HUSH"'; echo 'hush'
  sleep 40
  echo 'putStrLn "E2E RESUME"'; echo 'd1 $ struct (aiPat 1) $ s "lt"'; echo 'd2 $ s "hh27" # n (aiPat 3)'
  sleep 15
  echo 'putStrLn "E2E RESETCYCLES"'; echo 'resetCycles'
  sleep 15
  echo 'putStrLn "E2E KILL9 (Conductor)"'; echo 'getState "ai/1/1" >>= print'
  sleep 8
  echo 'putStrLn "E2E STATE AFTER DEADMAN"'
  for n in 1 2 3 4 5 6 7 8; do echo "getState \"ai/1/$n\" >>= print"; done
  echo 'getState "ai/1/density" >>= print'
  sleep 2
  echo ':quit'
) | run ghci -v0 -ghci-script "$OUT/BootTidal.hs" > "$OUT/tidal.log" 2>&1 &
TIDAL=$!
for i in {1..90}; do grep -q "E2E TIDAL READY" "$OUT/tidal.log" && break; sleep 1; done
grep -q "E2E TIDAL READY" "$OUT/tidal.log" || { echo "Tidal did not become ready"; tail -20 "$OUT/tidal.log"; exit 1; }
echo "Tidal ready ($i s)"
sleep 3

# 3. preflight (SC up, Tidal up, nothing playing yet → the clock line is a warning, which is expected)
AI_SCLANG_PORT="$SC_PORT" pnpm -s preflight > "$OUT/preflight.log" 2>&1; PREFLIGHT=$?
echo "preflight exit=$PREFLIGHT"

# 4. Conductor (pool Brain, kickstart after 3 s), started as a bare node process so that $! is node itself
AI_SCLANG_PORT="$SC_PORT" AI_KICKSTART_MS=3000 "$NODE_BIN" --import ./scripts/env.mjs --import tsx src/conductor/run.ts \
  --manifest manifests/example.json > "$OUT/conductor.log" 2>&1 &
CONDUCTOR=$!
for i in {1..200}; do grep -q "E2E KILL9" "$OUT/tidal.log" && break; sleep 1; done
sleep 1
kill -9 "$CONDUCTOR" 2>/dev/null; sleep 0.5
if kill -0 "$CONDUCTOR" 2>/dev/null; then echo "CONDUCTOR STILL RUNNING"; else echo "killed the Conductor ($CONDUCTOR) at $(date +%T)"; fi
CONDUCTOR=""
wait "$TIDAL" 2>/dev/null; TIDAL=""
sleep 2
kill "$SC" 2>/dev/null; wait "$SC" 2>/dev/null; SC=""
[ -n "$SCSYNTH" ] && kill "$SCSYNTH" 2>/dev/null; SCSYNTH=""

# 5. verdict — every observation the scenario is meant to prove
ok=1
fail() { echo "MISSING: $1"; ok=0; }
after() { awk -v m="$1" -v n="$2" '$0 ~ m {f=1; c=0; next} f && c<n {print; c++}' "$3"; }   # n lines after the marker
[ "$PREFLIGHT" = 0 ] || fail "preflight exit 0 (got $PREFLIGHT)"
grep -q "kickstart — no clock after startup, applying" "$OUT/conductor.log" || fail "kickstart"
after "E2E STATE AFTER KICKSTART" 1 "$OUT/tidal.log" | grep -q 'Just "' || fail "slot 1 has a pattern after kickstart"
after "E2E STATE AFTER KICKSTART" 1 "$OUT/tidal.log" | grep -q 'Just "~"' && fail "slot 1 is not the rest after kickstart"
APPLIED=$(grep -c "plan applied @" "$OUT/conductor.log")
[ "$APPLIED" -ge 3 ] || fail "at least 3 quantized plans (got $APPLIED)"
grep -o "plan applied @[0-9-]*" "$OUT/conductor.log" | awk -F@ '$2 % 4 != 0 {bad=1} END {exit bad}' || fail "every plan applied at a multiple of 4 cycles"
awk '/pll=STALE\(/ {stale=1} /clock rewind detected/ {exit} stale && /plan applied @/ {found=1} END {exit !found}' "$OUT/conductor.log" || fail "a plan applied while extrapolating through the hush"
grep -q "pll=STALE" "$OUT/conductor.log" || fail "extrapolation through hush"
grep -q "clock rewind detected" "$OUT/conductor.log" || fail "resetCycles rewind"
awk '/clock rewind detected/ {r=1} r && /plan applied @/ {found=1} END {exit !found}' "$OUT/conductor.log" || fail "a plan applied after the rewind"
[ "$(grep -c "silenced channel 1" "$OUT/sc.log")" -ge 2 ] || fail "SC deadman fired (silenced channel 1 at load and after kill -9)"
[ "$(grep "E2E lt-events/2s:" "$OUT/sc.log" | tail -2 | grep -c ": 0$")" = 2 ] || fail "no lt events after the deadman"
[ "$(after "E2E STATE AFTER DEADMAN" 8 "$OUT/tidal.log" | grep -c 'Just "~"')" = 8 ] || fail "deadman cleared all 8 slots"
after "E2E STATE AFTER DEADMAN" 9 "$OUT/tidal.log" | tail -1 | grep -q 'Just 0.0' || fail "deadman zeroed density"
[ "$ok" = 1 ] && echo "E2E OK" || echo "E2E FAILED (see $OUT)"
[ "$ok" = 1 ]
