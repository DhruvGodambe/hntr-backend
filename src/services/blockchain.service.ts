import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { NetworkService } from './network.service';
import { hntrContract } from './contract.service';
import { logger } from '../utils/logger';
import { Tier, CONTRACT_EVENTS } from '../constants';

export class BlockchainService {
  public startListening() {
    logger.info('Started listening to blockchain events...');

    hntrContract.on(CONTRACT_EVENTS.MEMBERSHIP_PURCHASED, async (buyer: string, tierIndex: number, amount: bigint, token: string, event: any) => {
      logger.info(`MembershipPurchased event detected for ${buyer}`);
      await this.handlePurchaseOrUpgrade(buyer, tierIndex, event.log.transactionHash, 'PURCHASE');
    });

    hntrContract.on(CONTRACT_EVENTS.MEMBERSHIP_UPGRADED, async (buyer: string, oldTier: number, newTier: number, amount: bigint, token: string, event: any) => {
      logger.info(`MembershipUpgraded event detected for ${buyer}`);
      await this.handlePurchaseOrUpgrade(buyer, newTier, event.log.transactionHash, 'UPGRADE');
    });
  }

  private async handlePurchaseOrUpgrade(walletAddress: string, tierIndex: number, txHash: string, type: 'PURCHASE' | 'UPGRADE') {
    try {
      const tierStr = this.getTierString(tierIndex);
      
      const user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });
      if (!user) {
        logger.warn(`User with wallet ${walletAddress} not found in DB`);
        return;
      }

      await Transaction.create({
        txHash,
        walletAddress: user.walletAddress,
        type,
        tier: tierStr,
        amount: this.getTierCost(tierStr),
        timestamp: new Date()
      });

      user.tier = tierStr as any;
      await user.save();

      for (const ancestor of user.ancestors) {
         await NetworkService.evaluateRank(ancestor);
      }

      logger.info(`Processed ${type} for user ${user.username}. Upgraded to ${tierStr}`);
    } catch (error: any) {
      logger.error('Error processing blockchain event:', error.message);
    }
  }

  private getTierString(tierIndex: number): string {
    const tiers = [Tier.NONE, Tier.SCOUT, Tier.TRACKER, Tier.RANGER, Tier.HUNTER, Tier.APEX];
    return tiers[tierIndex] || Tier.NONE;
  }

  private getTierCost(tier: string): number {
    switch(tier) {
        case Tier.SCOUT: return 100;
        case Tier.TRACKER: return 500;
        case Tier.RANGER: return 1000;
        case Tier.HUNTER: return 5000;
        case Tier.APEX: return 10000;
        default: return 0;
    }
  }
}
