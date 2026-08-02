import { Request, Response, NextFunction } from 'express';
import { ethers } from 'ethers';
import { NetworkService } from '../services/network.service';
import { RewardsService } from '../services/rewards.service';
import { PointsService } from '../services/points.service';
import { NotificationService } from '../services/notification.service';
import User from '../models/User';
import { contractABI, CONTRACT_ADDRESS, getContractAmountDecimals } from '../services/contract.service';
import { getLogsViaEtherscan } from '../services/etherscan.service';
import { ENV } from '../config/env';
import Transaction from '../models/Transaction';
import Payout from '../models/Payout';
import AchievementBonus from '../models/AchievementBonus';
import { failPendingRelay as markPendingRelayFailed, findActivePendingRelay, submitPendingRelay } from '../utils/staleTransactions';
import { sendSuccess, sendError } from '../utils/response';

const TIER_NAMES = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

function mapRewardStatus(status: 'PENDING' | 'PAID' | 'FAILED'): 'PENDING' | 'CONFIRMED' | 'FAILED' {
  if (status === 'PAID') return 'CONFIRMED';
  if (status === 'FAILED') return 'FAILED';
  return 'PENDING';
}

export class NetworkController {
  static async getUplines(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      const uplines = await NetworkService.getUplines(username as string);
      sendSuccess(res, { uplines }, 'Uplines retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  static async getDownline(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      const downlines = await NetworkService.getDownline(username as string);
      sendSuccess(res, { downlines }, 'Downline retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  static async getNetworkTree(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      // Match frontend NETWORK_TREE_DEPTH_OPTIONS (3/6/9/12). Cap at 12 to bound recursion.
      const requested = Number(req.query.depth) || 3;
      const allowed = [3, 6, 9, 12];
      const depth = allowed.includes(requested) ? requested : Math.min(Math.max(requested, 1), 12);
      const tree = await NetworkService.getNetworkTree(username as string, depth);
      if (!tree) {
        sendError(res, 'User not found', 404);
        return;
      }
      sendSuccess(res, { tree }, 'Network tree retrieved successfully');
    } catch (error) {
      next(error);
    }
  }


  static async claimCommissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // walletAddress comes from the authenticated session (requireWalletAuth), never
      // from the request body. The user signs and submits withdrawCommissions() themselves
      // and pays the gas; the backend only prepares the call data and tracks it via events.
      const walletAddress = req.walletAddress!;
      const { token } = req.body;

      if (!token) {
        sendError(res, 'token is required', 400);
        return;
      }

      const normalizedToken = String(token).toLowerCase();
      const pending = await findActivePendingRelay(walletAddress, 'COMMISSION_CLAIM', normalizedToken);
      if (pending) {
        sendError(res, 'A commission claim for this token is already in progress.', 409);
        return;
      }

      const txnRecord = await Transaction.create({
        walletAddress: walletAddress.toLowerCase(),
        type: 'COMMISSION_CLAIM',
        token: normalizedToken,
        amount: 0,
        status: 'PENDING',
      });

      sendSuccess(
        res,
        {
          operation: 'COMMISSION_CLAIM',
          walletAddress: walletAddress.toLowerCase(),
          tokenAddress: normalizedToken,
          contractAddress: CONTRACT_ADDRESS,
          pendingTransactionId: txnRecord._id.toString(),
          status: 'PENDING',
        },
        'Commission claim prepared; submit withdrawCommissions() from your wallet',
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * Marks a prepared PENDING relay (claim / purchase / upgrade) as FAILED when the
   * user rejects the wallet prompt or the client aborts before on-chain confirmation.
   */
  static async failPendingRelay(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const walletAddress = req.walletAddress!;
      const { pendingTransactionId, reason } = req.body || {};

      if (!pendingTransactionId || typeof pendingTransactionId !== 'string') {
        sendError(res, 'pendingTransactionId is required', 400);
        return;
      }

      try {
        const updated = await markPendingRelayFailed({
          walletAddress,
          pendingTransactionId,
          reason: typeof reason === 'string' ? reason : undefined,
        });
        if (!updated) {
          sendError(res, 'Transaction not found', 404);
          return;
        }
        sendSuccess(
          res,
          {
            pendingTransactionId: updated._id.toString(),
            status: updated.status,
            type: updated.type,
          },
          updated.status === 'FAILED' ? 'Pending relay marked as failed' : 'Transaction already finalized',
        );
      } catch (err: any) {
        if (err?.message === 'Not authorized to fail this transaction') {
          sendError(res, err.message, 403);
          return;
        }
        throw err;
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * Attaches the broadcast tx hash to a PENDING relay immediately after wallet submit.
   */
  static async submitPendingRelay(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const walletAddress = req.walletAddress!;
      const { pendingTransactionId, txHash } = req.body || {};

      if (!pendingTransactionId || typeof pendingTransactionId !== 'string') {
        sendError(res, 'pendingTransactionId is required', 400);
        return;
      }
      if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
        sendError(res, 'txHash is required', 400);
        return;
      }

      try {
        const updated = await submitPendingRelay({
          walletAddress,
          pendingTransactionId,
          txHash,
        });
        if (!updated) {
          sendError(res, 'Transaction not found', 404);
          return;
        }
        sendSuccess(
          res,
          {
            pendingTransactionId: updated._id.toString(),
            status: updated.status,
            txHash: updated.txHash,
            type: updated.type,
          },
          'Pending relay updated with tx hash',
        );
      } catch (err: any) {
        if (err?.message === 'Not authorized to update this transaction') {
          sendError(res, err.message, 403);
          return;
        }
        throw err;
      }
    } catch (error) {
      next(error);
    }
  }

  static async getTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const limit = Math.min(Number(req.query.limit) || 25, 100);
      const iface = new ethers.Interface(contractABI);
      const amountDecimals = await getContractAmountDecimals();

      const addressString = Array.isArray(walletAddress) ? walletAddress[0] : walletAddress;
      const normalizedAddress = addressString.toLowerCase();
      const paddedAddress = ethers.zeroPadValue(normalizedAddress, 32);

      const eventSignatures: Record<string, string> = {
        CommissionEarned: ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)'),
        CommissionWithdrawn: ethers.id('CommissionWithdrawn(address,uint256,address)'),
        MembershipPurchased: ethers.id('MembershipPurchased(address,uint8,uint256,address)'),
        MembershipUpgraded: ethers.id('MembershipUpgraded(address,uint8,uint8,uint256,address)'),
      };

      // Fetched via Etherscan (not raw eth_getLogs) so this covers the contract's
      // entire history instead of just whatever recent window the public RPC
      // allows before demanding an archive-node token. See etherscan.service.ts.
      const chainLogsPromise = Promise.all(
        Object.entries(eventSignatures).map(async ([type, sig]) => {
          const logs = await getLogsViaEtherscan({
            address: CONTRACT_ADDRESS,
            topics: [sig, paddedAddress],
            fromBlock: ENV.CONTRACT_DEPLOY_BLOCK,
          });
          return logs.map((l) => ({ type, log: l }));
        })
      );

      // Also pull DB-persisted records (pending relay claims, and commission events
      // captured by the blockchain listener). This ensures the 80/20 split data is
      // available even if the Etherscan API is slow or unavailable, and includes
      // off-chain metadata like per-token locked amounts.
      // Leadership / achievement cron dispersals live in separate collections and
      // are merged into the same history response so the frontend only needs one API.
      const dbRecordsPromise = Transaction.find({ walletAddress: normalizedAddress })
        .sort({ timestamp: -1 })
        .limit(limit * 2)
        .lean();
      const leadershipPayoutsPromise = Payout.find({ walletAddress: normalizedAddress })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      const achievementBonusesPromise = AchievementBonus.find({ walletAddress: normalizedAddress })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      const [allLogs, dbRecords, leadershipPayouts, achievementBonuses] = await Promise.all([
        chainLogsPromise,
        dbRecordsPromise,
        leadershipPayoutsPromise,
        achievementBonusesPromise,
      ]);

      const flatLogs = allLogs.flat().sort((a, b) => b.log.blockNumber - a.log.blockNumber).slice(0, limit);

      const toDollars = (raw: bigint): string => ethers.formatUnits(raw, amountDecimals);

      const chainTransactions = flatLogs.map(({ type, log }) => {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        const base = {
          type,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          timestamp: log.timeStamp ? new Date(log.timeStamp * 1000).toISOString() : null,
        };

        if (!parsed) return { ...base, amount: null, token: null };

        switch (type) {
          case 'CommissionEarned': {
            const [, liquidAmount, lockedAmount, level, token] = parsed.args;
            return {
              ...base,
              amount: toDollars(BigInt(liquidAmount.toString())),
              lockedAmount: toDollars(BigInt(lockedAmount.toString())),
              level: Number(level),
              token,
            };
          }
          case 'CommissionWithdrawn': {
            const [, amount, token] = parsed.args;
            return { ...base, amount: toDollars(BigInt(amount.toString())), token };
          }
          case 'MembershipPurchased': {
            const [buyer, tier, amount, token] = parsed.args;
            return {
              ...base,
              amount: toDollars(BigInt(amount.toString())),
              token,
              tier: TIER_NAMES[Number(tier)] || 'None',
              sourceWalletAddress: String(buyer).toLowerCase(),
            };
          }
          case 'MembershipUpgraded': {
            const [buyer, , newTier, amountPaid, token] = parsed.args;
            return {
              ...base,
              amount: toDollars(BigInt(amountPaid.toString())),
              token,
              tier: TIER_NAMES[Number(newTier)] || 'None',
              sourceWalletAddress: String(buyer).toLowerCase(),
            };
          }
          default:
            return { ...base, amount: null, token: null };
        }
      });

      const dbTransactions = dbRecords.map((record) => {
        const base = {
          type: record.type,
          txHash: record.txHash || undefined,
          blockNumber: 0,
          timestamp: record.timestamp ? new Date(record.timestamp).toISOString() : null,
        };

        // DB records already store dollar amounts; the frontend now displays them directly.
        const amount = (value: number | undefined): string => (value ?? 0).toFixed(2);

        switch (record.type) {
          case 'COMMISSION_EARNED':
            return {
              ...base,
              amount: amount(record.liquidAmount),
              lockedAmount: amount(record.lockedAmount),
              level: record.level ?? undefined,
              token: record.token,
              sourceWalletAddress: record.sourceWalletAddress || undefined,
            };
          case 'COMMISSION_WITHDRAWN':
          case 'COMMISSION_CLAIM':
            return {
              ...base,
              amount: amount(record.amount),
              token: record.token,
              status: record.status,
            };
          case 'PURCHASE':
          case 'UPGRADE':
            return {
              ...base,
              amount: amount(record.amount),
              token: record.token,
              tier: record.tier,
              status: record.status,
            };
          default:
            return { ...base, amount: amount(record.amount), token: record.token };
        }
      });

      const cronTransactions = [
        ...leadershipPayouts.map((payout) => {
          const paidEntry = (payout.breakdown || []).find((b) => b.status === 'PAID' && b.txHash);
          return {
            type: 'LEADERSHIP_PAYOUT',
            txHash: paidEntry?.txHash || payout.txHash || undefined,
            blockNumber: 0,
            timestamp: payout.createdAt ? new Date(payout.createdAt).toISOString() : null,
            amount: Number(payout.amountUSDC || 0).toFixed(2),
            token: paidEntry?.symbol || payout.breakdown?.[0]?.symbol || null,
            tier: payout.month,
            status: mapRewardStatus(payout.status),
          };
        }),
        ...achievementBonuses.map((bonus) => ({
          type: 'ACHIEVEMENT_BONUS',
          txHash: bonus.txHash || undefined,
          blockNumber: 0,
          timestamp: bonus.paidAt
            ? new Date(bonus.paidAt).toISOString()
            : bonus.createdAt
              ? new Date(bonus.createdAt).toISOString()
              : null,
          amount: Number(bonus.amountUSD || 0).toFixed(2),
          token: bonus.token || null,
          tier: bonus.rank,
          status: mapRewardStatus(bonus.status),
        })),
      ];

      // Merge chain + DB records. Normalize aliased types so one purchase does not
      // appear three times (Etherscan MembershipPurchased + DB PURCHASE + PENDING).
      const isClaimType = (type: string) =>
        type === 'COMMISSION_CLAIM' || type === 'COMMISSION_WITHDRAWN' || type === 'CommissionWithdrawn';

      const normalizeType = (type: string) => {
        if (type === 'MembershipPurchased' || type === 'PURCHASE') return 'PURCHASE';
        if (type === 'MembershipUpgraded' || type === 'UPGRADE') return 'UPGRADE';
        if (isClaimType(type)) return 'CLAIM';
        if (type === 'CommissionEarned' || type === 'COMMISSION_EARNED') return 'COMMISSION_EARNED';
        return type;
      };

      const merged = new Map<string, any>();

      const addToMerged = (item: any) => {
        const normalized = normalizeType(item.type);

        // Never surface hash-less prepare stubs (purchase / upgrade / claim) once any
        // confirmed on-chain counterpart exists — those show up as "$0 Pending".
        if (!item.txHash && (normalized === 'PURCHASE' || normalized === 'UPGRADE' || normalized === 'CLAIM')) {
          for (const existing of merged.values()) {
            if (normalizeType(existing.type) === normalized && existing.txHash) {
              return;
            }
          }
          // Also hide abandoned $0 claim prepares even if no other claim is loaded yet.
          if (normalized === 'CLAIM' && (item.status === 'PENDING' || item.status === 'FAILED') && Number(item.amount || 0) === 0) {
            return;
          }
        }

        const key = item.txHash && normalized === 'CLAIM'
          ? `${item.txHash}-claim`
          : item.type === 'LEADERSHIP_PAYOUT'
            ? `leadership-${item.tier || item.txHash || item.timestamp}`
            : item.type === 'ACHIEVEMENT_BONUS'
              ? `achievement-${item.tier || item.txHash || item.timestamp}`
              : item.level !== undefined
                ? `${item.txHash || 'pending'}-${normalized}-${item.level}`
                : `${item.txHash || 'pending'}-${normalized}`;

        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, item);
          return;
        }

        // Prefer a confirmed claim with a hash over a PENDING prepare stub.
        if (normalized === 'CLAIM') {
          const itemIsPendingStub = !item.txHash || item.status === 'PENDING';
          const existingIsPendingStub = !existing.txHash || existing.status === 'PENDING';
          if (itemIsPendingStub && !existingIsPendingStub) return;
          if (!itemIsPendingStub && existingIsPendingStub) {
            merged.set(key, item);
            return;
          }
          if (item.type === 'COMMISSION_CLAIM' && item.txHash) {
            merged.set(key, item);
            return;
          }
        }

        // Prefer the entry that already has a txHash / blockNumber.
        if (!existing.txHash && item.txHash) {
          merged.set(key, item);
        }
      };

      // Chain first (has block timestamps), then DB (fills gaps + pending/status),
      // then cron dispersals (leadership / rank bonus).
      chainTransactions.forEach(addToMerged);
      dbTransactions.forEach(addToMerged);
      cronTransactions.forEach(addToMerged);

      // Map purchase/upgrade txHash → buyer wallet so commission rows can show source user.
      const buyerByTxHash = new Map<string, string>();
      const chainRows: any[] = chainTransactions;
      for (const item of chainRows) {
        const normalized = normalizeType(String(item.type));
        if (
          (normalized === 'PURCHASE' || normalized === 'UPGRADE') &&
          item.txHash &&
          item.sourceWalletAddress
        ) {
          buyerByTxHash.set(String(item.txHash).toLowerCase(), String(item.sourceWalletAddress).toLowerCase());
        }
      }
      for (const record of dbRecords) {
        if (
          (record.type === 'PURCHASE' || record.type === 'UPGRADE') &&
          record.txHash &&
          record.walletAddress
        ) {
          buyerByTxHash.set(record.txHash.toLowerCase(), record.walletAddress.toLowerCase());
        }
      }

      const transactions = Array.from(merged.values())
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, limit);

      // Commission earner's history never includes the buyer's PURCHASE row (different wallet),
      // so resolve missing sources by looking up purchase/upgrade records for those tx hashes.
      const missingSourceHashes = [
        ...new Set(
          transactions
            .filter((tx) => {
              const normalized = normalizeType(tx.type);
              return (
                normalized === 'COMMISSION_EARNED' &&
                !tx.sourceWalletAddress &&
                !!tx.txHash
              );
            })
            .map((tx) => String(tx.txHash).toLowerCase()),
        ),
      ];
      if (missingSourceHashes.length > 0) {
        const purchaseRows = await Transaction.find({
          txHash: { $in: missingSourceHashes },
          type: { $in: ['PURCHASE', 'UPGRADE'] },
        })
          .select('txHash walletAddress')
          .lean();
        for (const row of purchaseRows) {
          if (row.txHash && row.walletAddress) {
            buyerByTxHash.set(row.txHash.toLowerCase(), row.walletAddress.toLowerCase());
          }
        }
      }

      for (const tx of transactions) {
        const normalized = normalizeType(tx.type);
        if (normalized !== 'COMMISSION_EARNED') continue;
        if (!tx.sourceWalletAddress && tx.txHash) {
          const fromPurchase = buyerByTxHash.get(String(tx.txHash).toLowerCase());
          if (fromPurchase) tx.sourceWalletAddress = fromPurchase;
        }
      }

      const sourceWallets = [
        ...new Set(
          transactions
            .map((tx) => tx.sourceWalletAddress)
            .filter((w): w is string => typeof w === 'string' && w.length > 0)
            .map((w) => w.toLowerCase()),
        ),
      ];
      if (sourceWallets.length > 0) {
        const sourceUsers = await User.find({ walletAddress: { $in: sourceWallets } })
          .select('walletAddress username')
          .lean();
        const usernameByWallet = new Map(
          sourceUsers.map((u) => [u.walletAddress.toLowerCase(), u.username]),
        );
        for (const tx of transactions) {
          if (!tx.sourceWalletAddress) continue;
          const username = usernameByWallet.get(String(tx.sourceWalletAddress).toLowerCase());
          if (username) tx.sourceUsername = username;
        }
      }

      sendSuccess(res, { transactions }, 'Transactions retrieved');
    } catch (error) {
      console.error("Failed to get transactions:", error);
      next(error);
    }
  }

  static async getRewardsSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const summary = await NetworkService.getRewardsSummary(walletAddress as string);
      sendSuccess(res, summary, 'Rewards summary retrieved');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Leadership Bonus is auto-deposited straight to the user's wallet by the monthly
   * cron (see rewards.service.ts) rather than accrued as a claimable contract
   * balance, so this just surfaces the payout history for display - there's no
   * "claim" action for it.
   */
  static async getLeadershipPayouts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const payouts = await RewardsService.getPayoutHistory(walletAddress as string);
      sendSuccess(res, { payouts }, 'Leadership payout history retrieved');
    } catch (error) {
      next(error);
    }
  }

  /** Share entitlement + pool estimate + payout history for the Leadership Bonus card. */
  static async getLeadershipStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const status = await RewardsService.getLeadershipStatus(walletAddress as string);
      sendSuccess(res, status, 'Leadership status retrieved');
    } catch (error) {
      next(error);
    }
  }

  /** One-time rank achievement bonus status for the Network Rank Bonus card. */
  static async getAchievementStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const status = await RewardsService.getAchievementStatus(walletAddress as string);
      sendSuccess(res, status, 'Achievement status retrieved');
    } catch (error) {
      next(error);
    }
  }

  static async getNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const data = await NotificationService.listForWallet(walletAddress as string, limit);
      sendSuccess(res, data, 'Notifications retrieved');
    } catch (error) {
      next(error);
    }
  }

  static async markNotificationsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined;
      const result = await NotificationService.markRead(walletAddress as string, ids);
      sendSuccess(res, result, 'Notifications marked as read');
    } catch (error) {
      next(error);
    }
  }

  static async getPointsSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const summary = await PointsService.getPointsSummary(walletAddress as string, limit);
      sendSuccess(res, summary, 'Points summary retrieved');
    } catch (error) {
      next(error);
    }
  }

  static async recalculatePoints(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const points = await PointsService.recalculatePoints(walletAddress as string);
      sendSuccess(res, { hntrPoints: points }, 'Points recalculated');
    } catch (error) {
      next(error);
    }
  }
}
