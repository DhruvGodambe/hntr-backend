import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import SyncState from '../models/SyncState';
import { NetworkService } from './network.service';
import { PointsService } from './points.service';
import { provider, CONTRACT_ADDRESS, contractABI, getErc20, getContractAmountDecimals } from './contract.service';
import { logger } from '../utils/logger';
import { Tier, CONTRACT_EVENTS, TIER_VOLUMES } from '../constants';
import { NotificationService } from './notification.service';

const POLL_INTERVAL_MS = 15_000; // Poll every 15 seconds
const SYNC_KEY = 'blockchain-listener';
// Alchemy Free (and similar tiers) reject eth_getLogs over >10 blocks.
// Keep chunks at 10 so the listener can catch up after downtime without failing.
const MAX_LOG_BLOCK_RANGE = Number(process.env.ETH_GETLOGS_MAX_RANGE || 10);
// Stay this many blocks behind the reported tip so eth_getLogs never asks for a
// range past a lagging replica's head ("block range extends beyond current head").
const LOG_CONFIRMATIONS = Number(process.env.ETH_LOG_CONFIRMATIONS || 3);

function isBeyondHeadError(error: any): boolean {
  const message = String(error?.message || error?.shortMessage || error || '').toLowerCase();
  const nested = String(error?.error?.message || error?.info?.error?.message || '').toLowerCase();
  const code = error?.error?.code ?? error?.code;
  return (
    code === -32602 ||
    message.includes('beyond current head') ||
    message.includes('extends beyond') ||
    nested.includes('beyond current head') ||
    nested.includes('extends beyond')
  );
}

export class BlockchainService {
  private lastProcessedBlock = 0;
  private iface = new ethers.Interface(contractABI);
  private eventTopics = [
    ethers.id('MembershipPurchased(address,uint8,uint256,address)'),
    ethers.id('MembershipUpgraded(address,uint8,uint8,uint256,address)'),
    ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)'),
    ethers.id('CommissionWithdrawn(address,uint256,address)'),
    ethers.id('CompanyWalletWithdrawn(address,address,uint256,address)'),
  ];

  public async startListening() {
    logger.info(
      `Started polling for blockchain events (eth_getLogs, max ${MAX_LOG_BLOCK_RANGE} blocks/chunk, ${LOG_CONFIRMATIONS} conf)...`,
    );

    try {
      const currentBlock = await provider.getBlockNumber();
      const safeHead = Math.max(0, currentBlock - LOG_CONFIRMATIONS);
      const syncState = await SyncState.findOne({ key: SYNC_KEY }).lean();

      if (syncState && syncState.lastProcessedBlock > 0) {
        // Resume from the last persisted block so we don't miss events that
        // happened while the backend was restarting or down.
        this.lastProcessedBlock = syncState.lastProcessedBlock;
        // Cursor can sit ahead of a lagging RPC head after a provider failover.
        if (this.lastProcessedBlock > safeHead) {
          logger.warn(
            `Sync cursor ${this.lastProcessedBlock} is ahead of safe head ${safeHead} (tip ${currentBlock}); clamping`,
          );
          this.lastProcessedBlock = safeHead;
          await this.persistCursor(this.lastProcessedBlock);
        }
        logger.info(`Resuming listener from block ${this.lastProcessedBlock} (tip ${currentBlock}, safe ${safeHead})`);
      } else {
        this.lastProcessedBlock = safeHead;
        await SyncState.findOneAndUpdate(
          { key: SYNC_KEY },
          { key: SYNC_KEY, lastProcessedBlock: safeHead, updatedAt: new Date() },
          { upsert: true, new: true },
        );
      }
    } catch {
      logger.warn('Could not get initial block number, starting from 0');
    }

    this.poll();
  }

  private async persistCursor(block: number) {
    this.lastProcessedBlock = block;
    await SyncState.findOneAndUpdate(
      { key: SYNC_KEY },
      { key: SYNC_KEY, lastProcessedBlock: block, updatedAt: new Date() },
      { upsert: true },
    );
  }

  private async processLog(log: ethers.Log) {
    const parsed = this.iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) return;

    if (parsed.name === 'MembershipPurchased') {
      const [buyer, tierIndex] = parsed.args;
      logger.info(`MembershipPurchased event detected for ${buyer} at block ${log.blockNumber}`);
      await this.handlePurchaseOrUpgrade(buyer, Number(tierIndex), log.transactionHash, 'PURCHASE');
    } else if (parsed.name === 'MembershipUpgraded') {
      const [buyer, , newTier] = parsed.args;
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
    } else if (parsed.name === 'CompanyWalletWithdrawn') {
      const [user, token, amount, companyWallet] = parsed.args;
      logger.info(`CompanyWalletWithdrawn event detected for ${user}: token ${token}, amount ${amount}`);
      await this.handleCompanyWalletWithdrawn(
        user,
        BigInt(amount.toString()),
        token,
        companyWallet,
        log.transactionHash,
      );
    }
  }

  private async poll() {
    try {
      const tip = await provider.getBlockNumber();
      const safeHead = Math.max(0, tip - LOG_CONFIRMATIONS);

      if (this.lastProcessedBlock > safeHead) {
        logger.warn(
          `Sync cursor ${this.lastProcessedBlock} ahead of safe head ${safeHead}; clamping`,
        );
        await this.persistCursor(safeHead);
        setTimeout(() => this.poll(), POLL_INTERVAL_MS);
        return;
      }

      if (safeHead <= this.lastProcessedBlock) {
        setTimeout(() => this.poll(), POLL_INTERVAL_MS);
        return;
      }

      // Walk forward in small chunks so free-tier RPCs (10-block eth_getLogs limit)
      // can still sync after the process was down for many blocks.
      let from = this.lastProcessedBlock + 1;
      while (from <= safeHead) {
        // Re-read tip each chunk — RPC fleets can lag between eth_blockNumber and eth_getLogs.
        const liveTip = await provider.getBlockNumber();
        const liveSafeHead = Math.max(0, liveTip - LOG_CONFIRMATIONS);
        if (from > liveSafeHead) break;

        const to = Math.min(from + MAX_LOG_BLOCK_RANGE - 1, liveSafeHead);

        let logs: ethers.Log[];
        try {
          logs = await provider.getLogs({
            address: CONTRACT_ADDRESS,
            topics: [this.eventTopics],
            fromBlock: from,
            toBlock: to,
          });
        } catch (logErr: any) {
          if (isBeyondHeadError(logErr)) {
            // Provider tip moved backwards / lagging replica — stop this pass; retry next tick.
            logger.warn(
              `eth_getLogs beyond head for [${from}, ${to}] (tip≈${liveTip}); backing off until next poll`,
            );
            break;
          }
          throw logErr;
        }

        const sortedLogs = logs.sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
          return (a.index ?? 0) - (b.index ?? 0);
        });

        for (const log of sortedLogs) {
          try {
            await this.processLog(log);
          } catch (parseErr: any) {
            logger.error('Error parsing/processing log:', parseErr.message);
          }
        }

        await this.persistCursor(to);
        from = to + 1;
      }
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

      // Prefer promoting the PENDING prepare-row (created by MembershipService) to
      // CONFIRMED so the UI does not show both a hash-less pending and a confirmed copy.
      // Fall back to creating a new row only when no pending/existing confirmed exists.
      const existingByHash = await Transaction.findOne({ txHash, walletAddress: user.walletAddress, type });
      if (existingByHash) {
        logger.info(`Duplicate ${type} tx record skipped: ${txHash}; still recalculating volumes`);
      } else {
        const pending = await Transaction.findOne({
          walletAddress: user.walletAddress,
          type,
          status: 'PENDING',
        });
        if (pending) {
          pending.txHash = txHash;
          pending.status = 'CONFIRMED';
          pending.tier = tierStr;
          pending.amount = this.getTierCost(tierStr);
          pending.timestamp = new Date();
          await pending.save();
          logger.info(`Promoted PENDING ${type} to CONFIRMED for ${txHash}`);
        } else {
          await Transaction.create({
            txHash,
            walletAddress: user.walletAddress,
            type,
            tier: tierStr,
            amount: this.getTierCost(tierStr),
            status: 'CONFIRMED',
            timestamp: new Date(),
          });
        }
      }

      const oldTier = user.tier;
      user.tier = tierStr as any;
      await user.save();

      // Recalculate the entire upline chain so every ancestor's leg volume and
      // team volume reflects the new purchase/upgrade.
      try {
        const results = await NetworkService.recalculateUplineVolumes(user.username);
        for (const result of results) {
          logger.info(`Recalculated volumes for ${result.username}: teamVolume=${result.teamVolume}, rank=${result.rank}`);
        }
      } catch (recalcErr: any) {
        logger.error(`Failed to recalculate upline volumes for ${user.username}: ${recalcErr.message}`);
        throw recalcErr;
      }

      // Award HNTR points for membership spend (250 points per USD).
      try {
        const spendAmount = this.getTierCost(tierStr);
        await PointsService.awardPoints(
          user.walletAddress,
          type === 'PURCHASE' ? 'MEMBERSHIP_PURCHASE' : 'MEMBERSHIP_UPGRADE',
          spendAmount,
          txHash,
        );
      } catch (pointsErr: any) {
        logger.error(`Failed to award points for ${type} ${txHash}: ${pointsErr.message}`);
      }

      await NotificationService.createQuiet({
        walletAddress: user.walletAddress,
        type: type === 'PURCHASE' ? 'MEMBERSHIP_PURCHASED' : 'MEMBERSHIP_UPGRADED',
        title: type === 'PURCHASE' ? 'Membership purchased' : 'Membership upgraded',
        sub: `${tierStr} membership confirmed${oldTier && oldTier !== 'None' ? ` (from ${oldTier})` : ''}.`,
        link: 'VIEW MEMBERSHIP',
        meta: { tier: tierStr, oldTier, txHash, type },
      });

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

      const amountDecimals = await getContractAmountDecimals();
      const liquid = Number(ethers.formatUnits(liquidAmount, amountDecimals));
      const locked = Number(ethers.formatUnits(lockedAmount, amountDecimals));
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

      // Award HNTR points for commission earned (10 points per USD).
      // Leadership pool distributions are separate and do not emit CommissionEarned,
      // so they are excluded automatically.
      try {
        await PointsService.awardPoints(
          walletAddress,
          'COMMISSION_EARNED',
          total,
          txHash,
          { level, token: tokenAddress.toLowerCase() },
        );
      } catch (pointsErr: any) {
        logger.error(`Failed to award points for commission ${txHash}: ${pointsErr.message}`);
      }

      await NotificationService.createQuiet({
        walletAddress,
        type: 'COMMISSION_EARNED',
        title: 'Referral commission earned',
        sub: `$${total.toFixed(2)} from level ${level} ($${liquid.toFixed(2)} claimable, $${locked.toFixed(2)} locked).`,
        link: 'VIEW NETWORK',
        meta: { amount: total, liquid, locked, level, txHash },
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
      const amountDecimals = await getContractAmountDecimals();
      const withdrawn = Number(ethers.formatUnits(amount, amountDecimals));
      const normalizedWallet = walletAddress.toLowerCase();
      const normalizedToken = tokenAddress.toLowerCase();

      const existingByHash = await Transaction.findOne({
        txHash,
        walletAddress: normalizedWallet,
        type: { $in: ['COMMISSION_WITHDRAWN', 'COMMISSION_CLAIM'] },
        token: normalizedToken,
      });
      if (existingByHash) {
        if (existingByHash.status === 'PENDING') {
          existingByHash.status = 'CONFIRMED';
          existingByHash.amount = withdrawn;
          existingByHash.timestamp = new Date();
          await existingByHash.save();
        }
        logger.info(`Duplicate CommissionWithdrawn tx skipped/updated: ${txHash}`);
        return;
      }

      // Promote the prepare-row from /claim so history does not keep a $0 PENDING stub.
      const pending = await Transaction.findOne({
        walletAddress: normalizedWallet,
        type: 'COMMISSION_CLAIM',
        status: 'PENDING',
      });
      if (pending) {
        pending.txHash = txHash;
        pending.status = 'CONFIRMED';
        pending.token = normalizedToken;
        pending.amount = withdrawn;
        pending.timestamp = new Date();
        await pending.save();
        logger.info(`Promoted PENDING COMMISSION_CLAIM to CONFIRMED for ${txHash}: $${withdrawn.toFixed(2)}`);
        await NotificationService.createQuiet({
          walletAddress: normalizedWallet,
          type: 'COMMISSION_CLAIMED',
          title: 'Referral commission claimed',
          sub: `$${withdrawn.toFixed(2)} sent to your wallet.`,
          link: 'VIEW TRANSACTION',
          meta: { amount: withdrawn, txHash, token: normalizedToken },
        });
        return;
      }

      await Transaction.create({
        txHash,
        walletAddress: normalizedWallet,
        type: 'COMMISSION_WITHDRAWN',
        token: normalizedToken,
        amount: withdrawn,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });

      await NotificationService.createQuiet({
        walletAddress: normalizedWallet,
        type: 'COMMISSION_CLAIMED',
        title: 'Referral commission claimed',
        sub: `$${withdrawn.toFixed(2)} sent to your wallet.`,
        link: 'VIEW TRANSACTION',
        meta: { amount: withdrawn, txHash, token: normalizedToken },
      });

      logger.info(`Stored COMMISSION_WITHDRAWN for ${walletAddress}: -$${withdrawn.toFixed(2)}`);
    } catch (error: any) {
      logger.error('Error processing CommissionWithdrawn event:', error.message);
    }
  }

  private async handleCompanyWalletWithdrawn(
    walletAddress: string,
    amount: bigint,
    tokenAddress: string,
    companyWalletAddress: string,
    txHash: string,
  ) {
    try {
      const amountDecimals = await getContractAmountDecimals();
      const withdrawn = Number(ethers.formatUnits(amount, amountDecimals));

      const existing = await Transaction.findOne({
        txHash,
        walletAddress: walletAddress.toLowerCase(),
        type: 'COMPANY_WALLET_WITHDRAWN',
        token: tokenAddress.toLowerCase(),
      });
      if (existing) {
        logger.info(`Duplicate CompanyWalletWithdrawn tx skipped: ${txHash}`);
        return;
      }

      await Transaction.create({
        txHash,
        walletAddress: walletAddress.toLowerCase(),
        type: 'COMPANY_WALLET_WITHDRAWN',
        token: tokenAddress.toLowerCase(),
        amount: withdrawn,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });

      logger.info(
        `Stored COMPANY_WALLET_WITHDRAWN for ${walletAddress}: -$${withdrawn.toFixed(2)} (companyWallet ${companyWalletAddress})`,
      );
    } catch (error: any) {
      logger.error('Error processing CompanyWalletWithdrawn event:', error.message);
    }
  }

  private getTierString(tierIndex: number): string {
    const tiers = [Tier.NONE, Tier.BRONZE, Tier.SILVER, Tier.GOLD, Tier.PLATINUM, Tier.DIAMOND];
    return tiers[tierIndex] || Tier.NONE;
  }

  private getTierCost(tier: string): number {
    return TIER_VOLUMES[tier as Tier] || 0;
  }
}
