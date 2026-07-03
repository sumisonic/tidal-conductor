#!/usr/bin/env bash
# Run NDJSON pattern cases through the real Tidal parser: haskell/check-cases.sh [file...] (default: stdin)
#   pnpm emit-pattern-cases | haskell/check-cases.sh
#   haskell/check-cases.sh ghci/api-smoke.ndjson
set -euo pipefail
cd "$(dirname "$0")/.."
cat "${@:--}" | haskell/with-tidal.sh runghc haskell/ParseBPCheck.hs
