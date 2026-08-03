/**
 * Hand-rolled ambient types for the one Cloudflare Workers surface this
 * Worker touches (R2, plus the static-assets Fetcher binding). The full
 * `@cloudflare/workers-types` package is not installed in this repo — see
 * AGENTS.md for why (nothing here may run `npm install`) — so this file
 * declares only the shapes actually used, matching the real R2 API
 * (`R2Bucket.put`'s `onlyIf` returning `null` on a failed precondition is
 * load-bearing for `worker/library-api.ts` and is exercised for real against
 * the local Workers runtime in `worker/library-api.workers.test.ts`, not
 * just asserted here).
 */

interface R2Conditional {
  etagMatches?: string
  etagDoesNotMatch?: string
  uploadedBefore?: Date
  uploadedAfter?: Date
}

interface R2HTTPMetadata {
  contentType?: string
}

interface R2Object {
  readonly key: string
  readonly etag: string
  readonly httpEtag: string
  readonly size: number
  readonly uploaded: Date
  readonly customMetadata?: Record<string, string>
}

interface R2ObjectBody extends R2Object {
  text(): Promise<string>
}

interface R2GetOptions {
  onlyIf?: R2Conditional | Headers
}

interface R2PutOptions {
  onlyIf?: R2Conditional | Headers
  httpMetadata?: R2HTTPMetadata
}

interface R2Bucket {
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: string,
    options?: R2PutOptions,
  ): Promise<R2Object | null>
}

/** The static-assets binding (`assets.binding` in wrangler.jsonc). */
interface Fetcher {
  fetch(request: Request): Promise<Response>
}

interface Env {
  readonly LIBRARY_BUCKET: R2Bucket
  readonly ASSETS?: Fetcher
}
