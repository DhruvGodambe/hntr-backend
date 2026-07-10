import User, { IUser } from '../models/User';

export class NetworkService {
  /**
   * getUplines fetches the closest 12 parent wallet addresses.
   */
  static async getUplines(username: string): Promise<string[]> {
    const user = await User.findOne({ username });
    if (!user) {
      throw new Error('User not found');
    }

    // ancestors is ordered e.g. ["root", "sponsor1", "sponsor2"]
    // We want up to 12 immediate ancestors (the closest ones), which are at the end of the array.
    const ancestorsToFetch = user.ancestors.slice(-12).reverse();
    
    // We need to fetch the wallet addresses for these ancestors.
    const parentUsers = await User.find({ username: { $in: ancestorsToFetch } });
    
    // Map them in the correct order
    const uplineAddresses = ancestorsToFetch.map(u => {
        const found = parentUsers.find(p => p.username === u);
        return found ? found.walletAddress : '0x0000000000000000000000000000000000000000';
    });
    
    return uplineAddresses;
  }

  /**
   * getDownline instantly fetches the user's entire downline tree.
   */
  static async getDownline(username: string): Promise<IUser[]> {
    // Anyone who has this username in their ancestors array is in the downline.
    const downlines = await User.find({ ancestors: username });
    return downlines;
  }

  /**
   * calculateLegVolumes computes total sales volume under each direct leg.
   */
  static async calculateLegVolumes(username: string): Promise<Map<string, number>> {
    const user = await User.findOne({ username });
    if (!user) throw new Error('User not found');

    const legVolumes = new Map<string, number>();

    for (const direct of user.directDownline) {
        // Find everyone under this direct downline, plus the direct downline themselves.
        const downlinesOfDirect = await User.find({ ancestors: direct });
        const directUser = await User.findOne({ username: direct });
        
        let totalVolume = 0;
        if (directUser) totalVolume += this.getTierVolume(directUser.tier);
        
        for (const dl of downlinesOfDirect) {
            totalVolume += this.getTierVolume(dl.tier);
        }
        
        legVolumes.set(direct, totalVolume);
    }
    
    user.legVolumes = legVolumes;
    user.teamVolume = Array.from(legVolumes.values()).reduce((sum, current) => sum + current, 0);
    await user.save();
    
    return legVolumes;
  }

  /**
   * evaluateRank applies the 40/40/20 rule to determine rank upgrades.
   */
  static async evaluateRank(username: string): Promise<string> {
    const user = await User.findOne({ username });
    if (!user) throw new Error('User not found');

    // Make sure we have latest volumes
    const legVolumes = await this.calculateLegVolumes(username);
    const volumesArray = Array.from(legVolumes.values()).sort((a, b) => b - a);
    
    const totalVolume = user.teamVolume;
    
    // 40/40/20 Rule
    const ranks = [
        { name: 'Legend', volumeReq: 5000000 },
        { name: 'Master', volumeReq: 2500000 },
        { name: 'Elite', volumeReq: 1000000 },
        { name: 'Apex', volumeReq: 500000 },
        { name: 'Hunter', volumeReq: 100000 },
        { name: 'Ranger', volumeReq: 50000 },
        { name: 'Tracker', volumeReq: 10000 }
    ];

    let newRank = user.rank;
    
    for (const rank of ranks) {
        if (this.check404020(volumesArray, rank.volumeReq)) {
             newRank = rank.name as any;
             break; // Found the highest qualifying rank
        }
    }

    if (newRank !== user.rank) {
        user.rank = newRank as any;
        await user.save();
    }

    return newRank;
  }

  private static check404020(sortedVolumes: number[], reqVol: number): boolean {
    if (sortedVolumes.length === 0) return false;
    
    const maxLeg40 = reqVol * 0.40;
    const maxRest20 = reqVol * 0.20;
    
    let vol1 = sortedVolumes[0] || 0;
    let vol2 = sortedVolumes[1] || 0;
    
    let restVol = 0;
    for (let i = 2; i < sortedVolumes.length; i++) {
        restVol += sortedVolumes[i];
    }
    
    let effectiveVol = 0;
    effectiveVol += Math.min(vol1, maxLeg40);
    effectiveVol += Math.min(vol2, maxLeg40);
    effectiveVol += Math.min(restVol, maxRest20); // Correctly capped at 20%

    return effectiveVol >= reqVol;
  }
  
  private static getTierVolume(tier: string): number {
      switch(tier) {
          case 'Scout': return 100;
          case 'Tracker': return 500;
          case 'Ranger': return 1000;
          case 'Hunter': return 5000;
          case 'Apex': return 10000;
          default: return 0;
      }
  }
}
