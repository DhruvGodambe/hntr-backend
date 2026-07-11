import mongoose from 'mongoose';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../hntr/.env') });

import User from '../models/User';
import Transaction from '../models/Transaction';
import { BlockchainService } from '../services/blockchain.service';
import { hntrContract, provider, CONTRACT_ADDRESS } from '../services/contract.service';

/**
 * LIVE SEPOLIA FULL COMMISSION FLOW TEST
 * Tests the entire commission logic including: multi-level uplines, dynamic compression, 
 * 80/20 liquid/locked splits, treasury breakage, and withdrawal.
 */
async function runFullCommissionFlow() {
  console.log("==========================================");
  console.log("🚀 STARTING FULL COMMISSION FLOW ON SEPOLIA");
  console.log("==========================================\n");

  const privateKey = process.env.PRIVATE_KEY;
  const mockUSDTAddress = "0xEC4ca582619E79FdedC4bc23948d7d7856b6750e";

  const TREASURY = "0x284E6b41dB482d9edE9449Bbda1198d95464B23D";
  
  // Dynamically generate a Leadership Wallet so we can test the cron job payouts
  const leadershipWallet = ethers.Wallet.createRandom().connect(provider);
  const LEADERSHIP = leadershipWallet.address;
  
  const ACHIEVEMENT = "0x3D6D1BffaDd3a71baDdC3E6468ed144f0F4B975b";

  if (!privateKey) {
    console.error("❌ PRIVATE_KEY not found in .env!");
    process.exit(1);
  }

  // 1. Setup 3 Wallets (Owner, Upline, Buyer)
  const ownerWallet = new ethers.Wallet(privateKey, provider);
  const uplineWallet = ethers.Wallet.createRandom().connect(provider);
  const buyerWallet = ethers.Wallet.createRandom().connect(provider);

  console.log(`👤 Owner/Genesis: ${ownerWallet.address}`);
  console.log(`👤 Upline User:   ${uplineWallet.address}`);
  console.log(`👤 Buyer User:    ${buyerWallet.address}`);
  
  // 1.5 Setup Backend & MongoDB
  console.log("\n--- CONFIGURING BACKEND DATABASE ---");
  const MONGODB_URI = 'mongodb://localhost:27017/hntr_test_db';
  await mongoose.connect(MONGODB_URI);
  await User.deleteMany({});
  await Transaction.deleteMany({});
  
  const ownerUser = await User.create({ username: 'Genesis', walletAddress: ownerWallet.address.toLowerCase(), tier: 'Apex', rank: 'Legend Hunter', ancestors: [], legVolumes: new Map() });
  const uplineUser = await User.create({ username: 'Upline', walletAddress: uplineWallet.address.toLowerCase(), tier: 'Hunter', rank: 'Elite Hunter', ancestors: ['Genesis'], legVolumes: new Map() });
  const buyerUser = await User.create({ username: 'Buyer', walletAddress: buyerWallet.address.toLowerCase(), tier: 'None', rank: 'None', ancestors: ['Genesis', 'Upline'], legVolumes: new Map() });
  
  console.log(`✅ MongoDB Cleared and Users Created!`);

  const blockchainService = new BlockchainService();
  hntrContract.on('MembershipPurchased', async (buyer: string, tierIndex: number, amount: bigint, token: string, event: any) => {
    console.log(`[BACKEND] Captured MembershipPurchased Event: ${buyer} bought tier ${tierIndex}`);
    await (blockchainService as any).handlePurchaseOrUpgrade(buyer.toLowerCase(), tierIndex, event.log.transactionHash, 'PURCHASE');
  });
  console.log(`✅ Backend actively listening for events on Sepolia...`);

  // Fund the newly created wallets with a little Sepolia ETH for gas
  console.log(`\n⏳ Funding test wallets with Sepolia ETH for gas...`);
  const fundTx1 = await ownerWallet.sendTransaction({ to: uplineWallet.address, value: ethers.parseEther("0.005") });
  const fundTx2 = await ownerWallet.sendTransaction({ to: buyerWallet.address, value: ethers.parseEther("0.005") });
  const fundTx3 = await ownerWallet.sendTransaction({ to: leadershipWallet.address, value: ethers.parseEther("0.005") }); // Needed for cron payouts
  await Promise.all([fundTx1.wait(), fundTx2.wait(), fundTx3.wait()]);
  console.log(`✅ Test wallets funded with ETH!`);

  // 2. Configure Protocol Wallets
  console.log("\n--- CONFIGURING PROTOCOL WALLETS ---");
  const liveHntrContract = hntrContract.connect(ownerWallet) as ethers.Contract;
  try {
    const setTx = await liveHntrContract.setWallets(TREASURY, LEADERSHIP, ACHIEVEMENT);
    await setTx.wait();
    console.log(`✅ Protocol Wallets successfully configured!`);
  } catch (e: any) {
    console.log(`⚠️ setWallets failed or already set.`);
  }

  // 3. Mint Mock USDT to all 3 wallets
  console.log("\n--- MINTING MOCK USDT ---");
  const erc20Abi = [
    "function mint(address to, uint256 amount) external",
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function balanceOf(address account) public view returns (uint256)"
  ];
  const usdtContract = new ethers.Contract(mockUSDTAddress, erc20Abi, ownerWallet);

  const mintAmount = ethers.parseUnits("5000", 6);
  await (await usdtContract.mint(ownerWallet.address, mintAmount)).wait();
  await (await usdtContract.mint(uplineWallet.address, mintAmount)).wait();
  await (await usdtContract.mint(buyerWallet.address, mintAmount)).wait();
  console.log(`✅ Minted 5,000 USDT to all 3 wallets!`);

  // 4. Setup Upline Tiers (Owner buys Apex, Upline buys Hunter)
  console.log("\n--- SETTING UP UPLINE TIERS ---");
  
  console.log(`⏳ Owner buying Apex (Tier 5) so they can receive commissions...`);
  await (await usdtContract.approve(CONTRACT_ADDRESS, ethers.parseUnits("2500", 6))).wait();
  try {
      await (await liveHntrContract.purchaseMembership(5, [], mockUSDTAddress)).wait();
  } catch (e) { console.log("Owner already has a tier."); }

  console.log(`⏳ Upline buying Hunter (Tier 4) under Owner...`);
  const usdtUpline = usdtContract.connect(uplineWallet) as ethers.Contract;
  const hntrUpline = hntrContract.connect(uplineWallet) as ethers.Contract;
  await (await usdtUpline.approve(CONTRACT_ADDRESS, ethers.parseUnits("1500", 6))).wait();
  try {
      await (await hntrUpline.purchaseMembership(4, [ownerWallet.address], mockUSDTAddress)).wait();
  } catch(e) { console.log("Upline already has a tier."); }

  // 5. Execution: Buyer buys Tracker under Upline -> Owner
  console.log("\n--- EXECUTING BUYER PURCHASE (TESTING COMMISSIONS) ---");
  
  // Snapshots
  const tBalInit = await usdtContract.balanceOf(TREASURY);
  const ownerLiquidInit = await liveHntrContract.withdrawableCommissions(ownerWallet.address, mockUSDTAddress);
  const uplineLiquidInit = await liveHntrContract.withdrawableCommissions(uplineWallet.address, mockUSDTAddress);

  console.log(`⏳ Buyer buying Tracker (Tier 2 - $250) under [Upline, Owner]...`);
  const usdtBuyer = usdtContract.connect(buyerWallet) as ethers.Contract;
  const hntrBuyer = hntrContract.connect(buyerWallet) as ethers.Contract;
  await (await usdtBuyer.approve(CONTRACT_ADDRESS, ethers.parseUnits("250", 6))).wait();
  
  // Upline array is closest first: [Upline, Owner]
  await (await hntrBuyer.purchaseMembership(2, [uplineWallet.address, ownerWallet.address], mockUSDTAddress)).wait();
  console.log(`✅ Purchase successful! Checking internal ledger...`);

  // 6. Verify 80/20 Split and Network Distribution
  console.log("\n--- VERIFYING COMMISSION MATH ---");
  const ownerLiquidFinal = await liveHntrContract.withdrawableCommissions(ownerWallet.address, mockUSDTAddress);
  const ownerLockedFinal = await liveHntrContract.lockedCommissions(ownerWallet.address, mockUSDTAddress);
  
  const uplineLiquidFinal = await liveHntrContract.withdrawableCommissions(uplineWallet.address, mockUSDTAddress);
  const uplineLockedFinal = await liveHntrContract.lockedCommissions(uplineWallet.address, mockUSDTAddress);

  const tBalFinal = await usdtContract.balanceOf(TREASURY);

  // Buyer paid $250.
  // Level 1 Upline (Upline Wallet) should get 20% = $50. (Liquid 80%: $40, Locked 20%: $10)
  // Level 2 Upline (Owner Wallet) should get 10% = $25. (Liquid 80%: $20, Locked 20%: $5)
  // Treasury gets 25% ($62.5) + Breakage (Remaining 35% of network = $87.5) = $150 total to Treasury
  
  console.log(`Upline Wallet Earned:`);
  console.log(`  Liquid: $${ethers.formatUnits(uplineLiquidFinal - uplineLiquidInit, 6)} (Expected: $40.0)`);
  console.log(`  Locked: $${ethers.formatUnits(uplineLockedFinal, 6)} (Expected: $10.0)`);
  
  console.log(`Owner Wallet Earned:`);
  console.log(`  Liquid: $${ethers.formatUnits(ownerLiquidFinal - ownerLiquidInit, 6)} (Expected: $20.0)`);
  console.log(`  Locked: $${ethers.formatUnits(ownerLockedFinal, 6)} (Expected: $5.0)`);

  console.log(`Treasury Wallet Gained:`);
  console.log(`  Total:  $${ethers.formatUnits(tBalFinal - tBalInit, 6)} (Expected: $150.0)`);

  // 7. Test Withdrawal
  console.log("\n--- TESTING WITHDRAWALS ---");
  
  // Upline Withdrawal
  const uplineUsdtInit = await usdtContract.balanceOf(uplineWallet.address);
  console.log(`⏳ Upline calling withdrawCommissions()...`);
  await (await hntrUpline.withdrawCommissions(mockUSDTAddress)).wait();
  const uplineUsdtFinal = await usdtContract.balanceOf(uplineWallet.address);
  console.log(`✅ Upline Actual USDT Balance Increased By: $${ethers.formatUnits(uplineUsdtFinal - uplineUsdtInit, 6)}`);

  // Owner Withdrawal
  const ownerUsdtInit = await usdtContract.balanceOf(ownerWallet.address);
  const ownerWithdrawable = await liveHntrContract.withdrawableCommissions(ownerWallet.address, mockUSDTAddress);
  console.log(`⏳ Owner withdrawing their total Liquid commissions ($${ethers.formatUnits(ownerWithdrawable, 6)})...`);
  
  if (ownerWithdrawable > BigInt(0)) {
      await (await liveHntrContract.withdrawCommissions(mockUSDTAddress)).wait();
      const ownerUsdtFinal = await usdtContract.balanceOf(ownerWallet.address);
      console.log(`✅ Owner Actual USDT Balance Increased By: $${ethers.formatUnits(ownerUsdtFinal - ownerUsdtInit, 6)}`);
  } else {
      console.log(`⚠️ Owner had $0 liquid commissions to withdraw.`);
  }

  console.log("\n--- VERIFYING BACKEND DATABASE SYNCHRONIZATION ---");
  // Wait a few seconds for the event listener promises to finish updating MongoDB
  await new Promise(resolve => setTimeout(resolve, 5000));

  const dbOwner = await User.findOne({ username: 'Genesis' });
  const dbUpline = await User.findOne({ username: 'Upline' });
  const dbBuyer = await User.findOne({ username: 'Buyer' });

  console.log(`Database State after Blockchain Events:`);
  console.log(`Genesis Tier: ${dbOwner?.tier} (Expected: Apex)`);
  console.log(`Upline Tier:  ${dbUpline?.tier} (Expected: Hunter)`);
  console.log(`Buyer Tier:   ${dbBuyer?.tier} (Expected: Tracker)`);

  if (dbOwner?.tier === 'Apex' && dbBuyer?.tier === 'Tracker') {
    console.log("🎉 SUCCESS: The backend perfectly synchronized with the smart contract events!");
  } else {
    console.log("⚠️ WARNING: The backend database did not update. The BlockchainService might have missed the event or failed.");
  }
  
  // 7.5 Test Rank Evaluation and Achievement Bonus Report
  console.log("\n--- TESTING RANK EVALUATION & ACHIEVEMENT REPORT ---");
  const { NetworkService } = await import('../services/network.service');
  const { RewardsService: RS } = await import('../services/rewards.service');

  console.log(`⏳ Simulating $5,000,000 leg volume for Upline (Hunter Tier)...`);
  const uplineToUpdate = await User.findOne({ username: 'Upline' });
  if (uplineToUpdate) {
      uplineToUpdate.legVolumes.set('FakeLeg1', 2000000);
      uplineToUpdate.legVolumes.set('FakeLeg2', 2000000);
      uplineToUpdate.legVolumes.set('FakeLeg3', 1000000);
      uplineToUpdate.teamVolume = 5000000;
      await uplineToUpdate.save();
      
      const newRank = await NetworkService.evaluateRank('Upline');
      console.log(`✅ Upline Evaluated Rank: ${newRank}`);
      if (newRank === 'Elite Hunter' || newRank === 'Hunter') { // Capped because of Hunter tier
          console.log(`   -> SUCCESS: Upline was restricted (capped at Elite Hunter/Hunter) because they lack the Apex tier for Master Hunter!`);
      } else {
          console.log(`   -> FAILED: Upline got rank ${newRank}, but should have been capped.`);
      }
  }

  console.log(`⏳ Generating Rank Bonus Report...`);
  const bonusReport = await RS.generateRankBonusReport();
  console.log(`✅ Rank Bonus Report Generated: Found ${bonusReport.length} eligible users.`);
  for (const b of bonusReport) {
      console.log(`   - ${b.username} (${b.rank}): $${b.bonusAmount}`);
  }

  // 8. Test Automated Cron Job (Leadership Payouts)
  console.log("\n--- TESTING MONTHLY LEADERSHIP CRON JOB ---");
  
  // Wait a few seconds for the network to settle
  await new Promise(resolve => setTimeout(resolve, 3000));

  // The smart contract should have sent 5% of the $250 purchase ($12.5 USDC) to the Leadership Wallet
  const leadershipUSDCBalance = await usdtContract.balanceOf(LEADERSHIP);
  console.log(`Leadership Wallet USDC Balance: $${ethers.formatUnits(leadershipUSDCBalance, 6)}`);

  // We set the environment variable to our mock leadership wallet's private key
  process.env.LEADERSHIP_PRIVATE_KEY = leadershipWallet.privateKey;
  
  // Import the RewardsService dynamically to ensure env vars are picked up if needed, though statically imported is fine
  const { RewardsService } = await import('../services/rewards.service');
  const Payout = (await import('../models/Payout')).default;
  
  // Clear any old payouts
  await Payout.deleteMany({});
  
  const initOwnerUsdc = await usdtContract.balanceOf(ownerWallet.address);
  const initUplineUsdc = await usdtContract.balanceOf(uplineWallet.address);

  console.log(`⏳ Triggering Monthly Leadership Cron...`);
  await RewardsService.calculateMonthlyLeadershipPool();

  const finalOwnerUsdc = await usdtContract.balanceOf(ownerWallet.address);
  const finalUplineUsdc = await usdtContract.balanceOf(uplineWallet.address);
  const finalLeadershipUsdc = await usdtContract.balanceOf(LEADERSHIP);

  console.log(`✅ Cron Job Finished! Checking results...`);
  console.log(`Leadership Wallet Final Balance: $${ethers.formatUnits(finalLeadershipUsdc, 6)}`);
  console.log(`Owner received payout: +$${ethers.formatUnits(finalOwnerUsdc - initOwnerUsdc, 6)} USDC`);
  console.log(`Upline received payout: +$${ethers.formatUnits(finalUplineUsdc - initUplineUsdc, 6)} USDC`);

  const pendingPayouts = await Payout.find();
  console.log(`Database Payouts Generated: ${pendingPayouts.length}`);
  
  if (pendingPayouts.length > 0 && pendingPayouts[0].status === 'PAID') {
      console.log("🎉 SUCCESS: Cron job successfully read the blockchain, calculated shares, transferred USDC, and saved PAID receipts!");
  } else {
      console.log("⚠️ WARNING: Cron job failed to mark payouts as PAID or did not generate them.");
  }
  
  console.log("\n==========================================");
  console.log("✅ FULL COMMISSION FLOW TEST COMPLETE!");
  console.log("==========================================");
  process.exit(0);
}

runFullCommissionFlow().catch(console.error);
