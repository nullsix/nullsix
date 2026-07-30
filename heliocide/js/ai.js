// HELIOCIDE — heuristic AI opponent (M3).
//
// One entry point:
//
//   chooseAction(state, { noise = 0.1, rng, seed }) -> Action
//
// It returns exactly one action that is legal for `state.acting`. Every choice is drawn from
// `legalActions(state)`, so legality is structural rather than asserted. Dispatch is on
// `state.acting`, never `turnPlayer` — a promote interrupt hands the *opponent* an action in
// the middle of someone else's turn.
//
// Information hygiene: the AI reads public state (both boards, scores, deck/hand/discard
// COUNTS, discard piles) plus its own hand. It never reads the other player's hand and never
// reads either deck's order.
//
// Determinism: `noise` (0-1) only ever widens the tie band, and the coin it flips comes from
// `opts.rng` (any `() -> [0,1)` function) or a mulberry32 seeded from `opts.seed`, which
// defaults to a fingerprint of the public state. `Math.random` is never touched, and
// `noise: 0` never calls the rng at all — same state in, same action out, forever.
//
// Layering law: imports engine.js + cards.js (+ rng.js, a leaf). Nothing imports this but ui.js.

import { WIN_SCORE, ENERGY_TYPES, ROT_DAMAGE, legalActions, typedDamage, maxHpOf } from './engine.js';
import { cardById } from './cards.js';
import { createRng } from './rng.js';

export const DEFAULT_NOISE = 0.1;

// ---------------------------------------------------------------------------
// tuning constants — everything is denominated in "damage points" so offence, tempo and
// energy can be added up on one scale.
// ---------------------------------------------------------------------------

const KO_VALUE = 60; // a score pip + the tempo of clearing their active, on top of the damage
const WIN_VALUE = 1000; // a line that ends the game right now dwarfs everything else
const PLAN_CAP = 250; // planning clamps WIN_VALUE: the board will have moved by the time we arrive
const ROT_VALUE = 18; // ~2 ticks of ROT_DAMAGE, discounted for the chance they retreat it
const STUN_VALUE = 24; // one denied swing
const DRAIN_VALUE = 14; // one energy off their threshold
const SHIELD_FACTOR = 0.5;
const HEAL_FACTOR = 0.6;
const SELF_DAMAGE_FACTOR = 0.8;
const DISCARD_ENERGY_VALUE = 12;
const BENCH_DAMAGE_FACTOR = 0.6; // splash matters less than pressure on the active
const ENERGY_VALUE = 12; // one attached energy, as damage-equivalent
const DELAY_DISCOUNT = 0.9; // each attach still needed divides a plan by ~1.9, 2.8, 3.7...
const BENCH_SLOT_WEIGHT = 0.55; // a benched creature has to be promoted or retreated in first
const DOOMED_DISCOUNT = 0.45; // energy on a creature that dies next turn evaporates with it
// PLAN.md sets the floor at 2; filling the third slot measured 53.0% head-to-head over 2400
// games against an otherwise identical bot, so the AI develops the whole bench. Bench bodies
// are attach targets, promote insurance, and only two cards in the catalog punish a wide bench.
const BENCH_TARGET = 3;
const RETREAT_THRESHOLD = 10; // retreats are not free; only swap on a real gain
const ACTIVE_TIE_BONUS = 2; // "prefer active" as a tie-break, not as a thumb on the scale
const NOISE_BAND = 18; // at noise 1, anything within 18 points of the best is a coin flip

// ---------------------------------------------------------------------------
// small local helpers (the engine keeps its own copies private)
// ---------------------------------------------------------------------------

function totalEnergy(energy) {
  let n = 0;
  for (const t of ENERGY_TYPES) n += energy[t] || 0;
  return n;
}

function blankEnergy() {
  const e = {};
  for (const t of ENERGY_TYPES) e[t] = 0;
  return e;
}

function addEnergy(energy, type) {
  const out = {};
  for (const t of ENERGY_TYPES) out[t] = energy[t] || 0;
  out[type] = (out[type] || 0) + 1;
  return out;
}

function ownCreatures(player) {
  return player.active ? [player.active, ...player.bench] : player.bench.slice();
}

function findOwn(player, uid) {
  if (player.active && player.active.uid === uid) return player.active;
  return player.bench.find((c) => c.uid === uid) || null;
}

function sumCost(cost) {
  let n = 0;
  for (const key of Object.keys(cost)) n += cost[key];
  return n;
}

/**
 * How many more attached energy a creature needs before `cost` is satisfied. One attach per
 * turn, so this doubles as "turns until this attack comes online" — with the caveat that
 * `drainEnergy` and `discardOwnEnergy` can walk a creature *backwards* off a threshold, which
 * is why plans at the threshold still get a small padding bonus in `chooseAttach`.
 */
export function energyShortfall(energy, cost) {
  let typedNeed = 0;
  let missing = 0;
  for (const key of Object.keys(cost)) {
    if (key === 'any') continue;
    typedNeed += cost[key];
    missing += Math.max(0, cost[key] - (energy[key] || 0));
  }
  const generic = cost.any || 0;
  // Once the typed shortfall is filled, whatever is left over has to cover the generic cost.
  const leftover = totalEnergy(energy) + missing - typedNeed;
  return missing + Math.max(0, generic - leftover);
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

/**
 * What one swing is worth. Mirrors the engine's resolution order (damage -> effect -> KO
 * sweep) closely enough to rank options, and returns the KO facts the cascade needs.
 * `defender` may be null (setup-phase planning, before the opponent has placed).
 */
function attackScore(state, side, attacker, attackIndex, defender) {
  const me = state.players[side];
  const foe = state.players[1 - side];
  const card = cardById(attacker.cardId);
  const atk = card.attacks[attackIndex];
  const effect = atk.effect || null;
  let score = 0;
  let dealt = 0;
  let kills = false;
  let kos = 0;

  if (defender) {
    if (atk.damage > 0) {
      const typed = typedDamage(card.type, defender.cardId, atk.damage);
      const landed = Math.max(0, typed.amount - (defender.shield || 0));
      dealt = Math.min(landed, defender.hp); // overkill is not worth extra
      kills = landed >= defender.hp;
      score += dealt;
    }
    if (kills) {
      kos += 1;
      score += KO_VALUE;
    }
  } else if (atk.damage > 0) {
    score += atk.damage * 0.8; // no target on the board yet; discount the unknown
  }

  const defenderSurvives = !!defender && !kills;
  let wipesBoard = kills && foe.bench.length === 0;

  if (effect) {
    switch (effect.kind) {
      case 'rot':
        if (defenderSurvives && !defender.rot) score += ROT_VALUE;
        break;
      case 'stun':
        if (defenderSurvives && !defender.stun) score += STUN_VALUE;
        break;
      case 'selfHeal': {
        const room = Math.max(0, maxHpOf(attacker) - attacker.hp);
        score += Math.min(effect.amount, room) * HEAL_FACTOR;
        break;
      }
      case 'shield':
        score += effect.amount * SHIELD_FACTOR;
        break;
      case 'selfDamage': {
        score -= effect.amount * SELF_DAMAGE_FACTOR;
        if (attacker.hp <= effect.amount) {
          // Trading our own active away: they score a pip, and it might end the game.
          score -= KO_VALUE;
          if (foe.score + 1 >= WIN_SCORE || me.bench.length === 0) score -= WIN_VALUE;
        }
        break;
      }
      case 'discardOwnEnergy':
        score -= Math.min(effect.count, totalEnergy(attacker.energy)) * DISCARD_ENERGY_VALUE;
        break;
      case 'drainEnergy':
        if (defenderSurvives) score += Math.min(effect.count, totalEnergy(defender.energy)) * DRAIN_VALUE;
        break;
      case 'benchDamage': {
        const bench = foe.bench;
        if (bench.length === 0) break;
        if (effect.scope === 'all') {
          let doomed = 0;
          for (const c of bench) {
            score += Math.min(effect.amount, c.hp) * BENCH_DAMAGE_FACTOR;
            if (c.hp <= effect.amount) {
              kos += 1;
              doomed += 1;
              score += KO_VALUE;
            }
          }
          if (kills && doomed === bench.length) wipesBoard = true;
        } else {
          // One random bench creature: average the outcomes rather than guess the roll.
          let splash = 0;
          let lethalShare = 0;
          for (const c of bench) {
            splash += Math.min(effect.amount, c.hp) * BENCH_DAMAGE_FACTOR;
            if (c.hp <= effect.amount) lethalShare += 1;
          }
          score += splash / bench.length;
          score += (lethalShare / bench.length) * KO_VALUE;
          kos += lethalShare / bench.length;
        }
        break;
      }
      default:
        break; // unknown effect kinds simply score as plain damage
    }
  }

  if (me.score + Math.floor(kos) >= WIN_SCORE) score += WIN_VALUE; // fourth pip
  else if (wipesBoard) score += WIN_VALUE; // nothing left for them to promote

  return { score, dealt, kills, kos };
}

/**
 * The best attack a creature is working toward, discounted by how many attaches it still
 * needs. This is the number `attach` decisions maximise the derivative of.
 */
function planValue(state, side, creature, energy, defender) {
  const attacks = cardById(creature.cardId).attacks;
  let best = 0;
  for (let i = 0; i < attacks.length; i++) {
    const need = energyShortfall(energy, attacks[i].cost);
    const raw = Math.min(attackScore(state, side, creature, i, defender).score, PLAN_CAP);
    const value = raw / (1 + DELAY_DISCOUNT * need);
    if (value > best) best = value;
  }
  return best;
}

/**
 * The biggest hit the opponent's active can put on `creature` on their next turn — they get one
 * attach before swinging, so anything within one energy of its threshold counts. Rot is added
 * because it lands on the same clock. A stunned active is treated as harmless (approximate
 * during a promote interrupt on their own turn, but the error is one turn of caution).
 */
function foeThreat(state, side, creature) {
  const rotTick = creature.rot ? ROT_DAMAGE : 0;
  const foeActive = state.players[1 - side].active;
  if (!foeActive || foeActive.stun) return rotTick;
  const card = cardById(foeActive.cardId);
  let hardest = 0;
  for (const atk of card.attacks) {
    if (energyShortfall(foeActive.energy, atk.cost) > 1) continue; // out of reach next turn
    const typed = typedDamage(card.type, creature.cardId, atk.damage);
    const landed = Math.max(0, typed.amount - (creature.shield || 0));
    if (landed > hardest) hardest = landed;
  }
  return hardest + rotTick;
}

// ---------------------------------------------------------------------------
// choice plumbing
// ---------------------------------------------------------------------------

/** Public-state fingerprint: the default noise seed. Never touches anyone's hand contents. */
function stateFingerprint(state) {
  const parts = [
    state.seed,
    state.turn,
    state.phase,
    state.acting,
    state.turnPlayer,
    state.attachedThisTurn ? 1 : 0,
    state.retreatedThisTurn ? 1 : 0,
    state.attackedThisTurn ? 1 : 0,
  ];
  for (const p of state.players) {
    parts.push(p.score, p.deck.length, p.hand.length, p.discard.length);
    for (const c of ownCreatures(p)) {
      parts.push(c.uid, c.hp, c.shield, c.rot ? 1 : 0, c.stun ? 1 : 0, ENERGY_TYPES.map((t) => c.energy[t]).join(''));
    }
  }
  return parts.join('|');
}

function resolveRng(state, opts) {
  if (typeof opts.rng === 'function') return opts.rng;
  return createRng(opts.seed !== undefined ? opts.seed : stateFingerprint(state));
}

/**
 * Highest score wins. With noise > 0, everything within `noise * NOISE_BAND` of the best is a
 * uniform coin flip — enough to make the opponent feel less mechanical without letting it
 * throw the game. With noise 0 the rng is never consulted.
 */
function pickBest(scored, ctx) {
  let best = scored[0];
  for (const cand of scored) if (cand.score > best.score) best = cand;
  if (!(ctx.noise > 0) || scored.length === 1) return best.action;
  const cutoff = best.score - ctx.noise * NOISE_BAND;
  const pool = scored.filter((c) => c.score >= cutoff);
  if (pool.length <= 1) return best.action;
  return pool[Math.min(pool.length - 1, Math.floor(ctx.rand() * pool.length))].action;
}

// ---------------------------------------------------------------------------
// setup phase
// ---------------------------------------------------------------------------

/**
 * Opening active. Wants the creature that reaches a real attack soonest and can take a punch
 * while it gets there; tier 3 is penalised because its attacks are 2-4 attaches away and its
 * retreat cost makes the mistake permanent. Player 1 chooses *after* player 0 has placed, so
 * when the opposing active is already on the board this is weakness-aware.
 */
function chooseSetupActive(state, options, ctx) {
  const side = state.acting;
  const foeActive = state.players[1 - side].active; // null when we place first
  const scored = options.map((action) => {
    const card = cardById(action.cardId);
    const virtual = {
      uid: 'ai:opening',
      cardId: action.cardId,
      hp: card.hp,
      energy: blankEnergy(),
      rot: false,
      stun: false,
      shield: 0,
    };
    let score = planValue(state, side, virtual, virtual.energy, foeActive);
    score += card.hp * 0.25; // it will be the first thing swung at
    score -= card.retreatCost * 8; // a big retreat cost means we are stuck with this choice
    if (card.tier === 3) score -= 20; // a wall we cannot power is a wall we cannot use
    return { action, score };
  });
  return pickBest(scored, ctx);
}

// ---------------------------------------------------------------------------
// promote phase
// ---------------------------------------------------------------------------

/**
 * Forced promotion. "Best answer to their active" is three things at once: hits it hardest
 * (weakness-aware, with the energy already attached), survives its next swing, and is not our
 * most fragile body. A promotion that dies immediately is a free pip for them.
 */
function choosePromote(state, options, ctx) {
  const side = state.acting;
  const me = state.players[side];
  const foeActive = state.players[1 - side].active; // may be null: both actives can die at once
  const scored = options.map((action) => {
    const c = findOwn(me, action.uid);
    const card = cardById(c.cardId);
    let score = planValue(state, side, c, c.energy, foeActive);
    score += c.hp * 0.2;
    score -= card.retreatCost * 4; // cheap retreats keep the option to rotate back out
    const threat = foeThreat(state, side, c);
    if (threat >= c.hp) score -= KO_VALUE * 0.8 + totalEnergy(c.energy) * ENERGY_VALUE * 0.5;
    else score += 15;
    return { action, score };
  });
  return pickBest(scored, ctx);
}

// ---------------------------------------------------------------------------
// main phase
// ---------------------------------------------------------------------------

/** Retreat is priced, not free: the cost comes off the leaving creature and stays off. */
function planRetreat(state, side, retreatOptions) {
  if (retreatOptions.length === 0) return null;
  const me = state.players[side];
  const foe = state.players[1 - side];
  const active = me.active;
  const defender = foe.active;
  const cost = cardById(active.cardId).retreatCost;
  const activeValue = active.stun ? 0 : planValue(state, side, active, active.energy, defender);
  const doomed = foeThreat(state, side, active) >= active.hp;
  let best = null;
  for (const action of retreatOptions) {
    const incoming = findOwn(me, action.toUid);
    let score = planValue(state, side, incoming, incoming.energy, defender) - activeValue;
    score -= cost * ENERGY_VALUE * 0.6; // energy burned to leave is energy we spent getting there
    if (doomed) score += KO_VALUE * 0.6; // pulling it out denies them the pip
    if (foeThreat(state, side, incoming) >= incoming.hp) score -= KO_VALUE * 0.6;
    if (active.stun) score += STUN_VALUE * 0.5; // a stunned active is a wasted turn
    if (active.rot) score += ROT_VALUE * 0.5; // retreating scrubs rot
    if (!best || score > best.score) best = { action, score, toUid: action.toUid };
  }
  return best;
}

/**
 * Where the turn's one energy goes: whichever attach most raises somebody's discounted best
 * attack, weighted toward whoever is going to be swinging. A creature that dies before it can
 * use the energy gets discounted; a creature already at its threshold still takes a nudge,
 * because padding above a threshold is what survives a `drainEnergy`.
 */
function chooseAttach(state, side, attachOptions, ctx, plan) {
  const me = state.players[side];
  const defender = state.players[1 - side].active;
  const scored = attachOptions.map((action) => {
    const c = findOwn(me, action.targetUid);
    const isActive = !!me.active && me.active.uid === c.uid;
    // A planned retreat means the *incoming* creature is the one that will be swinging.
    const willSwing = plan.retreat ? plan.retreat.toUid === c.uid : isActive;
    const before = planValue(state, side, c, c.energy, defender);
    const after = planValue(state, side, c, addEnergy(c.energy, action.energyType), defender);
    let score = (after - before) * (willSwing ? 1 : BENCH_SLOT_WEIGHT);
    if (willSwing && foeThreat(state, side, c) >= c.hp) score *= DOOMED_DISCOUNT;
    if (after <= before) score += willSwing ? 4 : 1; // padding / retreat fuel is still worth something
    if (isActive) score += ACTIVE_TIE_BONUS;
    return { action, score };
  });
  return pickBest(scored, ctx);
}

/** Bench development: cheapest first, so the body can be powered and promoted the soonest. */
function chooseBench(state, side, benchOptions, ctx) {
  const scored = benchOptions.map((action) => {
    const card = cardById(action.cardId);
    const cheapest = Math.min(...card.attacks.map((a) => sumCost(a.cost)));
    let score = 100 - card.tier * 22 - cheapest * 8 + card.hp * 0.15 - card.retreatCost * 2;
    return { action, score };
  });
  return pickBest(scored, ctx);
}

function chooseMain(state, options, ctx) {
  const side = state.acting;
  const me = state.players[side];
  const endTurn = options.find((a) => a.type === 'endTurn');
  const attachOptions = options.filter((a) => a.type === 'attach');
  const benchOptions = options.filter((a) => a.type === 'bench');
  const retreatOptions = options.filter((a) => a.type === 'retreat');
  const attacks = options
    .filter((a) => a.type === 'attack')
    .map((action) => ({ action, ...attackScore(state, side, me.active, action.attackIndex, state.players[1 - side].active) }));

  // 1. Lethal now. Attacking ends the turn, so before swinging, bank the free stuff: energy is
  //    a threshold and is never spent, so an attach can only help, and it cannot make the
  //    lethal illegal. Same for a bench body. A line that ends the game skips the pleasantries.
  const lethal = attacks.filter((a) => a.kills);
  if (lethal.length > 0) {
    const scored = lethal.map((a) => ({ action: a.action, score: a.score }));
    const gameWinning = lethal.some((a) => a.score >= WIN_VALUE);
    if (!gameWinning) {
      if (attachOptions.length > 0) return chooseAttach(state, side, attachOptions, ctx, { retreat: null });
      if (benchOptions.length > 0 && me.bench.length < BENCH_TARGET) {
        return chooseBench(state, side, benchOptions, ctx);
      }
    }
    return pickBest(scored, ctx);
  }

  // Retreat is decided before the attach so the energy can follow the creature that will swing.
  const retreat = retreatOptions.length > 0 ? planRetreat(state, side, retreatOptions) : null;
  const plan = { retreat: retreat && retreat.score > RETREAT_THRESHOLD ? retreat : null };

  // 2. Attach — always, when it is legal. There is no such thing as a wasted attach on the
  //    board (generic costs soak the wrong type), only a badly aimed one.
  if (attachOptions.length > 0) return chooseAttach(state, side, attachOptions, ctx, plan);

  // 3. Bench development (floor 2 per PLAN.md, target 3 — see BENCH_TARGET).
  if (benchOptions.length > 0 && me.bench.length < BENCH_TARGET) {
    return chooseBench(state, side, benchOptions, ctx);
  }

  // 4. Tactical retreat.
  if (plan.retreat) return plan.retreat.action;

  // 5. Best expected attack — but only if it is actually worth doing to ourselves.
  const worthwhile = attacks.filter((a) => a.score > 0);
  if (worthwhile.length > 0) {
    return pickBest(worthwhile.map((a) => ({ action: a.action, score: a.score })), ctx);
  }

  // 6. Nothing left worth doing.
  return endTurn || options[0];
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Choose one legal action for `state.acting`.
 *
 * @param {object} state  engine state, any phase but 'over'
 * @param {object} [opts]
 * @param {number} [opts.noise=0.1]  0-1 tie-band randomness (0 = strictly deterministic)
 * @param {function} [opts.rng]      `() -> [0,1)`; supply one to control the noise stream
 * @param {*}      [opts.seed]       seed for the built-in mulberry32 when `rng` is absent
 * @returns {object} an Action from `legalActions(state)`
 */
export function chooseAction(state, opts = {}) {
  const options = legalActions(state);
  if (options.length === 0) {
    throw new Error(`chooseAction: no legal actions in phase "${state.phase}" — the game is over`);
  }
  const noise = Math.max(0, Math.min(1, opts.noise === undefined ? DEFAULT_NOISE : opts.noise));
  // The rng is built lazily-ish but unconditionally cheap; pickBest only draws when noise > 0.
  const rng = noise > 0 ? resolveRng(state, opts) : null;
  const ctx = { noise, rand: rng ? () => rng() : () => 0 };

  switch (state.phase) {
    case 'setup':
      return chooseSetupActive(state, options, ctx);
    case 'promote':
      return choosePromote(state, options, ctx);
    case 'main':
      return chooseMain(state, options, ctx);
    default:
      // Unknown future phase: still return something legal rather than throwing at the UI.
      return options[0];
  }
}

export default chooseAction;
