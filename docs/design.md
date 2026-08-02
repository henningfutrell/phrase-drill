# Interface design — screen inventory and visual direction

Design only. No application code changes; `src/` is untouched. Reference mockups
live in `docs/design-notes/`.

Process note: this was designed with the `impeccable` skill against the **product**
register (Operate mode — she is completing a task, not being persuaded or shown
something). No interactive answer channel exists in this session (unattended design
task, no human to interview), so the skill's normal interview and decision-page
rounds were replaced with direct inference from the domain model and iOS-speech
notes, disclosed here rather than silently skipped. `PRODUCT.md` at the repo root
records what was inferred and flags it as such.

Every term below is the glossary's: Phrase, Deck, Cadence, Step, Rep, Drill,
Shuffle, Mix, Scan, Draft Phrase. No synonyms.

---

## 1. Visual direction

### The world: a four-beat metronome, not a flashcard deck

**Cadence** is a music word for a reason — FR·pause·FR·pause·EN·pause·FR·pause is a
fixed four-beat bar repeated once per Phrase. That is the one idea this design
commits to: the Drill's state is shown as a **beat**, not as text to read. A row of
four marks lights up one at a time in time with playback; she reads it the way a
musician reads a metronome, in her peripheral vision, without focusing on it. This
is deliberately not the flashcard/index-card visual language — no card flip, no
front/back, no stack-of-cards affordance anywhere — because the domain model
explicitly refuses the Anki-deck reading (T002, "Is not" column) and a card-flip
motion would silently reintroduce it.

The rejected default, named so it stays rejected: a language-app card stack in a
friendly rounded sans with a progress bar and a streak counter. That is the
category's rut (Duolingo-adjacent) and it is also exactly the gamification the
domain notes forbid. Nothing here has a streak, a score, a percentage, or a
due-count.

### Colour: Restrained, dark by default

Product default per Operate doctrine: neutrals plus one accent. Dark-by-default,
because the real scene is arm's-length outdoor/gym/kitchen use where a bright white
field at 300+ nits is glare, not clarity, and because the four-beat indicator reads
better as light-on-dark (a lit beat against dark marks) than the reverse.

| Role | Value | Use |
|---|---|---|
| `--bg` | `#101114` | app background |
| `--surface` | `#1a1c20` | cards, sheets, the settings list |
| `--ink` | `#f4f3ef` | primary text — warm-white, not pure white (less glare at arm's length) |
| `--ink-dim` | `#8b8d94` | secondary text, inactive beat marks |
| `--accent` | `#ff8a3d` | the one accent: live/playing state, primary actions, current beat |
| `--accent-dim` | `#7a4726` | accent at rest / pressed |
| `--danger` | `#e5484d` | destructive actions (delete Deck, delete Phrase), interrupted-state banner |
| `--ok` | `#3ecf8e` | confirmation only (Scan saved, export complete) — never a score |

One accent, used for exactly three things: the currently-lit beat, the primary
action button, and current-selection state (the Deck being drilled, the Decks
picked for a Mix). It never decorates.

### Type: one family, fixed rem scale

Product UI takes one workhorse sans across every screen — this is the "one family
is often right" rule for Operate surfaces, and it matters more than usual here
because a second face on the Drill screen would compete with the one thing that
must win: the French/English text. System stack (`-apple-system, "SF Pro Text"`)
rather than a webfont: it is the face iOS already renders fastest and sharpest,
there is no brand reason to override it, and a webfont is one more asset to load
on a phone that may be on cellular in a climbing gym car park.

Fixed rem scale, ratio ~1.2, but the Drill screen breaks the top of the scale
deliberately — see §3.

| Token | Size | Weight | Use |
|---|---|---|---|
| `--text-xs` | 13px | 500 | timestamps, helper copy |
| `--text-sm` | 15px | 500 | secondary labels, list metadata |
| `--text-base` | 17px | 400 | body, list rows (iOS default tap-target text size) |
| `--text-lg` | 20px | 600 | screen titles, Deck names |
| `--text-xl` | 28px | 700 | section headers (Mix summary, Scan review count) |
| `--text-drill` | **clamp(48px, 15vw, 88px)**, weight 700 | the current French/English line on the Drill screen only |

`--text-drill` is the one deliberately fluid size in the system, and the one
exception to "fixed rem scale" above — it is justified the same way a fluid h1 is
usually rejected in product UI (arm's-length, single-purpose, single-line context;
no sidebar to look worse in). Everywhere else, fixed rem.

### Spacing and motion

- 8px base grid; screen padding 20px (clears the safe-area on both edges without
  a separate breakpoint).
- Tap targets minimum 44×44pt (iOS HIG floor), the Drill screen's controls are
  56×56pt minimum — thumb targets used mid-task, not browsed.
- Motion budget: 150–250ms on state changes (beat advance, button press,
  screen transition). No orchestrated load sequences — the app is a tool opened
  mid-task, not a landing page. The one exception, because it is a state
  indicator, not decoration: the lit beat mark gets a 400ms fill animation that
  is designed to *communicate duration* — a Pause step's mark fills at the speed
  of the pause itself, so the beat row doubles as a countdown to "your turn," which
  is the single most product-specific motion decision in this design.

---

## 2. Component vocabulary

Reused across every screen — a component built once is not rebuilt per screen.

- **Beat row** — 4 marks (pill shape, 8×32px), one per Step of the current Rep's
  Cadence. States: upcoming (dim outline), live (filled `--accent`, animating fill
  if it is a Pause step), done (filled `--ink-dim`). Always exactly 4 — the Cadence
  is fixed, so this never needs to be N-wide.
- **Rep counter** — `Rep 7 of 23`, `--text-sm`, `--ink-dim`. A count, stated once,
  never a bar, never a percentage — a progress bar reads as a completion score and
  is exactly the framing the domain notes rule out.
- **Primary button** — full-width or large-circle, `--accent` fill, `--text-lg`
  weight 700, 56pt tall minimum. One per screen at most.
- **Icon-only control** — 56×56pt circle, `--surface` fill, `--ink` icon, for
  skip/stop where a full button would compete with the primary action.
- **Deck chip** — rounded rect, Deck name + Phrase count (`12 phrases`, not a
  progress figure), tappable, selectable (outline → filled `--accent` on
  selection, used identically in Decks and Mix).
- **List row** — `--text-base`. What shipped: an explicit `Delete` control that turns
  into a second-tap `Confirm delete` in place, not swipe-to-delete — swipe was the
  original intent for this row but was not built; recorded here as an unbuilt
  intention, not silently dropped. Deck-detail reorder likewise shipped as
  `Move up`/`Move down` icon controls rather than a drag handle — see §3.3 for why
  and what it costs to add a drag affordance later.
- **Sheet** — bottom sheet on `--surface`, rounded top corners, used for
  create/rename Deck, add/edit Phrase, confirmations. Never a full-screen modal
  for a single-field edit — respects the product doctrine against modal-as-first-
  thought.
- **Banner** — full-width, fixed under the safe-area top inset, `--danger` or
  neutral background, used exactly once for the interrupted-Drill state and for
  the "no API key" Scan state. Never for confirmations (those use the `--ok` toast,
  2s auto-dismiss, non-blocking).

---

## 3. Screens

### 3.1 Drill — the screen that runs a Deck or a Mix

The screen to get right; hands-free, arm's length, spoken aloud.

**Layout, top to bottom:**
1. Safe-area top inset, then a slim header: Deck/Mix name (`--text-sm`,
   `--ink-dim`) + a stop control (top-right, small — stopping is rare and
   deliberate, so it does not compete for thumb space with pause/skip below).
2. **Beat row**, centered, large (48px marks on Drill, larger than the component
   default) — the single largest non-text element on the screen after the phrase
   line itself. This is read before anything else.
3. **Current line** — the text currently being spoken, at `--text-drill`. Shows
   French or English depending on which Step is live; switches with a 150ms
   cross-fade, never a slide (a slide implies "next card," the card metaphor this
   design refuses).
4. **Rep counter**, `Rep 7 of 23`, directly under the current line.
5. Bottom control row, thumb reach, safe-area bottom inset:
   `[ Skip ]  ( Pause/Resume — primary, center, largest )  [ Stop ]`.

**Before starting — the tap that must happen, and the expectation it sets:** the
Drill never auto-starts. It opens on a **start card**: Deck/Mix name, phrase count,
and one primary button, `Start Drill`. Directly under the button, two short lines
in `--text-sm`/`--ink-dim`, stated plainly, not as fine print:

> Keep this screen on and open — the drill stops if your phone locks or you
> switch apps. You'll get a clear "tap to resume."
> Plays through the speaker even on silent.

These are the two iOS constraints (T001) that would otherwise surprise her in
public or mid-drill; stating them before the first tap is the whole mitigation
available at the UI level, and it is why they are copy on the start card rather
than a one-time onboarding tooltip she will not see twice.

**Before starting — the readiness gate.** The Drill can also open blocked, before
the start card, if it has nothing playable yet: no voice has been chosen in
Settings (`No voice has been chosen yet — pick one in Settings before drilling`,
with an `Open Settings` action), or every Phrase in this Deck/Mix is still waiting
on its audio (`This drill's audio isn't ready yet — it's still being made. Try
again in a moment`). Not in the original sketch — the app no longer speaks
Phrases live through the browser's `speechSynthesis`; French audio is generated
ahead of a Drill through a TTS API and cached as **Clips** (glossary), so "the
Phrase exists but its audio doesn't yet" is a real state a live-synthesis
readout never had to name. If some but not all Phrases are ready, the start
card shows the count skipped (`N phrases have no audio yet — skipped`) rather
than blocking the whole Drill. If the
one-tap unlock itself fails, the start card stays up with `Couldn't start audio
on this phone. Tap Start Drill to try again.` rather than moving on.

**The interrupted state — designed explicitly, not left as a dead screen.**
iOS suspends playback of the shared `<audio>` element on screen lock or
backgrounding with no web-platform workaround — established against
`speechSynthesis` (T001) and confirmed to hold for the `<audio>`-element Clip
player that replaced it. The Drill listens for
`visibilitychange`/`pagehide` and on return treats "was hidden while playing" as a
first-class state, not an error:

- The beat row and current line **freeze in place** exactly where they were —
  never blank, never reset to Rep 1. She left on "Rep 7, beat 3"; she returns to
  "Rep 7, beat 3."
- A banner drops from the top safe-area edge, neutral background (not `--danger`
  red — this is expected behaviour, not a fault): **"Drill paused when your screen
  locked."** Below it, the primary button relabels itself in place from
  `Pause/Resume` to **`Tap to resume`**, same position, same size — the control she
  already knows where to find is the control that recovers her, so the recovery
  gesture costs nothing to learn.
- Skip/Stop stay available under the frozen state; Stop from here ends the Drill
  cleanly rather than leaving it wedged.
- **Unbuilt intention — resume across a fresh page load.** The design called for
  this same freeze-and-resume treatment to survive Safari killing the tab: no
  in-memory Drill in IndexedDB would show the start card with different banner
  copy ("Your last drill stopped when the app closed. Start again when ready")
  instead of a plain start. Nothing persists an in-progress Drill anywhere —
  only the in-session `visibilitychange` freeze above shipped. A reload mid-Drill
  currently just lands on a fresh start card with no memory of the interruption.
  Left as a real gap, not a silent scope cut.

**Other states:**
- **Empty (Deck has no Phrases):** `Drill this Deck` in Deck detail is not
  disabled for an empty Deck (unlike the sketch below in §3.2/§3.3, which
  describes a disabled affordance) — tapping it opens the Drill, which then
  shows the `none-ready` blocked copy above (`This drill's audio isn't ready
  yet — it's still being made`). That copy was written for "audio still
  generating," not "there are no Phrases at all," so it is not quite right for
  this path; flagged here as needing a decision rather than silently left.
- **Stopped (manual):** returns to whichever screen launched it — Deck detail or
  Mix — no summary screen, no completion score. The Drill is simply over.
- **Mid-Rep skip:** beat row and current line cut immediately to the next Rep's
  first beat; no transition needed, it is a direct cut like a metronome missing a
  beat on purpose.

### 3.2 Decks — contexts, pick, create/rename/delete

- Header: `Decks`, `--text-lg`, and a `+ New Deck` link-style control (top-right).
  What shipped also puts `Settings` and `Mix decks…` in this same header action
  row, not as a secondary sub-list-line as originally sketched below.
- List of **Deck chips**, one per Deck, author order (Decks have no sort order of
  their own beyond creation — matches the domain model, §2, "the Deck keeps its
  author order"). Each chip: name, `--text-base`; phrase count, `--text-sm`
  `--ink-dim` (`Add phrases to drill this Deck` in place of a count when the Deck
  is empty); tap opens Deck detail (§3.3).
- **Unbuilt intention — direct-drill from the chip.** The sketch had each chip
  carry its own small `Drill` affordance so the common path never requires
  entering Deck detail first. Not built: a chip's only action is opening Deck
  detail, where `Drill this Deck` lives (§3.3). Recorded as a real idea that
  didn't ship, not dropped.
- What shipped: each chip carries explicit `Rename` and `Delete` controls
  directly on the row. `Rename` opens the **sheet** as designed. `Delete` does
  not — it turns into a second-tap `Confirm delete` button in place, no sheet,
  no long-press/`···` trigger. Simpler than sketched; still never silent, never
  inline-edit-on-list.
- **Empty state (0 Decks, first run):** replaces the list with a single line,
  `Nothing here yet — start a Deck for one of your contexts.` — the header's
  `+ New Deck` control is still there to act on it. The sketched second action,
  `Scan a page`, equally weighted with `New Deck`, was not built — see the Scan
  note below.
- **Unbuilt — Scan has no entry point in the shipped app.** §3.5 describes the
  Scan/correction screen, and `src/ui/ImportScreen.tsx` matches that
  description; it is built and tested. But nothing in `App.tsx` renders it —
  there is no `Mix decks…`-style link to it from here, from Deck detail, or
  anywhere else, and no `Scan a page` action in the empty state above. A person
  using the shipped app today has no way to reach Scan at all. Needs a decision:
  wire it in, or say explicitly it's deferred.

### 3.3 Deck detail — the phrases in one Deck

- Header: Deck name (tap to rename via sheet), phrase count, `Drill this Deck`
  primary button pinned under the header — starting a Drill from the Deck she is
  looking at should never require scrolling past its Phrase list first.
- List rows, one per Phrase, author order: French text (`--text-base`, weight
  600) over English text (`--text-sm`, `--ink-dim`) — the two lines stacked, not
  side by side, because side-by-side on a narrow phone column forces truncation
  on longer phrases and this list is read, not glanced at.
- **What shipped instead of a drag handle: `Move up` / `Move down` buttons**,
  one pair per row, each disabled at its end of the list. A deliberate
  substitution, not an oversight — the worktree that built this screen could not
  run `npm install` (adding a drag library would have left the build broken),
  and a hand-rolled pointer-drag was judged real engineering risk for an
  outcome the button pair already delivers. The domain's `reorderPhrase` and
  the `onMovePhraseUp`/`onMovePhraseDown` callback contract this screen already
  uses support a drag affordance unchanged, if one is wanted later — swapping
  the control does not touch the domain or the persistence path.
- What shipped instead of swipe-to-delete: an explicit `Delete` control per row
  that turns into a second-tap `Confirm delete` in place — no swipe gesture, no
  undo toast. Deleting is still two deliberate taps, just not the sketched
  pattern.
- `+ Add phrase` row pinned at the list's end, opens a **sheet** with two fields,
  French / English, `Save`.
- Tap a row to edit the same two fields in the same sheet shape (add and edit
  share one component).
- **Empty (0 phrases):** list is replaced by `Add phrases to drill this Deck.`
  The sketched second action, `Scan a page into this Deck`, was not built —
  Scan has no entry point anywhere in the shipped app (§3.2).
- **Delete Deck:** reached from the header's `Delete Deck` control, which turns
  into a second-tap confirm button in place — `Delete "Climbing" and its 14
  phrases?` — not a sheet as sketched. States the phrase count being deleted
  either way, never a bare "Are you sure?".

### 3.4 Mix — choose several Decks, drill as one run

- Reuses the **Deck chip** exactly as Decks does, but multi-select: tapping a
  chip toggles it into the selection (outline → `--accent` fill), no separate
  checkbox — the chip *is* the control.
- Running total pinned above the primary button: `3 decks selected · 41 phrases`
  — a count of material, not a score. Pluralises correctly at 1 (`1 deck
  selected · 12 phrases`).
- Primary button: enabled from 1 Deck selected, not disabled below 2 as first
  sketched — that sketch contradicted itself (disabled below 2 Decks, and
  separately a 1-Deck selection routing to a plain Drill), carried as an open
  contradiction from an earlier build stage and resolved during this build. What
  shipped: the button reads `Start Drill` at exactly 1 Deck selected and `Start
  Mix` at 2 or more — the same handoff either way, since a Mix of one Deck is
  structurally just that Deck's Phrases.
- Shuffle is implicit and stated once, inline under the button, `--text-xs`:
  "Phrases play in random order" — she does not choose Shuffle as an option
  because Mix always shuffles (domain model: Shuffle is a Drill-start property,
  and Mix's whole reason to exist is combine-and-shuffle).
- **Empty (fewer than 2 Decks exist):** what shipped is not quite the sketch —
  the `Mix decks…` link from Decks is always visible, not hidden/disabled;
  tapping it opens the Mix screen itself, which then shows its own empty state
  in place of the picker: `Add another Deck to mix`. Same message reaches her,
  one tap later than sketched.
- No "saved Mix" concept anywhere (open question 2 in the domain notes was left
  unresolved for the owner; this design does not invent persistence for it —
  re-selecting is three taps, matching the domain model's own reasoning).

### 3.5 Scan / correction — photograph, review, assign

**Unbuilt — Scan has no entry point.** `src/ui/ImportScreen.tsx` implements
this flow and is not itself wired into `App.tsx` from anywhere (§3.2). Every
description below is of the standalone component as it exists, reachable today
only in isolation (its own tests), not from the running app.

Three-step flow, one screen each. **Unbuilt intention:** the sketch called for a
top progress trail (`--text-xs`, three dots, not a percentage bar) marking
position in the flow; not built — the shipped screen has no position indicator
at all, just the three steps' content swapping in place.

**Step 1 — Capture.** A single large control, `Take Photo` (native
`<input type="file" capture="environment">` — no custom camera UI; the doctrine
against reinventing standard affordances applies directly here, and a bespoke
camera view is real engineering risk for zero product benefit). Secondary:
`Choose from Library`.

- **What shipped instead of a proactive "No API key present" state:** this
  screen has no key-presence check at all, and no `Open Settings` action —
  Step 1 always offers Take Photo / Choose from Library regardless of whether a
  key is saved. A missing key is only discovered reactively, as an
  `unauthorized` failure after a photo is taken and read fails (Step 2 below),
  not proactively before a photo is ever taken as originally sketched.

**Step 2 — Reading.** `Reading your photo…` with a `Cancel` button. **Unbuilt
intention:** the sketch called for a photo thumbnail and an animated beat-row
echo (three marks pulsing) standing in for a generic spinner, tying this
loading state to the Drill's own motif; neither shipped — there is no
thumbnail and no beat-row animation, just the status line above.

- **Failure states**, mapped directly from the `ScanError` port variants named in
  the domain model, each with its own plain-language copy: `unreadable` →
  "Couldn't read phrases from that photo — try better light or a closer shot."
  (`Try again`) `network` → "Couldn't reach the scanner — check your connection
  and try again." (`Try again`) `unauthorized` → "Scanning needs a key from
  whoever set this app up for you. Ask them to add it in Settings." (`Back`,
  not `Open Settings` — this screen has no Settings-navigation callback).
- **Not in the sketch:** a fourth outcome, a successful read that finds no
  phrases on the photo at all (`No phrases found on that photo — nothing to
  correct here`, with `Try another photo`) — the sketch only accounted for
  `ScanError` failures, not an empty-but-successful read.

**Step 3 — Review & assign.** A list of **Draft Phrase** rows — same visual
shape as a Phrase row (French over English) but with a distinct left-edge
treatment (a thin `--accent` bar) marking them as unconfirmed, never silently
identical to a saved Phrase, per the domain model's explicit distinction. Each
row is directly editable inline (tap either line to correct OCR misreads) and
individually removable (a misread row she doesn't want does not block the rest).
Below the list, a single **Deck picker** (existing Decks + `New Deck…` inline) —
one Deck for the whole batch, matching the domain model's confirmation semantics
(confirmation appends to exactly one Deck). Primary button: `Save N phrases to
"<Deck>"`, disabled until a Deck is chosen.

- **Abandoning this screen** (back, tab close) discards the Draft Phrases with no
  prompt — the domain notes accept this for v1 (a Scan is cheap to redo); a
  confirmation dialog here would misrepresent the decision as costly.

### 3.6 Settings — two keys, the voice picker, and the backup

Deliberately short — a personal-scale settings screen, not a developer panel.
Amended twice since the original sketch: a second key for speech, once the app
moved from the browser's own `speechSynthesis` to a TTS API generating cached
Clips (§3.1); and a full voice picker, once the owner asked mid-build to be
able to choose the voice herself, opening what had been a display-only
readout into the picker described below.

1. **Handwriting scan key** — one field, masked, `Save`, plus a `Clear`
   action once a key is saved. Helper text: "Used only to read photos of
   handwritten phrases. It's scoped to this app's workspace and spend-capped
   — it can't run up a large bill." Status line states plainly whether a key
   is saved yet, and that scanning simply waits if not — never framed as an
   error.
2. **Speech key** — a second, identically-shaped field for the TTS provider
   (ElevenLabs) that generates the Clips a Drill plays, `Save`/`Clear`,
   capped with a monthly credit limit per its own helper text. Existing audio
   keeps working with no key present; only new phrases wait for one.
3. **Voice — no longer display-only, now a picker.** A curated catalogue of
   voices (currently three, each named and described, e.g. "Female voice,
   American-accented English speaking French" — none is French-native, and the
   accent is stated plainly rather than implied). Each entry carries:
   - **Preview** — plays a real French phrase from her own library (the first
     Phrase with French text on file, or a fixed fallback phrase if she has
     none yet) spoken in that voice, so she is choosing by ear against her own
     material, not a generic sample.
   - **Use this voice**, which does not switch immediately — it opens a
     **confirmation sheet**: "Switch to `<voice>`? The audio for every phrase
     will be made again in this voice — that takes a little while, so phrases
     will be briefly silent while it catches up." Only `Switch voice` on that
     sheet actually pins the new voice, because every cached Clip is
     content-addressed by voice (glossary) and a change orphans the whole
     cache. Requires the speech key above; previewing and choosing are both
     blocked with inline copy until one is saved.
4. **Backup** — the single most important item on this screen, in its own
   card treatment. "Your phrases are saved on this phone only, and an iPhone
   can sometimes clear old app data if it hasn't been opened in a while. Save
   a backup you can keep or send yourself — then you can always get them
   back." A second line, not in the original sketch: Clips are not part of
   the backup — they regenerate automatically next time she's online, in the
   same voice, so a freshly restored phrase is normal to sit briefly silent.
   `Export backup` invokes the native iOS share sheet (`navigator.share`)
   where available, falling back to a plain file download only when sharing
   itself is unsupported — a fallback the original sketch didn't name, added
   because the primary path isn't universal. `Restore from backup` accepts a
   chosen file and, on a valid one, opens a confirmation sheet before
   replacing anything: "This replaces everything currently saved... This
   can't be undone. Are you sure?", confirmed via `Replace my phrases`. An
   invalid or unreadable file is refused with plain-language copy naming the
   likely cause, never a raw parse error.
- A closing privacy line, not in the original sketch: keys stay on the phone,
  never in a link, a log, or an exported backup.

**Unbuilt intention — About.** The sketch called for a third, minimal section
here: app name, nothing else. Not built — there is no About section in the
shipped screen. A small, low-risk omission, named here rather than silently
dropped.

**Unbuilt intention — first-run backup nudge.** The sketch called for a
one-line, dismiss-once nudge ("Tip: back up your phrases in Settings") on the
Decks empty-state and after the first successful Scan, so backup would be
discoverable without anyone opening Settings cold. Neither nudge is present in
the shipped Decks empty state, and Scan itself has no entry point yet (§3.2,
§3.5) to carry one from.

---

## 4. What was deliberately left out, and why

- **No progress bar, streak, score, or due-count anywhere** — the domain notes
  ban this outright (a Deck has no scheduler); the Rep counter and phrase counts
  are the only quantities shown, and both describe material, not achievement.
- **No saved/named Mix** — open question in the domain notes, left to the owner;
  designing it in now would answer a question that is not this session's to
  answer, and the re-selection flow (§3.4) is cheap enough that its absence is
  not a hardship.
- **No custom camera capture UI** — native `<input capture>` used as-is; a custom
  viewfinder is real risk (permissions, orientation, iOS camera quirks) for a
  feature (Scan) that is explicitly secondary to Drill.
- **No dark/light toggle** — dark-by-default only. A light theme was considered
  and dropped: the real use context (outdoor, gym, kitchen, arm's length) favours
  dark uniformly, and a toggle is a settings row that serves no one here — this
  is a one-person app, not a product with varied lighting preferences to
  accommodate.
- **No animated onboarding/tutorial** — the two load-bearing warnings (screen-on
  requirement, silent-mode audio) are stated as plain text on the Drill start
  card and nowhere else; a swipeable intro carousel is exactly the kind of
  orchestrated load sequence the motion doctrine rules out for product UI, and
  she would see it exactly once and never again.
- **No repeat-this-Rep / loop-one-phrase control** — named as a plausible future
  ask in the domain notes but not requested; left off rather than speculatively
  added to the control row, which is already at its practical limit of three
  controls for one-handed thumb reach.
