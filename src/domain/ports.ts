/**
 * The domain declares these ports; it never implements them. Adapters live
 * outside the domain and satisfy these interfaces with real I/O (audio output,
 * a timer, IndexedDB, a vision API). Tests inject fakes at these seams and
 * nowhere else.
 */

import type { Deck, DeckId } from './deck'
import type { Mix, MixId } from './mix'
import type { Passage, PassageId } from './passage'
import type { Voice } from './voice'

/** Closed on purpose — widening it later is a type change, not a data migration. */
export type Language = 'fr-FR' | 'en-US'

export interface SpeechPort {
  /** Speak text aloud in the given language. Resolves when the utterance ends. */
  speak(text: string, lang: Language): Promise<void>
  /** Stop any current utterance immediately. Safe when idle. */
  cancel(): void
}

export interface ClockPort {
  /** Resolve after ms. Cancellable via the given AbortSignal. */
  wait(ms: number, signal?: AbortSignal): Promise<void>
}

/** The two halves of a Phrase, as they sit on disk — plain data, no I/O. */
export interface PhraseRecord {
  readonly id: string
  readonly french: string
  readonly english: string
}

/**
 * A French/English pair proposed from a Scan, before review. Never a Phrase —
 * it has no id and reaches storage only once a person confirms it.
 */
export interface DraftPhrase {
  readonly french: string
  readonly english: string
}

/**
 * A Deck as it sits on disk: the domain shape plus the bookkeeping the
 * domain itself has no use for (when it was created/last touched). The
 * *current* schema version — an adapter's own historical shapes and
 * migrations between them are the adapter's concern, not the domain's.
 */
export interface DeckRecord {
  readonly id: string
  readonly name: string
  readonly phrases: readonly PhraseRecord[]
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * A saved Mix as it sits on disk: the domain shape plus the same
 * bookkeeping a DeckRecord carries. Deck *ids* only — a Mix that copied
 * Phrases would go stale the moment a Deck was edited.
 */
export interface MixRecord {
  readonly id: string
  readonly name: string
  readonly deckIds: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * A Passage as it sits on disk: the domain shape plus the same
 * `createdAt`/`updatedAt` bookkeeping a DeckRecord and a MixRecord carry.
 * Its whole content is `name` and `text` — a Passage has no interior list,
 * which is why the merge treats it whole-record like a Mix rather than
 * per-element like a Deck (`library-merge.ts`).
 */
export interface PassageRecord {
  readonly id: string
  readonly name: string
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
}

export const LIBRARY_FORMAT = 'phrase-drill-library'

/**
 * The record that a Deck, a Mix or a Passage was deleted, and when (T060). It
 * outlives the thing it names, on purpose.
 *
 * Sync merges two libraries instead of overwriting one with the other, and
 * a merge cannot tell "absent because the user deleted it" from "absent because
 * this device has never seen it" — absence alone means both. Without this
 * record the safe merge is a union, and a union makes a delete impossible:
 * every device that still holds the Deck pushes it back. So a deletion is
 * itself data, and it travels in the `Library` envelope like everything
 * else that is theirs.
 *
 * `kind` is not decoration: Deck, Mix and Passage ids all live in one
 * namespace here, so an id alone names up to three different aggregates. The
 * merge therefore matches a Tombstone on `kind` AND `id`, and a Tombstone
 * deletes exactly the aggregate it was written for.
 */
export interface Tombstone {
  readonly id: string
  readonly kind: 'deck' | 'mix' | 'passage'
  readonly deletedAt: number
}

/**
 * A whole-library snapshot for export/import — also the recovery path for
 * iOS's IndexedDB eviction, and the body of the `/api/library` sync
 * envelope.
 *
 * `importAll` still replaces the whole library, and a restore from a backup
 * file still never merges. Sync is the one path that does merge, through
 * `mergeLibraries` (library-merge.ts) — because there the two sides are two
 * of their own devices rather than a file the user chose, and replacing one with
 * the other deletes whatever only the loser had (T060).
 */
export interface Library {
  readonly format: typeof LIBRARY_FORMAT
  readonly schemaVersion: number
  readonly exportedAt: number
  readonly decks: readonly DeckRecord[]
  /**
   * Saved Mixes travel with the Decks (T059): they are their data, and a
   * library that left them behind would lose them on a new phone. Optional
   * because every backup written before schema v4 has no such field at all
   * — absent means "no saved Mixes", never "invalid file".
   */
  readonly mixes?: readonly MixRecord[]
  /**
   * Long-form Passages travel with the Decks, for the same reason the
   * Mixes do: they are text the user typed, and a library that left them behind
   * would lose them on a new phone. Optional for the same reason `mixes` and
   * `tombstones` are: every envelope written before schema v7 has no such
   * field, and absent means "no Passages" — never "invalid file", and never
   * "clear their Passages".
   */
  readonly passages?: readonly PassageRecord[]
  /**
   * What has been deleted, so a merge can tell a deletion from an absence
   * (T060). Optional for the same reason `mixes` is: every envelope written
   * before schema v5 has no such field, and absent means "nothing known to
   * be deleted", never "invalid file".
   */
  readonly tombstones?: readonly Tombstone[]
  /**
   * The voice pinned on the device that wrote this envelope (T067). Carried
   * so a new phone restores the preference instead of leaving them to guess
   * which voice the user had.
   *
   * **Named explicitly, rather than exporting the settings record.** The
   * export deliberately does not read the `settings` store, and what crosses
   * the wire is enumerated here field by field — the store's other contents
   * have no route out.
   *
   * Optional for the same reason `mixes` and `tombstones` are: an envelope
   * written before T067 has no such field, and absent means "no voice
   * recorded", never "invalid file" and never "clear the voice".
   *
   * It cannot invalidate anything. Since T067 a Clip is playable in the
   * voice it was made in, so the pinned voice decides only what the next new
   * Phrase is generated in — which is what makes plain last-writer-wins the
   * right merge rule for it (`library-merge.ts`).
   */
  readonly voice?: Voice
}

export interface DeckStore {
  loadAll(): Promise<Deck[]>
  get(id: DeckId): Promise<Deck | undefined>
  /**
   * Whole-aggregate put: insert or replace. No transaction spans stores.
   *
   * For a Deck that does not exist yet — a freshly generated id, with nothing
   * stored under it to overwrite. **Changing one that does exist goes through
   * `update`**, and the difference is not stylistic: a put carries a whole
   * Deck computed somewhere else and some time ago, and anything written under
   * that id in between is gone (T075).
   */
  save(deck: Deck): Promise<void>
  /**
   * Read one Deck, apply `apply` to it, and write the result back — as ONE
   * indivisible step (T075). Resolves with the Deck that was written.
   *
   * This is `updateAll` at the scale of a single Deck, and it exists for the
   * same reason. The composition root holds their library in React state, which
   * is a VIEW: a merge can write a Phrase from their other phone between the
   * render the user tapped and the moment that tap reaches storage. `save` of a
   * Deck built from that view then writes the Phrase away — and the Sync
   * Baseline holds it while the local Deck does not, which `mergePhrases`
   * reads as a deletion (T070) and takes to the server on the next round-trip.
   * `apply` is instead handed the Deck as it is stored at the instant of the
   * write, so their change and the merged Phrase both survive.
   *
   * `apply` must be pure and synchronous — the store is held open across it,
   * and anything awaited in there reopens the window it exists to close. It
   * must return a Deck with the id it was asked for.
   *
   * `stored` is `undefined` when this device no longer holds that Deck (a
   * merge deleted it, or the user did on the other phone). It is the caller's
   * decision what that means; the composition root falls back to what is on
   * screen, so an edit the user is part-way through is never dropped by it.
   */
  update(id: DeckId, apply: (stored: Deck | undefined) => Deck): Promise<Deck>
  remove(id: DeckId): Promise<void>
  /** Whole-library snapshot: Decks, Mixes and Tombstones. Reads no settings
   * — the pinned voice is joined onto the envelope by name, outside this
   * port (`adapters/sync/synced-library.ts`). */
  exportAll(): Promise<Library>
  /** Replaces the whole library. Never merges. */
  importAll(library: Library): Promise<void>
  /**
   * Read the whole library, apply `update` to it, and write the result back —
   * as ONE indivisible step (T074).
   *
   * `exportAll` then `importAll` is not the same thing and cost them a Deck:
   * between the two, a save the user made was computed away by a library that was
   * read before the user typed it. `update` is instead handed what is stored at the
   * instant of the write, so there is no window for anything to land in. It
   * must be pure and synchronous for exactly that reason — the store is held
   * open across it, and anything awaited in there would reopen the window it
   * exists to close.
   *
   * `changed` says whether anything was actually written, so a caller can tell
   * a merge that brought something down from one that brought nothing.
   */
  updateAll(update: (stored: Library) => Library): Promise<{ library: Library; changed: boolean }>
}

/**
 * Saved Mixes (T059). Separate from `DeckStore` because a Mix is its own
 * aggregate with its own lifetime: deleting one must never reach a Deck,
 * and deleting a Deck must never reach a Mix. Whole-library export/import
 * stays on `DeckStore`, which owns the one `Library` envelope both stores
 * travel in.
 */
export interface MixStore {
  loadAll(): Promise<Mix[]>
  /** Whole-aggregate put: insert or replace. */
  save(mix: Mix): Promise<void>
  remove(id: MixId): Promise<void>
}

/**
 * Long-form Passages. Its own store for the same reason a Mix has
 * one: a Passage is its own aggregate with its own lifetime, and deleting
 * one must never reach a Deck. Whole-library export/import stays on
 * `DeckStore`, which owns the one `Library` envelope every store travels in.
 *
 * **No `update(id, apply)`, unlike `DeckStore`.** That transaction exists
 * because a Deck holds many Phrases: a merge can land one between the render
 * the user tapped and the write, and a whole-Deck put computed from the stale
 * render would write it away (T075). A Passage's whole content is one text
 * field, so there is no such thing as a merged part of it to lose —
 * last-writer-wins is already its merge rule, in `library-merge.ts` and here
 * alike, and a read-apply-write transaction would buy nothing. It matches
 * `MixStore`, which is a flat record for the same reason.
 */
export interface PassageStore {
  loadAll(): Promise<Passage[]>
  /** Whole-aggregate put: insert or replace. */
  save(passage: Passage): Promise<void>
  remove(id: PassageId): Promise<void>
}

/**
 * Why a Scan could not be turned into Draft Phrases. An empty array from
 * `read` is not this — it is the honest result of a photo with no phrases on
 * it. This type exists only for genuine failure.
 */
export type ScanError =
  | { kind: 'unauthorized' }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'network'; detail: string }

export interface ScanReader {
  /**
   * Read a Scan (one photo) and propose Draft Phrases from it. Resolves to
   * `[]` when the photo genuinely contains no phrases — that is a successful
   * read, not a failure. Rejects with a ScanError only when the read itself
   * could not be completed.
   */
  read(image: Blob, signal?: AbortSignal): Promise<DraftPhrase[]>
}

/** Which side of a Phrase is being translated into which (T057). */
export type TranslateDirection = 'en-to-fr' | 'fr-to-en'

/**
 * A machine-proposed rendering of the other side of a Phrase, before review
 * (T057). Optionally labelled with the register it represents (tu/vous,
 * formal/casual) only when the phrase actually supports more than one
 * natural rendering — a phrase with one natural rendering carries no label,
 * and that is a correct, complete result, not a degraded one. Exists only
 * until reviewed; becomes a Phrase, paired with the text already known, only
 * once explicitly accepted into a chosen Deck.
 */
export interface PhraseCandidate {
  readonly text: string
  readonly register?: string
}

/**
 * Why a translation could not be proposed. An empty array from `translate`
 * is not this — it is the honest result of nothing worth proposing. This
 * type exists only for genuine failure.
 */
export type TranslateError =
  | { kind: 'unauthorized' }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'network'; detail: string }

export interface Translator {
  /**
   * Propose one or more Phrase Candidates translating `text` in `direction`.
   * `deckName` biases register (tu/vous, formal/casual) without fixing it —
   * the model interprets the name (`home`, `friends`, `work`, `formal`,
   * `climbing`, ...); a neutral default applies when the name gives no clue.
   * Resolves to `[]` only when genuinely nothing could be proposed; rejects
   * with a TranslateError only when the call itself could not complete.
   */
  translate(
    text: string,
    direction: TranslateDirection,
    deckName: string,
    signal?: AbortSignal,
  ): Promise<PhraseCandidate[]>
}
