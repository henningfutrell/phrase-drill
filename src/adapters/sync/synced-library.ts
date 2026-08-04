import type { DeckStore, Library } from '../../domain'
import { withVoice } from '../storage/library'
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
  }
}
