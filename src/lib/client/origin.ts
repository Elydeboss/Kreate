/**
 * Is this origin one that Panta's own servers could fetch from?
 *
 * Pulse hands Panta an `imageUrl` for every market it creates, and Panta fetches
 * it from its own infrastructure rather than from us. That makes the URL's
 * origin part of the create's correctness, and it is the one part of the create
 * form a user cannot see or reason about.
 *
 * The failure is expensive and late: the user types a question, sees a real fee
 * quoted by Panta, taps confirm, approves in their wallet, and only then is the
 * create rejected because the image could not be fetched. They have been charged
 * a quote and got nothing. So this is checked before the quote rather than
 * discovered after it.
 *
 * Not in the sheet's file, because a `'use client'` component with JSX cannot be
 * imported by the verify script, and a guard that cannot be tested is a guard
 * that quietly stops being true.
 */

/**
 * Rejects the loopback names and anything not over TLS.
 *
 * `0.0.0.0` and `[::1]` are in the list because they are what a dev server
 * reports when it is reached by its LAN address, and both are as unreachable
 * from Panta as `localhost` is. Being permissive about them would mean a
 * developer's machine quietly produces create URLs that only fail on chain.
 */
export function isPublicOrigin(origin: string): boolean {
  if (!/^https:\/\//i.test(origin)) return false
  return !/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:|\/|$)/i.test(origin)
}
