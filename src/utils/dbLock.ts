import crypto from 'crypto';
import Lock from '../models/Lock';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding a MongoDB lease lock, so it is exclusive across every backend
 * process sharing the database (not just this one). The lease expires on its own after
 * `leaseMs`, so a crashed holder can never wedge the lock.
 */
export async function withDbLock<T>(
  key: string,
  fn: () => Promise<T>,
  { leaseMs = 30_000, waitMs = 20_000 } = {},
): Promise<T> {
  const owner = crypto.randomUUID();
  const giveUpAt = Date.now() + waitMs;

  for (;;) {
    const now = new Date();
    try {
      // Matches only a free (expired) lock; when it is held, the upsert collides on the
      // unique key instead, which is how "someone else has it" shows up.
      await Lock.findOneAndUpdate(
        { key, expiresAt: { $lte: now } },
        { $set: { owner, expiresAt: new Date(now.getTime() + leaseMs) } },
        { upsert: true },
      );
      break;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      if (Date.now() > giveUpAt) throw new Error(`Timed out waiting for lock "${key}"`);
      await sleep(50 + Math.random() * 100);
    }
  }

  try {
    return await fn();
  } finally {
    await Lock.updateOne({ key, owner }, { $set: { expiresAt: new Date(0) } }).catch(() => undefined);
  }
}
