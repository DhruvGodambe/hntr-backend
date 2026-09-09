import User, { IUser } from '../models/User';
import { Tier, Rank } from '../constants';
import { sanitizeSearch } from '../utils/pagination';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

    // A username registered once must never be re-created — a second registerUser
    // for the same name would push it into a sponsor's directDownline before the
    // unique-index E11000 on save, corrupting the tree.
    const alreadyRegistered = await User.findOne({ username });
    if (alreadyRegistered) {
      throw new UserError('USERNAME_TAKEN', 'That username is already registered.', 409);
    }

    let ancestors: string[] = [];
    if (sponsorUsername) {
      if (sponsorUsername.trim().toLowerCase() === username.trim().toLowerCase()) {
        throw new UserError('SELF_SPONSOR', 'You cannot use your own username as your sponsor.', 400);
      }
      const sponsor = await this.assertSponsorEligible(sponsorUsername);
      if (sponsor.username === username) {
        throw new UserError('SELF_SPONSOR', 'You cannot sponsor yourself.', 400);
      }
      ancestors = [...sponsor.ancestors, sponsor.username];

      // $addToSet: never duplicate, and the self-check above keeps `username` out.
      await User.updateOne({ _id: sponsor._id }, { $addToSet: { directDownline: username } });
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
    const normalized = username.trim().replace(/^@/, '');
    if (!normalized) return null;
    // Prefer exact match, then case-insensitive (usernames are stored as registered).
    return (
      (await User.findOne({ username: normalized })) ||
      (await User.findOne({ username: new RegExp(`^${escapeRegex(normalized)}$`, 'i') }))
    );
  }

  /**
   * Lightweight username typeahead for authenticated members (e.g. gift-code share).
   * Returns only public display fields — never email/phone/wallet.
   */
  static async searchUsernames(
    q: string,
    opts: { limit?: number; excludeWallet?: string } = {},
  ): Promise<{ username: string; tier: string }[]> {
    const safe = sanitizeSearch(q.replace(/^@/, ''), 32);
    if (safe.length < 1) return [];

    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
    const filter: Record<string, unknown> = {
      type: { $ne: 'admin' },
      walletAddress: { $exists: true, $nin: [null, ''] },
      username: { $regex: safe, $options: 'i' },
    };
    if (opts.excludeWallet) {
      filter.walletAddress = {
        $exists: true,
        $nin: [null, '', opts.excludeWallet.toLowerCase()],
      };
    }

    const rows = await User.find(filter)
      .select({ username: 1, tier: 1, _id: 0 })
      .sort({ username: 1 })
      .limit(limit)
      .lean();

    return rows.map((r) => ({ username: r.username, tier: r.tier || 'None' }));
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
