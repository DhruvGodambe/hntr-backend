import { ethers } from 'ethers';
import User, { IUser } from '../models/User';
import { RANK_REQUIREMENTS, TIER_VOLUMES, Rank } from '../constants';
import { hntrContract, CONTRACT_ADDRESS, contractABI, getErc20 } from './contract.service';
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
   * evaluateRank applies the 40/40/20 rule to determine rank upgrades.
   */
  static async evaluateRank(username: string): Promise<string> {
    const user = await User.findOne({ username });
    if (!user) throw new Error('User not found');

    // Make sure we have latest volumes
    const legVolumes = await this.calculateLegVolumes(username);
    const volumesArray = Array.from(legVolumes.values()).sort((a, b) => b - a);
    
    const totalVolume = user.teamVolume;
    const userTierLevel = this.getTierLevel(user.tier);
    
    let newRank = user.rank;
    
    for (const rank of RANK_REQUIREMENTS) {
        if (this.check404020(volumesArray, rank.volumeReq)) {
             if (userTierLevel >= this.getRequiredTierLevelForRank(rank.name)) {
                 newRank = rank.name as any;
                 break; // Found the highest qualifying rank
             }
        }
    }

    if (newRank !== user.rank) {
        user.rank = newRank as any;
        await user.save();
    }

    return newRank;
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
      return TIER_VOLUMES[tier as keyof typeof TIER_VOLUMES] || 0;
  }

  private static getTierLevel(tier: string): number {
    const levels = {
      'None': 0, 'Scout': 1, 'Tracker': 2, 'Ranger': 3, 'Hunter': 4, 'Apex': 5
    };
    return (levels as any)[tier] || 0;
  }

  private static getRequiredTierLevelForRank(rankName: string): number {
    switch (rankName) {
      case 'Legend Hunter':
      case 'Master Hunter':
        return 5; // Apex
      case 'Elite Hunter':
      case 'Hunter':
        return 4; // Hunter
      case 'Ranger': return 3; // Ranger
      case 'Tracker': return 2; // Tracker
      case 'Scout': return 1; // Scout
      default: return 0;
    }
  }

  /** Computes how far a user's teamVolume is towards their next rank threshold. */
  static getRankProgress(rank: string, teamVolume: number): RankProgress {
    const currentRank = (rank as Rank) in RANK_THRESHOLDS ? (rank as Rank) : Rank.NONE;
    const idx = RANK_ORDER.indexOf(currentRank);
    const currentThreshold = RANK_THRESHOLDS[currentRank] ?? 0;
    const nextRank = idx >= 0 && idx < RANK_ORDER.length - 1 ? RANK_ORDER[idx + 1] : null;

    if (!nextRank) {
      return { percent: 100, currentRank, nextRank: null, currentThreshold, nextThreshold: null };
    }

    const nextThreshold = RANK_THRESHOLDS[nextRank];
    const span = nextThreshold - currentThreshold;
    const percent = span > 0 ? Math.min(100, Math.max(0, ((teamVolume - currentThreshold) / span) * 100)) : 100;

    return { percent: Math.round(percent), currentRank, nextRank, currentThreshold, nextThreshold };
  }

  /**
   * Applies the same 40/40/20 rule used by evaluateRank/check404020 to the user's
   * *current* legVolumes against the goal for their *next* rank, so the frontend
   * can show real "how close am I" leg-by-leg progress instead of static numbers.
   */
  static getLegBreakdown(legVolumes: Map<string, number> | Record<string, number> | undefined, progress: RankProgress): LegBreakdown {
    const entries = legVolumes instanceof Map ? Array.from(legVolumes.entries()) : Object.entries(legVolumes || {});
    entries.sort((a, b) => b[1] - a[1]);

    const goal = progress.nextThreshold ?? progress.currentThreshold;
    const maxLeg40 = goal * 0.4;
    const maxRest20 = goal * 0.2;

    const toLegProgress = (label: string, volume: number, cap: number): LegProgress => ({
      label,
      volume,
      cap,
      percent: cap > 0 ? Math.min(100, Math.round((volume / cap) * 100)) : 0,
    });

    const [leg1, leg2, ...rest] = entries;
    const restVolume = rest.reduce((sum, [, volume]) => sum + volume, 0);
    const restLabel = rest.length === 0 ? 'No other legs yet' : rest.length === 1 ? rest[0][0] : `${rest.length} other legs`;

    return {
      competitive: [
        toLegProgress(leg1?.[0] || 'No leg yet', leg1?.[1] || 0, maxLeg40),
        toLegProgress(leg2?.[0] || 'No leg yet', leg2?.[1] || 0, maxLeg40),
      ],
      weakest: toLegProgress(restLabel, restVolume, maxRest20),
    };
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
    const tierNames = ['None', 'Scout', 'Tracker', 'Ranger', 'Hunter', 'Apex'];

    let claimableNow = 0;
    let lockedRemaining = 0;
    const tokens: TokenBalance[] = [];

    for (const [symbol, tokenAddress] of [['USDT', usdtAddress], ['USDC', usdcAddress]] as const) {
      const erc20 = getErc20(tokenAddress);
      const [withdrawable, locked, decimals] = await Promise.all([
        hntrContract.withdrawableCommissions(address, tokenAddress),
        hntrContract.lockedCommissions(address, tokenAddress),
        erc20.decimals().catch(() => 6),
      ]);
      const claimable = Number(ethers.formatUnits(withdrawable, decimals));
      const lockedAmount = Number(ethers.formatUnits(locked, decimals));
      claimableNow += claimable;
      lockedRemaining += lockedAmount;
      tokens.push({ symbol, address: tokenAddress, claimable, locked: lockedAmount });
    }

    const totalRewarded = await this.getLifetimeCommissionsEarned(address, [usdtAddress, usdcAddress]);

    const rank = user?.rank || 'None';
    const teamVolume = user?.teamVolume || 0;
    const progress = this.getRankProgress(rank, teamVolume);

    return {
      walletAddress: address,
      username: user?.username || null,
      rank,
      tier: tierNames[tierIndex] || 'None',
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
   * Sums every historical CommissionEarned log for this wallet directly from the
   * chain (liquid + locked), independent of whether it has since been withdrawn.
   * Fetched via Etherscan (see etherscan.service.ts) from the contract's deploy
   * block onward, rather than raw `eth_getLogs`, so this is a true lifetime total
   * instead of being limited to whatever recent window the public RPC allows.
   */
  private static async getLifetimeCommissionsEarned(address: string, tokenAddresses: string[]): Promise<number> {
    try {
      const iface = new ethers.Interface(contractABI);
      const topic = ethers.id('CommissionEarned(address,uint256,uint256,uint8,address)');
      const paddedAddress = ethers.zeroPadValue(address, 32);

      const logs = await getLogsViaEtherscan({
        address: CONTRACT_ADDRESS,
        topics: [topic, paddedAddress],
        fromBlock: ENV.CONTRACT_DEPLOY_BLOCK,
      });

      const decimalsByToken = new Map<string, number>();
      for (const tokenAddress of tokenAddresses) {
        try {
          decimalsByToken.set(tokenAddress.toLowerCase(), Number(await getErc20(tokenAddress).decimals()));
        } catch {
          decimalsByToken.set(tokenAddress.toLowerCase(), 6);
        }
      }

      let total = 0;
      for (const log of logs) {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (!parsed) continue;
        const [, liquidAmount, lockedAmount, , token] = parsed.args;
        const decimals = decimalsByToken.get(String(token).toLowerCase()) ?? 6;
        total += Number(ethers.formatUnits(BigInt(liquidAmount) + BigInt(lockedAmount), decimals));
      }
      return total;
    } catch {
      return 0;
    }
  }
}
