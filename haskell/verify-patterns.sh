#!/usr/bin/env bash
# Generate the pattern cases with TypeScript and check them with the fixed Haskell runner (pnpm verify:patterns).
# pipefail: a generator that dies half-way must fail the whole verification, not just shorten it.
# The runner also refuses an empty input, so the two ends of the pipe are closed independently.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm -s emit-pattern-cases | haskell/check-cases.sh
