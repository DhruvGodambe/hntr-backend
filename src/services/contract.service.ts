import { ethers } from 'ethers';
import { ENV } from '../config/env';
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
  'function burnerWallet() view returns (address)',
  'function owner() view returns (address)',
  'function users(address) view returns (uint8 tier, uint256 joinedAt)',
  'function tierPrices(uint8) view returns (uint256)',
  'function tierMaxLevels(uint8) view returns (uint8)',
  'function withdrawableCommissions(address, address) view returns (uint256)',
  'function lockedCommissions(address, address) view returns (uint256)',
  'function levelPercentages(uint256) view returns (uint256)',
  'function getUser(address user) view returns (tuple(uint8 tier, uint256 joinedAt))',

  // --- Owner admin ---
  'function setWallets(address _treasury, address _leadership, address _achievement, address _poolWallet)',
  'function setBurnerWallet(address _burnerWallet)',

  // --- Burner-relayed writes ---
  'function purchaseMembership(address user, uint8 tier, address[] uplines, address token)',
  'function upgradeMembership(address user, uint8 newTier, address[] uplines, address token)',
  'function withdrawCommissions(address user, address token)',

  // --- Events ---
  'event MembershipPurchased(address indexed user, uint8 tier, uint256 amount, address token)',
  'event MembershipUpgraded(address indexed user, uint8 oldTier, uint8 newTier, uint256 amountPaid, address token)',
  'event CommissionEarned(address indexed user, uint256 liquidAmount, uint256 lockedAmount, uint8 level, address token)',
  'event CommissionWithdrawn(address indexed user, uint256 amount, address token)',
  'event WalletsUpdated(address treasury, address leadership, address achievement, address poolWallet)',
  'event BurnerWalletUpdated(address burnerWallet)',

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

if (!ENV.PRIVATE_KEY) {
  logger.error('PRIVATE_KEY is not set - the burner relayer cannot sign any transaction (purchase/upgrade/claim will fail).');
}

// Burner wallet used to relay purchaseMembership / upgradeMembership / withdrawCommissions.
export const burnerWallet = new ethers.Wallet(
  ENV.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000001',
  provider,
);

export const hntrContract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, provider);
export const hntrContractWithSigner = hntrContract.connect(burnerWallet);

export function getErc20(tokenAddress: string) {
  return new ethers.Contract(tokenAddress, erc20ABI, provider);
}

/**
 * Serializes every burner-signed transaction (purchase/upgrade/claim) through a single
 * promise chain so concurrent requests can never collide on the burner wallet's nonce.
 * A single Node process handles all writes here; if this service is ever scaled
 * horizontally, replace this with a distributed lock/queue (e.g. Redis) around the
 * same burner wallet key.
 */
class BurnerTxQueue {
  private queue: Promise<unknown> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Swallow errors here so one failed tx doesn't poison the rest of the queue.
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export const burnerTxQueue = new BurnerTxQueue();

export async function getBurnerBalance(): Promise<bigint> {
  return provider.getBalance(burnerWallet.address);
}

export async function checkBurnerBalanceHealthy(): Promise<{ healthy: boolean; balance: bigint }> {
  const balance = await getBurnerBalance();
  return { healthy: balance >= ENV.MIN_BURNER_BALANCE_WEI, balance };
}
