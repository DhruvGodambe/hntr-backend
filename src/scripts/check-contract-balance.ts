import { ethers } from 'ethers';
import { hntrContract, getErc20 } from '../services/contract.service';

/**
 * Diagnostic script: reads the on-chain withdrawable and locked commission
 * balances for a given wallet directly from the HNTRMembership contract.
 *
 * Run:
 *   npx tsx src/scripts/check-contract-balance.ts 0xYourWalletAddress
 */
async function main() {
  const walletAddress = process.argv[2];
  if (!walletAddress) {
    console.error('Usage: npx tsx src/scripts/check-contract-balance.ts <wallet-address>');
    process.exit(1);
  }

  const normalized = walletAddress.toLowerCase();

  const [usdtAddress, usdcAddress] = await Promise.all([
    hntrContract.usdt(),
    hntrContract.usdc(),
  ]);

  console.log(`Contract: ${await hntrContract.getAddress()}`);
  console.log(`Wallet:   ${normalized}`);
  console.log(`USDT:     ${usdtAddress}`);
  console.log(`USDC:     ${usdcAddress}`);
  console.log('');

  for (const [symbol, tokenAddress] of [['USDT', usdtAddress], ['USDC', usdcAddress]] as const) {
    const erc20 = getErc20(tokenAddress);
    const [withdrawable, locked, decimals] = await Promise.all([
      hntrContract.withdrawableCommissions(normalized, tokenAddress),
      hntrContract.lockedCommissions(normalized, tokenAddress),
      erc20.decimals().catch(() => 6),
    ]);

    console.log(`${symbol}:`);
    console.log(`  withdrawableCommissions: ${ethers.formatUnits(withdrawable, decimals)}`);
    console.log(`  lockedCommissions:       ${ethers.formatUnits(locked, decimals)}`);
    console.log(`  raw withdrawable:          ${withdrawable.toString()}`);
    console.log(`  raw locked:                ${locked.toString()}`);
    console.log(`  decimals:                  ${decimals}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('Failed to check contract balance:', err.message);
  process.exit(1);
});
