/**
 * What she is told when this phone refused to store a change (T069).
 *
 * Every write in this app is optimistic — the screen changes first and the
 * store is written after — because a phone that waits on IndexedDB before
 * showing a Phrase feels broken. The price of that is a rejected write
 * (a full origin, a transaction iOS aborted, a `versionchange` from another
 * surface) leaving a Phrase on screen that is not on disk. She scans a page,
 * sees ten Phrases, closes the app, and they are gone.
 *
 * So a rejected write does two things and needs both. The screen is put back
 * to what is really stored — otherwise she is looking at proof that it saved
 * — and this says so, in words that name the thing she changed and tell her
 * what to do. It is the only alert in the app, which is what keeps it worth
 * reading: the sync line is standing information about the *server*, and it
 * is deliberately quiet because there is nothing there for her to do.
 *
 * Dismissible on purpose. An alert she cannot clear is one she learns to look
 * past, and this one has to survive being seen twice.
 */
export function WriteFailureNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="write-failure" role="alert" data-testid="write-failure">
      <p className="write-failure-message">{message}</p>
      <p className="write-failure-detail">
        This phone may be out of space. What is on the screen now is what is really saved here.
      </p>
      <button
        type="button"
        className="btn-secondary"
        data-testid="write-failure-dismiss"
        onClick={onDismiss}
      >
        OK
      </button>
    </div>
  )
}
