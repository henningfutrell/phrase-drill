/**
 * Copies text to the clipboard, reporting success or failure honestly rather
 * than throwing — the one control in DiagnosticsScreen that copies the whole
 * report needs a plain yes/no to show her, not an uncaught rejection.
 * `clipboard` is injectable (defaults to `globalThis.navigator?.clipboard`)
 * so this is testable without a real browser Clipboard API.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard?.writeText) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
