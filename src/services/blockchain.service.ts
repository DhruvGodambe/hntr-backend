import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { NetworkService } from './network.service';
import { provider, CONTRACT_ADDRESS, contractABI } from './contract.service';
import { logger } from '../utils/logger';
import { Tier, CONTRACT_EVENTS, TIER_VOLUMES } from '../constants';

const POLL_INTERVAL_MS = 15_000; // Poll every 15 seconds

export class BlockchainService {
  private lastProcessedBlock = 0;
  private iface = new ethers.Interface(contractABI);

  public async startListening() {
    logger.info('Started polling for blockchain events (using eth_getLogs)...');

    try {
      this.lastProcessedBlock = await provider.getBlockNumber();
    } catch {
      logger.warn('Could not get initial block number, starting from 0');
    }

    this.poll();
  }

  private async poll() {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= this.lastProcessedBlock) {
        setTimeout(() => this.poll(), POLL_INTERVAL_MS);
        return;
      }

      const purchasedTopic = ethers.id('MembershipPurchased(address,uint8,uint256,address)');
      const upgradedTopic = ethers.id('MembershipUpgraded(address,uint8,uint8,uint256,address)');

      const logs = await provider.getLogs({
        address: CONTRACT_ADDRESS,
        topics: [[purchasedTopic, upgradedTopic]],
        fromBlock: this.lastProcessedBlock + 1,
        toBlock: currentBlock,
      });

      for (const log of logs) {
        try {
          const parsed = this.iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (!parsed) continue;

          if (parsed.name === 'MembershipPurchased') {
            const [buyer, tierIndex, , ] = parsed.args;
            logger.info(`MembershipPurchased event detected for ${buyer}`);
            await this.handlePurchaseOrUpgrade(buyer, Number(tierIndex), log.transactionHash, 'PURCHASE');
          } else if (parsed.name === 'MembershipUpgraded') {
            const [buyer, , newTier, , ] = parsed.args;
            logger.info(`MembershipUpgraded event detected for ${buyer}`);
            await this.handlePurchaseOrUpgrade(buyer, Number(newTier), log.transactionHash, 'UPGRADE');
          }
        } catch (parseErr: any) {
          logger.error('Error parsing log:', parseErr.message);
        }
      }

      this.lastProcessedBlock = currentBlock;
    } catch (error: any) {
      logger.error('Polling error:', error.message);
    }

    setTimeout(() => this.poll(), POLL_INTERVAL_MS);
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
    return TIER_VOLUMES[tier as Tier] || 0;
  }
}
