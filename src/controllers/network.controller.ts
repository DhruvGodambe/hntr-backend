import { Request, Response, NextFunction } from 'express';
import { ethers } from 'ethers';
import { NetworkService } from '../services/network.service';
import { RewardsService } from '../services/rewards.service';
import User from '../models/User';
import { hntrContractWithSigner, burnerTxQueue, contractABI, CONTRACT_ADDRESS } from '../services/contract.service';
import { getLogsViaEtherscan } from '../services/etherscan.service';
import { ENV } from '../config/env';
import Transaction from '../models/Transaction';
import { findActivePendingRelay } from '../utils/staleTransactions';
import { sendSuccess, sendError } from '../utils/response';

const TIER_NAMES = ['None', 'Scout', 'Tracker', 'Ranger', 'Hunter', 'Apex'];

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
      // from the request body - otherwise anyone could make the burner relay a claim
      // "on behalf of" an arbitrary address, burning the burner's gas for free.
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

      try {
        const txHash = await burnerTxQueue.enqueue(async () => {
          const tx = await (hntrContractWithSigner as any).withdrawCommissions(walletAddress, token);
          await tx.wait();
          return tx.hash as string;
        });

        txnRecord.txHash = txHash;
        txnRecord.status = 'CONFIRMED';
        await txnRecord.save();

        sendSuccess(res, { txHash }, 'Commissions claimed successfully');
      } catch (error: any) {
        txnRecord.status = 'FAILED';
        txnRecord.errorMessage = error?.shortMessage || error?.message || 'Unknown error';
        await txnRecord.save();
        throw error;
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
              amount: liquidAmount.toString(),
              lockedAmount: lockedAmount.toString(),
              level: Number(level),
              token,
            };
          }
          case 'CommissionWithdrawn': {
            const [, amount, token] = parsed.args;
            return { ...base, amount: amount.toString(), token };
          }
          case 'MembershipPurchased': {
            const [, tier, amount, token] = parsed.args;
            return { ...base, amount: amount.toString(), token, tier: TIER_NAMES[Number(tier)] || 'None' };
          }
          case 'MembershipUpgraded': {
            const [, , newTier, amountPaid, token] = parsed.args;
            return { ...base, amount: amountPaid.toString(), token, tier: TIER_NAMES[Number(newTier)] || 'None' };
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

        switch (record.type) {
          case 'COMMISSION_EARNED':
            return {
              ...base,
              amount: this.amountToRawString(record.liquidAmount ?? 0),
              lockedAmount: this.amountToRawString(record.lockedAmount ?? 0),
              level: record.level ?? undefined,
              token: record.token,
            };
          case 'COMMISSION_WITHDRAWN':
          case 'COMMISSION_CLAIM':
            return {
              ...base,
              amount: this.amountToRawString(record.amount),
              token: record.token,
              status: record.status,
            };
          case 'PURCHASE':
          case 'UPGRADE':
            return {
              ...base,
              amount: this.amountToRawString(record.amount),
              token: record.token,
              tier: record.tier,
            };
          default:
            return { ...base, amount: this.amountToRawString(record.amount), token: record.token };
        }
      });

      // Merge chain + DB records, deduplicating by txHash + type + level (for earned)
      // and prefer the on-chain record when available because it carries blockNumber.
      const seen = new Set<string>();
      const merged: any[] = [];

      const addToMerged = (item: any) => {
        const key = item.level !== undefined
          ? `${item.txHash || 'pending'}-${item.type}-${item.level}`
          : `${item.txHash || 'pending'}-${item.type}`;
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(item);
      };

      chainTransactions.forEach(addToMerged);
      dbTransactions.forEach(addToMerged);

      const transactions = merged
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, limit);

      sendSuccess(res, { transactions }, 'Transactions retrieved');
    } catch (error) {
      console.error("Failed to get transactions:", error);
      next(error);
    }
  }

  private static amountToRawString(value: number): string {
    // The frontend expects raw 6-decimal ERC20 amounts as strings.
    return Math.round(value * 1e6).toString();
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
}
