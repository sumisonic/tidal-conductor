# Manifests

A manifest tells the Conductor what to generate: which slots exist, what each one is for, and
which values are allowed. It is fixed when the Conductor starts (`pnpm conductor --manifest
<file>`). The schema lives in `src/conductor/manifest.ts`; unknown fields are rejected.

```json
{
  "id": "example",
  "name": "Example: two struct slots + one nsteps slot",
  "defaultLengthCycles": 4,
  "slots": [
    { "slot": 1, "generator": "struct", "role": "perc (low tom) — sparse to medium euclid or grid" },
    { "slot": 2, "generator": "struct", "role": "hat (closed hi-hat) — 16th-note feel, leaning on the offbeats" },
    { "slot": 3, "generator": "nsteps", "role": "hat sample selection (paired with slot 2)", "nRange": [0, 7] }
  ]
}
```

| field                 | required | meaning                                                                                                                                                       |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | yes      | Stable identifier, `[a-z0-9][a-z0-9-]*`. Keys the persistent veto/mark memory (`plans/feedback.json`), so keep it when you rename the manifest.                |
| `name`                | no       | Display name.                                                                                                                                                 |
| `style`               | no       | One sentence of style guidance for the LLM Brains (ignored by `pool` and `offline`).                                                                          |
| `defaultLengthCycles` | yes      | Phrase length in cycles: 1, 2, 4 or 8. Plans are applied at multiples of it.                                                                                  |
| `allowTransition`     | no       | Whether the Brain may put an announced fill into the last cycle of a phrase. Default true.                                                                    |
| `slots`               | yes      | 1 to 8 slot declarations.                                                                                                                                     |

Each slot:

| field       | applies to        | meaning                                                                                                                                                                 |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slot`      | all               | 1..8. Read in Tidal as `aiPat <slot>`.                                                                                                                                  |
| `generator` | all               | `struct`: a rhythm (`t`/`~`) for `struct (aiPat n)`. `nsteps`: a sequence of integers for `# n (aiPat n)`. `samples`: a sequence of sample names for `s (aiPat n)`.        |
| `role`      | all               | What the slot is for, in words. The Brains read it as a hint. The pool also matches whole words in it against its role tags: `kick`/`bd`, `snare`/`sn`/`sd`, `hat`/`hh`/`hi-hat`, `perc`/`percussion`, `bass`, `stab`/`chord`, `noise`. |
| `nRange`    | `nsteps` (one of the two is required) | `[min, max]` of the allowed indexes (0..127), in that order.                                                                        |
| `nSet`      | `nsteps` (one of the two is required) | An explicit list of allowed indexes (1 to 16 of them).                                                                                             |
| `vocab`     | `samples` (required) | The sample names the slot may use (1 to 64), each matching `^[A-Za-z][A-Za-z0-9_]*(:\d{1,3})?$` (letters, digits, `_`, an optional `:index`; no hyphens). Plans refer to them by index; the LLM never writes names. |

Notes:

- An `nsteps` slot declares its values with exactly one of `nRange` / `nSet`; there is no
  implicit default, and the keys are rejected on `struct` and `samples` slots. Every Brain's
  output is checked against the declaration, and a value outside it makes the plan fall back to
  the next Brain.

- Slots numbers do not have to be contiguous, but every slot you declare is written every
  phrase (missing ones as `~`), and slots you do not declare are never written.
- `vocab` names are never checked against your sample bank: a name SuperDirt does not have plays
  nothing and only logs `no synth or sample named ...`. The examples use standard Dirt-Samples
  names (`bd`, `sn`, `hh`, `perc`); `smoke-kit.json` and `smoke-alt.json` are small manifests for
  checking the wiring.
- A manifest with only `struct` slots works with every Brain. `nsteps` and `samples` slots are
  filled by the offline rules when the pool has nothing for them.
