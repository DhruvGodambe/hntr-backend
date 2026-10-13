import AdminSettings from '../models/AdminSettings';
import PriorityLineDeposit from '../models/PriorityLineDeposit';
import SyncState from '../models/SyncState';
import { ENV } from '../config/env';
import { hntrContract, provider } from './contract.service';
import { EtherscanTokenTransfer, getTokenTransfersViaEtherscan } from './etherscan.service';
import { PriorityLineError, PriorityLineService, PriorityToken } from './priorityLine.service';
import { logger } from '../utils/logger';

/**
 * Server-side safety net for Priority Line deposits.
 *
 * A deposit is normally recorded when the member's browser calls /deposit/confirm after the
 * transfer mines. That call can be lost: the mobile wallet app kills the tab before the hash
 * reaches the page, confirm retries run out while the RPC lags, the session expires, or the
 * member simply sends to the deposit wallet by hand. Each of those leaves a real on-chain
 * transfer with no DB row.
 *
 * This job reads every inbound USDT/USDC transfer to the deposit wallet(s) from Etherscan and
 * pushes any it has not seen through the exact same confirmDeposit path, so verification, the
 * cap/REVIEW split, replay protection and notifications are identical to a browser confirm.
 * A deposit credited late is slotted into the line by its on-chain time, not appended.
 */

// Per chain, so a testnet dev server and the mainnet server sharing a DB keep separate cursors.
const syncKey = () => `priority-line-reconciler:${ENV.ETHERSCAN_CHAIN_ID}`;
// Re-scan this many blocks behind the cursor to absorb Etherscan indexing lag and short reorgs.
// Already-recorded hashes are skipped with a single indexed lookup, so the overlap is cheap.
const OVERLAP_BLOCKS = 300;
const MIN_CONFIRMATIONS = 3;

// confirmDeposit errors that will never succeed on retry; anything else holds the cursor back.
const PERMANENT_ERRORS = new Set(['BELOW_MINIMUM', 'TRANSFER_NOT_FOUND', 'TX_FAILED', 'TX_ALREADY_USED', 'UNSUPPORTED_TOKEN']);

let running = false;
let chainChecked: boolean | null = null;

export function isPriorityLineReconcilerEnabled(): boolean {
  return (process.env.PRIORITY_LINE_RECONCILE || '').trim().toLowerCase() !== 'false';
}

async function rpcMatchesEtherscanChain(): Promise<boolean> {
  if (chainChecked !== null) return chainChecked;
  const { chainId } = await provider.getNetwork();
  chainChecked = Number(chainId) === ENV.ETHERSCAN_CHAIN_ID;
  if (!chainChecked) {
    logger.error(
      `[PriorityLine reconcile] disabled: RPC chain ${chainId} != ETHERSCAN_CHAIN_ID ${ENV.ETHERSCAN_CHAIN_ID}`,
    );
  }
  return chainChecked;
}

export interface ReconcileResult {
  scanned: number;
  credited: { txHash: string; from: string; token: PriorityToken; amount: string }[];
  skipped: { txHash: string; from: string; reason: string }[];
  cursor: number;
}

export async function reconcilePriorityLineDeposits(): Promise<ReconcileResult | null> {
  if (running) return null;
  running = true;
  try {
    if (!ENV.ETHERSCAN_API_KEY) {
      logger.warn('[PriorityLine reconcile] ETHERSCAN_API_KEY not set; skipping');
      return null;
    }
    if (!(await rpcMatchesEtherscanChain())) return null;

    const settings = await AdminSettings.findOne({ key: 'global' }).lean();
    const wallets = Array.from(
      new Set(
        [settings?.priorityLineDepositWallet, ...(settings?.priorityLineWalletHistory ?? [])]
          .filter((a): a is string => !!a)
          .map((a) => a.toLowerCase()),
      ),
    );
    if (!wallets.length) return null;

    const [usdt, usdc] = await Promise.all([hntrContract.usdt(), hntrContract.usdc()]);
    const tokens: [PriorityToken, string][] = [
      ['USDT', String(usdt).toLowerCase()],
      ['USDC', String(usdc).toLowerCase()],
    ];

    const state = await SyncState.findOne({ key: syncKey() }).lean();
    const prevCursor = state?.lastProcessedBlock ?? 0;
    const fromBlock = Math.max(0, prevCursor - OVERLAP_BLOCKS);

    const result: ReconcileResult = { scanned: 0, credited: [], skipped: [], cursor: prevCursor };
    let maxDone = prevCursor;
    let firstPending: number | null = null; // lowest block that must be retried next run
    const hold = (block: number) => {
      firstPending = firstPending === null ? block : Math.min(firstPending, block);
    };

    const inbound: (EtherscanTokenTransfer & { token: PriorityToken })[] = [];
    for (const wallet of wallets) {
      for (const [symbol, tokenAddress] of tokens) {
        const transfers = await getTokenTransfersViaEtherscan({ address: wallet, contractAddress: tokenAddress, fromBlock });
        // Outgoing payouts from the deposit wallet are not deposits.
        for (const t of transfers) if (t.to === wallet) inbound.push({ ...t, token: symbol });
      }
    }
    // Oldest first, so several late deposits land in the line in the order they were sent.
    inbound.sort((a, b) => a.blockNumber - b.blockNumber);
    result.scanned = inbound.length;

    // Stamp exact chain time on recorded deposits before slotting anything against them
    // (rows from before txTimestamp existed only have their createdAt).
    const recorded = await PriorityLineDeposit.find({ txHash: { $in: inbound.map((t) => t.hash) } })
      .select('txHash txTimestamp')
      .lean();
    const recordedHashes = new Set(recorded.map((r) => r.txHash));
    const unstamped = new Set(recorded.filter((r) => !r.txTimestamp).map((r) => r.txHash));
    for (const t of inbound) {
      if (!unstamped.delete(t.hash)) continue;
      await PriorityLineDeposit.updateMany(
        { txHash: t.hash, txTimestamp: { $exists: false } },
        { $set: { txTimestamp: new Date(t.timeStamp * 1000) } },
      );
    }

    for (const t of inbound) {
      if (t.confirmations < MIN_CONFIRMATIONS) {
        hold(t.blockNumber);
        continue;
      }
      if (recordedHashes.has(t.hash)) {
        maxDone = Math.max(maxDone, t.blockNumber);
        continue;
      }

      try {
        await PriorityLineService.confirmDeposit(t.from, t.hash, t.token);
        recordedHashes.add(t.hash);
        result.credited.push({ txHash: t.hash, from: t.from, token: t.token, amount: t.value });
        logger.warn(
          `[PriorityLine reconcile] credited deposit the browser never confirmed: ${t.hash} from ${t.from} (${t.token} raw ${t.value})`,
        );
        maxDone = Math.max(maxDone, t.blockNumber);
      } catch (err: any) {
        if (err instanceof PriorityLineError && PERMANENT_ERRORS.has(err.code)) {
          // e.g. sub-minimum dust from address-poisoning spam.
          result.skipped.push({ txHash: t.hash, from: t.from, reason: err.code });
          maxDone = Math.max(maxDone, t.blockNumber);
        } else {
          logger.error(`[PriorityLine reconcile] ${t.hash} will be retried: ${err?.message || err}`);
          hold(t.blockNumber);
        }
      }
    }

    // Never move past a transfer that still needs a retry; it stays inside the next scan window.
    const pending = firstPending as number | null;
    const next = pending === null ? maxDone : Math.min(maxDone, pending - 1);
    result.cursor = Math.max(prevCursor, next);
    if (result.cursor !== prevCursor) {
      await SyncState.findOneAndUpdate(
        { key: syncKey() },
        { key: syncKey(), lastProcessedBlock: result.cursor, updatedAt: new Date() },
        { upsert: true },
      );
    }
    return result;
  } finally {
    running = false;
  }
}
