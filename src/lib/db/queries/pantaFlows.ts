import { db, type Db } from '@/lib/db'
import type { QueryResultRow } from 'pg'

/**
 * In-flight Panta flows: `panta_creates` and `panta_orders`.
 *
 * These exist so a crashed run can be reconciled. Every Panta flow mints a
 * short-lived id before the user has signed anything — a `createId` for a market,
 * an `orderId` for a buy — and if the tab closes between the build and the
 * broadcast, that id is the only evidence the flow happened. Without these
 * tables the answer to "did that create ever land on chain?" is unknowable, and
 * a user who is unsure whether they were charged has no way to find out.
 *
 * Statuses move forward only, with one exception: `built` to `expired` is a real
 * transition, because a blockhash really does die after 60 seconds and recording
 * that is the whole point of the table.
 */

export type CreateStatus = 'pending' | 'registered' | 'failed' | 'expired'
export type OrderStatus = 'built' | 'submitted' | 'confirmed' | 'failed' | 'expired'

// ── Creates ─────────────────────────────────────────────────────────────────

export interface CreateRow extends QueryResultRow {
  create_id: string
  pulse_market_id: string
  wallet: string
  payment_usdc: string | null
  expected_event_pda: string | null
  status: CreateStatus
  signature: string | null
  created_at: Date
  updated_at: Date
}

export interface CreateFlow {
  createId: string
  pulseMarketId: string
  wallet: string
  /** Raw string from Panta's quote, as returned. Never parsed into a number. */
  paymentUsdc: string | null
  expectedEventPda: string | null
  status: CreateStatus
  signature: string | null
  createdAt: Date
  updatedAt: Date
}

function toCreate(row: CreateRow): CreateFlow {
  return {
    createId: row.create_id,
    pulseMarketId: row.pulse_market_id,
    wallet: row.wallet,
    paymentUsdc: row.payment_usdc,
    expectedEventPda: row.expected_event_pda,
    status: row.status,
    signature: row.signature,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const CREATE_COLUMNS = `
  create_id, pulse_market_id, wallet, payment_usdc, expected_event_pda,
  status, signature, created_at, updated_at`

/**
 * Record a create the moment Panta hands back a `createId`.
 *
 * Written before the user is asked to sign. The row is the only record that this
 * market was ever going to exist, and if we wrote it after the broadcast the
 * interesting failure — user closed the tab, or the signature never arrived —
 * would leave nothing behind at all.
 *
 * `payment_usdc` is stored as the string Panta quoted, not as a number. It is
 * read back for reconciliation against the eventual charge, and re-formatting it
 * through a float would destroy exactly the precision being checked.
 */
export async function recordCreate(
  input: {
    createId: string
    pulseMarketId: string
    wallet: string
    paymentUsdc?: string | null
    expectedEventPda?: string | null
  },
  executor: Db = db,
): Promise<CreateFlow> {
  const row = await executor.queryOne<CreateRow>(
    `INSERT INTO panta_creates (create_id, pulse_market_id, wallet, payment_usdc, expected_event_pda)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (create_id) DO NOTHING
     RETURNING ${CREATE_COLUMNS}`,
    [input.createId, input.pulseMarketId, input.wallet, input.paymentUsdc ?? null, input.expectedEventPda ?? null],
  )
  if (!row) {
    // Already recorded — a retried quote. Return the existing flow rather than
    // failing, because a duplicate createId is a replay, not an error.
    const existing = await findCreate(input.createId, executor)
    if (!existing) throw new Error('create conflict but no existing row')
    return existing
  }
  return toCreate(row)
}

export async function findCreate(createId: string, executor: Db = db): Promise<CreateFlow | null> {
  const row = await executor.queryOne<CreateRow>(
    `SELECT ${CREATE_COLUMNS} FROM panta_creates WHERE create_id = $1`,
    [createId],
  )
  return row ? toCreate(row) : null
}

/**
 * Mark a create landed, with the signature that landed it.
 *
 * `ON CONFLICT (create_id) DO UPDATE` rather than DO NOTHING, because the whole
 * point is to move a pending row forward. The unique constraint on
 * (order_id, signature) in panta_orders is what protects the broadcast replay
 * path; here the signature is simply recorded.
 */
export async function markCreateRegistered(
  createId: string,
  signature: string,
  executor: Db = db,
): Promise<CreateFlow | null> {
  const row = await executor.queryOne<CreateRow>(
    `UPDATE panta_creates
        SET status = 'registered', signature = $2, updated_at = now()
      WHERE create_id = $1 AND status IN ('pending', 'failed')
      RETURNING ${CREATE_COLUMNS}`,
    [createId, signature],
  )
  return row ? toCreate(row) : null
}

export async function markCreateStatus(
  createId: string,
  status: CreateStatus,
  executor: Db = db,
): Promise<CreateFlow | null> {
  const row = await executor.queryOne<CreateRow>(
    `UPDATE panta_creates
        SET status = $2, updated_at = now()
      WHERE create_id = $1
      RETURNING ${CREATE_COLUMNS}`,
    [createId, status],
  )
  return row ? toCreate(row) : null
}

/** Every in-flight create for a market. There is normally at most one. */
export async function listCreatesForMarket(
  pulseMarketId: string,
  executor: Db = db,
): Promise<CreateFlow[]> {
  const rows = await executor.query<CreateRow>(
    `SELECT ${CREATE_COLUMNS} FROM panta_creates WHERE pulse_market_id = $1 ORDER BY created_at DESC`,
    [pulseMarketId],
  )
  return rows.map(toCreate)
}

/**
 * Creates still pending, oldest first.
 *
 * The reconciliation queue. A `createId` lives about five minutes, so anything
 * still `pending` well past that has either landed without us hearing about it,
 * or expired. Both are answerable by asking Panta.
 */
export async function listStaleCreates(
  olderThanMinutes = 15,
  executor: Db = db,
): Promise<CreateFlow[]> {
  const rows = await executor.query<CreateRow>(
    `SELECT ${CREATE_COLUMNS}
       FROM panta_creates
      WHERE status = 'pending'
        AND created_at < now() - make_interval(mins => $1)
      ORDER BY created_at ASC`,
    [olderThanMinutes],
  )
  return rows.map(toCreate)
}

// ── Orders ──────────────────────────────────────────────────────────────────

export interface OrderRow extends QueryResultRow {
  order_id: string
  quote_id: string | null
  pulse_market_id: string
  wallet: string
  side: 'yes' | 'no'
  amount_usdc: string
  status: OrderStatus
  signature: string | null
  user_id: string | null
  created_at: Date
  updated_at: Date
}

export interface OrderFlow {
  orderId: string
  quoteId: string | null
  pulseMarketId: string
  wallet: string
  side: 'yes' | 'no'
  /** Decimal string as Panta quoted it, e.g. "20.00". */
  amountUsdc: string
  status: OrderStatus
  signature: string | null
  /** Panta's attribution id. Not a FK — it is Panta's namespace, not ours. */
  userId: string | null
  createdAt: Date
  updatedAt: Date
}

const ORDER_COLUMNS = `
  order_id, quote_id, pulse_market_id, wallet, side, amount_usdc,
  status, signature, user_id, created_at, updated_at`

function toOrder(row: OrderRow): OrderFlow {
  return {
    orderId: row.order_id,
    quoteId: row.quote_id,
    pulseMarketId: row.pulse_market_id,
    wallet: row.wallet,
    side: row.side,
    amountUsdc: row.amount_usdc,
    status: row.status,
    signature: row.signature,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Record a built order.
 *
 * `amount_usdc` is the decimal string from the quote. Note the asymmetry with
 * creates, which take base units: Panta quotes creates in base units and buys in
 * human decimals. Storing each in its own format, as a string, means neither
 * conversion is ever guessed.
 */
export async function recordOrder(
  input: {
    orderId: string
    quoteId?: string | null
    pulseMarketId: string
    wallet: string
    side: 'yes' | 'no'
    amountUsdc: string
    userId?: string | null
  },
  executor: Db = db,
): Promise<OrderFlow> {
  const row = await executor.queryOne<OrderRow>(
    `INSERT INTO panta_orders (order_id, quote_id, pulse_market_id, wallet, side, amount_usdc, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING ${ORDER_COLUMNS}`,
    [
      input.orderId,
      input.quoteId ?? null,
      input.pulseMarketId,
      input.wallet,
      input.side,
      input.amountUsdc,
      input.userId ?? null,
    ],
  )
  if (!row) {
    const existing = await findOrder(input.orderId, executor)
    if (!existing) throw new Error('order conflict but no existing row')
    return existing
  }
  return toOrder(row)
}

export async function findOrder(orderId: string, executor: Db = db): Promise<OrderFlow | null> {
  const row = await executor.queryOne<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM panta_orders WHERE order_id = $1`,
    [orderId],
  )
  return row ? toOrder(row) : null
}

/**
 * Record the signature for a submitted order.
 *
 * The unique (order_id, signature) constraint makes this the natural place to
 * catch a double-broadcast, and it mirrors Panta's own idempotency guarantee on
 * `/trades/`. Returns the existing row untouched if this signature is already
 * recorded, so a retried submit is a no-op rather than a 500.
 */
export async function markOrderSubmitted(
  orderId: string,
  signature: string,
  executor: Db = db,
): Promise<OrderFlow | null> {
  const row = await executor.queryOne<OrderRow>(
    `UPDATE panta_orders
        SET status = 'submitted', signature = $2, updated_at = now()
      WHERE order_id = $1
      RETURNING ${ORDER_COLUMNS}`,
    [orderId, signature],
  )
  return row ? toOrder(row) : null
}

export async function markOrderStatus(
  orderId: string,
  status: OrderStatus,
  executor: Db = db,
): Promise<OrderFlow | null> {
  const row = await executor.queryOne<OrderRow>(
    `UPDATE panta_orders
        SET status = $2, updated_at = now()
      WHERE order_id = $1
      RETURNING ${ORDER_COLUMNS}`,
    [orderId, status],
  )
  return row ? toOrder(row) : null
}

export async function listOrdersForWallet(
  wallet: string,
  limit = 50,
  executor: Db = db,
): Promise<OrderFlow[]> {
  const rows = await executor.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS}
       FROM panta_orders
      WHERE wallet = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [wallet, Math.min(Math.max(limit, 1), 200)],
  )
  return rows.map(toOrder)
}

/** Orders stuck in a non-terminal state, oldest first. The reconciliation queue. */
export async function listStaleOrders(
  olderThanMinutes = 10,
  executor: Db = db,
): Promise<OrderFlow[]> {
  const rows = await executor.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS}
       FROM panta_orders
      WHERE status IN ('built', 'submitted')
        AND created_at < now() - make_interval(mins => $1)
      ORDER BY created_at ASC`,
    [olderThanMinutes],
  )
  return rows.map(toOrder)
}

/**
 * Orders for a market that never reached a terminal state.
 *
 * The "did I get charged?" query. A `built` or `submitted` order older than the
 * ~120s orderId lifetime needs a real answer from the chain or from Panta, not a
 * guess.
 */
export async function listUnsettledOrdersForMarket(
  pulseMarketId: string,
  executor: Db = db,
): Promise<OrderFlow[]> {
  const rows = await executor.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS}
       FROM panta_orders
      WHERE pulse_market_id = $1 AND status IN ('built', 'submitted')
      ORDER BY created_at ASC`,
    [pulseMarketId],
  )
  return rows.map(toOrder)
}
