import { paintTile, tileFor } from '@/lib/image/tiles'

/**
 * GET /tiles/[category].png — a 1024×1024 market tile, generated.
 *
 * Panta requires a create's `imageUrl` to be a public HTTPS image it can fetch.
 * This route exists so that requirement is met by the app's own origin instead
 * of by a third-party image host nobody has signed up for yet. See
 * lib/image/png.ts for why the encoder is hand-rolled and lib/image/tiles.ts
 * for the art.
 *
 * WHY `/tiles/` AND NOT `/api/`. This is not an API — it takes no wallet, reads
 * no database, and returns the same bytes for everyone. It sits outside `/api`
 * so that a future change to the `/api` middleware — auth, rate limiting,
 * headers — cannot accidentally start applying to image fetches that Panta
 * makes from its own infrastructure, with no session to authenticate.
 *
 * CACHEABILITY. One year, immutable. The URL is the cache key and the content is
 * a pure function of the category, so it cannot go stale — which also means the
 * `immutable` directive is honest rather than optimistic.
 */

export const runtime = 'nodejs'

/**
 * Rendered on demand and cached by the CDN rather than pre-built into `public/`.
 *
 * Pre-generating would mean nine binary files in the repo that nobody can edit
 * without a rasteriser, for art that is a pure function of a category name.
 * Generating is ~15ms of CPU on a cache miss, and after the first request no
 * request pays it again.
 */
const SIZE = 1024

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ category: string }> },
): Promise<Response> {
  const { category: raw } = await params

  // The extension is stripped so `/tiles/crypto` and `/tiles/crypto.png` are the
  // same image. That looks like a nicety and is not: with a bare `[category]`
  // segment, a request for `crypto.png` sets the segment to the literal string
  // "crypto.png", which matches no tile and falls through to the neutral one.
  //
  // The failure is silent and total — every tile renders, every tile is the same
  // tile, and nothing errors. It was found by noticing that eight different
  // categories all returned byte-identical responses, which is the kind of
  // signal a test has to be told to look for. Accepting both forms means a
  // wrong guess about the extension can no longer produce a valid-looking
  // response that is the wrong picture.
  const category = raw.replace(/\.png$/i, '')

  // `tileFor` falls back rather than throwing, so an unknown category is a
  // neutral tile and not a 404. Panta fetches this URL from a server we do not
  // control, and a 404 here fails a market creation the user already paid to
  // quote.
  const png = paintTile(tileFor(category), SIZE).toPng()

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      // The URL is the cache key, so a `Vary` on anything would be noise. But
      // this response is identical for every client including bots and prefetchers,
      // which is the point.
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
