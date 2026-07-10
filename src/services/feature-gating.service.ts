import { hntrContract } from './contract.service';

export class FeatureGatingService {
  /**
   * Helper to fetch the user's on-chain tier directly from the smart contract.
   * Tier 0 = NONE, 1 = SCOUT, 2 = TRACKER, 3 = RANGER, 4 = HUNTER, 5 = APEX
   */
  static async getOnChainTier(walletAddress: string): Promise<number> {
    try {
      const user = await hntrContract.getUser(walletAddress);
      // user.tier is the first element in the returned tuple if using standard getters
      // In ethers v6, tuples are returned as Result objects. user[0] is the tier.
      return Number(user[0]); 
    } catch (e) {
      console.error("Error fetching tier from contract", e);
      return 0;
    }
  }

  /**
   * Unlocks the Educational Hub (Available to all purchased tiers).
   */
  static async canAccessEducation(walletAddress: string): Promise<boolean> {
    const tier = await this.getOnChainTier(walletAddress);
    return tier >= 1; // Scout and above
  }

  /**
   * Unlocks the Tailor OTC Desk (Requires Hunter or Apex).
   */
  static async canAccessOTC(walletAddress: string): Promise<boolean> {
    const tier = await this.getOnChainTier(walletAddress);
    return tier >= 4; // Hunter and above
  }

  /**
   * Unlocks the NFT Lending Platform (Requires Hunter or Apex).
   */
  static async canAccessLending(walletAddress: string): Promise<boolean> {
    const tier = await this.getOnChainTier(walletAddress);
    return tier >= 4; // Hunter and above
  }
}
