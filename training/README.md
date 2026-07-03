# training/ — recipe for a local Brain (LoRA fine-tune)

This directory is a **recipe**, not a model. tidal-conductor does not distribute any model or
LoRA weights, and no public model is currently qualified for real-time use. What you get here is
the pipeline the author used to build a 1.5B-class local Brain for their own sets; the same steps
produce a model tuned to *your* manifests. The default Brain (pool) needs none of this.

**Status.** The author has run this recipe only with an earlier version of the prompts (written in
Japanese) and only on Google Colab (L4). Nobody has run it with the English prompts in this
repository yet; the pass thresholds in Step 6 come from those earlier runs, and the "own CUDA
machine" path in Step 4 is the same notebook with different paths, not a separately tested
procedure. Treat all of it as a starting point, not a verified procedure. Reports are welcome.

```
Step 1 generate data (teacher API, 1–2 h) → Step 2 parseBP gate (minutes)
  → Step 3 build train/valid (seconds) → Step 4 LoRA training (Colab or a CUDA GPU, 20–30 min)
  → Step 5 deploy to Ollama (minutes) → Step 6 fixed harness (15 min)
```

Generated files (`data/`, `adapters/`, `fused/`) are all gitignored. `data/raw.jsonl` is the
source of truth; everything downstream can be rebuilt from it at any time.

## What the model learns (and what it does not)

- Input: exactly the prompt the local Brain sends in production (`SYSTEM_PROMPT + LOCAL_EXTRA_RULES
  + veto block + mark block` as the system message, `buildPrompt(ctx)` as the user message).
  The training data is built from the same constants, so the prompt at training time matches
  inference. **If you change the prompt constants, retrain.**
- Output: a plan JSON that passes the schema, the manifest consistency check and the parseBP gate.
- Contexts are sampled from your manifests (40%) and synthetic manifests (60%); the synthetic
  ones exist so the model reads the slot declarations instead of memorizing a layout.
- The contents of veto/mark lists are *not* learned (they are manifest-specific and injected at
  runtime); only the behavior "follow the list when present" is.

## Prerequisites

- Node 22 + pnpm 10 (`mise install`, or your own) and `pnpm install` done; a teacher API key in `.env` (see `.env.example`)
- GHC with the `tidal` package for the parseBP gate: `nix develop` on this repository provides it (or put a suitable ghc on PATH)
- `ollama serve` running (Step 5 onwards)
- A GPU for Step 4: Google Colab (L4 recommended, T4 works) or your own machine with a CUDA GPU
  (batch 16 assumes about 24 GB; halve it on smaller cards). Apple Silicon (MLX) is not covered

## Step 1: generate data (teacher = gemini-2.5-flash by default)

**Archive the previous generation before regenerating across a prompt change** (do not mix
distributions):

```sh
mv training/data/raw.jsonl training/data/raw-r1.jsonl   # name the old generation
```

```sh
pnpm gen-training-data 4500 google        # ordinary samples (the bulk)
pnpm gen-training-data 1300 google hard   # hard cases (aim for 15–25% of the total)
pnpm gen-training-data 500 anthropic      # optional: teacher diversity (run sequentially!)
```

- **One invocation is enough**: every success is appended to `data/raw.jsonl` as it happens
  (checkpointing — rerunning the same command after an interruption continues from the last
  index of the same seed, so failures do not cause duplicates)
- **Do not run two generators in parallel**: they would claim the same index range
- **`hard` mode**: the model's favorite shapes × avoid list × transition, 75% direct hits and 25%
  contrast examples ("allowed when not on the list"). The teacher runs in strict-avoid mode
  (a vetoed transition is rejected outright so that "omit the fill" never becomes an example)
- Failures labeled "avoid violation" or "manifest mismatch" are normal (rejection protects the
  training set). **Report if the failure rate exceeds 30%**
- Mind the provider quota; one generation plus retries can use most of a day's allowance
- Cost: a few dollars for 4,500 samples with gemini-2.5-flash
- If `sessions/*.jsonl` exist, their measured desire values seed the desire distribution
- `AI_TRAIN_MANIFESTS_DIR` points at another manifest directory; manifests whose id starts with
  `smoke-` are excluded (they are test fixtures)

## Step 2: parseBP gate

```sh
set -o pipefail   # a failing check must not be masked by tee
haskell/check-cases.sh training/data/cases.ndjson | tee training/data/check.log
```

- `ALL OK` → Step 3
- FAIL lines do not stop you: pass `check.log` to Step 3 and the offending samples are dropped
  (a FAIL is also a hole in the safety net — include the lines in your report)

## Step 3: build train/valid + diversity check

```sh
pnpm build-dataset                                # when the gate was ALL OK
pnpm build-dataset 0.05 training/data/check.log   # when there were FAIL lines
```

Produces `data/train.jsonl`, `data/valid.jsonl`, `data/metrics.json`. Sanity-check the metrics
(stop and investigate if they are far off): pattern-type distribution (samples not starved),
`likedRate` ≈ 0.4, `syntheticManifestRate` ≈ 0.6, `avoidRate` ≈ 0.55 for ordinary samples alone and
about 0.6 or more once the hard set is in (the sampler's nominal mix; the teacher's rejections
shift it, and these figures come from the author's earlier runs).

## Step 4: LoRA training (Colab or a CUDA machine)

The notebook `training/colab_train.ipynb` is the same for both; only where the data comes from
and where the outputs go differs (a configuration cell near the top, overridable with
`TC_DATA_DIR` / `TC_OUT_DIR`).

**Colab.** Data goes in and out through Google Drive; open the notebook from GitHub so you
always train with the committed version:

1. Put the data on Drive: copy `training/data/{train,valid}.jsonl` into a folder of your choice
   (the notebook defaults to `tidal-conductor/data/` in My Drive).
2. Open `training/colab_train.ipynb` in Colab via **File → Open notebook → GitHub** from your
   fork or clone. Edits made in Colab do not flow back to the repository.

**Own machine.** `pip install unsloth jupyter` in a Python 3.12 environment (`training/mise.toml`
pins the interpreter; use any environment manager you like), start Jupyter from the `training/`
directory and open the notebook. It reads `data/{train,valid}.jsonl` and writes to `fused/`.

Either way:

3. Runtime → GPU (L4 recommended). **Run all cells once, top to bottom, on a fresh runtime**:
   - calling the export cell twice on the same runtime produces a GGUF **without the LoRA**
     (observed on hardware); redo the whole runtime instead
   - the asserts in the model-setup cell (chat-template markers / no thinking block / training
     text) stop template accidents before training
   - check that the loaded train/valid counts match Step 3 (if not, Drive has not synced yet)
4. Eyeball the smoke cell (one generation from valid): it must look like a plan JSON.
5. The last cell saves `<SAVE_NAME>.Q4_K_M.gguf` and a production-ready `Modelfile-<SAVE_NAME>`
   (temperature 0.6 / num_ctx 4096 / FROM rewritten) to Drive, or to `training/fused/` on your
   own machine.

## Step 5: deploy to Ollama

On Colab, copy the two files from Drive into `training/fused/` (on your own machine they are
already there), then:

```sh
cd training/fused
M=tidal-conductor-1.5b-r1        # the SAVE_NAME from the notebook
ollama create "$M" -f "Modelfile-$M"
```

The Modelfile needs no editing (the notebook already applied the production settings).

## Step 6: fixed harness (compare new and old under identical conditions)

**Close the browser first** (GPU contention breaks the latency judgement), then for each model:

```sh
M=tidal-conductor-1.5b-r1        # the model name in Ollama
AI_LOCAL_MODEL="$M" pnpm api-smoke local 10                                                      # (1) baseline layout
AI_SMOKE_MANIFEST=manifests/smoke-alt.json AI_LOCAL_MODEL="$M" pnpm api-smoke local 10           # (2) unseen layout (memorization check)
AI_SMOKE_AVOID='t(3,8);t ~ t ~ t ~ t ~;0 1 0 ~ 2 3 0 ~ 4 5 ~ 6 ~ 7 6;t(5,16,<0 8>)' \
  AI_LOCAL_MODEL="$M" pnpm api-smoke local 20                                                    # (3) veto compliance
AI_SMOKE_MANIFEST=manifests/smoke-kit.json AI_LOCAL_MODEL="$M" pnpm api-smoke local 20           # (4) samples / nSet
```

Then the parseBP check of the smoke output: `haskell/check-cases.sh ghci/api-smoke.ndjson`

What to look at (out-of-range values are already zero thanks to grammar enforcement, so the
metrics are about how rarely plans get discarded or degraded):

- (1)(2) consistent 9/10 or better, (4) 19/20 or better, parseBP ALL OK. These thresholds were
  measured on the author's earlier models, trained with different prompts: treat them as a
  starting point, not a guarantee
- (3) the sum of "discarded for avoid violation" and "partial degradation" (lower = better raw
  compliance = more AI phrases survive live)
- latency median ≤ 4.5 s (the first round is a cold load — use the second run)

**Adoption**: switch when the new model is at least as good on every gate and no slower.

The judgement above is manual for now: `api-smoke` prints one line per round plus the discard / partial-degradation
warnings, and its exit code is 0 only when every round succeeded (a 9/10 result exits non-zero). A structured tally
with pass criteria is not implemented.

## Before a live set (every time)

Close the browser and run once:

```sh
AI_LOCAL_MODEL=tidal-conductor-1.5b-r1 pnpm api-smoke local 10
```

Warm-up and measurement in one: confirm **median ≤ 4.5 s** (about 3 s when healthy).

## Changing the base model

- A better benchmark does not mean a better measured result (a 1.7B model with the best
  instruction-following benchmark lost on schema failures and latency). Assume checkpoint
  variance and **always compare against the previous generation on the fixed harness**.
- Bases with a "thinking" mechanism are the biggest template risk. The notebook's asserts and
  `strip_think` defend against it, but eyeball the probe output whenever you switch families.

## Report format

Paste these after a run and the next decision can be made without further context:

1. The last line of Step 1 (successes/failures) and the failure breakdown, if any
2. The essentials of `data/metrics.json` (likedRate / avoidRate / syntheticManifestRate / sample count)
3. Step 4's final train loss / val loss (last lines of the log) and the "Num examples" line
4. Step 6's api-smoke output (new and old) and the parseBP check result (ALL OK / FAIL)

## Troubleshooting

- **gen-training-data stops on a quota error**: the provider's daily limit; rerun the same command
  after the reset and it continues
- **gen-training-data exits with "key not set"**: put the key in `.env` next to package.json
  (loaded automatically) or export it in the shell
- **Colab loads stale data**: you mounted Drive before it synced; recreate the runtime and retry
- **Stalled GGUF download/export**: interrupt the cell and rerun it to resume; but redo the
  export on a **fresh runtime** (a second export loses the LoRA)
- **api-smoke is only slow on round 1**: cold load; use the second run
- **Consistent but slow generation (~30 tok/s)**: GPU contention. Close browsers and anything
  that draws continuously; compare against a plain small model under the same conditions
- **Consistent but monotonous patterns (many duplicates)**: raise the Modelfile temperature from
  0.6 to 0.8 and re-measure; the structure is baked in and survives a higher temperature
- **The model keeps writing one value (e.g. 7)**: a value-range bias in the data. Grammar
  enforcement contains the damage; the real fix is boundary diversity in the data
- **Behavior differs across Ollama versions**: include `ollama --version` in reports
