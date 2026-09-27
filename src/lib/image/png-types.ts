/**
 * Types shared between the tile painter and the tile URL builder.
 *
 * A separate file so that `tileUrl.ts` can name an `Rgb` without importing
 * `png.ts` and, through it, `node:zlib`. The type is three numbers; the
 * encoder that consumes it is not something a browser should see.
 *
 * Nothing in a `*-types.ts` file may ever grow an import of its own. If one
 * does, this arrangement stops working silently and the next build dies on
 * `UnhandledSchemeError` instead of here.
 */

export type Rgb = readonly [number, number, number]
