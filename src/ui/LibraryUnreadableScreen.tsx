import { RestoreControl, type RestoreFileResult } from './RestoreControl'

/**
 * What she is looking at when this phone would not open its storage at launch
 * (T083, from the T079 audit's finding 7).
 *
 * Every write goes through `persistLocally`, which rolls the screens back and
 * raises the T069 notice. A READ that is refused at mount is a different
 * moment: there is no screen to roll back to, because no screen ever rendered.
 * `decks` stays `undefined`, and what she got was a bare `<main>` — a blank
 * page, on the app that holds phrases written nowhere else. That is
 * indistinguishable from a broken phone, and the reasonable next thing for a
 * non-technical person to do is delete the app and install it again, which on
 * iOS discards the origin's storage for real. The blank screen is therefore
 * not a cosmetic failure; it is the step before the destructive one.
 *
 * So this screen exists to do two things.
 *
 * **Say what happened, and no more than what happened.** The storage did not
 * open. That is all anyone knows — the data behind it is very probably intact,
 * and an evicted origin, a full disk and a `VersionError` from a rolled-back
 * build all look identical from here. Saying anything stronger would send her
 * to reinstall, and reinstalling is the one action that turns a recoverable
 * morning into an unrecoverable one. The copy says the opposite out loud
 * rather than leaving it implied.
 *
 * **Carry Restore.** `RestoreControl` lives on the Decks empty state because
 * that is "the screen a wiped or replaced phone actually opens on"
 * (`RestoreControl.tsx`) — and the Decks screen is inside the tree that never
 * mounted here. The failure that most needs Restore was exactly the failure
 * that hid it. It is the same component, so the confirmation, the refusal copy
 * and the file-input behaviour cannot drift between this path and the calm one.
 *
 * Purely presentational, like `RestoreControl` itself: it reads no file and
 * writes no storage.
 */
export function LibraryUnreadableScreen({
  onRestoreFileChosen,
  onConfirmRestore,
  onCancelRestore,
}: {
  onRestoreFileChosen: (file: File) => Promise<RestoreFileResult>
  onConfirmRestore: () => void
  onCancelRestore: () => void
}) {
  return (
    <main className="screen" data-testid="library-unreadable">
      <header className="screen-header">
        <h1>Your phrases could not be opened</h1>
      </header>

      <p className="empty-state">
        This phone could not open the place your phrases are kept, so there is nothing to show
        yet. Your phrases have not been deleted.
      </p>

      <p className="settings-help">
        Close this app completely and open it again — that is usually enough. Do not delete this
        app: deleting it also removes what is still saved on this phone.
      </p>

      <div className="empty-state-recovery">
        <p className="settings-help">Have a backup file? You can put it back now.</p>
        <RestoreControl
          label="Restore from a backup file"
          onRestoreFileChosen={onRestoreFileChosen}
          onConfirmRestore={onConfirmRestore}
          onCancelRestore={onCancelRestore}
        />
      </div>
    </main>
  )
}
