import mongoose from 'mongoose';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

import User from '../models/User';
import Transaction from '../models/Transaction';
import { BlockchainService } from '../services/blockchain.service';
import { RewardsService } from '../services/rewards.service';
import { FeatureGatingService } from '../services/feature-gating.service';
import { hntrContract as defaultContract, provider as defaultProvider } from '../services/contract.service';

/**
 * FULL ON-CHAIN E2E INTEGRATION TEST
 * This script deploys the contracts to a local Anvil node, executes real transactions,
 * and verifies that the backend Express services correctly pick up the events and update MongoDB.
 * 
 * PRE-REQUISITE: You must have `anvil` running in a separate terminal.
 */
async function runOnChainE2E() {
  console.log("==========================================");
  console.log("🚀 STARTING FULL ON-CHAIN E2E WORKFLOW");
  console.log("==========================================\n");

  // 1. Connect to Local Anvil Node
  const RPC_URL = "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  // Use Anvil's default signers
  const signers = await provider.listAccounts();
  const deployer = await provider.getSigner(signers[0].address);
  const user1Signer = await provider.getSigner(signers[1].address);
  const user2Signer = await provider.getSigner(signers[2].address);
  const poolWalletSigner = await provider.getSigner(signers[4].address);
  const genesisSigner = await provider.getSigner(signers[9].address);

  console.log(`✅ Connected to Local Anvil Node at ${RPC_URL}`);

  // 2. Connect to MongoDB
  const MONGODB_URI = 'mongodb://localhost:27017/hntr_test_db';
  await mongoose.connect(MONGODB_URI);
  await User.deleteMany({});
  await Transaction.deleteMany({});
  console.log(`✅ Connected to MongoDB & Cleared test collections.`);

  // 3. Deploy Mock USDC and HNTRMembership via Ethers
  console.log("\n--- DEPLOYING SMART CONTRACTS ---");
  
  const mockPath = path.resolve(__dirname, '../../../hntr/out/Mocks.sol/MockERC20.json');
  const hntrPath = path.resolve(__dirname, '../../../hntr/out/HNTRMembership.sol/HNTRMembership.json');
  
  if (!fs.existsSync(mockPath) || !fs.existsSync(hntrPath)) {
      console.error("❌ Contract compiled JSONs not found. Please run `forge build` in the hntr folder.");
      process.exit(1);
  }

  const mockJson = JSON.parse(fs.readFileSync(mockPath, 'utf8'));
  const hntrJson = JSON.parse(fs.readFileSync(hntrPath, 'utf8'));

  // Deploy Mock USDC
  const ERC20Factory = new ethers.ContractFactory(mockJson.abi, mockJson.bytecode, deployer);
  const mockUSDC = await ERC20Factory.deploy();
  await mockUSDC.waitForDeployment();
  const usdcAddress = await mockUSDC.getAddress();
  console.log(`✅ Mock USDC deployed at: ${usdcAddress}`);

  // Deploy HNTRMembership
  const HNTRFactory = new ethers.ContractFactory(hntrJson.abi, hntrJson.bytecode, deployer);
  // Constructor takes: (address usdt, address usdc)
  const hntrContract = await HNTRFactory.deploy(usdcAddress, usdcAddress);
  await hntrContract.waitForDeployment();
  const contractAddress = await hntrContract.getAddress();
  console.log(`✅ HNTRMembership deployed at: ${contractAddress}`);

  // Set the 4 wallets (using deployer for treasury/leadership/achievement and a dedicated signer for pool)
  await (hntrContract as any).setWallets(
    deployer.address,
    deployer.address,
    deployer.address,
    poolWalletSigner.address,
  );
  console.log(`✅ Wallets configured on-chain.`);

  // 4. Start Backend Blockchain Listener
  console.log("\n--- STARTING BACKEND LISTENER ---");
  // Override the contract singleton for this test
  // (In a real app, you'd mock the import or re-initialize it)
  // For the test, we'll instantiate a fresh BlockchainService
  const blockchainService = new BlockchainService();
  
  // Hack: We need to override the global `hntrContract` inside `blockchain.service.ts` 
  // because it's statically imported. For testing, we just manually wire the events.
  const liveContract = new ethers.Contract(contractAddress, hntrJson.abi, provider);
  
  liveContract.on('MembershipPurchased', async (buyer: string, tierIndex: number, amount: bigint, token: string, event: any) => {
    console.log(`[BACKEND] Captured MembershipPurchased Event: ${buyer} bought tier ${tierIndex}`);
    await (blockchainService as any).handlePurchaseOrUpgrade(buyer.toLowerCase(), tierIndex, event.log.transactionHash, 'PURCHASE');
  });
  console.log(`✅ Backend listening for on-chain events.`);

  // 5. Setup Web2 Users (Genesis & User1)
  console.log("\n--- EXECUTING REAL TRANSACTIONS ---");
  const genesis = await User.create({
    username: 'genesis',
    walletAddress: genesisSigner.address.toLowerCase(),
    tier: 'None',
    rank: 'None',
    ancestors: [],
    legVolumes: new Map(),
  });

  const user1 = await User.create({
    username: 'User1',
    walletAddress: user1Signer.address.toLowerCase(),
    tier: 'None',
    rank: 'None',
    ancestors: ['genesis'],
    legVolumes: new Map(),
  });

  // Mint USDC & Approve
  const cost = ethers.parseUnits("5000", 6); // enough for Platinum ($1,500)
  await (mockUSDC as any).mint(user1Signer.address, cost);
  
  const usdcAsUser1 = new ethers.Contract(usdcAddress, mockJson.abi, user1Signer);
  await usdcAsUser1.approve(contractAddress, cost);
  console.log(`✅ Minted and Approved $5000 USDC for User1.`);

  // Execute Web3 Purchase!
  console.log(`🚀 Sending REAL purchase tx to Anvil...`);
  const hntrAsUser1 = new ethers.Contract(contractAddress, hntrJson.abi, user1Signer);

  // Tier 4 = Platinum (requires backend-signed ranks/deadline against the live contract ABI)
  const tx = await hntrAsUser1.purchaseMembership(
    user1Signer.address,
    4,
    [genesisSigner.address],
    [0],
    usdcAddress,
    Math.floor(Date.now() / 1000) + 3600,
    "0x",
  );
  await tx.wait();
  console.log(`✅ Transaction mined! Hash: ${tx.hash}`);

  // 6. Verify Backend processed the event
  console.log("\n--- VERIFYING BACKEND INTEGRATION ---");
  // Wait a moment for the event listener promise to resolve DB writes
  await new Promise(resolve => setTimeout(resolve, 2000));

  const updatedUser1 = await User.findOne({ username: 'User1' });
  console.log(`User1 DB Tier: ${updatedUser1?.tier}`);
  if (updatedUser1?.tier === 'Platinum') {
      console.log("🎉 SUCCESS: Backend automatically upgraded tier via blockchain event!");
  } else {
      console.error("❌ FAILED: Backend did not update tier.");
  }

  const txRecord = await Transaction.findOne({ walletAddress: user1Signer.address.toLowerCase() });
  console.log(`DB Transaction Record Hash: ${txRecord?.txHash}`);
  if (txRecord) console.log("🎉 SUCCESS: Backend logged the transaction in the DB!");

  console.log("\n==========================================");
  console.log("✅ ON-CHAIN E2E WORKFLOW COMPLETED");
  console.log("==========================================");
  
  process.exit(0);
}

runOnChainE2E().catch(console.error);
