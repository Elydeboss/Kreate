/**
 * Render every market tile to `tmp/tiles/` so the art can be looked at.
 *
 *   npm run tiles
 *
 * The tiles are geometry drawn from a distance function, which is exactly the
 * kind of thing that looks right in the source and wrong on screen — a bar that
 * is half off-canvas, a mark that vanishes at 48px, a contrast ratio that fails
 * against the title text on top of it. None of that shows up in a typecheck.
 *
 * So this exists. It writes the real encoder's real output, at the real 1024px,
 * plus a 48px contact sheet, and prints the file sizes. If a tile is going to be
 * wrong, this is where it is found — before a stage, not on one.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paintTile, TILE_SPECS } from '../src/lib/image/tiles.ts'
import { Canvas } from '../src/lib/image/png.ts'

const OUT = join(process.cwd(), 'tmp', 'tiles')
mkdirSync(OUT, { recursive: true })

let total = 0
for (const spec of TILE_SPECS) {
  const png = paintTile(spec, 1024).toPng()
  const file = join(OUT, `${spec.category}.png`)
  writeFileSync(file, png)
  total += png.byteLength
  console.log(`${spec.category.padEnd(14)} ${spec.mark.padEnd(6)} ${(png.byteLength / 1024).toFixed(1)} kB`)
}

// A contact sheet at the size the room actually shows them. A tile that only
// works at 1024px is a tile that does not work in the product.
const THUMB = 48
const GAP = 8
const sheet = new Canvas(TILE_SPECS.length * (THUMB + GAP) - GAP + GAP)
sheet.fill(() => [30, 31, 36])
TILE_SPECS.forEach((spec, i) => {
  const thumb = paintTile(spec, THUMB)
  const at = i * (THUMB + GAP) + GAP / 2
  for (let y = 0; y < THUMB; y += 1) {
    for (let x = 0; x < THUMB; x += 1) {
      sheet.set(at + x, GAP / 2 + y, thumb.get(x, y))
    }
  }
})
writeFileSync(join(OUT, 'contact-sheet-48.png'), sheet.toPng())

console.log(`\n${TILE_SPECS.length} tiles, ${(total / 1024).toFixed(1)} kB total, in ${OUT}`)
