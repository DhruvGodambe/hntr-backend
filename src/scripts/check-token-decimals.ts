/**
 * Read-only check: actual on-chain decimals() of the configured USDT/USDC
 * against the membership contract's assumed 6-decimal tierPrices.
 *
 *   npx tsx src/scripts/check-token-decimals.ts
 */
import { ethers } from 'ethers';
import { provider } from '../services/contract.service';
import { ENV } from '../config/env';

async function main() {
  const erc20Abi = [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ];
  const usdt = new ethers.Contract(ENV.USDT_ADDRESS, erc20Abi, provider);
  const usdc = new ethers.Contract(ENV.USDC_ADDRESS, erc20Abi, provider);
  const membershipAbi = ['function tierPrices(uint8) view returns (uint256)'];
  const membership = new ethers.Contract(ENV.CONTRACT_ADDRESS, membershipAbi, provider);

  const [usdtDec, usdtSym, usdcDec, usdcSym, bronzePrice, silverPrice] = await Promise.all([
    usdt.decimals(),
    usdt.symbol(),
    usdc.decimals(),
    usdc.symbol(),
    membership.tierPrices(1),
    membership.tierPrices(2),
  ]);

  console.log(
    JSON.stringify(
      {
        USDT_ADDRESS: ENV.USDT_ADDRESS,
        usdtDecimalsOnChain: Number(usdtDec),
        usdtSymbol: usdtSym,
        USDC_ADDRESS: ENV.USDC_ADDRESS,
        usdcDecimalsOnChain: Number(usdcDec),
        usdcSymbol: usdcSym,
        bronzePriceRaw: bronzePrice.toString(),
        silverPriceRaw: silverPrice.toString(),
        bronzeAsAssumed6Dec: Number(ethers.formatUnits(bronzePrice, 6)),
        bronzeAsActualTokenDec: Number(ethers.formatUnits(bronzePrice, Number(usdtDec))),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
