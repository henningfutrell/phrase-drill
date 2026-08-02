import { useState } from 'react'

/** Plain presentation shape for the pinned voice — no adapter types cross into UI. */
export interface VoiceInfo {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
}

/**
 * Settings — the two API keys and the pinned voice (docs/design.md §3.6,
 * amended by T019 §7 for the ElevenLabs key and voice display). Purely
 * presentational: every persist decision is the composition root's
 * (App.tsx). A key's actual value never reaches this component — only
 * whether one is present — so there is nothing here that could render it.
 */
export function SettingsScreen({
  onBack,
  anthropicKeyPresent,
  elevenLabsKeyPresent,
  voice,
  onSaveAnthropicKey,
  onClearAnthropicKey,
  onSaveElevenLabsKey,
  onClearElevenLabsKey,
}: {
  onBack: () => void
  anthropicKeyPresent: boolean
  elevenLabsKeyPresent: boolean
  voice: VoiceInfo | null
  onSaveAnthropicKey: (key: string) => void
  onClearAnthropicKey: () => void
  onSaveElevenLabsKey: (key: string) => void
  onClearElevenLabsKey: () => void
}) {
  const [anthropicInput, setAnthropicInput] = useState('')
  const [elevenLabsInput, setElevenLabsInput] = useState('')

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
        {voice ? (
          <>
            <p className="settings-status" data-testid="voice-display">
              {voice.provider} · {voice.modelId} · {voice.voiceId}
            </p>
            <p className="settings-help">
              Changing this later regenerates every phrase's audio from scratch — it
              isn't a quick swap, so it's only done deliberately, by whoever set up
              this app.
            </p>
          </>
        ) : (
          <p className="settings-status settings-status--calm" data-testid="voice-display">
            No voice chosen yet — that's set up once, ask Henning.
          </p>
        )}
      </section>

      <p className="settings-help settings-privacy-note">
        Keys stay on this phone. They're never put in a link, never written to a
        log, and never included in a backup you export.
      </p>
    </main>
  )
}
