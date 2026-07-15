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

      // Fetched via Etherscan (not raw eth_getLogs) so this covers the contract's
      // entire history instead of just whatever recent window the public RPC
      // allows before demanding an archive-node token. See etherscan.service.ts.
      const addressString = Array.isArray(walletAddress) ? walletAddress[0] : walletAddress;
      const paddedAddress = ethers.zeroPadValue(addressString.toLowerCase(), 32);
      const eventSignatures: Record<string, string> = {
        CommissionEarned: ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)'),
        CommissionWithdrawn: ethers.id('CommissionWithdrawn(address,uint256,address)'),
        MembershipPurchased: ethers.id('MembershipPurchased(address,uint8,uint256,address)'),
        MembershipUpgraded: ethers.id('MembershipUpgraded(address,uint8,uint8,uint256,address)'),
      };

      const allLogs = await Promise.all(
        Object.entries(eventSignatures).map(async ([type, sig]) => {
          const logs = await getLogsViaEtherscan({
            address: CONTRACT_ADDRESS,
            topics: [sig, paddedAddress],
            fromBlock: ENV.CONTRACT_DEPLOY_BLOCK,
          });
          return logs.map((l) => ({ type, log: l }));
        })
      );

      const flatLogs = allLogs.flat().sort((a, b) => b.log.blockNumber - a.log.blockNumber).slice(0, limit);

      const transactions = flatLogs.map(({ type, log }) => {
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
            return { ...base, amount: liquidAmount.toString(), lockedAmount: lockedAmount.toString(), level: Number(level), token };
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
}
