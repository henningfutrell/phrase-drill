import { useState } from 'react'

/**
 * Diagnostics (T039) — "be able to answer 'it's not working' without
 * guessing." Shows the formatted report text (built by
 * `adapters/diagnostics/diagnostics-report.ts`) and one control that copies
 * it whole, for pasting into a message. Purely presentational: gathering the
 * snapshot and formatting it is the composition root's job (App.tsx); this
 * component only shows what's ready and reports what the copy attempt did.
 */
export function DiagnosticsScreen({
  onBack,
  reportText,
  onCopyReport,
}: {
  onBack: () => void
  reportText: string | undefined
  onCopyReport: (text: string) => Promise<boolean>
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null)

  async function handleCopy() {
    if (!reportText) return
    const ok = await onCopyReport(reportText)
    setCopyStatus(ok ? 'Copied.' : "Couldn't copy — select and copy the text below instead.")
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <button type="button" data-testid="diagnostics-back" className="link-action" onClick={onBack}>
          Back
        </button>
        <h1>Diagnostics</h1>
        <span />
      </header>

      {reportText === undefined ? (
        <p className="settings-status settings-status--calm" data-testid="diagnostics-loading">
          Gathering diagnostics…
        </p>
      ) : (
        <>
          <button type="button" data-testid="copy-diagnostics-report" className="btn-primary" onClick={() => void handleCopy()}>
            Copy report
          </button>
          {copyStatus && (
            <p className="settings-status settings-status--calm" data-testid="copy-status">
              {copyStatus}
            </p>
          )}
          <pre className="diagnostics-report" data-testid="diagnostics-report">
            {reportText}
          </pre>
        </>
      )}
    </main>
  )
}
