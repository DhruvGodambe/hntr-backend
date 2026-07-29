/**
 * Create the first admin panel account (DB-backed login).
 *
 *   npx tsx src/scripts/seed-admin-account.ts [username] [password]
 *
 * If username/password are omitted, defaults are admin / ChangeMe123!
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { AdminAccountService } from '../services/adminAccount.service';

async function seedAdminAccount() {
  const username = process.argv[2] || 'admin';
  const password = process.argv[3] || 'ChangeMe123!';

  try {
    await connectDB();

    const existingCount = await AdminAccountService.countAllAccounts();
    if (existingCount > 0) {
      console.log(`Admin accounts already exist (${existingCount}). Skipping seed.`);
      await mongoose.disconnect();
      process.exit(0);
    }

    const account = await AdminAccountService.createAccount(username, password);
    console.log(`Created admin account: username=${account.username} id=${account.id}`);
    console.log('Change the password after first login.');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Failed to seed admin account:', err);
    await mongoose.disconnect();
    process.exit(1);
  }
}

seedAdminAccount();
