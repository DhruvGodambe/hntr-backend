import { ethers } from 'ethers';
import User, { IUser } from '../models/User';
import AdminUserOverride from '../models/AdminUserOverride';
import Transaction from '../models/Transaction';
import { RANK_REQUIREMENTS, TIER_VOLUMES, Rank, getRankLadderIndex } from '../constants';
import { hntrContract, CONTRACT_ADDRESS, contractABI, getErc20, getContractAmountDecimals } from './contract.service';
import { getLogsViaEtherscan } from './etherscan.service';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

const RANK_ORDER: Rank[] = [
  Rank.NONE,
  Rank.SCOUT,
  Rank.TRACKER,
  Rank.RANGER,
  Rank.HUNTER,
  Rank.ELITE,
  Rank.MASTER,
  Rank.LEGEND,
];

const RANK_THRESHOLDS: Record<string, number> = RANK_REQUIREMENTS.reduce(
  (acc, { name, volumeReq }) => ({ ...acc, [name]: volumeReq }),
  { [Rank.NONE]: 0 } as Record<string, number>,
);

export interface RankProgress {
  percent: number;
  currentRank: Rank;
  nextRank: Rank | null;
  currentThreshold: number;
  nextThreshold: number | null;
}

export interface TokenBalance {
  symbol: 'USDT' | 'USDC';
  address: string;
  claimable: number;
  locked: number;
}

export interface LegProgress {
  label: string;
  volume: number;
  cap: number;
  percent: number;
}

export interface LegBreakdown {
  competitive: LegProgress[]; // largest two legs, each capped at 40% of the next rank's goal
  weakest: LegProgress; // every other leg combined, capped at 20% of the next rank's goal
}

export interface NetworkTreeNode {
  username: string;
  walletAddress: string;
  tier: string;
  rank: string;
  personalVolume: number;
  children: NetworkTreeNode[];
}

export interface RewardsSummary {
  walletAddress: string;
  username: string | null;
  rank: string;
  tier: string;
  joinedAt: Date | null;
  teamVolume: number;
  networkSize: number;
  progress: RankProgress;
  legs: LegBreakdown;
  claimableNow: number;
  lockedRemaining: number;
  totalRewarded: number;
  tokens: TokenBalance[];
}

export class NetworkService {
  /**
   * getUplines fetches the closest 12 parent wallet addresses.
   */
  static async getUplines(username: string): Promise<string[]> {
    const { uplines } = await this.getUplinesWithRanks(username);
    return uplines;
  }

  /**
   * Closest 12 parent wallets plus each parent's contract rank index
   * (NONE..HUNTER). Used to build the backend-signed commission auth payload.
   */
  static async getUplinesWithRanks(username: string): Promise<{ uplines: string[]; ranks: number[] }> {
    const user = await User.findOne({ username });
    if (!user) {
      throw new Error('User not found');
    }

    // ancestors is ordered e.g. ["root", "sponsor1", "sponsor2"]
    // We want up to 12 immediate ancestors (the closest ones), which are at the end of the array.
    const ancestorsToFetch = user.ancestors.slice(-12).reverse();

    const parentUsers = await User.find({ username: { $in: ancestorsToFetch } });

    const uplines: string[] = [];
    const ranks: number[] = [];

    for (const uname of ancestorsToFetch) {
      const found = parentUsers.find((p) => p.username === uname);
      const wallet = found?.walletAddress?.trim();
      if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
        break;
      }
      uplines.push(wallet);
      ranks.push(this.toContractRankIndex(found?.rank || Rank.NONE));
    }

    return { uplines, ranks };
  }

  /** Maps a backend rank name to the on-chain Rank enum index (0..4). */
  static toContractRankIndex(rankName: string): number {
    const idx = RANK_ORDER.indexOf(rankName as Rank);
    if (idx < 0) return 0;
    // Contract Rank enum only supports NONE..HUNTER (indices 0..4).
    return Math.min(idx, 4);
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
   * getNetworkTree builds a shallow (depth-limited) nested tree of a user's real
   * downline, for the "Topology Matrix Mapping" visualization on the network
   * page. Capped at maxDepth levels and maxNodes total nodes visited so a large
   * network can't trigger unbounded recursion/DB round-trips.
   */
  static async getNetworkTree(username: string, maxDepth = 3, maxNodes = 200): Promise<NetworkTreeNode | null> {
    let visited = 0;

    const build = async (uname: string, depth: number): Promise<NetworkTreeNode | null> => {
      const user = await User.findOne({ username: uname });
      if (!user) return null;
      visited += 1;

      const node: NetworkTreeNode = {
        username: user.username,
        walletAddress: user.walletAddress,
        tier: user.tier,
        rank: user.rank,
        personalVolume: this.getTierVolume(user.tier),
        children: [],
      };

      if (depth < maxDepth) {
        for (const childUsername of user.directDownline) {
          if (visited >= maxNodes) break;
          const child = await build(childUsername, depth + 1);
          if (child) node.children.push(child);
        }
      }

      return node;
    };

    return build(username, 0);
  }

  /**
   * calculateLegVolumes computes total sales volume under each direct leg.
   */
  static async calculateLegVolumes(username: string): Promise<Map<string, number>> {
    const user = await User.findOne({ username });
    if (!user) throw new Error('User not found');

    const legVolumes = new Map<string, number>();
    const directDownline = user.directDownline || [];

    logger.info(`Calculating leg volumes for ${username}: directDownline=[${directDownline.join(', ')}]`);

    for (const direct of directDownline) {
        // Find everyone under this direct downline, plus the direct downline themselves.
        const downlinesOfDirect = await User.find({ ancestors: direct });
        const directUser = await User.findOne({ username: direct });

        let totalVolume = 0;
        if (directUser) {
            totalVolume += this.getTierVolume(directUser.tier);
            logger.info(`  Leg ${direct}: direct user tier=${directUser.tier}, volume=${this.getTierVolume(directUser.tier)}`);
        } else {
            logger.warn(`  Leg ${direct}: direct user not found in database`);
        }

        for (const dl of downlinesOfDirect) {
            const dlVolume = this.getTierVolume(dl.tier);
            totalVolume += dlVolume;
            logger.info(`  Leg ${direct}: descendant ${dl.username} tier=${dl.tier}, volume=${dlVolume}`);
        }

        legVolumes.set(direct, totalVolume);
        logger.info(`  Leg ${direct}: total=${totalVolume}`);
    }

    user.legVolumes = legVolumes;
    user.teamVolume = Array.from(legVolumes.values()).reduce((sum, current) => sum + current, 0);
    await user.save();

    logger.info(`Saved ${username}: teamVolume=${user.teamVolume}, legs=${JSON.stringify(Object.fromEntries(legVolumes))}`);

    return legVolumes;
  }

  /**
   * evaluateRank applies the 40% per-leg cap rule to determine rank upgrades.
   * Forced-rank users keep their admin-assigned display rank until volume catches
   * up; achievement bonuses only enqueue for volume-qualified ranks.
   */
  static async evaluateRank(username: string): Promise<string> {
    const user = await User.findOne({ username });
    if (!user) throw new Error('User not found');

    // Make sure we have latest volumes
    const legVolumes = await this.calculateLegVolumes(username);
    const volumesArray = Array.from(legVolumes.values()).sort((a, b) => b - a);

    const userTierLevel = this.getTierLevel(user.tier);

    let volumeQualifiedRank: string = Rank.NONE;
    for (const rank of RANK_REQUIREMENTS) {
      if (this.checkLegCap40(volumesArray, rank.volumeReq)) {
        if (userTierLevel >= this.getRequiredTierLevelForRank(rank.name)) {
          volumeQualifiedRank = rank.name;
          break; // Highest qualifying rank (RANK_REQUIREMENTS is descending)
        }
      }
    }

    const previousDisplayRank = user.rank;
    let displayRank = volumeQualifiedRank as typeof user.rank;
    let clearedForcedRank = false;

    if (user.isForcedRank) {
      const forcedIdx = getRankLadderIndex(user.rank);
      const organicIdx = getRankLadderIndex(volumeQualifiedRank);
      if (organicIdx >= forcedIdx) {
        // Volume has caught up to (or passed) the forced rank — clear the force flag.
        user.isForcedRank = false;
        displayRank = volumeQualifiedRank as typeof user.rank;
        clearedForcedRank = true;
        try {
          await AdminUserOverride.findOneAndUpdate(
            { username: user.username.toLowerCase() },
            { $set: { rankOverride: null } },
          );
        } catch (err: any) {
          logger.error(`Failed to clear rankOverride for ${user.username}: ${err.message}`);
        }
      } else {
        // Keep the higher forced display rank; do not demote.
        displayRank = user.rank;
      }
    }

    const displayChanged = displayRank !== previousDisplayRank;
    if (displayChanged) {
      user.rank = displayRank;
    }

    if (displayChanged || clearedForcedRank) {
      await user.save();
    }

    if (displayChanged) {
      logger.info(
        `Rank updated off-chain for ${user.walletAddress}: ${previousDisplayRank} -> ${displayRank}` +
          (clearedForcedRank ? ' (forced rank cleared by volume)' : ''),
      );

      const { NotificationService } = await import('./notification.service');
      const { getLeadershipShares } = await import('../constants');
      const shares = getLeadershipShares(displayRank);

      await NotificationService.createQuiet({
        walletAddress: user.walletAddress,
        type: 'RANK_UP',
        title: `Rank upgraded to ${displayRank}`,
        sub:
          shares > 0
            ? `You now have ${shares} leadership share${shares === 1 ? '' : 's'} in the monthly pool.`
            : `Keep growing — Hunter rank and above unlock leadership pool shares.`,
        link: 'VIEW NETWORK',
        meta: { previousRank: previousDisplayRank, newRank: displayRank, shares },
      });
    }

    // Achievement bonuses follow volume qualification only (never the forced display jump).
    // Unique (wallet, rank) index skips ranks already queued/paid.
    if (volumeQualifiedRank !== Rank.NONE) {
      try {
        const { RewardsService } = await import('./rewards.service');
        await RewardsService.enqueueAchievementBonuses(user, Rank.NONE, volumeQualifiedRank);
      } catch (enqueueErr: any) {
        logger.error(
          `Failed to enqueue volume-qualified achievement bonuses for ${user.username}: ${enqueueErr.message}`,
        );
      }
    }

    // Rank stays off-chain; purchase/upgrade txs carry a company-wallet signature
    // over the current upline ranks so the contract can enforce commission gates.
    return user.rank;
  }

  /**
   * Recalculates leg volumes and team volume for a single user.
   * Also re-evaluates their rank so the stored state is fully consistent.
   */
  static async recalculateVolumes(username: string): Promise<{ username: string; teamVolume: number; rank: string }> {
    const rank = await this.evaluateRank(username);
    const user = await User.findOne({ username });
    return {
      username,
      teamVolume: user?.teamVolume ?? 0,
      rank,
    };
  }

  /**
   * Recalculates volumes and ranks for a user and every upline ancestor.
   * Use this after a downline purchase/upgrade to ensure the whole chain is
   * updated even if a previous listener tick failed part-way through.
   */
  static async recalculateUplineVolumes(username: string): Promise<{ username: string; teamVolume: number; rank: string }[]> {
    const user = await User.findOne({ username });
    if (!user) throw new Error('User not found');

    const targets = [username, ...user.ancestors];
    const results: { username: string; teamVolume: number; rank: string }[] = [];

    for (const target of targets) {
      try {
        results.push(await this.recalculateVolumes(target));
      } catch (err: any) {
        // Don't let one broken ancestor (e.g. a missing username in the chain)
        // stop the rest of the upline from being recalculated. Log and continue.
        logger.error(`Failed to recalculate volumes for ${target}: ${err.message}`);
      }
    }

    return results;
  }

  /** Global gate so overlapping volume reconcile crons cannot run two full passes at once. */
  private static reconcileAllVolumesInFlight: Promise<{ updated: number; failed: number }> | null = null;

  /**
   * Recalculates leg volumes + ranks for every user. Intended for cron backfill when
   * the blockchain listener misses a purchase/upgrade upline update.
   */
  static async recalculateAllVolumes(): Promise<{ updated: number; failed: number }> {
    if (this.reconcileAllVolumesInFlight) {
      logger.warn('Volume reconciliation already in progress; skipping overlapping run');
      return this.reconcileAllVolumesInFlight;
    }

    this.reconcileAllVolumesInFlight = (async () => {
      const usernames = await User.distinct('username');
      logger.info(`Recalculating leg volumes for ${usernames.length} users`);

      let updated = 0;
      let failed = 0;

      for (const username of usernames) {
        if (!username) continue;
        try {
          await this.recalculateVolumes(username);
          updated += 1;
        } catch (err: any) {
          failed += 1;
          logger.error(`Failed to recalculate volumes for ${username}: ${err.message}`);
        }
      }

      logger.info(`Volume reconciliation complete: updated=${updated}, failed=${failed}`);
      return { updated, failed };
    })();

    try {
      return await this.reconcileAllVolumesInFlight;
    } finally {
      this.reconcileAllVolumesInFlight = null;
    }
  }

  /**
   * Each leg may contribute at most 40% of the rank goal. Qualifying volume is the
   * sum of per-leg capped amounts (no separate 20% weak-leg bucket).
   */
  private static checkLegCap40(sortedVolumes: number[], reqVol: number): boolean {
    if (sortedVolumes.length === 0) return false;

    const maxPerLeg = reqVol * 0.4;
    let effectiveVol = 0;
    for (const vol of sortedVolumes) {
      effectiveVol += Math.min(vol, maxPerLeg);
    }

    return effectiveVol >= reqVol;
  }
  
  private static getTierVolume(tier: string): number {
      return TIER_VOLUMES[tier as keyof typeof TIER_VOLUMES] || 0;
  }

  private static getTierLevel(tier: string): number {
    const levels: Record<string, number> = {
      'None': 0, 'Bronze': 1, 'Silver': 2, 'Gold': 3, 'Platinum': 4, 'Diamond': 5
    };
    return levels[tier] || 0;
  }

  private static getRequiredTierLevelForRank(rankName: string): number {
    switch (rankName) {
      case 'Legend Hunter':
      case 'Master Hunter':
        return 5; // Diamond
      case 'Elite Hunter':
      case 'Hunter':
        return 4; // Platinum
      case 'Ranger': return 3; // Gold
      case 'Tracker': return 2; // Silver
      case 'Scout': return 1; // Bronze
      default: return 0;
    }
  }

  /** Computes how far a user's qualifying volume is towards their next rank threshold.
   * Uses the 40% per-leg cap so a single whale leg cannot carry the progress bar.
   */
  static getRankProgress(
    rank: string,
    teamVolume: number,
    legVolumes?: Map<string, number> | Record<string, number>,
  ): RankProgress {
    const currentRank = (rank as Rank) in RANK_THRESHOLDS ? (rank as Rank) : Rank.NONE;
    const idx = RANK_ORDER.indexOf(currentRank);
    const currentThreshold = RANK_THRESHOLDS[currentRank] ?? 0;
    const nextRank = idx >= 0 && idx < RANK_ORDER.length - 1 ? RANK_ORDER[idx + 1] : null;

    if (!nextRank) {
      return { percent: 100, currentRank, nextRank: null, currentThreshold, nextThreshold: null };
    }

    const nextThreshold = RANK_THRESHOLDS[nextRank];
    const qualifyingVolume = this.getQualifyingVolume(legVolumes, nextThreshold);
    const span = nextThreshold - currentThreshold;
    const percent = span > 0 ? Math.min(100, Math.max(0, ((qualifyingVolume - currentThreshold) / span) * 100)) : 100;

    return { percent: Math.round(percent), currentRank, nextRank, currentThreshold, nextThreshold };
  }

  private static getQualifyingVolume(
    legVolumes: Map<string, number> | Record<string, number> | undefined,
    goal: number,
  ): number {
    const entries = legVolumes instanceof Map ? Array.from(legVolumes.entries()) : Object.entries(legVolumes || {});
    const sortedVolumes = entries.map(([, volume]) => volume).sort((a, b) => b - a);

    const maxPerLeg = goal * 0.4;
    let effectiveVol = 0;
    for (const vol of sortedVolumes) {
      effectiveVol += Math.min(vol, maxPerLeg);
    }

    return effectiveVol;
  }

  /**
   * Applies the same 40% per-leg cap used by evaluateRank to the user's current
   * legVolumes against the goal for their next rank, for the network progress UI.
   */
  static getLegBreakdown(legVolumes: Map<string, number> | Record<string, number> | undefined, progress: RankProgress): LegBreakdown {
    const entries = legVolumes instanceof Map ? Array.from(legVolumes.entries()) : Object.entries(legVolumes || {});
    entries.sort((a, b) => b[1] - a[1]);

    const goal = progress.nextThreshold ?? progress.currentThreshold;
    const maxPerLeg = goal * 0.4;

    const toLegProgress = (label: string, volume: number, cap: number): LegProgress => ({
      label,
      volume,
      cap,
      percent: cap > 0 ? Math.min(100, Math.round((volume / cap) * 100)) : 0,
    });

    const [leg1, leg2, ...rest] = entries;
    const restVolume = rest.reduce((sum, [, volume]) => sum + volume, 0);
    const restCap = maxPerLeg * Math.max(rest.length, 1);
    const restLabel = rest.length === 0 ? 'No other legs yet' : rest.length === 1 ? rest[0][0] : `${rest.length} other legs`;

    return {
      competitive: [
        toLegProgress(leg1?.[0] || 'No leg yet', leg1?.[1] || 0, maxPerLeg),
        toLegProgress(leg2?.[0] || 'No leg yet', leg2?.[1] || 0, maxPerLeg),
      ],
      weakest: toLegProgress(restLabel, restVolume, restCap),
    };
  }

  /**
   * Applies any pending admin rank override onto the User document.
   * Membership tier is never overridden (on-chain purchase / upgrade only).
   * Does NOT enqueue achievement bonuses — forced ranks are display-only until
   * volume qualifies (see evaluateRank).
   */
  static async syncAdminOverrides(user: {
    username: string;
    walletAddress: string;
    rank: string;
    tier: string;
    isForcedRank?: boolean;
    save: () => Promise<unknown>;
  }): Promise<{ rank: string; tier: string }> {
    const override = await AdminUserOverride.findOne({
      username: user.username.toLowerCase(),
    }).lean();

    if (!override) {
      return { rank: user.rank || 'None', tier: user.tier || 'None' };
    }

    // Drop stale membership overrides — admin may no longer change tier.
    if (override.tierOverride) {
      await AdminUserOverride.updateOne(
        { username: user.username.toLowerCase() },
        { $set: { tierOverride: null } },
      );
    }

    const nextRank = override.rankOverride || user.rank || 'None';
    const previousRank = user.rank || 'None';
    let changed = false;

    if (override.rankOverride && override.rankOverride !== user.rank) {
      const prevIdx = getRankLadderIndex(user.rank);
      const nextIdx = getRankLadderIndex(override.rankOverride);
      // Only apply upward (or equal) rank forces — never a downgrade.
      if (nextIdx >= prevIdx) {
        (user as { rank: string }).rank = override.rankOverride;
        (user as { isForcedRank: boolean }).isForcedRank = true;
        changed = true;
      }
    }

    if (changed) {
      await user.save();
      logger.info(
        `Synced admin rank override onto ${user.username}: rank ${previousRank} -> ${nextRank} (membership unchanged: ${user.tier})`,
      );
    }

    return { rank: (user.rank as string) || 'None', tier: user.tier || 'None' };
  }

  /**
   * Combines on-chain commission state (source of truth for money) with the
   * off-chain profile/rank (source of truth for the MLM tree) into the single
   * payload the network page and dashboard right rail both need.
   */
  static async getRewardsSummary(walletAddress: string): Promise<RewardsSummary> {
    const address = walletAddress.toLowerCase();
    const user = await User.findOne({ walletAddress: address });

    const [onChainUser, usdtAddress, usdcAddress] = await Promise.all([
      hntrContract.getUser(address),
      hntrContract.usdt(),
      hntrContract.usdc(),
    ]);

    const tierIndex = Number(onChainUser[0]);
    const tierNames = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

    let claimableNow = 0;
    let lockedRemaining = 0;
    const tokens: TokenBalance[] = [];
    const amountDecimals = await getContractAmountDecimals();

    for (const [symbol, tokenAddress] of [['USDT', usdtAddress], ['USDC', usdcAddress]] as const) {
      const [withdrawable, locked] = await Promise.all([
        hntrContract.withdrawableCommissions(address, tokenAddress),
        hntrContract.lockedCommissions(address, tokenAddress),
      ]);
      const claimable = Number(ethers.formatUnits(withdrawable, amountDecimals));
      const lockedAmount = Number(ethers.formatUnits(locked, amountDecimals));
      claimableNow += claimable;
      lockedRemaining += lockedAmount;
      tokens.push({ symbol, address: tokenAddress, claimable, locked: lockedAmount });
      logger.info(
        `Contract balance for ${address} ${symbol}: withdrawable=${claimable}, locked=${lockedAmount}, amountDecimals=${amountDecimals}`
      );
    }

    const totalRewarded = await this.getLifetimeCommissionsEarned(address, [usdtAddress, usdcAddress], amountDecimals);

    const synced = user
      ? await this.syncAdminOverrides(user)
      : { rank: 'None', tier: 'None' };
    const rank = synced.rank;

    // Membership is always the on-chain tier (admin cannot override it).
    // Keep Mongo User.tier aligned so admin list matches the user dashboard.
    const onChainTier = tierNames[tierIndex] || 'None';
    if (user && user.tier !== onChainTier) {
      try {
        user.tier = onChainTier as typeof user.tier;
        await user.save();
        logger.info(
          `Repaired ${user.username} membership Mongo ${synced.tier} → on-chain ${onChainTier}`,
        );
      } catch (err: unknown) {
        logger.warn(
          `Failed membership repair for ${address}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const teamVolume = user?.teamVolume || 0;
    const progress = this.getRankProgress(rank, teamVolume, user?.legVolumes);

    logger.info(
      `Rewards summary for ${address}: rank=${rank}, teamVolume=${teamVolume}, qualifyingProgress=${progress.percent}%, claimableNow=${claimableNow}, lockedRemaining=${lockedRemaining}, totalRewarded=${totalRewarded}`
    );

    return {
      walletAddress: address,
      username: user?.username || null,
      rank,
      tier: onChainTier,
      joinedAt: user?.joinedAt || null,
      teamVolume,
      networkSize: user ? await User.countDocuments({ ancestors: user.username }) : 0,
      progress,
      legs: this.getLegBreakdown(user?.legVolumes, progress),
      claimableNow: Number(claimableNow.toFixed(2)),
      lockedRemaining: Number(lockedRemaining.toFixed(2)),
      totalRewarded: Number(totalRewarded.toFixed(2)),
      tokens,
    };
  }

  /**
   * Lifetime commissions earned (liquid + locked), whether later withdrawn or not.
   *
   * Prefer Mongo COMMISSION_EARNED rows — those survive membership contract redeploys
   * and bootstrap (seedCommissions does not emit CommissionEarned). Also include any
   * current-contract chain events not yet written by the listener to avoid a brief
   * undercount after a new earn.
   */
  private static async getLifetimeCommissionsEarned(address: string, _tokenAddresses: string[], amountDecimals: number): Promise<number> {
    const normalized = address.toLowerCase();

    try {
      const [agg] = await Transaction.aggregate<{ total: number }>([
        {
          $match: {
            walletAddress: normalized,
            type: 'COMMISSION_EARNED',
            status: 'CONFIRMED',
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      let total = Number(agg?.total || 0);

      // Supplement with current-contract logs not yet mirrored into Mongo.
      try {
        const iface = new ethers.Interface(contractABI);
        const topic = ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)');
        const paddedAddress = ethers.zeroPadValue(normalized, 32);
        const logs = await getLogsViaEtherscan({
          address: CONTRACT_ADDRESS,
          topics: [topic, paddedAddress],
          fromBlock: ENV.CONTRACT_DEPLOY_BLOCK,
        });

        if (logs.length > 0) {
          const existing = await Transaction.find({
            walletAddress: normalized,
            type: 'COMMISSION_EARNED',
            status: 'CONFIRMED',
            txHash: { $in: logs.map((l) => String(l.transactionHash || '').toLowerCase()) },
          })
            .select('txHash token level')
            .lean();

          const seen = new Set(
            existing.map(
              (row) =>
                `${String(row.txHash || '').toLowerCase()}:${String(row.token || '').toLowerCase()}:${Number(row.level)}`,
            ),
          );

          for (const log of logs) {
            const parsed = iface.parseLog({ topics: log.topics, data: log.data });
            if (!parsed) continue;
            const [, liquidAmount, lockedAmount, level, token] = parsed.args;
            const key = `${String(log.transactionHash || '').toLowerCase()}:${String(token).toLowerCase()}:${Number(level)}`;
            if (seen.has(key)) continue;

            total += Number(
              ethers.formatUnits(BigInt(liquidAmount) + BigInt(lockedAmount), amountDecimals),
            );
          }
        }
      } catch (chainErr: any) {
        logger.warn(
          `Lifetime commissions chain supplement failed for ${normalized}: ${chainErr?.message || chainErr}`,
        );
      }

      return total;
    } catch (err: any) {
      logger.warn(`Lifetime commissions lookup failed for ${normalized}: ${err?.message || err}`);
      return 0;
    }
  }
}
