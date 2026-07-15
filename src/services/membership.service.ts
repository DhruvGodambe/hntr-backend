import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { NetworkService } from './network.service';
import { hntrContract, hntrContractWithSigner, burnerTxQueue, getErc20, CONTRACT_ADDRESS } from './contract.service';
import { Tier, TIER_VOLUMES } from '../constants';
import { logger } from '../utils/logger';
import { findActivePendingRelay } from '../utils/staleTransactions';

const TIER_ORDER: Tier[] = [Tier.NONE, Tier.SCOUT, Tier.TRACKER, Tier.RANGER, Tier.HUNTER, Tier.APEX];

export class MembershipError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function tierNameToIndex(tierName: string): number {
  const idx = TIER_ORDER.findIndex((t) => t.toLowerCase() === String(tierName).toLowerCase());
  if (idx <= 0) {
    throw new MembershipError('INVALID_TIER', `Unknown or invalid tier: ${tierName}`);
  }
  return idx;
}

function tierIndexToName(idx: number): Tier {
  return TIER_ORDER[idx] ?? Tier.NONE;
}

async function resolveTokenAddress(tokenSymbol: string): Promise<string> {
  const symbol = String(tokenSymbol).toUpperCase();
  if (symbol === 'USDT') return hntrContract.usdt();
  if (symbol === 'USDC') return hntrContract.usdc();
  // Allow passing a raw address directly too.
  if (ethers.isAddress(tokenSymbol)) return tokenSymbol;
  throw new MembershipError('UNSUPPORTED_TOKEN', `Unsupported token: ${tokenSymbol}`);
}

export interface MembershipQuote {
  tier: string;
  tierIndex: number;
  isUpgrade: boolean;
  currentTier: string;
  tokenAddress: string;
  tokenSymbol: string;
  decimals: number;
  amountDueRaw: string;
  amountDueFormatted: string;
  contractAddress: string;
  allowanceRaw: string;
  balanceRaw: string;
  needsApproval: boolean;
  insufficientBalance: boolean;
}

export class MembershipService {
  static async getQuote(walletAddress: string, tierName: string, tokenSymbol: string): Promise<MembershipQuote> {
    const tierIndex = tierNameToIndex(tierName);
    const tokenAddress = await resolveTokenAddress(tokenSymbol);

    const [price, onChainUser] = await Promise.all([
      hntrContract.tierPrices(tierIndex),
      hntrContract.getUser(walletAddress),
    ]);

    const currentTierIndex = Number(onChainUser[0]);
    const isUpgrade = currentTierIndex !== 0;

    if (isUpgrade && tierIndex <= currentTierIndex) {
      throw new MembershipError('INVALID_UPGRADE', 'Can only upgrade to a strictly higher tier');
    }

    const currentPrice = isUpgrade ? await hntrContract.tierPrices(currentTierIndex) : BigInt(0);
    const amountDue: bigint = BigInt(price) - BigInt(currentPrice);

    const erc20 = getErc20(tokenAddress);
    const [allowance, balance, decimals, symbol] = await Promise.all([
      erc20.allowance(walletAddress, CONTRACT_ADDRESS),
      erc20.balanceOf(walletAddress),
      erc20.decimals(),
      erc20.symbol().catch(() => tokenSymbol),
    ]);

    return {
      tier: tierIndexToName(tierIndex),
      tierIndex,
      isUpgrade,
      currentTier: tierIndexToName(currentTierIndex),
      tokenAddress,
      tokenSymbol: symbol,
      decimals: Number(decimals),
      amountDueRaw: amountDue.toString(),
      amountDueFormatted: ethers.formatUnits(amountDue, decimals),
      contractAddress: CONTRACT_ADDRESS,
      allowanceRaw: allowance.toString(),
      balanceRaw: balance.toString(),
      needsApproval: BigInt(allowance) < amountDue,
      insufficientBalance: BigInt(balance) < amountDue,
    };
  }

  private static async assertNoPendingRelay(walletAddress: string, type: 'PURCHASE' | 'UPGRADE') {
    const pending = await findActivePendingRelay(walletAddress, type);
    if (pending) {
      throw new MembershipError('RELAY_IN_PROGRESS', 'A purchase/upgrade for this wallet is already in progress. Please wait for it to confirm.');
    }
  }

  private static async getUplinesForWallet(walletAddress: string): Promise<string[]> {
    const user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });
    if (!user) {
      throw new MembershipError('USER_NOT_REGISTERED', 'No registered profile for this wallet. Please complete sign up first.', 404);
    }
    return NetworkService.getUplines(user.username);
  }

  static async purchase(walletAddress: string, tierName: string, tokenSymbol: string): Promise<{ txHash: string }> {
    const address = walletAddress.toLowerCase();
    const tierIndex = tierNameToIndex(tierName);

    const onChainUser = await hntrContract.getUser(address);
    if (Number(onChainUser[0]) !== 0) {
      throw new MembershipError('ALREADY_MEMBER', 'This wallet already owns a membership tier. Use upgrade instead.');
    }

    const quote = await this.getQuote(address, tierName, tokenSymbol);
    if (quote.insufficientBalance) {
      throw new MembershipError('INSUFFICIENT_BALANCE', `Insufficient ${quote.tokenSymbol} balance to purchase ${tierName}.`);
    }
    if (quote.needsApproval) {
      throw new MembershipError('NEEDS_APPROVAL', `Approve the HNTRMembership contract to spend ${quote.amountDueFormatted} ${quote.tokenSymbol} first.`);
    }

    await this.assertNoPendingRelay(address, 'PURCHASE');
    const uplines = await this.getUplinesForWallet(address);

    const txnRecord = await Transaction.create({
      walletAddress: address,
      type: 'PURCHASE',
      tier: tierName,
      token: quote.tokenSymbol,
      amount: TIER_VOLUMES[quote.tier as Tier] || 0,
      status: 'PENDING',
    });

    try {
      const txHash = await burnerTxQueue.enqueue(async () => {
        const tx = await (hntrContractWithSigner as any).purchaseMembership(address, tierIndex, uplines, quote.tokenAddress);
        await tx.wait();
        return tx.hash as string;
      });

      txnRecord.txHash = txHash;
      txnRecord.status = 'CONFIRMED';
      await txnRecord.save();

      return { txHash };
    } catch (error: any) {
      logger.error(`Purchase relay failed for ${address}:`, error);
      txnRecord.status = 'FAILED';
      txnRecord.errorMessage = error?.shortMessage || error?.message || 'Unknown error';
      await txnRecord.save();
      throw new MembershipError('RELAY_FAILED', 'The relay transaction failed on-chain. Your funds were not moved. Please try again.', 502);
    }
  }

  static async upgrade(walletAddress: string, newTierName: string, tokenSymbol: string): Promise<{ txHash: string }> {
    const address = walletAddress.toLowerCase();
    const newTierIndex = tierNameToIndex(newTierName);

    const onChainUser = await hntrContract.getUser(address);
    const currentTierIndex = Number(onChainUser[0]);
    if (currentTierIndex === 0) {
      throw new MembershipError('NOT_A_MEMBER', 'This wallet has no membership yet. Use purchase instead.');
    }
    if (newTierIndex <= currentTierIndex) {
      throw new MembershipError('INVALID_UPGRADE', 'Can only upgrade to a strictly higher tier');
    }

    const quote = await this.getQuote(address, newTierName, tokenSymbol);
    if (quote.insufficientBalance) {
      throw new MembershipError('INSUFFICIENT_BALANCE', `Insufficient ${quote.tokenSymbol} balance to upgrade to ${newTierName}.`);
    }
    if (quote.needsApproval) {
      throw new MembershipError('NEEDS_APPROVAL', `Approve the HNTRMembership contract to spend ${quote.amountDueFormatted} ${quote.tokenSymbol} first.`);
    }

    await this.assertNoPendingRelay(address, 'UPGRADE');
    const uplines = await this.getUplinesForWallet(address);

    const txnRecord = await Transaction.create({
      walletAddress: address,
      type: 'UPGRADE',
      tier: newTierName,
      token: quote.tokenSymbol,
      amount: TIER_VOLUMES[quote.tier as Tier] || 0,
      status: 'PENDING',
    });

    try {
      const txHash = await burnerTxQueue.enqueue(async () => {
        const tx = await (hntrContractWithSigner as any).upgradeMembership(address, newTierIndex, uplines, quote.tokenAddress);
        await tx.wait();
        return tx.hash as string;
      });

      txnRecord.txHash = txHash;
      txnRecord.status = 'CONFIRMED';
      await txnRecord.save();

      return { txHash };
    } catch (error: any) {
      logger.error(`Upgrade relay failed for ${address}:`, error);
      txnRecord.status = 'FAILED';
      txnRecord.errorMessage = error?.shortMessage || error?.message || 'Unknown error';
      await txnRecord.save();
      throw new MembershipError('RELAY_FAILED', 'The relay transaction failed on-chain. Your funds were not moved. Please try again.', 502);
    }
  }
}
