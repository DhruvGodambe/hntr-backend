import { ethers } from 'ethers';
import { hntrContract, getErc20 } from './contract.service';

export class SecurityWalletError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function resolveTokenAddress(tokenSymbol: string): Promise<string> {
  const symbol = String(tokenSymbol).toUpperCase();
  if (symbol === 'USDT') return hntrContract.usdt();
  if (symbol === 'USDC') return hntrContract.usdc();
  if (ethers.isAddress(tokenSymbol)) return tokenSymbol.toLowerCase();
  throw new SecurityWalletError('UNSUPPORTED_TOKEN', `Unsupported token: ${tokenSymbol}`);
}

/**
 * Read-only helpers for the on-chain security wallet. It has no backend private key:
 * `withdrawUnclaimed` is always signed by the admin connecting the security wallet in
 * the admin UI, and `getUnclaimedWallets` is a view called with a `from` override.
 */
export class SecurityWalletService {
  /** On-chain security wallet address, used by the admin UI to verify the connected wallet. */
  static async getSecurityWalletAddress(): Promise<string> {
    const address = await hntrContract.securityWallet();
    return String(address).toLowerCase();
  }

  /**
   * Wallets with withdrawable commissions that are overdue for the given token
   * (last claim > 30 days ago or never claimed). eth_call with `from = securityWallet`
   * so the onlySecurityWallet view gate passes without any private key.
   */
  static async getUnclaimedWallets(tokenSymbol: string): Promise<{
    token: string;
    tokenAddress: string;
    overdue: string[];
    count: number;
    securityWallet: string;
  }> {
    const tokenAddress = await resolveTokenAddress(tokenSymbol);
    const securityAddress = await this.getSecurityWalletAddress();

    const overdue: string[] = await hntrContract.getUnclaimedWallets.staticCall(tokenAddress, {
      from: securityAddress,
    });

    return {
      token: tokenSymbol.toUpperCase(),
      tokenAddress: String(tokenAddress).toLowerCase(),
      overdue: overdue.map((a) => a.toLowerCase()),
      count: overdue.length,
      securityWallet: securityAddress,
    };
  }

  /**
   * Live token balance of the pool wallet. The contract sends the 20% locked portion
   * of every commission here, so it accumulates over time.
   */
  static async getPoolWalletBalance(tokenSymbol: string): Promise<{
    token: string;
    tokenAddress: string;
    poolWallet: string;
    balance: number;
  }> {
    const tokenAddress = await resolveTokenAddress(tokenSymbol);
    const poolWallet = await hntrContract.poolWallet();
    const [rawBalance, decimals] = await Promise.all([
      getErc20(tokenAddress).balanceOf(poolWallet),
      getErc20(tokenAddress).decimals().catch(() => 6),
    ]);

    const balance = Number(ethers.formatUnits(rawBalance, Number(decimals)));

    return {
      token: tokenSymbol.toUpperCase(),
      tokenAddress,
      poolWallet: poolWallet.toLowerCase(),
      balance,
    };
  }
}
