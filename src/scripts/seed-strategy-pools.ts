/**
 * Seed StrategyPool docs from test.strategypools.json, one at a time, letting
 * Mongo generate fresh _ids (the file's own $oid values are dropped/ignored).
 * Skips any pool whose slug already exists so this is safe to re-run.
 *
 *   npx tsx src/scripts/seed-strategy-pools.ts
 */
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { connectDB } from '../config/db';
import StrategyPool from '../models/StrategyPool';

const DATA_PATH = path.resolve(__dirname, '../../test.strategypools.json');

async function seedStrategyPools() {
  try {
    await connectDB();

    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    const pools = JSON.parse(raw) as Array<Record<string, any>>;

    for (const pool of pools) {
      const { _id, __v, createdAt, updatedAt, ...doc } = pool;

      const existing = await StrategyPool.findOne({ slug: doc.slug });
      if (existing) {
        console.log(`Skipped (already exists): slug=${doc.slug} id=${existing.id}`);
        continue;
      }

      const created = await StrategyPool.create(doc);
      console.log(`Created: slug=${created.slug} id=${created.id}`);
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Failed to seed strategy pools:', err);
    await mongoose.disconnect();
    process.exit(1);
  }
}

seedStrategyPools();
