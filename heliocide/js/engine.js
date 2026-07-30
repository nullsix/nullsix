// MARROW — pure rules engine (M1). Implements the frozen contract in PLAN.md.
//
// Rules: no DOM, no Date, no Math.random. Every random decision advances `state.rng`, so a
// (seed, action sequence) pair replays exactly. `applyAction` clones its input first and
// mutates only the clone — callers can freeze states and keep them as history.
//
// Layering law: imports rng.js + cards.js, nothing else.

import { hashSeed, nextInt, shuffle } from './rng.js';
import { TYPES, cardById, deckById } from './cards.js';

export const WIN_SCORE = 4;
export const BENCH_LIMIT = 3;
export const HAND_SIZE = 5; // opening draw
export const ROT_DAMAGE = 10; // rot tick at the end of the owner's turn
export const RESISTANCE_REDUCTION = 20;

/** Canonical energy id order. Also the fixed order the engine auto-picks energy to discard. */
export const ENERGY_TYPES = TYPES.map((t) => t.id);

const DEFAULT_NAMES = ['Player 1', 'Player 2'];

// ---------------------------------------------------------------------------
// small pure utilities
// ---------------------------------------------------------------------------

/** Deep clone for the JSON-shaped state (cheaper and more predictable than structuredClone). */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

function emptyEnergy() {
  const e = {};
  for (const t of ENERGY_TYPES) e[t] = 0;
  return e;
}

function totalEnergy(creature) {
  let n = 0;
  for (const t of ENERGY_TYPES) n += creature.energy[t] || 0;
  return n;
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** Active first, then bench in slot order. Snapshot array — safe to mutate the board while iterating. */
function creaturesOf(player) {
  return player.active ? [player.active, ...player.bench] : player.bench.slice();
}

function findOwn(player, uid) {
  if (player.active && player.active.uid === uid) return player.active;
  return player.bench.find((c) => c.uid === uid) || null;
}

/** Public read helper: locate a creature anywhere on the board. */
export function findCreature(state, uid) {
  for (let i = 0; i < 2; i++) {
    const c = findOwn(state.players[i], uid);
    if (c) return { creature: c, player: i, slot: state.players[i].active === c ? 'active' : 'bench' };
  }
  return null;
}

export function maxHpOf(creature) {
  return cardById(creature.cardId).hp;
}

/**
 * Attack costs are thresholds, not payments: typed requirements must be met exactly by type,
 * and `any` is covered by whatever energy is left over.
 */
export function costMet(energy, cost) {
  let typedNeed = 0;
  for (const key of Object.keys(cost || {})) {
    if (key === 'any') continue;
    if ((energy[key] || 0) < cost[key]) return false;
    typedNeed += cost[key];
  }
  let total = 0;
  for (const t of ENERGY_TYPES) total += energy[t] || 0;
  return total - typedNeed >= ((cost && cost.any) || 0);
}

/**
 * Weakness doubles, then resistance subtracts (floored at 0) — TCG order.
 * Shields are applied separately, at the point of impact.
 */
export function typedDamage(attackerType, defenderCardId, baseDamage) {
  const card = cardById(defenderCardId);
  const weakness = card.weakness === attackerType;
  const resistance = card.resistance === attackerType;
  let amount = baseDamage;
  if (weakness) amount *= 2;
  if (resistance) amount = Math.max(0, amount - RESISTANCE_REDUCTION);
  return { amount, weakness, resistance };
}

function resolveDeck(deck) {
  if (typeof deck === 'string') return deckById(deck);
  if (deck && Array.isArray(deck.cards)) return deck;
  throw new Error('createGame: deckA/deckB must be a preset deck id or a deck object');
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

/**
 * createGame({ deckA, deckB, seed, names }) -> State in the 'setup' phase.
 * Decks are shuffled and both players draw 5; each then plays one `setupActive`.
 * `turn` is 0 until player 0's first turn begins (turn increments when player 0 starts).
 * `seed` defaults to 1 so the engine never has to invent randomness — callers that want
 * variety (the UI) must pass a real seed.
 */
export function createGame({ deckA, deckB, seed = 1, names } = {}) {
  const presets = [resolveDeck(deckA), resolveDeck(deckB)];
  let rngState = hashSeed(seed);
  const players = [];
  for (let i = 0; i < 2; i++) {
    const preset = presets[i];
    const r = shuffle(preset.cards, rngState);
    rngState = r.rngState;
    const deck = r.shuffled;
    const hand = deck.splice(0, HAND_SIZE); // index 0 is the top of the deck
    players.push({
      name: (names && names[i]) || DEFAULT_NAMES[i],
      deckList: preset.id,
      profile: preset.profile.slice(),
      deck,
      hand,
      discard: [],
      active: null,
      bench: [],
      score: 0,
    });
  }
  return {
    seed,
    rng: rngState,
    turn: 0,
    phase: 'setup',
    acting: 0,
    turnPlayer: 0,
    attachedThisTurn: false,
    retreatedThisTurn: false,
    attackedThisTurn: false,
    nextUid: 1, // creature uid counter; keeps uids deterministic without touching the PRNG
    result: null, // { player, reason } once decided — `winner()` reads this
    players,
  };
}

function makeCreature(state, cardId) {
  const card = cardById(cardId);
  return {
    uid: `u${state.nextUid++}`,
    cardId,
    hp: card.hp,
    energy: emptyEnergy(),
    rot: false,
    stun: false,
    shield: 0,
  };
}

// ---------------------------------------------------------------------------
// legal actions
// ---------------------------------------------------------------------------

function firstPlayerOpeningTurn(state) {
  // Player 0 always moves first, so "the player who goes first" is player 0 on turn 1.
  return state.turn === 1 && state.turnPlayer === 0;
}

function attackBlockedReason(state) {
  const me = state.players[state.turnPlayer];
  const foe = state.players[1 - state.turnPlayer];
  if (state.phase !== 'main') return 'not in the main phase';
  if (state.attackedThisTurn) return 'already attacked this turn';
  if (!me.active) return 'no active creature';
  if (!foe.active) return 'the opponent has no active creature';
  if (me.active.stun) return 'the active creature is stunned this turn';
  if (firstPlayerOpeningTurn(state)) return 'the first player cannot attack on turn 1';
  return null;
}

export function legalActions(state) {
  if (state.phase === 'over') return [];
  const me = state.players[state.acting];

  if (state.phase === 'setup') {
    return uniq(me.hand).map((cardId) => ({ type: 'setupActive', cardId }));
  }
  if (state.phase === 'promote') {
    return me.bench.map((c) => ({ type: 'promote', uid: c.uid }));
  }

  const actions = [];
  if (me.bench.length < BENCH_LIMIT) {
    for (const cardId of uniq(me.hand)) actions.push({ type: 'bench', cardId });
  }
  if (!state.attachedThisTurn) {
    for (const energyType of me.profile) {
      for (const c of creaturesOf(me)) actions.push({ type: 'attach', energyType, targetUid: c.uid });
    }
  }
  if (!state.retreatedThisTurn && me.active && me.bench.length > 0) {
    if (totalEnergy(me.active) >= cardById(me.active.cardId).retreatCost) {
      for (const c of me.bench) actions.push({ type: 'retreat', toUid: c.uid });
    }
  }
  if (!attackBlockedReason(state)) {
    cardById(me.active.cardId).attacks.forEach((atk, attackIndex) => {
      if (costMet(me.active.energy, atk.cost)) actions.push({ type: 'attack', attackIndex });
    });
  }
  actions.push({ type: 'endTurn' });
  return actions;
}

export function winner(state) {
  return state.result ? { player: state.result.player, reason: state.result.reason } : null;
}

// ---------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------

export function applyAction(state, action) {
  if (!action || typeof action.type !== 'string') {
    throw new Error('applyAction: action must be an object with a string `type`');
  }
  if (state.phase === 'over') throw new Error('applyAction: the game is already over');

  const s = clone(state);
  const events = [];
  switch (action.type) {
    case 'setupActive':
      doSetupActive(s, action, events);
      break;
    case 'bench':
      doBench(s, action, events);
      break;
    case 'attach':
      doAttach(s, action, events);
      break;
    case 'retreat':
      doRetreat(s, action, events);
      break;
    case 'attack':
      doAttack(s, action, events);
      break;
    case 'endTurn':
      doEndTurn(s, events);
      break;
    case 'promote':
      doPromote(s, action, events);
      break;
    default:
      throw new Error(`applyAction: unknown action type "${action.type}"`);
  }
  return { state: s, events };
}

function requireMain(state, what) {
  if (state.phase !== 'main') throw new Error(`${what}: only legal in the main phase (phase is "${state.phase}")`);
}

function drawFromHand(player, cardId, what) {
  const i = player.hand.indexOf(cardId);
  if (i < 0) throw new Error(`${what}: card "${cardId}" is not in ${player.name}'s hand`);
  player.hand.splice(i, 1);
  return cardId;
}

function doSetupActive(s, action, events) {
  if (s.phase !== 'setup') throw new Error(`setupActive: only legal in the setup phase (phase is "${s.phase}")`);
  const p = s.players[s.acting];
  drawFromHand(p, action.cardId, 'setupActive');
  p.active = makeCreature(s, action.cardId);
  events.push({
    kind: 'promote',
    player: s.acting,
    uid: p.active.uid,
    cardId: p.active.cardId,
    from: 'hand',
    reason: 'setup',
  });
  if (s.acting === 0) s.acting = 1; // player 0 sets up, then player 1, then turn 1 begins
  else beginTurn(s, 0, events);
}

function doBench(s, action, events) {
  requireMain(s, 'bench');
  const p = s.players[s.turnPlayer];
  if (p.bench.length >= BENCH_LIMIT) throw new Error(`bench: bench is full (${BENCH_LIMIT})`);
  drawFromHand(p, action.cardId, 'bench');
  const creature = makeCreature(s, action.cardId);
  p.bench.push(creature);
  events.push({
    kind: 'bench',
    player: s.turnPlayer,
    uid: creature.uid,
    cardId: creature.cardId,
    benchCount: p.bench.length,
  });
}

function doAttach(s, action, events) {
  requireMain(s, 'attach');
  if (s.attachedThisTurn) throw new Error('attach: already attached an energy this turn');
  const p = s.players[s.turnPlayer];
  if (!p.profile.includes(action.energyType)) {
    throw new Error(
      `attach: "${action.energyType}" is not in this deck's energy profile (${p.profile.join(', ')})`,
    );
  }
  const target = findOwn(p, action.targetUid);
  if (!target) throw new Error(`attach: uid "${action.targetUid}" is not one of ${p.name}'s creatures`);
  target.energy[action.energyType] += 1;
  s.attachedThisTurn = true;
  events.push({
    kind: 'attach',
    player: s.turnPlayer,
    energyType: action.energyType,
    uid: target.uid,
    cardId: target.cardId,
    energy: clone(target.energy),
  });
}

/** Removes up to `count` energy in ENERGY_TYPES order. -> { lost: sparse map, removed } */
function payEnergy(creature, count) {
  const lost = {};
  let left = count;
  for (const t of ENERGY_TYPES) {
    while (left > 0 && creature.energy[t] > 0) {
      creature.energy[t] -= 1;
      lost[t] = (lost[t] || 0) + 1;
      left -= 1;
    }
    if (left === 0) break;
  }
  return { lost, removed: count - left };
}

function clearStatus(s, playerIndex, creature, status, reason, events) {
  if (!creature[status]) return;
  creature[status] = false;
  events.push({
    kind: 'status',
    player: playerIndex,
    uid: creature.uid,
    cardId: creature.cardId,
    status,
    on: false,
    reason,
  });
}

function doRetreat(s, action, events) {
  requireMain(s, 'retreat');
  if (s.retreatedThisTurn) throw new Error('retreat: already retreated this turn');
  const p = s.players[s.turnPlayer];
  if (!p.active) throw new Error('retreat: no active creature to retreat');
  const slot = p.bench.findIndex((c) => c.uid === action.toUid);
  if (slot < 0) throw new Error(`retreat: uid "${action.toUid}" is not on ${p.name}'s bench`);
  const leaving = p.active;
  const cost = cardById(leaving.cardId).retreatCost;
  if (totalEnergy(leaving) < cost) {
    throw new Error(
      `retreat: ${leaving.cardId} needs ${cost} attached energy to retreat (has ${totalEnergy(leaving)})`,
    );
  }
  const incoming = p.bench[slot];
  events.push({
    kind: 'retreat',
    player: s.turnPlayer,
    fromUid: leaving.uid,
    fromCardId: leaving.cardId,
    toUid: incoming.uid,
    toCardId: incoming.cardId,
    cost,
  });
  const paid = payEnergy(leaving, cost);
  if (paid.removed > 0) {
    events.push({
      kind: 'energyLoss',
      player: s.turnPlayer,
      uid: leaving.uid,
      cardId: leaving.cardId,
      lost: paid.lost,
      count: paid.removed,
      reason: 'retreat',
      energy: clone(leaving.energy),
    });
  }
  // Retreating clears rot and stun on the creature leaving the active slot. Shields are a
  // separate durable field (PLAN.md lists only rot/stun as statuses), so they ride along.
  clearStatus(s, s.turnPlayer, leaving, 'rot', 'retreat', events);
  clearStatus(s, s.turnPlayer, leaving, 'stun', 'retreat', events);
  p.bench[slot] = leaving; // swap in place so bench slot order stays stable for the UI
  p.active = incoming;
  s.retreatedThisTurn = true;
}

function doEndTurn(s, events) {
  requireMain(s, 'endTurn');
  concludeTurn(s, events);
}

function doPromote(s, action, events) {
  if (s.phase !== 'promote') throw new Error(`promote: only legal in the promote phase (phase is "${s.phase}")`);
  const p = s.players[s.acting];
  const slot = p.bench.findIndex((c) => c.uid === action.uid);
  if (slot < 0) throw new Error(`promote: uid "${action.uid}" is not on ${p.name}'s bench`);
  const promoted = p.bench.splice(slot, 1)[0];
  p.active = promoted;
  events.push({
    kind: 'promote',
    player: s.acting,
    uid: promoted.uid,
    cardId: promoted.cardId,
    from: 'bench',
    reason: 'ko',
  });
  handoff(s, events);
}

// ---------------------------------------------------------------------------
// combat
// ---------------------------------------------------------------------------

/** Raw damage — no weakness/resistance/shield. Used by rot, selfDamage and benchDamage. */
function dealRaw(s, ownerIndex, creature, amount, source, events) {
  const hpBefore = creature.hp;
  creature.hp = Math.max(0, creature.hp - amount);
  events.push({
    kind: 'damage',
    player: ownerIndex,
    uid: creature.uid,
    cardId: creature.cardId,
    amount: hpBefore - creature.hp,
    raw: amount,
    hpBefore,
    hpAfter: creature.hp,
    maxHp: maxHpOf(creature),
    weakness: false,
    resistance: false,
    absorbed: 0,
    source,
  });
}

function doAttack(s, action, events) {
  const blocked = attackBlockedReason(s);
  if (blocked) throw new Error(`attack: ${blocked}`);
  const me = s.players[s.turnPlayer];
  const foe = s.players[1 - s.turnPlayer];
  const card = cardById(me.active.cardId);
  const atk = card.attacks[action.attackIndex];
  if (!atk) throw new Error(`attack: ${card.id} has no attack at index ${action.attackIndex}`);
  if (!costMet(me.active.energy, atk.cost)) {
    throw new Error(`attack: "${atk.name}" costs ${JSON.stringify(atk.cost)}, which the active creature cannot meet`);
  }

  s.attackedThisTurn = true;
  const attacker = me.active;
  const defender = foe.active;
  events.push({
    kind: 'attack',
    player: s.turnPlayer,
    uid: attacker.uid,
    cardId: attacker.cardId,
    attackerType: card.type,
    attackIndex: action.attackIndex,
    attackName: atk.name,
    cost: clone(atk.cost),
    baseDamage: atk.damage,
    effect: atk.effect ? clone(atk.effect) : null,
    text: atk.text,
    targetPlayer: 1 - s.turnPlayer,
    targetUid: defender.uid,
    targetCardId: defender.cardId,
  });

  if (atk.damage > 0) {
    const typed = typedDamage(card.type, defender.cardId, atk.damage);
    let amount = typed.amount;
    let absorbed = 0;
    // A shield soaks up to `amount` and is spent by the first attack that actually connects.
    if (amount > 0 && defender.shield > 0) {
      absorbed = Math.min(defender.shield, amount);
      amount -= absorbed;
      defender.shield = 0;
      events.push({
        kind: 'shield',
        player: 1 - s.turnPlayer,
        uid: defender.uid,
        cardId: defender.cardId,
        amount: 0,
        absorbed,
        spent: true,
      });
    }
    const hpBefore = defender.hp;
    defender.hp = Math.max(0, defender.hp - amount);
    events.push({
      kind: 'damage',
      player: 1 - s.turnPlayer,
      uid: defender.uid,
      cardId: defender.cardId,
      amount: hpBefore - defender.hp,
      raw: atk.damage,
      hpBefore,
      hpAfter: defender.hp,
      maxHp: maxHpOf(defender),
      weakness: typed.weakness,
      resistance: typed.resistance,
      absorbed,
      source: 'attack',
    });
  }

  if (atk.effect) applyEffect(s, atk.effect, attacker, defender, events);

  resolveKOs(s, 'attack', events);
  if (s.result) return;
  concludeTurn(s, events); // attacking ends the turn
}

/**
 * Attack effects. Defender-targeting effects are skipped if the defender was knocked out by
 * the damage step (nothing left to rot, stun or drain).
 */
function applyEffect(s, effect, attacker, defender, events) {
  const attackerIndex = s.turnPlayer;
  const defenderIndex = 1 - s.turnPlayer;
  const defenderAlive = defender && defender.hp > 0;

  switch (effect.kind) {
    case 'rot':
    case 'stun': {
      if (!defenderAlive || defender[effect.kind]) break;
      defender[effect.kind] = true;
      events.push({
        kind: 'status',
        player: defenderIndex,
        uid: defender.uid,
        cardId: defender.cardId,
        status: effect.kind,
        on: true,
        reason: 'attack',
      });
      break;
    }
    case 'selfHeal': {
      const max = maxHpOf(attacker);
      const healed = Math.max(0, Math.min(effect.amount, max - attacker.hp));
      const hpBefore = attacker.hp;
      attacker.hp += healed;
      events.push({
        kind: 'heal',
        player: attackerIndex,
        uid: attacker.uid,
        cardId: attacker.cardId,
        amount: healed,
        requested: effect.amount,
        hpBefore,
        hpAfter: attacker.hp,
        maxHp: max,
      });
      break;
    }
    case 'benchDamage': {
      const bench = s.players[defenderIndex].bench;
      if (bench.length === 0) break;
      if (effect.scope === 'all') {
        for (const c of bench.slice()) dealRaw(s, defenderIndex, c, effect.amount, 'benchDamage', events);
      } else {
        const r = nextInt(s.rng, bench.length);
        s.rng = r.rngState;
        dealRaw(s, defenderIndex, bench[r.value], effect.amount, 'benchDamage', events);
      }
      break;
    }
    case 'selfDamage':
      dealRaw(s, attackerIndex, attacker, effect.amount, 'selfDamage', events);
      break;
    case 'discardOwnEnergy': {
      const paid = payEnergy(attacker, effect.count);
      if (paid.removed > 0) {
        events.push({
          kind: 'energyLoss',
          player: attackerIndex,
          uid: attacker.uid,
          cardId: attacker.cardId,
          lost: paid.lost,
          count: paid.removed,
          reason: 'discardOwnEnergy',
          energy: clone(attacker.energy),
        });
      }
      break;
    }
    case 'drainEnergy': {
      if (!defenderAlive) break;
      const paid = payEnergy(defender, effect.count);
      if (paid.removed > 0) {
        events.push({
          kind: 'energyLoss',
          player: defenderIndex,
          uid: defender.uid,
          cardId: defender.cardId,
          lost: paid.lost,
          count: paid.removed,
          reason: 'drainEnergy',
          energy: clone(defender.energy),
        });
      }
      break;
    }
    case 'shield': {
      attacker.shield += effect.amount;
      events.push({
        kind: 'shield',
        player: attackerIndex,
        uid: attacker.uid,
        cardId: attacker.cardId,
        amount: attacker.shield,
        gained: effect.amount,
        spent: false,
      });
      break;
    }
    default:
      throw new Error(`applyEffect: unknown effect kind "${effect.kind}"`);
  }
}

/**
 * Sweep the board for creatures at 0 hp: discard the card (its attached energy simply
 * evaporates), score 1 for the *other* player — that generalises "the attacker's owner
 * scores" to rot ticks, bench splash and self-damage — and check the 4-KO win.
 */
function resolveKOs(s, source, events) {
  // The struck side is swept first so an attacker's own KO scores before any recoil KO.
  for (const pi of [1 - s.turnPlayer, s.turnPlayer]) {
    const p = s.players[pi];
    if (p.active && p.active.hp <= 0) {
      const dead = p.active;
      p.active = null;
      koCreature(s, pi, dead, 'active', source, events);
      if (s.result) return;
    }
    for (const c of p.bench.slice()) {
      if (c.hp <= 0) {
        p.bench.splice(p.bench.indexOf(c), 1);
        koCreature(s, pi, c, 'bench', source, events);
        if (s.result) return;
      }
    }
  }
  // Empty active slot with nothing to promote = loss. Checked turn-player-first so that in
  // the freak case of both boards emptying at once, the player who swung loses.
  for (const pi of [s.turnPlayer, 1 - s.turnPlayer]) {
    const p = s.players[pi];
    if (!p.active && p.bench.length === 0) {
      finish(s, 1 - pi, 'noPromote', events);
      return;
    }
  }
}

function koCreature(s, ownerIndex, creature, slot, source, events) {
  const scorer = 1 - ownerIndex;
  s.players[ownerIndex].discard.push(creature.cardId);
  s.players[scorer].score += 1;
  events.push({
    kind: 'ko',
    player: ownerIndex,
    uid: creature.uid,
    cardId: creature.cardId,
    slot,
    source,
    scorer,
    score: s.players[scorer].score,
    energyLost: clone(creature.energy),
  });
  if (s.players[scorer].score >= WIN_SCORE) finish(s, scorer, 'score', events);
}

function finish(s, playerIndex, reason, events) {
  if (s.result) return;
  s.result = { player: playerIndex, reason };
  s.phase = 'over';
  events.push({
    kind: 'gameOver',
    player: playerIndex,
    reason,
    scores: s.players.map((p) => p.score),
  });
}

// ---------------------------------------------------------------------------
// turn boundaries
// ---------------------------------------------------------------------------

/**
 * End-of-turn upkeep, then hand off. Runs before any promote interrupt so the promote
 * continuation is always the same thing (`handoff`) no matter what caused it — and a freshly
 * promoted creature can never carry rot or stun anyway, so nothing is lost by the ordering.
 */
function concludeTurn(s, events) {
  const owner = s.turnPlayer;
  for (const c of creaturesOf(s.players[owner])) {
    if (c.rot && c.hp > 0) dealRaw(s, owner, c, ROT_DAMAGE, 'rot', events);
  }
  resolveKOs(s, 'rot', events);
  if (s.result) return;
  // Stun blocked this turn's attack; it clears now.
  for (const c of creaturesOf(s.players[owner])) clearStatus(s, owner, c, 'stun', 'endOfTurn', events);
  handoff(s, events);
}

function handoff(s, events) {
  if (s.result) {
    s.phase = 'over';
    return;
  }
  // Forced promotions happen before the next turn starts, defending player first.
  for (const pi of [1 - s.turnPlayer, s.turnPlayer]) {
    const p = s.players[pi];
    if (!p.active) {
      if (p.bench.length === 0) {
        finish(s, 1 - pi, 'noPromote', events);
        return;
      }
      s.phase = 'promote';
      s.acting = pi;
      return;
    }
  }
  beginTurn(s, 1 - s.turnPlayer, events);
}

function beginTurn(s, playerIndex, events) {
  s.turnPlayer = playerIndex;
  s.acting = playerIndex;
  s.phase = 'main';
  if (playerIndex === 0) s.turn += 1; // `turn` is a round counter: both players share turn N
  s.attachedThisTurn = false;
  s.retreatedThisTurn = false;
  s.attackedThisTurn = false;
  events.push({ kind: 'turnStart', player: playerIndex, turn: s.turn });
  // Shields last through the opponent's turn and expire as the owner's next turn opens.
  // (PLAN.md says "before its owner's next turn ends"; nothing can damage a creature during
  // its owner's own turn except rot/self-damage, which shields don't cover, so clearing at
  // the start of that turn is equivalent and needs no extra bookkeeping.)
  for (const c of creaturesOf(s.players[playerIndex])) {
    if (c.shield > 0) {
      c.shield = 0;
      events.push({
        kind: 'shield',
        player: playerIndex,
        uid: c.uid,
        cardId: c.cardId,
        amount: 0,
        expired: true,
        spent: false,
      });
    }
  }
  // Draws are symmetric — every player draws at every turn start, including turn 1.
  // (A first-player draw-skip was tried and reverted 2026-07-29: threshold energy means
  // seat 0 banks its "lost" first attack, so the skip stacked both edges on seat 0 —
  // 80.8% in AI mirrors. Symmetric draws measure 53.2/46.8. See test/balance-report.md.)
  const p = s.players[playerIndex];
  if (p.deck.length === 0) {
    finish(s, 1 - playerIndex, 'deckOut', events); // drawing from an empty deck loses
    return;
  }
  const cardId = p.deck.shift();
  p.hand.push(cardId);
  events.push({
    kind: 'draw',
    player: playerIndex,
    cardId,
    deckCount: p.deck.length,
    handCount: p.hand.length,
  });
}
