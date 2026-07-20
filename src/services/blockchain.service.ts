import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import SyncState from '../models/SyncState';
import { NetworkService } from './network.service';
import { PointsService } from './points.service';
import { provider, CONTRACT_ADDRESS, contractABI, getContractAmountDecimals } from './contract.service';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';
import { Tier, TIER_VOLUMES } from '../constants';
import { NotificationService } from './notification.service';

const POLL_INTERVAL_MS = Number(process.env.ETH_POLL_INTERVAL_MS || 15_000);
const SYNC_KEY = 'blockchain-listener';
// Alchemy Free (and similar tiers) reject eth_getLogs over >10 blocks.
const MAX_LOG_BLOCK_RANGE = Math.max(1, Number(process.env.ETH_GETLOGS_MAX_RANGE || 10));
// Stay behind the tip so eth_getLogs never asks past a lagging replica's head.
const LOG_CONFIRMATIONS = Math.max(0, Number(process.env.ETH_LOG_CONFIRMATIONS || 3));
// Cap work per poll so a large backlog cannot block the event loop forever.
const MAX_CHUNKS_PER_POLL = Math.max(1, Number(process.env.ETH_MAX_CHUNKS_PER_POLL || 50));
const GETLOGS_MAX_RETRIES = Math.max(1, Number(process.env.ETH_GETLOGS_RETRIES || 3));

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

function isRateLimitError(error: any): boolean {
  const message = String(error?.message || error?.shortMessage || error || '').toLowerCase();
  const nested = String(error?.error?.message || error?.info?.error?.message || '').toLowerCase();
  const code = error?.error?.code ?? error?.code;
  return (
    code === 429 ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('exceeded') ||
    nested.includes('rate limit') ||
    nested.includes('too many requests')
  );
}

function isTransientRpcError(error: any): boolean {
  const message = String(error?.message || error?.shortMessage || error || '').toLowerCase();
  return (
    isRateLimitError(error) ||
    message.includes('timeout') ||
    message.includes('temporar') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('socket') ||
    message.includes('503') ||
    message.includes('502') ||
    message.includes('network')
  );
}

function isDuplicateKeyError(error: any): boolean {
  return error?.code === 11000 || error?.codeName === 'DuplicateKey';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BlockchainService {
  private lastProcessedBlock = 0;
  private isPolling = false;
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private iface = new ethers.Interface(contractABI);
  private eventTopics = [
    ethers.id('MembershipPurchased(address,uint8,uint256,address)'),
    ethers.id('MembershipUpgraded(address,uint8,uint8,uint256,address)'),
    ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)'),
    ethers.id('CommissionWithdrawn(address,uint256,address)'),
    ethers.id('CompanyWalletWithdrawn(address,address,uint256,address)'),
  ];

  public async startListening() {
    if (!CONTRACT_ADDRESS || !ethers.isAddress(CONTRACT_ADDRESS)) {
      logger.error(`Blockchain listener disabled: invalid CONTRACT_ADDRESS "${CONTRACT_ADDRESS}"`);
      return;
    }

    logger.info(
      `Started polling for blockchain events (range≤${MAX_LOG_BLOCK_RANGE}, conf=${LOG_CONFIRMATIONS}, chunks/poll≤${MAX_CHUNKS_PER_POLL})...`,
    );

    try {
      const tip = await provider.getBlockNumber();
      const safeHead = Math.max(0, tip - LOG_CONFIRMATIONS);
      const deployFloor = Math.max(0, ENV.CONTRACT_DEPLOY_BLOCK || 0);
      const syncState = await SyncState.findOne({ key: SYNC_KEY }).lean();

      if (syncState && syncState.lastProcessedBlock > 0) {
        this.lastProcessedBlock = syncState.lastProcessedBlock;

        // Only clamp when the cursor is past the absolute tip (RPC glitch / wrong chain).
        // Do NOT clamp down to safeHead — that reprocesses confirmed blocks and spam side effects.
        if (this.lastProcessedBlock > tip) {
          logger.warn(
            `Sync cursor ${this.lastProcessedBlock} is past tip ${tip}; clamping to safe head ${safeHead}`,
          );
          this.lastProcessedBlock = safeHead;
          await this.persistCursor(this.lastProcessedBlock);
        } else if (this.lastProcessedBlock < deployFloor) {
          logger.warn(
            `Sync cursor ${this.lastProcessedBlock} is below deploy block ${deployFloor}; advancing floor`,
          );
          this.lastProcessedBlock = deployFloor;
          await this.persistCursor(this.lastProcessedBlock);
        }

        logger.info(
          `Resuming listener from block ${this.lastProcessedBlock} (tip ${tip}, safe ${safeHead})`,
        );
      } else {
        // Fresh start: begin at safe head so we don't replay the entire chain.
        // Historical backfill is handled by dedicated Etherscan scripts/admin tools.
        this.lastProcessedBlock = Math.max(safeHead, deployFloor);
        await this.persistCursor(this.lastProcessedBlock);
        logger.info(`Initialized listener cursor at ${this.lastProcessedBlock} (tip ${tip})`);
      }
    } catch (err: any) {
      const fallback = Math.max(0, ENV.CONTRACT_DEPLOY_BLOCK || 0);
      this.lastProcessedBlock = fallback;
      logger.warn(
        `Could not get initial block number (${err?.message || err}); starting from deploy floor ${fallback}`,
      );
    }

    this.schedulePoll(0);
  }

  public stopListening() {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private schedulePoll(delayMs = POLL_INTERVAL_MS) {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
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
    let parsed: ethers.LogDescription | null;
    try {
      parsed = this.iface.parseLog({ topics: log.topics as string[], data: log.data });
    } catch (err: any) {
      logger.warn(`Skipping unparseable log ${log.transactionHash}: ${err.message}`);
      return;
    }
    if (!parsed) return;

    const txHash = (log.transactionHash || '').toLowerCase();
    if (!txHash) {
      logger.warn('Skipping log without transactionHash');
      return;
    }

    if (parsed.name === 'MembershipPurchased') {
      const [buyer, tierIndex, amount] = parsed.args;
      logger.info(`MembershipPurchased event detected for ${buyer} at block ${log.blockNumber}`);
      await this.handlePurchaseOrUpgrade(
        buyer,
        Number(tierIndex),
        txHash,
        'PURCHASE',
        BigInt(amount.toString()),
      );
    } else if (parsed.name === 'MembershipUpgraded') {
      const [buyer, , newTier, amountPaid] = parsed.args;
      logger.info(`MembershipUpgraded event detected for ${buyer} at block ${log.blockNumber}`);
      await this.handlePurchaseOrUpgrade(
        buyer,
        Number(newTier),
        txHash,
        'UPGRADE',
        BigInt(amountPaid.toString()),
      );
    } else if (parsed.name === 'CommissionEarned') {
      const [user, liquidAmount, lockedAmount, level, token] = parsed.args;
      logger.info(`CommissionEarned event detected for ${user}: level ${level}, token ${token}`);
      await this.handleCommissionEarned(
        user,
        BigInt(liquidAmount.toString()),
        BigInt(lockedAmount.toString()),
        Number(level),
        token,
        txHash,
      );
    } else if (parsed.name === 'CommissionWithdrawn') {
      const [user, amount, token] = parsed.args;
      logger.info(`CommissionWithdrawn event detected for ${user}: token ${token}`);
      await this.handleCommissionWithdrawn(user, BigInt(amount.toString()), token, txHash);
    } else if (parsed.name === 'CompanyWalletWithdrawn') {
      const [user, token, amount, companyWallet] = parsed.args;
      logger.info(`CompanyWalletWithdrawn event detected for ${user}: token ${token}, amount ${amount}`);
      await this.handleCompanyWalletWithdrawn(
        user,
        BigInt(amount.toString()),
        token,
        companyWallet,
        txHash,
      );
    }
  }

  private async getLogsWithRetry(from: number, to: number): Promise<ethers.Log[]> {
    let attempt = 0;

    while (attempt < GETLOGS_MAX_RETRIES) {
      attempt += 1;
      try {
        return await provider.getLogs({
          address: CONTRACT_ADDRESS,
          topics: [this.eventTopics],
          fromBlock: from,
          toBlock: to,
        });
      } catch (logErr: any) {
        if (isBeyondHeadError(logErr)) {
          throw logErr; // caller backs off without advancing cursor
        }

        if (isTransientRpcError(logErr) && attempt < GETLOGS_MAX_RETRIES) {
          const backoff = Math.min(8_000, 500 * 2 ** (attempt - 1));
          logger.warn(
            `Transient eth_getLogs error for [${from}, ${to}] (attempt ${attempt}/${GETLOGS_MAX_RETRIES}): ${logErr.message}; retry in ${backoff}ms`,
          );
          await sleep(backoff);
          continue;
        }

        throw logErr;
      }
    }

    return [];
  }

  private isResultTooLargeError(error: any): boolean {
    const message = String(error?.message || error?.shortMessage || error || '').toLowerCase();
    return (
      message.includes('more than') ||
      message.includes('query returned') ||
      message.includes('response size') ||
      message.includes('block range is too large') ||
      message.includes('range is too large')
    );
  }

  private async poll() {
    if (this.stopped) return;
    if (this.isPolling) {
      logger.warn('Previous blockchain poll still running; skipping tick');
      this.schedulePoll();
      return;
    }

    this.isPolling = true;
    try {
      const tip = await provider.getBlockNumber();
      const safeHead = Math.max(0, tip - LOG_CONFIRMATIONS);

      if (this.lastProcessedBlock > tip) {
        logger.warn(
          `Sync cursor ${this.lastProcessedBlock} ahead of tip ${tip}; clamping to safe head ${safeHead}`,
        );
        await this.persistCursor(safeHead);
        return;
      }

      // Cursor between safeHead and tip: waiting for confirmations — do not move backwards.
      if (this.lastProcessedBlock >= safeHead) {
        return;
      }

      let from = this.lastProcessedBlock + 1;
      let chunks = 0;
      let chunkSize = MAX_LOG_BLOCK_RANGE;

      while (from <= safeHead && chunks < MAX_CHUNKS_PER_POLL) {
        chunks += 1;

        const liveTip = await provider.getBlockNumber();
        const liveSafeHead = Math.max(0, liveTip - LOG_CONFIRMATIONS);
        if (from > liveSafeHead) break;

        const to = Math.min(from + chunkSize - 1, liveSafeHead);

        let logs: ethers.Log[];
        try {
          logs = await this.getLogsWithRetry(from, to);
        } catch (logErr: any) {
          if (isBeyondHeadError(logErr)) {
            logger.warn(
              `eth_getLogs beyond head for [${from}, ${to}] (tip≈${liveTip}); backing off until next poll`,
            );
            break;
          }
          if (this.isResultTooLargeError(logErr) && chunkSize > 1) {
            chunkSize = Math.max(1, Math.floor(chunkSize / 2));
            logger.warn(
              `eth_getLogs result too large for [${from}, ${to}]; reducing chunk size to ${chunkSize}`,
            );
            chunks -= 1; // don't count the failed attempt against the budget
            continue;
          }
          throw logErr;
        }
        const sortedLogs = [...logs].sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
          return (a.index ?? 0) - (b.index ?? 0);
        });

        let chunkFailed = false;
        for (const log of sortedLogs) {
          try {
            await this.processLog(log);
          } catch (processErr: any) {
            chunkFailed = true;
            logger.error(
              `Failed processing log ${log.transactionHash} @${log.blockNumber}: ${processErr.message}`,
            );
            // Stop this chunk — do not advance cursor so the event is retried.
            break;
          }
        }

        if (chunkFailed) {
          break;
        }

        await this.persistCursor(to);
        from = to + 1;
      }

      if (from <= safeHead && chunks >= MAX_CHUNKS_PER_POLL) {
        logger.info(
          `Catch-up budget reached (${MAX_CHUNKS_PER_POLL} chunks); cursor at ${this.lastProcessedBlock}, safe head ${safeHead}`,
        );
      }
    } catch (error: any) {
      logger.error('Polling error:', error.message);
    } finally {
      this.isPolling = false;
      this.schedulePoll();
    }
  }

  private async usdFromContractAmount(raw: bigint): Promise<number> {
    const amountDecimals = await getContractAmountDecimals();
    return Number(ethers.formatUnits(raw, amountDecimals));
  }

  private async handlePurchaseOrUpgrade(
    walletAddress: string,
    tierIndex: number,
    txHash: string,
    type: 'PURCHASE' | 'UPGRADE',
    rawAmount: bigint,
  ) {
    const tierStr = this.getTierString(tierIndex);
    const normalizedWallet = walletAddress.toLowerCase();
    const normalizedHash = txHash.toLowerCase();

    const user = await User.findOne({ walletAddress: normalizedWallet });
    if (!user) {
      logger.warn(`User with wallet ${walletAddress} not found in DB`);
      return;
    }

    const spendUsd = await this.usdFromContractAmount(rawAmount);
    // Fall back to configured tier table if the event amount is somehow zero.
    const fallbackCost =
      type === 'PURCHASE'
        ? this.getTierCost(tierStr)
        : Math.max(0, this.getTierCost(tierStr) - this.getTierCost(String(user.tier)));
    const amountUsd = spendUsd > 0 ? spendUsd : fallbackCost;

    const existingByHash = await Transaction.findOne({
      txHash: normalizedHash,
      walletAddress: user.walletAddress,
      type,
    });

    if (existingByHash?.status === 'CONFIRMED') {
      // Already fully ingested — skip side effects (notifications / volume spam on reorg retries).
      logger.info(`Duplicate ${type} tx already confirmed: ${normalizedHash}; skipping`);
      return;
    }

    if (existingByHash) {
      existingByHash.status = 'CONFIRMED';
      existingByHash.tier = tierStr;
      existingByHash.amount = amountUsd;
      existingByHash.timestamp = new Date();
      await existingByHash.save();
      logger.info(`Updated existing ${type} row to CONFIRMED for ${normalizedHash}`);
    } else {
      const pending = await Transaction.findOne({
        walletAddress: user.walletAddress,
        type,
        status: 'PENDING',
      });
      if (pending) {
        pending.txHash = normalizedHash;
        pending.status = 'CONFIRMED';
        pending.tier = tierStr;
        pending.amount = amountUsd;
        pending.timestamp = new Date();
        await pending.save();
        logger.info(`Promoted PENDING ${type} to CONFIRMED for ${normalizedHash}`);
      } else {
        try {
          await Transaction.create({
            txHash: normalizedHash,
            walletAddress: user.walletAddress,
            type,
            tier: tierStr,
            amount: amountUsd,
            status: 'CONFIRMED',
            timestamp: new Date(),
          });
        } catch (err: any) {
          if (!isDuplicateKeyError(err)) throw err;
          logger.info(`Race-created ${type} tx already exists: ${normalizedHash}`);
        }
      }
    }

    const oldTier = user.tier;
    user.tier = tierStr as any;
    await user.save();

    try {
      const results = await NetworkService.recalculateUplineVolumes(user.username);
      for (const result of results) {
        logger.info(
          `Recalculated volumes for ${result.username}: teamVolume=${result.teamVolume}, rank=${result.rank}`,
        );
      }
    } catch (recalcErr: any) {
      logger.error(`Failed to recalculate upline volumes for ${user.username}: ${recalcErr.message}`);
      throw recalcErr;
    }

    try {
      await PointsService.awardPoints(
        user.walletAddress,
        type === 'PURCHASE' ? 'MEMBERSHIP_PURCHASE' : 'MEMBERSHIP_UPGRADE',
        amountUsd,
        normalizedHash,
      );
    } catch (pointsErr: any) {
      logger.error(`Failed to award points for ${type} ${normalizedHash}: ${pointsErr.message}`);
    }

    await NotificationService.createQuiet({
      walletAddress: user.walletAddress,
      type: type === 'PURCHASE' ? 'MEMBERSHIP_PURCHASED' : 'MEMBERSHIP_UPGRADED',
      title: type === 'PURCHASE' ? 'Membership purchased' : 'Membership upgraded',
      sub: `${tierStr} membership confirmed${oldTier && oldTier !== 'None' ? ` (from ${oldTier})` : ''}.`,
      link: 'VIEW MEMBERSHIP',
      meta: { tier: tierStr, oldTier, txHash: normalizedHash, type, amountUsd },
    });

    logger.info(
      `Processed ${type} for user ${user.username}: ${oldTier} -> ${tierStr} ($${amountUsd.toFixed(2)}). Ancestors: ${user.ancestors.length}`,
    );
  }

  private async handleCommissionEarned(
    walletAddress: string,
    liquidAmount: bigint,
    lockedAmount: bigint,
    level: number,
    tokenAddress: string,
    txHash: string,
  ) {
    const normalizedWallet = walletAddress.toLowerCase();
    const normalizedToken = String(tokenAddress).toLowerCase();
    const normalizedHash = txHash.toLowerCase();

    const user = await User.findOne({ walletAddress: normalizedWallet });
    if (!user) {
      logger.warn(`User with wallet ${walletAddress} not found in DB for commission event`);
    }

    const amountDecimals = await getContractAmountDecimals();
    const liquid = Number(ethers.formatUnits(liquidAmount, amountDecimals));
    const locked = Number(ethers.formatUnits(lockedAmount, amountDecimals));
    const total = liquid + locked;

    const existing = await Transaction.findOne({
      txHash: normalizedHash,
      walletAddress: normalizedWallet,
      type: 'COMMISSION_EARNED',
      token: normalizedToken,
      level,
    });
    if (existing) {
      logger.info(`Duplicate CommissionEarned tx skipped: ${normalizedHash} level ${level}`);
      return;
    }

    try {
      await Transaction.create({
        txHash: normalizedHash,
        walletAddress: normalizedWallet,
        type: 'COMMISSION_EARNED',
        token: normalizedToken,
        amount: total,
        liquidAmount: liquid,
        lockedAmount: locked,
        level,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });
    } catch (err: any) {
      if (isDuplicateKeyError(err)) {
        logger.info(`Race-created CommissionEarned already exists: ${normalizedHash} level ${level}`);
        return;
      }
      throw err;
    }

    try {
      await PointsService.awardPoints(normalizedWallet, 'COMMISSION_EARNED', total, normalizedHash, {
        level,
        token: normalizedToken,
      });
    } catch (pointsErr: any) {
      logger.error(`Failed to award points for commission ${normalizedHash}: ${pointsErr.message}`);
    }

    await NotificationService.createQuiet({
      walletAddress: normalizedWallet,
      type: 'COMMISSION_EARNED',
      title: 'Referral commission earned',
      sub: `$${total.toFixed(2)} from level ${level} ($${liquid.toFixed(2)} claimable, $${locked.toFixed(2)} locked).`,
      link: 'VIEW NETWORK',
      meta: { amount: total, liquid, locked, level, txHash: normalizedHash },
    });

    logger.info(
      `Stored COMMISSION_EARNED for ${walletAddress}: +$${total.toFixed(2)} (liquid $${liquid.toFixed(2)}, locked $${locked.toFixed(2)})`,
    );
  }

  private async handleCommissionWithdrawn(
    walletAddress: string,
    amount: bigint,
    tokenAddress: string,
    txHash: string,
  ) {
    const amountDecimals = await getContractAmountDecimals();
    const withdrawn = Number(ethers.formatUnits(amount, amountDecimals));
    const normalizedWallet = walletAddress.toLowerCase();
    const normalizedToken = String(tokenAddress).toLowerCase();
    const normalizedHash = txHash.toLowerCase();

    const existingByHash = await Transaction.findOne({
      txHash: normalizedHash,
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
      logger.info(`Duplicate CommissionWithdrawn tx skipped/updated: ${normalizedHash}`);
      return;
    }

    const pending = await Transaction.findOne({
      walletAddress: normalizedWallet,
      type: 'COMMISSION_CLAIM',
      status: 'PENDING',
    });
    if (pending) {
      pending.txHash = normalizedHash;
      pending.status = 'CONFIRMED';
      pending.token = normalizedToken;
      pending.amount = withdrawn;
      pending.timestamp = new Date();
      await pending.save();
      logger.info(
        `Promoted PENDING COMMISSION_CLAIM to CONFIRMED for ${normalizedHash}: $${withdrawn.toFixed(2)}`,
      );
      await NotificationService.createQuiet({
        walletAddress: normalizedWallet,
        type: 'COMMISSION_CLAIMED',
        title: 'Referral commission claimed',
        sub: `$${withdrawn.toFixed(2)} sent to your wallet.`,
        link: 'VIEW TRANSACTION',
        meta: { amount: withdrawn, txHash: normalizedHash, token: normalizedToken },
      });
      return;
    }

    try {
      await Transaction.create({
        txHash: normalizedHash,
        walletAddress: normalizedWallet,
        type: 'COMMISSION_WITHDRAWN',
        token: normalizedToken,
        amount: withdrawn,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });
    } catch (err: any) {
      if (isDuplicateKeyError(err)) {
        logger.info(`Race-created CommissionWithdrawn already exists: ${normalizedHash}`);
        return;
      }
      throw err;
    }

    await NotificationService.createQuiet({
      walletAddress: normalizedWallet,
      type: 'COMMISSION_CLAIMED',
      title: 'Referral commission claimed',
      sub: `$${withdrawn.toFixed(2)} sent to your wallet.`,
      link: 'VIEW TRANSACTION',
      meta: { amount: withdrawn, txHash: normalizedHash, token: normalizedToken },
    });

    logger.info(`Stored COMMISSION_WITHDRAWN for ${walletAddress}: -$${withdrawn.toFixed(2)}`);
  }

  private async handleCompanyWalletWithdrawn(
    walletAddress: string,
    amount: bigint,
    tokenAddress: string,
    companyWalletAddress: string,
    txHash: string,
  ) {
    const amountDecimals = await getContractAmountDecimals();
    const withdrawn = Number(ethers.formatUnits(amount, amountDecimals));
    const normalizedWallet = walletAddress.toLowerCase();
    const normalizedToken = String(tokenAddress).toLowerCase();
    const normalizedHash = txHash.toLowerCase();

    const existing = await Transaction.findOne({
      txHash: normalizedHash,
      walletAddress: normalizedWallet,
      type: 'COMPANY_WALLET_WITHDRAWN',
      token: normalizedToken,
    });
    if (existing) {
      logger.info(`Duplicate CompanyWalletWithdrawn tx skipped: ${normalizedHash}`);
      return;
    }

    try {
      await Transaction.create({
        txHash: normalizedHash,
        walletAddress: normalizedWallet,
        type: 'COMPANY_WALLET_WITHDRAWN',
        token: normalizedToken,
        amount: withdrawn,
        status: 'CONFIRMED',
        timestamp: new Date(),
      });
    } catch (err: any) {
      if (isDuplicateKeyError(err)) {
        logger.info(`Race-created CompanyWalletWithdrawn already exists: ${normalizedHash}`);
        return;
      }
      throw err;
    }

    await NotificationService.createQuiet({
      walletAddress: normalizedWallet,
      type: 'COMMISSION_CLAIMED',
      title: 'Commissions withdrawn (admin)',
      sub: `$${withdrawn.toFixed(2)} sent to your wallet by the company wallet.`,
      link: 'VIEW TRANSACTION',
      meta: {
        amount: withdrawn,
        txHash: normalizedHash,
        token: normalizedToken,
        companyWallet: companyWalletAddress.toLowerCase(),
        source: 'company_wallet',
      },
    });

    logger.info(
      `Stored COMPANY_WALLET_WITHDRAWN for ${walletAddress}: -$${withdrawn.toFixed(2)} (companyWallet ${companyWalletAddress})`,
    );
  }

  private getTierString(tierIndex: number): string {
    const tiers = [Tier.NONE, Tier.BRONZE, Tier.SILVER, Tier.GOLD, Tier.PLATINUM, Tier.DIAMOND];
    return tiers[tierIndex] || Tier.NONE;
  }

  private getTierCost(tier: string): number {
    return TIER_VOLUMES[tier as Tier] || 0;
  }
}
