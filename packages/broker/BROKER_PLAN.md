# Broker Service Implementation Plan

## Overview

The broker:
1. Accepts bets from players via Yellow Network (one session per bet)
2. Records bets in memory by round
3. Receives hit cells from keeper when rounds end
4. Computes payouts using parimutuel algorithm
5. Settles on-chain via `Onigo.settleRound()`

## Architecture

```
┌─────────────┐      WebSocket       ┌─────────────┐
│   Players   │ ◄──────────────────► │   Yellow    │
│  (demo.ts)  │   create_app_session │  ClearNode  │
└─────────────┘   close_app_session  └──────┬──────┘
                                            │
                                            │ asu events
                                            ▼
┌─────────────┐      HTTP            ┌─────────────┐
│   Keeper    │ ◄────────────────────│   BROKER    │
│  (hit cells)│   GET /hit-cells     │  (index.ts) │
└─────────────┘                      └──────┬──────┘
                                            │
                                            │ settleRound()
                                            ▼
                                     ┌─────────────┐
                                     │  Onigo.sol  │
                                     │  (on-chain) │
                                     └─────────────┘
```

## Data Flow

1. **Player places bet**: `demo.ts` → Broker WebSocket (port 3001)
2. **Broker co-signs**: Multi-sig `create_app_session` → ClearNode
3. **Auto-close**: Broker calls `close_app_session` with `[player: 0, broker: betAmount]`
4. **Record bet**: Stored in `BetManager` by market/round
5. **Round ends**: Keeper signals → Broker fetches hit cells → computes payouts → settles on-chain

---

## Files to Create

### 1. `packages/broker/src/types.ts`

```typescript
// Core grid cell - matches Onigo.sol GridCell struct
export type GridCell = {
  timeSlotStart: bigint;
  dataRangeStart: bigint;
};

// Single bet within a player's BetData
export type Bet = {
  amount: bigint;
  cells: GridCell[];
};

// BetData - stored per player per round
export type BetData = {
  player: `0x${string}`;
  marketId: number;
  roundId: number;
  totalAmount: bigint;
  bets: Bet[];
};

// RoundBets - all bets for a round
export type RoundBets = {
  marketId: number;
  roundId: number;
  bets: BetData[];
  totalPool: bigint;
};

// Payout result - matches settleRound() contract args
export type PayoutResult = {
  players: `0x${string}`[];
  payouts: bigint[];
  totalPayout: bigint;
};
```

### 2. `packages/broker/src/config.ts`

```typescript
import "dotenv/config";

export const config = {
  BROKER_PRIVATE_KEY: process.env.RECEIVER_PRIVATE_KEY!,
  CLEARNODE_URL: process.env.CLEARNODE_URL ?? "wss://clearnet-sandbox.yellow.com/ws",
  RPC_URL: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  CHAIN_ID: parseInt(process.env.CHAIN_ID ?? "84532"),
  ONIGO_CONTRACT_ADDRESS: process.env.ONIGO_CONTRACT_ADDRESS as `0x${string}`,
  USDC_ADDRESS: process.env.USDC_ADDRESS as `0x${string}`,
  KEEPER_URL: process.env.KEEPER_URL ?? "http://localhost:3002",
  BROKER_API_PORT: parseInt(process.env.BROKER_API_PORT ?? "3001"),
};
```

### 3. `packages/broker/src/payout.ts`

Pure function implementing tech-spec Section 9 parimutuel algorithm:

```typescript
export function computePayouts(
  bets: BetData[],
  hitCells: GridCell[],
  commissionBps: number
): PayoutResult;
```

Algorithm:
1. Total pool = sum of all bet amounts
2. Prize pool = total pool - commission
3. For each player: `winningStake = totalAmount * hitCount / totalCells`
4. Total winning stake = sum of all winning stakes
5. For each winner: `payout = winningStake * prizePool / totalWinningStake`

### 4. `packages/broker/src/betManager.ts`

```typescript
export class BetManager {
  addBet(betData: BetData): void;
  getRoundBets(marketId: number, roundId: number): RoundBets | undefined;
  clearRound(marketId: number, roundId: number): void;
  getActiveRounds(): RoundBets[];
}
```

### 5. `packages/broker/src/settler.ts`

```typescript
export class Settler {
  settleRound(marketId: number, roundId: number, winningCells: GridCell[], payoutResult: PayoutResult): Promise<`0x${string}`>;
  getMarketConfig(marketId: number): Promise<Market>;
}
```

- Uses viem for contract calls
- Handles USDC approval before `settleRound()`
- Waits for tx confirmation

### 6. `packages/broker/src/keeper.ts`

```typescript
export class KeeperClient {
  getHitCells(marketId: number, roundId: number): Promise<GridCell[]>;
  getRoundPhase(marketId: number): Promise<{ roundId: number; phase: string }>;
}
```

### 7. `packages/broker/src/index.ts`

Refactor from `receiver.ts`:
- Extract ClearNode auth flow
- Extract session handling
- Add `BetManager` integration after session close
- Add `settle_round` message handler for manual testing
- Add settlement flow calling `Settler`

---

## Implementation Order

1. **`types.ts`** - No dependencies
2. **`config.ts`** - Environment loading
3. **`payout.ts`** - Pure computation, testable
4. **`betManager.ts`** - In-memory storage
5. **`settler.ts`** - On-chain interaction
6. **`keeper.ts`** - HTTP client
7. **`index.ts`** - Wire everything, refactor from receiver.ts

---

## Key Changes from receiver.ts

| Current (receiver.ts) | New (index.ts) |
|-----------------------|----------------|
| Inline types | Import from `types.ts` |
| Hardcoded config | Import from `config.ts` |
| No bet recording | `betManager.addBet()` after session close |
| No settlement | `settle_round` handler + `settleRound()` flow |
| No keeper integration | `KeeperClient` for hit cells |

---

## Folder Structure

```
packages/broker/
├── src/
│   ├── index.ts        # Main broker entry point
│   ├── types.ts
│   ├── config.ts
│   ├── payout.ts
│   ├── betManager.ts
│   ├── settler.ts
│   └── keeper.ts
└── demo-scripts/
    ├── demo.ts           # Move from src/
    ├── check-balance.ts  # Move from src/
    ├── get-app-sessions.ts # Move from src/
    └── receiver.ts       # Move from src/ (keep as reference)
```

## Critical Files

- [receiver.ts](demo-scripts/receiver.ts) - Source for refactoring
- [demo.ts](demo-scripts/demo.ts) - Test client
- [Onigo.sol](../foundry/contracts/Onigo.sol) - Contract interface

---

## Verification

### Manual Testing Flow

```bash
# Terminal 1: Start local chain
yarn chain

# Terminal 2: Deploy contracts (creates market)
yarn deploy

# Terminal 3: Start broker
yarn dev

# Terminal 4: Place a bet
yarn demo

# Terminal 5: Trigger settlement (via WebSocket or add CLI command)
# Send: { "type": "settle_round", "marketId": 1, "roundId": 1 }
```

### Checklist

- [ ] `yarn dev` starts broker, connects to ClearNode
- [ ] `yarn demo` places bet, session created + auto-closed
- [ ] Bet recorded in BetManager (check logs)
- [ ] `settle_round` computes payouts correctly
- [ ] `settleRound()` tx succeeds on-chain
- [ ] Player can claim via `claimPlayerPayout()`

---

## Environment Variables

```env
# Broker (uses same key as receiver)
RECEIVER_PRIVATE_KEY=0x...

# Yellow Network
CLEARNODE_URL=wss://clearnet-sandbox.yellow.com/ws

# On-chain
RPC_URL=http://127.0.0.1:8545
ONIGO_CONTRACT_ADDRESS=0x...
USDC_ADDRESS=0x...

# Services
KEEPER_URL=http://localhost:3002
BROKER_API_PORT=3001
```

---

## Notes

1. **Keeper not implemented yet**: For testing, can hardcode hit cells or add mock endpoint
2. **One session per bet**: Simplifies flow, avoids cumulative state tracking
3. **In-memory storage**: No persistence - bets lost on restart (acceptable for MVP)
4. **Commission**: Deducted on-chain by contract, not by broker

## Future Enhancements

1. **Recover bets from ClearNode on restart**: Query `get_app_sessions`, decode `sessionData` (contains `BetData` with `roundId`), rebuild bet state. The `RPCAppSession.sessionData` field persists even for closed sessions.
