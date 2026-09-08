/**
 * Verify CoinGecko Mongo cache: cold miss → store → warm hit → concurrent coalesce.
 *   npx tsx src/scripts/verify-coingecko-cache.ts
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { CoinGeckoService } from '../services/coingecko.service';
import CoinGeckoCache from '../models/CoinGeckoCache';

const PATH = 'search/trending';

async function main() {
  await connectDB();

  // Force a cold path for this run by clearing this key.
  await CoinGeckoCache.deleteOne({ key: PATH });

  const t0 = Date.now();
  const cold = await CoinGeckoService.get(PATH);
  const coldMs = Date.now() - t0;
  const afterCold = await CoinGeckoCache.findOne({ key: PATH }).lean();

  const t1 = Date.now();
  const warm = await CoinGeckoService.get(PATH);
  const warmMs = Date.now() - t1;

  const concurrent = await Promise.all(
    Array.from({ length: 20 }, () => CoinGeckoService.get(PATH)),
  );

  const eth = await CoinGeckoService.getEthUsdPrice();

  console.log(
    JSON.stringify(
      {
        coldStatus: cold.status,
        warmStatus: warm.status,
        coldMs,
        warmMs,
        cachedAfterCold: Boolean(afterCold),
        expiresAt: afterCold?.expiresAt,
        concurrentOk: concurrent.every((r) => r.status === 200),
        concurrentCount: concurrent.length,
        ethStatus: eth.status,
        ethUsd: (eth.body as { usd?: number } | null)?.usd ?? null,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
  if (cold.status !== 200 || warm.status !== 200 || !afterCold) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
