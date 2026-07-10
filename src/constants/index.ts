export enum Tier {
  NONE = 'None',
  SCOUT = 'Scout',
  TRACKER = 'Tracker',
  RANGER = 'Ranger',
  HUNTER = 'Hunter',
  APEX = 'Apex',
}

export enum Rank {
  NONE = 'None',
  TRACKER = 'Tracker',
  RANGER = 'Ranger',
  HUNTER = 'Hunter',
  APEX = 'Apex',
  ELITE = 'Elite',
  MASTER = 'Master',
  LEGEND = 'Legend',
}

export const TIER_VOLUMES: Record<Tier, number> = {
  [Tier.NONE]: 0,
  [Tier.SCOUT]: 100,
  [Tier.TRACKER]: 500,
  [Tier.RANGER]: 1000,
  [Tier.HUNTER]: 5000,
  [Tier.APEX]: 10000,
};

export const RANK_REQUIREMENTS = [
  { name: Rank.LEGEND, volumeReq: 5000000 },
  { name: Rank.MASTER, volumeReq: 2500000 },
  { name: Rank.ELITE, volumeReq: 1000000 },
  { name: Rank.APEX, volumeReq: 500000 },
  { name: Rank.HUNTER, volumeReq: 100000 },
  { name: Rank.RANGER, volumeReq: 50000 },
  { name: Rank.TRACKER, volumeReq: 10000 },
];

export const CONTRACT_EVENTS = {
  MEMBERSHIP_PURCHASED: 'MembershipPurchased',
  MEMBERSHIP_UPGRADED: 'MembershipUpgraded',
};
