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
  unauthorized: "That didn't play — check the speech key above.",
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

/**
 * Settings — the two API keys, the voice picker, and backup/restore
 * (docs/design.md §3.6, amended by T019 §7 for the ElevenLabs key, by T016
 * for backup/restore, and by T026 for the previewable voice picker — the
 * voice is no longer display-only, and "the user" who picks it is the
 * friend who drills, not whoever set the app up). Purely presentational:
 * every persist decision, every synth call, every file read, and the actual
 * share/download call are the composition root's (App.tsx) — this component
 * only describes the choice and shows what the callbacks resolved to. A
 * key's actual value never reaches this component — only whether one is
 * present — so there is nothing here that could render it.
 */
export function SettingsScreen({
  onBack,
  anthropicKeyPresent,
  elevenLabsKeyPresent,
  voice,
  voices,
  previewText,
  onSaveAnthropicKey,
  onClearAnthropicKey,
  onSaveElevenLabsKey,
  onClearElevenLabsKey,
  onPreviewVoice,
  onChooseVoice,
  onExportBackup,
  onRestoreFileChosen,
  onConfirmRestore,
  onCancelRestore,
}: {
  onBack: () => void
  anthropicKeyPresent: boolean
  elevenLabsKeyPresent: boolean
  voice: VoiceInfo | null
  voices: readonly VoiceOption[]
  previewText: string
  onSaveAnthropicKey: (key: string) => void
  onClearAnthropicKey: () => void
  onSaveElevenLabsKey: (key: string) => void
  onClearElevenLabsKey: () => void
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
}) {
  const [anthropicInput, setAnthropicInput] = useState('')
  const [elevenLabsInput, setElevenLabsInput] = useState('')
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

      <section className="settings-section">
        <h2 className="settings-section-title">Handwriting scan key</h2>
        <p className="settings-help">
          Used only to read photos of handwritten phrases. It's scoped to this app's
          workspace and spend-capped — it can't run up a large bill.
        </p>
        <p className={anthropicKeyPresent ? 'settings-status' : 'settings-status settings-status--calm'}>
          {anthropicKeyPresent
            ? 'A key is saved.'
            : "No key yet — that's expected until whoever set up this app adds one. Scanning just waits."}
        </p>
        <input
          type="password"
          autoComplete="off"
          data-testid="anthropic-key-input"
          className="sheet-input"
          placeholder="Paste key"
          value={anthropicInput}
          onChange={(e) => setAnthropicInput(e.target.value)}
        />
        <div className="settings-actions">
          <button
            type="button"
            data-testid="anthropic-key-clear"
            className="btn-icon btn-danger"
            disabled={!anthropicKeyPresent}
            onClick={onClearAnthropicKey}
          >
            Clear
          </button>
          <button
            type="button"
            data-testid="anthropic-key-save"
            className="btn-primary"
            disabled={anthropicInput.trim().length === 0}
            onClick={() => {
              onSaveAnthropicKey(anthropicInput.trim())
              setAnthropicInput('')
            }}
          >
            Save
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">Speech key</h2>
        <p className="settings-help">
          Used only to turn phrases into spoken audio. It's scoped to text-to-speech
          and capped with a monthly credit limit.
        </p>
        <p className={elevenLabsKeyPresent ? 'settings-status' : 'settings-status settings-status--calm'}>
          {elevenLabsKeyPresent
            ? 'A key is saved.'
            : "No key yet — that's expected until whoever set up this app adds one. Existing audio keeps working; new phrases just wait for theirs."}
        </p>
        <input
          type="password"
          autoComplete="off"
          data-testid="elevenlabs-key-input"
          className="sheet-input"
          placeholder="Paste key"
          value={elevenLabsInput}
          onChange={(e) => setElevenLabsInput(e.target.value)}
        />
        <div className="settings-actions">
          <button
            type="button"
            data-testid="elevenlabs-key-clear"
            className="btn-icon btn-danger"
            disabled={!elevenLabsKeyPresent}
            onClick={onClearElevenLabsKey}
          >
            Clear
          </button>
          <button
            type="button"
            data-testid="elevenlabs-key-save"
            className="btn-primary"
            disabled={elevenLabsInput.trim().length === 0}
            onClick={() => {
              onSaveElevenLabsKey(elevenLabsInput.trim())
              setElevenLabsInput('')
            }}
          >
            Save
          </button>
        </div>
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
        {!elevenLabsKeyPresent && (
          <p className="settings-status settings-status--calm" data-testid="voice-preview-needs-key">
            Add the speech key above first — previewing a voice needs it.
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
                    disabled={!elevenLabsKeyPresent}
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
          Your phrases are saved on this phone only, and an iPhone can sometimes clear
          old app data if it hasn't been opened in a while. Save a backup you can keep
          or send yourself — then you can always get them back.
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

      <p className="settings-help settings-privacy-note">
        Keys stay on this phone. They're never put in a link, never written to a
        log, and never included in a backup you export.
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
