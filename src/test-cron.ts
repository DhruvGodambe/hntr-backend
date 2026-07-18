import mongoose from 'mongoose';
import { RewardsService } from './services/rewards.service';
import User from './models/User';
import Payout from './models/Payout';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../hntr/.env') });

async function testCron() {
  console.log('Testing Leadership Cron Execution...');
  
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hntr_test_db';
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to MongoDB: ${MONGODB_URI}`);

  // Create a mock user who qualifies for shares
  await User.deleteMany({});
  await Payout.deleteMany({});
  
  await User.create({
    username: 'LegendLeader',
    walletAddress: '0x111122223333444455556666777788889999aaaa',
    rank: 'Legend Hunter',
    ancestors: [],
    directDownline: [],
    tier: 'Diamond',
    teamVolume: 30000000,
    legVolumes: new Map(),
    joinedAt: new Date()
  });
  
  await User.create({
    username: 'EliteLeader',
    walletAddress: '0xbbbbccccddddeeeeffff00001111222233334444',
    rank: 'Elite Hunter',
    ancestors: [],
    directDownline: [],
    tier: 'Platinum',
    teamVolume: 1000000,
    legVolumes: new Map(),
    joinedAt: new Date()
  });

  console.log('Running calculateMonthlyLeadershipPool...');
  try {
    const payouts = await RewardsService.calculateMonthlyLeadershipPool();
    console.log('Generated Payouts:', payouts.map(p => ({ user: p.username, amount: p.amountUSDC, shares: p.shares })));
    
    // Check DB
    const dbPayouts = await Payout.find();
    console.log(`Found ${dbPayouts.length} payouts saved in DB.`);
  } catch (error) {
    console.error('Test Failed:', error);
  } finally {
    await mongoose.disconnect();
  }
}

testCron();
