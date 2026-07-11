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
  [Tier.SCOUT]: 50,
  [Tier.TRACKER]: 250,
  [Tier.RANGER]: 750,
  [Tier.HUNTER]: 1500,
  [Tier.APEX]: 2500,
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

export const CONTRACT_EVENTS = {
  MEMBERSHIP_PURCHASED: 'MembershipPurchased',
  MEMBERSHIP_UPGRADED: 'MembershipUpgraded',
};
