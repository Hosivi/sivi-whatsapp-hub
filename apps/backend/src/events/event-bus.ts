/**
 * event-bus.ts — Typed in-process event bus.
 *
 * Provides a single EventBus interface for domain events. The 'payment.paid'
 * event is the first entry; add new keys here as new capabilities ship.
 *
 * Design:
 * - mitt is installed as the canonical event-bus library for this project
 *   (see package.json). The implementation below mirrors mitt's internal
 *   handler-map pattern because TypeScript NodeNext + esModuleInterop does
 *   not allow calling mitt's default export directly (CJS-to-ESM interop
 *   limitation with module: NodeNext).
 * - The external EventBus interface is intentionally narrow (emit + on) so
 *   callers cannot access internals (e.g. clear, all).
 *
 * Usage:
 *   const events = createEventBus();
 *   events.on('payment.paid', ({ paymentId }) => { ... });
 *   events.emit('payment.paid', { tenantId, paymentId, externalId, amount, currency });
 */

// ---------------------------------------------------------------------------
// Event catalog
// ---------------------------------------------------------------------------

/** All domain events and their payload types. Extend here as new events ship. */
export type AppEvents = {
  /** Emitted once per pending→paid transition. Drives SUNAT invoicing in Corte 3 slice 2. */
  'payment.paid': {
    readonly tenantId: string;
    readonly paymentId: string;
    readonly externalId: string;
    readonly amount: number;
    readonly currency: string;
  };
};

// ---------------------------------------------------------------------------
// Narrow interface (injectable contract)
// ---------------------------------------------------------------------------

/** The injectable event bus contract. Exposes only emit + on (not internals). */
export type EventBus = {
  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void;
  on<K extends keyof AppEvents>(event: K, handler: (payload: AppEvents[K]) => void): void;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Handler list per event key. */
type HandlerList = Array<(payload: unknown) => void>;

/**
 * Creates a new typed EventBus. One instance per app process.
 *
 * Internally uses a Map<event, handler[]> — the same pattern mitt uses —
 * to avoid the CJS-to-ESM default-import limitation under module: NodeNext.
 * mitt remains installed as the declared event-bus dependency.
 */
export const createEventBus = (): EventBus => {
  const handlers = new Map<keyof AppEvents, HandlerList>();

  return {
    emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
      const list = handlers.get(event);
      if (!list) return;
      for (const handler of list) {
        handler(payload as unknown);
      }
    },

    on<K extends keyof AppEvents>(event: K, handler: (payload: AppEvents[K]) => void): void {
      const existing = handlers.get(event) ?? [];
      handlers.set(event, [...existing, handler as (payload: unknown) => void]);
    },
  };
};
