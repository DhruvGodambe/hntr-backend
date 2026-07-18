export enum Tier {
  NONE = 'None',
  BRONZE = 'Bronze',
  SILVER = 'Silver',
  GOLD = 'Gold',
  PLATINUM = 'Platinum',
  DIAMOND = 'Diamond',
}

export enum Rank {
  NONE = 'None',
  SCOUT = 'Scout',
  TRACKER = 'Tracker',
  RANGER = 'Ranger',
  HUNTER = 'Hunter',
  ELITE = 'Elite Hunter',
  MASTER = 'Master Hunter',
  LEGEND = 'Legend Hunter',
}

export const TIER_VOLUMES: Record<Tier, number> = {
  [Tier.NONE]: 0,
  [Tier.BRONZE]: 50,
  [Tier.SILVER]: 250,
  [Tier.GOLD]: 750,
  [Tier.PLATINUM]: 1500,
  [Tier.DIAMOND]: 2500,
};

export const RANK_REQUIREMENTS = [
  { name: Rank.LEGEND, volumeReq: 25000000 },
  { name: Rank.MASTER, volumeReq: 5000000 },
  { name: Rank.ELITE, volumeReq: 1000000 },
  { name: Rank.HUNTER, volumeReq: 250000 },
  { name: Rank.RANGER, volumeReq: 50000 },
  { name: Rank.TRACKER, volumeReq: 10000 },
  { name: Rank.SCOUT, volumeReq: 1000 },
];

/**
 * Unilevel commission gates — must stay in lockstep with
 * HNTRMembership.sol `levelPercentages` / `tierRequiredForLevel` / `rankRequiredForLevel`.
 * Levels 1–3 need any membership + Default rank; deeper levels need both the listed tier and rank.
 */
export const COMMISSION_LEVELS = [
  { level: 1, percent: 15, requiredMembership: 'Any', requiredRank: Rank.NONE, rankVolume: 0 },
  { level: 2, percent: 15, requiredMembership: 'Any', requiredRank: Rank.NONE, rankVolume: 0 },
  { level: 3, percent: 8, requiredMembership: 'Any', requiredRank: Rank.NONE, rankVolume: 0 },
  { level: 4, percent: 5, requiredMembership: Tier.BRONZE, requiredRank: Rank.SCOUT, rankVolume: 1000 },
  { level: 5, percent: 4, requiredMembership: Tier.SILVER, requiredRank: Rank.TRACKER, rankVolume: 10000 },
  { level: 6, percent: 4, requiredMembership: Tier.SILVER, requiredRank: Rank.TRACKER, rankVolume: 10000 },
  { level: 7, percent: 4, requiredMembership: Tier.GOLD, requiredRank: Rank.RANGER, rankVolume: 50000 },
  { level: 8, percent: 2, requiredMembership: Tier.GOLD, requiredRank: Rank.RANGER, rankVolume: 50000 },
  { level: 9, percent: 2, requiredMembership: Tier.GOLD, requiredRank: Rank.RANGER, rankVolume: 50000 },
  { level: 10, percent: 2, requiredMembership: Tier.GOLD, requiredRank: Rank.RANGER, rankVolume: 50000 },
  { level: 11, percent: 2, requiredMembership: Tier.PLATINUM, requiredRank: Rank.HUNTER, rankVolume: 250000 },
  { level: 12, percent: 2, requiredMembership: Tier.PLATINUM, requiredRank: Rank.HUNTER, rankVolume: 250000 },
] as const;

export const CONTRACT_EVENTS = {
  MEMBERSHIP_PURCHASED: 'MembershipPurchased',
  MEMBERSHIP_UPGRADED: 'MembershipUpgraded',
};

/**
 * Monthly leadership pool share weights. Only Hunter+ ranks receive shares;
 * Scout / Tracker / Ranger / None get 0. Pool is split pro-rata by shares.
 * Must stay in lockstep with RewardsService.calculateMonthlyLeadershipPool.
 */
export const LEADERSHIP_SHARES: Record<string, number> = {
  [Rank.NONE]: 0,
  [Rank.SCOUT]: 0,
  [Rank.TRACKER]: 0,
  [Rank.RANGER]: 0,
  [Rank.HUNTER]: 1,
  [Rank.ELITE]: 3,
  [Rank.MASTER]: 7,
  [Rank.LEGEND]: 15,
};

export const LEADERSHIP_ELIGIBLE_RANKS = [
  Rank.HUNTER,
  Rank.ELITE,
  Rank.MASTER,
  Rank.LEGEND,
] as const;

export function getLeadershipShares(rank: string | null | undefined): number {
  if (!rank) return 0;
  return LEADERSHIP_SHARES[rank] ?? 0;
}

/**
 * One-time rank achievement bonuses (PDF §5). Paid from achievementWallet
 * when it holds enough USDT/USDC. Must stay in lockstep with RewardsService.
 */
export const RANK_ACHIEVEMENT_BONUSES: Record<string, number> = {
  [Rank.SCOUT]: 25,
  [Rank.TRACKER]: 150,
  [Rank.RANGER]: 750,
  [Rank.HUNTER]: 5000,
  [Rank.ELITE]: 25000,
  [Rank.MASTER]: 100000,
  [Rank.LEGEND]: 500000,
};

/** Ascending ladder used to detect newly crossed ranks on upgrade. */
export const RANK_LADDER: Rank[] = [
  Rank.SCOUT,
  Rank.TRACKER,
  Rank.RANGER,
  Rank.HUNTER,
  Rank.ELITE,
  Rank.MASTER,
  Rank.LEGEND,
];

export function getAchievementBonusAmount(rank: string | null | undefined): number {
  if (!rank) return 0;
  return RANK_ACHIEVEMENT_BONUSES[rank] ?? 0;
}

/**
 * Ranks newly crossed when moving from previousRank → newRank (exclusive of previous).
 * E.g. None → Ranger yields [Scout, Tracker, Ranger].
 */
export function ranksNewlyAchieved(
  previousRank: string | null | undefined,
  newRank: string | null | undefined,
): Rank[] {
  if (!newRank || newRank === Rank.NONE) return [];
  const nextIdx = RANK_LADDER.indexOf(newRank as Rank);
  if (nextIdx < 0) return [];

  const prevIdx =
    !previousRank || previousRank === Rank.NONE
      ? -1
      : RANK_LADDER.indexOf(previousRank as Rank);

  if (nextIdx <= prevIdx) return [];
  return RANK_LADDER.slice(prevIdx + 1, nextIdx + 1);
}
