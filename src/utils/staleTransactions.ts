import Transaction, { ITransaction } from '../models/Transaction';

/**
 * After this long with no confirmation/failure, a PENDING relay record is treated
 * as abandoned (e.g. the backend process restarted mid-flight) instead of a
 * permanent lock. `Transaction` has a unique partial index on
 * {walletAddress, type} while status === 'PENDING', so without this recovery a
 * single interrupted purchase/upgrade/claim would leave that wallet unable to
 * ever retry that action again until someone manually fixed the DB record.
 */
export const STALE_PENDING_RELAY_MS = 3 * 60 * 1000;

/**
 * Returns the still-active PENDING transaction for this wallet+type, if any.
 * Any PENDING record older than STALE_PENDING_RELAY_MS is auto-marked FAILED
 * first, so an interrupted relay can't permanently lock this wallet+type out.
 */
export async function findActivePendingRelay(
  walletAddress: string,
  type: ITransaction['type'],
): Promise<ITransaction | null> {
  const pending = await Transaction.findOne({ walletAddress: walletAddress.toLowerCase(), type, status: 'PENDING' });
  if (!pending) return null;

  const ageMs = Date.now() - pending.timestamp.getTime();
  if (ageMs > STALE_PENDING_RELAY_MS) {
    pending.status = 'FAILED';
    pending.errorMessage = 'Auto-recovered: relay appeared abandoned (no confirmation within timeout).';
    await pending.save();
    return null;
  }
  return pending;
}

/**
 * Marks a PENDING relay as FAILED (e.g. user rejected the wallet prompt).
 * Only the owning wallet can fail its own relay; already-finalized rows are a no-op.
 */
export async function failPendingRelay(params: {
  walletAddress: string;
  pendingTransactionId: string;
  reason?: string;
}): Promise<ITransaction | null> {
  const pending = await Transaction.findById(params.pendingTransactionId);
  if (!pending) return null;

  if (pending.walletAddress.toLowerCase() !== params.walletAddress.toLowerCase()) {
    throw new Error('Not authorized to fail this transaction');
  }

  if (pending.status !== 'PENDING') {
    return pending;
  }

  pending.status = 'FAILED';
  pending.errorMessage =
    (params.reason && String(params.reason).slice(0, 500)) ||
    'Wallet request was cancelled or failed before confirmation.';
  await pending.save();
  return pending;
}
