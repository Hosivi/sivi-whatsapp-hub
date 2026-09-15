/**
 * sivihub-outbox-drain.ts — the Hub -> SiviHub outbox drain loop
 * (ADR-0048 corte 1, walking skeleton B3).
 *
 * Runs IN THE SAME PROCESS as the API (spec item 6): an interval loop that, each
 * tick, opens one transaction on the app_outbox_drain connection (least-privilege,
 * cross-tenant — see 0007_sivihub_event_outbox.sql), SELECTs a batch of due rows
 * with `FOR UPDATE ... SKIP LOCKED` (safe if this ever runs with >1 worker), and for
 * each row: decrypts the channel secret, re-signs the SAME stored payload bytes with
 * a FRESH timestamp (spec item 7 — the body never changes across retries, only the
 * signature), POSTs it with a bounded delivery timeout, and classifies the response
 * per the contract's response table (see classifyDeliveryOutcome).
 *
 * Held DB locks: the batch's row locks are held for the WHOLE batch's delivery time
 * (worst case batchSize * deliveryTimeoutMs). Acceptable here because this is a
 * single in-process loop — no concurrent drain worker exists to contend with, and
 * SKIP LOCKED means a future second worker would simply take the next batch instead
 * of blocking.
 */

import { sql as rawSql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Logger } from 'pino';
import type { SivihubLinkSecretCipher } from './sivihub-link-secret-cipher.js';
import { signSivihubEvent } from './sivihub-outbox-signature.js';

// ---------------------------------------------------------------------------
// Pure decision functions — spec's response table + backoff schedule
// ---------------------------------------------------------------------------

export type DeliveryOutcome = 'delivered' | 'dead' | 'retry';
export type DeliveryResult = number | 'timeout' | 'network_error';

/** Spec: "A los 12 intentos pasa a dead." */
export const MAX_ATTEMPTS = 12;

const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 3600; // 1h cap

/**
 * Classifies a delivery attempt's HTTP status (or transport failure) per the
 * spec's response table:
 *   2xx                          -> delivered
 *   400 / 401 / 403               -> dead (the SAME body would fail again)
 *   503, other 5xx, 408, 429,
 *   timeout, network error        -> retry
 *   any other/unlisted status     -> dead (the contract never emits one; treated
 *                                    like the 400/401/403 class rather than
 *                                    retried forever against a body it will never
 *                                    accept)
 */
export function classifyDeliveryOutcome(result: DeliveryResult): DeliveryOutcome {
  if (result === 'timeout' || result === 'network_error') {
    return 'retry';
  }
  if (result >= 200 && result < 300) {
    return 'delivered';
  }
  if (result === 408 || result === 429) {
    return 'retry';
  }
  if (result >= 500) {
    return 'retry';
  }
  // 400, 401, 403, and any other unlisted status (contractually impossible).
  return 'dead';
}

/** Exponential backoff from 30s, doubling per attempt, capped at 1h. */
export function computeBackoffSeconds(attempts: number): number {
  return Math.min(BASE_BACKOFF_SECONDS * 2 ** (attempts - 1), MAX_BACKOFF_SECONDS);
}

// ---------------------------------------------------------------------------
// Batch row shape (SELECT ... JOIN sivihub_links)
// ---------------------------------------------------------------------------

type OutboxDrainRow = {
  id: string;
  tenant_id: string;
  link_id: string;
  event_id: string;
  type: string;
  payload: unknown;
  attempts: number;
  events_url: string;
  secret_encrypted: string;
};

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

type MinimalLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export type SivihubOutboxDrainDeps = {
  /** The app_outbox_drain-connected drizzle handle (createOutboxDrainDb). */
  readonly drainDb: PostgresJsDatabase;
  readonly cipher: SivihubLinkSecretCipher;
  /** Injectable for tests — defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock — signs with this instant (spec item 7: testable window). */
  readonly clock?: () => Date;
  readonly logger?: MinimalLogger;
  readonly batchSize?: number;
  readonly deliveryTimeoutMs?: number;
  /** How often the loop ticks when idle. Defaults to 5s. */
  readonly pollIntervalMs?: number;
};

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// One batch
// ---------------------------------------------------------------------------

/**
 * Runs exactly one batch: selects up to `batchSize` due rows FOR UPDATE SKIP LOCKED
 * and processes each one to a terminal or retry state, all inside one transaction.
 */
export async function drainOnce(deps: SivihubOutboxDrainDeps): Promise<{ processed: number }> {
  const now = deps.clock ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const deliveryTimeoutMs = deps.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;

  let processed = 0;

  await deps.drainDb.transaction(async (tx) => {
    const selected = await tx.execute(rawSql`
      SELECT o.id, o.tenant_id, o.link_id, o.event_id, o.type, o.payload, o.attempts,
             l.events_url, l.secret_encrypted
      FROM sivihub_event_outbox o
      JOIN sivihub_links l ON l.id = o.link_id
      WHERE o.status = 'pending' AND o.next_attempt_at <= now()
      ORDER BY o.next_attempt_at
      LIMIT ${batchSize}
      FOR UPDATE OF o SKIP LOCKED
    `);
    const rows = selected as unknown as OutboxDrainRow[];
    processed = rows.length;

    for (const row of rows) {
      await processOne(tx, row, {
        cipher: deps.cipher,
        fetchImpl,
        deliveryTimeoutMs,
        now,
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      });
    }
  });

  return { processed };
}

async function markTerminalOrRetry(
  tx: PostgresJsDatabase,
  row: OutboxDrainRow,
  outcome: DeliveryOutcome,
  nextAttemptNumber: number,
  lastStatus: string,
  lastError: string | null,
): Promise<void> {
  if (outcome === 'delivered') {
    await tx.execute(rawSql`
      UPDATE sivihub_event_outbox
      SET status = 'delivered', delivered_at = now(), attempts = ${nextAttemptNumber},
          last_status = ${lastStatus}, last_error = NULL
      WHERE id = ${row.id}::uuid
    `);
    return;
  }

  if (outcome === 'dead' || nextAttemptNumber >= MAX_ATTEMPTS) {
    await tx.execute(rawSql`
      UPDATE sivihub_event_outbox
      SET status = 'dead', attempts = ${nextAttemptNumber},
          last_status = ${lastStatus}, last_error = ${lastError}
      WHERE id = ${row.id}::uuid
    `);
    return;
  }

  // retry: exponential backoff, still 'pending' so the next tick can pick it up.
  const backoffSeconds = computeBackoffSeconds(nextAttemptNumber);
  await tx.execute(rawSql`
    UPDATE sivihub_event_outbox
    SET status = 'pending', attempts = ${nextAttemptNumber},
        next_attempt_at = now() + (${backoffSeconds}::text || ' seconds')::interval,
        last_status = ${lastStatus}, last_error = ${lastError}
    WHERE id = ${row.id}::uuid
  `);
}

async function processOne(
  tx: PostgresJsDatabase,
  row: OutboxDrainRow,
  ctx: {
    cipher: SivihubLinkSecretCipher;
    fetchImpl: typeof fetch;
    deliveryTimeoutMs: number;
    now: () => Date;
    logger?: MinimalLogger;
  },
): Promise<void> {
  const nextAttemptNumber = row.attempts + 1;

  const secret = ctx.cipher.decrypt(row.secret_encrypted);
  if (secret === null) {
    // Corrupted/undecryptable secret — no amount of retrying fixes this.
    ctx.logger?.error(
      { tenantId: row.tenant_id, eventId: row.event_id },
      'sivihub_outbox_decrypt_failed',
    );
    await markTerminalOrRetry(
      tx,
      row,
      'dead',
      nextAttemptNumber,
      'decrypt_failed',
      'channel secret could not be decrypted',
    );
    return;
  }

  // The SAME payload bytes on every attempt — only the timestamp/signature change.
  const rawBody = JSON.stringify(row.payload);
  const timestampSeconds = Math.floor(ctx.now().getTime() / 1000);
  const signature = signSivihubEvent(secret, rawBody, timestampSeconds);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), ctx.deliveryTimeoutMs);

  let result: DeliveryResult;
  let lastError: string | null = null;
  try {
    const response = await ctx.fetchImpl(row.events_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sivi-Event-Id': row.event_id,
        'X-Sivi-Timestamp': String(timestampSeconds),
        'X-Sivi-Signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    result = response.status;
  } catch (cause) {
    result = controller.signal.aborted ? 'timeout' : 'network_error';
    lastError = cause instanceof Error ? cause.message : String(cause);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const outcome = classifyDeliveryOutcome(result);
  const lastStatus = typeof result === 'number' ? String(result) : result;

  ctx.logger?.info(
    {
      tenantId: row.tenant_id,
      eventId: row.event_id,
      outcome,
      attempt: nextAttemptNumber,
      lastStatus,
    },
    'sivihub_outbox_delivery_attempt',
  );

  await markTerminalOrRetry(tx, row, outcome, nextAttemptNumber, lastStatus, lastError);
}

// ---------------------------------------------------------------------------
// The interval loop
// ---------------------------------------------------------------------------

export type SivihubOutboxDrainLoop = {
  /** Starts ticking. Safe to call once; a second call while running is a no-op. */
  start(): void;
  /** Stops cleanly: cancels the next scheduled tick and awaits any in-flight batch. */
  stop(): Promise<void>;
  /** Runs exactly one batch, outside the interval schedule — used directly by tests. */
  drainOnce(): Promise<{ processed: number }>;
};

/**
 * Builds the drain loop. `start()`/`stop()` implement the spec's "bucle con
 * intervalo ... se detiene limpio con la señal de apagado" — main.ts calls start()
 * after boot and stop() on SIGTERM/SIGINT, before closing the drain DB connection.
 */
export function createSivihubOutboxDrainLoop(deps: SivihubOutboxDrainDeps): SivihubOutboxDrainLoop {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentRun: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped) {
      return;
    }
    currentRun = drainOnce(deps)
      .then(() => undefined)
      .catch((cause: unknown) => {
        deps.logger?.error({ cause }, 'sivihub_outbox_drain_tick_failed');
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, pollIntervalMs);
        }
      });
  };

  return {
    start() {
      if (running || stopped) {
        return;
      }
      running = true;
      tick();
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await currentRun;
    },
    drainOnce: () => drainOnce(deps),
  };
}
