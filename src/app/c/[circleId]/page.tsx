import { notFound } from 'next/navigation'
import { Room } from '@/components/room/Room'
import { ConnectButton } from '@/components/wallet/ConnectButton'
import { MARKET_CATEGORIES } from '@/lib/db/queries/markets'

/**
 * A circle's room.
 *
 * Server shell only. The room is entirely client-driven because its data is a
 * live poll against a session that changes every few seconds — server-rendering a
 * snapshot of it would guarantee the first paint is already stale.
 *
 * The circle name is NOT read here. Doing so would need a membership check in a
 * server component, and an unauthenticated server render has no wallet, so it
 * would either leak the name to anyone with the URL or 404 every legitimate
 * visitor. The room fetch is authorised; this shell is not, and does not need to
 * be.
 *
 * THE CATEGORY LIST IS PASSED DOWN RATHER THAN IMPORTED BY THE CLIENT. The
 * allowlist lives in one place, next to the SQL, and `npm run verify` asserts it
 * still matches Panta's. A client-side copy would be a third list, free to drift,
 * and the failure mode is a create rejected with a 400 about a category on the
 * one flow that has to work live. Reading `MARKET_CATEGORIES` here — where the
 * server can, and the browser cannot — makes drift structurally impossible
 * instead of merely checked.
 *
 * Cost: the array is serialised into the page payload once. It is eight strings.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ circleId: string }>
}

export default async function CirclePage({ params }: { params: Promise<{ circleId: string }> }) {
  const { circleId } = await params

  // Shape-check the id before it reaches the API. A malformed UUID in the path
  // would otherwise produce a Postgres error rather than a 404, and this route is
  // reachable by anyone who edits a URL.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(circleId)) {
    notFound()
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col">
      <div className="flex items-center justify-end px-4 pt-4">
        <ConnectButton />
      </div>
      <Room circleId={circleId} categories={[...MARKET_CATEGORIES]} />
    </main>
  )
}
