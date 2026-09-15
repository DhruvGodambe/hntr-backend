import User from '../models/User';
import Transaction from '../models/Transaction';

export type PublicActivityKind = 'join' | 'purchase';

export interface PublicActivityEntry {
  id: string;
  kind: PublicActivityKind;
  username: string;
  country?: string;
  action: string;
  tier?: string;
  ts: number;
}

const PURCHASE_TX_TYPES = ['PURCHASE', 'UPGRADE', 'VOUCHER_MEMBERSHIP_REDEEM'] as const;

export class ActivityFeedService {
  /** Public, unauthenticated feed of recent signups and membership purchases. */
  static async getPublicFeed(limit = 20): Promise<PublicActivityEntry[]> {
    const fetchLimit = Math.min(Math.max(limit, 1), 50);

    const [recentUsers, recentTx] = await Promise.all([
      User.find({ type: 'member' })
        .select('username country joinedAt')
        .sort({ joinedAt: -1 })
        .limit(fetchLimit)
        .lean(),
      Transaction.find({ type: { $in: PURCHASE_TX_TYPES }, status: 'CONFIRMED' })
        .select('walletAddress type tier timestamp')
        .sort({ timestamp: -1 })
        .limit(fetchLimit)
        .lean(),
    ]);

    const wallets = [...new Set(recentTx.map((tx) => tx.walletAddress.toLowerCase()))];
    const buyers = wallets.length
      ? await User.find({ walletAddress: { $in: wallets } })
          .select('walletAddress username country')
          .lean()
      : [];
    const buyerByWallet = new Map(buyers.map((u) => [u.walletAddress.toLowerCase(), u]));

    const joinEntries: PublicActivityEntry[] = recentUsers.map((user) => ({
      id: `join-${String(user._id)}`,
      kind: 'join',
      username: user.username,
      country: user.country,
      action: 'JOINED',
      ts: new Date(user.joinedAt).getTime(),
    }));

    const purchaseEntries: PublicActivityEntry[] = recentTx.map((tx) => {
      const buyer = buyerByWallet.get(tx.walletAddress.toLowerCase());
      const action =
        tx.type === 'UPGRADE' ? 'UPGRADED' : tx.type === 'VOUCHER_MEMBERSHIP_REDEEM' ? 'REDEEMED' : 'PURCHASED';
      return {
        id: `tx-${String(tx._id)}`,
        kind: 'purchase',
        username: buyer?.username || `${tx.walletAddress.slice(0, 6)}...`,
        country: buyer?.country,
        action,
        tier: tx.tier,
        ts: new Date(tx.timestamp).getTime(),
      };
    });

    return [...joinEntries, ...purchaseEntries].sort((a, b) => b.ts - a.ts).slice(0, fetchLimit);
  }
}
