import { ethers } from 'ethers';
import { ENV } from '../config/env';
import { Tier, TIER_VOLUMES } from '../constants';
import { logger } from '../utils/logger';

export const CONTRACT_ADDRESS = ENV.CONTRACT_ADDRESS;
export const RPC_URL = ENV.RPC_URL;

/**
 * Human-readable ABI kept in lockstep with IHNTRMembership.sol / HNTRMembership.sol.
 * If you change the contract's public interface, update this ABI (or better: wire in
 * the compiled artifact from `hntr/out/HNTRMembership.sol/HNTRMembership.json`).
 */
export const contractABI = [
  'constructor(address _usdt, address _usdc)',

  // --- Views ---
  'function usdt() view returns (address)',
  'function usdc() view returns (address)',
  'function treasuryWallet() view returns (address)',
  'function leadershipWallet() view returns (address)',
  'function achievementWallet() view returns (address)',
  'function poolWallet() view returns (address)',
  'function companyWallet() view returns (address)',
  'function owner() view returns (address)',
  'function users(address) view returns (uint8 tier, uint256 joinedAt)',
  'function allUsers(uint256) view returns (address)',
  'function tierPrices(uint8) view returns (uint256)',
  'function withdrawableCommissions(address, address) view returns (uint256)',
  'function lockedCommissions(address, address) view returns (uint256)',
  'function lastClaimedAt(address, address) view returns (uint256)',
  'function levelPercentages(uint256) view returns (uint256)',
  'function tierRequiredForLevel(uint256) view returns (uint8)',
  'function rankRequiredForLevel(uint256) view returns (uint8)',
  'function CLAIM_GRACE_PERIOD() view returns (uint256)',
  'function PURCHASE_OP() view returns (bytes32)',
  'function UPGRADE_OP() view returns (bytes32)',
  'function getUser(address user) view returns (tuple(uint8 tier, uint256 joinedAt))',
  'function getOverdueWallets(address token) view returns (address[])',

  // --- Owner admin ---
  'function setWallets(address _treasury, address _leadership, address _achievement, address _poolWallet)',
  'function setCompanyWallet(address _companyWallet)',

  // --- User writes (backend-signed uplines + ranks) ---
  'function purchaseMembership(address user, uint8 tier, address[] uplines, uint8[] ranks, address token, uint256 deadline, bytes signature)',
  'function upgradeMembership(address user, uint8 newTier, address[] uplines, uint8[] ranks, address token, uint256 deadline, bytes signature)',
  'function withdrawCommissions(address user, address token)',
  'function withdrawCompanyWallet(address user, address token)',

  // --- Events ---
  'event MembershipPurchased(address indexed user, uint8 tier, uint256 amount, address token)',
  'event MembershipUpgraded(address indexed user, uint8 oldTier, uint8 newTier, uint256 amountPaid, address token)',
  'event CommissionEarned(address indexed user, uint256 liquidAmount, uint256 lockedAmount, uint8 level, address token)',
  'event CommissionWithdrawn(address indexed user, uint256 amount, address token)',
  'event CompanyWalletWithdrawn(address indexed user, address indexed token, uint256 amount, address indexed companyWallet)',
  'event WalletsUpdated(address treasury, address leadership, address achievement, address poolWallet)',
  'event CompanyWalletUpdated(address companyWallet)',

  // --- Errors (SafeERC20) ---
  'error SafeERC20FailedOperation(address token)',
];

/** Minimal ERC20 ABI used for pre-flight allowance/balance checks before relaying a tx. */
export const erc20ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export const provider = new ethers.JsonRpcProvider(RPC_URL);

export const hntrContract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, provider);

// Optional signer for the on-chain company wallet. Only available when
// COMPANY_WALLET_PRIVATE_KEY is configured; required for:
// - signing purchase/upgrade commission-auth payloads (uplines + ranks)
// - overdue-wallet queries and company-withdrawal transactions
export const companyWallet = ENV.COMPANY_WALLET_PRIVATE_KEY
  ? new ethers.Wallet(ENV.COMPANY_WALLET_PRIVATE_KEY, provider)
  : null;

/** Commission-auth signature lifetime. Anchored to chain time (not server clock). */
export const SIGNATURE_TTL_SECONDS = 60 * 60; // 1 hour

export const hntrContractWithCompanySigner = companyWallet
  ? hntrContract.connect(companyWallet)
  : null;

export function getErc20(tokenAddress: string) {
  return new ethers.Contract(tokenAddress, erc20ABI, provider);
}

let cachedAmountDecimals: number | null = null;

/**
 * The HNTRMembership contract stores/emit amounts in its own internal decimal scale,
 * which may differ from the ERC20 token decimals (e.g. 6 vs 18). We detect it once by
 * comparing the raw Bronze tier price to the known $50 price so commission balances,
 * event amounts, and transfer amounts all use the same scale.
 */
export async function getContractAmountDecimals(): Promise<number> {
  if (cachedAmountDecimals !== null) {
    return cachedAmountDecimals;
  }

  try {
    const bronzeIndex = 1; // Bronze tier
    const rawPrice = await hntrContract.tierPrices(bronzeIndex);
    const expectedPrice = TIER_VOLUMES[Tier.BRONZE]; // 50
    const rawPerDollar = Number(rawPrice) / expectedPrice;
    const decimals = Math.round(Math.log10(rawPerDollar));

    cachedAmountDecimals = decimals > 0 ? decimals : 18;
    logger.info(`Detected contract amount decimals: ${cachedAmountDecimals} (rawPrice=${rawPrice}, expected=${expectedPrice})`);
  } catch (err: any) {
    logger.warn(`Failed to detect contract amount decimals: ${err.message}; falling back to 18`);
    cachedAmountDecimals = 18;
  }

  return cachedAmountDecimals;
}
