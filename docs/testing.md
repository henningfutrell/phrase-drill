# Testing

Two gates, answering two different questions.

| Command | Question it answers | Runtime |
|---|---|---|
| `npm test` | does the app do what the tests say? | ~4s |
| `npm run test:mutation` | do the tests notice when the domain stops doing it? | ~15s |

`npm test` must exit 0 before a change lands (AGENTS.md). The mutation gate is
not on that path — run it when you change `src/domain/`.

## Why a mutation gate

Line coverage says a line ran. It cannot say anything ran *because of* it.
A test that calls `buildCadence()` and asserts only that it returned an array
covers every line in the file and would not notice if the pause durations were
all set to zero.

Stryker answers the harder question by breaking the code on purpose. It makes
small edits — `>=` becomes `>`, `+= 1` becomes `-= 1`, a string becomes `""` —
and re-runs the tests against each one. An edit the suite catches is a
**killed** mutant. An edit that leaves every test green is a **survivor**, and
a survivor is a precise, located statement that some behaviour of the domain is
not actually pinned by anything.

This matters here more than in most apps of this size. The user is
non-technical and in another country. A domain regression does not surface as a
stack trace she can send — it surfaces as a drill that feels subtly wrong, or
does not, and neither of us finds out.

## Running it

```sh
npm run test:mutation          # full run, writes reports/mutation/index.html
npx stryker run --mutate src/domain/shuffle.ts   # one file, while iterating
```

Open `reports/mutation/index.html` to read survivors in context — it shows each
mutant inline in the source, which the terminal output cannot.

## What is in scope, and what is not

`stryker.config.json` mutates `src/domain/**` only.

The domain is the whole of the app's behaviour that is worth pinning this hard:
it is pure, it has no I/O, and it is the part whose silent breakage is
undetectable from the outside. Adapters are thin wrappers around a browser API
— mutating them mostly produces mutants killed by the wrapper's own mock, which
proves the mock works and nothing else. React screens produce large numbers of
survivors in markup that no reasonable test asserts on.

The **tests** it runs are the whole suite, minus `pwa.build.test.ts` (see
`vitest.mutation.config.ts` — that file shells out to a real `npm run build`,
and once per mutant it is hours). Adapter and screen tests stay in, because
`coverageAnalysis: "perTest"` runs only the tests that touch each mutant, so
they cost almost nothing and they legitimately kill domain mutants. Restricting
the run to `src/domain/*.test.ts` would be faster and would report survivors
that are already dead.

## The threshold is a ratchet

`thresholds.break` is **95**. The rule: **raise it as survivors are killed,
never lower it.** If a change drops the score, it either needs a test or the
argument for lowering has to be made explicitly in the commit message.

| Date | break | Measured | Why |
|---|---|---|---|
| 2026-08-02 | 82 | 82.74% | the baseline the gate arrived at |
| 2026-08-03 | 95 | 100.00% | T044/T045 killed every survivor |
| 2026-08-03 | 95 | 100.00% | T060 added `library-merge.ts`; 63 new mutants, all killed |

It is deliberately **not 100**, even though the domain measures 100.00% over
three runs. Four to five of the 151 mutants are killed by *timeout*, and a
timeout is a wall-clock judgement rather than a property of the code — the
killed/timeout split moved between runs on the same machine (146/5, 147/4). A
machine faster than the one measured here could let one of those mutants
complete instead of timing out, at which point it might survive, and a
threshold of 100 would fail a build containing no defect. 95 absorbs one such
flip and still fails loudly on a real regression.

A gate set above the real score is a gate that is red on arrival, and a red
gate nobody can turn green gets bypassed within a week.

`mutation.config.test.ts` asserts the gate's contract — that the scope resolves
to real domain files, that `break` is set to something greater than zero, and
that the npm script exists. It deliberately does not assert the score. Its job
is to stop the gate quietly becoming decoration: a scope that matches nothing
reports 100%, and a `break` of `null` reports a score and exits 0 regardless.

## Current state (2026-08-03)

**100.00%** — 151 mutants, 0 survived, 0 uncovered, across all seven domain
files. The 26 survivors and 3 uncovered mutants the gate found on arrival were
closed by T044 and T045.

Read that number with one qualification. Of the 29, **twelve were killed by new
tests** and **seventeen were suppressed** as equivalent mutants — changes that
cannot alter observable behaviour, so no test can kill them and demanding one
would only produce a test asserting an implementation detail. Suppression
removes a mutant from the denominator, so 100.00% over 151 mutants is not the
same claim as 100.00% over 168.

Every suppression is a `// Stryker disable next-line <Mutator>: <reason>`
comment in `src/domain/drill-player.ts` carrying its own argument, and each was
checked against the source before it was accepted. They fall into four groups:

- **`generation` (2)** — `+= 1` versus `-= 1`. The counter is read only through
  an equality check against a snapshot taken at loop-iteration start, so any
  injective change is indistinguishable.
- **`pause()`'s `stepAbort?.abort()` (1)** — the null branch is unreachable.
  Reaching the line requires `_status === 'playing'`, and status only becomes
  `'playing'` inside a synchronous stretch that assigns `stepAbort`, with no
  yield point an external `pause()` could land in.
- **`wasPlaying` and its `if` (6)** — see the finding below.
- **`runLoop`'s while-condition and post-loop check (8)** — both are redundant
  with the loop body's own `break`. At the post-loop check the two operands are
  always equal in truth value, so `&&`, `||`, and either clause pinned to
  `true` all decide the same thing.

If you add a `// Stryker disable` comment, it needs an argument of this kind in
the comment itself. A disable without one is indistinguishable from hiding a
missing test, and it is the one way this gate can quietly stop meaning
anything.

## Open finding: `drill-player.ts:125` is dead code

`if (wasPlaying) await this.runLoop()` in `skip()` cannot affect anything, and
this is what six of the suppressions above are really saying.

When `skip()` is called during playback, the outer `runLoop` is still on the
stack awaiting a step, so `running` is `true` and the nested call returns
immediately at its re-entrancy guard. When `skip()` is called while paused,
`wasPlaying` is false — and had it been true, `runLoop`'s own while-condition
would have found `_status !== 'playing'` and done nothing. Both branches are
no-ops, which is why no mutation of `wasPlaying` is observable. Playback
continues after a skip because the *outer* loop carries on, not because of this
line.

The same pattern covers the `runLoop` suppressions: several defensive checks
there are made redundant by the `running` flag and the inner `break`. None of
it is wrong. But a future reader cannot tell "redundant by design" from
"redundant by accident" without redoing this analysis, which is the actual
cost. A deliberate simplification pass is worth doing separately — not folded
into a testing change, and not while the drill's interruption behaviour is
still unverified on a real device.
