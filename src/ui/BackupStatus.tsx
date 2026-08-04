import { useState } from 'react'
import type { BackupAge, BackupAgeLevel } from '../domain'

/**
 * What an export attempt actually resolved to. `unavailable` is not an error
 * — it is the honest outcome on a platform where no file can be written, and
 * it carries the backup text so this component can offer it to be copied
 * instead of claiming a file appeared somewhere. See App.tsx for why an
 * installed iOS web app has no download path at all.
 */
export type ExportOutcome =
  | { kind: 'shared' }
  | { kind: 'cancelled' }
  | { kind: 'downloaded' }
  | { kind: 'unavailable'; text: string; filename: string }

const AGE_COPY: Record<BackupAgeLevel, (days: number) => string> = {
  never: () => 'Not backed up yet.',
  fresh: sinceCopy,
  aging: sinceCopy,
  overdue: sinceCopy,
}

function sinceCopy(days: number): string {
  if (days === 0) return 'Backed up today.'
  if (days === 1) return 'Backed up yesterday.'
  return `Backed up ${days} days ago.`
}

/**
 * The one line of consequence, added as the age climbs. Fresh says nothing
 * beyond the age itself: a warning that is always on is a warning that is
 * never read.
 */
const DETAIL_COPY: Record<BackupAgeLevel, string | null> = {
  fresh: null,
  aging: 'Anything added since then is only on this phone.',
  never: 'Everything here is only on this phone. Nothing has reached the server or a file yet.',
  overdue:
    'Everything added since then is only on this phone. If it is lost or replaced, that work goes with it.',
}

const ACTION_COPY: Record<BackupAgeLevel, string> = {
  fresh: 'Save a copy',
  aging: 'Save a copy',
  never: 'Save a copy now',
  overdue: 'Save a copy now',
}

/**
 * Escalation in weight, not in noise: a link, a quiet button, then the rose.
 *
 * `never` sits at the top with `overdue`, not beside `aging`, and a render is
 * what made that obvious: "not backed up yet" with twenty-nine phrases on the
 * phone is strictly worse than "backed up twelve days ago", and giving it the
 * middle treatment said the opposite.
 */
const ACTION_CLASS: Record<BackupAgeLevel, string> = {
  fresh: 'link-action',
  aging: 'btn-icon',
  never: 'btn-primary',
  overdue: 'btn-primary',
}

/**
 * `downloaded` says less than `shared` on purpose (T085). A share sheet
 * reports back — the file reached Files, or Messages, or she backed out — and
 * that answer is what lets the app say "saved" and start the Backup age
 * again. A download reports nothing at all, so the age above this line does
 * not move, and the copy has to explain that rather than leave her reading a
 * warning that appears to have ignored what she just did.
 */
const RESULT_COPY: Record<'shared' | 'downloaded', string> = {
  shared: 'Backup saved.',
  downloaded:
    'Sent to downloads — look in Files, or wherever this browser puts them. This browser can’t tell the app whether it arrived, so check it is there.',
}

/**
 * How long since the library was last safe somewhere else, and the one action
 * that changes the answer.
 *
 * Deliberately not dismissible, at any level. It replaces a dismiss-once
 * nudge (T027), which retired itself for good the first time she tapped "Got
 * it" — after which the app never mentioned durability again. Purely
 * presentational: the age is computed by `domain/backup-age`, and the export
 * itself is the composition root's.
 */
export function BackupStatus({
  age,
  onExportBackup,
  onCopyText,
}: {
  age: BackupAge
  onExportBackup: () => Promise<ExportOutcome>
  /**
   * Resolves `true` when the text reached the clipboard. Reached only on the
   * fallback path, so it is optional: a caller that has no clipboard port to
   * offer still shows the backup text and tells her to select it by hand,
   * which is a real degradation rather than a hidden one.
   */
  onCopyText?: (text: string) => Promise<boolean>
}) {
  const [result, setResult] = useState<string | null>(null)
  const [copySheet, setCopySheet] = useState<{ text: string; filename: string } | null>(null)
  const [copyResult, setCopyResult] = useState<string | null>(null)

  async function handleExport(): Promise<void> {
    setResult(null)
    const outcome = await onExportBackup()
    if (outcome.kind === 'unavailable') {
      setCopyResult(null)
      setCopySheet({ text: outcome.text, filename: outcome.filename })
      return
    }
    // A cancelled share is her choosing not to, not a failure. Say nothing.
    if (outcome.kind === 'cancelled') return
    setResult(RESULT_COPY[outcome.kind])
  }

  async function handleCopy(): Promise<void> {
    if (!copySheet || !onCopyText) return
    const copied = await onCopyText(copySheet.text)
    setCopyResult(
      copied
        ? 'Copied. Paste it into Notes or a message to yourself and keep it.'
        : 'The clipboard refused. You can still select it and copy it by hand.',
    )
  }

  const detail = DETAIL_COPY[age.level]

  return (
    <section
      className={`backup-status backup-status--${age.level}`}
      data-testid="backup-status"
      data-level={age.level}
    >
      <p className="backup-status-age" data-testid="backup-status-age">
        {AGE_COPY[age.level](age.days)}
      </p>
      {detail && (
        <p className="backup-status-detail" data-testid="backup-status-detail">
          {detail}
        </p>
      )}
      <button
        type="button"
        data-testid="backup-status-export"
        className={ACTION_CLASS[age.level]}
        onClick={() => {
          void handleExport()
        }}
      >
        {ACTION_COPY[age.level]}
      </button>
      {result && (
        <p className="settings-status settings-status--calm" data-testid="backup-status-result">
          {result}
        </p>
      )}

      {copySheet && (
        <div className="sheet" data-testid="backup-copy-sheet">
          <p className="sheet-title">Copy your backup</p>
          <p className="sheet-label">
            This phone can’t save the file directly from an installed app. Copy the text below and
            keep it somewhere — Notes, or a message to yourself. Pasting it into a file named{' '}
            {copySheet.filename} restores it later.
            {!onCopyText && ' Select it and copy it by hand.'}
          </p>
          <textarea
            className="sheet-input backup-copy-text"
            data-testid="backup-copy-text"
            readOnly
            rows={6}
            value={copySheet.text}
          />
          {copyResult && (
            <p className="settings-status settings-status--calm" data-testid="backup-copy-result">
              {copyResult}
            </p>
          )}
          <div className="sheet-actions">
            <button
              type="button"
              data-testid="backup-copy-done"
              className="btn-secondary"
              onClick={() => setCopySheet(null)}
            >
              Done
            </button>
            {onCopyText && (
              <button
                type="button"
                data-testid="backup-copy"
                className="btn-primary"
                onClick={() => {
                  void handleCopy()
                }}
              >
                Copy
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
