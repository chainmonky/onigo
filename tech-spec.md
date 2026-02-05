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
│  └────┬─────┘  └────┬─────┘  └─────────┘  └─────┬──────┘    │
│       │              │                           │           │
│  ┌────▼──────────────▼───────────────────┐  ┌────▼───────┐   │
│  │        Yellow SDK (Browser)           │  │  Game WS   │   │
│  │  - Channel management                 │  │  Client    │   │
│  │  - Bet signing (off-chain states)     │  │            │   │
│  │  - WebSocket to ClearNode             │  │  Prices,   │   │
│  └──────────────────┬────────────────────┘  │  hit cells,│   │
│                     │                       │  phases     │   │
│                     │                       └────┬───────┘   │
└─────────────────────┼────────────────────────────┼───────────┘
                      │ WebSocket                  │ WebSocket
                      ▼                            │
┌─────────────────────────────────────────────┐    │
│               YELLOW NETWORK                │    │
│                                             │    │
│  ┌──────────────┐  ┌────────────────────┐   │    │
│  │  ClearNode   │  │ Custody Contract   │   │    │
│  │  (off-chain) ├─►│ (on-chain)         │   │    │
│  │  - Routing   │  │ - Deposits         │   │    │
│  │  - Auth      │  │ - Channel mgmt     │   │    │
│  └──────┬───────┘  └────────────────────┘   │    │
└─────────┼───────────────────────────────────┘    │
          │ WebSocket                              │
          ▼                                        │
┌─────────────────────────────────┐                │
│         BROKER                  │                │
│       (Node.js)                 │                │
│                                 │                │
│  ┌───────────────┐              │                │
│  │ Yellow SDK    │              │                │
│  │ (Server)      │              │                │
│  │ - Co-sign     │              │                │
│  │   bet states  │              │                │
│  │ - Channel     │              │   hit cells    │
│  │   management  │              │◄───────────────┼──────────┐
│  │ - Fund        │              │                │          │
│  │   transfers   │              │                │          │
│  └───────┬───────┘              │                │          │
│          │                      │                │          │
│  ┌───────▼───────┐              │                │          │
│  │ Payout        │              │                │          │
│  │ Calculator    │              │                │          │
│  │ - Aggregate   │              │                │          │
│  │   bets        │              │                │          │
│  │ - Compute     │              │                │          │
│  │   payouts     │              │                │          │
│  │ - Settle      │              │                │          │
│  │   on-chain    │              │                │          │
│  └───────┬───────┘              │                │          │
└──────────┼──────────────────────┘                │          │
           │                                       │          │
           ▼                                       │          │
┌──────────────────────────────┐    ┌──────────────┴──────────┐
│   SMART CONTRACTS (On-Chain) │    │         KEEPER          │
│      (Foundry / Solidity)    │    │       (Node.js)         │
│                              │    │                         │
│  ┌────────────────────────┐  │    │  ┌───────────────────┐  │
│  │      Onigo.sol         │  │    │  │  Price Tracker    │  │
│  │  (Settlement Ledger)   │  │    │  │  - Poll APIs      │  │
│  │                        │  │    │  │  - Compute hit    │  │
│  │  createMarket()        │  │    │  │    cells          │  │
│  │  settleRound()         │  │    │  │  - Interpolation  │  │
│  │  claimPlayerPayout()   │  │    │  └─────────┬─────────┘  │
│  │  withdrawCommissions() │  │    │            │            │
│  └────────────────────────┘  │    │  ┌─────────▼─────────┐  │
│                              │    │  │  WebSocket Server │  │
│                              │    │  │  - ROUND_START    │  │
│                              │    │  │  - PHASE_CHANGE   │  │
│                              │    │  │  - PRICE_UPDATE   │  │
│                              │    │  │  - ROUND_END      │  │
│                              │    │  └───────────────────┘  │
└──────────────────────────────┘    └─────────────────────────┘
```

**Backend is split into two independent services:**

- **Keeper** — Polls price feed APIs, computes hit cells (with interpolation), manages round phases (BETTING → LIVE → SETTLING), and broadcasts real-time updates to frontends via WebSocket. See `onigo-keeper-websocket-spec.md` for full implementation details.
- **Broker** — Receives user funds via Yellow Network state channels, co-signs bets, aggregates bets per round, requests hit cells from the keeper, computes payouts, and settles on-chain via `settleRound()`.

---

## 3. Game Flow (Sequence Diagram)

```
Player          Frontend        Yellow/ClearNode      Broker          Keeper          Contract
  │                │                  │                  │               │               │
  │ ── SETUP (once per session) ────────────────────────────────────────────────────────  │
  │                │                  │                  │               │               │
  │  Connect       │                  │                  │               │               │
  │  wallet ──────►│                  │                  │               │               │
  │                │  Auth request ──►│                  │               │               │
  │                │◄── Challenge ────│                  │               │               │
  │  Sign ◄────────│                  │                  │               │               │
  │  challenge ───►│  Auth verify ───►│                  │               │               │
  │                │◄── Authenticated │                  │               │               │
  │                │                  │                  │               │               │
  │  Deposit       │                  │                  │               │               │
  │  USDC ────────►│ ─── deposit() ──────────────────────────────────────────►│(Custody) │
  │                │                  │                  │               │               │
  │  Open          │  Open channel ──►│  Notify ────────►│               │               │
  │  channel ─────►│◄── Co-signed ─── │◄── Co-sign ──────│               │               │
  │                │                  │                  │               │               │
  │                │  Subscribe ──────────────────────────────────►│               │
  │                │  to market WS    │                  │         (game WS)       │
  │                │                  │                  │               │               │
  │ ── BETTING PHASE (repeats every round) ─────────────────────────────────────────────  │
  │                │                  │                  │               │               │
  │                │◄── ROUND_START ──────────────────────────────│               │
  │                │                  │                  │               │               │
  │  Select cells  │                  │                  │               │               │
  │  + amount ────►│                  │                  │               │               │
  │                │  State update:   │                  │               │               │
  │  Sign ◄────────│  [P:90, B:10]    │                  │               │               │
  │  state ───────►│  data: [bet1] ──►│  Forward ───────►│               │               │
  │                │                  │                  │  Validate     │               │
  │                │                  │◄── Co-sign ──────│  + co-sign    │               │
  │                │◄── Confirmed ────│                  │               │               │
  │                │                  │                  │               │               │
  │  More bets...  │  State update:   │                  │               │               │
  │  (same flow)   │  [P:70, B:30]    │                  │               │               │
  │                │  data: [b1,b2,b3]│                  │  Store        │               │
  │                │                  │                  │  cumulative   │               │
  │                │                  │                  │  bet history  │               │
  │                │                  │                  │               │               │
  │ ── LIVE PHASE ─────────────────────────────────────────────────────────────────────   │
  │                │                  │                  │               │               │
  │                │◄── PHASE_CHANGE (LIVE) ─────────────────────│               │
  │                │                  │                  │               │  Poll price   │
  │                │                  │                  │               │  APIs (1s)    │
  │                │                  │                  │               │               │
  │                │◄── PRICE_UPDATE ─────────────────────────────│  Compute     │
  │                │  (price, hitCells│                  │               │  hit cells    │
  │                │   so far)        │                  │               │  (interpolate)│
  │                │                  │                  │               │               │
  │ ── SETTLING PHASE ─────────────────────────────────────────────────────────────────   │
  │                │                  │                  │               │               │
  │                │◄── ROUND_END (final hitCells) ──────────────│               │
  │                │                  │                  │               │               │
  │                │                  │                  │◄── hitCells ──│               │
  │                │                  │                  │               │               │
  │                │                  │                  │  Compute      │               │
  │                │                  │                  │  payouts      │               │
  │                │                  │                  │               │               │
  │                │                  │                  │  Resize/close │               │
  │                │                  │                  │  channels to  │               │
  │                │                  │                  │  withdraw bet │               │
  │                │                  │                  │  funds───────────────►│(Custody)
  │                │                  │                  │               │               │
  │                │                  │                  │  settleRound()│               │
  │                │                  │                  │  (hitCells +  │               │
  │                │                  │                  │   players +   │               │
  │                │                  │                  │   payouts) ──────────►│       │
  │                │                  │                  │               │               │
  │ ── POST-SETTLEMENT ────────────────────────────────────────────────────────────────   │
  │                │                  │                  │               │               │
  │                │                  │                  │◄── payouts ──────────│        │
  │                │                  │                  │  deposited    │               │
  │                │                  │◄── Update ───────│               │               │
  │                │◄── Channel ──────│  channel states  │               │               │
  │                │    updated       │  with winnings   │               │               │
  │                │                  │                  │               │               │
  │  OR: claim     │                  │                  │               │               │
  │  directly ────►│ ─── claimPlayerPayout() ────────────────────────────────►│          │
  │◄── USDC ───────│◄────────────────────────────────────────────────────────│           │
  │                │                  │                  │               │               │
  │ ── CASH OUT (anytime) ─────────────────────────────────────────────────────────────   │
  │                │                  │                  │               │               │
  │  Close         │  Close channel ─►│  Notify ────────►│               │               │
  │  channel ─────►│                  │◄── Co-sign ──────│               │               │
  │                │ ─── close() ──────────────────────────────────────────────►│(Custody)
  │◄── USDC ───────│◄─────────────────────────────────────────────────────────│          │
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

### 6.2 Broker (Independent Service)

The broker is a separate backend service from the keeper. It manages Yellow Network channels and handles settlement.

**Architecture:**

```
packages/broker/src/
├── index.ts        — Main entry: ClearNode auth, WebSocket API server, event handlers
├── types.ts        — GridCell, Bet, BetData, RoundBets, PayoutResult, BET_DATA_ABI
├── config.ts       — Environment config (BROKER_PRIVATE_KEY, CLEARNODE_URL, etc.)
├── payout.ts       — computePayouts() — parimutuel algorithm from Section 9
├── betManager.ts   — BetManager class — in-memory bet storage by market/round
├── settler.ts      — Settler class — on-chain settlement (USDC approval + settleRound)
└── keeper.ts       — KeeperClient class — HTTP client for hit cells
```

**One Session Per Bet Model:**

Each bet creates a new app session that is immediately auto-closed, transferring funds to the broker:

```typescript
// Player sends create_session request with bet data
// Broker co-signs the session creation
// Session auto-closes with allocations [player: 0, broker: betAmount]
// Bet is recorded in BetManager for later settlement
```

**WebSocket API (port 3001):**

| Message Type | Direction | Description |
|--------------|-----------|-------------|
| `create_session` | Client → Broker | Create app session with bet, broker co-signs |
| `session_created` | Broker → Client | Session created successfully |
| `settle_round` | Client → Broker | Trigger settlement for a round |
| `round_settled` | Broker → Client | Settlement completed with tx hash |
| `get_bets` | Client → Broker | Query current bet state |
| `get_broker_address` | Client → Broker | Get broker's address |

**Settlement Flow:**

```typescript
// broker/src/index.ts — handleSettleRound()

async function handleSettleRound(marketId: number, roundId: number) {
  // 1. Get all bets from BetManager
  const roundBets = betManager.getRoundBets(marketId, roundId);

  // 2. Fetch hit cells from keeper (or use mock if unavailable)
  const hitCells = await keeperClient.getHitCells(marketId, roundId);

  // 3. Get market config for commission rate
  const market = await settler.getMarketConfig(marketId);

  // 4. Compute payouts using parimutuel algorithm
  const payoutResult = computePayouts(roundBets.bets, hitCells, market.commissionBps);

  // 5. Settle on-chain (handles USDC approval automatically)
  const txHash = await settler.settleRound(marketId, roundId, hitCells, payoutResult);

  // 6. Clear round from memory
  betManager.clearRound(marketId, roundId);
}
```

**Payout Computation (payout.ts):**

```typescript
// Implements Section 9 algorithm
function computePayouts(bets: BetData[], hitCells: GridCell[], commissionBps: number): PayoutResult {
  // Step 1: totalPool = sum of all bet amounts
  // Step 2: prizePool = totalPool - commission
  // Step 3: For each bet: winningStake = amount * hitCount / totalCells
  // Step 4: totalWinningStake = sum of winning stakes
  // Step 5: For each winner: payout = winningStake * prizePool / totalWinningStake
  // Edge case: No winners → refund minus commission
}
```

**On-Chain Settlement (settler.ts):**

```typescript
class Settler {
  async settleRound(marketId, roundId, winningCells, payoutResult) {
    // 1. Check/approve USDC allowance for Onigo contract
    // 2. Call Onigo.settleRound() with winning cells, players, payouts
    // 3. Wait for tx confirmation
    return txHash;
  }

  async getMarketConfig(marketId): Promise<Market> {
    // Read market config from contract
  }

  async verifyBrokerRole(): Promise<boolean> {
    // Verify this address is registered as broker
  }
}
```

**Environment Variables:**

```env
RECEIVER_PRIVATE_KEY=0x...      # Broker wallet private key
CLEARNODE_URL=wss://...         # Yellow Network ClearNode
RPC_URL=http://...              # Blockchain RPC
CHAIN_ID=31337                  # Chain ID (31337=local, 84532=Base Sepolia)
ONIGO_CONTRACT_ADDRESS=0x...    # Onigo.sol address
USDC_ADDRESS=0x...              # USDC token address
KEEPER_URL=http://localhost:3002
BROKER_API_PORT=3001
```

**Running the Broker:**

```bash
# Start broker service
yarn dev

# Place a test bet
yarn demo

# Trigger settlement (via WebSocket message)
{ "type": "settle_round", "marketId": 1, "roundId": 1 }
```

**Notes:**

- Bets are stored in memory — lost on restart (MVP limitation)
- Future: Recover bets from ClearNode via `get_app_sessions` + `sessionData` field
- Keeper client has mock fallback for testing without keeper service

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

## 8. Keeper (Independent Service)

The keeper is a standalone backend service, separate from the broker. It is responsible for:

1. **Price feed polling** — Fetches price data from external APIs (Chainlink, Binance, etc.) every 1 second during the LIVE phase
2. **Hit cell computation** — Determines which grid cells the price chart traverses, using linear interpolation between consecutive data points to capture all crossed rows
3. **Round phase management** — Tracks BETTING → LIVE → SETTLING transitions based on market timing config
4. **WebSocket broadcasting** — Sends real-time updates to connected frontends
5. **Hit cell delivery to broker** — Provides final hit cells to the broker for payout computation and on-chain settlement

### 8.1 Core Calculations

```typescript
const effectiveIncrement = market.dataIncrement * Math.pow(10, market.dataPower);

// Price → grid row
function priceToRow(price: number): number {
  return Math.floor(price / effectiveIncrement) * effectiveIncrement;
}

// Timestamp → time slot (0-based column index)
function timestampToTimeSlot(timestamp: number, liveStartTime: number): number {
  return Math.floor((timestamp - liveStartTime) / market.timeSlotWidth);
}

// All rows traversed between two consecutive prices (interpolation)
function getRowsBetween(price1: number, price2: number): number[] {
  const row1 = priceToRow(price1);
  const row2 = priceToRow(price2);
  const rows: number[] = [];
  for (let r = Math.min(row1, row2); r <= Math.max(row1, row2); r += effectiveIncrement) {
    rows.push(r);
  }
  return rows;
}
```

### 8.2 Hit Cell Computation

For each consecutive pair of price points, the keeper computes all traversed rows and assigns them to the relevant time slot(s). When a pair crosses a time slot boundary, traversed rows are assigned to both slots.

```typescript
function computeHitCells(priceHistory: PricePoint[], liveStartTime: number): GridCell[] {
  const hitMap = new Map<string, GridCell>();

  for (let i = 0; i < priceHistory.length; i++) {
    const curr = priceHistory[i];
    const currSlot = timestampToTimeSlot(curr.timestamp, liveStartTime);
    if (currSlot < 0) continue;

    if (i === 0) {
      const row = priceToRow(curr.price);
      hitMap.set(`${currSlot}:${row}`, { timeSlot: currSlot, priceRangeStart: row });
      continue;
    }

    const prev = priceHistory[i - 1];
    const prevSlot = timestampToTimeSlot(prev.timestamp, liveStartTime);
    const rows = getRowsBetween(prev.price, curr.price);

    // Assign to current slot (and previous slot if boundary crossed)
    for (const row of rows) {
      hitMap.set(`${currSlot}:${row}`, { timeSlot: currSlot, priceRangeStart: row });
      if (prevSlot >= 0 && prevSlot !== currSlot) {
        hitMap.set(`${prevSlot}:${row}`, { timeSlot: prevSlot, priceRangeStart: row });
      }
    }
  }

  return Array.from(hitMap.values());
}
```

### 8.3 WebSocket Protocol

The keeper broadcasts the following message types to subscribed frontends:

| Message | When | Payload |
|---------|------|---------|
| `ROUND_START` | New round begins | roundId, timing (roundStart, bettingEnd, liveStart, liveEnd) |
| `PHASE_CHANGE` | Phase transitions | roundId, new phase |
| `PRICE_UPDATE` | Every 1s during LIVE | price, timestamp, timeSlot, hitCells (cumulative) |
| `ROUND_END` | LIVE phase ends | final hitCells, full priceHistory |

Frontends subscribe to a market via `{ type: "SUBSCRIBE", payload: { marketId } }`.

### 8.4 GridCell Conversion (Keeper → Contract)

The keeper uses `timeSlot` (0-based index) and `priceRangeStart` internally. The broker converts these to the contract's `timeSlotStart` (Unix timestamp) and `dataRangeStart` before calling `settleRound()`:

```
timeSlotStart  = liveStartTime + timeSlot * market.timeSlotWidth
dataRangeStart = priceRangeStart
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
│       └── lib/
│           ├── yellow.ts                — Yellow SDK setup
│           └── payout.ts                — Payout math (shared)
│
├── keeper/                              — Keeper service (standalone)
│   ├── src/
│   │   ├── index.ts                     — Entry point (Express + WebSocket server)
│   │   ├── keeper.ts                    — Price tracking, hit cell computation
│   │   ├── priceSource.ts              — Price feed adapters (Chainlink, Binance, mock)
│   │   └── wsServer.ts                 — WebSocket broadcast to frontends
│   └── package.json
│
├── broker/                              — Broker service (standalone)
│   ├── src/
│   │   ├── index.ts                     — Main entry point (ClearNode auth, WebSocket API, bet recording)
│   │   ├── types.ts                     — Shared types (GridCell, Bet, BetData, RoundBets, PayoutResult)
│   │   ├── config.ts                    — Environment configuration
│   │   ├── payout.ts                    — Parimutuel payout computation (Section 9 algorithm)
│   │   ├── betManager.ts                — In-memory bet storage by market/round
│   │   ├── settler.ts                   — On-chain settlement (USDC approval + settleRound)
│   │   └── keeper.ts                    — HTTP client for fetching hit cells from keeper
│   ├── demo-scripts/
│   │   ├── demo.ts                      — Test client for placing bets
│   │   ├── receiver.ts                  — Original receiver (reference implementation)
│   │   ├── check-balance.ts             — Balance checker utility
│   │   └── get-app-sessions.ts          — Session query utility
│   └── package.json
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

### Phase 2: Keeper Service
4. Price feed polling (Chainlink, Binance, or mock source)
5. Hit cell computation (graph traversal with interpolation)
6. WebSocket server — broadcast ROUND_START, PHASE_CHANGE, PRICE_UPDATE, ROUND_END
7. Round phase management (BETTING → LIVE → SETTLING timing)

### Phase 3: Broker Service + Yellow Integration
8. Yellow SDK setup — ClearNode connection, authentication
9. Channel management — open, state updates, resize, close
10. Bet co-signing and validation
11. Payout computation using hit cells from keeper
12. On-chain settlement — GridCell conversion, settleRound() call, USDC approval

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
