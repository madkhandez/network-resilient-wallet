import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, NetworkError, isOnline } from '../api';
import { useNetwork } from '../App';
import {
  addPending,
  updatePending,
  getQueue,
  processQueue,
  reconcile,
  clearResolved,
  hasPendingItems,
} from '../transferQueue';
import type { PendingTransfer, ServerTransfer } from '../transferQueue';

interface Profile {
  id: string;
  email: string;
  balance: number;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { online } = useNetwork();

  // --- Transfer form state ---
  const [recipientEmail, setRecipientEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [transferError, setTransferError] = useState('');
  const [transferSuccess, setTransferSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // --- Pending queue state (re-read from localStorage on each render) ---
  const pendingItems = getQueue();

  // --- Server data via TanStack Query ---
  const { data: profile, isLoading: profileLoading, error: profileError, dataUpdatedAt } = useQuery<Profile, ApiError | NetworkError>({
    queryKey: ['profile'],
    queryFn: () => apiFetch('/me'),
  });

  const { data: transfers } = useQuery<ServerTransfer[]>({
    queryKey: ['transfers'],
    queryFn: () => apiFetch('/transfers'),
  });

  // --- Clear notifications when online ---
  useEffect(() => {
    if (online) {
      setTransferError('');
      setTransferSuccess('');
    }
  }, [online]);

  // --- Logout ---
  const handleLogout = () => {
    localStorage.removeItem('jwt');
    localStorage.removeItem('last_active');
    navigate('/login');
  };

  // --- Submit transfer ---
  const handleTransfer = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setTransferError('');
    setTransferSuccess('');

    const amountCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      setTransferError('Amount must be greater than zero');
      return;
    }
    if (!recipientEmail.trim()) {
      setTransferError('Recipient email is required');
      return;
    }

    // Generate idempotency key and add to pending queue BEFORE sending
    const key = addPending(recipientEmail.trim(), amountCents, notes);
    setSubmitting(true);

    if (!isOnline()) {
      // Offline — transfer is queued, not sent
      setTransferSuccess('Transfer queued — will send when connected');
      setRecipientEmail('');
      setAmount('');
      setNotes('');
      setSubmitting(false);
      return;
    }

    try {
      await apiFetch('/transfers', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({
          recipient_email: recipientEmail.trim(),
          amount: amountCents,
          notes,
        }),
      });

      // Server confirmed — update pending item
      updatePending(key, { status: 'completed' });

      setTransferSuccess('Transfer completed successfully');
      setRecipientEmail('');
      setAmount('');
      setNotes('');

      // Refresh server-authoritative data
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['transfers'] });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          // Auth expired — queue preserved, redirect to login
          updatePending(key, { status: 'pending' });
          localStorage.removeItem('jwt');
          navigate('/login');
          return;
        }
        // Permanent server error (400 = insufficient funds, bad recipient, etc.)
        updatePending(key, {
          status: 'permanentFailure',
          lastError: err.message,
        });
        setTransferError(err.message);
      } else if (err instanceof NetworkError) {
        // Ambiguous failure — transfer stays pending, will retry
        setTransferError('Network error — transfer queued for retry');
      } else {
        setTransferError('An unexpected error occurred');
      }
    } finally {
      setSubmitting(false);
    }
  }, [recipientEmail, amount, notes, navigate, queryClient]);

  // --- Manual retry of pending queue ---
  const handleRetryQueue = useCallback(async () => {
    setTransferError('');
    setTransferSuccess('');

    if (!isOnline()) return;

    const { authExpired } = await processQueue();
    if (authExpired) {
      localStorage.removeItem('jwt');
      navigate('/login');
      return;
    }

    // Reconcile against server
    try {
      const serverTransfers: ServerTransfer[] = await apiFetch('/transfers');
      reconcile(serverTransfers);
    } catch {
      // Best-effort
    }

    queryClient.invalidateQueries({ queryKey: ['profile'] });
    queryClient.invalidateQueries({ queryKey: ['transfers'] });
  }, [navigate, queryClient]);

  // --- Clear resolved items ---
  const handleClearResolved = () => {
    clearResolved();
    // Force re-render by invalidating queries
    queryClient.invalidateQueries({ queryKey: ['profile'] });
  };

  // --- Balance display ---
  const balanceStale = !online || (profileError != null);
  const balanceDisplay = profile
    ? `$${(profile.balance / 100).toFixed(2)}`
    : '—';

  // --- Time since last update ---
  const lastUpdatedLabel = dataUpdatedAt
    ? `Last updated: ${new Date(dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';

  if (profileLoading && !profile) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className={`dashboard-container ${online ? 'dashboard-online' : 'dashboard-offline'}`}>
      <header className="dashboard-header">
        <div className="header-left">
          <h1>Hello {profile?.email ?? '...'}, welcome back</h1>
          {!online && (
            <span className="offline-badge" role="status">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '4px'}}>
                <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0119 12.55M5 9.86a10.94 10.94 0 00-3.28 2.69M1 12c.9-1.07 1.87-2.07 2.93-3M2 12h.01"></path>
              </svg>
              Offline
            </span>
          )}
        </div>
        <button onClick={handleLogout} className="logout-btn animate-hover">Logout</button>
      </header>
      
      <main className="dashboard-main">
        {/* --- Balance Card --- */}
        <div className="dashboard-card balance-card animate-hover">
          <h2>Your Balance</h2>
          <p className="balance-amount">{balanceDisplay}</p>
          {balanceStale && profile && (
            <p className="balance-stale">⚠ Balance may be stale — reconnect to refresh</p>
          )}
          <p className="balance-updated">{lastUpdatedLabel}</p>
        </div>

        {/* --- Transfer Form --- */}
        <div className="dashboard-card transfer-card">
          <h2>Send Transfer</h2>
          {transferError && <div className="error-alert">{transferError}</div>}
          {transferSuccess && <div className="success-alert">{transferSuccess}</div>}
          <form onSubmit={handleTransfer}>
            <div className="form-group">
              <label htmlFor="recipient-email">Recipient Email</label>
              <input
                id="recipient-email"
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="recipient@example.com"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="transfer-amount">Amount ($)</label>
              <input
                id="transfer-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="transfer-notes">Notes (optional)</label>
              <input
                id="transfer-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What's this for?"
              />
            </div>
            <button type="submit" disabled={submitting} id="submit-transfer" className="animate-hover">
              {submitting ? 'Sending...' : (online ? 'Send Transfer' : 'Queue Transfer (Offline)')}
            </button>
          </form>
        </div>

        {/* --- Pending Transfers --- */}
        {pendingItems.length > 0 && (
          <div className="dashboard-card pending-card">
            <div className="pending-header">
              <h2>Pending Transfers</h2>
              <div className="pending-actions">
                {online && hasPendingItems() && (
                  <button onClick={handleRetryQueue} className="retry-btn animate-hover" id="retry-queue">
                    Retry All
                  </button>
                )}
                {pendingItems.some(t => t.status === 'completed' || t.status === 'permanentFailure') && (
                  <button onClick={handleClearResolved} className="clear-btn animate-hover">
                    Clear Resolved
                  </button>
                )}
              </div>
            </div>
            <ul className="pending-list">
              {pendingItems.map((item) => (
                <PendingTransferItem key={item.idempotencyKey} item={item} />
              ))}
            </ul>
          </div>
        )}

        {/* --- Transfer History (from server) --- */}
        <div className="dashboard-card history-card">
          <div className="history-header">
            <h2>Transfer History</h2>
          </div>
          {transfers && transfers.length > 0 ? (
            <ul className="transfer-list">
              {transfers.map((t) => {
                const isSender = profile && t.sender_id === profile.id;
                return (
                <li key={t.id} className="transfer-item">
                  <div className="transfer-info">
                    <span className="transfer-direction">
                      {isSender ? '↑ Sent' : '↓ Received'}
                    </span>
                    <span className={`transfer-amount ${!isSender ? 'positive' : ''}`}>
                      {isSender ? '−' : '+'}${(t.amount / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="transfer-meta">
                    <span className={`status-badge status-${t.status}`}>
                      {t.status}
                    </span>
                    <span className="transfer-date">
                      {new Date(t.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </div>
                  {t.notes && <p className="transfer-notes">{t.notes}</p>}
                </li>
                );
              })}
            </ul>
          ) : (
            <p className="empty-state">No transfers yet</p>
          )}
        </div>
      </main>
    </div>
  );
}

// --- Pending Transfer Item Component ---
function PendingTransferItem({ item }: { item: PendingTransfer }) {
  const statusLabel: Record<string, string> = {
    pending: 'Pending (Offline)',
    sending: 'Sending...',
    completed: 'Completed',
    permanentFailure: 'Failed',
  };

  return (
    <li className={`pending-item`}>
      <div className="pending-info">
        <span className="pending-direction">
          To:
          <span className="pending-recipient">{item.recipientEmail}</span>
        </span>
        <span className="pending-amount">${(item.amount / 100).toFixed(2)}</span>
      </div>
      <div className="pending-meta">
        <span className={`status-badge status-${item.status}`}>
          {statusLabel[item.status] || item.status}
        </span>
        {item.retryCount > 0 && (
          <span className="pending-retries" style={{fontSize: '0.75rem', color: 'var(--text-secondary)'}}>
            Retries: {item.retryCount}
          </span>
        )}
      </div>
      {item.lastError && item.status === 'permanentFailure' && (
        <p className="pending-error">{item.lastError}</p>
      )}
    </li>
  );
}
