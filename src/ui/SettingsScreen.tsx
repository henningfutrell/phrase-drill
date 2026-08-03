import { useEffect, useRef, useState } from 'react'

/** Plain presentation shape for the pinned voice — no adapter types cross into UI. */
export interface VoiceInfo {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
}

/** One entry in the curated voice catalogue, as this screen needs it — no
 * adapter type crosses into UI (mirrors `VoiceCatalogueEntry`). */
export interface VoiceOption {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
  readonly name: string
  readonly description: string
}

/** What a preview attempt resolved to — mirrors `SynthError`'s `kind`
 * without importing the adapter type. */
export type PreviewOutcome = { ok: true } | { ok: false; reason: 'unauthorized' | 'quota' | 'network' }

const PREVIEW_ERROR_COPY: Record<Exclude<PreviewOutcome, { ok: true }>['reason'], string> = {
  unauthorized: "That didn't play — the server isn't set up for speech yet. Ask whoever runs it to check.",
  quota: "That didn't play — this month's speech credit may be used up.",
  network: "That didn't play — check the connection and try again.",
}

/** What `onExportBackup` resolved to, for the one-line status shown after. */
export type ExportOutcome = 'shared' | 'cancelled' | 'downloaded'

/** Why a chosen restore file was refused — mirrors `ParseLibraryResult`'s
 * `reason` without this presentational component importing the adapter type. */
export type RestoreRefusal = { ok: false; reason: 'not-json' | 'wrong-format' | 'invalid' }
export type RestoreFileResult = { ok: true } | RestoreRefusal

const RESTORE_ERROR_COPY: Record<RestoreRefusal['reason'], string> = {
  'not-json': "That file wasn't able to be read as a backup — it may be damaged. Try exporting a fresh one.",
  'wrong-format': "That doesn't look like a phrase-drill backup. Choose the file that was saved from Export backup.",
  invalid: "That doesn't look like a phrase-drill backup. Choose the file that was saved from Export backup.",
}

const LIBRARY_KEY_PATTERN = /^[0-9a-f]{64}$/

/**
 * Settings — Sync (the library key), the voice picker, and backup/restore
 * (docs/design.md §3.6, amended by T041 to replace the two API key fields
 * with the library key). Purely presentational: every persist decision,
 * every synth call, every file read, and the actual share/download call are
 * the composition root's (App.tsx) — this component only describes the
 * choice and shows what the callbacks resolved to.
 *
 * Unlike the provider keys it replaces, the library key is shown in the
 * open, not masked: it has to be, since reading and copying it down
 * somewhere safe is the entire recovery story for a wiped or replaced
 * phone (T041).
 */
export function SettingsScreen({
  onBack,
  libraryKey,
  voice,
  voices,
  previewText,
  onUseLibraryKey,
  onPreviewVoice,
  onChooseVoice,
  onExportBackup,
  onRestoreFileChosen,
  onConfirmRestore,
  onCancelRestore,
  onOpenDiagnostics,
}: {
  onBack: () => void
  libraryKey: string
  voice: VoiceInfo | null
  voices: readonly VoiceOption[]
  previewText: string
  onUseLibraryKey: (key: string) => void
  onPreviewVoice: (
    voice: { modelId: string; voiceId: string },
    text: string,
    signal: AbortSignal,
  ) => Promise<PreviewOutcome>
  onChooseVoice: (voice: { provider: string; modelId: string; voiceId: string }) => void
  onExportBackup: () => Promise<ExportOutcome>
  onRestoreFileChosen: (file: File) => Promise<RestoreFileResult>
  onConfirmRestore: () => void
  onCancelRestore: () => void
  onOpenDiagnostics: () => void
}) {
  const [switchKeyInput, setSwitchKeyInput] = useState('')
  const [switchKeyError, setSwitchKeyError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [confirmingRestore, setConfirmingRestore] = useState(false)
  const restoreFileInput = useRef<HTMLInputElement>(null)
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const [confirmingVoice, setConfirmingVoice] = useState<VoiceOption | null>(null)

  useEffect(() => {
    return () => {
      previewController.current?.abort()
    }
  }, [])

  function handlePreviewVoice(entry: VoiceOption) {
    previewController.current?.abort()
    const controller = new AbortController()
    previewController.current = controller
    setPreviewError(null)
    setPreviewingVoiceId(entry.voiceId)

    onPreviewVoice({ modelId: entry.modelId, voiceId: entry.voiceId }, previewText, controller.signal)
      .then((outcome) => {
        if (previewController.current !== controller) return
        previewController.current = null
        setPreviewingVoiceId(null)
        if (!outcome.ok) setPreviewError(PREVIEW_ERROR_COPY[outcome.reason])
      })
      .catch(() => {
        if (previewController.current !== controller) return
        previewController.current = null
        setPreviewingVoiceId(null)
      })
  }

  function handleChooseVoice(entry: VoiceOption) {
    setConfirmingVoice(entry)
  }

  function handleConfirmVoice() {
    if (!confirmingVoice) return
    onChooseVoice({
      provider: confirmingVoice.provider,
      modelId: confirmingVoice.modelId,
      voiceId: confirmingVoice.voiceId,
    })
    setConfirmingVoice(null)
  }

  function handleCancelVoice() {
    setConfirmingVoice(null)
  }

  async function handleCopyLibraryKey() {
    try {
      await navigator.clipboard.writeText(libraryKey)
      setCopyStatus('Copied.')
    } catch {
      setCopyStatus('Could not copy — select and copy the key by hand.')
    }
  }

  function handleUseLibraryKey() {
    const candidate = switchKeyInput.trim().toLowerCase()
    if (!LIBRARY_KEY_PATTERN.test(candidate)) {
      setSwitchKeyError('That doesn’t look like a sync key — it should be 64 letters and numbers, with nothing else.')
      return
    }
    setSwitchKeyError(null)
    setSwitchKeyInput('')
    onUseLibraryKey(candidate)
  }

  async function handleExportBackup() {
    const outcome = await onExportBackup()
    if (outcome === 'shared') {
      setExportStatus('Backup shared.')
    } else if (outcome === 'downloaded') {
      setExportStatus('Sharing wasn’t available, so the backup downloaded instead — check Files, or wherever this browser saves downloads.')
    } else {
      setExportStatus(null)
    }
  }

  async function handleRestoreFileChange(files: FileList | null) {
    const file = files?.[0]
    if (restoreFileInput.current) restoreFileInput.current.value = ''
    if (!file) return

    setExportStatus(null)
    const result = await onRestoreFileChosen(file)
    if (result.ok) {
      setRestoreError(null)
      setConfirmingRestore(true)
    } else {
      setRestoreError(RESTORE_ERROR_COPY[result.reason])
      setConfirmingRestore(false)
    }
  }

  function handleConfirmRestore() {
    setConfirmingRestore(false)
    onConfirmRestore()
  }

  function handleCancelRestore() {
    setConfirmingRestore(false)
    onCancelRestore()
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <button type="button" data-testid="settings-back" className="link-action" onClick={onBack}>
          Back
        </button>
        <h1>Settings</h1>
        <span />
      </header>

      <section className="settings-section" data-testid="sync-section">
        <h2 className="settings-section-title">Sync</h2>
        <p className="settings-help">
          This is what makes your phrases yours on the server — write it down somewhere
          safe. If this phone is ever lost, wiped, or replaced, enter this same key on
          the new one and your phrases come back.
        </p>
        <p className="settings-help">Anyone who has this key can see and change your phrases, so keep it private.</p>
        <p className="sheet-label" data-testid="library-key-display" style={{ wordBreak: 'break-all' }}>
          {libraryKey}
        </p>
        <div className="settings-actions">
          <button type="button" data-testid="library-key-copy" className="btn-icon" onClick={() => void handleCopyLibraryKey()}>
            Copy
          </button>
        </div>
        {copyStatus && (
          <p className="settings-status settings-status--calm" data-testid="library-key-copy-status">
            {copyStatus}
          </p>
        )}

        <p className="settings-help">Setting up a phone that already has a key? Enter it here instead of using this one.</p>
        <input
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          data-testid="library-key-input"
          className="sheet-input"
          placeholder="Paste sync key"
          value={switchKeyInput}
          onChange={(e) => setSwitchKeyInput(e.target.value)}
        />
        <div className="settings-actions">
          <button
            type="button"
            data-testid="library-key-use"
            className="btn-primary"
            disabled={switchKeyInput.trim().length === 0}
            onClick={handleUseLibraryKey}
          >
            Use this key
          </button>
        </div>
        {switchKeyError && (
          <p className="settings-status" data-testid="library-key-error">
            {switchKeyError}
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">Voice</h2>
        <p className="settings-help">
          Pick who reads the French out loud. Tap Preview to hear a real phrase before
          choosing.
        </p>
        {!voice && (
          <p className="settings-status settings-status--calm" data-testid="voice-display">
            No voice chosen yet — pick one below.
          </p>
        )}
        <ul className="voice-list" data-testid="voice-list">
          {voices.map((entry) => {
            const isCurrent = voice?.voiceId === entry.voiceId && voice?.modelId === entry.modelId
            const isPreviewing = previewingVoiceId === entry.voiceId
            return (
              <li key={entry.voiceId} className="voice-option" data-testid={`voice-option-${entry.voiceId}`}>
                <p className="voice-option-name">
                  {entry.name}
                  {isCurrent && (
                    <span data-testid={`voice-current-${entry.voiceId}`} className="voice-current-badge">
                      {' '}
                      · Currently in use
                    </span>
                  )}
                </p>
                <p className="settings-help">{entry.description}</p>
                <div className="settings-actions">
                  <button
                    type="button"
                    data-testid={`voice-preview-${entry.voiceId}`}
                    className="btn-icon"
                    onClick={() => handlePreviewVoice(entry)}
                  >
                    {isPreviewing ? 'Playing…' : 'Preview'}
                  </button>
                  <button
                    type="button"
                    data-testid={`voice-choose-${entry.voiceId}`}
                    className="btn-primary"
                    disabled={isCurrent}
                    onClick={() => handleChooseVoice(entry)}
                  >
                    {isCurrent ? 'Current voice' : 'Use this voice'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
        {previewError && (
          <p className="settings-status" data-testid="voice-preview-error">
            {previewError}
          </p>
        )}
      </section>

      <section className="settings-section settings-section--backup" data-testid="backup-section">
        <h2 className="settings-section-title">Backup</h2>
        <p className="settings-help">
          Your phrases sync to the server automatically, but you can also save a backup
          file you keep or send yourself, for extra peace of mind.
        </p>
        <p className="settings-help">
          Saved audio isn't part of the backup — it's regenerated automatically the
          next time you're online, using the same voice, so it's normal for a restored
          phrase to be briefly silent while that catches up.
        </p>
        <button
          type="button"
          data-testid="export-backup"
          className="btn-primary"
          onClick={() => {
            void handleExportBackup()
          }}
        >
          Export backup
        </button>
        {exportStatus && (
          <p className="settings-status settings-status--calm" data-testid="export-status">
            {exportStatus}
          </p>
        )}

        <button
          type="button"
          data-testid="restore-backup"
          className="btn-icon"
          onClick={() => restoreFileInput.current?.click()}
        >
          Restore from backup
        </button>
        <input
          ref={restoreFileInput}
          type="file"
          accept="application/json,.json"
          data-testid="restore-file-input"
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleRestoreFileChange(e.target.files)
          }}
        />
        {restoreError && (
          <p className="settings-status" data-testid="restore-error">
            {restoreError}
          </p>
        )}
      </section>

      <section className="settings-section" data-testid="diagnostics-section">
        <h2 className="settings-section-title">Diagnostics</h2>
        <p className="settings-help">
          If something isn't working, open this and copy the report into a message —
          it says what's set up and what's gone wrong, never your phrases.
        </p>
        <button type="button" data-testid="open-diagnostics" className="btn-icon" onClick={onOpenDiagnostics}>
          Open diagnostics
        </button>
      </section>

      <p className="settings-help settings-privacy-note">
        This phone holds no server credentials — only your sync key, which stays on
        this phone unless you choose to copy it.
      </p>

      {confirmingVoice && (
        <div className="sheet" data-testid="voice-confirm-sheet">
          <p className="sheet-title">Switch to {confirmingVoice.name}?</p>
          <p className="sheet-label">
            The audio for every phrase will be made again in this voice — that takes a
            little while, so phrases will be briefly silent while it catches up.
          </p>
          <div className="sheet-actions">
            <button type="button" data-testid="voice-cancel" className="btn-secondary" onClick={handleCancelVoice}>
              Cancel
            </button>
            <button type="button" data-testid="voice-confirm" className="btn-primary" onClick={handleConfirmVoice}>
              Switch voice
            </button>
          </div>
        </div>
      )}

      {confirmingRestore && (
        <div className="sheet" data-testid="restore-confirm-sheet">
          <p className="sheet-title">This replaces everything currently saved.</p>
          <p className="sheet-label">
            Every Deck and Phrase on this phone will be replaced by what's in this
            backup file. This can't be undone. Are you sure?
          </p>
          <div className="sheet-actions">
            <button type="button" data-testid="restore-cancel" className="btn-secondary" onClick={handleCancelRestore}>
              Cancel
            </button>
            <button
              type="button"
              data-testid="restore-confirm"
              className="btn-primary btn-danger"
              onClick={handleConfirmRestore}
            >
              Replace my phrases
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
