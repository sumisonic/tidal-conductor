{
  description = "tidal-conductor — GHC + TidalCycles for the pattern verification harness";

  # The pin that matters for reproducibility is flake.lock (the nixpkgs commit), not the branch name.
  # Expected: Tidal 1.10.1 / GHC 9.10.x. The assertions below fail the evaluation if a lock update
  # silently moves either version; bump them deliberately together with the lock.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # An explicit GHC package set rather than the floating `haskellPackages` alias
        hs = pkgs.haskell.packages.ghc910;
        expectedTidal = "1.10.1";
        tidal = hs.tidal;
        ghcWithTidal =
          assert pkgs.lib.assertMsg (tidal.version == expectedTidal)
            "tidal ${tidal.version} in nixpkgs, expected ${expectedTidal} (update the assertion and the docs together)";
          hs.ghcWithPackages (p: [ p.tidal ]);
      in {
        devShells.default = pkgs.mkShell {
          name = "tidal-conductor";
          buildInputs = [ ghcWithTidal ];
          # stderr, so that `$(nix develop -c ghc-pkg ...)` style substitutions stay clean
          shellHook = ''
            echo "tidal-conductor: GHC $(ghc --numeric-version), tidal ${tidal.version}" >&2
          '';
        };

        # `nix flake check` builds these. They only need the committed sources (no pnpm):
        checks = {
          # aiPat specification against integration/tidal/Conductor.tidal (State injection tests)
          aipat-spec = pkgs.runCommand "aipat-spec" { buildInputs = [ ghcWithTidal ]; } ''
            cd ${self}
            export HOME=$TMPDIR
            printf ':script integration/tidal/Conductor.tidal\n:script haskell/AiPatSpec.tidal\n' \
              | ghci -v0 -ghci-script "$(ghc-pkg field tidal data-dir | sed 's/data-dir: //')/BootTidal.hs" | tee $TMPDIR/out
            grep -q '^AIPAT SPEC OK$' $TMPDIR/out
            mkdir -p $out && cp $TMPDIR/out $out/aipat-spec.log
          '';
          # Fixed pattern cases (haskell/fixtures/*.ndjson) through the real parseBP
          parsebp-fixtures = pkgs.runCommand "parsebp-fixtures" { buildInputs = [ ghcWithTidal ]; } ''
            cd ${self}
            export HOME=$TMPDIR
            cat haskell/fixtures/*.ndjson | runghc haskell/ParseBPCheck.hs | tee $TMPDIR/out
            grep -q '^ALL OK' $TMPDIR/out
            mkdir -p $out && cp $TMPDIR/out $out/parsebp-fixtures.log
          '';
        };
      });
}
