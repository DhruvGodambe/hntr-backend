import User, { IUser } from '../models/User';
import { Tier, Rank } from '../constants';

export class UserError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class UserService {
  static isRootAdminUser(user: IUser): boolean {
    return user.type === 'admin' || user.username.toLowerCase() === 'admin';
  }

  static async assertSponsorEligible(sponsorUsername: string): Promise<IUser> {
    const normalized = sponsorUsername.trim();
    if (!normalized) {
      throw new UserError('SPONSOR_REQUIRED', 'Sponsor username is required.', 400);
    }

    const sponsor =
      normalized.toLowerCase() === 'admin'
        ? await User.findOne({ $or: [{ username: 'admin' }, { type: 'admin' }] })
        : await User.findOne({ username: normalized });
    if (!sponsor) {
      throw new UserError('SPONSOR_NOT_FOUND', 'Sponsor not found', 404);
    }

    const syncedSponsor = await this.syncUserTierWithBlockchain(sponsor);

    if (
      !this.isRootAdminUser(syncedSponsor) &&
      (!syncedSponsor.tier || syncedSponsor.tier === Tier.NONE)
    ) {
      throw new UserError(
        'SPONSOR_NO_MEMBERSHIP',
        'This sponsor does not have an active membership plan. Ask your referrer to purchase a membership first.',
        400,
      );
    }

    return syncedSponsor;
  }

  static async validateSponsor(sponsorUsername: string): Promise<{ username: string; tier: string }> {
    const sponsor = await this.assertSponsorEligible(sponsorUsername);
    return { username: sponsor.username, tier: sponsor.tier };
  }

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
      const sponsor = await this.assertSponsorEligible(sponsorUsername);
      ancestors = [...sponsor.ancestors, sponsor.username];

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
      legVolumes: {},
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
