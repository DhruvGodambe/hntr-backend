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
