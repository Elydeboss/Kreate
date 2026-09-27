/**
 * Resolve hook that lets Node run the app's TypeScript sources directly.
 *
 * The app source uses extensionless relative imports (`./errors`), which is what
 * a bundler and `tsc` both expect. Node's ESM resolver does not, so
 * `scripts/verify-resilience.ts` registers this hook to retry a failed relative
 * specifier with `.ts` appended.
 *
 * This exists so the resilience modules can be exercised as real runtime code,
 * not as a reimplementation in a test file. Changing the app's import style to
 * satisfy a script runner would be the wrong trade.
 *
 * See scripts/register-ts.mjs for the entry point.
 */

const HAS_EXTENSION = /\.[cm]?[jt]sx?$/

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    if (isRelative && !HAS_EXTENSION.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw err
  }
}
