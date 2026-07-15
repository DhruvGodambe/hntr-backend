import cron from 'node-cron';
import { ethers } from 'ethers';
import { checkBurnerBalanceHealthy, burnerWallet } from '../services/contract.service';
import { logger } from '../utils/logger';

/**
 * Every purchase/upgrade/claim depends entirely on the single burner wallet having
 * enough native gas token to relay transactions. If it runs dry, ALL purchases halt
 * silently (each request just starts failing). Poll the balance and log loudly well
 * before that happens so ops can top it up.
 */
export function startBurnerBalanceMonitor() {
  const check = async () => {
    try {
      const { healthy, balance } = await checkBurnerBalanceHealthy();
      const formatted = ethers.formatEther(balance);
      if (!healthy) {
        logger.error(
          `Burner wallet (${burnerWallet.address}) balance is LOW: ${formatted} native token. ` +
            `Purchases/upgrades/claims will start failing once it hits 0. Top it up now.`,
        );
      } else {
        logger.debug(`Burner wallet balance OK: ${formatted} native token.`);
      }
    } catch (error) {
      logger.error('Failed to check burner wallet balance:', error);
    }
  };

  // Check immediately on boot, then every 15 minutes.
  check();
  cron.schedule('*/15 * * * *', check);
}
