import { Wallet } from 'ethers';

/**
 * Generates three random Ethereum wallets to be used for the protocol.
 * - Treasury Wallet
 * - Leadership Wallet
 * - Achievement Wallet
 * 
 * Make sure to securely store the private keys outputted by this function!
 */
export function generateProtocolWallets() {
  const treasuryWallet = Wallet.createRandom();
  const leadershipWallet = Wallet.createRandom();
  const achievementWallet = Wallet.createRandom();

  const wallets = {
    treasury: {
      address: treasuryWallet.address,
      privateKey: treasuryWallet.privateKey,
    },
    leadership: {
      address: leadershipWallet.address,
      privateKey: leadershipWallet.privateKey,
    },
    achievement: {
      address: achievementWallet.address,
      privateKey: achievementWallet.privateKey,
    }
  };

  console.log("==========================================");
  console.log("🏦 PROTOCOL WALLETS GENERATED 🏦");
  console.log("==========================================");
  
  console.log("\n1. TREASURY WALLET");
  console.log(`Address:     ${wallets.treasury.address}`);
  console.log(`Private Key: ${wallets.treasury.privateKey}`);
  
  console.log("\n2. LEADERSHIP WALLET");
  console.log(`Address:     ${wallets.leadership.address}`);
  console.log(`Private Key: ${wallets.leadership.privateKey}`);
  
  console.log("\n3. ACHIEVEMENT WALLET");
  console.log(`Address:     ${wallets.achievement.address}`);
  console.log(`Private Key: ${wallets.achievement.privateKey}`);
  console.log("\n==========================================");
  console.log("⚠️  IMPORTANT: Save these private keys securely!");
  console.log("You will need the Addresses to set them in the smart contract.");

  return wallets;
}

// If this file is run directly, execute the function
if (require.main === module) {
    generateProtocolWallets();
}
