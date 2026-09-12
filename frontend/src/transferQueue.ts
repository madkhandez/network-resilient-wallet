// transferQueue.ts — Pending transfer queue in localStorage
// Implements the ~50-100 line custom queue from ARCHITECTURE.md
// No external dependencies. No state management library.

import { apiFetch, ApiError } from './api';

// --- Types ---

export type PendingStatus = 'pending' | 'sending' | 'completed' | 'permanentFailure';

export interface PendingTransfer {
  idempotencyKey: string;
  recipientEmail: string;
  amount: number; // in cents
  notes: string;
  status: PendingStatus;
  retryCount: number;
  createdAt: number; // Date.now()
  lastError?: string;
}

export interface ServerTransfer {
  id: string;
  idempotency_key: string;
  sender_id: string;
  recipient_id: string;
  amount: number;
  notes: string;
  status: string;
  created_at: string;
}

const QUEUE_KEY = 'pending_transfers';

// --- Module-level processing lock ---
// Prevents concurrent queue processing from reconnect/timer/mount/manual retry
let isProcessing = false;

// --- Safe localStorage access ---

export function getQueue(): PendingTransfer[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each item has required fields
    return parsed.filter(
      (item: unknown): item is PendingTransfer =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as PendingTransfer).idempotencyKey === 'string' &&
        typeof (item as PendingTransfer).recipientEmail === 'string' &&
        typeof (item as PendingTransfer).amount === 'number' &&
        typeof (item as PendingTransfer).status === 'string' &&
        (item as PendingTransfer).amount > 0
    );
  } catch {
    // Malformed localStorage data — fail safely, don't crash
    // Do NOT clear it — preserving potentially valid data is safer
    return [];
  }
}

function saveQueue(queue: PendingTransfer[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage full or unavailable — best-effort
    console.error('Failed to save pending transfer queue');
  }
}

// --- Queue operations ---

/** Add a new pending transfer. Generates UUID v4 idempotency key. Returns the key. */
export function addPending(recipientEmail: string, amount: number, notes: string): string {
  const idempotencyKey = crypto.randomUUID();
  const item: PendingTransfer = {
    idempotencyKey,
    recipientEmail,
    amount,
    notes,
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now(),
  };
  const queue = getQueue();
  queue.push(item);
  saveQueue(queue);
  return idempotencyKey;
}

/** Update a pending transfer's status by idempotency key. */
export function updatePending(
  idempotencyKey: string,
  updates: Partial<Pick<PendingTransfer, 'status' | 'retryCount' | 'lastError'>>
): void {
  const queue = getQueue();
  const idx = queue.findIndex((t) => t.idempotencyKey === idempotencyKey);
  if (idx !== -1) {
    queue[idx] = { ...queue[idx], ...updates };
    saveQueue(queue);
  }
}

/** Remove a pending transfer by idempotency key. Only call after definitive reconciliation. */
export function removePending(idempotencyKey: string): void {
  const queue = getQueue().filter((t) => t.idempotencyKey !== idempotencyKey);
  saveQueue(queue);
}

/** Get all pending/sending items that should be retried. */
export function getRetryable(): PendingTransfer[] {
  return getQueue().filter((t) => t.status === 'pending' || t.status === 'sending');
}

// --- Error classification ---

/** Returns true if the error is transient and the transfer should be retried. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof ApiError) {
    // 5xx = server error, retry
    if (err.status >= 500) return true;
    // 401 = auth expired, not transient per se but queue should be preserved
    // 400, 403, 404, 409 = permanent client error
    return false;
  }
  // Network errors, AbortError (timeout) = transient
  return true;
}

/** Returns true if the error means the transfer permanently failed. */
export function isPermanentError(err: unknown): boolean {
  if (err instanceof ApiError) {
    // 400 = bad request (insufficient funds, bad recipient, etc.)
    // 403 = forbidden
    // 404 = not found
    // 409 = conflict
    return err.status >= 400 && err.status < 500 && err.status !== 401;
  }
  return false;
}

/** Returns true if the error is an auth failure requiring re-login. */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// --- Queue processing ---

/**
 * Process all retryable items in the queue, one at a time (serialized).
 * 
 * The isProcessing lock prevents concurrent execution from:
 * - reconnect event + timer firing simultaneously
 * - component mount + online event
 * - manual retry + automatic retry
 */
export async function processQueue(): Promise<{ processed: number; authExpired: boolean }> {
  if (isProcessing) return { processed: 0, authExpired: false };
  isProcessing = true;

  let processed = 0;
  let authExpired = false;

  try {
    const retryable = getRetryable();
    
    for (const item of retryable) {
      // Re-read status in case another tab modified it
      const current = getQueue().find((t) => t.idempotencyKey === item.idempotencyKey);
      if (!current || current.status === 'completed' || current.status === 'permanentFailure') {
        continue;
      }

      updatePending(item.idempotencyKey, { status: 'sending' });

      try {
        await apiFetch('/transfers', {
          method: 'POST',
          headers: { 'Idempotency-Key': item.idempotencyKey },
          body: JSON.stringify({
            recipient_email: item.recipientEmail,
            amount: item.amount,
            notes: item.notes,
          }),
        });

        // Server confirmed — mark completed
        updatePending(item.idempotencyKey, { status: 'completed' });
        processed++;
      } catch (err) {
        if (isAuthError(err)) {
          // JWT expired — stop processing, preserve queue
          // Revert to pending so it can be retried after re-login
          updatePending(item.idempotencyKey, { status: 'pending' });
          authExpired = true;
          break;
        }

        if (isPermanentError(err)) {
          // Server rejected definitively (bad input, insufficient funds, etc.)
          // The server has recorded this as 'failed' with the same idempotency key
          updatePending(item.idempotencyKey, {
            status: 'permanentFailure',
            lastError: err instanceof Error ? err.message : 'Transfer failed',
            retryCount: item.retryCount + 1,
          });
          processed++;
        } else {
          // Transient error — revert to pending for future retry
          updatePending(item.idempotencyKey, {
            status: 'pending',
            retryCount: item.retryCount + 1,
            lastError: err instanceof Error ? err.message : 'Network error',
          });
        }
      }
    }
  } finally {
    isProcessing = false;
  }

  return { processed, authExpired };
}

// --- Reconciliation ---

/**
 * Reconcile pending items against server transfer history.
 * Items whose idempotency key appears in server history are resolved.
 * This handles the "commit + lost response" scenario.
 */
export function reconcile(serverTransfers: ServerTransfer[]): number {
  const queue = getQueue();
  if (queue.length === 0) return 0;

  const serverKeySet = new Set(serverTransfers.map((t) => t.idempotency_key));
  let reconciled = 0;

  for (const item of queue) {
    if (item.status === 'completed' || item.status === 'permanentFailure') {
      // Already resolved locally — can remove
      removePending(item.idempotencyKey);
      reconciled++;
    } else if (serverKeySet.has(item.idempotencyKey)) {
      // Server has this transfer — it committed. Mark resolved.
      removePending(item.idempotencyKey);
      reconciled++;
    }
    // If not in server history and not resolved, leave it pending for retry
  }

  return reconciled;
}

/** Returns true if there are any pending/sending items. */
export function hasPendingItems(): boolean {
  return getRetryable().length > 0;
}

/** Clear all completed and permanently failed items from the queue. */
export function clearResolved(): void {
  const queue = getQueue().filter(
    (t) => t.status === 'pending' || t.status === 'sending'
  );
  saveQueue(queue);
}

// For testing — reset the processing lock
export function _resetProcessingLock(): void {
  isProcessing = false;
}
