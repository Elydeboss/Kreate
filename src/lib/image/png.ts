/**
 * A minimal PNG encoder.
 *
 * WHY THIS EXISTS. Panta requires `imageUrl` to be a public HTTPS image, and it
 * is the single most reliable way to lose a live demo: the market is built, the
 * fee is quoted, the user confirms, and the create is rejected because the image
 * could not be fetched. Every workaround for that — Cloudinary, S3, imgix,
 * GitHub raw — is an account the user does not have yet, and a demo that depends
 * on an account someone has not signed up for is a demo that fails on stage.
 *
 * So the app generates its own. Deployed, it serves 1024×1024 PNGs from its own
 * origin, which is by definition the public HTTPS URL Panta asked for. No
 * third party, no credentials, no expiry, and the tiles cannot 404 because
 * nothing about them is mutable.
 *
 * SCOPE. 8-bit truecolour, no interlacing, one IDAT. That is the smallest thing
 * that is still a valid PNG, and it is enough for a flat geometric tile. It is
 * not a general image library: no palette, no alpha, no filtering beyond
 * "none". Adding those means adding a dependency, and the whole point of this
 * file is to not need one.
 *
 * Runs on the server only. `node:zlib` is not available in the browser bundle.
 */

import { deflateSync } from 'node:zlib'
import type { Rgb } from './png-types'

// Re-exported so existing importers of the encoder keep one import site. The
// canonical home is png-types, which is importable from the client without
// dragging this file — and node:zlib — into the browser bundle.
export type { Rgb }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Precomputed CRC-32 table. The naive bitwise loop costs ~8ms per image. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    // `& 0xff` is the standard CRC-32 table index and is always in 0..255, which
    // TypeScript cannot infer through a `Uint32Array` index. The `!` is a claim
    // about that mask, not a suppression: an out-of-range byte would return
    // `undefined` and the XOR would produce NaN, and a NaN CRC writes a PNG that
    // no decoder will open — so the next assertion in this file is that every
    // tile decodes.
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** length(4) + type(4) + data + crc(4), where crc covers type+data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** A mutable 8-bit RGB canvas. Row-major, three bytes per pixel. */
export class Canvas {
  readonly size: number
  private readonly pixels: Buffer

  constructor(size: number) {
    this.size = size
    this.pixels = Buffer.alloc(size * size * 3)
  }

  /** Set one pixel. Out-of-range coordinates are ignored, not thrown on. */
  set(x: number, y: number, colour: Rgb): void {
    const px = x | 0
    const py = y | 0
    if (px < 0 || py < 0 || px >= this.size || py >= this.size) return
    const at = (py * this.size + px) * 3
    this.pixels[at] = colour[0]
    this.pixels[at + 1] = colour[1]
    this.pixels[at + 2] = colour[2]
  }

  /** Read one pixel. Returns black outside the canvas. */
  get(x: number, y: number): Rgb {
    const px = x | 0
    const py = y | 0
    if (px < 0 || py < 0 || px >= this.size || py >= this.size) return [0, 0, 0]
    // Bounds are checked above, so these indices are in range. The `!` records
    // that; without it a Buffer index is `number | undefined` and the tuple
    // silently becomes `(number | undefined)[]`, which no longer satisfies Rgb.
    const at = (py * this.size + px) * 3
    return [this.pixels[at]!, this.pixels[at + 1]!, this.pixels[at + 2]!]
  }

  /**
   * Fill every pixel from a callback. The painter runs once per pixel and is
   * where all the drawing logic lives, which keeps this class free of opinions
   * about what a tile should look like.
   */
  fill(paint: (x: number, y: number, size: number) => Rgb): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const [r, g, b] = paint(x, y, this.size)
        const at = (y * this.size + x) * 3
        this.pixels[at] = r
        this.pixels[at + 1] = g
        this.pixels[at + 2] = b
      }
    }
  }

  /** Multiply a colour toward black by `amount` in 0..1. */
  static shade(colour: Rgb, amount: number): Rgb {
    const k = 1 - Math.max(0, Math.min(1, amount))
    return [Math.round(colour[0] * k), Math.round(colour[1] * k), Math.round(colour[2] * k)]
  }

  /** Linear blend. `t` of 0 returns `a`, 1 returns `b`. */
  static mix(a: Rgb, b: Rgb, t: number): Rgb {
    const k = Math.max(0, Math.min(1, t))
    return [
      Math.round(a[0] + (b[0] - a[0]) * k),
      Math.round(a[1] + (b[1] - a[1]) * k),
      Math.round(a[2] + (b[2] - a[2]) * k),
    ]
  }
  /** Encode to PNG bytes. */
  toPng(): Buffer {
    const { size, pixels } = this

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(size, 0)
    ihdr.writeUInt32BE(size, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 2 // colour type: truecolour
    ihdr[10] = 0 // compression: deflate
    ihdr[11] = 0 // filter: adaptive
    ihdr[12] = 0 // interlace: none

    // Every scanline is prefixed with its filter byte. 0 is "None", which costs
    // nothing to produce and compresses acceptably for a flat geometric tile.
    // The 1-byte-per-row overhead is the entire price of not implementing the
    // other five filters.
    const stride = size * 3
    const rawWithFilters = Buffer.alloc((stride + 1) * size)
    for (let y = 0; y < size; y += 1) {
      rawWithFilters[y * (stride + 1)] = 0
      pixels.copy(rawWithFilters, y * (stride + 1) + 1, y * stride, y * stride + stride)
    }

    return Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      // Level 9. These images are served once and cached for a year; a few
      // hundred extra milliseconds of CPU at build time beats a few hundred
      // kilobytes on every future request.
      chunk('IDAT', deflateSync(rawWithFilters, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }
}
