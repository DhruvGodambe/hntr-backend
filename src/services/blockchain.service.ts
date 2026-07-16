import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import SyncState from '../models/SyncState';
import { NetworkService } from './network.service';
import { provider, CONTRACT_ADDRESS, contractABI, getErc20 } from './contract.service';
import { logger } from '../utils/logger';
import { Tier, CONTRACT_EVENTS, TIER_VOLUMES } from '../constants';

const POLL_INTERVAL_MS = 15_000; // Poll every 15 seconds
const SYNC_KEY = 'blockchain-listener';

export class BlockchainService {
  private lastProcessedBlock = 0;
  private iface = new ethers.Interface(contractABI);

  public async startListening() {
    logger.info('Started polling for blockchain events (using eth_getLogs)...');

    try {
      const currentBlock = await provider.getBlockNumber();
      const syncState = await SyncState.findOne({ key: SYNC_KEY }).lean();

      if (syncState && syncState.lastProcessedBlock > 0) {
        // Resume from the last persisted block so we don't miss events that
        // happened while the backend was restarting or down.
        this.lastProcessedBlock = syncState.lastProcessedBlock;
        logger.info(`Resuming listener from block ${this.lastProcessedBlock} (current ${currentBlock})`);
      } else {
        this.lastProcessedBlock = currentBlock;
        await SyncState.findOneAndUpdate(
          { key: SYNC_KEY },
          { key: SYNC_KEY, lastProcessedBlock: currentBlock, updatedAt: new Date() },
          { upsert: true, new: true },
        );
      }
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
      const commissionEarnedTopic = ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)');
      const commissionWithdrawnTopic = ethers.id('CommissionWithdrawn(address,uint256,address)');

      const logs = await provider.getLogs({
        address: CONTRACT_ADDRESS,
        topics: [[purchasedTopic, upgradedTopic, commissionEarnedTopic, commissionWithdrawnTopic]],
        fromBlock: this.lastProcessedBlock + 1,
        toBlock: currentBlock,
      });

      // Sort by block number and log index so we process events in exact chain order.
      const sortedLogs = logs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
        return (a.index ?? 0) - (b.index ?? 0);
      });

      for (const log of sortedLogs) {
        try {
          const parsed = this.iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (!parsed) continue;

          if (parsed.name === 'MembershipPurchased') {
            const [buyer, tierIndex, , ] = parsed.args;
            logger.info(`MembershipPurchased event detected for ${buyer} at block ${log.blockNumber}`);
            await this.handlePurchaseOrUpgrade(buyer, Number(tierIndex), log.transactionHash, 'PURCHASE');
          } else if (parsed.name === 'MembershipUpgraded') {
            const [buyer, , newTier, , ] = parsed.args;
            logger.info(`MembershipUpgraded event detected for ${buyer} at block ${log.blockNumber}`);
            await this.handlePurchaseOrUpgrade(buyer, Number(newTier), log.transactionHash, 'UPGRADE');
          } else if (parsed.name === 'CommissionEarned') {
            const [user, liquidAmount, lockedAmount, level, token] = parsed.args;
            logger.info(`CommissionEarned event detected for ${user}: level ${level}, token ${token}`);
            await this.handleCommissionEarned(
              user,
              BigInt(liquidAmount.toString()),
              BigInt(lockedAmount.toString()),
              Number(level),
              token,
              log.transactionHash,
            );
          } else if (parsed.name === 'CommissionWithdrawn') {
            const [user, amount, token] = parsed.args;
            logger.info(`CommissionWithdrawn event detected for ${user}: token ${token}`);
            await this.handleCommissionWithdrawn(user, BigInt(amount.toString()), token, log.transactionHash);
          }
        } catch (parseErr: any) {
          logger.error('Error parsing log:', parseErr.message);
        }
      }

      this.lastProcessedBlock = currentBlock;
      await SyncState.findOneAndUpdate(
        { key: SYNC_KEY },
        { key: SYNC_KEY, lastProcessedBlock: currentBlock, updatedAt: new Date() },
        { upsert: true },
      );
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

      // Avoid duplicate purchase/upgrade records for the same transaction.
      const existing = await Transaction.findOne({ txHash, walletAddress: user.walletAddress, type });
      if (existing) {
        logger.info(`Duplicate ${type} tx skipped: ${txHash}`);
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

      const oldTier = user.tier;
      user.tier = tierStr as any;
      await user.save();

      // Recalculate the entire upline chain so every ancestor's leg volume and
      // team volume reflects the new purchase/upgrade. We use recalculateUplineVolumes
      // instead of evaluateRank directly so the whole chain is recomputed in a single
      // call and failures are surfaced clearly.
      try {
        const results = await NetworkService.recalculateUplineVolumes(user.username);
        for (const result of results) {
          logger.info(`Recalculated volumes for ${result.username}: teamVolume=${result.teamVolume}, rank=${result.rank}`);
        }
      } catch (recalcErr: any) {
        logger.error(`Failed to recalculate upline volumes for ${user.username}: ${recalcErr.message}`);
        throw recalcErr;
      }

      logger.info(`Processed ${type} for user ${user.username}: ${oldTier} -> ${tierStr}. Ancestors updated: ${user.ancestors.length}`);
    } catch (error: any) {
      logger.error('Error processing blockchain event:', error.message);
    }
  }

  private async handleCommissionEarned(
    walletAddress: string,
    liquidAmount: bigint,
    lockedAmount: bigint,
    level: number,
    tokenAddress: string,
    txHash: string,
  ) {
    try {
      const user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });
      if (!user) {
        logger.warn(`User with wallet ${walletAddress} not found in DB for commission event`);
      }

      const decimals = await this.getTokenDecimals(tokenAddress);
      const liquid = Number(ethers.formatUnits(liquidAmount, decimals));
      const locked = Number(ethers.formatUnits(lockedAmount, decimals));
      const total = liquid + locked;

      // Avoid duplicate entries for the same tx + wallet + level + token.
      const existing = await Transaction.findOne({
        txHash,
        walletAddress: walletAddress.toLowerCase(),
        type: 'COMMISSION_EARNED',
        token: tokenAddress.toLowerCase(),
        level,
      });
      if (existing) {
        logger.info(`Duplicate CommissionEarned tx skipped: ${txHash} level ${level}`);
        return;
      }

      await Transaction.create({
        txHash,
        walletAddress: walletAddress.toLowerCase(),
        type: 'COMMISSION_EARNED',
        token: tokenAddress.toLowerCase(),
        amount: total,
        liquidAmount: liquid,
        lockedAmount: locked,
        level,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });

      logger.info(`Stored COMMISSION_EARNED for ${walletAddress}: +$${total.toFixed(2)} (liquid $${liquid.toFixed(2)}, locked $${locked.toFixed(2)})`);
    } catch (error: any) {
      logger.error('Error processing CommissionEarned event:', error.message);
    }
  }

  private async handleCommissionWithdrawn(
    walletAddress: string,
    amount: bigint,
    tokenAddress: string,
    txHash: string,
  ) {
    try {
      const decimals = await this.getTokenDecimals(tokenAddress);
      const withdrawn = Number(ethers.formatUnits(amount, decimals));

      const existing = await Transaction.findOne({
        txHash,
        walletAddress: walletAddress.toLowerCase(),
        type: 'COMMISSION_WITHDRAWN',
        token: tokenAddress.toLowerCase(),
      });
      if (existing) {
        logger.info(`Duplicate CommissionWithdrawn tx skipped: ${txHash}`);
        return;
      }

      await Transaction.create({
        txHash,
        walletAddress: walletAddress.toLowerCase(),
        type: 'COMMISSION_WITHDRAWN',
        token: tokenAddress.toLowerCase(),
        amount: withdrawn,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });

      logger.info(`Stored COMMISSION_WITHDRAWN for ${walletAddress}: -$${withdrawn.toFixed(2)}`);
    } catch (error: any) {
      logger.error('Error processing CommissionWithdrawn event:', error.message);
    }
  }

  private async getTokenDecimals(tokenAddress: string): Promise<number> {
    try {
      return Number(await getErc20(tokenAddress).decimals());
    } catch {
      return 6;
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
