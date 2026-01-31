# Matrix Prediction Game — Technical Specification

## 1. Overview

A parimutuel matrix betting game where players bet on grid cells (time × price) predicting where a price chart will traverse. Built on Scaffold-ETH 2 with Yellow Network for gasless betting and ENS for identity.

**Hackathon scope:**
- Yellow Network integration (betting + cross-chain deposits)
- On-chain settlement (trusted broker, dispute mechanism is future work)
- ENS integration (player identity)
- Scaffold-ETH 2 framework (Foundry + Next.js)

**Prize targets:** Yellow ($15k pool) + ENS ($5k)

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                             │
│                    (Next.js / Scaffold-ETH)                 │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌─────────┐  ┌────────────┐    │
│  │ Grid UI  │  │  Wallet  │  │  ENS    │  │  Game      │    │
│  │ (betting)│  │ Connect  │  │ Display │  │  Status    │    │
│  └────┬─────┘  └────┬─────┘  └─────────┘  └────────────┘    │
│       │              │                                      │
│  ┌────▼──────────────▼──────────────────────────────────┐   │
│  │              Yellow SDK (Browser)                    │   │
│  │  - Channel management                                │   │
│  │  - Bet signing (off-chain state updates)             │   │
│  │  - WebSocket to ClearNode                            │   │
│  └──────────────────────┬───────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────┘
                          │ WebSocket
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     YELLOW NETWORK                          │
│                                                             │
│  ┌──────────────┐         ┌─────────────────────────────┐   │
│  │  ClearNode   │◄───────►│  Custody Contract (on-chain)│   │
│  │  (off-chain) │         │  - Deposits                 │   │
│  │  - Message   │         │  - Channel open/close       │   │
│  │    routing   │         │  - Cross-chain unified      │   │
│  │  - Auth      │         │    balance                  │   │
│  └──────┬───────┘         └─────────────────────────────┘   │
└─────────┼───────────────────────────────────────────────────┘
          │ WebSocket
          ▼
┌─────────────────────────────────────────────────────────────┐
│                    BROKER (Backend)                         │
│                   (Node.js / Express)                       │
│                                                             │
│  ┌───────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ Yellow SDK    │  │ Round        │  │ Keeper          │   │
│  │ (Server)      │  │ Manager      │  │ (Price Oracle)  │   │
│  │               │  │              │  │                 │   │
│  │ - Co-sign     │  │ - Phase      │  │ - Poll price    │   │
│  │   bet states  │  │   transitions│  │   feed          │   │
│  │ - Channel     │  │ - Aggregate  │  │ - Compute hit   │   │
│  │   management  │  │   bets       │  │   cells         │   │
│  │ - Fund        │  │ - Trigger    │  │ - Submit to     │   │
│  │   transfers   │  │   settlement │  │   settlement    │   │
│  └───────┬───────┘  └──────┬───────┘  └────────┬────────┘   │
└──────────┼──────────────────┼────────────────────┼──────────┘
           │                  │                    │
           ▼                  ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                  SMART CONTRACTS (On-Chain)                 │
│                     (Foundry / Solidity)                    │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    Onigo.sol                         │   │
│  │                (Settlement Ledger)                   │   │
│  │                                                      │   │
│  │  createMarket()                                      │   │
│  │  settleRound(marketId, roundId, winningCells[],     │   │
│  │               players[], payouts[])                  │   │
│  │  claimPlayerPayout()                                 │   │
│  │  withdrawCommissions()                               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Game Flow (Sequence Diagram)

```
Player          Frontend        Yellow/ClearNode      Broker           Contract        Oracle
  │                │                  │                  │                │               │
  │ ── SETUP (once per session) ───────────────────────────────────────────────────────   │
  │                │                  │                  │                │               │
  ��  Connect      │                  │                  │                │               │
  │  wallet ──────►│                  │                  │                │               │
  │                │  Auth request ──►│                  │                │               │
  │                │◄── Challenge ────│                  │                │               │
  │  Sign ◄────────│                  │                  │                │               │
  │  challenge ───►│  Auth verify ───►│                  │                │               │
  │                │◄── Authenticated │                  │                │               │
  │                │                  │                  │                │               │
  │  Deposit       │                  │                  │                │               │
  │  USDC ────────►│ ─── deposit() ──────────────────────────────►│ (Custody)             │
  │                │                  │                  │                │               │
  │  Open          │  Open channel ──►│  Notify ────────►│                │               │
  │  channel ─────►│◄── Co-signed ─── │◄── Co-sign ──────│                │               │
  │                │                  │                  │                │               │
  │ ── BETTING PHASE (60s, repeats every round) ────────────────────────────────────────  │
  │                │                  │                  │                │               │
  │  Select cells  │                  │                  │                │               │
  │  + amount ────►│                  │                  │                │               │
  │                │  State update:   │                  │                │               │
  │  Sign ◄────────│  [P:90, B:10]    │                  │                │               │
  │  state ───────►│  data: [bet1] ──►│  Forward ───────►│                │               │
  │                │                  │                  │  Validate      │               │
  │                │                  │◄── Co-sign ──────│  + co-sign     │               │
  │                │◄── Confirmed ────│                  │                │               │
  │                │                  │                  │                │               │
  │  More bets...  │  State update:   │                  │                │               │
  │  (same flow)   │  [P:70, B:30]    │                  │                │               │
  │                │  data: [b1,b2,b3]│                  │  Store         │               │
  │                │                  │                  │  cumulative    │               │
  │                │                  │                  │  bet history   │               │
  │                │                  │                  │                │               │
  │ ── LIVE PHASE (120s) ───────────────────────────────────────────────────────────────  │
  │                │                  │                  │                │               │
  │                │  Live price      │                  │                │  Poll price   │
  │                │  feed via WS ◄───│◄─────────────────│◄─────────────────────────────  │
  │                │                  │                  │                │               │
  │                │                  │                  │  Track which   │               │
  │                │                  │                  │  cells the     │               │
  │                │                  │                  │  price graph   │               │
  │                │                  │                  │  traverses     │               │
  │                │                  │                  │                │               │
  │ ── SETTLING PHASE (on-chain) ─────────────────────────────────────────────────────    │
  │                │                  │                  │                │               │
  │                │                  │                  │  Resize/close  │               │
  │                │                  │                  │  channels to   │               │
  │                │                  │                  │  withdraw bet  │               │
  │                │                  │                  │  funds───►│(Custody)           │
  │                │                  │                  │                │               │
  │                │                  │                  │  settleRound() │               │
  │                │                  │                  │  (hitCells +   │               │
  │                │                  │                  │   winners +    │               │
  │                │                  │                  │   payouts) ───►│               │
  │                │                  │                  │                │               │
  │ ── POST-SETTLEMENT ─────────────────────────────────────────────────────────────────  │
  │                │                  │                  │                │               │
  │                │                  │                  │◄── payouts ────│               │
  │                │                  │                  │  deposited     │               │
  │                │                  │◄── Update ───────│                │               │
  │                │◄── Channel ──────│  channel states  │                │               │
  │                │    updated       │  with winnings   │                │               │
  │                │                  │                  │                │               │
  │  OR: claim     │                  │                  │                │               │
  │  directly ────►│ ─── claimPlayerPayout() ──────────────────────────►│               │
  │◄── USDC ───────│◄──────────────────────────────────────────────────── │               │
  │                │                  │                  │                │               │
  │ ── CASH OUT (anytime) ────────────────────────────────────────────────────────────    │
  │                │                  │                  │                │               │
  │  Close         │  Close channel ─►│  Notify ────────►│                │               │
  │  channel ─────►│                  │◄── Co-sign ──────│                │               │
  │                │ ─── close() ──────────────────────────────────►│ (Custody)           │
  │◄── USDC ───────│◄─────────────────────────────────────────────────────│               │
```

---

## 4. Grid & Betting Model

```
Y-axis (price, $100 increments, unbounded)
▲
│
$3300 ┤  ┌─────┐
      │  │     │
$3200 ┤  │  ╔══╪══╗─────┐
      │  │  ║  │  ║     │
$3100 ┤  └──╫──┘  ║  ┌──┘    ← Price graph traverses these cells
      │     ║     ║  │
$3000 ┤  ───╨─────╨──┘
      │
$2900 ┤
      │
      └──┬─────┬─────┬─────┬─────┬──► X-axis (time, 1-min slots)
         0     1     2     3     4    minutes into LIVE phase

Player bet: [(min:1, $3100-$3200), (min:2, $3200-$3300), (min:3, $3100-$3200)]
Hit cells:  [(min:0, $3000-$3100), (min:1, $3100-$3200), (min:1, $3200-$3300),
             (min:2, $3200-$3300), (min:3, $3100-$3200), (min:3, $3000-$3100)]

Player hits: (min:1, $3100-$3200) ✓, (min:2, $3200-$3300) ✓, (min:3, $3100-$3200) ✓

Result: 3 cells bet, 3 hit → hitRatio = 3/3 = 100%
winningStake = betAmount × 1.0
```

### Grid Cell Definition

```
GridCell {
    timeSlotStart:  uint256  // Unix timestamp marking the start of this cell's time slot
    dataRangeStart: int256   // lower bound in data units (e.g., 3000 = $3000)
}
```

- `timeSlotEnd` = `timeSlotStart + market.timeSlotWidth`
- `dataRangeEnd` = `dataRangeStart + market.dataIncrement * 10^market.dataPower`
- Both ends are implicit, derived from market config
- Y-axis is unbounded — players can bet on any data range

---

## 5. Smart Contract Design

### 5.1 `Onigo.sol`

The contract is a **settlement ledger** — all payout computation happens off-chain by the trusted broker. The broker submits pre-computed payouts, and the contract records them and handles USDC transfers. On-chain payout verification is deferred to a future dispute mechanism (players hold co-signed Yellow Network state channel data as evidence).

```solidity
// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

// Uses OpenZeppelin: Ownable, SafeERC20

struct Market {
    uint8 commissionBps;       // e.g., 200 (2%)
    int8 dataPower;            // e.g., -2 (10^-2 = 0.01 multiplier)
    uint16 marketId;
    uint32 dataIncrement;      // e.g., 100 (100 * 10^dataPower per row)
    uint32 timeSlotWidth;      // e.g., 60 (1 minute in seconds)
    uint256 marketStartTime;
    uint256 roundLength;
    string marketName;
}

struct GridCell {
    uint256 timeSlotStart;     // Unix timestamp marking the start of this cell's time slot
    int256 dataRangeStart;     // lower bound in data units
}

struct SettlementData {
    uint16 marketId;
    uint32 roundId;
    GridCell[] winningCells;
    address[] players;
    uint256[] payouts;
}

// State:
//   broker: address             — authorized settlement submitter
//   usdc: address               — USDC token address
//   houseCommissionBps: uint8   — default commission (2%)
//   unclaimedCommissions        — accumulated commission across all markets
//   unclaimedPlayerPayouts      — per-player balance across all markets
//   settlementPerRoundPerMarket — (marketId, roundId) → SettlementData

// Functions:

function createMarket(
    string memory marketName,
    int8 dataPower,
    uint32 dataIncrement,
    uint32 timeSlotWidth,
    uint256 roundLength
) external onlyOwner;
// Creates a new market. Commission is snapshotted from houseCommissionBps.
// Round timing: roundStartTime = marketStartTime + (roundId - 1) * roundLength

function settleRound(
    uint16 marketId,
    uint32 roundId,
    GridCell[] calldata winningCells,
    address[] calldata players,
    uint256[] calldata payouts
) external onlyBroker;
// Broker submits pre-computed payouts. Contract:
// 1. Validates marketId, roundId, and that round is not already settled
// 2. Validates winning cells fall within the round's time window
// 3. Deducts commission per player payout and credits net amount
// 4. Stores settlement data on-chain
// 5. Pulls total payout amount from broker via USDC safeTransferFrom

function claimPlayerPayout() external;
// Player claims their accumulated payout across all markets/rounds

function withdrawCommissions() external onlyOwner;
// Owner withdraws accumulated commission

function setBroker(address broker) external onlyOwner;
// Update the broker address
```

**Note:** Oracle contracts (`IOracle.sol`, `MockOracle.sol`) are not needed on-chain. The keeper tracks prices off-chain and feeds hit cell data to the broker for settlement.

---

## 6. Yellow Integration (Off-Chain Layer)

### 6.0 Channel State `appData` Schema

The `data` field in Nitrolite state updates is ABI-encoded `bytes` (not JSON). We define a custom encoding for bet data carried in the player↔broker channel.

**Solidity struct (for ABI encoding reference):**

```solidity
struct BetData {
    uint256 roundId;
    Bet[] bets;        // cumulative — every state update carries the full bet history
}

struct Bet {
    uint256 amount;    // in USDC base units (6 decimals)
    GridCell[] cells;  // cells the player is betting on
}
```

**ABI type string:**

```
(uint256, (uint256, (uint16, int256)[])[] )
 roundId   amount    timeSlot  priceStart
                     ^^^^^^^^^^^^^^^^^^^^^^^^ GridCell[]
            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ Bet[]
```

**TypeScript encode / decode (using viem):**

```typescript
import { encodeAbiParameters, decodeAbiParameters } from "viem";

const BET_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "roundId", type: "uint256" },
      {
        name: "bets",
        type: "tuple[]",
        components: [
          { name: "amount", type: "uint256" },
          {
            name: "cells",
            type: "tuple[]",
            components: [
              { name: "timeSlot", type: "uint16" },
              { name: "priceRangeStart", type: "int256" },
            ],
          },
        ],
      },
    ],
  },
] as const;

// Encode
function encodeBetData(roundId: bigint, bets: Bet[]): `0x${string}` {
  return encodeAbiParameters(BET_DATA_ABI, [{ roundId, bets }]);
}

// Decode
function decodeBetData(data: `0x${string}`) {
  const [decoded] = decodeAbiParameters(BET_DATA_ABI, data);
  return decoded; // { roundId, bets: [{ amount, cells: [{ timeSlot, priceRangeStart }] }] }
}
```

**Example encoded value (human-readable):**

```
roundId: 42
bets: [
  { amount: 10_000000,  cells: [ {timeSlot:1, priceRangeStart:3100}, {timeSlot:2, priceRangeStart:3200} ] },
  { amount:  5_000000,  cells: [ {timeSlot:0, priceRangeStart:3000} ] }
]
```

**State update lifecycle:**

| Version | Player balance | Broker balance | appData (decoded) |
|---------|---------------|----------------|-------------------|
| 0 | 100 USDC | 0 | (empty — channel open) |
| 1 | 90 USDC | 10 USDC | roundId=42, bets=[{amt:10, cells:[(1,3100),(2,3200)]}] |
| 2 | 85 USDC | 15 USDC | roundId=42, bets=[{amt:10, cells:[(1,3100),(2,3200)]}, {amt:5, cells:[(0,3000)]}] |

Each state update is **cumulative** — it contains the full bet history for the current round. The broker validates that:
1. New bets are only appended (existing bets are not modified)
2. The allocation shift matches the new bet amount
3. The round is still in BETTING phase

### 6.1 Player-Side (Frontend)

```typescript
// packages/nextjs/lib/yellow.ts

import { NitroliteClient } from "@erc7824/nitrolite";

// 1. Connect to ClearNode
const client = new NitroliteClient({
  endpoint: "wss://clearnet.yellow.com/ws",
  signer: walletSigner
});

// 2. Authenticate (3-step)
await client.authenticate();

// 3. Open channel with broker (one-time)
await client.openChannel({
  participants: [playerAddress, brokerAddress],
  challenge: 3600,
  initialAllocations: [
    { destination: playerAddress, token: USDC, amount: depositAmount },
    { destination: brokerAddress, token: USDC, amount: 0 }
  ]
});

// 4. Place bet (per bet, gasless)
const currentBets = [...previousBets, newBet]; // cumulative
await client.updateState({
  intent: "OPERATE",
  version: nextVersion,
  data: encodeBetData(roundId, currentBets),  // ABI-encoded BetData
  allocations: [
    { destination: playerAddress, token: USDC, amount: remainingBalance },
    { destination: brokerAddress, token: USDC, amount: totalBetAmount }
  ]
});
```

### 6.2 Broker-Side (Backend)

```typescript
// packages/nextjs/server/broker.ts  (or separate backend)

// 1. Listen for state updates from players
clearNode.on("stateUpdate", async (state, playerChannel) => {
  const betData = decodeBetData(state.data);

  // 2. Validate bet
  if (!isValidBet(betData, currentRoundPhase)) {
    return reject(state);
  }

  // 3. Co-sign state
  const coSigned = await broker.coSign(state);
  return coSigned;
});

// 4. At settlement time
async function settleRound(roundId: number) {
  // Collect all bets from all player channels
  const allBets = collectBetsFromChannels(roundId);

  // Get hit cells from keeper
  const hitCells = keeper.getHitCells(roundId);

  // Compute payouts
  const payouts = computePayouts(allBets, hitCells, commissionRate);

  // Withdraw funds from channels (resize)
  for (const channel of activeChannels) {
    await channel.resize(/* move bet funds to broker */);
  }

  // Approve USDC spend, then submit to contract
  await usdc.approve(onigoAddress, totalPayoutAmount);
  await onigo.settleRound(
    marketId, roundId, hitCells,
    payouts.players, payouts.payoutAmounts
  );

  // Update winner channels with winnings
  for (const winner of payouts.winners) {
    await winner.channel.updateState(/* add winnings back */);
  }
}
```

### 6.3 Cross-Chain Deposit Flow

```
Player on Polygon                Yellow Network               Settlement Chain (Base)
      │                               │                              │
      │  Deposit USDC ───────────────►│                              │
      │  (Polygon Custody contract)   │                              │
      │                               │  Unified balance             │
      │                               │  credits player              │
      │                               │                              │
      │  Open channel with broker ───►│                              │
      │  (funds from unified balance) │                              │
      │                               │  Channel opened              │
      │                               │  (off-chain, any chain)      │
      │                               │                              │
      │  Place bets (off-chain) ─────►│                              │
      │                               │                              │
      │                               │  Broker settles ────────────►│
      │                               │  (on-chain on Base)          │
      │                               │                              │
      │  Cash out ───────────────────►│                              │
      │◄── USDC on Polygon ──────────│  (withdraw to original chain)│
```

---

## 7. ENS Integration

```typescript
// packages/nextjs/hooks/useENS.ts

import { useEnsName, useEnsAvatar } from "wagmi";

// Display ENS names in:
// - Game grid (hover over other players' bets)
// - Leaderboard
// - Recent winners
// - Bet history

function PlayerName({ address }: { address: string }) {
  const { data: ensName } = useEnsName({ address });
  const { data: avatar } = useEnsAvatar({ name: ensName });

  return (
    <div>
      {avatar && <img src={avatar} />}
      {ensName || truncateAddress(address)}
    </div>
  );
}
```

---

## 8. Keeper (Price Oracle Tracker)

```typescript
// packages/nextjs/server/keeper.ts

class Keeper {
  private priceHistory: { price: number; timestamp: number }[] = [];
  private hitCells: GridCell[] = [];

  // During LIVE phase: poll price every second
  async trackPrices(market: Market, roundStartTime: number) {
    const interval = setInterval(async () => {
      const { price, timestamp } = await oracle.getLatestPrice();
      this.priceHistory.push({ price, timestamp });
    }, 1000); // poll every second

    // After LIVE phase ends
    setTimeout(() => {
      clearInterval(interval);
      this.computeHitCells(market);
    }, LIVE_DURATION);
  }

  // Compute which cells the price graph traversed
  computeHitCells(market: Market) {
    for (const dataPoint of this.priceHistory) {
      const timeSlot = Math.floor(
        (dataPoint.timestamp - roundStartTime) / market.timeSlotWidth
      );

      // Price might cross multiple rows between data points
      // Interpolate between consecutive points
      const currentRow = Math.floor(dataPoint.price / market.priceIncrement);

      // Add cell
      this.hitCells.push({
        timeSlot,
        priceRangeStart: currentRow * market.priceIncrement
      });

      // If price crossed rows between this and previous point,
      // add all intermediate rows too
      if (previousPoint) {
        const prevRow = Math.floor(previousPoint.price / market.priceIncrement);
        for (let row = Math.min(prevRow, currentRow);
             row <= Math.max(prevRow, currentRow); row++) {
          this.hitCells.push({
            timeSlot,
            priceRangeStart: row * market.priceIncrement
          });
        }
      }
    }

    // Deduplicate
    this.hitCells = deduplicate(this.hitCells);
  }
}
```

---

## 9. Payout Computation

```
Given:
  hitCells[]              — cells the price graph traversed
  bets[]                  — all player bets for the round
  commissionBps = 1000    — 10%

Step 1: Total pool
  totalPool = sum(bet.amount for all bets)

Step 2: Commission
  commission = totalPool * commissionBps / 10000
  prizePool = totalPool - commission

Step 3: Per-bet winning stake
  For each bet:
    hitCount = count of bet.cells that appear in hitCells
    totalCells = len(bet.cells)
    winningStake = bet.amount * hitCount / totalCells

Step 4: Total winning stake
  totalWinningStake = sum(winningStake for all bets where hitCount > 0)

Step 5: Payout per winner
  For each bet where winningStake > 0:
    payout = winningStake * prizePool / totalWinningStake

Edge cases:
  - No winners (totalWinningStake = 0): refund all players (minus commission? TBD)
  - Single player: they get the full prizePool
  - All cells hit for everyone: payouts proportional to bet amounts
```

---

## 10. Scaffold-ETH 2 Project Structure

```
Onigo/
├── packages/
│   ├── foundry/
│   │   ├── contracts/
│   │   │   └── Onigo.sol               — Settlement ledger contract
│   │   ├── script/
│   │   │   └── Deploy.s.sol            — Deployment script
│   │   └── test/
│   │       └── Onigo.t.sol             — Contract tests
│   │
│   └── nextjs/
│       ├── app/
│       │   ├── page.tsx                 — Landing / game page
│       │   └── leaderboard/
│       │       └── page.tsx             — Leaderboard with ENS
│       ├── components/
│       │   ├── Grid.tsx                 — Interactive betting grid
│       │   ├── BetPanel.tsx             — Bet amount + submit
│       │   ├── GameStatus.tsx           — Round phase indicator
│       │   ├── PriceChart.tsx           — Live price feed display
│       │   ├── PlayerName.tsx           — ENS name + avatar
│       │   └── Leaderboard.tsx          — Winners list
│       ├── hooks/
│       │   ├── useYellow.ts             — Yellow SDK channel mgmt
│       │   ├── useBet.ts                — Bet signing via Yellow
│       │   ├── useRound.ts              — Round phase tracking
│       │   └── useENS.ts                — ENS resolution
│       ├── lib/
│       │   ├── yellow.ts                — Yellow SDK setup
│       │   └── payout.ts                — Payout math (shared)
│       └── server/
│           ├── broker.ts                — Broker logic
│           └── keeper.ts                — Price oracle tracker
│
├── .github/
├── foundry.toml
├── package.json                         — Yarn workspaces root
└── README.md
```

---

## 11. Implementation Order

### Phase 1: Smart Contracts
1. Set up Scaffold-ETH 2 with Foundry
2. `Onigo.sol` — `settleRound()`, `claimPlayerPayout()`, `withdrawCommissions()`
3. Contract tests — creating mock contracts, full round lifecycle, edge cases

### Phase 2: Yellow Integration
5. Yellow SDK setup — ClearNode connection, authentication
6. Channel management — open, state updates, resize, close
7. Broker service — co-sign bets, aggregate per round, submit settlement
8. Bet signing flow — cumulative state data, fund allocation updates

### Phase 3: Keeper
9. Price feed polling (Chainlink or similar)
10. Hit cell computation (graph traversal with interpolation)
11. Integration with broker settlement flow

### Phase 4: Frontend
12. Grid UI — interactive cell selection
13. Bet placement via Yellow SDK (gasless)
14. Live price chart during LIVE phase
15. Round phase indicator + countdown
16. Results display after settlement

### Phase 5: ENS
17. ENS name resolution for all player addresses
18. ENS avatars on leaderboard and game UI

### Phase 6: Polish
19. Cross-chain deposit flow via Yellow
20. Deploy to testnet
21. Demo video (2-3 min)

---

## 12. Verification

1. **Contract tests**: `yarn forge:test`
   - Market creation and validation
   - Round settlement with multiple players (broker submits payouts)
   - Commission deduction per player payout
   - Claim flow (claimPlayerPayout, withdrawCommissions)
   - Edge cases: invalid marketId, roundId=0, double settlement, zero claims
2. **Yellow integration test**: channel open → bet → settle → payout → close
3. **Keeper test**: mock price data → correct hit cell computation
4. **E2E test**: full round with frontend → Yellow → broker → contract → claim
5. **ENS test**: display names on testnet with ENS-enabled addresses
