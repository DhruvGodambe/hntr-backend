# Backend APIs needed by the member frontend

> Same document as `hntr-frontend/docs/FRONTEND_API_REQUIREMENTS.md`. Update both copies together.

**For:** backend developer (hntr-backend)
**Scope:** member-facing pages of `hntr-frontend` (branch `v2-redesign`). The `/admin` pages in hntr-frontend are out of scope (hntr-admin is the admin app).
**Checked:** 2026-10-16, against hntr-backend `dev`.

This lists every page or component whose data does not yet come from the backend, what the screen needs, and a proposed API for each. Field names and endpoints are proposals. Change them if you have a better shape, but tell the frontend so the hooks match. Where a product decision is needed first, it is marked **Decision needed**.

---

## 1. Summary

| # | Feature | Where it shows | Today | Priority | Blocked by |
|---|---|---|---|---|---|
| 3.1 | Strategy deposits | Pool detail deposit panel, deposit popup, "Enter strategy" buttons | Disabled ("Opens soon"). No contract, no API | **P0** | Contract decision |
| 3.2 | Pool rounds and accounting | NFT Strategy tables, Home strategy carousel, Pool detail stats | `raisedEth` / `participants` typed in by admin. Upcoming list hardcoded | **P0** | Partly 3.1 |
| 3.3 | HNTR NFT inventory (bought, listed, sold) | Marketplace grids and stats, Home Listings and Sales, NFT detail popup | Placeholder cards, stats hardcoded `0` | P1 | 3.2 |
| 3.4 | Member positions | My NFTs: stats, co-owned grid, positions table, Share Collection | Hardcoded `0`, empty rows | P1 | 3.1, 3.3 |
| 3.5 | Strategy activity feeds | NFT Strategy "Real-Time Activity", Pool detail "Transaction Activity" | Static "starts at launch" note | P2 | 3.1 |
| 3.6 | Marketplace activity feed | Marketplace "Network Activity" table | Collection names with empty cells | P2 | 3.3 |
| 3.7 | Network reward cards | Network page: NFT Strategy Rewards, OTC Desk, Liquidity Provider | Hardcoded "Coming soon" | P3 | Product |
| 3.8 | Support desk | Support page (hidden for now) | Built on `dev` incl. screenshot uploads, not deployed. No admin screen | — | Deploy + Cloudinary keys |
| 3.9 | Small items | Various | See section | Low | — |

Two frontend flags gate the pre-launch UI. Turning them on does **not** bring data in by itself; the APIs below are needed first:
- `LISTINGS_LIVE = false` in `lib/launch.ts`: listings, sales and positions show placeholders.
- `DEPOSITS_ENABLED = false` in `lib/deposit-modal.ts`: deposit disabled, "Raised" shows "—", only BAYC shows as live.

---

## 2. Conventions to follow

Copy the structure of **Priority Line** (`priorityLine.*`) and **Support** (`support.*`). Both are recent and follow the house style.

- **Layers:** `routes/x.routes.ts` → `controllers/x.controller.ts` (thin; `handle()` maps the service error) → `services/x.service.ts` (all rules; throws `XError(code, message, status)`) → `models/X.ts`.
- **Response envelope:** `sendSuccess(res, data)` / `sendError(res, msg, status, { code })`. The frontend reads `data`, and `errors.code` for error handling.
- **Member identity:** member routes use `requireWalletAuth`. The member is always `req.walletAddress`, never a body field. If a wallet or username is in the path, add `requireSelfWallet` / `requireSelfUsername`.
- **Read-only sessions:** super-login tokens are read-only (GET only). This is already enforced by `requireWalletAuth`; keep write routes as POST.
- **Rate limits** (`middlewares/rateLimiter.middleware.ts`):
  - public reads: `marketApiRateLimit`
  - member reads: `userApiRateLimit`
  - writes: a dedicated limiter
- **Lists:** `parsePagination(req.query)` and `paginatedResponse(items, total, page, limit)` → `{ items, pagination }`.
- **Units:**
  - ETH display amounts are numbers in ETH (the frontend formats them with `.toFixed(2)`).
  - Add `…Wei` strings where exactness matters (deposits, payouts).
  - USD amounts are numbers; dates are ISO strings; wallets are lowercase.
- **Privacy:** public feeds show `username` (or a shortened wallet), never email, phone or full name. See `ActivityFeedService` and the fixed `NetworkService.getDownline`.
- **Notifications:** call `NotificationService.createQuiet({... dedupeKey })`. A new type must be added in **three** places:
  - the `NotificationType` union in `models/Notification.ts`
  - the schema `enum` in the same file
  - the frontend `BackendNotificationType` in `lib/notifications.ts` (frontend change; tell the frontend)
- **Tests:**
  - vitest service tests with mocked models (see `src/tests/priorityLine.test.ts`, `src/tests/support.test.ts`)
  - add every new member route to `src/tests/idor.authz.test.ts`
- **Frontend pool URL:** `/pool/<poolSlug>--<tokenId>` (`toPoolRouteId` in frontend `lib/opensea.ts`). NFT ids below use the same `<slug>--<tokenId>` form so links line up.

---

## 3. Features

### 3.1 Strategy deposits — P0

**Where**
- `app/pool/[id]/page.tsx` → `DockedDeposit`:
  - ETH amount input with 25% / 50% / 100% buttons (of the wallet's ETH balance) and a USD estimate
  - a **DEPOSIT** button, currently "Opens soon"
  - stats: "Pool Raised", "% raised", "N users already deposited"
- `app/components/DepositModal.tsx`: the popup version, opened with `window.openDepositModal(assetName, floorEth)`.
- Home and NFT Strategy "Enter strategy" buttons lead here.

**Rules already promised in the frontend copy**
(Sources: `lib/contracts.ts` `PAYMENT_RULES` / `PACKAGE_BENEFITS` / `TIERS`, and the "Strategy Mechanics" text on the pool page.)
- Pool deposits are **ETH only**. Pool rewards are **ETH only, paid instantly via smart contract**.
- An active membership is required.
- **Per-tier cap** ("Max Deposit per Pool"): Bronze $400, Silver $1,500, Gold $4,000, Platinum $8,000, Diamond $20,000. These match `PRIORITY_LINE_TIER_CAPS` in `src/constants/index.ts`. The cap is in USD but deposits are in ETH, so convert with `CoinGeckoService.getEthUsdPrice()` at deposit time and store the rate used.
- **Target** = the collection's floor (cheapest OpenSea listing). When raised ≥ target, the pool closes and **instantly buys** the cheapest NFT.
- The NFT is then listed at a premium (copy says "10%", the pool page says "10–25%"). On sale, ETH plus profit returns to depositors **pro-rata by seat size**.
- **80/20 rule:** 20% of unilevel commissions go "into the first available pool". This is `lockedRemaining` in the rewards summary today.
- `POOL_DEPOSIT` points already exist (`PointsService` multiplier **15 points per USD**), but nothing awards them, and `recalculatePoints` doesn't include pool deposits.

**Decision needed before any API work**
1. **Contract.** There is **no pool/vault contract** in either repo; only `HNTRMembership` exists. The UI copy promises "automated smart contracts… fully decentralized". So either:
   - (a) deploy a vault contract per pool or round, and the backend indexes its events, or
   - (b) use a custodial deposit wallet like Priority Line, where the backend verifies the transfer receipt.

   (a) matches the copy.
2. Is the cap **per pool** or **across all pools**? The constant's comment says "per pool".
3. Does the 20% locked commission count as a deposit and a seat in the first open pool? Automatically?
4. How do **Priority Line** reservations (USDT/USDC queue) convert into strategy seats at launch?
5. Minimum deposit in ETH?

**Proposed endpoints** (same prepare/confirm shape as Priority Line)

`GET /api/pools/:slug/me` (wallet auth): can this member deposit into the current round, and how much?
```json
{
  "roundNumber": 844,
  "canDeposit": true,
  "reason": null,
  "tier": "Gold",
  "capUsd": 4000,
  "capEth": 1.62,
  "depositedEth": 0.4,
  "remainingEth": 1.22,
  "minDepositEth": 0.01,
  "ethUsd": 2470.12
}
```
`reason` when `canDeposit` is false: `NO_MEMBERSHIP` | `NOT_LIVE` | `DEPOSITS_PAUSED` | `ROUND_FULL` | `CAP_REACHED`.

`POST /api/pools/:slug/deposits/prepare` (wallet auth): body `{ "amountEth": "0.5" }`. Validates the cap and returns what the wallet should send:
```json
{ "to": "0xVault…", "valueWei": "500000000000000000", "data": "0x…", "chainId": 11155111, "roundNumber": 844, "quoteExpiresAt": "2026-10-16T12:05:00Z" }
```

`POST /api/pools/:slug/deposits/confirm` (wallet auth): body `{ "txHash": "0x…" }`.
- Verify the receipt: success, `to` is the round's vault/wallet, value or deposit event, `from` is the session wallet.
- Make it idempotent on `(txHash, logIndex)`.
- Then:
  - record the deposit
  - update the round's raised amount and participants
  - award `POOL_DEPOSIT` points
  - send a `POOL_DEPOSIT` notification (new type)
- Returns the same body as `/me`.

Also add a **reconciler / chain listener** like `priorityLineReconciler`, so deposits sent without a confirm call (closed tab, etc.) are still recorded.

**Proposed model:** `PoolDeposit { walletAddress, poolSlug, roundNumber, amountEth, amountWei, ethUsdAtDeposit, txHash, logIndex, status: 'CONFIRMED' | 'REFUNDED', createdAt }`, with a unique index on `(txHash, logIndex)`.

**Frontend follow-up after this ships:** remove the `DEPOSITS_ENABLED` gate and wire `DockedDeposit` / `DepositModal` (prepare → wallet send → confirm). Separately, `DepositModal.tsx` has a hardcoded `DM_ETH_USD = 1820`; that is a frontend fix.

---

### 3.2 Pool rounds and accounting — P0

**Today**
- `StrategyPool` is one document per collection.
- `raisedEth` and `participants` are typed in by an admin.
- `status` is `OPEN | CLOSED | COMPLETED`.
- The frontend works out the target from the live OpenSea floor.
- The NFT Strategy page **hardcodes** the Upcoming table (`UPCOMING_CATALOG` in `app/pools/page.tsx`: Pudgy Penguins, CryptoPunks, Azuki, Mutant Ape Yacht Club, listed even without a pool record) and the pre-launch live pool (`PRELAUNCH_LIVE_SLUG = "boredapeyachtclub"`).

**Needed**
1. **Upcoming status** on `StrategyPool`: add `UPCOMING` to `status`, plus a `sortOrder` number. `GET /api/pools` returns them, and the frontend drops its hardcoded list. *(Quick win; can ship before deposits.)*
2. **Rounds.** The design shows "POOL #844", one numbered round per purchase. Proposed `PoolRound`:
   ```
   poolSlug, roundNumber (global, unique), status: FUNDING | BUYING | HOLDING | LISTED | SOLD | SETTLED,
   targetEth, raisedEth, participants, openedAt, filledAt,
   nft?: { contract, tokenId, name, imageUrl, paidEth, purchaseTxHash, purchasedAt,
           askEth, listedAt, openseaUrl, soldEth, saleTxHash, soldAt, profitEth }
   ```
   - `raisedEth` and `participants` are **computed from deposits**, not typed in.
   - `targetEth` is the floor snapshot when the round opens (or live; **Decision needed**).
3. Extend `GET /api/pools` and `GET /api/pools/:slug` without breaking the current `PublicPool` fields (`slug, name, imageUrl, raisedEth, status, depositsPaused, collectionName, openSea, gpProfit, ethProfit, usdtProfit, participants, daysRemaining, tags, updatedAt`):
   ```json
   "currentRound": { "roundNumber": 844, "status": "FUNDING", "targetEth": 5.38, "raisedEth": 1.2, "participants": 37, "progressPct": 22 },
   "sortOrder": 2
   ```
   Keep top-level `raisedEth` / `participants` mirroring the current round so existing screens keep working.

---

### 3.3 HNTR NFT inventory — P1

**Where**
- **Marketplace** (`app/marketplace/page.tsx`):
  - **Stats row:** Total Protocol Value ($), Total NFTs Owned, Total Co-owners, Total NFTs Sold. The design also shows "+6.1% this month" and "+2 this month".
  - **NFT LISTED** grid (5 per row). Card: image, name ("Azuki #2204"), **Paid**, **Ask**, **Est. Profit**, "VIEW LISTING" (OpenSea link). Plus a collection filter and sort.
  - **NFT SOLD** grid. Card: image, name, **Paid**, **Sold**, **Profit**.
- **Home** (`app/home/page.tsx`): **HNTR LISTINGS** grid (same listed card) and **HNTR SALES** scroller (same sold card).
- **NFT detail popup** (design):
  - listed: For sale, Collection, Price bought, premium %, My share, Transaction (Etherscan), OpenSea link, share text "I own X% of <asset> on HNTR"
  - sold: profit, sale transaction (Etherscan), my share %, my profit

**Proposed endpoints** (public; `marketApiRateLimit`)

`GET /api/nfts?status=listed|sold|all&collection=<slug>&sort=newest|price_desc|price_asc|profit_desc&page&limit`
```json
{
  "items": [{
    "id": "azuki--2204", "poolSlug": "azuki", "roundNumber": 844,
    "collection": { "slug": "azuki", "name": "Azuki" },
    "tokenId": "2204", "name": "Azuki #2204", "imageUrl": "https://…",
    "status": "LISTED",
    "paidEth": 4.15, "purchaseTxHash": "0x…", "purchasedAt": "…",
    "askEth": 4.90, "premiumPct": 18.1, "estProfitEth": 0.75, "listedAt": "…", "openseaUrl": "https://opensea.io/item/…",
    "soldEth": null, "saleTxHash": null, "soldAt": null, "profitEth": null,
    "coOwners": 37
  }],
  "pagination": { "page": 1, "limit": 20, "total": 6, "totalPages": 1, "hasNext": false, "hasPrev": false }
}
```

`GET /api/nfts/stats`:
```json
{ "totalValueUsd": 2400000, "totalValueChangePct30d": 6.1, "ownedCount": 6, "ownedChange30d": 2, "coOwners": 12482, "soldCount": 8 }
```
Definitions to confirm (**Decision needed**):
- total value = sum of held NFTs at ask (or floor) × ETH/USD
- co-owners = distinct wallets holding a seat in any HOLDING / LISTED round

`GET /api/nfts/:id` (`id` = `<slug>--<tokenId>`): a single item. If a wallet session is present, also include `"myShare": { "pct": 0.18, "depositedEth": 0.9, "profitEth": 0.13 }`. Optional auth: decode the token if present, but don't require it.

**Data source:** written by whatever runs the pool: purchase transaction, OpenSea listing, sale transaction. Fill these on `PoolRound.nft` as they happen.

---

### 3.4 Member positions (My NFTs) — P1

**Where:** `app/collection/page.tsx` (needs a wallet; nav is locked when disconnected).
- **Stats:** NFT Owned (count), Total NFTs Value (ETH + USD, the member's share), MY PROFIT (ETH + USD).
- **Co-Owned NFTs grid** card: "POOL #844", collection, "#1188", Listed Price (ETH + USD), My Share (ETH + USD), profit % badge, status (Held / Listed / Sold). In-progress rounds show a % ring instead.
- **All Positions Breakdown** tabs. Columns are fixed in `POS_HEADS`:
  - NFTs Listed: Collection · Price Listed · APR · My Profit · View NFT
  - NFTs Sold: Collection · Bought Price · Sold Price · My Profit · View NFT
  - Pools in Progress: Collection · ETH Target · Raised · APR · My Deposit · View NFT
  - pagination: "Showing 1–5 of N"
- **Share Collection** popup (`components/collection/ShareCollectionModal.tsx`) takes `nfts: { name, imageUrl, priceEth }[]`. It is passed `[]` today.

**Proposed endpoints** (wallet auth, session wallet only, `userApiRateLimit`)

`GET /api/positions/summary`
```json
{ "ownedCount": 3, "totalValueEth": 7.4, "totalValueUsd": 18280, "profitEth": 0.92, "profitUsd": 2272 }
```

`GET /api/positions?view=listed|sold|progress&page&limit`
```json
{
  "items": [{
    "nftId": "boredapeyachtclub--1188", "poolSlug": "boredapeyachtclub", "roundNumber": 844,
    "collectionName": "Bored Ape Yacht Club", "tokenId": "1188", "imageUrl": "https://…",
    "status": "LISTED",
    "depositedEth": 5.03, "sharePct": 0.34, "shareValueEth": 5.03,
    "listedPriceEth": 14.8, "boughtPriceEth": 12.2, "soldPriceEth": null,
    "profitEth": 1.06, "profitPct": 21, "aprPct": 38.5,
    "targetEth": null, "raisedEth": null, "progressPct": null
  }],
  "pagination": { … }
}
```
- Send the fields that matter for each view; others can be `null`.
- `sharePct` = member's deposit ÷ round's raised.
- **APR:** **Decision needed** on the formula, e.g. (profit ÷ deposit) ÷ days held × 365, using estimated profit while listed.

The Share Collection popup can reuse `GET /api/positions?view=listed`.

---

### 3.5 Strategy activity feeds — P2

**Where**
- **NFT Strategy** page, "Real-Time Activity" (`app/pools/page.tsx`, `ACTIVITY_COLUMNS`): **Wallet · Bid Amount · Collection · Completion · Action**. The latest deposits across live pools. "Completion" = round % after that deposit. "Action" = link to the pool.
- **Pool detail**, "Transaction Activity" (`app/pool/[id]/page.tsx`): **User · Type · Date · Amount · Action**, paginated. Types: deposit, pool bought NFT, listed, sold, payout/refund. "Action" = Etherscan transaction link.

**Proposed endpoints** (public)
- `GET /api/pools/activity?limit=20`
- `GET /api/pools/:slug/activity?page&limit`

```json
{ "id": "dep-…", "type": "DEPOSIT", "username": "huntera", "walletShort": "0x71C…41f4",
  "amountEth": 0.5, "collection": { "slug": "azuki", "name": "Azuki" }, "roundNumber": 844,
  "completionPct": 63, "txHash": "0x…", "ts": "2026-10-16T12:00:00Z" }
```
Show `username` when registered, otherwise `walletShort`. Never the full wallet, email or name. (The existing `/api/activity/feed` follows this pattern.)

---

### 3.6 Marketplace "Network Activity" — P2

**Where:** `app/marketplace/page.tsx`. Columns: **Asset · Event · Price · Source · Time**. Design sample rows: "CryptoPunk #7712 · Listed · 33.40 ETH · OpenSea · 2m ago", "Azuki #2204 · Bid · 4.62 ETH · Blur · 14m ago", "BAYC #5540 · Sold · 13.75 ETH · OpenSea · 38m ago".

**Decision needed:** HNTR's own NFT events only (built from 3.3 data), or market-wide events for the tracked collections (OpenSea events through the existing `/api/market/opensea` proxy)? Recommend HNTR's own events first.

**Proposed:** `GET /api/nfts/activity?limit=20` →
```json
{ "nftId": "azuki--2204", "name": "Azuki #2204", "imageUrl": "https://…", "event": "LISTED", "priceEth": 4.9, "source": "OpenSea", "ts": "…" }
```
`event`: `BOUGHT | LISTED | SOLD | BID`.

---

### 3.7 Network reward cards — P3 (product first)

**Where:** `app/network/page.tsx`, `UPCOMING_NETWORK_REWARDS`. Three cards are hardcoded "Coming soon":
- **NFT Strategy Rewards**: "Claim your profit upon successful NFT Strategy sale". This becomes real with 3.4. `PAYMENT_RULES` says pool rewards are "paid instantly via smart contract", so maybe there is no claim, just totals. Proposed: `GET /api/positions/rewards` → `{ "paidEth": 0.92, "pendingEth": 0.3, "lastPayoutAt": "…" }`, plus a claim endpoint only if payouts aren't automatic.
- **OTC Desk** (Platinum and Diamond only: 25% platform fee, 75% to participants monthly) and **Liquidity Provider** (lending yields): no spec yet. Product needs to define these.

---

### 3.8 Support desk — built (incl. screenshot uploads), needs deploy

Built on hntr-backend `dev`, not yet on the Render dev server. All routes use the standard envelope (`data`, and `errors.code` on failure).

**Member routes** (`requireWalletAuth`; a ticket always belongs to the session wallet, never a body field):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/support/tickets` | — | `SupportTicket[]` (newest activity first, max 50) |
| POST | `/api/support/tickets` | JSON `{ category, priority, strategy?, subject, message, attachmentCount? }` | `SupportTicket` (201) |
| POST | `/api/support/tickets/:id/messages` | JSON `{ body }` | `SupportTicket` |
| POST | `/api/support/tickets/:id/attachments` | **multipart/form-data**, images in field `files` | `SupportTicket` |

**Admin routes** (hntr-admin, admin panel auth): `GET /api/admin/support/tickets?status=active|open|pending|resolved|all&search&page&limit`, `GET …/:id`, `POST …/:id/messages`, `POST …/:id/status` `{ status }`, `POST …/:id/attachments` (multipart, same rules; stored with `fromSupport: true`, allowed on any status). Admin DTOs also carry `walletAddress, username, attachmentCount, lastMessageAt, resolvedAt, resolvedBy` and `author` on support messages.

**Ticket shape (member):**
```json
{
  "id": "HNT-1001", "subject": "Upgrade not showing", "category": "Membership",
  "priority": "Urgent", "strategy": "Bored Ape Yacht Club", "status": "open",
  "createdAt": "2026-10-17T10:00:00Z",
  "messages": [{ "fromSupport": false, "body": "…", "createdAt": "…" }],
  "attachments": [{
    "url": "https://api.cloudinary.com/v1_1/…/image/download?…&expires_at=…",
    "format": "png", "bytes": 182044, "width": 1170, "height": 2532,
    "fromSupport": false, "uploadedAt": "…"
  }]
}
```
- `status`: `open` = waiting on support, `pending` = support replied, `resolved` = closed (no member replies or uploads).
- `category` must be one of: Deposits & Withdrawals, NFT Strategies, Membership, Network & Rewards, Wallet & Account, Other. `priority`: Low | Normal | Urgent.

**Screenshot uploads**
- Files are stored **private** in Cloudinary (`authenticated` assets under `hntr/support/HNT-xxxx/`). `attachments[].url` is a **signed URL that expires after ~10 minutes**: refetch the ticket list to get fresh ones, don't cache them. `url` is `null` if storage is not configured.
- Limits: PNG, JPEG, GIF or WebP only (checked from the file bytes, not the extension); max **5 MB per file**; max **10 screenshots per ticket** in total; rate limit 20 upload requests per 10 min.
- Flow for the Support page: create the ticket (JSON) → if files were picked, `POST /api/support/tickets/<id>/attachments` with `FormData` (`files` repeated per file) and the `Authorization: Bearer` header. **Don't set `Content-Type` yourself**; the browser adds the multipart boundary. If the upload fails, the ticket still exists; show "Ticket opened, screenshots failed to upload" and allow a retry.
- Read-only super-login sessions can't upload (POST).

Example call:
```ts
const form = new FormData();
files.forEach((f) => form.append("files", f));
const res = await fetch(`${API_BASE}/api/support/tickets/${id}/attachments`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
const json = await res.json(); // json.data = SupportTicket, or json.errors.code on failure
```

**Error codes** (`errors.code`):

| Code | HTTP | When |
|---|---|---|
| `INVALID_TICKET` | 400 | id is not `HNT-<n>` |
| `INVALID_INPUT` / `INVALID_CATEGORY` / `INVALID_PRIORITY` | 400 | bad create/reply body |
| `TICKET_NOT_FOUND` | 404 | unknown ticket, or another wallet's ticket |
| `TICKET_RESOLVED` | 409 | reply/upload on a resolved ticket |
| `TICKET_FULL` | 409 | 200-message limit reached |
| `TOO_MANY_OPEN_TICKETS` | 429 | 10 unresolved tickets already |
| `NO_FILES` | 400 | upload with no `files` |
| `INVALID_FILE_TYPE` | 400 | not a PNG/JPEG/GIF/WebP |
| `FILE_TOO_LARGE` | 413 | a file over 5 MB |
| `TOO_MANY_FILES` | 400 / 409 | more than 10 in one request (400), or the ticket would exceed 10 (409) |
| `INVALID_UPLOAD` | 400 | malformed multipart body |
| `UPLOAD_FAILED` | 502 | Cloudinary rejected the upload; nothing was saved, retry |
| `UPLOADS_NOT_CONFIGURED` | 503 | Cloudinary keys not set on the server |

Notification: `SUPPORT_REPLY` (link `/support?ticket=HNT-xxxx`) when support answers.

Tests: `src/tests/support.test.ts` (incl. uploads, with Cloudinary mocked), and the auth checks in `src/tests/idor.authz.test.ts`.

Still to do:
- **Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`** (optional `CLOUDINARY_FOLDER`) on the Render service, then **deploy `dev`**. The frontend Support page is hidden for now and will be switched back on after.
- **Frontend:** `lib/support.ts` needs an `attachments` field on `SupportTicket` and an upload call (above); the Support page should upload after create and show thumbnails from `attachments[].url`. Its "support will ask in a reply" copy can go.
- **hntr-admin** needs a Support screen (admin frontend work) for staff to read and answer tickets and view screenshots.

---

### 3.9 Small items and known issues

- **CoinGecko** (Home market overview): `nfts/market_chart/global?days=7` returns **404** (not on the current CoinGecko plan; the frontend falls back). `nfts/markets…` returns **429** on a cold cache. The proxy already caches with stale fallback (`COINGECKO_CACHE_TTL_MS`, default 120 s). Fix by raising the TTL for `nfts/*` paths (e.g. 10 min), warming the cache on a cron, or upgrading the plan.
- **Network topology "Latency: Xms"** (`components/NetworkTopologyTree.tsx`) is a random number. Low value; the frontend may just remove it. No API needed unless wanted.
- **Telegram / Discord links** go to `#` until `NEXT_PUBLIC_TELEGRAM_URL` / `NEXT_PUBLIC_DISCORD_URL` are set. Frontend config, not an API.
- **Live Webinar:** the page embeds the presentation deck only. The design's live video, chat and language picker are not built and have no backend. Out of scope unless product asks.
- **Language selector** is switched off in the frontend for now. Translation is client-side; no API needed.

---

## 4. Already connected (don't rebuild)

| Area | Endpoints |
|---|---|
| Wallet login | `GET /api/auth/nonce`, `POST /api/auth/verify` |
| Sign-up / profile | `/api/users/register`, `/username/:u/available`, `/sponsor/:u/validate`, `/wallet/:w`, `/wallet/:w/full-name`, `/search`; `/api/turnstile/*` |
| Membership | `/api/membership/quote`, `/purchase`, `/upgrade` |
| Gift codes | `/api/vouchers*` |
| Network page | `/api/network/:u/tree`, `/:w/rewards-summary`, `/transactions/:w`, `/:w/leadership-status`, `/:w/leadership-payouts`, `/:w/achievement-status`, `/:w/points`, `/claim`, `/relay/*` |
| Notifications | `/api/network/:w/notifications`, `/notifications/read` |
| Priority Line | `/api/priority-line/me`, `/deposit/prepare`, `/deposit/confirm`, `/withdrawals` |
| Strategies (list and detail numbers) | `/api/pools`, `/api/pools/:slug` |
| Prices / market | `/api/market/eth-usd`, `/api/market/coingecko`, `/api/market/opensea` |
| Home "Platform Activity" | `/api/activity/feed` |

## 5. Endpoints the member frontend doesn't use

Keep or remove as you see fit.
- `POST /api/pools/:slug/offer-payload`: builds the pool's own OpenSea offer (keeper side). Likely part of 3.1 / 3.2 automation.
- `GET /api/network/:u/uplines`: upline wallets for commission signing.
- `POST /api/network/:w/points/recalculate`: repair tool. Add `POOL_DEPOSIT` to it when 3.1 ships.
- `GET /api/network/:u/downline`: now returns public fields only (email, phone and name removed on `dev`). The Network tree uses `/tree` instead.

## 6. Suggested order

1. **Decide** the deposit mechanism, contract and the open questions in 3.1, 3.2, 3.3, 3.4 and 3.6.
2. **Upcoming status + sort order** (3.2, item 1). Small, and unblocks the hardcoded Upcoming list now.
3. **Rounds model** (3.2) + **deposits prepare/confirm + reconciler + points + notification** (3.1).
4. **Strategy activity feeds** (3.5).
5. **NFT inventory** (3.3), once purchase, listing and sale are recorded on rounds.
6. **Positions** (3.4) + **strategy rewards** (3.7).
7. **Marketplace activity** (3.6).
8. Set the Cloudinary keys and deploy `dev` for **Support** (3.8) whenever ready; it's independent.

For each step: service tests, add the routes to `idor.authz.test.ts`, and share the final response shapes with the frontend so `lib/*.ts` hooks can be written against them.
