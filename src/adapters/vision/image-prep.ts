/**
 * Re-encodes a Scan photo (whatever format the camera produced, including
 * HEIC) as JPEG and downscales it before upload.
 *
 * iOS Safari can decode HEIC through `createImageBitmap` by delegating to
 * the OS's own licensed HEVC decoder — the same one iOS uses to play video.
 * That only holds on Safari/iOS/macOS: Chrome and Firefox ship no HEIC
 * decoder at all, so this function would silently fail to decode there.
 * This app targets iOS Safari exclusively (see AGENTS.md), so that is the
 * only platform this needs to work on.
 */

const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.85

export interface PreparedImage {
  readonly base64: string
  readonly mediaType: string
}

export async function prepareImageForUpload(image: Blob): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(image)
  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('canvas 2d context unavailable')
    }

    // HEIC supports transparency; JPEG does not. Fill white first so a
    // transparent source doesn't turn black on re-encode.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)

    const jpeg = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('canvas JPEG encode failed'))),
        'image/jpeg',
        JPEG_QUALITY,
      )
    })

    return { base64: await blobToBase64(jpeg), mediaType: 'image/jpeg' }
  } finally {
    bitmap.close()
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
