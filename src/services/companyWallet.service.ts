import { ethers } from 'ethers';
import {
  hntrContract,
  hntrContractWithCompanySigner,
  companyWallet,
  getErc20,
  getContractAmountDecimals,
} from './contract.service';
import { logger } from '../utils/logger';

export class CompanyWalletError extends Error {
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
  throw new CompanyWalletError('UNSUPPORTED_TOKEN', `Unsupported token: ${tokenSymbol}`);
}

export class CompanyWalletService {
  /**
   * On-chain company wallet address (public view). Used by admin UI to verify
   * the ConnectKit-connected wallet before signing withdrawCompanyWallet txs.
   */
  static async getCompanyWalletAddress(): Promise<string> {
    const address = await hntrContract.companyWallet();
    return String(address).toLowerCase();
  }

  /**
   * Returns all wallets that have withdrawable commissions and are overdue for the
   * given token (last claim > 30 days ago or never claimed).
   * Uses eth_call with `from = companyWallet` so the onlyCompanyWallet view gate
   * passes without needing the company private key on the server.
   */
  static async getOverdueWallets(tokenSymbol: string): Promise<{
    token: string;
    tokenAddress: string;
    overdue: string[];
    count: number;
    companyWallet: string;
  }> {
    const tokenAddress = await resolveTokenAddress(tokenSymbol);
    const companyAddress = await this.getCompanyWalletAddress();

    const overdue: string[] = await hntrContract.getOverdueWallets.staticCall(tokenAddress, {
      from: companyAddress,
    });

    return {
      token: tokenSymbol.toUpperCase(),
      tokenAddress: String(tokenAddress).toLowerCase(),
      overdue: overdue.map((a) => a.toLowerCase()),
      count: overdue.length,
      companyWallet: companyAddress,
    };
  }

  /**
   * Executes `withdrawCompanyWallet(user, token)` from the backend company signer.
   * Prefer admin-panel client-side ConnectKit signing; this remains for secret admin scripts.
   */
  static async withdrawForUser(walletAddress: string, tokenSymbol: string): Promise<{
    txHash: string;
    amount: number;
  }> {
    if (!companyWallet || !hntrContractWithCompanySigner) {
      throw new CompanyWalletError(
        'NOT_CONFIGURED',
        'Company wallet private key is not configured in the backend. Connect the company wallet in the admin UI instead.',
        503,
      );
    }

    const address = walletAddress.toLowerCase();
    const tokenAddress = await resolveTokenAddress(tokenSymbol);
    const amountDecimals = await getContractAmountDecimals();

    const claimable = await hntrContract.withdrawableCommissions(address, tokenAddress);
    if (claimable === BigInt(0)) {
      throw new CompanyWalletError('NO_CLAIMABLE', 'No withdrawable commissions for this wallet/token.', 400);
    }

    const tx = await (hntrContractWithCompanySigner as any).withdrawCompanyWallet(address, tokenAddress);
    logger.info(`Company wallet withdrawal submitted for ${address}: ${tx.hash}`);
    await tx.wait();

    const amount = Number(ethers.formatUnits(claimable, amountDecimals));
    return { txHash: tx.hash as string, amount };
  }

  /**
   * Reads the live token balance of the pool wallet. The contract sends the 20%
   * locked portion of every commission to this wallet, so it accumulates over time.
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
