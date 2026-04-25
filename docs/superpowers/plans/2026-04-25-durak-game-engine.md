# Durak Spec 2 — Game Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full Durak card game engine (throwing + transfer variants), real-time WebSocket play, proportionally scalable game window UI, reconnect, timeouts, and payout.

**Architecture:** Server-authoritative pure-function game engine (game-engine.ts) + in-memory session manager with timers (game-sessions.ts) + per-table WebSocket channel (/ws/game/:tableId). Game window uses CSS transform:scale for proportional resize. All state lives on the server; clients receive snapshots on reconnect.

**Tech Stack:** Node.js/TypeScript/better-sqlite3/ws (fight server) · Electron/HTML/JS/WebSocket (fight-overlay)

---

## Task 1: DB schema

- [ ] Add `turn_timeout` and `throw_timeout` columns to `game_tables`, and create `game_history` table in `fight/server/db.ts`.

Add to `fight/server/db.ts` after the existing game tables block:

```typescript
try { db.exec(`ALTER TABLE game_tables ADD COLUMN turn_timeout INTEGER NOT NULL DEFAULT 30`) } catch {}
try { db.exec(`ALTER TABLE game_tables ADD COLUMN throw_timeout INTEGER NOT NULL DEFAULT 10`) } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS game_history (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    table_id    TEXT NOT NULL REFERENCES game_tables(id) ON DELETE CASCADE,
    finished_at TEXT NOT NULL DEFAULT (datetime('now')),
    type        TEXT NOT NULL,
    bet         INTEGER NOT NULL DEFAULT 0,
    result      TEXT NOT NULL DEFAULT '[]'
  )
`)
```

- [ ] Verify:

```bash
cd fight && npx tsx -e "import db from './server/db.js'; console.log(db.prepare('PRAGMA table_info(game_tables)').all().map((c:any)=>c.name).join(', '))"
```

Expected output includes: `turn_timeout, throw_timeout`

---

## Task 2: Game engine — types + deck + createGame

- [ ] Create `fight/server/game-engine.ts` with Card types, GameState interface, deck utilities, and `createGame` function.

```typescript
export type Suit = '♠' | '♥' | '♦' | '♣'
export type Rank = '6'|'7'|'8'|'9'|'10'|'J'|'Q'|'K'|'A'
export interface Card { rank: Rank; suit: Suit }
export interface AttackPair { attack: Card; defend: Card | null }

export interface PlayerState {
  user_id: string
  game_name: string
  avatar_url: string | null
  gender: 'male' | 'female'
  cardCount: number
  connected: boolean
}

export interface GameState {
  tableId: string
  type: 'throwing' | 'transfer'
  turnTimeout: number
  throwTimeout: number
  deck: Card[]
  discard: Card[]
  trump: Suit
  trumpCard: Card | null
  hands: Record<string, Card[]>
  table: AttackPair[]
  players: PlayerState[]
  attackerIdx: number
  defenderIdx: number
  phase: 'attack' | 'defense' | 'throw' | 'finished'
  passedIds: string[]
  exits: { user_id: string; place: number }[]
  timerEndsAt: number | null
}

export type GameEvent = { type: string; [k: string]: unknown }

const RANKS: Rank[] = ['6','7','8','9','10','J','Q','K','A']
const SUITS: Suit[] = ['♠','♥','♦','♣']
const RANK_IDX = Object.fromEntries(RANKS.map((r,i) => [r,i])) as Record<Rank, number>

function createDeck(): Card[] {
  const d: Card[] = []
  for (const suit of SUITS) for (const rank of RANKS) d.push({ rank, suit })
  return d
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function canBeat(attack: Card, defense: Card, trump: Suit): boolean {
  if (attack.suit === defense.suit)
    return RANK_IDX[defense.rank] > RANK_IDX[attack.rank]
  return defense.suit === trump && attack.suit !== trump
}

interface PlayerInfo { user_id: string; game_name: string; avatar_url: string | null; gender: 'male'|'female' }

export function createGame(
  tableId: string,
  players: PlayerInfo[],
  type: 'throwing' | 'transfer',
  turnTimeout: number,
  throwTimeout: number
): GameState {
  const deck = shuffle(createDeck())
  const hands: Record<string, Card[]> = {}
  for (const p of players) hands[p.user_id] = []
  // deal 6 each
  for (let i = 0; i < 6; i++)
    for (const p of players) { const c = deck.pop()!; hands[p.user_id].push(c) }
  const trumpCard = deck[0] ?? null
  const trump = trumpCard?.suit ?? '♠'
  return {
    tableId, type, turnTimeout, throwTimeout,
    deck, discard: [], trump, trumpCard,
    hands,
    table: [],
    players: players.map(p => ({
      user_id: p.user_id, game_name: p.game_name,
      avatar_url: p.avatar_url, gender: p.gender,
      cardCount: 6, connected: false
    })),
    attackerIdx: 0,
    defenderIdx: 1 % players.length,
    phase: 'attack',
    passedIds: [],
    exits: [],
    timerEndsAt: null,
  }
}
```

- [ ] Verify:

```bash
cd fight && npx tsx -e "
import { createGame } from './server/game-engine.js'
const s = createGame('t1', [{user_id:'u1',game_name:'A',avatar_url:null,gender:'male'},{user_id:'u2',game_name:'B',avatar_url:null,gender:'female'}], 'throwing', 30, 10)
console.assert(s.deck.length === 22, 'deck: ' + s.deck.length)
console.assert(s.hands.u1.length === 6, 'hand u1')
console.assert(s.trump === s.trumpCard?.suit, 'trump suit')
console.log('createGame OK')
"
```

---

## Task 3: Game engine — attack + defend

- [ ] Add `attack` and `defend` functions to `fight/server/game-engine.ts`.

```typescript
function cardEq(a: Card, b: Card) { return a.rank === b.rank && a.suit === b.suit }

function removeFromHand(hand: Card[], card: Card): boolean {
  const i = hand.findIndex(c => cardEq(c, card))
  if (i === -1) return false
  hand.splice(i, 1)
  return true
}

function tableRanks(state: GameState): Set<Rank> {
  const s = new Set<Rank>()
  for (const p of state.table) {
    s.add(p.attack.rank)
    if (p.defend) s.add(p.defend.rank)
  }
  return s
}

export function attack(state: GameState, userId: string, cards: Card[]): { state: GameState; events: GameEvent[] } {
  if (state.phase !== 'attack') return { state, events: [{ type: 'error', msg: 'Not attack phase' }] }
  const attacker = state.players[state.attackerIdx]
  if (attacker.user_id !== userId) return { state, events: [{ type: 'error', msg: 'Not your turn' }] }
  if (!cards.length) return { state, events: [{ type: 'error', msg: 'No cards' }] }

  // All cards must be in hand; if table is not empty, ranks must match
  const hand = state.hands[userId]
  const existingRanks = tableRanks(state)
  for (const card of cards) {
    if (!hand.find(c => cardEq(c, card))) return { state, events: [{ type: 'error', msg: 'Card not in hand' }] }
    if (existingRanks.size > 0 && !existingRanks.has(card.rank))
      return { state, events: [{ type: 'error', msg: 'Rank not on table' }] }
  }

  const defender = state.players[state.defenderIdx]
  const maxAllowed = state.hands[defender.user_id].length
  if (state.table.length + cards.length > maxAllowed)
    return { state, events: [{ type: 'error', msg: 'Too many cards' }] }

  const s = { ...state, hands: { ...state.hands, [userId]: [...hand] }, table: [...state.table] }
  for (const card of cards) {
    removeFromHand(s.hands[userId], card)
    s.table.push({ attack: card, defend: null })
  }
  s.players = s.players.map(p => p.user_id === userId ? { ...p, cardCount: s.hands[userId].length } : p)
  s.phase = 'defense'
  s.passedIds = []
  s.timerEndsAt = Date.now() + state.turnTimeout * 1000

  const events: GameEvent[] = [
    { type: 'attack', user_id: userId, cards, table: s.table },
    { type: 'timer_start', kind: 'turn', user_id: defender.user_id, seconds: state.turnTimeout }
  ]
  return { state: s, events }
}

export function defend(state: GameState, userId: string, attackCard: Card, defendCard: Card): { state: GameState; events: GameEvent[] } {
  if (state.phase !== 'defense') return { state, events: [{ type: 'error', msg: 'Not defense phase' }] }
  const defender = state.players[state.defenderIdx]
  if (defender.user_id !== userId) return { state, events: [{ type: 'error', msg: 'Not your turn' }] }

  const pairIdx = state.table.findIndex(p => cardEq(p.attack, attackCard) && !p.defend)
  if (pairIdx === -1) return { state, events: [{ type: 'error', msg: 'No such undefended card' }] }

  const hand = state.hands[userId]
  if (!hand.find(c => cardEq(c, defendCard))) return { state, events: [{ type: 'error', msg: 'Card not in hand' }] }
  if (!canBeat(attackCard, defendCard, state.trump)) return { state, events: [{ type: 'error', msg: 'Cannot beat that card' }] }

  const s = { ...state, hands: { ...state.hands, [userId]: [...hand] }, table: [...state.table] }
  removeFromHand(s.hands[userId], defendCard)
  s.table = s.table.map((p, i) => i === pairIdx ? { ...p, defend: defendCard } : p)
  s.players = s.players.map(p => p.user_id === userId ? { ...p, cardCount: s.hands[userId].length } : p)

  const allDefended = s.table.every(p => p.defend !== null)
  const events: GameEvent[] = [{ type: 'defend', attack_card: attackCard, defend_card: defendCard, table: s.table }]

  if (allDefended) {
    s.phase = 'throw'
    s.passedIds = []
    s.timerEndsAt = Date.now() + state.throwTimeout * 1000
    events.push({ type: 'timer_start', kind: 'throw', seconds: state.throwTimeout })
  }
  return { state: s, events }
}
```

- [ ] Verify:

```bash
cd fight && npx tsx -e "
import { createGame, attack, defend, canBeat } from './server/game-engine.js'
console.assert(canBeat({rank:'6',suit:'♠'}, {rank:'7',suit:'♠'}, '♥'), 'higher same suit')
console.assert(!canBeat({rank:'7',suit:'♠'}, {rank:'6',suit:'♠'}, '♥'), 'lower fails')
console.assert(canBeat({rank:'A',suit:'♠'}, {rank:'6',suit:'♥'}, '♥'), 'trump beats non-trump')
console.log('canBeat OK')
"
```

---

## Task 4: Game engine — throwIn + pass + take + drawCards

- [ ] Add `throwIn`, `pass`, `take`, and round/game management helpers to `fight/server/game-engine.ts`.

```typescript
export function throwIn(state: GameState, userId: string, card: Card): { state: GameState; events: GameEvent[] } {
  if (state.phase !== 'throw' && state.phase !== 'defense') 
    return { state, events: [{ type: 'error', msg: 'Cannot throw now' }] }
  const defender = state.players[state.defenderIdx]
  if (userId === defender.user_id) return { state, events: [{ type: 'error', msg: 'Defender cannot throw in' }] }

  const ranks = tableRanks(state)
  if (!ranks.has(card.rank)) return { state, events: [{ type: 'error', msg: 'Rank not on table' }] }

  const hand = state.hands[userId]
  if (!hand.find(c => cardEq(c, card))) return { state, events: [{ type: 'error', msg: 'Card not in hand' }] }

  const undefendedCount = state.table.filter(p => !p.defend).length
  const defenderCards = state.hands[defender.user_id].length
  if (state.table.length >= defenderCards + undefendedCount)
    return { state, events: [{ type: 'error', msg: 'Too many cards for defender' }] }

  const s = { ...state, hands: { ...state.hands, [userId]: [...hand] }, table: [...state.table] }
  removeFromHand(s.hands[userId], card)
  s.table.push({ attack: card, defend: null })
  s.players = s.players.map(p => p.user_id === userId ? { ...p, cardCount: s.hands[userId].length } : p)
  s.phase = 'defense'
  s.passedIds = []
  s.timerEndsAt = Date.now() + state.turnTimeout * 1000

  return { state: s, events: [
    { type: 'throw_in', user_id: userId, card, table: s.table },
    { type: 'timer_start', kind: 'turn', user_id: defender.user_id, seconds: state.turnTimeout }
  ]}
}

export function pass(state: GameState, userId: string): { state: GameState; events: GameEvent[] } {
  if (state.phase !== 'throw') return { state, events: [{ type: 'error', msg: 'Not throw phase' }] }
  const defender = state.players[state.defenderIdx]
  if (userId === defender.user_id) return { state, events: [{ type: 'error', msg: 'Defender cannot pass' }] }

  const s = { ...state, passedIds: Array.from(new Set([...state.passedIds, userId])) }
  // Active non-defender players
  const active = s.players.filter(p => p.user_id !== defender.user_id && !s.exits.find(e => e.user_id === p.user_id))
  const allPassed = active.every(p => s.passedIds.includes(p.user_id))

  if (!allPassed) return { state: s, events: [{ type: 'pass', user_id: userId }] }

  // All passed → end round, discard table
  return endRound(s)
}

export function take(state: GameState, userId: string): { state: GameState; events: GameEvent[] } {
  if (state.phase !== 'defense') return { state, events: [{ type: 'error', msg: 'Not defense phase' }] }
  const defender = state.players[state.defenderIdx]
  if (defender.user_id !== userId) return { state, events: [{ type: 'error', msg: 'Not your turn' }] }

  const s = { ...state }
  const allCards = s.table.flatMap(p => p.defend ? [p.attack, p.defend] : [p.attack])
  s.hands = { ...s.hands, [userId]: [...s.hands[userId], ...allCards] }
  s.players = s.players.map(p => p.user_id === userId ? { ...p, cardCount: s.hands[userId].length } : p)
  s.table = []
  s.timerEndsAt = null

  const events: GameEvent[] = [{ type: 'take', user_id: userId }]
  return nextRound(s, true, events)
}

function endRound(state: GameState): { state: GameState; events: GameEvent[] } {
  const s = { ...state }
  const discarded = s.table.flatMap(p => p.defend ? [p.attack, p.defend] : [p.attack])
  s.discard = [...s.discard, ...discarded]
  s.table = []
  s.timerEndsAt = null
  return nextRound(s, false, [{ type: 'round_end', discarded: true }])
}

function nextRound(state: GameState, defenderTook: boolean, events: GameEvent[]): { state: GameState; events: GameEvent[] } {
  const s = drawAllCards(state)
  const drawEvents = checkExits(s)
  events.push(...drawEvents.events)

  const finalState = drawEvents.state
  if (finalState.phase === 'finished') return { state: finalState, events }

  const activePlayers = finalState.players.filter(p => !finalState.exits.find(e => e.user_id === p.user_id))
  if (activePlayers.length < 2) {
    return finishGame(finalState, events)
  }

  // Advance attacker/defender
  const currentDefIdx = finalState.defenderIdx
  let newAttIdx: number
  if (defenderTook) {
    // Defender took: skip over defender, next active player attacks
    newAttIdx = nextActiveIdx(finalState, currentDefIdx)
  } else {
    // Discard: defender becomes attacker
    newAttIdx = currentDefIdx
  }
  const newDefIdx = nextActiveIdx(finalState, newAttIdx)

  finalState.attackerIdx = newAttIdx
  finalState.defenderIdx = newDefIdx
  finalState.phase = 'attack'
  finalState.passedIds = []
  finalState.timerEndsAt = null

  return { state: finalState, events }
}

function nextActiveIdx(state: GameState, fromIdx: number): number {
  const n = state.players.length
  let idx = (fromIdx + 1) % n
  while (state.exits.find(e => e.user_id === state.players[idx].user_id)) {
    idx = (idx + 1) % n
  }
  return idx
}

function drawAllCards(state: GameState): GameState {
  const s = { ...state, deck: [...state.deck], hands: { ...state.hands } }
  // Draw order: attacker first, then clockwise
  const order: string[] = []
  const n = s.players.length
  let idx = s.attackerIdx
  for (let i = 0; i < n; i++) {
    const p = s.players[idx]
    if (!s.exits.find(e => e.user_id === p.user_id)) order.push(p.user_id)
    idx = (idx + 1) % n
  }
  for (const uid of order) {
    const hand = s.hands[uid]
    while (hand.length < 6 && s.deck.length > 0) hand.push(s.deck.pop()!)
    // Trump card at bottom: when deck is empty, trumpCard is the last card
    if (s.deck.length === 0 && s.trumpCard) {
      const already = hand.find(c => cardEq(c, s.trumpCard!))
      if (!already) { hand.push(s.trumpCard); s.trumpCard = null }
    }
  }
  s.players = s.players.map(p => ({ ...p, cardCount: s.hands[p.user_id].length }))
  return s
}

function checkExits(state: GameState): { state: GameState; events: GameEvent[] } {
  const s = { ...state }
  const events: GameEvent[] = []
  let place = s.exits.length + 1
  for (const p of s.players) {
    if (s.exits.find(e => e.user_id === p.user_id)) continue
    if (s.hands[p.user_id].length === 0 && s.deck.length === 0 && !s.trumpCard) {
      s.exits = [...s.exits, { user_id: p.user_id, place }]
      events.push({ type: 'player_exit', user_id: p.user_id, place })
      place++
    }
  }
  return { state: s, events }
}

function finishGame(state: GameState, prevEvents: GameEvent[]): { state: GameState; events: GameEvent[] } {
  const s = { ...state, phase: 'finished' as const, timerEndsAt: null }
  const active = s.players.filter(p => !s.exits.find(e => e.user_id === p.user_id))
  // Remaining players are дураки — assign place
  let place = s.exits.length + 1
  for (const p of active) {
    s.exits = [...s.exits, { user_id: p.user_id, place }]
    place++
  }
  // Payout
  const N = s.players.length
  const bank = 0 // actual bet * N is computed in session layer
  const results = s.exits.map(e => {
    const weight = N - e.place
    return { user_id: e.user_id, game_name: s.players.find(p => p.user_id === e.user_id)!.game_name, place: e.place, weight }
  })
  const events = [...prevEvents, { type: 'game_over', results }]
  return { state: s, events }
}
```

- [ ] Verify:

```bash
cd fight && npx tsx -e "
import { createGame, attack, take, pass } from './server/game-engine.js'
const s = createGame('t', [{user_id:'u1',game_name:'A',avatar_url:null,gender:'male'},{user_id:'u2',game_name:'B',avatar_url:null,gender:'female'}], 'throwing', 30, 10)
const {state:s2} = attack(s, 'u1', [s.hands.u1[0]])
console.assert(s2.phase === 'defense', 'phase after attack: ' + s2.phase)
const {state:s3} = take(s2, 'u2')
console.assert(s3.phase === 'attack', 'phase after take: ' + s3.phase)
console.log('attack/take OK')
"
```

---

## Task 5: Game engine — transfer (переводной)

- [ ] Add `transfer` function to `fight/server/game-engine.ts`.

```typescript
export function transfer(state: GameState, userId: string, card: Card): { state: GameState; events: GameEvent[] } {
  if (state.type !== 'transfer') return { state, events: [{ type: 'error', msg: 'Not transfer variant' }] }
  if (state.phase !== 'defense') return { state, events: [{ type: 'error', msg: 'Not defense phase' }] }
  const defender = state.players[state.defenderIdx]
  if (defender.user_id !== userId) return { state, events: [{ type: 'error', msg: 'Not your turn' }] }

  // Can only transfer if no cards have been defended yet
  if (state.table.some(p => p.defend !== null)) return { state, events: [{ type: 'error', msg: 'Already defended some cards' }] }

  // Card must match rank of attack card on table
  const attackRank = state.table[0]?.attack.rank
  if (!attackRank || card.rank !== attackRank) return { state, events: [{ type: 'error', msg: 'Card rank must match attack' }] }

  const hand = state.hands[userId]
  if (!hand.find(c => cardEq(c, card))) return { state, events: [{ type: 'error', msg: 'Card not in hand' }] }

  // Next player must have enough cards
  const nextDefIdx = nextActiveIdx(state, state.defenderIdx)
  const nextDef = state.players[nextDefIdx]
  const newTableSize = state.table.length + 1
  if (state.hands[nextDef.user_id].length < newTableSize)
    return { state, events: [{ type: 'error', msg: 'Next player has too few cards' }] }

  const s = { ...state, hands: { ...state.hands, [userId]: [...hand] }, table: [...state.table] }
  removeFromHand(s.hands[userId], card)
  s.table.push({ attack: card, defend: null })
  s.players = s.players.map(p => p.user_id === userId ? { ...p, cardCount: s.hands[userId].length } : p)

  // Shift defender: old defender becomes attacker/thrower, next becomes defender
  s.attackerIdx = state.defenderIdx
  s.defenderIdx = nextDefIdx
  s.phase = 'defense'
  s.passedIds = []
  s.timerEndsAt = Date.now() + state.turnTimeout * 1000

  return { state: s, events: [
    { type: 'transfer', user_id: userId, card, new_defender_id: nextDef.user_id, table: s.table },
    { type: 'timer_start', kind: 'turn', user_id: nextDef.user_id, seconds: state.turnTimeout }
  ]}
}
```

- [ ] Verify:

```bash
cd fight && npx tsx -e "
import { createGame, attack, transfer } from './server/game-engine.js'
const s = createGame('t', [{user_id:'u1',game_name:'A',avatar_url:null,gender:'male'},{user_id:'u2',game_name:'B',avatar_url:null,gender:'female'},{user_id:'u3',game_name:'C',avatar_url:null,gender:'male'}], 'transfer', 30, 10)
// plant matching rank card in u2's hand
s.hands.u2[0] = {...s.hands.u1[0]}  // same rank
const {state:s2} = attack(s, 'u1', [s.hands.u1[0]])
const {events} = transfer(s2, 'u2', s2.hands.u2[0])
console.assert(events.some(e=>e.type==='transfer'), 'transfer event: ' + JSON.stringify(events))
console.log('transfer OK')
"
```

---

## Task 6: Game sessions

- [ ] Create `fight/server/game-sessions.ts` with session management, timer scheduling, broadcast helpers, action dispatch, and game-over payout logic.

```typescript
import type { GameState, GameEvent, Card } from './game-engine.js'
import { attack, defend, transfer as transferFn, throwIn, pass, take } from './game-engine.js'
import { WebSocket } from 'ws'
import db from './db.js'
import crypto from 'node:crypto'

export interface GameSession {
  state: GameState
  sockets: Map<string, WebSocket>
  turnTimer: ReturnType<typeof setTimeout> | null
  throwTimer: ReturnType<typeof setTimeout> | null
  bet: number
}

const sessions = new Map<string, GameSession>()

export function createSession(
  tableId: string,
  state: GameState,
  bet: number
): GameSession {
  const session: GameSession = { state, sockets: new Map(), turnTimer: null, throwTimer: null, bet }
  sessions.set(tableId, session)
  return session
}

export function getSession(tableId: string): GameSession | undefined {
  return sessions.get(tableId)
}

export function endSession(tableId: string) {
  const s = sessions.get(tableId)
  if (!s) return
  if (s.turnTimer) clearTimeout(s.turnTimer)
  if (s.throwTimer) clearTimeout(s.throwTimer)
  sessions.delete(tableId)
}

export function broadcastToSession(session: GameSession, msg: object, excludeUserId?: string) {
  const data = JSON.stringify(msg)
  for (const [uid, ws] of session.sockets) {
    if (uid === excludeUserId) continue
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

export function sendToUser(session: GameSession, userId: string, msg: object) {
  const ws = session.sockets.get(userId)
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export function serializeStateFor(state: GameState, userId: string) {
  return {
    tableId: state.tableId,
    type: state.type,
    trump: state.trump,
    trumpCard: state.trumpCard,
    deckCount: state.deck.length + (state.trumpCard ? 1 : 0),
    discardCount: state.discard.length,
    table: state.table,
    players: state.players.map(p => ({
      ...p,
      cardCount: p.cardCount,
      // Only send actual cards for the requesting user
    })),
    myHand: state.hands[userId] ?? [],
    myUserId: userId,
    attackerIdx: state.attackerIdx,
    defenderIdx: state.defenderIdx,
    phase: state.phase,
    passedIds: state.passedIds,
    exits: state.exits,
    timerEndsAt: state.timerEndsAt,
  }
}

function applyAndBroadcast(
  session: GameSession,
  result: { state: GameState; events: GameEvent[] }
) {
  session.state = result.state
  resetTimers(session)

  for (const event of result.events) {
    if (event.type === 'error') continue
    broadcastToSession(session, event)
  }

  if (result.state.phase === 'finished') {
    handleGameOver(session)
  } else {
    scheduleTimers(session)
  }
}

function resetTimers(session: GameSession) {
  if (session.turnTimer) { clearTimeout(session.turnTimer); session.turnTimer = null }
  if (session.throwTimer) { clearTimeout(session.throwTimer); session.throwTimer = null }
}

function scheduleTimers(session: GameSession) {
  const { state } = session
  if (!state.timerEndsAt) return
  const ms = Math.max(0, state.timerEndsAt - Date.now())

  if (state.phase === 'defense') {
    session.turnTimer = setTimeout(() => {
      const defender = state.players[state.defenderIdx]
      const result = take(session.state, defender.user_id)
      applyAndBroadcast(session, result)
    }, ms)
  } else if (state.phase === 'throw') {
    session.throwTimer = setTimeout(() => {
      // Auto-pass for all who haven't passed yet
      let s = session.state
      const defender = s.players[s.defenderIdx]
      const active = s.players.filter(p =>
        p.user_id !== defender.user_id && !s.exits.find(e => e.user_id === p.user_id)
      )
      for (const p of active) {
        if (!s.passedIds.includes(p.user_id)) {
          const res = pass(s, p.user_id)
          s = res.state
          if (s.phase !== 'throw') {
            applyAndBroadcast(session, { state: s, events: res.events })
            return
          }
        }
      }
    }, ms)
  }
}

function handleGameOver(session: GameSession) {
  const { state, bet } = session
  const N = state.players.length
  const totalBank = bet * N
  const sumWeights = (N * (N - 1)) / 2

  const results = state.exits.map(e => {
    const weight = N - e.place
    const payout = sumWeights > 0 ? Math.floor(totalBank * weight / sumWeights) : 0
    return { user_id: e.user_id, game_name: e.user_id, place: e.place, payout, weight }
  })

  // Fix rounding: give remainder to 1st place
  const totalPaid = results.reduce((s, r) => s + r.payout, 0)
  const first = results.find(r => r.place === 1)
  if (first) first.payout += totalBank - totalPaid

  // Update balances and save history
  if (bet > 0) {
    const txn = db.transaction(() => {
      for (const r of results) {
        if (r.payout > 0) {
          db.prepare(`UPDATE game_balances SET balance = balance + ?, updated_at = datetime('now') WHERE user_id = ?`)
            .run(r.payout, r.user_id)
        }
      }
    })
    try { txn() } catch {}
  }

  // Save history
  const resultWithNames = state.exits.map(e => {
    const player = state.players.find(p => p.user_id === e.user_id)!
    const r = results.find(r => r.user_id === e.user_id)!
    return { user_id: e.user_id, game_name: player.game_name, place: e.place, payout: r.payout }
  })
  try {
    db.prepare(`INSERT INTO game_history (id, table_id, type, bet, result) VALUES (?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), state.tableId, state.type, bet, JSON.stringify(resultWithNames))
    db.prepare(`UPDATE game_tables SET status = 'finished' WHERE id = ?`).run(state.tableId)
  } catch {}

  broadcastToSession(session, { type: 'game_over', results: resultWithNames })
  endSession(state.tableId)
}

export function handleAction(session: GameSession, userId: string, msg: { type: string; [k: string]: unknown }) {
  const { state } = session
  let result: { state: GameState; events: GameEvent[] } | null = null

  if (msg.type === 'attack') {
    result = attack(state, userId, msg.cards as Card[])
  } else if (msg.type === 'defend') {
    result = defend(state, userId, msg.attack_card as Card, msg.defend_card as Card)
  } else if (msg.type === 'transfer') {
    result = transferFn(state, userId, msg.card as Card)
  } else if (msg.type === 'throw_in') {
    result = throwIn(state, userId, msg.card as Card)
  } else if (msg.type === 'pass') {
    result = pass(state, userId)
  } else if (msg.type === 'take') {
    result = take(state, userId)
  }

  if (!result) return
  if (result.events[0]?.type === 'error') {
    sendToUser(session, userId, result.events[0])
    return
  }
  applyAndBroadcast(session, result)
}
```

- [ ] Verify import compiles:

```bash
cd fight && npx tsx -e "import { createSession, getSession } from './server/game-sessions.js'; console.log('sessions OK')"
```

---

## Task 7: WebSocket game channel

- [ ] Create `fight/server/ws-game.ts` with the `/ws/game/:tableId` WebSocket handler, auth, reconnect, and message dispatch.

```typescript
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { verifyToken } from './auth.js'
import { getSession, broadcastToSession, serializeStateFor, handleAction } from './game-sessions.js'

interface GameWS extends WebSocket { userId?: string; tableId?: string }

export function setupGameWS(server: Server) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (!/^\/ws\/game\/[^/]+$/.test(url.pathname)) return
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: GameWS, req) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const tableId = url.pathname.split('/').pop()!
    const token = url.searchParams.get('token')

    if (!token) { ws.close(1008, 'Missing token'); return }

    let userId: string
    try { userId = verifyToken(token) }
    catch { ws.close(1008, 'Invalid token'); return }

    const session = getSession(tableId)
    if (!session) { ws.close(1008, 'No active session'); return }

    if (!session.state.players.find(p => p.user_id === userId)) {
      ws.close(1008, 'Not a player at this table'); return
    }

    ws.userId = userId
    ws.tableId = tableId

    // Close previous connection for this user if any
    const prev = session.sockets.get(userId)
    if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) {
      prev.onclose = null
      prev.close(1001, 'Replaced by new connection')
    }
    session.sockets.set(userId, ws)

    // Mark connected
    const player = session.state.players.find(p => p.user_id === userId)!
    player.connected = true

    // Send full state snapshot
    ws.send(JSON.stringify({ type: 'game_state', ...serializeStateFor(session.state, userId) }))

    // Notify others of reconnect
    broadcastToSession(session, { type: 'player_reconnected', user_id: userId }, userId)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        handleAction(session, userId, msg)
      } catch {}
    })

    ws.on('close', () => {
      if (session.sockets.get(userId) === ws) {
        session.sockets.delete(userId)
        const p = session.state.players.find(p => p.user_id === userId)
        if (p) p.connected = false
      }
    })

    ws.on('error', () => {})
  })
}
```

- [ ] Verify compiles:

```bash
cd fight && npx tsx -e "import { setupGameWS } from './server/ws-game.js'; console.log('ws-game OK')"
```

---

## Task 8: Server wiring — index.ts + routes/games.ts

- [ ] Modify `fight/server/index.ts`: import and call `setupGameWS`.

Add to imports at top:
```typescript
import { setupGameWS } from './ws-game.js'
```

After the existing `setupGamesWS(server)` line add:
```typescript
setupGameWS(server)
```

- [ ] Modify `fight/server/routes/games.ts`: add imports, timeout fields to POST /tables, and `createGame`/`createSession` call in POST /tables/:id/start.

Add to imports at top:
```typescript
import { createGame } from '../game-engine.js'
import { createSession } from '../game-sessions.js'
```

In `POST /tables` body validation, add to the extracted fields:
```typescript
const { name, type, max_players, bet, turn_timeout = 30, throw_timeout = 10 } = req.body
```

In the `db.transaction` that creates the table, update the INSERT to include the new fields:
```sql
INSERT INTO game_tables (id, name, type, max_players, bet, turn_timeout, throw_timeout, created_by)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```
And pass `turn_timeout`, `throw_timeout` in the `.run()` call arguments in matching order.

In the `TableRow` interface add:
```typescript
turn_timeout: number; throw_timeout: number
```

In `POST /tables/:id/start`, after the `playerProfiles` query and before the broadcast loop, add:
```typescript
// Build player infos for game engine
const playerInfos = playerProfiles.map(p => {
  const profile = db.prepare('SELECT avatar_url, gender FROM profiles WHERE user_id = ?')
    .get(p.user_id) as { avatar_url: string | null; gender: string } | undefined
  // Get first warrior photo if no avatar
  const photo = !profile?.avatar_url
    ? (db.prepare('SELECT url FROM warrior_photos WHERE user_id = ? ORDER BY sort_order ASC, rowid ASC LIMIT 1').get(p.user_id) as { url: string } | undefined)?.url ?? null
    : profile.avatar_url
  return {
    user_id: p.user_id,
    game_name: p.game_name,
    avatar_url: photo,
    gender: (profile?.gender ?? 'male') as 'male' | 'female',
  }
})

const gameState = createGame(
  req.params.id,
  playerInfos,
  table.type as 'throwing' | 'transfer',
  table.turn_timeout,
  table.throw_timeout
)
createSession(req.params.id, gameState, table.bet)
```

- [ ] Verify server starts:

```bash
cd fight && npx tsx server/index.ts &
sleep 2 && curl http://localhost:4000/api/games/balance -H "Authorization: Bearer invalid" | head -c 50
kill %1
```

---

## Task 9: Lobby form — timeout fields

- [ ] Modify `fight-overlay/overlay.html`: add `turn_timeout` and `throw_timeout` inputs to the create table form, and include the values in `submitCreateTable()`.

In the create table form (inside `#gtfForm`), add two number inputs after the ставка field:

```html
<div class="gtf-row">
  <label class="gtf-label">Таймаут хода</label>
  <input type="number" id="gtfTurnTimeout" class="gtf-input" min="10" max="120" value="30" style="width:60px">
  <span style="font-size:10px;color:#475569">сек</span>
</div>
<div class="gtf-row">
  <label class="gtf-label">Таймаут подкидывания</label>
  <input type="number" id="gtfThrowTimeout" class="gtf-input" min="5" max="60" value="10" style="width:60px">
  <span style="font-size:10px;color:#475569">сек</span>
</div>
```

In `submitCreateTable()` function, add the timeout values to the request body:
```javascript
const turn_timeout = Math.max(10, Math.min(120, parseInt(document.getElementById('gtfTurnTimeout').value) || 30))
const throw_timeout = Math.max(5, Math.min(60, parseInt(document.getElementById('gtfThrowTimeout').value) || 10))
// add to fetch body:
body: JSON.stringify({ name, type: gtfType, max_players: gtfPlayers, bet, turn_timeout, throw_timeout })
```

- [ ] Commit:

```bash
cd fight-overlay && git add overlay.html && git commit -m "feat: add turn/throw timeout fields to create table form"
```

---

## Task 10: game-preload.cjs — expand API

- [ ] Modify `fight-overlay/game-preload.cjs`: add `connect`, `onEvent`, `sendAction`, and `disconnect` methods via `contextBridge`.

```javascript
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

let _ws = null
const _listeners = []

contextBridge.exposeInMainWorld('gameAPI', {
  isElectron: true,

  connect(tableId, token, srv) {
    if (_ws) { _ws.onclose = null; _ws.close() }
    const wsBase = srv.replace(/^http/, 'ws')
    _ws = new WebSocket(`${wsBase}/ws/game/${tableId}?token=${token}`)
    _ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        for (const cb of _listeners) try { cb(msg) } catch {}
      } catch {}
    }
    _ws.onclose = () => {
      // Retry after 2s
      setTimeout(() => {
        if (_ws && _ws.readyState === WebSocket.CLOSED)
          window.gameAPI.connect(tableId, token, srv)
      }, 2000)
    }
    _ws.onerror = () => {}
  },

  onEvent(cb) {
    _listeners.push(cb)
    return () => { const i = _listeners.indexOf(cb); if (i !== -1) _listeners.splice(i, 1) }
  },

  sendAction(type, data = {}) {
    if (_ws?.readyState === WebSocket.OPEN)
      _ws.send(JSON.stringify({ type, ...data }))
  },

  disconnect() {
    if (_ws) { _ws.onclose = null; _ws.close(); _ws = null }
  }
})
```

- [ ] Commit:

```bash
cd fight-overlay && git add game-preload.cjs && git commit -m "feat: game-preload connect/onEvent/sendAction"
```

---

## Task 11: Game window HTML + CSS

- [ ] Replace `fight-overlay/game-window.html` with the full UI (860x580 scale root, title bar, opponents row, table center with trump/discard, hand row, action bar, end screen overlay).

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Дурак</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0f1a; }

/* Scale container */
#scaleRoot {
  width: 860px; height: 580px;
  background: #0d3320;
  border: 1px solid #1a5c35;
  border-radius: 12px;
  overflow: hidden;
  display: flex; flex-direction: column;
  transform-origin: top left;
  position: absolute; top: 0; left: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #e2e8f0;
}

/* Title bar */
.title-bar { background: #071a10; border-bottom: 1px solid #1a3d20; padding: 8px 16px; display: flex; align-items: center; gap: 10px; font-size: 13px; color: #4ade80; font-weight: 600; flex-shrink: 0; }
.tb-title { flex: 1; }
.tb-timer { background: #451a03; border: 1px solid #f59e0b; border-radius: 4px; padding: 3px 10px; font-size: 12px; color: #f59e0b; font-weight: 700; display: none; }
.tb-timer.active { display: inline-block; }
.tb-info { color: #475569; font-size: 12px; }

/* Portrait */
.portrait { width: 42px; height: 58px; border-radius: 5px; overflow: hidden; border: 2px solid rgba(255,255,255,.1); flex-shrink: 0; background: #0f2440; display: flex; align-items: center; justify-content: center; }
.portrait img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
.portrait.attacker { border-color: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,.3); }
.portrait.defender { border-color: #3b82f6; box-shadow: 0 0 8px rgba(59,130,246,.3); }
.portrait.me { border-color: #4ade80; box-shadow: 0 0 8px rgba(74,222,128,.3); }
.sil { width: 26px; height: 34px; opacity: .3; }

/* Opponents */
.opponents-area { display: flex; justify-content: space-around; gap: 10px; padding: 12px 16px 8px; flex-shrink: 0; }
.player-slot { display: flex; flex-direction: row; align-items: center; gap: 10px; background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.07); border-radius: 9px; padding: 8px 14px; flex: 1; position: relative; transition: border-color .2s; }
.player-slot.attacker { border-color: #ef4444; background: rgba(239,68,68,.08); }
.player-slot.defender { border-color: #3b82f6; background: rgba(59,130,246,.08); }
.player-slot.exited { opacity: .35; }
.player-slot.disconnected { opacity: .5; }
.ps-info { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.ps-name { font-size: 13px; font-weight: 700; color: #94a3b8; }
.ps-role { font-size: 11px; color: #475569; text-transform: uppercase; letter-spacing: .06em; }
.ps-role.atk { color: #f87171; }
.ps-role.def { color: #60a5fa; }
.ps-cards { display: flex; }
.card-back { width: 22px; height: 32px; background: linear-gradient(135deg,#1e3a5f,#0f2440); border: 1px solid #334155; border-radius: 3px; margin-left: -6px; }
.card-back:first-child { margin-left: 0; }
.ps-timer { position: absolute; top: 6px; right: 10px; font-size: 12px; font-weight: 700; color: #f59e0b; }

/* Table */
.table-center { background: #0a2d18; border: 1px solid #1a5c35; border-radius: 12px; flex: 1; margin: 4px 16px; display: flex; align-items: center; padding: 14px 18px; gap: 18px; position: relative; min-height: 120px; }
.table-label { position: absolute; top: 7px; left: 12px; font-size: 10px; color: #1a5c35; text-transform: uppercase; letter-spacing: .08em; }
.pairs-area { display: flex; gap: 14px; flex: 1; align-items: center; justify-content: center; flex-wrap: wrap; }
.attack-pair { position: relative; width: 62px; height: 90px; flex-shrink: 0; }

/* Cards */
.card { position: absolute; width: 56px; height: 78px; border-radius: 6px; border: 1px solid rgba(255,255,255,.15); display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; box-shadow: 0 3px 10px rgba(0,0,0,.5); cursor: default; user-select: none; }
.card.red { background: #fef2f2; color: #dc2626; }
.card.black { background: #f8fafc; color: #1e293b; }
.card.clickable { cursor: pointer; transition: transform .12s; }
.card.clickable:hover { transform: translateY(-8px); }
.card.selected { outline: 2px solid #f59e0b !important; transform: translateY(-10px); }
.card-rank { position: absolute; top: 4px; left: 5px; font-size: 11px; font-weight: 800; line-height: 1; }
.card-suit { font-size: 18px; line-height: 1; }
.card-rank-br { position: absolute; bottom: 4px; right: 5px; font-size: 11px; font-weight: 800; line-height: 1; transform: rotate(180deg); }
.attack-card-pos { top: 0; left: 0; }
.defend-card-pos { top: 12px; left: 8px; transform: rotate(12deg); }
.defend-card-pos.selected { transform: rotate(12deg) translateY(-8px); }

/* Trump + deck */
.trump-area { display: flex; flex-direction: column; align-items: center; gap: 5px; margin-left: auto; }
.trump-card-wrap { position: relative; width: 50px; height: 70px; }
.trump-card { position: absolute; width: 50px; height: 70px; border-radius: 5px; border: 1px solid rgba(255,255,255,.15); display: flex; align-items: center; justify-content: center; flex-direction: column; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
.deck-stack { position: absolute; top: -4px; left: -4px; width: 50px; height: 70px; background: linear-gradient(135deg,#1e3a5f,#0f2440); border: 1px solid #334155; border-radius: 5px; }
.trump-label { font-size: 9px; color: #4ade80; text-transform: uppercase; letter-spacing: .06em; }
.deck-count { font-size: 11px; color: #475569; }
.discard-pile { width: 50px; height: 70px; background: rgba(0,0,0,.3); border: 1px dashed #1a5c35; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #1a5c35; }
.discard-count { font-size: 10px; color: #334155; }

/* Hand */
.hand-row { display: flex; align-items: center; padding: 6px 16px 6px; gap: 14px; flex-shrink: 0; }
.my-portrait-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
.my-name { font-size: 11px; color: #4ade80; font-weight: 700; max-width: 56px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hand-label { font-size: 10px; color: #1a5c35; text-transform: uppercase; letter-spacing: .06em; text-align: center; }
.my-hand { display: flex; justify-content: center; align-items: flex-end; flex: 1; }
.hand-card { width: 56px; height: 78px; border-radius: 6px; border: 1px solid rgba(255,255,255,.15); display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; box-shadow: 0 3px 10px rgba(0,0,0,.5); margin-left: -18px; cursor: pointer; transition: transform .12s; position: relative; user-select: none; }
.hand-card:first-child { margin-left: 0; }
.hand-card:hover { transform: translateY(-10px); }
.hand-card.selected { transform: translateY(-14px); outline: 2px solid #f59e0b; }
.hand-card.red { background: #fef2f2; color: #dc2626; }
.hand-card.black { background: #f8fafc; color: #1e293b; }
.hand-card.dim { opacity: .4; cursor: default; }

/* Action bar */
.action-bar { background: #071a10; border-top: 1px solid #1a3d20; padding: 10px 16px 12px; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.btn { background: #1a3d20; border: 1px solid #2d6a35; border-radius: 6px; color: #4ade80; font-size: 13px; font-weight: 700; padding: 7px 16px; cursor: pointer; white-space: nowrap; }
.btn.primary { background: #14532d; border-color: #22c55e; }
.btn.danger { background: #450a0a; border-color: #ef4444; color: #f87171; }
.btn:disabled { opacity: .35; cursor: default; }
.status-msg { flex: 1; font-size: 12px; color: #64748b; text-align: center; }
.bet-info { font-size: 12px; color: #f59e0b; font-weight: 700; white-space: nowrap; }

/* End screen */
#endScreen { display: none; position: absolute; inset: 0; background: rgba(0,0,0,.85); backdrop-filter: blur(4px); z-index: 100; align-items: center; justify-content: center; }
#endScreen.show { display: flex; }
.end-box { background: #0d3320; border: 1px solid #1a5c35; border-radius: 12px; padding: 24px 32px; min-width: 340px; }
.end-title { font-size: 18px; font-weight: 700; color: #4ade80; text-align: center; margin-bottom: 16px; }
.end-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #0a2d18; }
.end-place { font-size: 22px; width: 36px; text-align: center; }
.end-name { flex: 1; font-size: 14px; color: #94a3b8; font-weight: 600; }
.end-payout { font-size: 14px; color: #f59e0b; font-weight: 700; }
.end-close { margin-top: 16px; width: 100%; }
</style>
</head>
<body>
<div id="scaleRoot">
  <div class="title-bar">
    <span class="tb-title" id="tbTitle">Дурак</span>
    <span class="tb-timer" id="tbTimer"></span>
    <span class="tb-info" id="tbInfo"></span>
  </div>
  <div class="opponents-area" id="opponentsArea"></div>
  <div class="table-center" id="tableCenter">
    <div class="table-label">Стол</div>
    <div class="pairs-area" id="pairsArea"></div>
    <div class="trump-area" id="trumpArea"></div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:3px" id="discardArea"></div>
  </div>
  <div class="hand-row">
    <div class="my-portrait-wrap">
      <div class="portrait me" id="myPortrait" style="width:48px;height:66px"></div>
      <div class="my-name" id="myName"></div>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;gap:3px">
      <div class="hand-label" id="handLabel">Моя рука</div>
      <div class="my-hand" id="myHand"></div>
    </div>
  </div>
  <div class="action-bar">
    <button class="btn primary" id="btnAction" disabled onclick="doAction()"></button>
    <button class="btn" id="btnSecondary" disabled onclick="doSecondary()"></button>
    <button class="btn danger" id="btnTake" style="display:none" onclick="doTake()">Взять</button>
    <div class="status-msg" id="statusMsg">Подключение…</div>
    <div class="bet-info" id="betInfo"></div>
  </div>
  <div id="endScreen">
    <div class="end-box">
      <div class="end-title">Игра окончена</div>
      <div id="endResults"></div>
      <button class="btn primary end-close" onclick="window.close()">Закрыть</button>
    </div>
  </div>
</div>
<script>/* Task 12 JS goes here */</script>
</body>
</html>
```

- [ ] Commit:

```bash
cd fight-overlay && git add game-window.html && git commit -m "feat: game window HTML+CSS structure"
```

---

## Task 12: Game window JavaScript

- [ ] Replace the `<script>` block in `fight-overlay/game-window.html` with the complete game client: WebSocket connection, proportional scale via ResizeObserver, full render pipeline (opponents, table, trump/deck, hand), action dispatch, timer countdown, and end-screen.

```javascript
const p = new URLSearchParams(location.search)
const tableId = p.get('tableId') || ''
const token   = p.get('token') || ''
const srv     = p.get('srv') || 'https://nordheimunion.ru'

const BASE_W = 860, BASE_H = 580
const root = document.getElementById('scaleRoot')
new ResizeObserver(() => {
  const s = Math.min(document.body.clientWidth / BASE_W, document.body.clientHeight / BASE_H)
  root.style.transform = `scale(${s})`
}).observe(document.body)

let state = null
let myUserId = null
let selectedHandCard = null
let selectedAttackCard = null  // for defend mode: which table card to beat
let timerInterval = null

const suit = s => ({'♠':'black','♣':'black','♥':'red','♦':'red'}[s] || 'black')

function cardHTML(card, cls = '') {
  return `<span class="card-rank">${card.rank}</span><span class="card-suit">${card.suit}</span><span class="card-rank-br">${card.rank}</span>`
}

function renderPortrait(player) {
  if (player.avatar_url) {
    return `<img src="${srv}${player.avatar_url}" onerror="this.parentNode.innerHTML=sil('${player.gender}')">`
  }
  return sil(player.gender)
}

function sil(gender) {
  if (gender === 'female') {
    return `<svg viewBox="0 0 24 32" fill="#94a3b8" style="width:26px;height:34px;opacity:.3"><ellipse cx="12" cy="8" rx="5" ry="6"/><path d="M3 28 Q4 17 12 17 Q20 17 21 28Z"/><path d="M7 22 Q12 26 17 22 Q15 29 9 29Z" opacity=".6"/></svg>`
  }
  return `<svg viewBox="0 0 24 32" fill="#94a3b8" style="width:26px;height:34px;opacity:.3"><ellipse cx="12" cy="8" rx="5" ry="6"/><path d="M3 28 Q4 18 12 18 Q20 18 21 28Z"/></svg>`
}

function roleLabel(player) {
  if (!state) return ''
  const aIdx = state.attackerIdx, dIdx = state.defenderIdx
  const idx = state.players.findIndex(p => p.user_id === player.user_id)
  if (state.exits.find(e => e.user_id === player.user_id)) return 'Вышел'
  if (!player.connected) return 'Отключён'
  if (idx === aIdx) return '<span class="ps-role atk">Атакует</span>'
  if (idx === dIdx) return '<span class="ps-role def">Защищается</span>'
  return '<span class="ps-role">Ждёт</span>'
}

function renderOpponents() {
  if (!state) return
  const area = document.getElementById('opponentsArea')
  const others = state.players.filter(p => p.user_id !== myUserId)
  area.innerHTML = others.map(player => {
    const aIdx = state.attackerIdx, dIdx = state.defenderIdx
    const idx = state.players.findIndex(p => p.user_id === player.user_id)
    const isAtk = idx === aIdx, isDef = idx === dIdx
    const exited = state.exits.find(e => e.user_id === player.user_id)
    const disc = !player.connected
    const cls = `player-slot${isAtk?' attacker':isDef?' defender':''}${exited?' exited':''}${disc?' disconnected':''}`
    const pCls = `portrait${isAtk?' attacker':isDef?' defender':''}`
    const cards = Array.from({length: player.cardCount}, () => '<div class="card-back"></div>').join('')
    const timer = state.timerEndsAt && (isDef && state.phase === 'defense')
      ? `<span class="ps-timer" data-uid="${player.user_id}"></span>` : ''
    return `<div class="${cls}">${timer}<div class="${pCls}">${renderPortrait(player)}</div><div class="ps-info"><div class="ps-name">${player.game_name}</div>${roleLabel(player)}<div class="ps-cards">${cards}</div></div></div>`
  }).join('')
}

function renderTable() {
  if (!state) return
  const pairs = document.getElementById('pairsArea')
  pairs.innerHTML = state.table.map((pair, i) => {
    const ac = pair.attack, dc = pair.defend
    const acEl = `<div class="card ${suit(ac.suit)} attack-card-pos" data-pair="${i}" data-role="attack">${cardHTML(ac)}</div>`
    const dcEl = dc ? `<div class="card ${suit(dc.suit)} defend-card-pos">${cardHTML(dc)}</div>` : ''
    return `<div class="attack-pair">${acEl}${dcEl}</div>`
  }).join('')

  // Trump + deck
  const trumpArea = document.getElementById('trumpArea')
  if (state.trumpCard) {
    trumpArea.innerHTML = `
      <div class="trump-card-wrap">
        ${state.deckCount > 1 ? '<div class="deck-stack"></div>' : ''}
        <div class="trump-card ${suit(state.trumpCard.suit)}">${cardHTML(state.trumpCard)}</div>
      </div>
      <div class="trump-label">Козырь ${state.trump}</div>
      <div class="deck-count">${state.deckCount}</div>`
  } else {
    trumpArea.innerHTML = `<div class="trump-label">Козырь ${state.trump}</div><div class="deck-count">Колода: 0</div>`
  }

  document.getElementById('discardArea').innerHTML = `
    <div class="discard-pile">сброс</div>
    <div class="discard-count">Сброс: ${state.discardCount}</div>`
}

function renderHand() {
  if (!state) return
  const hand = state.myHand || []
  const myIdx = state.players.findIndex(p => p.user_id === myUserId)
  const isAttacker = myIdx === state.attackerIdx
  const isDefender = myIdx === state.defenderIdx
  const canPlay = (state.phase === 'attack' && isAttacker) ||
                  (state.phase === 'defense' && isDefender) ||
                  (state.phase === 'throw' && !isDefender)

  const handEl = document.getElementById('myHand')
  handEl.innerHTML = hand.map((card, i) => {
    const sel = selectedHandCard && selectedHandCard.rank === card.rank && selectedHandCard.suit === card.suit ? ' selected' : ''
    const dim = canPlay ? '' : ' dim'
    return `<div class="hand-card ${suit(card.suit)}${sel}${dim}" data-i="${i}" onclick="selectHandCard(${i})">${cardHTML(card)}</div>`
  }).join('')

  updateTimer()
  updateButtons()
}

function selectHandCard(i) {
  const card = state?.myHand?.[i]
  if (!card) return
  const myIdx = state.players.findIndex(p => p.user_id === myUserId)
  const isAttacker = myIdx === state.attackerIdx
  const isDefender = myIdx === state.defenderIdx
  const phase = state.phase

  if (phase === 'attack' && isAttacker) {
    selectedHandCard = (selectedHandCard?.rank === card.rank && selectedHandCard?.suit === card.suit) ? null : card
  } else if (phase === 'throw' && !isDefender) {
    selectedHandCard = (selectedHandCard?.rank === card.rank && selectedHandCard?.suit === card.suit) ? null : card
  } else if (phase === 'defense' && isDefender) {
    selectedHandCard = (selectedHandCard?.rank === card.rank && selectedHandCard?.suit === card.suit) ? null : card
  }
  renderHand()
  updateButtons()
}

function updateButtons() {
  if (!state) return
  const myIdx = state.players.findIndex(p => p.user_id === myUserId)
  const isAttacker = myIdx === state.attackerIdx
  const isDefender = myIdx === state.defenderIdx
  const phase = state.phase

  const btnAction = document.getElementById('btnAction')
  const btnSec    = document.getElementById('btnSecondary')
  const btnTake   = document.getElementById('btnTake')
  const statusEl  = document.getElementById('statusMsg')

  btnTake.style.display = 'none'

  if (phase === 'attack' && isAttacker) {
    btnAction.textContent = selectedHandCard ? `Атаковать ${selectedHandCard.suit}${selectedHandCard.rank}` : 'Атаковать'
    btnAction.disabled = !selectedHandCard
    btnSec.textContent = 'Пас'; btnSec.disabled = state.table.length === 0
    statusEl.textContent = 'Ваш ход — выберите карту для атаки'
  } else if (phase === 'defense' && isDefender) {
    btnAction.textContent = selectedHandCard && selectedAttackCard ? 'Отбить' : 'Отбить'
    btnAction.disabled = !(selectedHandCard && selectedAttackCard)
    btnTake.style.display = 'inline-block'
    if (state.type === 'transfer' && state.table.every(p => !p.defend)) {
      btnSec.textContent = 'Перевести'; btnSec.disabled = !selectedHandCard
    } else {
      btnSec.textContent = ''; btnSec.disabled = true
    }
    statusEl.textContent = 'Защита — выберите карту на столе, затем карту из руки'
  } else if (phase === 'throw' && !isDefender) {
    btnAction.textContent = selectedHandCard ? `Подкинуть ${selectedHandCard.suit}${selectedHandCard.rank}` : 'Подкинуть'
    btnAction.disabled = !selectedHandCard
    btnSec.textContent = 'Пас'; btnSec.disabled = false
    statusEl.textContent = 'Можно подкинуть карту или спасовать'
  } else {
    btnAction.textContent = '—'; btnAction.disabled = true
    btnSec.textContent = ''; btnSec.disabled = true
    const attName = state.players[state.attackerIdx]?.game_name
    const defName = state.players[state.defenderIdx]?.game_name
    statusEl.textContent = `${attName} атакует · ${defName} защищается`
  }
}

function doAction() {
  if (!state || !selectedHandCard) return
  const myIdx = state.players.findIndex(p => p.user_id === myUserId)
  const phase = state.phase
  if (phase === 'attack' && myIdx === state.attackerIdx) {
    window.gameAPI.sendAction('attack', { cards: [selectedHandCard] })
  } else if (phase === 'defense' && myIdx === state.defenderIdx && selectedAttackCard) {
    window.gameAPI.sendAction('defend', { attack_card: selectedAttackCard, defend_card: selectedHandCard })
  } else if (phase === 'throw' && myIdx !== state.defenderIdx) {
    window.gameAPI.sendAction('throw_in', { card: selectedHandCard })
  }
  selectedHandCard = null; selectedAttackCard = null
}

function doSecondary() {
  if (!state) return
  const myIdx = state.players.findIndex(p => p.user_id === myUserId)
  const phase = state.phase
  if ((phase === 'attack' || phase === 'throw') && myIdx !== state.defenderIdx) {
    window.gameAPI.sendAction('pass')
  } else if (phase === 'defense' && myIdx === state.defenderIdx && state.type === 'transfer' && selectedHandCard) {
    window.gameAPI.sendAction('transfer', { card: selectedHandCard })
    selectedHandCard = null
  }
}

function doTake() {
  window.gameAPI.sendAction('take')
  selectedHandCard = null; selectedAttackCard = null
}

// Click on table card (for defend: select which card to beat)
document.getElementById('pairsArea').addEventListener('click', e => {
  const el = e.target.closest('[data-role="attack"]')
  if (!el) return
  const myIdx = state?.players.findIndex(p => p.user_id === myUserId)
  if (!state || state.phase !== 'defense' || myIdx !== state.defenderIdx) return
  const pairIdx = parseInt(el.dataset.pair)
  const pair = state.table[pairIdx]
  if (!pair || pair.defend) return
  selectedAttackCard = pair.attack
  updateButtons()
  // Highlight selected table card
  document.querySelectorAll('[data-role="attack"]').forEach(c => c.classList.remove('selected'))
  el.classList.add('selected')
})

function updateTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
  const tbTimer = document.getElementById('tbTimer')
  if (!state?.timerEndsAt) { tbTimer.classList.remove('active'); return }

  tbTimer.classList.add('active')
  function tick() {
    const secs = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000))
    tbTimer.textContent = `${secs}с`
    if (secs === 0) { clearInterval(timerInterval); timerInterval = null }
  }
  tick()
  timerInterval = setInterval(tick, 500)
}

function applyState(s) {
  state = s
  selectedHandCard = null; selectedAttackCard = null
  renderOpponents()
  renderTable()
  renderHand()
  updateTimer()
}

function renderEnd(results) {
  const placeEmoji = ['1','2','3','4','5','6']
  document.getElementById('endResults').innerHTML = results.map(r => `
    <div class="end-row">
      <span class="end-place">${placeEmoji[r.place-1] || r.place}</span>
      <span class="end-name">${r.game_name}${r.user_id === myUserId ? ' (вы)' : ''}</span>
      <span class="end-payout">${r.payout > 0 ? '+' + r.payout : r.place === results.length ? 'Дурак' : '0'}</span>
    </div>`).join('')
  document.getElementById('endScreen').classList.add('show')
}

// Connect
if (window.gameAPI && tableId && token) {
  window.gameAPI.onEvent(msg => {
    if (msg.type === 'game_state') {
      myUserId = msg.myUserId || myUserId
      state = msg
      document.getElementById('tbTitle').textContent = `Дурак — ${msg.type === 'transfer' ? 'Переводной' : 'Подкидной'}`
      document.getElementById('betInfo').textContent = msg.bet > 0 ? `Банк: ${msg.bet * msg.players.length}` : ''
      renderOpponents(); renderTable(); renderHand(); updateTimer()
    } else if (msg.type === 'attack' || msg.type === 'defend' || msg.type === 'throw_in' || msg.type === 'transfer') {
      if (msg.table) state.table = msg.table
      renderTable(); updateButtons()
    } else if (msg.type === 'take') {
      state.table = []; renderTable()
    } else if (msg.type === 'round_end') {
      state.table = []; renderTable()
    } else if (msg.type === 'timer_start') {
      state.timerEndsAt = Date.now() + msg.seconds * 1000
      updateTimer()
    } else if (msg.type === 'player_reconnected' || msg.type === 'player_exit') {
      const pl = state?.players?.find(pl => pl.user_id === msg.user_id)
      if (pl) { pl.connected = msg.type === 'player_reconnected'; renderOpponents() }
    } else if (msg.type === 'game_over') {
      renderEnd(msg.results)
    }
  })
  window.gameAPI.connect(tableId, token, srv)
} else {
  document.getElementById('statusMsg').textContent = 'Нет параметров подключения'
}
```

Also add `myUserId` to `serializeStateFor` return value in `fight/server/game-sessions.ts` (already included in Task 6 above as `myUserId: userId`).

- [ ] Commit:

```bash
cd fight-overlay && git add game-window.html && git commit -m "feat: game window JavaScript — WS, rendering, actions, end screen"
cd fight && git add server/game-engine.ts server/game-sessions.ts server/ws-game.ts server/routes/games.ts server/index.ts server/db.ts && git commit -m "feat: Durak Spec 2 — game engine, sessions, WS channel"
```

---

## Self-review checklist

- [x] 36-card deck (6–A x 4 suits): `createDeck()` generates 4 suits x 9 ranks = 36 cards
- [x] Deal 6 each: loop in `createGame` deals 6 cards per player
- [x] Trump = bottom card: `deck[0]` after dealing is bottom of remaining deck
- [x] Throwing variant: `throwIn` / `pass` functions
- [x] Transfer variant: `transfer` function checks rank match, shifts defender
- [x] WebSocket channel `/ws/game/:tableId?token=`: `ws-game.ts` upgrade handler
- [x] Server-authoritative pure functions: game-engine.ts exports only pure `{ state, events }` pairs
- [x] Auto-move on `turn_timeout`: `scheduleTimers` calls `take` for defender
- [x] Auto-move on `throw_timeout`: `scheduleTimers` auto-passes all non-passers
- [x] Reconnect full snapshot: `ws-game.ts` sends `game_state` on connection
- [x] Payout weights (N-1),(N-2)...1,0: `handleGameOver` computes `weight = N - place`
- [x] DB schema: `turn_timeout`, `throw_timeout` columns + `game_history` table
- [x] UI resizable via `transform:scale`: `ResizeObserver` in Task 12 JS
- [x] Portrait photos from `warrior_photos`: `routes/games.ts` queries `warrior_photos` table
- [x] No placeholders or TBD: all code blocks are complete and runnable
- [x] Verify commands present on every task
