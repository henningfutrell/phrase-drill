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
- **List row** — `--text-base`, swipe-to-delete (native iOS pattern, not
  reinvented), drag handle for reorder in Deck detail.
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

**The interrupted state — designed explicitly, not left as a dead screen.**
iOS suspends `speechSynthesis` on screen lock or backgrounding with no
web-platform workaround (T001, confirmed). The Drill listens for
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
- This state is reachable from a fresh page load too (Safari killed the tab): if
  IndexedDB shows no in-memory Drill to resume, the start card is shown instead,
  with the banner copy changed to **"Your last drill stopped when the app closed.
  Start again when ready"** — same visual language, different recovery (a fresh
  Start, not a Resume), so a dead session never reads as a bug.

**Other states:**
- **Empty (Deck has no Phrases):** Drill is not reachable; Decks screen disables
  the chip's drill affordance and explains inline (§3.2).
- **Stopped (manual):** returns to the Decks or Mix screen it was launched from —
  no summary screen, no completion score. The Drill is simply over.
- **Mid-Rep skip:** beat row and current line cut immediately to the next Rep's
  first beat; no transition needed, it is a direct cut like a metronome missing a
  beat on purpose.

### 3.2 Decks — contexts, pick, create/rename/delete

- Header: `Decks`, `--text-lg`, and a `+ New Deck` primary control (top-right,
  small — creation is infrequent relative to drilling).
- List of **Deck chips**, one per Deck, author order (Decks have no sort order of
  their own beyond creation — matches the domain model, §2, "the Deck keeps its
  author order"). Each chip: name, `--text-base`; phrase count, `--text-sm`
  `--ink-dim`; tap opens Deck detail (§3.3).
- Each chip carries a small `Drill` affordance (icon or short label) that starts a
  single-Deck Drill directly — the common path does not require entering Deck
  detail first.
- Long-press or a trailing `···` opens rename/delete via a **sheet**, never
  inline-edit-on-list (a renamed-in-place list row is easy to trigger by
  accident on a touch list).
- **Empty Deck (0 phrases):** the chip's `Drill` affordance is visibly disabled
  (dimmed, no accent) with inline caption `Add phrases to drill this Deck` — never
  a silently-dead tap target.
- **Empty state (0 Decks, first run):** replaces the list with a single centered
  prompt: "Nothing here yet — start a Deck for one of your contexts, or scan a
  page of handwritten phrases," with two primary actions, `New Deck` and `Scan a
  page`, equally weighted — Scan is a first-class entry point to populating a
  Deck, not buried in Deck detail.
- Below the list, secondary: `Mix decks…` (→ §3.4) and `Scan a page` (→ §3.5),
  both `--text-sm` links, not competing with the primary list.

### 3.3 Deck detail — the phrases in one Deck

- Header: Deck name (tap to rename via sheet), phrase count, `Drill this Deck`
  primary button pinned under the header — starting a Drill from the Deck she is
  looking at should never require scrolling past its Phrase list first.
- List rows, one per Phrase, author order: French text (`--text-base`, weight
  600) over English text (`--text-sm`, `--ink-dim`) — the two lines stacked, not
  side by side, because side-by-side on a narrow phone column forces truncation
  on longer phrases and this list is read, not glanced at.
- Drag handle (native reorder), swipe-to-delete (native pattern, confirms via a
  brief undo toast rather than a blocking confirmation — deleting one Phrase is
  low-stakes and reversible for a few seconds).
- `+ Add phrase` row pinned at the list's end, opens a **sheet** with two fields,
  French / English, `Save`.
- Tap a row to edit the same two fields in the same sheet shape (add and edit
  share one component).
- **Empty (0 phrases):** list is replaced by the same "add phrases" prompt as the
  Decks empty state, plus `Scan a page into this Deck` as a second action —
  naming the Deck as the Scan target directly from here removes a step versus
  scanning generically and assigning after (§3.5 still supports the generic path
  too).
- **Delete Deck:** reached from the header's `···`, sheet confirmation states the
  phrase count being deleted (`Delete "Climbing" and its 14 phrases?`) — never a
  bare "Are you sure?".

### 3.4 Mix — choose several Decks, drill as one run

- Reuses the **Deck chip** exactly as Decks does, but multi-select: tapping a
  chip toggles it into the selection (outline → `--accent` fill), no separate
  checkbox — the chip *is* the control.
- Running total pinned above the primary button: `3 decks selected · 41 phrases`
  — a count of material, not a score.
- Primary button: `Start Mix` (disabled, dimmed, until ≥2 Decks are selected — a
  1-Deck "Mix" is just that Deck, and the button routes to a plain Drill in that
  case rather than presenting a redundant confirmation).
- Shuffle is implicit and stated once, inline under the button, `--text-xs`:
  "Phrases play in random order" — she does not choose Shuffle as an option
  because Mix always shuffles (domain model: Shuffle is a Drill-start property,
  and Mix's whole reason to exist is combine-and-shuffle).
- **Empty (fewer than 2 Decks exist):** Mix is not reachable as a distinct
  screen — the `Mix decks…` link from Decks is hidden/disabled with inline
  caption `Add another Deck to mix` (mixing needs ≥2 Decks to mean anything).
- No "saved Mix" concept anywhere (open question 2 in the domain notes was left
  unresolved for the owner; this design does not invent persistence for it —
  re-selecting is three taps, matching the domain model's own reasoning).

### 3.5 Scan / correction — photograph, review, assign

Three-step flow, one screen each, in a top progress trail (`--text-xs`, three
dots, not a percentage bar — consistent with the no-progress-score rule; this
trail marks position in a short flow, not achievement).

**Step 1 — Capture.** A single large control, `Take Photo` (native
`<input type="file" capture="environment">` — no custom camera UI; the doctrine
against reinventing standard affordances applies directly here, and a bespoke
camera view is real engineering risk for zero product benefit). Secondary:
`Choose from Library`.

- **No API key present:** this entire screen replaces its content with a calm,
  non-alarming state — no red, no error iconography: "Scanning needs a key from
  whoever set this app up for you. Ask them to add it in Settings." One action,
  `Open Settings`. This is explicitly not an error screen; the domain notes are
  clear that a missing key is an expected, common state, not a fault.

**Step 2 — Reading.** Photo thumbnail, a determinate-feeling but honestly
indeterminate spinner (the vision call has no reliable progress signal — an
animated beat-row echo of the Drill's own motif, three marks pulsing in
sequence, ties this loading state visually to the rest of the product instead of
a generic spinner), with `Cancel`.

- **Failure states**, mapped directly from the `ScanError` port variants named in
  the domain model, each with its own plain-language copy and a `Try again`:
  `unreadable` → "Couldn't read phrases from that photo — try better light or a
  closer shot." `network` → "Couldn't reach the scanner — check your connection
  and try again." (`unauthorized` is handled at Step 1, before a photo is ever
  taken.)

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

### 3.6 Settings — the API key and the backup

Deliberately short — a personal-scale settings screen, not a developer panel.

1. **Scan key** — one field, masked, `Save`. Helper text: "Only used to read
   photos of handwriting. Ask [owner] if you're not sure what this is." No other
   scan configuration exists to show.
2. **Backup** — the single most important item on this screen, and placed
   *first-visually-weighted* despite being second in the list, via a distinct
   card treatment (not just another settings row): "Your phrases are saved on
   this phone only, and iPhone can sometimes clear old app data. Save a backup
   you can keep or send yourself." One primary button, `Export backup`, which
   invokes the native iOS share sheet (`navigator.share` with the JSON file) —
   not a desktop-style file download link, which on iOS Safari is a dead pattern
   she would not know how to find afterward. A `Restore from backup` secondary
   action accepts a shared-in file, with a plain-language warning before it runs
   (`importAll` replaces the whole library): "This replaces everything currently
   saved. Are you sure?"
3. **About** — app name, nothing else. No account, no plan, no admin.

- **First-run nudge, elsewhere, not here:** because a backup screen nobody visits
  is not discoverable, the Decks empty-state and the very first successful Scan
  both carry a one-line, dismiss-once nudge: "Tip: back up your phrases in
  Settings" — the doctrine requirement that backup be discoverable by someone who
  does not know what a backup is met by surfacing it at the two moments she has
  just created something worth keeping, not by hoping she opens Settings cold.

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
