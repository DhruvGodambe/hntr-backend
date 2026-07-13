import { Request, Response, NextFunction } from 'express';
import { NetworkService } from '../services/network.service';
import User from '../models/User';
import { hntrContractWithSigner, provider } from '../services/contract.service';
import { sendSuccess } from '../utils/response';

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


  static async claimCommissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress, token } = req.body;
      const tx = await (hntrContractWithSigner as any).withdrawCommissions(walletAddress, token);
      await tx.wait();
      sendSuccess(res, { txHash: tx.hash }, 'Commissions claimed successfully');
    } catch (error) {
      next(error);
    }
  }

  static async getTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      const { ethers } = await import('ethers');
      
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 10000);

      // Build topic hashes manually to use provider.getLogs (avoids eth_newFilter)
      const addressString = Array.isArray(walletAddress) ? walletAddress[0] : walletAddress;
      const paddedAddress = ethers.zeroPadValue(addressString.toLowerCase(), 32);
      const eventSignatures: Record<string, string> = {
        CommissionEarned: ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)'),
        CommissionWithdrawn: ethers.id('CommissionWithdrawn(address,uint256,address)'),
        MembershipPurchased: ethers.id('MembershipPurchased(address,uint8,uint256,address)'),
        MembershipUpgraded: ethers.id('MembershipUpgraded(address,uint8,uint8,uint256,address)'),
      };

      const contractAddress = (await import('../services/contract.service')).CONTRACT_ADDRESS;

      const allLogs = await Promise.all(
        Object.entries(eventSignatures).map(async ([type, sig]) => {
          try {
            const logs = await provider.getLogs({
              address: contractAddress,
              topics: [sig, paddedAddress],
              fromBlock,
              toBlock: currentBlock,
            });
            return logs.map(l => ({
              type,
              txHash: l.transactionHash,
              blockNumber: l.blockNumber,
            }));
          } catch (e: any) {
            console.warn(`Could not fetch logs for ${type} due to RPC limit:`, e.message);
            return []; // Fallback to empty if RPC limits block range
          }
        })
      );

      const transactions = allLogs.flat().sort((a, b) => b.blockNumber - a.blockNumber);
      
      sendSuccess(res, { transactions }, 'Transactions retrieved');
    } catch (error) {
      console.error("Failed to get transactions:", error);
      next(error);
    }
  }
}
