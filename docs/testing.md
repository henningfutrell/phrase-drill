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

`thresholds.break` is **82**, set at the measured baseline of 82.74% (stable
across three runs, 2026-08-02). It is not an aspiration — a gate set above the
real score is a gate that is red on arrival, and a red gate nobody can turn
green gets bypassed within a week.

The rule: **raise it as survivors are killed, never lower it.** If a change
drops the score, the change either needs a test or the threshold argument needs
to be made explicitly in the commit message. The 0.74 of slack exists because
five mutants are killed by timeout, and a timeout is a wall-clock judgement
rather than a deterministic one.

`mutation.config.test.ts` asserts the gate's contract — that the scope resolves
to real domain files, that `break` is set to something greater than zero, and
that the npm script exists. It deliberately does not assert the score. Its job
is to stop the gate quietly becoming decoration: a scope that matches nothing
reports 100%, and a `break` of `null` reports a score and exits 0 regardless.

## Baseline survivors (2026-08-02)

26 survivors, 3 uncovered, at 82.74%. Four clusters, in the order they are
worth killing:

1. **`drill-player.ts` control paths (20).** `pause`/`resume`/`stop` and the
   `generation` counter that invalidates a stale run loop. `this.generation
   += 1` survives being flipped to `-= 1` in two places, and `if (this._status
   !== 'stopped') return` survives being disabled entirely — so the re-entrancy
   guard on `start()` and the stale-loop guard are both unpinned. This is the
   code that decides what happens when a screen lock interrupts a drill, which
   T015 designed as a first-class state.
2. **`step-runner.ts` abort handling (4).** The already-aborted-on-entry branch
   survives being disabled, and `{ once: true }` survives becoming
   `{ once: false }` — the listener-leak guarantee is not tested.
3. **`shuffle.ts` index arithmetic (2).** `Math.floor(random.next() * (i + 1))`
   survives both `*` → `/` and `i + 1` → `i - 1`. A Fisher-Yates with the wrong
   index range still returns a shuffled-looking deck; it is just not uniform.
   Nothing currently distinguishes the two.
4. **3 uncovered mutants** in `drill-player.ts` and `step-runner.ts` — code no
   test reaches at all.
