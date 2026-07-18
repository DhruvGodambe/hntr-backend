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
import { findActivePendingRelay } from '../utils/staleTransactions';
import { sendSuccess, sendError } from '../utils/response';

const TIER_NAMES = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

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
      const depth = Math.min(Number(req.query.depth) || 3, 4);
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

      const pending = await findActivePendingRelay(walletAddress, 'COMMISSION_CLAIM');
      if (pending) {
        sendError(res, 'A commission claim for this wallet is already in progress.', 409);
        return;
      }

      const txnRecord = await Transaction.create({
        walletAddress: walletAddress.toLowerCase(),
        type: 'COMMISSION_CLAIM',
        token,
        amount: 0,
        status: 'PENDING',
      });

      sendSuccess(
        res,
        {
          operation: 'COMMISSION_CLAIM',
          walletAddress: walletAddress.toLowerCase(),
          tokenAddress: token,
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
      const dbRecordsPromise = Transaction.find({ walletAddress: normalizedAddress })
        .sort({ timestamp: -1 })
        .limit(limit * 2)
        .lean();

      const [allLogs, dbRecords] = await Promise.all([chainLogsPromise, dbRecordsPromise]);

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
            const [, tier, amount, token] = parsed.args;
            return { ...base, amount: toDollars(BigInt(amount.toString())), token, tier: TIER_NAMES[Number(tier)] || 'None' };
          }
          case 'MembershipUpgraded': {
            const [, , newTier, amountPaid, token] = parsed.args;
            return { ...base, amount: toDollars(BigInt(amountPaid.toString())), token, tier: TIER_NAMES[Number(newTier)] || 'None' };
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

      // Chain first (has block timestamps), then DB (fills gaps + pending/status).
      chainTransactions.forEach(addToMerged);
      dbTransactions.forEach(addToMerged);

      const transactions = Array.from(merged.values())
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, limit);

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
