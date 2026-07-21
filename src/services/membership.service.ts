import { ethers } from 'ethers';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { NetworkService } from './network.service';
import {
  hntrContract,
  getErc20,
  CONTRACT_ADDRESS,
  companyWallet,
  SIGNATURE_TTL_SECONDS,
  provider,
  getContractAmountDecimals,
} from './contract.service';
import { Tier, TIER_VOLUMES } from '../constants';
import { logger } from '../utils/logger';
import { findActivePendingRelay } from '../utils/staleTransactions';

/** Format contract-scale amounts for UI (trim trailing zeros: 250.000000 → 250). */
function formatAmountDue(raw: bigint, decimals: number): string {
  const formatted = ethers.formatUnits(raw, decimals);
  if (!formatted.includes('.')) return formatted;
  return formatted.replace(/\.?0+$/, '');
}

const TIER_ORDER: Tier[] = [Tier.NONE, Tier.BRONZE, Tier.SILVER, Tier.GOLD, Tier.PLATINUM, Tier.DIAMOND];

const PURCHASE_OP = ethers.id('PURCHASE');
const UPGRADE_OP = ethers.id('UPGRADE');

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

export interface PreparedMembershipTx {
  operation: 'PURCHASE' | 'UPGRADE';
  walletAddress: string;
  tierIndex: number;
  uplines: string[];
  ranks: number[];
  tokenAddress: string;
  tokenSymbol: string;
  amountDueRaw: string;
  contractAddress: string;
  deadline: number;
  signature: string;
  pendingTransactionId: string;
  status: 'PENDING';
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
    // tierPrices / amountDue use the contract's internal scale (USDT-like 6), which can
    // differ from ERC20.decimals() on mock tokens (often 18). Format with contract scale.
    const [allowance, balance, symbol, contractDecimals] = await Promise.all([
      erc20.allowance(walletAddress, CONTRACT_ADDRESS),
      erc20.balanceOf(walletAddress),
      erc20.symbol().catch(() => tokenSymbol),
      getContractAmountDecimals(),
    ]);

    return {
      tier: tierIndexToName(tierIndex),
      tierIndex,
      isUpgrade,
      currentTier: tierIndexToName(currentTierIndex),
      tokenAddress,
      tokenSymbol: symbol,
      decimals: contractDecimals,
      amountDueRaw: amountDue.toString(),
      amountDueFormatted: formatAmountDue(amountDue, contractDecimals),
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

  private static async getUplinesWithRanksForWallet(walletAddress: string): Promise<{ uplines: string[]; ranks: number[] }> {
    const user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });
    if (!user) {
      throw new MembershipError('USER_NOT_REGISTERED', 'No registered profile for this wallet. Please complete sign up first.', 404);
    }
    return NetworkService.getUplinesWithRanks(user.username);
  }

  /**
   * Signs the commission-auth payload the contract verifies on purchase/upgrade.
   * Must match HNTRMembership._verifyCommissionAuth hashing exactly.
   */
  private static async signCommissionAuth(params: {
    user: string;
    tierIndex: number;
    uplines: string[];
    ranks: number[];
    tokenAddress: string;
    deadline: number;
    operation: 'PURCHASE' | 'UPGRADE';
  }): Promise<string> {
    if (!companyWallet) {
      throw new MembershipError(
        'COMPANY_WALLET_NOT_CONFIGURED',
        'Server cannot authorize membership purchases (COMPANY_WALLET_PRIVATE_KEY missing).',
        503,
      );
    }

    const network = await provider.getNetwork();
    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint8', 'address[]', 'uint8[]', 'address', 'uint256', 'uint256', 'address', 'bytes32'],
        [
          ethers.getAddress(params.user),
          params.tierIndex,
          params.uplines.map((a) => ethers.getAddress(a)),
          params.ranks,
          ethers.getAddress(params.tokenAddress),
          params.deadline,
          network.chainId,
          ethers.getAddress(CONTRACT_ADDRESS),
          params.operation === 'PURCHASE' ? PURCHASE_OP : UPGRADE_OP,
        ],
      ),
    );

    return companyWallet.signMessage(ethers.getBytes(structHash));
  }

  private static async prepareAuth(
    walletAddress: string,
    tierIndex: number,
    tokenAddress: string,
    operation: 'PURCHASE' | 'UPGRADE',
  ) {
    const { uplines, ranks } = await this.getUplinesWithRanksForWallet(walletAddress);

    // Anchor deadline to the chain clock so a skewed server clock cannot make
    // fresh signatures look already-expired during eth_estimateGas.
    const latest = await provider.getBlock('latest');
    if (!latest) {
      throw new MembershipError('RPC_ERROR', 'Could not read latest block timestamp from RPC.', 503);
    }
    const deadline = Number(latest.timestamp) + SIGNATURE_TTL_SECONDS;

    const checksumUser = ethers.getAddress(walletAddress);
    const checksumUplines = uplines.map((a) => ethers.getAddress(a));
    const checksumToken = ethers.getAddress(tokenAddress);

    const signature = await this.signCommissionAuth({
      user: checksumUser,
      tierIndex,
      uplines: checksumUplines,
      ranks,
      tokenAddress: checksumToken,
      deadline,
      operation,
    });
    return {
      walletAddress: checksumUser,
      uplines: checksumUplines,
      ranks,
      tokenAddress: checksumToken,
      deadline,
      signature,
    };
  }

  static async purchase(walletAddress: string, tierName: string, tokenSymbol: string): Promise<PreparedMembershipTx> {
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
    const auth = await this.prepareAuth(address, tierIndex, quote.tokenAddress, 'PURCHASE');

    const txnRecord = await Transaction.create({
      walletAddress: address,
      type: 'PURCHASE',
      tier: tierName,
      token: quote.tokenSymbol,
      amount: TIER_VOLUMES[quote.tier as Tier] || 0,
      status: 'PENDING',
    });

    logger.info(
      `Purchase prepared for ${auth.walletAddress}: tier=${tierName}, token=${quote.tokenSymbol}, amount=${quote.amountDueRaw}, deadline=${auth.deadline}, uplines=${auth.uplines.length}`,
    );

    return {
      operation: 'PURCHASE',
      walletAddress: auth.walletAddress,
      tierIndex,
      uplines: auth.uplines,
      ranks: auth.ranks,
      tokenAddress: auth.tokenAddress,
      tokenSymbol: quote.tokenSymbol,
      amountDueRaw: quote.amountDueRaw,
      contractAddress: ethers.getAddress(CONTRACT_ADDRESS),
      deadline: auth.deadline,
      signature: auth.signature,
      pendingTransactionId: txnRecord._id.toString(),
      status: 'PENDING',
    };
  }

  static async upgrade(walletAddress: string, newTierName: string, tokenSymbol: string): Promise<PreparedMembershipTx> {
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
    const auth = await this.prepareAuth(address, newTierIndex, quote.tokenAddress, 'UPGRADE');

    const txnRecord = await Transaction.create({
      walletAddress: address,
      type: 'UPGRADE',
      tier: newTierName,
      token: quote.tokenSymbol,
      amount: TIER_VOLUMES[quote.tier as Tier] || 0,
      status: 'PENDING',
    });

    logger.info(
      `Upgrade prepared for ${auth.walletAddress}: tier=${newTierName}, token=${quote.tokenSymbol}, amount=${quote.amountDueRaw}, deadline=${auth.deadline}, uplines=${auth.uplines.length}`,
    );

    return {
      operation: 'UPGRADE',
      walletAddress: auth.walletAddress,
      tierIndex: newTierIndex,
      uplines: auth.uplines,
      ranks: auth.ranks,
      tokenAddress: auth.tokenAddress,
      tokenSymbol: quote.tokenSymbol,
      amountDueRaw: quote.amountDueRaw,
      contractAddress: ethers.getAddress(CONTRACT_ADDRESS),
      deadline: auth.deadline,
      signature: auth.signature,
      pendingTransactionId: txnRecord._id.toString(),
      status: 'PENDING',
    };
  }
}
