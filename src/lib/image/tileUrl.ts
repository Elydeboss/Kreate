/**
 * A tile's identity and where to find it. NO `node:` IMPORTS, EVER.
 *
 * This module exists as a separate file from `tiles.ts` for one reason, and the
 * reason is a build failure that only appears at `next build`:
 *
 *   CreateSheet (client) → tiles.ts → png.ts → node:zlib
 *
 * `png.ts` is the hand-rolled PNG encoder and it compresses with `node:zlib`,
 * which webpack cannot put in a browser bundle. Importing a `tileUrl` helper
 * from a module that also contained the encoder pulled zlib into the client
 * graph and the build died with `UnhandledSchemeError`. `npm run verify` and
 * `npx tsc` were both green on the broken code, because neither of them bundles
 * anything — the failure lives entirely on the boundary between server code and
 * client code, which is exactly where a typechecker is blind.
 *
 * So the split follows the real seam. Everything here is pure data and string
 * building: the `Rgb` triple, the per-category spec, the fallback, and the URL.
 * Everything in `tiles.ts` is pixels and compression. A client component that
 * needs a tile URL imports from here and never reaches for zlib.
 *
 * `Rgb` lives on this side even though it is a painting type, because
 * `TileSpec.accent` needs it and `TileSpec` is pure. Keeping the type in `png.ts`
 * would mean this file imported the encoder to name a triple of numbers, and the
 * split would be decorative.
 *
 * THE RULE THIS FILE HAS TO KEEP: it imports nothing.
 */

import type { Rgb } from './png-types'

export type { Rgb }

/** One tile's identity. Pure data — no functions, no Node built-ins. */
export interface TileSpec {
  /** Panta category. Doubles as the tile's cache key. */
  category: string
  accent: Rgb
  /** Which mark to draw. See `drawMark` in tiles.ts. */
  mark: 'bars' | 'arcs' | 'grid' | 'wedge' | 'cross' | 'ring' | 'steps' | 'burst'
}

/** Kept in step with `PANTA_CATEGORIES` in lib/panta/types.ts. */
export const TILE_SPECS: readonly TileSpec[] = [
  { category: 'sports', accent: [122, 201, 128], mark: 'arcs' },
  { category: 'crypto', accent: [139, 124, 246], mark: 'steps' },
  { category: 'politics', accent: [232, 160, 92], mark: 'bars' },
  { category: 'entertainment', accent: [232, 106, 148], mark: 'burst' },
  { category: 'finance', accent: [86, 178, 214], mark: 'grid' },
  { category: 'science', accent: [120, 196, 214], mark: 'ring' },
  { category: 'world', accent: [168, 178, 190], mark: 'wedge' },
  { category: 'other', accent: [142, 146, 158], mark: 'cross' },
]

/**
 * The tile for a category, or the neutral one.
 *
 * Falls back rather than throwing, because Panta fetches this URL from its own
 * infrastructure and a missing tile is a failed market creation the user has
 * already paid to quote. `FALLBACK` is the last element rather than a separate
 * constant so it cannot drift out of the list it belongs to.
 */
const FALLBACK: TileSpec = TILE_SPECS[TILE_SPECS.length - 1] ?? {
  category: 'other',
  accent: [142, 146, 158],
  mark: 'cross',
}

export function tileFor(category: string): TileSpec {
  return TILE_SPECS.find((t) => t.category === category) ?? FALLBACK
}

/**
 * The absolute URL to hand Panta as a market's `imageUrl`.
 *
 * Panta fetches this from its own servers, so it has to be absolute and public
 * — which means it is built from the ORIGIN the browser is currently on. That
 * has one hard consequence: this is only correct once the app is deployed. On
 * localhost it produces `http://localhost:3000/tiles/…`, which Panta cannot
 * reach and the create will be rejected. There is no way to detect that from
 * here without a config flag, so the caller passes the origin in rather than
 * reading `location` here, and `isPublicOrigin` is what the sheet uses to refuse
 * the create before it is paid for.
 *
 * The path shape is asserted against the route in scripts/verify-resilience.ts.
 * The two drifting apart is not a hypothetical: an earlier version served
 * `/tiles/[category]` while the natural guess was `/tiles/crypto.png`, and every
 * such request rendered the neutral tile with a 200 and no error.
 */
export function tileUrl(origin: string, category: string): string {
  return `${origin.replace(/\/+$/, '')}/tiles/${encodeURIComponent(category)}.png`
}
