#!/usr/bin/env bash
# Run a command with a GHC that has the tidal package. Uses `nix develop` on this repo's flake when
# Nix is available (the reproducible route, with the lock file frozen), otherwise whatever
# ghc/ghci/runghc is on PATH. Set NIX_FLAKE to use another flake, or WITH_TIDAL=path to skip Nix
# explicitly. There is deliberately no automatic fallback from a broken Nix to PATH: that would
# silently test a different Tidal than the pinned one.
set -euo pipefail
if [ "${WITH_TIDAL:-}" = "path" ] || ! command -v nix >/dev/null 2>&1; then
  exec "$@"
fi
flake="${NIX_FLAKE:-$(dirname "$0")/..}"
# Probe the Nix route first so that a broken Nix is reported as such (a failing command keeps its own exit code)
if ! nix develop --no-update-lock-file "$flake" -c true; then
  echo "with-tidal.sh: \`nix develop $flake\` does not work here. Fix Nix (daemon, flakes, network), or set" >&2
  echo "  WITH_TIDAL=path only if the GHC/Tidal on PATH is deliberately the version you want to test." >&2
  exit 2
fi
exec nix develop --no-update-lock-file "$flake" -c "$@"
