import type { DeckStore, Library } from '../../domain'
import { withVoice } from '../storage/library'
import { sameVoice } from '../storage/library-identity'
import type { SettingsStore } from '../storage/settings-store'

export interface SyncedLibraryDeps {
  readonly deckStore: DeckStore
  readonly settingsStore: SettingsStore
}

export interface SyncedLibrary {
  /** The whole local library, as it is on this device right now. */
  readLocal(): Promise<Library>
  /** Replace the whole local library with an arriving one. */
  writeLocal(library: Library): Promise<void>
  /**
   * Read the whole local library, apply `update` to it, and write the result
   * back as one indivisible step (T074) — the sync path's write.
   *
   * `readLocal` then `writeLocal` is the pair this replaces there, and the gap
   * between them was where a Deck she saved mid-sync was lost. `update` runs
   * against what is stored at the instant of the write, so there is nothing
   * for a save to slip into. It must be pure and synchronous.
   *
   * `changed` covers the pinned voice as well as the records, because "did
   * this merge bring anything down?" is one question to the screen that asks
   * it, not two.
   */
  updateLocal(update: (stored: Library) => Library): Promise<{ library: Library; changed: boolean }>
}

/**
 * The two halves of what syncs — and what a backup file is — assembled in
 * one place (T067).
 *
 * The `Library` envelope is the deck store's (Decks, Mixes, Tombstones) plus
 * exactly one field from settings: the pinned voice. That field is joined on
 * here, by name, rather than by letting the deck store read the `settings`
 * store, and the distinction is the whole point. An export that reads a
 * store carries whatever that store holds, today and after the next feature;
 * an export that names its fields carries what somebody decided it should.
 * The pinned voice is a preference worth restoring on a new phone. Nothing
 * else in `settings` is, and nothing else gets out.
 *
 * A named module rather than three lines in the composition root because
 * both directions are testable behaviour: a fresh phone must end up with the
 * voice from the server copy, and an older envelope with no voice at all must
 * leave the local one alone.
 */
export function createSyncedLibrary(deps: SyncedLibraryDeps): SyncedLibrary {
  return {
    async readLocal(): Promise<Library> {
      const [library, settings] = await Promise.all([deps.deckStore.exportAll(), deps.settingsStore.load()])
      return withVoice(library, settings.voice)
    },

    async writeLocal(library: Library): Promise<void> {
      await deps.deckStore.importAll(library)
      // Absent leaves the local pin alone; present replaces it. Which of two
      // voices wins was decided before this — by `mergeLibraries` on the sync
      // path, and by her choosing the file on the restore path.
      await deps.settingsStore.adoptVoice(library.voice)
    },

    async updateLocal(update): Promise<{ library: Library; changed: boolean }> {
      // The voice is read before the deck store's transaction opens and
      // written after it closes: it lives in a different object store, reached
      // through a different connection, so no transaction can span both. That
      // leaves the pinned voice — and only the pinned voice — able to lose a
      // change made mid-sync, which costs one tap in Settings (T067). Her
      // Phrases are inside the transaction.
      const settings = await deps.settingsStore.load()
      const result = await deps.deckStore.updateAll((stored) => update(withVoice(stored, settings.voice)))
      await deps.settingsStore.adoptVoice(result.library.voice)
      return {
        library: result.library,
        changed: result.changed || !sameVoice(settings.voice, result.library.voice),
      }
    },
  }
}
