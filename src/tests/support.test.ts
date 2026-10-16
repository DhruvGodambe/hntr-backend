import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const state = vi.hoisted(() => ({
  tickets: [] as any[],
  usernames: {} as Record<string, string>,
  counter: 0,
  notifications: [] as any[],
}));

function matches(row: any, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return (v as any[]).some((f) => matches(row, f));
    const path = k.split('.');
    let actual: any = row;
    for (const p of path) actual = actual?.[p];
    if (v instanceof RegExp) return typeof actual === 'string' && v.test(actual);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.includes(actual);
      if ('$exists' in v) return (actual !== undefined) === v.$exists;
    }
    return actual === v;
  });
}

function applyUpdate(row: any, update: any) {
  Object.assign(row, update.$set ?? {});
  for (const k of Object.keys(update.$unset ?? {})) delete row[k];
  for (const [k, val] of Object.entries(update.$push ?? {})) row[k] = [...(row[k] ?? []), val];
}

const clone = (r: any) => (r ? JSON.parse(JSON.stringify(r)) : r);

vi.mock('../models/SupportTicket', () => ({
  __esModule: true,
  default: {
    find: (q: any = {}) => {
      let rows = state.tickets.filter((r) => matches(r, q));
      const chain: any = {
        sort: (spec: any) => {
          const [[key, dir]] = Object.entries(spec) as [string, number][];
          rows = [...rows].sort((a, b) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0));
          return chain;
        },
        skip: (n: number) => {
          rows = rows.slice(n);
          return chain;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return chain;
        },
        lean: async () => rows.map(clone),
      };
      return chain;
    },
    findOne: (q: any) => ({ lean: async () => clone(state.tickets.find((r) => matches(r, q)) ?? null) }),
    findOneAndUpdate: (q: any, update: any) => ({
      lean: async () => {
        const row = state.tickets.find((r) => matches(r, q));
        if (!row) return null;
        applyUpdate(row, update);
        return clone(row);
      },
    }),
    countDocuments: async (q: any = {}) => state.tickets.filter((r) => matches(r, q)).length,
    create: async (data: any) => {
      const row = { ...data, createdAt: new Date(1_700_000_000_000 + state.tickets.length).toISOString() };
      state.tickets.push(row);
      return clone(row);
    },
  },
}));

vi.mock('../models/Counter', () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: async () => ({ seq: ++state.counter }),
  },
}));

vi.mock('../models/User', () => ({
  __esModule: true,
  default: {
    findOne: (q: any) => ({
      select: () => ({ lean: async () => (state.usernames[q.walletAddress] ? { username: state.usernames[q.walletAddress] } : null) }),
    }),
  },
}));

vi.mock('../services/notification.service', () => ({
  NotificationService: {
    createQuiet: async (n: any) => {
      state.notifications.push(n);
      return n;
    },
  },
}));

import { SupportService, SupportError } from '../services/support.service';

const valid = {
  category: 'Membership',
  priority: 'Urgent',
  subject: 'Upgrade not showing',
  message: 'I upgraded to Gold but my profile still says Silver. Tx 0xabc',
  strategy: 'Bored Ape Yacht Club',
  attachmentCount: 2,
};

async function expectError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(SupportError);
  expect(err.code).toBe(code);
  expect(err.statusCode).toBe(status);
}

beforeEach(() => {
  state.tickets = [];
  state.usernames = { [USER]: 'hunter1' };
  state.counter = 0;
  state.notifications = [];
});

describe('SupportService — member', () => {
  it('opens numbered tickets owned by the caller, with the first message', async () => {
    const t1 = await SupportService.createTicket(USER, valid);
    const t2 = await SupportService.createTicket(USER.toUpperCase().replace('0X', '0x'), { ...valid, priority: 'Low' });

    expect(t1.id).toBe('HNT-1001');
    expect(t2.id).toBe('HNT-1002');
    expect(t1).toMatchObject({ status: 'open', category: 'Membership', priority: 'Urgent', strategy: 'Bored Ape Yacht Club' });
    expect(t1.messages).toEqual([expect.objectContaining({ fromSupport: false, body: valid.message })]);
    expect(state.tickets[0]).toMatchObject({ walletAddress: USER, username: 'hunter1', attachmentCount: 2 });
    expect(state.tickets[1].walletAddress).toBe(USER);
  });

  it('validates category, priority, subject and message', async () => {
    await expectError(SupportService.createTicket(USER, { ...valid, category: 'Refunds' }), 'INVALID_CATEGORY', 400);
    await expectError(SupportService.createTicket(USER, { ...valid, priority: 'Critical' }), 'INVALID_PRIORITY', 400);
    await expectError(SupportService.createTicket(USER, { ...valid, subject: '   ' }), 'INVALID_INPUT', 400);
    await expectError(SupportService.createTicket(USER, { ...valid, subject: 'x'.repeat(91) }), 'INVALID_INPUT', 400);
    await expectError(SupportService.createTicket(USER, { ...valid, message: '' }), 'INVALID_INPUT', 400);
    expect(state.tickets).toHaveLength(0);
  });

  it('caps attachments and defaults priority to Normal', async () => {
    const t = await SupportService.createTicket(USER, { ...valid, priority: undefined, attachmentCount: 99 });
    expect(t.priority).toBe('Normal');
    expect(state.tickets[0].attachmentCount).toBe(10);
  });

  it('limits a wallet to 10 unresolved tickets', async () => {
    for (let i = 0; i < 10; i++) await SupportService.createTicket(USER, valid);
    await expectError(SupportService.createTicket(USER, valid), 'TOO_MANY_OPEN_TICKETS', 429);

    state.tickets[0].status = 'resolved';
    await expect(SupportService.createTicket(USER, valid)).resolves.toMatchObject({ id: 'HNT-1011' });
  });

  it('lists only the caller’s tickets, most recently active first', async () => {
    await SupportService.createTicket(USER, valid);
    await SupportService.createTicket(OTHER, valid);
    await SupportService.createTicket(USER, { ...valid, subject: 'Second' });
    state.tickets[0].lastMessageAt = new Date(2_000_000_000_000);

    const mine = await SupportService.listMine(USER);
    expect(mine.map((t) => t.id)).toEqual(['HNT-1001', 'HNT-1003']);
  });

  it('member reply re-opens a pending ticket; other wallets and resolved tickets are refused', async () => {
    await SupportService.createTicket(USER, valid);
    state.tickets[0].status = 'pending';

    const replied = await SupportService.replyAsMember(USER, 'hnt-1001', 'Still not fixed');
    expect(replied.status).toBe('open');
    expect(replied.messages.map((m) => m.body)).toEqual([valid.message, 'Still not fixed']);

    await expectError(SupportService.replyAsMember(OTHER, 'HNT-1001', 'hi'), 'TICKET_NOT_FOUND', 404);
    await expectError(SupportService.replyAsMember(USER, 'HNT-9999', 'hi'), 'TICKET_NOT_FOUND', 404);
    await expectError(SupportService.replyAsMember(USER, '1001', 'hi'), 'INVALID_TICKET', 400);
    await expectError(SupportService.replyAsMember(USER, 'HNT-1001', '  '), 'INVALID_INPUT', 400);

    state.tickets[0].status = 'resolved';
    await expectError(SupportService.replyAsMember(USER, 'HNT-1001', 'hi'), 'TICKET_RESOLVED', 409);
  });
});

describe('SupportService — admin', () => {
  it('support reply sets pending, notifies the member and keeps the admin name off the member view', async () => {
    await SupportService.createTicket(USER, valid);

    const adminView = await SupportService.adminReply('HNT-1001', 'alice', 'Fixed — please refresh.');
    expect(adminView.status).toBe('pending');
    expect(adminView.messages[1]).toMatchObject({ fromSupport: true, author: 'alice' });

    const [memberView] = await SupportService.listMine(USER);
    expect(memberView.messages[1]).toEqual({ fromSupport: true, body: 'Fixed — please refresh.', createdAt: expect.anything() });
    expect(JSON.stringify(memberView)).not.toContain('alice');

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({ walletAddress: USER, type: 'SUPPORT_REPLY', link: '/support?ticket=HNT-1001' });
  });

  it('support reply re-opens a resolved ticket', async () => {
    await SupportService.createTicket(USER, valid);
    await SupportService.adminSetStatus('HNT-1001', 'alice', 'resolved');
    expect(state.tickets[0]).toMatchObject({ status: 'resolved', resolvedBy: 'alice' });

    await SupportService.adminReply('HNT-1001', 'bob', 'Reopening to follow up');
    expect(state.tickets[0].status).toBe('pending');
    expect(state.tickets[0].resolvedBy).toBeUndefined();
  });

  it('rejects unknown statuses and tickets', async () => {
    await SupportService.createTicket(USER, valid);
    await expectError(SupportService.adminSetStatus('HNT-1001', 'alice', 'closed'), 'INVALID_STATUS', 400);
    await expectError(SupportService.adminSetStatus('HNT-1002', 'alice', 'resolved'), 'TICKET_NOT_FOUND', 404);
    await expectError(SupportService.adminReply('HNT-1002', 'alice', 'hi'), 'TICKET_NOT_FOUND', 404);
  });

  it('lists active tickets by default and finds tickets by id', async () => {
    await SupportService.createTicket(USER, valid);
    await SupportService.createTicket(OTHER, { ...valid, subject: 'Deposit missing' });
    await SupportService.adminSetStatus('HNT-1001', 'alice', 'resolved');

    const active = await SupportService.adminList({});
    expect(active.items.map((t) => t.id)).toEqual(['HNT-1002']);

    const all = await SupportService.adminList({ status: 'all' });
    expect(all.pagination.total).toBe(2);

    const byId = await SupportService.adminList({ status: 'all', search: 'HNT-1001' });
    expect(byId.items.map((t) => t.id)).toEqual(['HNT-1001']);
    expect(byId.items[0]).toMatchObject({ username: 'hunter1', walletAddress: USER, attachmentCount: 2 });
  });
});
