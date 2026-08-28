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
stack trace the user can send — it surfaces as a drill that feels subtly wrong, or
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
| 2026-08-28 | 95 | 100.00% | Passage/Line/Statement landed; 607 mutants, all killed |

It is deliberately **not 100**, even though the domain has measured 100.00% on
every run since. Some mutants are killed by *timeout* — 24 of the 607 in the
current run, four to five of the 151 in the first — and a timeout is a
wall-clock judgement rather than a property of the code: the killed/timeout
split moved between runs on the same machine at the original size (146/5,
147/4). A machine faster than the one measured here could let one of those
mutants complete instead of timing out, at which point it might survive, and a
threshold of 100 would fail a build containing no defect. 95 absorbs one such
flip and still fails loudly on a real regression.

A gate set above the real score is a gate that is red on arrival, and a red
gate nobody can turn green gets bypassed within a week.

`mutation.config.test.ts` asserts the gate's contract — that the scope resolves
to real domain files, that `break` is set to something greater than zero, and
that the npm script exists. It deliberately does not assert the score. Its job
is to stop the gate quietly becoming decoration: a scope that matches nothing
reports 100%, and a `break` of `null` reports a score and exits 0 regardless.

## Current state (2026-08-28)

**100.00%** — **607 mutants, 0 survived**: 583 killed outright, 24 killed by
timeout, 0 uncovered, across every file in `src/domain/`.

Up from 151 at the T044/T045 baseline, in two steps: `library-merge.ts` (T060,
63 mutants), and then the Passage work, which added `passage.ts`, `line.ts` and
`statement.ts` as domain files and widened `rep.ts`, `cadence.ts` and
`drill-player.ts` — a Rep now carries N Statements rather than one Phrase, and
`cadence.ts` carries the Line Cadence and `PASSAGE_PAUSE_MAX_MS` beside the
Phrase's.

Read that number with one qualification, carried from the 151-mutant run and
still true. Of the 29 findings the gate arrived with, **twelve were killed by
new tests** and **seventeen were suppressed** as equivalent mutants — changes
that cannot alter observable behaviour, so no test can kill them and demanding
one would only produce a test asserting an implementation detail. Suppression
removes a mutant from the denominator, so a score is over the mutants Stryker
was allowed to make, not over every edit it could have made.

Every suppression is a `// Stryker disable next-line <Mutator>: <reason>`
comment carrying its own argument, and each was checked against the source
before it was accepted. Seven are in `src/domain/drill-player.ts`, in four
groups:

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

One more sits in `src/domain/library-merge.ts:531` — `>` versus `>=` when two
Tombstones under one `kind:id` compare equal on `deletedAt`. A Tombstone is
exactly `{kind, id, deletedAt}`, so two that tie are structurally identical and
the map holds the same value whichever the tie keeps.

If you add a `// Stryker disable` comment, it needs an argument of this kind in
the comment itself. A disable without one is indistinguishable from hiding a
missing test, and it is the one way this gate can quietly stop meaning
anything.

## A worked survivor: a conflict rule tested in one direction

The best example this file has of reading a survivor, because the test that
missed it looked complete.

`reconcilePassage` (`src/domain/library-merge.ts`) decides a Passage conflict:
baseline first, then the later `updatedAt`. Its `if (!localChanged)` guard
**survived** mutation to `if (true)`.

A mutant that survives is not a hole in coverage — the guard was covered. The
hole was the direction. The only both-sides-changed test had the **remote** copy
as the later write, so `if (true)` returned `remote`, and the assertion wanted
`remote` anyway. The mutant is exactly the defect of taking the other device's
text whenever both sides edited, whichever write is later: a page the user typed on
this phone, replaced by an older page from the other one, silently. A test
asserting the right answer for the wrong reason cannot see it.

Killed by adding the mirror — both changed, **local** later — and a both-changed
tie, which pins "a tie keeps local" as well. Three cases where there was one.

**The lesson, worth more than the fix: a conflict-resolution rule tested in only
one direction is not tested.** Whenever a rule picks between two sides, the
suite needs each side winning, and the tie. Otherwise one assertion is doing the
work of the rule and of a coin toss at once, and mutation is the only thing that
will tell you which.

## Two hand checks the gate cannot do for you

Both were used in the Passage work, where the automated gates could not reach.

- **Hand-apply the mutant and re-run one file.** A full `npm run test:mutation`
  is too slow to iterate against while you are writing the test that kills a
  survivor. Make the mutant's edit in the source by hand, run only the affected
  test file, and watch it stay green — that is the survivor reproduced in about
  a second. Then write the test, watch it go red, and undo the edit. Confirm
  with the real run once, at the end; `npx stryker run --mutate <one file>` is
  the middle option.
- **Grep for a renamed symbol; `tsc -b` is not a blast-radius oracle here.**
  `tsconfig` excludes `src/**/*.integration.test.ts`, so a rename that breaks an
  integration test compiles clean and a green type-check proves nothing about
  the callers it did not read. The Passage work renamed the Rep builder into two
  (`rep.ts`) and the clip cache's readiness sweep (`clip-cache.ts`), and in both
  cases the surviving references were in files the type-check never opened —
  integration tests and this `docs/` tree. So after a rename, grep the whole
  tree for the old name and expect zero hits. The type checker answers a
  narrower question than the one you are asking.

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
