import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getQueue,
  addPending,
  updatePending,
  removePending,
  getRetryable,
  isTransientError,
  isPermanentError,
  isAuthError,
  processQueue,
  reconcile,
  hasPendingItems,
  clearResolved,
  _resetProcessingLock,
} from './transferQueue';
import type { ServerTransfer } from './transferQueue';
import { ApiError, NetworkError } from './api';

// Mock apiFetch globally for processQueue tests
vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return {
    ...original,
    apiFetch: vi.fn(),
  };
});

import { apiFetch } from './api';
const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  _resetProcessingLock();
  mockApiFetch.mockReset();
});

// =============================================================================
// 1. Queue basic operations
// =============================================================================
describe('Queue operations', () => {
  it('starts with an empty queue', () => {
    expect(getQueue()).toEqual([]);
  });

  it('adds a pending transfer with UUID idempotency key', () => {
    const key = addPending('bob@example.com', 50000, 'test note');

    expect(key).toBeTruthy();
    // UUID v4 format
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].idempotencyKey).toBe(key);
    expect(queue[0].recipientEmail).toBe('bob@example.com');
    expect(queue[0].amount).toBe(50000);
    expect(queue[0].notes).toBe('test note');
    expect(queue[0].status).toBe('pending');
    expect(queue[0].retryCount).toBe(0);
  });

  it('adds multiple items with unique idempotency keys', () => {
    const key1 = addPending('a@test.com', 1000, '');
    const key2 = addPending('b@test.com', 2000, '');
    const key3 = addPending('c@test.com', 3000, '');

    expect(key1).not.toBe(key2);
    expect(key2).not.toBe(key3);
    expect(getQueue()).toHaveLength(3);
  });

  it('updates a pending transfer status', () => {
    const key = addPending('bob@example.com', 50000, '');

    updatePending(key, { status: 'sending' });
    expect(getQueue()[0].status).toBe('sending');

    updatePending(key, { status: 'completed' });
    expect(getQueue()[0].status).toBe('completed');
  });

  it('updates retry count and last error', () => {
    const key = addPending('bob@example.com', 50000, '');

    updatePending(key, { retryCount: 3, lastError: 'timeout' });
    const item = getQueue()[0];
    expect(item.retryCount).toBe(3);
    expect(item.lastError).toBe('timeout');
  });

  it('does nothing when updating non-existent key', () => {
    addPending('bob@example.com', 50000, '');

    // Should not throw
    updatePending('non-existent-key', { status: 'completed' });
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].status).toBe('pending');
  });

  it('removes a pending transfer', () => {
    const key1 = addPending('a@test.com', 1000, '');
    const key2 = addPending('b@test.com', 2000, '');

    removePending(key1);
    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].idempotencyKey).toBe(key2);
  });

  it('removing non-existent key does not affect queue', () => {
    addPending('a@test.com', 1000, '');
    removePending('non-existent');
    expect(getQueue()).toHaveLength(1);
  });
});

// =============================================================================
// 2. UUID/idempotency key preservation
// =============================================================================
describe('Idempotency key preservation', () => {
  it('preserves idempotency key across status updates', () => {
    const key = addPending('bob@example.com', 50000, '');

    updatePending(key, { status: 'sending' });
    updatePending(key, { status: 'pending', retryCount: 1 });
    updatePending(key, { status: 'sending' });

    const item = getQueue()[0];
    expect(item.idempotencyKey).toBe(key);
  });

  it('each new transfer gets a unique idempotency key even for same payload', () => {
    const key1 = addPending('bob@example.com', 50000, 'same');
    const key2 = addPending('bob@example.com', 50000, 'same');

    expect(key1).not.toBe(key2);
  });
});

// =============================================================================
// 3. Queue persistence (localStorage)
// =============================================================================
describe('Queue persistence', () => {
  it('persists to localStorage', () => {
    addPending('bob@example.com', 50000, 'note');

    const raw = localStorage.getItem('pending_transfers');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].recipientEmail).toBe('bob@example.com');
  });

  it('survives simulated reload (read from persisted state)', () => {
    // Add items
    const key = addPending('bob@example.com', 50000, 'test');
    updatePending(key, { status: 'sending' });

    // Simulate reload: clear JS module state, read from localStorage
    _resetProcessingLock();

    // Queue should still be readable
    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].idempotencyKey).toBe(key);
    expect(queue[0].status).toBe('sending');
  });
});

// =============================================================================
// 4. Malformed localStorage handling
// =============================================================================
describe('Malformed localStorage', () => {
  it('returns empty array for null localStorage', () => {
    localStorage.removeItem('pending_transfers');
    expect(getQueue()).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    localStorage.setItem('pending_transfers', 'not valid json {{{');
    expect(getQueue()).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    localStorage.setItem('pending_transfers', '{"key": "value"}');
    expect(getQueue()).toEqual([]);
  });

  it('filters out items missing required fields', () => {
    localStorage.setItem('pending_transfers', JSON.stringify([
      { idempotencyKey: 'k1', recipientEmail: 'a@test.com', amount: 100, status: 'pending' }, // valid
      { recipientEmail: 'b@test.com', amount: 200 }, // missing idempotencyKey
      { idempotencyKey: 'k3', amount: 300 }, // missing recipientEmail
      { idempotencyKey: 'k4', recipientEmail: 'c@test.com', amount: -100, status: 'pending' }, // negative amount
      { idempotencyKey: 'k5', recipientEmail: 'd@test.com', amount: 0, status: 'pending' }, // zero amount
      null,
      42,
      'string item',
    ]));

    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].idempotencyKey).toBe('k1');
  });

  it('does not crash on empty string', () => {
    localStorage.setItem('pending_transfers', '');
    expect(getQueue()).toEqual([]);
  });

  it('handles corrupted data without creating unintended transfers', () => {
    // Even with malformed data, getQueue never returns items that could
    // be processed as valid transfers without proper validation
    localStorage.setItem('pending_transfers', JSON.stringify([
      { idempotencyKey: 123, recipientEmail: 'x@test.com', amount: 100, status: 'pending' },
    ]));

    const queue = getQueue();
    expect(queue).toHaveLength(0); // idempotencyKey is not a string
  });
});

// =============================================================================
// 5. Error classification
// =============================================================================
describe('Error classification', () => {
  it('classifies 500 as transient', () => {
    expect(isTransientError(new ApiError(500, 'Internal error'))).toBe(true);
    expect(isTransientError(new ApiError(502, 'Bad gateway'))).toBe(true);
    expect(isTransientError(new ApiError(503, 'Unavailable'))).toBe(true);
  });

  it('classifies network errors as transient', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new NetworkError('timeout'))).toBe(true);
    expect(isTransientError(new TypeError('NetworkError'))).toBe(true);
  });

  it('classifies 400 as permanent', () => {
    expect(isPermanentError(new ApiError(400, 'Bad request'))).toBe(true);
    expect(isPermanentError(new ApiError(403, 'Forbidden'))).toBe(true);
    expect(isPermanentError(new ApiError(404, 'Not found'))).toBe(true);
  });

  it('does NOT classify 401 as permanent (it is auth error)', () => {
    expect(isPermanentError(new ApiError(401, 'Unauthorized'))).toBe(false);
  });

  it('classifies 401 as auth error', () => {
    expect(isAuthError(new ApiError(401, 'Unauthorized'))).toBe(true);
    expect(isAuthError(new ApiError(400, 'Bad request'))).toBe(false);
    expect(isAuthError(new Error('generic'))).toBe(false);
  });

  it('network errors are not permanent', () => {
    expect(isPermanentError(new NetworkError('timeout'))).toBe(false);
    expect(isPermanentError(new Error('fetch failed'))).toBe(false);
  });
});

// =============================================================================
// 6. getRetryable
// =============================================================================
describe('getRetryable', () => {
  it('returns only pending and sending items', () => {
    const k1 = addPending('a@test.com', 100, '');
    const k2 = addPending('b@test.com', 200, '');
    const k3 = addPending('c@test.com', 300, '');
    const k4 = addPending('d@test.com', 400, '');

    updatePending(k2, { status: 'completed' });
    updatePending(k3, { status: 'permanentFailure' });
    updatePending(k4, { status: 'sending' });

    const retryable = getRetryable();
    expect(retryable).toHaveLength(2);
    expect(retryable.map(r => r.idempotencyKey)).toContain(k1);
    expect(retryable.map(r => r.idempotencyKey)).toContain(k4);
  });
});

// =============================================================================
// 7. processQueue
// =============================================================================
describe('processQueue', () => {
  it('processes pending items and marks them completed on success', async () => {
    mockApiFetch.mockResolvedValue({ status: 'completed' });

    addPending('bob@example.com', 50000, 'test');

    const result = await processQueue();
    expect(result.processed).toBe(1);
    expect(result.authExpired).toBe(false);

    const queue = getQueue();
    expect(queue[0].status).toBe('completed');
  });

  it('sends correct idempotency key in the request', async () => {
    mockApiFetch.mockResolvedValue({ status: 'completed' });

    const key = addPending('bob@example.com', 50000, 'test');
    await processQueue();

    expect(mockApiFetch).toHaveBeenCalledWith('/transfers', expect.objectContaining({
      method: 'POST',
      headers: { 'Idempotency-Key': key },
    }));
  });

  it('marks items as permanentFailure on 400 error', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(400, 'insufficient funds'));

    addPending('bob@example.com', 50000, '');
    await processQueue();

    const queue = getQueue();
    expect(queue[0].status).toBe('permanentFailure');
    expect(queue[0].lastError).toBe('insufficient funds');
  });

  it('reverts items to pending on transient error', async () => {
    mockApiFetch.mockRejectedValue(new NetworkError('timeout'));

    addPending('bob@example.com', 50000, '');
    await processQueue();

    const queue = getQueue();
    expect(queue[0].status).toBe('pending');
    expect(queue[0].retryCount).toBe(1);
  });

  it('stops processing and sets authExpired on 401', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(401, 'Unauthorized'));

    addPending('a@test.com', 1000, '');
    addPending('b@test.com', 2000, '');

    const result = await processQueue();
    expect(result.authExpired).toBe(true);
    // First item reverted to pending (not lost)
    expect(getQueue()[0].status).toBe('pending');
    // Second item never touched
    expect(getQueue()[1].status).toBe('pending');
  });

  it('prevents concurrent processing (lock mechanism)', async () => {
    // Make apiFetch slow
    mockApiFetch.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ status: 'completed' }), 100)));

    addPending('bob@example.com', 50000, '');

    // Start two concurrent processQueue calls
    const [result1, result2] = await Promise.all([
      processQueue(),
      processQueue(),
    ]);

    // One should have processed, the other should have been locked out
    expect(result1.processed + result2.processed).toBe(1);
  });

  it('skips already completed items', async () => {
    const key = addPending('bob@example.com', 50000, '');
    updatePending(key, { status: 'completed' });

    const result = await processQueue();
    expect(result.processed).toBe(0);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('skips permanently failed items', async () => {
    const key = addPending('bob@example.com', 50000, '');
    updatePending(key, { status: 'permanentFailure' });

    const result = await processQueue();
    expect(result.processed).toBe(0);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 8. Reconciliation
// =============================================================================
describe('reconcile', () => {
  it('removes pending items found in server history', () => {
    const key1 = addPending('a@test.com', 1000, '');
    const key2 = addPending('b@test.com', 2000, '');

    const serverTransfers: ServerTransfer[] = [
      {
        id: 'server-1',
        idempotency_key: key1,
        sender_id: 'sender',
        recipient_id: 'recipient',
        amount: 1000,
        notes: '',
        status: 'completed',
        created_at: new Date().toISOString(),
      },
    ];

    const count = reconcile(serverTransfers);
    expect(count).toBe(1);

    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].idempotencyKey).toBe(key2);
  });

  it('removes locally completed items', () => {
    const key = addPending('a@test.com', 1000, '');
    updatePending(key, { status: 'completed' });

    const count = reconcile([]);
    expect(count).toBe(1);
    expect(getQueue()).toHaveLength(0);
  });

  it('removes permanently failed items', () => {
    const key = addPending('a@test.com', 1000, '');
    updatePending(key, { status: 'permanentFailure' });

    const count = reconcile([]);
    expect(count).toBe(1);
    expect(getQueue()).toHaveLength(0);
  });

  it('leaves unresolved pending items in the queue', () => {
    addPending('a@test.com', 1000, '');

    const count = reconcile([]); // server has no matching transfer
    expect(count).toBe(0);
    expect(getQueue()).toHaveLength(1);
  });

  it('handles commit + lost response: server has it, client still pending', () => {
    // This is the critical scenario: transfer committed on server but
    // client never got the response. The pending item remains.
    // After reconciliation, the pending item should be removed.
    const key = addPending('a@test.com', 5000, 'important');

    const serverTransfers: ServerTransfer[] = [{
      id: 'server-uuid',
      idempotency_key: key,
      sender_id: 'me',
      recipient_id: 'them',
      amount: 5000,
      notes: 'important',
      status: 'completed',
      created_at: new Date().toISOString(),
    }];

    reconcile(serverTransfers);
    expect(getQueue()).toHaveLength(0);
  });

  it('returns 0 for empty queue', () => {
    expect(reconcile([])).toBe(0);
  });
});

// =============================================================================
// 9. hasPendingItems
// =============================================================================
describe('hasPendingItems', () => {
  it('returns false for empty queue', () => {
    expect(hasPendingItems()).toBe(false);
  });

  it('returns true when pending items exist', () => {
    addPending('a@test.com', 1000, '');
    expect(hasPendingItems()).toBe(true);
  });

  it('returns false when all items are resolved', () => {
    const k1 = addPending('a@test.com', 1000, '');
    const k2 = addPending('b@test.com', 2000, '');
    updatePending(k1, { status: 'completed' });
    updatePending(k2, { status: 'permanentFailure' });
    expect(hasPendingItems()).toBe(false);
  });
});

// =============================================================================
// 10. clearResolved
// =============================================================================
describe('clearResolved', () => {
  it('removes completed and failed items, keeps pending', () => {
    const k1 = addPending('a@test.com', 1000, '');
    const k2 = addPending('b@test.com', 2000, '');
    const k3 = addPending('c@test.com', 3000, '');

    updatePending(k1, { status: 'completed' });
    updatePending(k2, { status: 'permanentFailure' });

    clearResolved();
    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].idempotencyKey).toBe(k3);
  });
});

// =============================================================================
// 11. Adversarial scenario tests
// =============================================================================
describe('Adversarial scenarios', () => {
  it('Scenario 1: commit + lost response — retry with same key succeeds', async () => {
    // First call: server commits but client times out (network error)
    // Second call: server returns existing transfer (idempotent replay)
    mockApiFetch
      .mockRejectedValueOnce(new NetworkError('timeout'))
      .mockResolvedValueOnce({ status: 'completed', idempotency_key: 'the-key' });

    const key = addPending('bob@example.com', 50000, '');

    // First attempt — times out
    await processQueue();
    expect(getQueue()[0].status).toBe('pending'); // reverted to pending
    expect(getQueue()[0].retryCount).toBe(1);

    // Second attempt — succeeds with same key
    await processQueue();
    expect(getQueue()[0].status).toBe('completed');

    // Verify same idempotency key used both times
    const calls = mockApiFetch.mock.calls;
    expect(calls[0][1]?.headers).toEqual({ 'Idempotency-Key': key });
    expect(calls[1][1]?.headers).toEqual({ 'Idempotency-Key': key });
  });

  it('Scenario 2: permanent failure does not loop', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(400, 'insufficient funds'));

    addPending('bob@example.com', 99999999, '');

    await processQueue();
    expect(getQueue()[0].status).toBe('permanentFailure');

    // Subsequent processQueue calls should not reprocess
    mockApiFetch.mockClear();
    await processQueue();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('Scenario 3: JWT expires during offline — queue preserved', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(401, 'Unauthorized'));

    const key = addPending('bob@example.com', 50000, '');
    const result = await processQueue();

    expect(result.authExpired).toBe(true);
    // Queue is preserved — not lost
    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].idempotencyKey).toBe(key);
    expect(queue[0].status).toBe('pending');
  });

  it('Scenario 4: manual transfer + pending queue have different keys', () => {
    // Pending transfer from previous session
    const pendingKey = addPending('alice@test.com', 1000, 'previous');

    // New manual transfer
    const manualKey = addPending('bob@test.com', 2000, 'new');

    expect(pendingKey).not.toBe(manualKey);
    expect(getQueue()).toHaveLength(2);
  });

  it('Scenario 5: queue state never becomes financial truth', () => {
    // Add items, mark some completed
    const k1 = addPending('a@test.com', 1000, '');
    updatePending(k1, { status: 'completed' });

    // The queue records status but has NO balance field
    // There's no way for queue data to represent or modify balances
    const queue = getQueue();
    expect(queue[0]).not.toHaveProperty('balance');
    expect(queue[0]).not.toHaveProperty('senderBalance');
  });
});
