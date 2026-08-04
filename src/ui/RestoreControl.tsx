import { useRef, useState } from 'react'

/** Why a chosen restore file was refused — mirrors `ParseLibraryResult`'s
 * `reason` without this presentational component importing the adapter type. */
export type RestoreRefusal = {
  ok: false
  reason: 'not-json' | 'wrong-format' | 'invalid' | 'needs-update' | 'empty'
}
export type RestoreFileResult = { ok: true } | RestoreRefusal

const RESTORE_ERROR_COPY: Record<RestoreRefusal['reason'], string> = {
  'not-json': "That file wasn't able to be read as a backup — it may be damaged. Try exporting a fresh one.",
  'wrong-format': "That doesn't look like a phrase-drill backup. Choose the file that was saved from Export backup.",
  invalid: "That doesn't look like a phrase-drill backup. Choose the file that was saved from Export backup.",
  // Both of these are refusals of a file that would otherwise have cleared
  // every Deck she has (T070). Each says what was wrong with the FILE, so it
  // never reads as something being wrong with her phrases.
  'needs-update': 'That backup was saved by a newer version of this app. Update the app on this phone first — nothing on it has been changed.',
  empty: "That backup file has nothing in it — no decks and no phrases. Restoring it would have replaced everything on this phone with nothing, so it wasn't used.",
}

/**
 * Choose a backup file, and confirm before it replaces anything.
 *
 * Shared, because restore has to exist in two places at once: in Settings,
 * where someone deliberately looking for it goes, and on the Decks empty
 * state, which is the screen a wiped or replaced phone actually opens on and
 * the only screen she will be looking at when her phrases are gone. One
 * component so the confirmation, the refusal copy, and the file-input
 * behaviour cannot drift apart between the calm path and the panicking one.
 *
 * Purely presentational: it reads no file and writes no storage. The caller
 * parses the file (`onRestoreFileChosen`) and performs the replacement
 * (`onConfirmRestore`).
 */
export function RestoreControl({
  onRestoreFileChosen,
  onConfirmRestore,
  onCancelRestore,
  label = 'Restore from backup',
  className = 'btn-icon',
}: {
  onRestoreFileChosen: (file: File) => Promise<RestoreFileResult>
  onConfirmRestore: () => void
  onCancelRestore: () => void
  label?: string
  className?: string
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function handleFileChange(files: FileList | null): Promise<void> {
    const file = files?.[0]
    // Reset first, so choosing the same file twice still fires a change event.
    if (fileInput.current) fileInput.current.value = ''
    if (!file) return

    const result = await onRestoreFileChosen(file)
    if (result.ok) {
      setError(null)
      setConfirming(true)
    } else {
      setError(RESTORE_ERROR_COPY[result.reason])
      setConfirming(false)
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="restore-backup"
        className={className}
        onClick={() => fileInput.current?.click()}
      >
        {label}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        data-testid="restore-file-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleFileChange(e.target.files)
        }}
      />
      {error && (
        <p className="settings-status" data-testid="restore-error">
          {error}
        </p>
      )}

      {confirming && (
        <div className="sheet" data-testid="restore-confirm-sheet">
          <p className="sheet-title">This replaces everything currently saved.</p>
          <p className="sheet-label">
            Every Deck and Phrase on this phone will be replaced by what&apos;s in this backup file.
            This can&apos;t be undone. Are you sure?
          </p>
          <div className="sheet-actions">
            <button
              type="button"
              data-testid="restore-cancel"
              className="btn-secondary"
              onClick={() => {
                setConfirming(false)
                onCancelRestore()
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="restore-confirm"
              className="btn-primary btn-danger"
              onClick={() => {
                setConfirming(false)
                onConfirmRestore()
              }}
            >
              Replace my phrases
            </button>
          </div>
        </div>
      )}
    </>
  )
}
