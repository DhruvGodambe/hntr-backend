import User, { IUser } from '../models/User';
import { Tier, Rank } from '../constants';

export class UserService {
  
  static async registerUser(data: {
    username: string;
    walletAddress: string;
    email: string;
    phone: string;
    sponsorUsername?: string;
  }): Promise<IUser> {
    const { username, walletAddress, email, phone, sponsorUsername } = data;

    let ancestors: string[] = [];
    if (sponsorUsername) {
      const sponsor = await User.findOne({ username: sponsorUsername });
      if (!sponsor) {
        throw new Error('Sponsor not found');
      }
      ancestors = [...sponsor.ancestors, sponsorUsername];
      
      sponsor.directDownline.push(username);
      await sponsor.save();
    }

    const newUser = new User({
      username,
      walletAddress: walletAddress.toLowerCase(),
      type: 'member',
      email,
      phone,
      sponsorUsername,
      ancestors,
      directDownline: [],
      tier: Tier.NONE,
      rank: Rank.NONE,
      teamVolume: 0,
      legVolumes: {}
    });

    await newUser.save();
    return newUser;
  }

  static async getUserByUsername(username: string): Promise<IUser | null> {
    return User.findOne({ username });
  }

  static async getUserByWallet(walletAddress: string): Promise<IUser | null> {
    return User.findOne({ walletAddress: walletAddress.toLowerCase() });
  }

  static async syncUserTierWithBlockchain(user: IUser): Promise<IUser> {
    if (!user.walletAddress || user.type === 'admin') {
      return user;
    }
    try {
      const { hntrContract } = await import('./contract.service');
      const onChainData = await hntrContract.getUser(user.walletAddress);
      const tierIndex = Number(onChainData[0]);
      
      const tierLevels = [Tier.NONE, Tier.BRONZE, Tier.SILVER, Tier.GOLD, Tier.PLATINUM, Tier.DIAMOND];
      const onchainTier = tierLevels[tierIndex] || Tier.NONE;

      if (user.tier !== onchainTier) {
        user.tier = onchainTier as any;
        await user.save();
      }
    } catch (error) {
      console.error(`Failed to sync tier for ${user.walletAddress}:`, error);
    }
    return user;
  }
}
