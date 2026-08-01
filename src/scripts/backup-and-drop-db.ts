/**
 * Backup all Mongo collections to backups/hntr-<timestamp>/ as JSON,
 * then drop the database.
 *
 *   npx tsx src/scripts/backup-and-drop-db.ts
 *   npx tsx src/scripts/backup-and-drop-db.ts --backup-only
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';

const backupOnly = process.argv.includes('--backup-only');

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(process.cwd(), 'backups', `hntr-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const cols = await db.listCollections().toArray();
  const summary: { collection: string; count: number }[] = [];

  for (const c of cols) {
    const name = c.name;
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(docs, null, 2));
    summary.push({ collection: name, count: docs.length });
  }

  fs.writeFileSync(
    path.join(outDir, '_manifest.json'),
    JSON.stringify(
      {
        database: db.databaseName,
        createdAt: new Date().toISOString(),
        collections: summary,
      },
      null,
      2,
    ),
  );

  console.log(`BACKUP_DIR=${outDir}`);
  console.log(`COLLECTIONS=${summary.length}`);
  console.log(`TOTAL_DOCS=${summary.reduce((n, s) => n + s.count, 0)}`);

  if (backupOnly) {
    await mongoose.disconnect();
    process.exit(0);
  }

  const name = db.databaseName;
  await mongoose.connection.dropDatabase();
  console.log(`DROPPED_DB=${name}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
