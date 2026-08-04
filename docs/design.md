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
  neutral background, used exactly once for the interrupted-Drill state. Never
  for confirmations (those use the `--ok` toast, 2s auto-dismiss,
  non-blocking). T041 removed the second use this bullet used to name (a "no
  API key" Scan state) — the device holds no provider key any more, so there
  is nothing left to warn about at that point in the flow.

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
  `+ New Deck` control is still there to act on it, as is the header's `Scan a
  page` link. The sketch put `Scan a page` *inside* the empty state, equally
  weighted with `New Deck`; what shipped puts it in the header instead, so it is
  reachable from the list whether or not there are Decks.
- **Scan's entry point is a header link, not an empty-state action.**
  `DecksScreen` renders `Scan a page` (`data-testid="open-import"`) beside
  `Mix decks…` and `Settings`, as a `link-action` rather than a primary button
  (`src/ui/DecksScreen.tsx`). `App.tsx` sets `importOpen` from it and renders
  `ImportScreen` with the real `createClaudeScanReader`. Deck detail has no Scan
  entry — a Scan is always started from the Decks list, and the target Deck is
  chosen inside the flow (§3.5).

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
  The sketched second action, `Scan a page into this Deck`, was not built. Scan
  is reachable only from the Decks list header (§3.2), and picks its target Deck
  inside the flow rather than inheriting it from the screen it was started on.
  **`Drill this Deck` is not offered here either** (T027 fix) — it used to be
  pinned under the header regardless of phrase count, and starting it on an
  empty Deck landed on the `none-ready` blocked state, whose copy ("This
  drill's audio isn't ready yet — it's still being made") was written for
  phrases that exist but have no Clip yet, not for a Deck with nothing in it.
  Rather than invent a second `DrillReadinessReason` for a case the button
  should never reach, the button itself is withheld when `deck.phrases.length
  === 0`; the empty-state line above is the only thing shown.
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
- **Saved Mixes (T059)** — the owner answered open question 2: "make where you
  can save, edit and delete mixes". A Mix is now a persisted entity, and this
  screen has two halves:
  - **Her saved Mixes, listed first**, above the picker: name in `--font-script`,
    then `2 decks · 15 phrases` in the muted register. The row *is* the start
    control — one tap goes straight into a Drill on that Mix, titled with the
    Mix's name rather than the generic `Mix`. Beside each row, three held-back
    `btn-icon` actions: `Rename`, `Edit decks`, and `Delete` (second-tap confirm
    in place, exactly as Deck delete works). `No saved mixes yet` where the list
    would be.
  - **The picker below**, unchanged, plus one control: `Save mix` beside
    `Start Mix`. `Save mix` opens the shared name sheet; while she is editing an
    existing Mix it reads `Save changes` and a `Cancel` sits next to it, with
    the Mix's current Decks preloaded into the selection.
  - **A Deck deleted out from under a Mix** does not remove the Mix or rewrite
    it. The row lists what is left (`1 deck · 9 phrases`); a Mix whose Decks are
    all gone reads `Its decks are gone` and its row is disabled, because an
    empty Drill is not a thing to start. The dead id leaves the Mix only when
    she edits and re-saves it herself.
  - The saved list is shown whatever the Deck count is, including below 2, where
    the picker is replaced by `Add another Deck to mix`. A screen that hid her
    saved Mixes would be indistinguishable from one that had lost them.

### 3.5 Scan / correction — photograph, review, assign

Reached from `Scan a page` in the Decks list header (§3.2).
`src/ui/ImportScreen.tsx` implements this flow; `App.tsx` renders it with
`createServerScanReader` (T041), which calls this app's own `/api/scan`,
authenticated with her session token (T050, replacing an earlier Keycloak
login in turn replacing the original device library key). The device holds no Anthropic key at all any more, so
there is nothing to be present or missing — the old `apiKeyPresent` gate is
gone with it.

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
  screen never had a key-presence check to remove (T041 made the question
  moot rather than resolving it) — Step 1 always offers Take Photo / Choose
  from Library. The only remaining reason a scan fails at the door is the
  server itself having no Anthropic key configured, surfaced reactively as an
  `unauthorized` failure after a photo is taken and read fails (Step 2
  below), never proactively before a photo is ever taken.

**Step 2 — Reading.** `Reading your photo…` with a `Cancel` button. **Unbuilt
intention:** the sketch called for a photo thumbnail and an animated beat-row
echo (three marks pulsing) standing in for a generic spinner, tying this
loading state to the Drill's own motif; neither shipped — there is no
thumbnail and no beat-row animation, just the status line above.

- **Failure states**, mapped directly from the `ScanError` port variants named in
  the domain model, each with its own plain-language copy: `unreadable` →
  "Couldn't read phrases from that photo — try better light or a closer shot."
  (`Try again`) `network` → "Couldn't reach the scanner — check your connection
  and try again." (`Try again`) `unauthorized` (T041: now a server
  misconfiguration, not a missing on-device key) → "Scanning isn't set up on
  the server yet. Ask whoever runs it to check." (`Back`, not `Open Settings`
  — there is no on-device setting that would fix this).
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

### 3.6 Settings — the voice picker and the backup

Deliberately short — a personal-scale settings screen, not a developer panel.
Amended three times since the original sketch: a second key for speech, once
the app moved from the browser's own `speechSynthesis` to a TTS API
generating cached Clips (§3.1); a full voice picker, once the owner asked
mid-build to be able to choose the voice herself; and, in T041, both
provider-key fields were deleted outright and replaced with a **Sync**
section — the server now holds both credentials, so there was no key
left for this screen to collect. T043 deleted that Sync section in turn:
identity is a login (T050: a plain username/password form; T043 through
T049 used a Keycloak browser redirect instead), not a pasted key, so there
is nothing left on this screen to display, copy, or recover by hand — a
wiped or replaced phone recovers by logging in again, the same as any other
account.

1. **Voice — a picker.** A curated catalogue of voices (currently three, each
   named and described, e.g. "Female voice, American-accented English
   speaking French" — none is French-native, and the accent is stated plainly
   rather than implied). Each entry carries:
   - **Preview** — plays a real French phrase from her own library (the first
     Phrase with French text on file, or a fixed fallback phrase if she has
     none yet) spoken in that voice, so she is choosing by ear against her own
     material, not a generic sample. No key gate any more — a preview is
     always attempted; if the server has no speech provider configured, the
     failure is surfaced with copy naming the server, not a device fix.
   - **Use this voice**, which does not switch immediately — it opens a
     **confirmation sheet**: "Switch to `<voice>`? The audio for every phrase
     will be made again in this voice — that takes a little while, so phrases
     will be briefly silent while it catches up." Only `Switch voice` on that
     sheet actually pins the new voice, because every cached Clip is
     content-addressed by voice (glossary) and a change orphans the whole
     cache.
2. **Backup** — still present alongside server sync, in its own card
   treatment, reframed as extra insurance rather than the only copy: "Your
   phrases sync to the server automatically, but you can also save a backup
   file you keep or send yourself, for extra peace of mind." Clips are not
   part of the backup — they regenerate automatically next time she's online,
   in the same voice, so a freshly restored phrase is normal to sit briefly
   silent. `Export backup` invokes the native iOS share sheet
   (`navigator.share`) where available, falling back to a plain file download
   only when sharing itself is unsupported. `Restore from backup` accepts a
   chosen file and, on a valid one, opens a confirmation sheet before
   replacing anything: "This replaces everything currently saved... This
   can't be undone. Are you sure?", confirmed via `Replace my phrases`. An
   invalid or unreadable file is refused with plain-language copy naming the
   likely cause, never a raw parse error.
- A closing privacy line, rewritten for T041: "This phone holds no server
  credentials — only your sync key, which stays on this phone unless you
  choose to copy it."

**Unbuilt intention — About.** The sketch called for a third, minimal section
here: app name, nothing else. Not built — there is no About section in the
shipped screen. A small, low-risk omission, named here rather than silently
dropped.

**First-run backup nudge (T027).** A one-line, dismiss-once nudge — `Tip: back
up your phrases in Settings.` plus a `Got it` dismiss — appears in two places:
the Decks empty state (§3.2, below the `Nothing here yet…` line) and the Scan
review step (§3.5 Step 3, above the Draft Phrase list), the moment a Scan has
actually produced phrases to save. One flag backs both: `Settings.
backupNudgeDismissed`, `false` until she dismisses the nudge from either
place, `true` and permanent after — there is no way back to shown. It is not
part of the exported backup itself, same treatment as the pinned voice
(§3.6, `DeckStore.exportAll()` cannot see it).

### 3.7 Diagnostics — answer "it's not working" without guessing (T039)

Reached from Settings by a plainly-labelled `Open diagnostics` button, in its
own card — not a hidden gesture. Built because the app has one remote,
non-technical user: when she says something is broken, there was previously
no way to find out why without guessing.

Shows one already-formatted report, gathered fresh every time the screen
opens:

- **Build** — the git commit short SHA and build timestamp (`vite.config.ts`
  embeds both via `define` at build time), so a build can be identified over
  the phone rather than assumed current.
- **Voice** — whether one is pinned, and which provider. (T041 dropped the
  "key presence" line this report used to carry — the device holds no
  provider key any more, so there is nothing to report presence of.)
- **Clips ready vs total Phrases** — a count, never phrase text.
- **Storage** — usage against quota via `navigator.storage.estimate()`,
  reported honestly as unavailable rather than a fabricated zero when the
  browser doesn't support it.
- **Last sync** — the timestamp of the last successful Library sync, or
  "never."
- **Recent errors** — the last several entries from a bounded, on-device
  error log (`ErrorLog`, capped at 50 entries, oldest dropped first),
  populated by `window.onerror`, `unhandledrejection`, and adapter failures
  (a failed scan, a failed synthesis call). Any key value that could appear
  in a captured error message is redacted (`[REDACTED]`) before it is ever
  written to the log.

One control, `Copy report`, copies the whole formatted report as text for
pasting into a message — the only way she has of sending back what's wrong.
If the Clipboard API is unavailable or the copy itself fails, the screen says
so plainly and leaves the report visible to select by hand, rather than
failing silently.

Never included, by design: phrase text (counts only), a provider key (the
device does not hold one to include), and any third-party analytics or
error-reporting service — everything here stays on-device until she chooses
to paste it somewhere.

---

## 4. What was deliberately left out, and why

- **No progress bar, streak, score, or due-count anywhere** — the domain notes
  ban this outright (a Deck has no scheduler); the Rep counter and phrase counts
  are the only quantities shown, and both describe material, not achievement.
- ~~**No saved/named Mix**~~ — the owner answered the open question in T059
  ("make where you can save, edit and delete mixes"); saved Mixes shipped, and
  §3.4 describes what they look like. Kept here struck through because the
  reasoning for the original omission (it was the owner's question to answer,
  not the design's) is still the right reasoning — it was answered, not
  overruled.
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
