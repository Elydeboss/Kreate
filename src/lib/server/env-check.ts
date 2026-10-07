/**
 * Environment validation logic, with no `server-only` and no `process.env`.
 *
 * Split out for the same reason `lib/client/origin.ts` exists: a module marked
 * `server-only` cannot be imported by the verify script, so a guard inside
 * `env.ts` is a guard that cannot be tested and therefore quietly stops being
 * true. Here it can be called directly, and it is.
 *
 * Every function takes the RAW VALUE rather than reading `process.env` itself.
 * That is what makes the unfilled-placeholder check testable at all: the
 * alternative reads global state, so the only way to exercise it is to mutate
 * the environment of the test process.
 */

export class MissingEnvError extends Error {
  constructor(name: string) {
    super(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    )
    this.name = 'MissingEnvError'
  }
}

/**
 * A value that must be present. Does NOT check for a placeholder.
 *
 * The split from `assertFilled` is load-bearing, and the first version of this
 * module got it wrong. Validating placeholders here — at module scope, in
 * `env.ts` — throws while `next build` imports route modules to collect page
 * data, which makes the build unrunnable on any machine that is not the
 * production one. Including a fresh checkout, including CI, including the laptop
 * you are about to deploy from.
 *
 * So a placeholder is caught at USE, by the Panta client and the DB pool, where
 * the error names the call that could not be made. The build succeeds; the first
 * real request produces one sentence about the one variable it needed. That is
 * both less blocking and more accurate than failing a build over a value the
 * build never reads.
 *
 * Scripts (`db:migrate`) are the opposite case: they use the value immediately,
 * are never bundled, and have no "build" to protect — so they call
 * `requireValue`, which is both checks.
 */
export function requirePresent(name: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') throw new MissingEnvError(name)
  return raw.trim()
}

/**
 * The value is present but is still the template's placeholder.
 *
 * A separate error because the failure it prevents is genuinely confusing.
 * `DATABASE_URL=REPLACE_postgres_connection_string` is not a URL, so `pg` falls
 * back to parsing it as a space-separated key/value DSN and reports `ENOTFOUND`
 * for a host called `base` — an error pointing at DNS, at a hostname nobody
 * typed, in a file the user believes they filled in. This turns that into a
 * sentence naming the variable and the file to edit.
 */
export class UnfilledEnvError extends Error {
  constructor(name: string) {
    super(
      `${name} is still the .env.example placeholder. Open .env and put a real ` +
        `value in — nothing has been read from it yet.`,
    )
    this.name = 'UnfilledEnvError'
  }
}

/**
 * What marks a value as "the template's, not yours".
 *
 * Matched against the whole value, case-insensitively, and anchored nowhere: a
 * placeholder embedded in a larger string is still a placeholder. `xxx` is here
 * because the QuickNode template URL ends in `/replace-me/` and users write both
 * spellings.
 */
export const PLACEHOLDER_MARKER = /REPLACE|replace[-_]?me|your[-_ ]?key|^xxx$/i

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_MARKER.test(value.trim())
}

/** Throws `UnfilledEnvError` if the value is a template placeholder. */
export function assertFilled(name: string, value: string): void {
  if (isPlaceholder(value)) throw new UnfilledEnvError(name)
}

/**
 * Both checks, for callers that are about to USE the value.
 *
 * A script, not a module. `db:migrate` runs in a terminal, is never bundled,
 * and fails immediately on a bad value — there is no build to protect, so the
 * strict form is the right one there.
 */
export function requireValue(name: string, raw: string | undefined): string {
  const trimmed = requirePresent(name, raw)
  assertFilled(name, trimmed)
  return trimmed
}

/** A value that may be absent. Placeholders are left alone, not rejected. */
export function optionalValue(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.trim() === '') return fallback
  return raw.trim()
}
