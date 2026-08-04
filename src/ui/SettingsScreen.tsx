import { useEffect, useRef, useState } from 'react'
import type { BackupAge } from '../domain'
import { BackupStatus, type ExportOutcome } from './BackupStatus'
import { RestoreControl, type RestoreFileResult } from './RestoreControl'

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

export type { ExportOutcome, RestoreFileResult }

/**
 * Settings — the voice picker and backup/restore (docs/design.md §3.6). Her
 * identity on the server is a session token from a plain login form (T050),
 * not a key this screen shows or lets her paste in — the Sync section that used to do that
 * is gone entirely: log-in/out lives wherever the app puts an
 * account-status affordance, not here. Purely presentational: every persist
 * decision, every synth call, every file read, and the actual share/download
 * call are the composition root's (App.tsx) — this component only describes
 * the choice and shows what the callbacks resolved to.
 */
export function SettingsScreen({
  onBack,
  voice,
  voices,
  previewText,
  onPreviewVoice,
  onChooseVoice,
  backupAge,
  onExportBackup,
  onCopyText,
  onRestoreFileChosen,
  onConfirmRestore,
  onCancelRestore,
  onOpenDiagnostics,
}: {
  onBack: () => void
  voice: VoiceInfo | null
  voices: readonly VoiceOption[]
  previewText: string
  onPreviewVoice: (
    voice: { provider: string; modelId: string; voiceId: string },
    text: string,
    signal: AbortSignal,
  ) => Promise<PreviewOutcome>
  onChooseVoice: (voice: { provider: string; modelId: string; voiceId: string }) => void
  backupAge: BackupAge
  onExportBackup: () => Promise<ExportOutcome>
  onCopyText?: (text: string) => Promise<boolean>
  onRestoreFileChosen: (file: File) => Promise<RestoreFileResult>
  onConfirmRestore: () => void
  onCancelRestore: () => void
  onOpenDiagnostics: () => void
}) {
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

    onPreviewVoice({ provider: entry.provider, modelId: entry.modelId, voiceId: entry.voiceId }, previewText, controller.signal)
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

  return (
    <main className="screen">
      <header className="screen-header">
        <button type="button" data-testid="settings-back" className="link-action" onClick={onBack}>
          Back
        </button>
        <h1>Settings</h1>
        <span />
      </header>

      <section className="settings-section settings-section--backup" data-testid="backup-section">
        <h2 className="settings-section-title">Backup</h2>
        <BackupStatus age={backupAge} onExportBackup={onExportBackup} onCopyText={onCopyText} />
        <p className="settings-help">
          Your phrases sync to the server automatically, but you can also save a backup
          file you keep or send yourself, for extra peace of mind.
        </p>
        <p className="settings-help">
          Saved audio isn't part of the backup — it's regenerated automatically the
          next time you're online, using the same voice, so it's normal for a restored
          phrase to be briefly silent while that catches up.
        </p>
        <RestoreControl
          onRestoreFileChosen={onRestoreFileChosen}
          onConfirmRestore={onConfirmRestore}
          onCancelRestore={onCancelRestore}
        />
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
        This phone holds no server credentials — you're signed in through the server's
        own login, the same as any other account.
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

    </main>
  )
}
