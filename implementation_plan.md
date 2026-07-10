# Phase 1.5: Off-Chain Backend Implementation Plan

To support the simplified smart contract architecture, we need a robust off-chain backend that tracks the referral tree, calculates the 40/40/20 leg rules, listens to blockchain events, and serves data to the frontend dApp. 

**Stack:** Node.js, Express.js, MongoDB (Mongoose), and `ethers` (v6).

## 1. System Architecture & Flow

### User Registration & Purchase Flow
1. **Sign Up (Off-Chain)**: A user connects their wallet to the dApp and signs up using a referral link. The frontend sends their `username`, `email`, `phone`, `walletAddress`, and their sponsor's `username` (instead of wallet address) to the backend.
2. **Fetch Uplines (API)**: When the user clicks "Purchase Tier", the frontend queries the backend (`GET /api/upline/:username`) to retrieve the exact array of up to 12 upline *wallet addresses* based on the tree.
3. **Transaction (On-Chain)**: The frontend passes this array directly to the smart contract's `purchaseMembership` function.
4. **Verification (Event Listener)**: The backend uses `ethers.js` to constantly listen for `MembershipPurchased` events. Once detected, it updates the user's Tier in the database and triggers a background job to recalculate the 40/40/20 team volume for their uplines.

## 2. Database Schema (MongoDB / Mongoose)

To efficiently store and query the full up/downline tree without slow recursive queries, we will use the **Ancestors Array (Materialized Path)** pattern.

### A. `User` Collection
Stores personal info, network relationships, and computed state.
- `username`: String (Unique, Indexed, used as referral code)
- `walletAddress`: String (Unique, Indexed)
- `email`: String
- `phone`: String
- `sponsorUsername`: String (Direct parent)
- `ancestors`: Array of Strings (List of all upline usernames, e.g., `["root", "sponsorA", "sponsorB"]`. Makes querying full downlines instantly fast).
- `directDownline`: Array of Strings (List of usernames of people directly sponsored by this user).
- `tier`: String (e.g., "None", "Scout", "Tracker", "Ranger", "Hunter", "Apex")
- `rank`: String (Default: "None", can upgrade to "Tracker", "Ranger", etc.)
- `teamVolume`: Number (Total sales volume of entire downline)
- `legVolumes`: Map of `String -> Number` (Tracks volume per direct referral for the 40/40/20 rule)
- `joinedAt`: Date

### B. `Transaction` Collection
Acts as an off-chain ledger of confirmed blockchain events.
- `txHash`: String (Unique)
- `walletAddress`: String
- `type`: String (e.g., "PURCHASE", "UPGRADE", "COMMISSION_CLAIM")
- `tier`: String (e.g., "Scout")
- `amount`: Number
- `timestamp`: Date

## 3. Backend Services & APIs (Full Protocol Support)

To fully support the features described in `HNTR_2.pdf`, the backend will implement the following services:

### A. `network.service.js` (Tree & Volume Logic)
- **`getUplines(username)`**: Uses the `ancestors` array to fetch the closest 12 parent wallet addresses for the smart contract's `purchaseMembership` transaction.
- **`getDownline(username)`**: Instantly fetches the user's entire downline tree for the dApp dashboard.
- **`calculateLegVolumes(username)`**: Crawls the `directDownline` and computes total sales volume under each direct leg. 
- **`evaluateRank(username)`**: Applies the 40/40/20 rule to the user's leg volumes to determine if they qualify for a Rank upgrade (e.g., Tracker requires $10,000 volume). Automatically updates their `rank` in the database if they qualify.

### B. `blockchain.service.js` (Ethers v6 Listener)
- **`syncPurchases()`**: Listens to the `MembershipPurchased` and `MembershipUpgraded` events on-chain. Validates the TX, updates the user's `tier` (converting uint8 to String like "Scout"), and triggers `evaluateRank()` for their uplines.

### C. `rewards.service.js` (Manual Payout Generators)
As per the PDF, Rank Bonuses and Leadership Bonuses are paid out manually.
- **`generateRankBonusReport()`**: Runs daily. Finds all users who achieved a new rank that day (e.g., Hunter = $5,000 bonus) and generates a CSV/List of wallet addresses and payout amounts for the Admin to send from the `achievementWallet`.
- **`calculateMonthlyLeadershipPool()`**: Runs on the 1st of every month. 
  - Finds all users ranked Hunter and above.
  - Assigns shares (Hunter = 1, Elite = 3, Master = 7, Legend = 15).
  - Calculates the total USDC in the `leadershipWallet`.
  - Determines the exact USDC payout per user based on their proportional shares.
  - Generates the final payout report for the Admin.

### D. `feature-gating.service.js` (Tier Benefits)
The PDF outlines specific Web2/Web3 benefits tied to tiers. This service acts as an auth middleware.
- **`canAccessEducation(tier)`**: Unlocks the Educational Hub (Available to all tiers).
- **`canAccessOTC(tier)`**: Unlocks the Tailor OTC Desk (Requires Hunter or Apex).
- **`canAccessLending(tier)`**: Unlocks the NFT Lending Platform (Requires Hunter or Apex).

### Express API Endpoints
- **Auth**: `POST /api/users/register`, `POST /api/users/login` (Wallet Signature verification).
- **Profile**: `GET /api/users/:username` (Returns profile, tier, rank, team volume, and unlocked features).
- **Network**: `GET /api/network/uplines/:username`, `GET /api/network/downline/:username`.
- **Admin**: `GET /api/admin/reports/rank-bonuses`, `GET /api/admin/reports/leadership-pool`.

## Proposed Setup Steps
1. **Initialize Project**: Create a new `/backend` folder, run `npm init`, and install dependencies (`express`, `mongoose`, `ethers`, `dotenv`, `cors`).
2. **Create Models**: Write the Mongoose schemas for `User` and `Transaction`.
3. **Build Services**: Implement the Ancestor tree logic and the Ethers event listener.
4. **Create API Routes**: Wire the Express controllers to serve the dApp.

---

## Open Questions for Review

> [!IMPORTANT]
> **Authentication & Security**
> For `POST /api/users/register`, anyone could theoretically submit a fake API request. Do you want to implement **Wallet Signatures** (EIP-4361 / Sign-In with Ethereum) so users must cryptographically prove they own the `walletAddress` before registering or viewing their downline?

> [!NOTE]
> **Project Structure**
> I plan to initialize this inside a new `d:\internship\stellar-code\hntr\backend` directory to keep it alongside your smart contracts. Is this location good?
