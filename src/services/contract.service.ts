import { ethers } from 'ethers';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

export const CONTRACT_ADDRESS = ENV.CONTRACT_ADDRESS;
export const RPC_URL = ENV.RPC_URL;

/**
 * Human-readable ABI matching the deployed HNTRMembership contract (EIP-712,
 * Ownable2Step, Pausable, ReentrancyGuard, pull-payment, multi-signer).
 */
export const contractABI = [
  'constructor(address _usdt, address _usdc)',

  // --- Views ---
  'function usdt() view returns (address)',
  'function usdc() view returns (address)',
  'function tokenDecimals() view returns (uint8)',
  'function companyWallet() view returns (address)',
  'function leadershipWallet() view returns (address)',
  'function rankWallet() view returns (address)',
  'function poolWallet() view returns (address)',
  'function securityWallet() view returns (address)',
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
  'function MAX_SIGNATURE_VALIDITY() view returns (uint256)',
  'function MAX_UPLINES() view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function signatureEpoch() view returns (uint256)',
  'function isAuthorizedSigner(address) view returns (bool)',
  'function protocolBalances(address, address) view returns (uint256)',
  'function totalProtocolBalance(address) view returns (uint256)',
  'function totalWithdrawable(address) view returns (uint256)',
  'function bootstrapClosed() view returns (bool)',
  'function fundingShortfall(address token) view returns (uint256)',
  'function getUser(address user) view returns (tuple(uint8 tier, uint256 joinedAt))',
  'function getUnclaimedWallets(address token) view returns (address[])',

  // --- Owner admin ---
  'function setWallets(address _company, address _leadership, address _rank, address _poolWallet)',
  'function setSecurityWallet(address _securityWallet)',
  'function pause()',
  'function unpause()',
  'function invalidateSignatures()',
  'function authorizeSigner(address signer)',
  'function revokeSigner(address signer)',
  'function rescueToken(address token, address to, uint256 amount)',
  'function fundBootstrap(address token, uint256 amount)',
  'function seedMemberships(address[] accounts, uint8[] tiers, uint256[] joinedAts)',
  'function seedCommissions(address[] accounts, address[] tokens, uint256[] withdrawable, uint256[] locked, uint256[] lastClaimed)',
  'function sealBootstrap()',
  'function renounceOwnership()',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',

  'function overrideMembershipTier(address user, uint8 tier)',
  
  'function setBurnerWallet(address _burnerWallet)',
  'function burnerWallet() view returns (address)',
  'function voucherRedeemed(bytes32 voucherId) view returns (bool)',
  'function redeemVoucher(bytes32 voucherId, address user, uint8 tier)',

  // --- User writes (backend-signed uplines + ranks) ---
  'function purchaseMembership(address user, uint8 tier, address[] uplines, uint8[] ranks, address token, uint256 deadline, bytes signature)',
  'function upgradeMembership(address user, uint8 newTier, address[] uplines, uint8[] ranks, address token, uint256 deadline, bytes signature)',
  'function purchaseMembershipWithPermit(address user, uint8 tier, address[] uplines, uint8[] ranks, address token, uint256 deadline, bytes signature, uint256 permitValue, uint256 permitDeadline, uint8 permitV, bytes32 permitR, bytes32 permitS)',
  'function upgradeMembershipWithPermit(address user, uint8 newTier, address[] uplines, uint8[] ranks, address token, uint256 deadline, bytes signature, uint256 permitValue, uint256 permitDeadline, uint8 permitV, bytes32 permitR, bytes32 permitS)',
  'function withdrawCommissions(address user, address token)',
  'function withdrawUnclaimed(address user, address token)',
  'function withdrawProtocolBalance(address token)',

  // --- Events ---
  'event MembershipPurchased(address indexed user, uint8 tier, uint256 amount, address token)',
  'event MembershipUpgraded(address indexed user, uint8 oldTier, uint8 newTier, uint256 amountPaid, address token)',
  'event CommissionEarned(address indexed user, uint256 liquidAmount, uint256 lockedAmount, uint8 level, address token)',
  'event CommissionWithdrawn(address indexed user, uint256 amount, address token)',
  'event UnclaimedWithdrawn(address indexed user, address indexed token, uint256 amount, address indexed caller)',
  'event WalletsUpdated(address company, address leadership, address rank, address poolWallet)',
  'event SecurityWalletUpdated(address securityWallet)',
  'event SignaturesInvalidated(uint256 newEpoch)',
  'event TokensRescued(address indexed token, address indexed to, uint256 amount)',
  'event SignerAuthorized(address indexed signer)',
  'event SignerRevoked(address indexed signer)',
  'event ProtocolFundsCredited(address indexed wallet, address indexed token, uint256 amount)',
  'event ProtocolFundsWithdrawn(address indexed wallet, address indexed token, uint256 amount)',
  'event BootstrapFunded(address indexed token, uint256 amount, uint256 newBalance)',
  'event MembershipSeeded(address indexed user, uint8 tier, uint256 joinedAt)',
  'event CommissionSeeded(address indexed user, address indexed token, uint256 withdrawable, uint256 locked, uint256 lastClaimed)',
  'event BootstrapSealed()',
  'event MembershipTierOverriden(address indexed user, uint8 tier, uint256 joinedAt)',
  'event BurnerWalletUpdated(address burnerWallet)',
  'event VoucherRedeemed(address indexed user, bytes32 indexed voucherId, uint8 oldTier, uint8 newTier, uint256 joinedAt)',

  // --- Errors (SafeERC20) ---
  'error SafeERC20FailedOperation(address token)',
];

/** Minimal ERC20 ABI used for balance/allowance checks and pool wallet transfers. */
export const erc20ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

/** Sepolia mock USDT/USDC (and Foundry MockERC20) expose an unrestricted mint. */
export const mintableErc20ABI = [
  ...erc20ABI,
  'function mint(address to, uint256 amount)',
];

export const provider = new ethers.JsonRpcProvider(RPC_URL);

export const hntrContract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, provider);

/** Commission-auth signature lifetime. Anchored to chain time (not server clock). */
export const SIGNATURE_TTL_SECONDS = 60 * 60; // 1 hour

// The security wallet (getUnclaimedWallets / withdrawUnclaimed) has NO backend key.
// getUnclaimedWallets is read via eth_call with a `from` override; withdrawUnclaimed
// is always signed by the admin connecting the security wallet in the admin UI.

// Optional signer for the on-chain burner wallet. Only available when
// BURNER_WALLET_PRIVATE_KEY is configured. The burner sends `redeemVoucher`, signs
// purchase/upgrade commission-auth payloads (it is the contract's authorized signer,
// auto-enrolled by setBurnerWallet), calls `overrideMembershipTier`, and is the hop-2
// payer for leadership/rank/pool disbursements.
export const burnerWallet = ENV.BURNER_WALLET_PRIVATE_KEY
  ? new ethers.Wallet(ENV.BURNER_WALLET_PRIVATE_KEY, provider)
  : null;

export const hntrContractWithBurnerSigner = burnerWallet
  ? (hntrContract.connect(burnerWallet) as ethers.Contract)
  : null;

/**
 * Startup guard: the configured burner key must control the on-chain burnerWallet
 * and be enrolled as the commission-auth signer. Logs loudly and returns a status
 * object rather than throwing, so the rest of the API still boots.
 */
export async function verifyBurnerWallet(): Promise<{
  configured: boolean;
  matches: boolean;
  onChain: string | null;
  address: string | null;
}> {
  if (!burnerWallet) {
    logger.warn('BURNER_WALLET_PRIVATE_KEY not set — voucher redemption is disabled.');
    return { configured: false, matches: false, onChain: null, address: null };
  }
  try {
    const onChain: string = await hntrContract.burnerWallet();
    const matches = onChain.toLowerCase() === burnerWallet.address.toLowerCase();
    if (!matches) {
      logger.error(
        `BURNER_WALLET_PRIVATE_KEY address ${burnerWallet.address} does not match on-chain burnerWallet ${onChain}. Voucher redemption will revert until setBurnerWallet is called.`,
      );
    }
    const isSigner: boolean = await hntrContract.isAuthorizedSigner(burnerWallet.address);
    if (!isSigner) {
      logger.error(
        `burner wallet ${burnerWallet.address} is NOT an authorized commission signer. Membership purchases will revert until setBurnerWallet is called on this contract.`,
      );
    }
    return { configured: true, matches, onChain, address: burnerWallet.address };
  } catch (err: any) {
    logger.warn(`verifyBurnerWallet failed: ${err.message}`);
    return { configured: true, matches: false, onChain: null, address: burnerWallet.address };
  }
}

/** Burner gas-balance health, surfaced to the admin panel and the voucher cron. */
export async function getBurnerHealth(): Promise<{
  configuredAddress: string | null;
  onChainAddress: string | null;
  matches: boolean;
  balanceEth: number;
  minEth: number;
  healthy: boolean;
}> {
  const status = await verifyBurnerWallet();
  let balanceEth = 0;
  if (burnerWallet) {
    try {
      balanceEth = Number(ethers.formatEther(await provider.getBalance(burnerWallet.address)));
    } catch (err: any) {
      logger.warn(`getBurnerHealth balance read failed: ${err.message}`);
    }
  }
  const minEth = ENV.BURNER_MIN_ETH;
  return {
    configuredAddress: status.address,
    onChainAddress: status.onChain,
    matches: status.matches,
    balanceEth,
    minEth,
    healthy: status.configured && status.matches && balanceEth >= minEth,
  };
}

export function getErc20(tokenAddress: string) {
  return new ethers.Contract(tokenAddress, erc20ABI, provider);
}

let cachedTokenDecimals: number | null = null;

/**
 * Reads the immutable `tokenDecimals` from the deployed HNTRMembership contract.
 * This is the decimal scale shared by USDT/USDC (detected at deploy time) and used
 * for all tier prices, commission balances, and transfer amounts.
 */
export async function getContractAmountDecimals(): Promise<number> {
  if (cachedTokenDecimals !== null) {
    return cachedTokenDecimals;
  }

  try {
    cachedTokenDecimals = Number(await hntrContract.tokenDecimals());
    logger.info(`Contract tokenDecimals: ${cachedTokenDecimals}`);
  } catch (err: any) {
    logger.warn(`Failed to read tokenDecimals(): ${err.message}; falling back to 6`);
    cachedTokenDecimals = 6;
  }

  return cachedTokenDecimals;
}
