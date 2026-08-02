# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

_All fields below are inferred from the build brief and domain-model notes handed to
this session; no interactive interview was possible (this is an unattended design
task with no user-facing answer channel), so everything here is a labeled inference,
not a confirmed answer. A human should skim and correct rather than treat this as settled._

## Stack

Existing codebase: React + TypeScript + Vite, static PWA, no server. Not decided by
this session — inherited from the repo.

## Users

One named, specific person: a non-technical woman learning French, using an iPhone.
No second user, no admin, no multi-tenant concern _(inferred: repo `AGENTS.md`
states this explicitly)_. She reaches the app to drill phrases she wrote herself,
hands-free, phone in hand or propped, speaking aloud along with the audio.

## Product Purpose

A phrase-drill tool: she writes French/English phrase pairs, grouped by the
contexts of her life (home, friends, work, formal, climbing), and the app speaks
each phrase in a fixed rhythm (French, pause, French, pause, English, pause,
French, pause) so she can repeat aloud. She can also photograph a handwritten
page and have its phrases read in.

## Positioning

_(inferred)_ Not a flashcard/SRS app (no scores, no streaks, no due-counts — the
domain notes rule these out explicitly) and not a course. It is closer to a
practice-room drill partner than a study app: it has one job, playback in a fixed
cadence, and does that job hands-free.

## Operating Context

- iPhone, Safari, portrait, one-handed, often at arm's length while speaking aloud.
- Drilling happens in situations where looking at the screen closely is
  inconvenient or impossible (walking, cooking, climbing gym) — glanceable state
  matters more than dense text.
- iOS suspends `speechSynthesis` on screen lock / backgrounding — no workaround
  exists at the web-platform level _(T001 spike notes, confirmed research)_.
- Audio plays through the speaker even with the phone muted.
- Her IndexedDB data can be evicted by iOS after inactivity; export/backup must be
  discoverable, not a developer feature.

## Capabilities and Constraints

- No server; all state in IndexedDB. The only network call is to a vision API for
  handwriting scan, gated by a bring-your-own API key the app owner (not she)
  provisions once.
- Cadence is fixed in v1: FR, pause, FR, pause, EN, pause, FR, pause. Not
  user-configurable.
- Domain terms are fixed and binding for this design: Phrase, Deck, Cadence, Step,
  Rep, Drill, Shuffle, Mix, Scan, Draft Phrase. See the app's own
  `docs/glossary.md` (being populated concurrently) for definitions.
- Explicitly out of scope / must not be implied by the UI: streaks, scores,
  due-counts, or any progress gamification. A Deck is not an Anki deck and has no
  scheduler.

## Brand Commitments

None recorded. No existing name treatment, logo, or visual identity beyond the
app name `phrase-drill`.

## Evidence on Hand

None — no screenshots, no existing UI, no user-supplied reference images. This is
a from-scratch interface design produced from written specification only.

## Product Principles

1. **Hands-free legibility over information density.** The Drill screen is read at
   arm's length while speaking; state must be readable as shape and colour, not
   as paragraphs.
2. **No gamification, ever.** No streaks, scores, due-counts, or progress framing
   that implies a spaced-repetition product. Stated explicitly and repeatedly in
   the domain notes — this is a hard constraint, not a style choice.
3. **Interruption is normal, not exceptional.** The screen-lock/backgrounding
   suspension of speech is guaranteed to happen constantly; the UI must expect it
   and recover visibly, never fail silently.
4. **One person, one phone, no server** shapes every screen: settings holds a
   personal API key and a backup, not an admin panel.

## Accessibility & Inclusion

Large-type, high-contrast requirement is functional, not decorative: the primary
user reads the Drill screen at arm's length while speaking aloud, effectively a
low-vision-adjacent use case even though she has no diagnosed impairment.
