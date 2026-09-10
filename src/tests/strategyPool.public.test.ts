import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for the StrategyPool mongoose model.
const store = vi.hoisted(() => ({ pools: [] as any[] }));

vi.mock('../models/StrategyPool', () => {
  const DEFAULT_SEAPORT_PROTOCOL_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395';
  return {
    __esModule: true,
    DEFAULT_SEAPORT_PROTOCOL_ADDRESS,
    default: {
      find: (q: any = {}) => {
        let rows = store.pools;
        if (q?.status?.$ne) rows = rows.filter((p) => p.status !== q.status.$ne);
        const chain: any = { sort: () => chain, lean: async () => rows };
        return chain;
      },
      findOne: (q: any = {}) => ({
        lean: async () => store.pools.find((p) => p.slug === q.slug) ?? null,
      }),
    },
  };
});

import {
  normalizeOpenSea,
  normalizeTags,
  toPublicPool,
  StrategyPoolService,
  PoolServiceError,
} from '../services/strategyPool.service';

const OFFERER = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  store.pools = [];
});

describe('normalizeOpenSea', () => {
  it('returns undefined when no binding fields are present', () => {
    expect(normalizeOpenSea(undefined)).toBeUndefined();
    expect(normalizeOpenSea({})).toBeUndefined();
  });

  it('requires collectionSlug once any binding field is set', () => {
    expect(() => normalizeOpenSea({ contractAddress: '0x'.padEnd(42, 'a') })).toThrow(PoolServiceError);
  });

  it('defaults chain, protocol address and offer protection', () => {
    const os = normalizeOpenSea({ collectionSlug: 'azuki' })!;
    expect(os.chain).toBe('ethereum');
    expect(os.protocolAddress).toBe('0x0000000000000068F116a894984e2DB1123eB395');
    expect(os.offerProtectionEnabled).toBe(true);
  });

  it('rejects a malformed contract address and half-specified trait', () => {
    expect(() => normalizeOpenSea({ collectionSlug: 'a', contractAddress: 'nope' })).toThrow(/contractAddress/);
    expect(() => normalizeOpenSea({ collectionSlug: 'a', trait: { type: 'Fur' } })).toThrow(/trait/);
  });

  it('keeps a fully specified trait', () => {
    const os = normalizeOpenSea({ collectionSlug: 'a', trait: { type: 'Fur', value: 'Gold' } })!;
    expect(os.trait).toEqual({ type: 'Fur', value: 'Gold' });
  });
});

describe('normalizeTags', () => {
  it('splits a comma string and caps the count', () => {
    expect(normalizeTags('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(normalizeTags(undefined)).toBeUndefined();
  });
});

describe('toPublicPool', () => {
  it('projects a DTO with no _id and no target/progress (target is the live OpenSea floor)', () => {
    const dto = toPublicPool({
      _id: 'x',
      slug: 's',
      name: 'S',
      imageUrl: '/i.jpg',
      raisedEth: 4,
      status: 'OPEN',
      depositsPaused: false,
      openSea: { collectionSlug: 'azuki', chain: 'ethereum' },
    } as any);
    expect(dto).not.toHaveProperty('_id');
    expect(dto).not.toHaveProperty('targetEth');
    expect(dto).not.toHaveProperty('progress');
    expect(dto.raisedEth).toBe(4);
    expect(dto.openSea?.collectionSlug).toBe('azuki');
  });
});

describe('StrategyPoolService.getPublicPools', () => {
  it('hides CLOSED pools', async () => {
    store.pools = [
      { slug: 'a', name: 'A', imageUrl: '', raisedEth: 0, status: 'OPEN', depositsPaused: false },
      { slug: 'b', name: 'B', imageUrl: '', raisedEth: 0, status: 'CLOSED', depositsPaused: false },
    ];
    const pools = await StrategyPoolService.getPublicPools();
    expect(pools.map((p) => p.slug)).toEqual(['a']);
  });
});

describe('StrategyPoolService.buildOfferPayload', () => {
  const base = {
    slug: 'bayc',
    name: 'BAYC',
    imageUrl: '',
    targetEth: 10,
    raisedEth: 1,
    status: 'OPEN',
    depositsPaused: false,
  };

  it('rejects a bad offerer', async () => {
    store.pools = [{ ...base, openSea: { collectionSlug: 'boredapeyachtclub', chain: 'ethereum' } }];
    await expect(StrategyPoolService.buildOfferPayload('bayc', 'nope')).rejects.toThrow(/offerer/);
  });

  it('404s an unknown pool and 409s an unbound pool', async () => {
    await expect(StrategyPoolService.buildOfferPayload('ghost', OFFERER)).rejects.toMatchObject({ statusCode: 404 });
    store.pools = [{ ...base }];
    await expect(StrategyPoolService.buildOfferPayload('bayc', OFFERER)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('builds a whole-collection criteria body', async () => {
    store.pools = [
      {
        ...base,
        openSea: {
          collectionSlug: 'boredapeyachtclub',
          chain: 'ethereum',
          protocolAddress: '0x0000000000000068F116a894984e2DB1123eB395',
          offerProtectionEnabled: true,
        },
      },
    ];
    const out = await StrategyPoolService.buildOfferPayload('bayc', OFFERER, 2);
    expect(out.proxyPath).toBe('offers/build');
    expect(out.body).toEqual({
      criteria: { collection: { slug: 'boredapeyachtclub' } },
      offerer: OFFERER,
      protocol_address: '0x0000000000000068F116a894984e2DB1123eB395',
      quantity: 2,
      offer_protection_enabled: true,
    });
  });

  it('includes contract + trait in criteria when the pool is a trait offer', async () => {
    store.pools = [
      {
        ...base,
        openSea: {
          collectionSlug: 'boredapeyachtclub',
          chain: 'ethereum',
          contractAddress: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
          trait: { type: 'Fur', value: 'Gold' },
        },
      },
    ];
    const out = await StrategyPoolService.buildOfferPayload('bayc', OFFERER);
    expect((out.body.criteria as any).contract).toEqual({ address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D' });
    expect((out.body.criteria as any).trait).toEqual({ type: 'Fur', value: 'Gold' });
    expect(out.body.quantity).toBe(1);
  });
});

describe('OpenSea proxy allowlist', () => {
  it('permits the new offer paths and still rejects unknown paths', async () => {
    const { OpenSeaService } = await import('../services/opensea.service');
    expect(OpenSeaService.isAllowedPath('offers/collection/azuki', 'GET')).toBe(true);
    expect(OpenSeaService.isAllowedPath('offers/build', 'POST')).toBe(true);
    expect(OpenSeaService.isAllowedPath('offers/build', 'GET')).toBe(false);
    expect(OpenSeaService.isAllowedPath('accounts/0xabc', 'GET')).toBe(false);
  });
});
