#!/usr/bin/env bash
# Run haskell/AiPatSpec.tidal against integration/tidal/Conductor.tidal in a GHCi that has the
# tidal package, using the BootTidal.hs shipped with the package (plain Tidal, no custom boot).
# GHCi swallows exit codes raised inside :script, so the verdict is the "AIPAT SPEC OK" marker.
set -euo pipefail
cd "$(dirname "$0")/.."
with="haskell/with-tidal.sh"
boot="$("$with" bash -c 'ghc-pkg field tidal data-dir | sed "s/data-dir: //"' | tail -n1)/BootTidal.hs"
[ -f "$boot" ] || { echo "BootTidal.hs not found in the tidal package data dir ($boot)" >&2; exit 2; }
out="$(mktemp)"
printf ':script integration/tidal/Conductor.tidal\n:script haskell/AiPatSpec.tidal\n' | "$with" ghci -v0 -ghci-script "$boot" 2>&1 | tee "$out"
grep -q '^AIPAT SPEC OK$' "$out"
