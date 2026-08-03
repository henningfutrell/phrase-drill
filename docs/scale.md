# Scale: what thousands of Phrases actually does (T032)

The library was designed and built against a personal-scale assumption
(dozens of Phrases). The real library is thousands. This note replaces that
assumption with numbers.

**Method.** `src/adapters/storage/scale.bench.test.ts` runs the *real*
`clip-cache.ts`, `indexed-db-deck-store.ts`, `library.ts`, and
`generation-queue.ts` code — unmodified — against the same in-memory `idb`
fake (`idb.test-support.ts`, `vi.mock('idb', ...)`) the rest of this repo's
adapter tests already use, at synthetic library sizes of 100, 1,000, 5,000,
and 10,000 Phrases (4–12 words each, 2 Clips/Phrase). No call to
`api.elevenlabs.io` was made or attempted.

Run it with:

```sh
RUN_SCALE_BENCH=1 npx vitest run src/adapters/storage/scale.bench.test.ts --reporter=verbose
```

It is gated behind `RUN_SCALE_BENCH=1` (`describe.skipIf`) and does not run
under plain `npm test`.

**Labels.** Every number below is one of:
- **measured** — real code path, real timer, run in this repo.
- **measured (fake)** — same, but against the in-memory `idb` fake, not real
  Safari disk-backed IndexedDB. That fake is a `Map`: `getAll()` returns
  array references with no structured-clone cost. These numbers are a floor
  for on-device latency, not a ceiling — see the caveat under §3.
- **modelled** — derived from a formula/constant already in this codebase,
  no I/O performed.
- **read from code** — a structural fact, not a number, established by
  reading the source.

## 1. Clip cache bytes (modelled)

Duration per Clip is modelled with the domain's own
`estimatePauseDuration` (`src/domain/cadence.ts`: 65 ms/character, clamped
to [1500, 5000] ms) — its own doc comment says the pause "scales with how
long the phrase takes to say," so it is already this codebase's model of
spoken duration, reused here rather than inventing a new constant. Bytes =
duration × 16 (`MP3_BYTES_PER_MS_AT_128KBPS`, `eleven-labs-synth-client.ts`,
128 kbps). The one real data point in that file's own comment — "a ~36 KB
response for a short French phrase," i.e. ~2,250 ms — sits inside this
model's clamped range, which is the corroboration available without a key.

| Phrases | Clip cache bytes (modelled) | ≈ |
|---:|---:|---|
| 100 | 9,209,200 | 8.8 MB |
| 1,000 | 90,543,760 | 86.4 MB |
| 5,000 | 445,346,080 | 424.7 MB |
| 10,000 | 889,010,240 | 847.8 MB |

~89 KB/Phrase (2 Clips). Linear, as expected — nothing amortizes.

## 2. Cold-fill cost

**Call count — read from code + measured.** `generateOne` (`generation-queue.ts`)
is called once per language per Phrase, unconditionally, whenever the Phrase
isn't already cached. `computeDrillReadiness` (`drill-readiness.ts` line
54) loops over **every** unready Phrase and calls `generationQueue.enqueue()`
synchronously, in one pass, for all of them — not batched, not paginated.

| Phrases | ElevenLabs calls (measured, matches 2n exactly) |
|---:|---:|
| 100 | 200 |
| 1,000 | 2,000 |
| 5,000 | 10,000 |
| 10,000 | 20,000 |

**Concurrency — measured, decisively.** `enqueue()` has no concurrency
limiter anywhere in the call chain (`generation-queue.ts`, `drill-readiness.ts`,
`main.tsx`, `App.tsx` — grepped, none exists). Proven, not just read: the
harness gives every call a synth client that **never resolves**, enqueues
the whole synthetic library, flushes the event loop, and counts how many
`synthesize()` calls were issued anyway. Result: **exactly 2n at every
size** (200/2,000/10,000/20,000) — every single call fires immediately,
none waits for another to finish. A throttled queue would have stayed near
its limit regardless of n; it did not.

**Wall-clock — modelled, not measured** (no key, no real request timing
available). Two plausible bottlenecks, in order of likely severity:

- **Provider concurrency/rate limits.** A personal ElevenLabs plan's
  concurrent-request limit is almost certainly far below "hundreds to tens
  of thousands of simultaneous connections." `429` maps to `SynthError.kind
  === 'quota'` in this codebase (`eleven-labs-synth-client.ts`), which
  `generation-queue.ts` **never retries** — it is a terminal, permanent
  failure for that Clip. A cold fill of even the 100-Phrase size (200
  simultaneous calls) is a plausible trigger for widespread, permanent
  `quota` failures on the very first drill-readiness sweep, before storage
  is even a factor. This is the most likely single point of breakage, and
  the smallest n at which it plausibly bites.
- **Safari per-host connection ceiling** (commonly ~6 concurrent
  connections to one host; not verified against this build) would serialize
  the rest into batches. At an assumed ~1.5 s/call (a plausible order of
  magnitude for a short TTS synthesis call — not measured, no basis to
  pick a tighter number):

  | Phrases | Calls | ÷6 batches | × 1.5 s | ≈ wall clock |
  |---:|---:|---:|---:|---|
  | 100 | 200 | 34 | 51 s | under a minute |
  | 1,000 | 2,000 | 334 | 500 s | ~8 min |
  | 5,000 | 10,000 | 1,667 | 2,500 s | ~42 min |
  | 10,000 | 20,000 | 3,334 | 5,000 s | ~83 min |

  This table assumes every call *succeeds*; the quota point above says that
  assumption is unlikely to hold at these fan-out levels, so treat this as
  a best-case floor, not a forecast.

## 3. IndexedDB write throughput (measured, against the fake — see caveat)

| Phrases | Save all decks, one at a time (ms) | `importAll` — one transaction (ms) | `readyPhraseIds`, cold cache (ms) | `readyPhraseIds`, warm cache (ms) | raw 2n-hash loop (ms) |
|---:|---:|---:|---:|---:|---:|
| 100 | 0.38 | 0.07 | 2.01 | 1.27 | 1.75 |
| 1,000 | 0.13 | 0.01 | 12.46 | 9.23 | 14.92 |
| 5,000 | 0.32 | 0.05 | 52.74 | 52.66 | 65.33 |
| 10,000 | 0.82 | 0.09 | 94.12 | 90.47 | 134.03 |

Deck save/import are near-instant against the fake — expected, it's a `Map`
write. **Not representative of real Safari IndexedDB**, which persists to
disk and has its own overhead; treat these two columns as a floor only.

**`readyPhraseIds` is the important row, and it is worse than the timings
above suggest.** Two findings, both read from code and confirmed by the
harness:

- **It hashes every Phrase, every drill start.** `readyPhraseIds`
  (`clip-cache.ts` lines 91–109) calls `computeClipHash` twice per Phrase —
  real SHA-256 via `crypto.subtle.digest`, unconditionally, for the whole
  set passed in. `computeDrillReadiness` calls it once per drill start
  (`drill-readiness.ts` line 48). At 10,000 Phrases that is 20,000 SHA-256
  digests — 94–134 ms in this harness's Node/V8; a phone's JS engine is
  typically slower, and this runs synchronously before the Drill screen can
  render anything.
- **It loads the *entire* clip store, not the Phrases being drilled.**
  `readyPhraseIds` unconditionally does `db.getAll(CLIPS_STORE)` (line 95)
  — every Clip in the whole cache — regardless of how many Phrases are
  passed in. Starting a Drill on a 10-Phrase Deck, in a library that has
  grown to 10,000 Phrases with a fully warm cache, still pulls the **whole**
  ~848 MB cache into memory first. The warm-cache timings above (90–101 ms,
  barely different from cold) do not show this cost, because the in-memory
  fake's `getAll()` is a reference-array copy with no structured-clone
  cost — real IndexedDB deserializes every stored `ArrayBuffer` off disk.
  **This is the harness's biggest blind spot**: the real on-device cost of
  `readyPhraseIds` at a large, warm cache could not be measured here, and
  is very likely materially worse than what this table shows.

## 4. Export file size (measured)

`exportAll` never touches the `clips` store (confirmed, `indexed-db-deck-store.ts`
line 66 only reads `DECKS_STORE`) — Clip bytes are excluded from every
export, by construction, regardless of library size.

| Phrases | Export bytes | ≈ | `exportAll` (ms) |
|---:|---:|---|---:|
| 100 | 12,759 | 12.5 KB | 0.018 |
| 1,000 | 126,711 | 123.7 KB | 0.004 |
| 5,000 | 630,928 | 616.3 KB | 0.005 |
| 10,000 | 1,261,205 | 1.2 MB | 0.024 |

~126 bytes/Phrase of JSON. Export stays small and fast at every size tested
— it is not on the list of things that break.

## 5. Read from code, not modelled or measured

- **Does the drill-start sweep enqueue every unready Phrase in one go?**
  Yes (`drill-readiness.ts` line 54, `for (const phrase of unready)
  deps.generationQueue.enqueue(phrase)` — synchronous loop, no batching, no
  cap). For a cold 10,000-Phrase library this fires 20,000 concurrent
  ElevenLabs calls in one pass (§2).
- **Does anything bound the clip cache size, or evict old Clips?** No.
  Read `clip-cache.ts`, `generation-queue.ts`, `database.ts` end to end:
  `put()` only ever overwrites a Clip stored under the *same* content
  hash (an edited Phrase or re-pinned voice orphans the old one, per the
  design intent in the code comments) — nothing ever deletes an orphaned
  Clip, nothing enforces a size cap, nothing runs an LRU sweep. The cache
  grows monotonically forever. State plainly: **there is no eviction path
  in this codebase.**
- **Is `computeClipHash` called per Phrase per drill start?** Yes, twice
  per Phrase, every time `readyPhraseIds` runs, every drill start (§3).

## What breaks first

Ranked by how small an n it takes to hit, and how automatic the trigger is:

1. **Cold-fill concurrency exhausting the ElevenLabs account limit —
   breaks first, at the smallest library.** 2n simultaneous, unthrottled
   calls (measured, exactly 2n at every size tested, down to n=100 → 200
   calls) almost certainly exceeds a personal-tier concurrency limit long
   before storage is a factor. `429` → `quota` is never retried
   (`generation-queue.ts`), so this is a **permanent** failure for whatever
   Clips lose the race, on the very first sweep — self-inflicted, and
   present even at scales well short of "thousands."
2. **Clip cache growth — no bound, no eviction, hundreds of MB by
   thousands of Phrases.** Modelled at 424.7 MB (5,000 Phrases) to 847.8 MB
   (10,000 Phrases; §1), with **nothing in the code that would ever shrink
   it** (§5). This is the storage-pressure risk the task named: at this
   size it is squarely in the range where iOS treats an origin's storage as
   evictable.
3. **`readyPhraseIds`' whole-cache `getAll()` — a self-compounding cost
   with #2.** Every drill start loads the *entire* clip cache (not just the
   Phrases in play) into memory and hashes the *entire* Phrase library
   passed to it. As #2 grows the cache, this sweep gets slower and heavier
   in lockstep, on every single drill start, for every Deck, however small.
   Measured hashing cost alone: 94–134 ms at 10,000 Phrases in Node; the
   full on-device cost including structured-clone of ~848 MB of Clips could
   not be measured here (§3) and is likely materially higher.
4. **Export/import — not a breaking point.** Stays small (1.2 MB at
   10,000 Phrases) and fast at every size tested, because Clips are
   structurally excluded.

## Assumptions and gaps, named plainly

- **Modelled, not measured:** Clip duration/bytes (§1), per-call ElevenLabs
  latency and Safari's per-host connection ceiling used for the wall-clock
  cold-fill estimate (§2). No ElevenLabs key was available or used.
- **Could not verify:** the real, on-device cost of `readyPhraseIds`
  against a large warm cache backed by actual Safari IndexedDB (structured
  clone of hundreds of MB) — the in-memory `idb` fake used throughout this
  harness does not model that cost, and is a known blind spot (§3).
  Likewise, real ElevenLabs concurrency/rate-limit behavior — the specific
  number where `quota` responses start — is asserted from the 429→`quota`
  code path, not observed against the live API.
- **Assumed:** phrase length distribution (4–12 words, French/English word
  lists built for this benchmark) — a stand-in for the real library's
  actual phrases, which were not available to this task.
