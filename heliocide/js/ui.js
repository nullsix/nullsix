// HELIOCIDE — DOM rendering + input (M4). Owns the game loop and the visual log.
//
// Layering law: this file may import everything; nothing imports it back — except
// gallery.html, which reuses the card renderer (`cardHtml`, `sigilSvg`, the legend helpers) and,
// since M4.5, the art switch (`artMode`, `setArtMode`, `onArtMode`, `artSwitchHtml`,
// `asciiArtHtml`). Nothing here runs at import time: `boot()` is the only entry point, so the
// gallery can pull the renderer in without starting a game.
//
// Mobile-portrait first. The whole screen is laid out in one scale unit, `--u` (see style.css),
// which is `min(viewportWidth/400, viewportHeight/780)` — the 390x844 design shrinks to fit
// whatever it is handed instead of clipping or scrolling.
//
// Two engine facts drive the control flow (PLAN.md "M1 as-built addenda"):
//   * dispatch on `state.acting`, never `turnPlayer` — after an attack the state can be
//     phase:'promote' with the *other* player acting, so the human's promote modal has to be
//     able to interrupt the middle of the AI's turn (and vice versa);
//   * only ever offer actions that appear in `legalActions(state)`; illegal ones throw.
//
// `js/ai.js` is loaded lazily and defensively (it is written by a parallel agent): if it is
// missing, or throws, or hands back something illegal, the built-in stub picks the first legal
// action so the game still plays.

import {
  WIN_SCORE,
  BENCH_LIMIT,
  ENERGY_TYPES,
  createGame,
  legalActions,
  applyAction,
  winner,
  costMet,
  maxHpOf,
} from './engine.js';
import { CARDS, TYPES, DECKS, cardById, deckById, typeById } from './cards.js';
import { artFor } from './art.js';
import { createRng } from './rng.js';

const HUMAN = 0;
const AI = 1;

// Opponent skill: three brains behind one knob. 'cunning' is the real heuristic at its
// intended noise; 'wayward' is the same brain making real plays but missing real lines;
// 'mindless' ignores ai.js entirely and picks uniformly from legalActions.
const AI_MODES = {
  cunning: { label: 'Cunning', noise: 0.08 },
  wayward: { label: 'Wayward', noise: 0.65 },
  mindless: { label: 'Mindless', random: true },
};
const AI_MODE_KEY = 'heliocide.aiMode';
const AI_MODE_DEFAULT = 'wayward';
let aiModeCache = null;

function aiMode() {
  if (aiModeCache) return aiModeCache;
  let stored = null;
  try {
    stored = localStorage.getItem(AI_MODE_KEY);
  } catch {
    /* private mode — default is fine, the switch still works in-session */
  }
  aiModeCache = Object.hasOwn(AI_MODES, stored) ? stored : AI_MODE_DEFAULT;
  return aiModeCache;
}

function setAiMode(mode) {
  aiModeCache = Object.hasOwn(AI_MODES, mode) ? mode : AI_MODE_DEFAULT;
  try {
    localStorage.setItem(AI_MODE_KEY, aiModeCache);
  } catch {
    /* not persisting is survivable */
  }
  return aiModeCache;
}

// Mixed into every AI seed so consecutive decisions in one turn draw fresh randomness
// (state.rng only advances on shuffle/random-splash, so it is constant across a turn).
let aiDecisionCount = 0;

const MOTION_OK =
  typeof matchMedia === 'function' ? !matchMedia('(prefers-reduced-motion: reduce)').matches : true;
const AI_DELAY = MOTION_OK ? 460 : 110;
const AI_ACTION_CAP = 80; // a legal turn is ~6 actions; this only ever catches a runaway AI

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const ROMAN = ['', 'I', 'II', 'III', 'IV'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sum(obj) {
  let n = 0;
  for (const t of ENERGY_TYPES) n += obj[t] || 0;
  return n;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flash(el, cls, ms) {
  if (!el) return;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// ---------------------------------------------------------------------------
// type + glyph display
// ---------------------------------------------------------------------------

// `︎` is the text-presentation selector: it keeps iOS from promoting a dingbat like
// U+274B to a colour-emoji font. Paired with `font-variant-emoji: text` in the CSS.
const VS15 = '︎';

export function typeGlyph(typeId) {
  return `<span class="glyph t-${typeId}" aria-hidden="true">${typeById(typeId).glyph}${VS15}</span>`;
}

export function typeName(typeId) {
  return typeById(typeId).name;
}

/** One pip: a type-coloured disc carrying the type glyph. `any` is the hollow one. */
function pip(typeId, extraCls = '') {
  if (typeId === 'any') {
    return `<span class="pip pip--any ${extraCls}" title="any energy" aria-label="any energy"></span>`;
  }
  const t = typeById(typeId);
  return `<span class="pip t-${typeId} ${extraCls}" title="${esc(t.name)}" aria-label="${esc(t.name)}">${t.glyph}${VS15}</span>`;
}

/** Attack cost as pips, typed in TYPES order then generic. */
function costPips(cost, extraCls = '') {
  let out = '';
  for (const t of ENERGY_TYPES) for (let i = 0; i < (cost[t] || 0); i++) out += pip(t, extraCls);
  for (let i = 0; i < (cost.any || 0); i++) out += pip('any', extraCls);
  return out || pip('any', extraCls);
}

/** Attached energy as pips (what a creature is carrying). */
function energyPips(energy) {
  let out = '';
  for (const t of ENERGY_TYPES) for (let i = 0; i < (energy[t] || 0); i++) out += pip(t);
  return out;
}

/**
 * The smallest set of extra energy that would make `cost` payable — mirrors engine `costMet`:
 * typed requirements are per-type, `any` is covered by whatever is left over.
 */
export function costDeficit(energy, cost) {
  const typedMissing = {};
  let typedNeed = 0;
  let missingCount = 0;
  for (const k of Object.keys(cost || {})) {
    if (k === 'any') continue;
    typedNeed += cost[k];
    const short = Math.max(0, cost[k] - (energy[k] || 0));
    if (short > 0) {
      typedMissing[k] = short;
      missingCount += short;
    }
  }
  const totalAfterTyped = sum(energy) + missingCount;
  const anyMissing = Math.max(0, (cost.any || 0) - (totalAfterTyped - typedNeed));
  return { typed: typedMissing, any: anyMissing, count: missingCount + anyMissing };
}

function deficitPips(deficit) {
  let out = '';
  for (const t of ENERGY_TYPES) for (let i = 0; i < (deficit.typed[t] || 0); i++) out += pip(t, 'pip--miss');
  for (let i = 0; i < deficit.any; i++) out += pip('any', 'pip--miss');
  return out;
}

// ---------------------------------------------------------------------------
// effects
// ---------------------------------------------------------------------------

/** Exported so gallery.html can print the same pips in its reading key. */
export function pipHtml(typeId) {
  return pip(typeId);
}

export function costPipsHtml(cost) {
  return costPips(cost);
}

export function energyPipsHtml(energy) {
  return energyPips(energy);
}

export const EFFECTS = {
  rot: { mark: '❋', label: (e) => 'inflicts Rot (10 a turn)' },
  stun: { mark: '✦', label: () => 'stuns: no attack next turn' },
  selfHeal: { mark: '+', label: (e) => `heals itself ${e.amount}` },
  benchDamage: { mark: '※', label: (e) => `${e.amount} to ${e.scope === 'all' ? 'every benched foe' : 'a random benched foe'}` },
  selfDamage: { mark: '⚠', label: (e) => `takes ${e.amount} itself` },
  discardOwnEnergy: { mark: '−', label: (e) => `discards ${e.count} of its own energy` },
  drainEnergy: { mark: '↯', label: (e) => `strips ${e.count} energy from the target` },
  shield: { mark: '⛊', label: (e) => `shields ${e.amount} until your next turn` },
};

function effectMark(effect) {
  if (!effect) return '';
  const info = EFFECTS[effect.kind];
  if (!info) return '';
  return `<span class="eff" title="${esc(info.label(effect))}">${info.mark}${VS15}</span>`;
}

function effectLine(effect) {
  if (!effect) return '';
  const info = EFFECTS[effect.kind];
  if (!info) return '';
  return `<span class="eff-line"><span class="eff">${info.mark}${VS15}</span> ${esc(info.label(effect))}</span>`;
}

// ---------------------------------------------------------------------------
// sigils — one procedural inline-SVG mark per `sigil` token in cards.js
// ---------------------------------------------------------------------------

const SIGILS = {
  shard: '<path d="M12 2.5 14.2 9.2 21 11.6 14.2 14 12 21.5 9.8 14 3 11.6 9.8 9.2Z"/><path d="M12 8.5v7" opacity=".45"/>',
  door: '<path d="M5 21.5V10.5a7 7 0 0 1 14 0v11"/><path d="M12 10.5v11"/><circle cx="9.2" cy="14.5" r=".9" fill="currentColor" stroke="none"/>',
  hound: '<path d="M4.5 6.5 8.5 10h7l4-3.5v5.5L12 21 4.5 12Z"/><circle cx="9.6" cy="12.4" r=".85" fill="currentColor" stroke="none"/><circle cx="14.4" cy="12.4" r=".85" fill="currentColor" stroke="none"/>',
  ossuary:
    '<path d="M6.5 7.5h11M6.5 13h11M6.5 18.5h11"/><circle cx="5.6" cy="7.5" r="1.5"/><circle cx="18.4" cy="7.5" r="1.5"/><circle cx="5.6" cy="13" r="1.5"/><circle cx="18.4" cy="13" r="1.5"/><circle cx="5.6" cy="18.5" r="1.5"/><circle cx="18.4" cy="18.5" r="1.5"/>',
  wisp: '<path d="M12 2.5c3.6 5.2 5 7.6 5 10.2a5 5 0 0 1-10 0c0-2.6 1.4-5 5-10.2Z"/><path d="M12 12.5c1.2 2 1.7 3 1.7 4a1.7 1.7 0 0 1-3.4 0c0-1 .5-2 1.7-4Z" opacity=".55"/>',
  sow: '<circle cx="10.2" cy="14.4" r="6"/><circle cx="18" cy="10.8" r="2.7"/><path d="M16.6 8.2 17.6 5.6M20.2 9l1.4-2.2"/><circle cx="18.5" cy="10.8" r=".7" fill="currentColor" stroke="none"/>',
  geode: '<path d="M12 2.5 20 7v10l-8 4.5L4 17V7Z"/><path d="M12 7.5 16 9.8v4.6L12 16.7 8 14.4V9.8Z" opacity=".6"/>',
  drake: '<path d="M2.5 7.5 8 9.2 12 4.5l4 4.7 5.5-1.7-3 6.5L12 21.5 5.5 14Z"/><circle cx="10.6" cy="10.6" r=".8" fill="currentColor" stroke="none"/><circle cx="13.4" cy="10.6" r=".8" fill="currentColor" stroke="none"/>',
  bloom:
    '<circle cx="12" cy="6.5" r="3"/><circle cx="17.6" cy="10.6" r="3"/><circle cx="15.4" cy="17.2" r="3"/><circle cx="8.6" cy="17.2" r="3"/><circle cx="6.4" cy="10.6" r="3"/><circle cx="12" cy="12.5" r="1.5" fill="currentColor" stroke="none"/>',
  thorn: '<path d="M5 21.5C9 15 12.5 9 19.5 3.5"/><path d="M8.6 15.6 6 12.4M12 11.2 9.6 7.8M15.4 7.2 13.2 4"/>',
  leech: '<path d="M6 21.5c1-8 4.5-11 6-12.5 1.8-1.8 3-3.5 3-6"/><circle cx="15" cy="3.6" r="2.4"/><circle cx="15" cy="3.6" r=".9" fill="currentColor" stroke="none"/><path d="M7.6 17.2h3.6M9.4 13.2h3.6"/>',
  maw: '<path d="M3.5 8.5c3.5 3 13.5 3 17 0"/><path d="M3.5 15.5c3.5-3 13.5-3 17 0"/><path d="M6 8.8l1.6 2.4L9.4 8.8l1.8 2.4 1.8-2.4 1.8 2.4 1.6-2.4"/><path d="M6 15.2l1.6-2.4 1.8 2.4 1.8-2.4 1.8 2.4 1.8-2.4 1.6 2.4" opacity=".6"/>',
  fork: '<path d="M12 21.5v-8.5"/><path d="M7.5 13h9"/><path d="M7.5 13V4.5M16.5 13V4.5"/>',
  pup: '<circle cx="12" cy="12" r="5"/><path d="M7.6 8.6 5 13.4M16.4 8.6 19 13.4"/><path d="M7.5 19.5h9"/><circle cx="10.2" cy="11.4" r=".8" fill="currentColor" stroke="none"/><circle cx="13.8" cy="11.4" r=".8" fill="currentColor" stroke="none"/>',
  tog: '<rect x="4.5" y="7.5" width="15" height="10" rx="2.5"/><path d="M7.5 17.5v3.5M16.5 17.5v3.5"/><path d="M7.5 11h3.5M13 11h3.5"/>',
  coil: '<path d="M18.5 12a6.5 6.5 0 1 1-6.5-6.5"/><path d="M12 15.5A3.5 3.5 0 1 0 15.5 12"/><path d="M12 5.5h6.5"/>',
  sprite: '<circle cx="12" cy="12" r="8" opacity=".4"/><path d="M12 3.5 13.6 10.4 20.5 12 13.6 13.6 12 20.5 10.4 13.6 3.5 12 10.4 10.4Z"/>',
  lamp: '<path d="M9 8h6l1.5 10h-9Z"/><path d="M10.5 5.5h3"/><path d="M12 5.5V3"/><path d="M12 11c1 1.4 1.4 2.2 1.4 3a1.4 1.4 0 0 1-2.8 0c0-.8.4-1.6 1.4-3Z" fill="currentColor" stroke="none" opacity=".7"/>',
  storm: '<path d="M6.5 12.5a3.5 3.5 0 0 1 .6-7 5 5 0 0 1 9.3-.3 3.9 3.9 0 0 1 .6 7.3"/><path d="M13 10.5 9.5 16h4l-2 5.5 5.5-7h-4Z"/>',
  frost: '<path d="M12 2.5v19M3.8 7.2l16.4 9.6M20.2 7.2 3.8 16.8"/><path d="M12 6.5 9.6 4.6M12 6.5l2.4-1.9M12 17.5l-2.4 1.9M12 17.5l2.4 1.9"/>',
};

const SIGIL_FALLBACK = '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>';

/** Inline SVG mark for a sigil token. Procedural, no image files, inherits `currentColor`. */
export function sigilSvg(sigil) {
  const body = SIGILS[sigil] || SIGIL_FALLBACK;
  return (
    `<svg class="sigil" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" ` +
    `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}

export const SIGIL_NAMES = Object.keys(SIGILS);

// ---------------------------------------------------------------------------
// art mode — the sigil/ASCII switch (M4.5)
//
// Two complete art systems, neither a fallback for the other: the procedural SVG sigils above,
// and the hand-authored ASCII plates in js/art.js. The choice is one string in localStorage and
// it drives every render on both pages — board art window, zoom overlay, gallery.
//
// gallery.html has no game loop, so it drives this through the same three exports the duel
// screen uses (`artMode`, `setArtMode`, `onArtMode`) and re-renders itself from the listener.
// ---------------------------------------------------------------------------

const ART_KEY = 'heliocide.artMode';
const ART_MODES = ['ascii', 'sigil'];
const ART_DEFAULT = 'ascii';

let artModeCache = null;
const artListeners = [];

function stampArtAttr(mode) {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-art', mode);
  }
}

/** Current art mode: 'ascii' (default) or 'sigil'. Reads localStorage once, then caches. */
export function artMode() {
  if (artModeCache) return artModeCache;
  let stored = null;
  try {
    stored = localStorage.getItem(ART_KEY);
  } catch {
    /* private mode / file:// — fall through to the default; the toggle still works in-session */
  }
  artModeCache = ART_MODES.includes(stored) ? stored : ART_DEFAULT;
  stampArtAttr(artModeCache);
  return artModeCache;
}

/** Set the art mode, persist it, and tell every listener (the board and the gallery). */
export function setArtMode(mode) {
  const next = ART_MODES.includes(mode) ? mode : ART_DEFAULT;
  artModeCache = next;
  try {
    localStorage.setItem(ART_KEY, next);
  } catch {
    /* not persisting is survivable; not switching is not */
  }
  stampArtAttr(next);
  for (const fn of artListeners) {
    try {
      fn(next);
    } catch {
      /* one bad listener must not strand the other page's render */
    }
  }
  return next;
}

export function onArtMode(fn) {
  if (typeof fn === 'function') artListeners.push(fn);
}

/** The switch itself. `cls` lets the gallery wrap it in its own bordered bar. */
export function artSwitchHtml(cls = '') {
  const cur = artMode();
  const seg = [
    ['ascii', 'ASCII art'],
    ['sigil', 'Sigils'],
  ]
    .map(
      ([mode, label]) =>
        `<button class="artbtn${cur === mode ? ' is-on' : ''}" data-act="artmode" data-mode="${mode}" ` +
        `aria-pressed="${cur === mode}">${label}</button>`,
    )
    .join('');
  return `<div class="artswitch ${cls}" role="group" aria-label="Card art style">
    <span class="artswitch-label">Card art</span>
    <span class="artseg">${seg}</span>
  </div>`;
}

/**
 * The ASCII plate for a card: a <pre> whose glyphs are painted with the type's gradient (see
 * `.ascii` in style.css). Decorative, so it is hidden from assistive tech — the card's name,
 * type and numbers already say everything the picture is saying.
 *
 * The gradient comes from `--tg` on an ancestor `.t-<type>`, which is the card (or, in the
 * gallery's plate grid, the figure). Pass `cls: 't-bone'` etc. to stand one up on its own.
 */
export function asciiArtHtml(cardId, { cls = '' } = {}) {
  return `<pre class="ascii ${cls}" aria-hidden="true">${esc(artFor(cardId))}</pre>`;
}

/** What goes in a card's art window, per the current mode. */
function cardArtHtml(card) {
  return artMode() === 'sigil' ? sigilSvg(card.sigil) : asciiArtHtml(card.id);
}

// ---------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------

/**
 * One card, at one of four sizes. Everything inside is em-based off the card width, so a size
 * is just a width in style.css:
 *   `board` — the active creature, the big readable one (150 design px)
 *   `hand`  — the fanned hand (100 design px)
 *   `chip`  — a bench slot: same DOM, grid-rearranged into a wide two-line strip
 *   `zoom`  — the full-size overlay, the only size that carries flavour + attack text
 *
 * opts: { size, creature, cls, attrs, faceDown }
 * `creature` is a live engine creature (or any {hp, energy, rot, stun, shield, uid}-shaped
 * mock, which is how gallery.html shows in-play cards) and switches on hp/energy/status chrome.
 */
export function cardHtml(cardId, opts = {}) {
  const { size = 'hand', creature = null, cls = '', attrs = '', faceDown = false } = opts;
  const card = cardById(cardId);
  const type = typeById(card.type);

  if (faceDown) {
    return `<div class="card card--${size} card--back ${cls}" ${attrs}><span class="back-mark">✷${VS15}</span></div>`;
  }

  const maxHp = card.hp;
  const hp = creature ? creature.hp : maxHp;
  const pct = Math.max(0, Math.min(100, (100 * hp) / maxHp));
  const low = pct <= 34 ? ' is-low' : pct <= 67 ? ' is-mid' : '';

  const badges = [];
  if (creature) {
    if (creature.rot) badges.push('<span class="badge b-rot" title="Rot: 10 at the end of its turn">❋' + VS15 + '</span>');
    if (creature.stun) badges.push('<span class="badge b-stun" title="Stunned: cannot attack next turn">✦' + VS15 + '</span>');
    if (creature.shield > 0) {
      badges.push(`<span class="badge b-shield" title="Shield ${creature.shield}">⛊${VS15}${creature.shield}</span>`);
    }
  }

  const atks = card.attacks
    .map(
      (atk, i) => `<div class="c-atk" data-i="${i}">
        <span class="c-cost">${costPips(atk.cost)}</span>
        <span class="c-an">${esc(atk.name)}${effectMark(atk.effect)}</span>
        <span class="c-dm">${atk.damage}</span>
      </div>${size === 'zoom' ? `<div class="c-atext">${effectLine(atk.effect)}${effectLine(atk.effect) ? ' · ' : ''}<i>${esc(atk.text)}</i></div>` : ''}`,
    )
    .join('');

  // The tier marker lives in the footer, not the header: at board size the header needs every
  // pixel for a 23-character card name.
  const wr = [`<span class="c-tier" title="Tier ${card.tier}">${ROMAN[card.tier]}</span>`];
  if (card.weakness) wr.push(`<span class="wk" title="Weak to ${esc(typeName(card.weakness))} (x2)">weak ${typeGlyph(card.weakness)}</span>`);
  if (card.resistance) wr.push(`<span class="rs" title="Resists ${esc(typeName(card.resistance))} (-20)">res ${typeGlyph(card.resistance)}</span>`);
  wr.push(`<span class="rc" title="Retreat cost: ${card.retreatCost} attached energy">⇄${VS15}${card.retreatCost}</span>`);

  return `<div class="card card--${size} t-${card.type} ${cls}" data-cid="${cardId}"${creature ? ` data-uid="${creature.uid}"` : ''} ${attrs}>
    ${badges.length ? `<div class="c-badges">${badges.join('')}</div>` : ''}
    <div class="c-head">
      ${typeGlyph(card.type)}
      <span class="c-name">${esc(card.name)}</span>
    </div>
    <div class="c-art">${cardArtHtml(card)}</div>
    <div class="c-hp${low}"><span class="c-hp-fill" style="width:${pct}%"></span><span class="c-hp-num">${hp}<i>/${maxHp}</i></span></div>
    <div class="c-pips">${creature ? energyPips(creature.energy) || '<span class="c-noen">no energy</span>' : `<span class="c-type">${esc(type.name)} · T${card.tier}</span>`}</div>
    <div class="c-atks">${atks}</div>
    <div class="c-foot">${wr.join('')}</div>
    ${size === 'zoom' ? `<div class="c-flavor">${esc(card.flavor)}</div>` : ''}
  </div>`;
}

/** The five-type legend (used by the gallery and the rules panel). */
export function typeLegendHtml() {
  return `<div class="legend">${TYPES.map(
    (t) => `<div class="legend-row t-${t.id}">
      ${typeGlyph(t.id)}
      <span class="legend-name">${esc(t.name)}</span>
      <span class="legend-id">${esc(t.id)}</span>
      <span class="legend-swatch" style="background:${t.color}"></span>
    </div>`,
  ).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// narration — built from applyAction events (there is no turnEnd event; the next
// turnStart marks the boundary)
// ---------------------------------------------------------------------------

function nameOf(cardId) {
  return cardById(cardId).name;
}

function side(playerIndex) {
  return playerIndex === HUMAN ? 'You' : 'They';
}

function possessive(playerIndex) {
  return playerIndex === HUMAN ? 'Your' : 'Their';
}

/** -> { text, sub?, cls } or null for events that need no line. */
function narrate(ev, state) {
  const mine = ev.player === HUMAN;
  switch (ev.kind) {
    case 'turnStart':
      return {
        text: `Turn ${ev.turn} — ${mine ? 'your move' : 'their move'}`,
        cls: `l-turn ${mine ? 'l-you' : 'l-foe'}`,
      };
    case 'draw':
      return {
        // Never leak the opponent's card: only the human's own draw is named.
        text: mine ? `You draw ${nameOf(ev.cardId)}.` : `They draw a card (${ev.handCount} in hand).`,
        cls: 'l-quiet',
      };
    case 'bench':
      return { text: `${side(ev.player)} bench ${nameOf(ev.cardId)}.`, cls: 'l-play' };
    case 'promote':
      if (ev.reason === 'setup') {
        return { text: `${side(ev.player)} lead with ${nameOf(ev.cardId)}.`, cls: 'l-play' };
      }
      return { text: `${nameOf(ev.cardId)} steps up to fill the gap.`, cls: 'l-play' };
    case 'attach':
      return {
        text: `${side(ev.player)} channel ${typeName(ev.energyType)} into ${nameOf(ev.cardId)}.`,
        cls: 'l-energy',
      };
    case 'retreat':
      return {
        text: `${nameOf(ev.fromCardId)} falls back; ${nameOf(ev.toCardId)} takes the front${ev.cost ? ` (${ev.cost} energy spent)` : ''}.`,
        cls: 'l-play',
      };
    case 'attack':
      return {
        text: `${nameOf(ev.cardId)} — ${ev.attackName}!`,
        sub: ev.text,
        cls: `l-attack ${mine ? 'l-you' : 'l-foe'}`,
      };
    case 'damage': {
      const tags = [];
      if (ev.weakness) tags.push('weakness x2');
      if (ev.resistance) tags.push('resisted -20');
      if (ev.absorbed) tags.push(`${ev.absorbed} absorbed`);
      const src = ev.source === 'rot' ? ' to rot' : ev.source === 'benchDamage' ? ' from the splash' : ev.source === 'selfDamage' ? ' to its own price' : '';
      return {
        text: `${nameOf(ev.cardId)} takes ${ev.amount}${src} — ${ev.hpAfter}/${ev.maxHp}${tags.length ? ` (${tags.join(', ')})` : ''}.`,
        cls: mine ? 'l-hurt' : 'l-hit',
      };
    }
    case 'heal':
      return { text: `${nameOf(ev.cardId)} knits back ${ev.amount} — ${ev.hpAfter}/${ev.maxHp}.`, cls: 'l-heal' };
    case 'shield':
      if (ev.spent) return { text: `${nameOf(ev.cardId)}'s shield breaks, eating ${ev.absorbed}.`, cls: 'l-shield' };
      if (ev.expired) return null; // housekeeping, not story
      return { text: `${nameOf(ev.cardId)} raises a shield of ${ev.gained}.`, cls: 'l-shield' };
    case 'status':
      if (ev.on) {
        return {
          text: ev.status === 'rot' ? `${nameOf(ev.cardId)} starts to rot.` : `${nameOf(ev.cardId)} is stunned.`,
          cls: 'l-status',
        };
      }
      if (ev.reason === 'retreat') return { text: `${nameOf(ev.cardId)} shakes it off on the way out.`, cls: 'l-quiet' };
      return null; // stun clearing at end of turn is bookkeeping
    case 'energyLoss':
      return {
        text:
          ev.reason === 'drainEnergy'
            ? `${ev.count} energy is torn off ${nameOf(ev.cardId)}.`
            : ev.reason === 'discardOwnEnergy'
              ? `${nameOf(ev.cardId)} burns ${ev.count} of its own energy.`
              : `${nameOf(ev.cardId)} sheds ${ev.count} energy.`,
        cls: 'l-energy',
      };
    case 'ko':
      return {
        text: `${nameOf(ev.cardId)} is destroyed. ${side(ev.scorer)} score — ${ev.score}/${WIN_SCORE}.`,
        cls: `l-ko ${ev.scorer === HUMAN ? 'l-you' : 'l-foe'}`,
      };
    case 'gameOver':
      return { text: gameOverLine(ev), cls: `l-over ${ev.player === HUMAN ? 'l-you' : 'l-foe'}` };
    default:
      return null;
  }
}

function reasonPhrase(ev) {
  if (ev.reason === 'score') return `${WIN_SCORE} knockouts`;
  if (ev.reason === 'deckOut') return 'an empty deck';
  return 'nothing left to send in';
}

function gameOverLine(ev) {
  return ev.player === HUMAN
    ? `You win — ${reasonPhrase(ev)}. ${ev.scores[HUMAN]}-${ev.scores[AI]}.`
    : `You lose — ${reasonPhrase(ev)}. ${ev.scores[HUMAN]}-${ev.scores[AI]}.`;
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

const S = {
  state: null,
  decks: { human: null, ai: null },
  seed: null,
  sel: null, // { kind:'hand', cardId } | { kind:'energy', energyType } | { kind:'retreat' }
  log: [],
  logOpen: false,
  aiBusy: false,
  scripted: false, // set by the smoke-test autoplayer: suppresses the AI loop and delays
  overlay: null, // 'menu' | 'zoom' | 'promote' | 'over'
  zoom: null, // { cardId, uid }
  lastEvents: [],
};

const DOM = {};

// ---------------------------------------------------------------------------
// affordances — everything the human may do, straight from legalActions
// ---------------------------------------------------------------------------

function humanTurn() {
  return !!S.state && S.state.acting === HUMAN && S.state.phase !== 'over';
}

function myActions() {
  if (!S.state || S.state.phase === 'over' || S.state.acting !== HUMAN) return [];
  return legalActions(S.state);
}

function has(actions, pred) {
  return actions.some(pred);
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function render() {
  if (!S.state) return;
  const st = S.state;
  const acts = myActions();
  renderHud(DOM.foeHud, AI, st);
  renderHud(DOM.youHud, HUMAN, st);
  renderBench(DOM.foeBench, AI, st, acts);
  renderActive(DOM.foeActive, AI, st, acts);
  renderBench(DOM.youBench, HUMAN, st, acts);
  renderActive(DOM.youActive, HUMAN, st, acts);
  renderStrip(st, acts);
  renderActions(st, acts);
  renderHand(st, acts);
  renderLog();
  renderOverlay();
  document.body.classList.toggle('is-your-turn', humanTurn() && st.phase === 'main');
}

function scorePips(player) {
  let out = '';
  for (let i = 0; i < WIN_SCORE; i++) out += `<span class="sp${i < player.score ? ' on' : ''}"></span>`;
  return out;
}

function renderHud(node, pi, st) {
  const p = st.players[pi];
  const deck = deckById(p.deckList);
  node.innerHTML = `
    <span class="hud-who">${pi === HUMAN ? 'You' : 'Opponent'} <em>${esc(deck.name)}</em></span>
    <span class="hud-score" title="Knockouts scored (first to ${WIN_SCORE} wins)">${scorePips(p)}</span>
    <span class="hud-counts">
      <b title="cards left in deck">${p.deck.length}</b><span>deck</span>
      <b title="cards in hand">${p.hand.length}</b><span>hand</span>
      <b title="cards destroyed">${p.discard.length}</b><span>out</span>
    </span>`;
}

function renderBench(node, pi, st, acts) {
  const p = st.players[pi];
  const mine = pi === HUMAN;
  const sideAttr = mine ? 'you' : 'foe';
  const benchable = mine && S.sel && S.sel.kind === 'hand' && has(acts, (a) => a.type === 'bench' && a.cardId === S.sel.cardId);
  let out = '';
  for (let i = 0; i < BENCH_LIMIT; i++) {
    const c = p.bench[i];
    if (c) {
      const attachable =
        mine && S.sel && S.sel.kind === 'energy' && has(acts, (a) => a.type === 'attach' && a.energyType === S.sel.energyType && a.targetUid === c.uid);
      const retreatable = mine && S.sel && S.sel.kind === 'retreat' && has(acts, (a) => a.type === 'retreat' && a.toUid === c.uid);
      const target = attachable || retreatable;
      out += `<div class="slot slot--chip${target ? ' is-target' : ''}">${cardHtml(c.cardId, {
        size: 'chip',
        creature: c,
        cls: target ? 'is-target' : '',
        attrs: `data-act="creature" data-uid="${c.uid}" data-side="${sideAttr}" tabindex="0"`,
      })}</div>`;
    } else {
      out += `<div class="slot slot--chip is-empty${benchable ? ' is-target' : ''}"${
        benchable ? ' data-act="benchslot" tabindex="0" role="button"' : ''
      }><span class="slot-hint">${benchable ? 'play here' : 'bench'}</span></div>`;
    }
  }
  node.innerHTML = out;
}

function renderActive(node, pi, st, acts) {
  const p = st.players[pi];
  const mine = pi === HUMAN;
  const c = p.active;
  if (!c) {
    const setupMe = mine && st.phase === 'setup' && S.sel && S.sel.kind === 'hand';
    node.innerHTML = `<div class="slot slot--board is-empty${setupMe ? ' is-target' : ''}"${
      setupMe ? ' data-act="setupslot" tabindex="0" role="button"' : ''
    }><span class="slot-hint">${mine ? (st.phase === 'setup' ? 'tap a card to lead' : 'promote a creature') : 'no active'}</span></div>`;
    return;
  }
  const attachable =
    mine && S.sel && S.sel.kind === 'energy' && has(acts, (a) => a.type === 'attach' && a.energyType === S.sel.energyType && a.targetUid === c.uid);
  node.innerHTML = `<div class="slot slot--board${attachable ? ' is-target' : ''}">${cardHtml(c.cardId, {
    size: 'board',
    creature: c,
    cls: `${attachable ? 'is-target' : ''} ${mine ? 'is-mine' : ''}`,
    attrs: `data-act="creature" data-uid="${c.uid}" data-side="${mine ? 'you' : 'foe'}" tabindex="0"`,
  })}</div>`;
}

function hintFor(st, acts) {
  if (st.phase === 'over') return 'The duel is finished.';
  if (st.acting !== HUMAN) return 'They are deciding…';
  if (st.phase === 'setup') return 'Tap a card in hand to lead with it.';
  if (st.phase === 'promote') return 'Choose who steps up.';
  if (S.sel && S.sel.kind === 'hand') return 'Tap an open bench slot.';
  if (S.sel && S.sel.kind === 'energy') return `Tap one of your creatures to attach ${typeName(S.sel.energyType)}.`;
  if (S.sel && S.sel.kind === 'retreat') return 'Tap the creature to bring forward.';
  if (has(acts, (a) => a.type === 'attack')) return 'Attack when you are ready — it ends your turn.';
  const bits = [];
  if (has(acts, (a) => a.type === 'attach')) bits.push('attach energy');
  if (has(acts, (a) => a.type === 'bench')) bits.push('bench a creature');
  if (has(acts, (a) => a.type === 'retreat')) bits.push('retreat');
  if (bits.length === 0) return 'Nothing left this turn — end it.';
  return `You can ${bits.join(', ')} — then end your turn.`;
}

/**
 * One line, doing two jobs: your instruction when it is your move, the last thing that happened
 * when it is not. Tapping it opens the full log.
 */
function renderStrip(st, acts) {
  const last = S.log[S.log.length - 1];
  const mine = st.acting === HUMAN && st.phase !== 'over';
  const line = mine ? hintFor(st, acts) : last ? last.text : 'The dark is quiet.';
  DOM.strip.innerHTML = `
    <button class="strip-log" data-act="toggle-log" aria-expanded="${S.logOpen}" aria-label="Battle log">
      <span class="strip-turn">${st.phase === 'setup' ? 'set' : `t${st.turn}`}</span>
      <span class="strip-line">${esc(line)}</span>
      <span class="strip-chev">${S.logOpen ? '▾' : '▴'}${VS15}</span>
    </button>`;
}

function attackButton(st, acts, atk, i) {
  const me = st.players[HUMAN];
  const legal = has(acts, (a) => a.type === 'attack' && a.attackIndex === i);
  let why = '';
  if (!legal) {
    const paid = me.active && costMet(me.active.energy, atk.cost);
    if (st.phase === 'promote' && st.acting === HUMAN) why = 'promote first';
    else if (st.acting !== HUMAN || st.phase !== 'main') why = 'not your turn';
    else if (me.active && me.active.stun) why = 'stunned';
    else if (st.turn === 1 && st.turnPlayer === HUMAN) why = 'no attack on turn 1';
    else if (!paid) why = `needs ${deficitPips(costDeficit(me.active.energy, atk.cost))}`;
    else why = 'not now';
  }
  return `<button class="atkbtn${legal ? '' : ' is-off'}" ${legal ? `data-act="attack" data-i="${i}"` : 'disabled aria-disabled="true"'}>
    <span class="atk-top"><span class="atk-cost">${costPips(atk.cost)}</span><span class="atk-dm">${atk.damage}</span></span>
    <span class="atk-name">${esc(atk.name)}${effectMark(atk.effect)}</span>
    ${why ? `<span class="atk-why">${why}</span>` : ''}
  </button>`;
}

function renderActions(st, acts) {
  const me = st.players[HUMAN];
  const card = me.active ? cardById(me.active.cardId) : null;
  const atkRow = card
    ? card.attacks.map((atk, i) => attackButton(st, acts, atk, i)).join('')
    : `<div class="atk-none">No active creature.</div>`;

  const chips = me.profile
    .map((t) => {
      const legal = has(acts, (a) => a.type === 'attach' && a.energyType === t);
      const on = S.sel && S.sel.kind === 'energy' && S.sel.energyType === t;
      return `<button class="chip t-${t}${on ? ' is-on' : ''}${legal ? '' : ' is-off'}" ${
        legal ? `data-act="energy" data-t="${t}"` : 'disabled aria-disabled="true"'
      } title="${st.attachedThisTurn ? 'Already attached this turn' : `Attach 1 ${typeName(t)}`}">
        ${typeGlyph(t)}<span class="chip-name">${esc(typeName(t))}</span></button>`;
    })
    .join('');

  const canRetreat = has(acts, (a) => a.type === 'retreat');
  const retreatCost = me.active ? cardById(me.active.cardId).retreatCost : 0;
  const retreatOn = S.sel && S.sel.kind === 'retreat';
  const canEnd = has(acts, (a) => a.type === 'endTurn');

  DOM.actions.innerHTML = `
    <div class="bar bar--atk">${atkRow}</div>
    <div class="bar bar--ctl">
      <span class="chips" role="group" aria-label="Attach energy">${chips}</span>
      <button class="btn btn--rt${retreatOn ? ' is-on' : ''}${canRetreat ? '' : ' is-off'}" ${
        canRetreat ? 'data-act="retreat"' : 'disabled aria-disabled="true"'
      } title="Swap the active creature, paying ${retreatCost} attached energy">⇄${VS15} <b>${retreatCost}</b></button>
      <button class="btn btn--end${canEnd ? '' : ' is-off'}" ${canEnd ? 'data-act="end"' : 'disabled aria-disabled="true"'}>End turn</button>
    </div>`;
}

function renderHand(st, acts) {
  const me = st.players[HUMAN];
  const n = me.hand.length;
  const cardW = 100; // design px; --u scales it (see style.css)
  // 342, not 370: the rail keeps 14 design px of side padding so the fan's rotation has
  // somewhere to go (a rotated card's box is ~12px wider than its layout box, and the rail
  // clips). The step always shrinks to fit, so no card is ever pushed out of reach.
  const room = 342;
  const step = n > 1 ? Math.max(14, Math.min(cardW * 0.84, (room - cardW) / (n - 1))) : cardW;
  const mid = (n - 1) / 2;
  // Cap the fan's total spread: the outermost card never tilts past ~5deg, or a big hand's
  // rotated corners would push outside the rail's padding and get clipped.
  const spread = Math.min(2.4, 5 / Math.max(mid, 1));
  const arc = Math.min(1.6, 6 / Math.max(mid, 1));
  const html = me.hand
    .map((cardId, i) => {
      const playable = has(acts, (a) => (a.type === 'bench' || a.type === 'setupActive') && a.cardId === cardId);
      const on = S.sel && S.sel.kind === 'hand' && S.sel.cardId === cardId;
      const rot = n > 1 ? (i - mid) * spread : 0;
      const dy = n > 1 ? Math.abs(i - mid) * arc : 0;
      return cardHtml(cardId, {
        size: 'hand',
        cls: `hand-card${playable ? ' is-playable' : ''}${on ? ' is-on' : ''}`,
        attrs:
          `data-act="hand" data-i="${i}" tabindex="0" ` +
          `style="--rot:${rot.toFixed(2)}deg; --dy:${dy.toFixed(2)}; ` +
          `margin-right:calc(${(i === n - 1 ? 0 : step - cardW).toFixed(1)} * var(--u)); z-index:${on ? 40 : i + 1}"`,
      });
    })
    .join('');
  DOM.hand.innerHTML = html || '<div class="hand-empty">Your hand is empty.</div>';
  DOM.hand.style.setProperty('--hand-n', String(n));
}

function renderLog() {
  DOM.logBody.innerHTML = S.log
    .map((l) => `<div class="log-line ${l.cls || ''}">${esc(l.text)}${l.sub ? `<i>${esc(l.sub)}</i>` : ''}</div>`)
    .join('');
  DOM.log.classList.toggle('is-open', S.logOpen);
  DOM.log.setAttribute('aria-hidden', String(!S.logOpen));
  if (S.logOpen) DOM.logBody.scrollTop = DOM.logBody.scrollHeight;
}

// ---------------------------------------------------------------------------
// overlays: menu / zoom / promote / game over
// ---------------------------------------------------------------------------

function renderOverlay() {
  const o = DOM.overlay;
  if (!S.overlay) {
    o.hidden = true;
    o.innerHTML = '';
    document.body.classList.remove('has-overlay');
    return;
  }
  o.hidden = false;
  document.body.classList.add('has-overlay');
  o.className = `overlay ov--${S.overlay}`;
  if (S.overlay === 'menu') o.innerHTML = menuHtml();
  else if (S.overlay === 'zoom') o.innerHTML = zoomHtml();
  else if (S.overlay === 'promote') o.innerHTML = promoteHtml();
  else if (S.overlay === 'over') o.innerHTML = overHtml();
}

function menuHtml() {
  const decks = DECKS.map(
    (d) => `<button class="deckcard" data-act="pickdeck" data-deck="${d.id}">
      <span class="deck-head"><span class="deck-name">${esc(d.name)}</span><span class="deck-profile">${d.profile.map(typeGlyph).join('')}</span></span>
      <span class="deck-blurb">${esc(d.blurb)}</span>
      <span class="deck-types">${d.profile.map((t) => esc(typeName(t))).join(' + ')}</span>
    </button>`,
  ).join('');
  return `<div class="sheet sheet--menu">
    <h1 class="brand">HELIOCIDE<span class="brand-sub">a duel in the dark after the sun</span></h1>
    <p class="menu-lede">Pick a deck. Four knockouts wins — or outlast their deck.</p>
    <div class="deckgrid">${decks}</div>
    <div class="menu-row">
      <button class="btn btn--wide" data-act="pickdeck" data-deck="random">Surprise me</button>
      <a class="btn btn--ghost" href="gallery.html">Card gallery</a>
    </div>
    ${artSwitchHtml()}
    ${aiSwitchHtml()}
    <details class="rules">
      <summary>How it works</summary>
      <ul>
        <li>One active creature, up to ${BENCH_LIMIT} on the bench. Draw one a turn; an empty deck loses.</li>
        <li>Attach one energy a turn from your deck's two types. Attack costs are thresholds, not payments.</li>
        <li>Weakness doubles damage, resistance takes 20 off. Attacking ends your turn.</li>
        <li>Long-press any card to read it full size.</li>
      </ul>
      ${typeLegendHtml()}
      <p class="rules-canon">A toy set on Iomesel — the world of <em>Thoughts of an Eaten Sun</em> and a sequel still being written. It winks at the books; it carries zero canon weight.</p>
    </details>
  </div>`;
}

/** Opponent-skill switch — borrows the artswitch chrome so it costs zero CSS. */
function aiSwitchHtml() {
  const cur = aiMode();
  const seg = Object.entries(AI_MODES)
    .map(
      ([mode, m]) =>
        `<button class="artbtn${cur === mode ? ' is-on' : ''}" data-act="aimode" data-mode="${mode}" ` +
        `aria-pressed="${cur === mode}">${m.label}</button>`,
    )
    .join('');
  return `<div class="artswitch" role="group" aria-label="Opponent skill">
    <span class="artswitch-label">Opponent</span>
    <span class="artseg">${seg}</span>
  </div>`;
}

function zoomHtml() {
  const { cardId, uid } = S.zoom;
  let creature = null;
  if (uid && S.state) {
    for (const p of S.state.players) {
      if (p.active && p.active.uid === uid) creature = p.active;
      const b = p.bench.find((c) => c.uid === uid);
      if (b) creature = b;
    }
  }
  return `<div class="sheet sheet--zoom" data-act="closezoom">
    ${cardHtml(cardId, { size: 'zoom', creature })}
    <button class="btn btn--wide" data-act="closezoom">Close</button>
  </div>`;
}

function promoteHtml() {
  const me = S.state.players[HUMAN];
  return `<div class="sheet sheet--promote">
    <h2>Your active is gone</h2>
    <p>Choose who steps into the gap.</p>
    <div class="pickrow">${me.bench
      .map((c) => cardHtml(c.cardId, { size: 'hand', creature: c, cls: 'is-playable', attrs: `data-act="promote" data-uid="${c.uid}" tabindex="0"` }))
      .join('')}</div>
  </div>`;
}

function overHtml() {
  const w = winner(S.state);
  const won = w && w.player === HUMAN;
  const scores = S.state.players.map((p) => p.score);
  return `<div class="sheet sheet--over ${won ? 'is-win' : 'is-loss'}">
    <h1 class="over-title">${won ? 'You hold the field' : 'You are unmade'}</h1>
    <p class="over-why">${esc(gameOverLine({ player: w.player, reason: w.reason, scores }))}</p>
    <p class="over-meta">${esc(deckById(S.decks.human).name)} vs ${esc(deckById(S.decks.ai).name)} · ${S.state.turn} turns · seed ${S.seed}</p>
    <button class="btn btn--wide btn--go" data-act="rematch">Rematch</button>
    <button class="btn btn--wide btn--ghost" data-act="menu">Different deck</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// game flow
// ---------------------------------------------------------------------------

function realSeed() {
  return (Date.now() ^ ((Math.random() * 0xffffffff) | 0)) | 0;
}

function pushLog(entry) {
  if (!entry) return;
  S.log.push(entry);
  if (S.log.length > 400) S.log.splice(0, S.log.length - 400);
}

function startGame({ humanDeck, aiDeck, seed } = {}) {
  const hd = humanDeck && humanDeck !== 'random' ? humanDeck : DECKS[(Math.random() * DECKS.length) | 0].id;
  const ad = aiDeck && aiDeck !== 'random' ? aiDeck : DECKS[(Math.random() * DECKS.length) | 0].id;
  S.decks = { human: hd, ai: ad };
  S.seed = seed === undefined || seed === null ? realSeed() : seed;
  S.state = createGame({
    deckA: hd,
    deckB: ad,
    seed: S.seed,
    names: [deckById(hd).name, deckById(ad).name],
  });
  S.sel = null;
  S.log = [{ text: `${deckById(hd).name} against ${deckById(ad).name}.`, cls: 'l-turn' }];
  S.overlay = null;
  S.zoom = null;
  S.aiBusy = false;
  S.lastEvents = [];
  render();
  pump();
}

/** Apply one action: engine step, narration, re-render, animation. Never throws outward. */
function step(action) {
  if (!S.state || S.state.phase === 'over') return false;
  let out;
  try {
    out = applyAction(S.state, action);
  } catch (err) {
    // Should be unreachable: every offered action comes from legalActions. Surface it in the
    // log rather than the console so a bad affordance is visible without breaking the page.
    pushLog({ text: `That move was refused: ${err.message}`, cls: 'l-warn' });
    S.sel = null;
    render();
    return false;
  }
  S.state = out.state;
  S.lastEvents = out.events;
  for (const ev of out.events) pushLog(narrate(ev, S.state));
  S.sel = null;
  render();
  animate(out.events);
  return true;
}

function animate(events) {
  if (!MOTION_OK) return;
  for (const ev of events) {
    if (ev.kind === 'attack') {
      const el = $(`#app .card[data-uid="${ev.uid}"]`);
      flash(el, ev.player === HUMAN ? 'is-lunge-up' : 'is-lunge-down', 300);
    } else if (ev.kind === 'damage' && ev.amount > 0) {
      flash($(`#app .card[data-uid="${ev.uid}"]`), 'is-hit', 320);
    } else if (ev.kind === 'heal' && ev.amount > 0) {
      flash($(`#app .card[data-uid="${ev.uid}"]`), 'is-healed', 320);
    } else if (ev.kind === 'ko') {
      const side = ev.player === HUMAN ? '#youActive, #youBench' : '#foeActive, #foeBench';
      for (const slot of document.querySelectorAll(side)) flash(slot, 'is-ko', 380);
    } else if (ev.kind === 'bench' || ev.kind === 'promote') {
      flash($(`#app .card[data-uid="${ev.uid}"]`), 'is-enter', 320);
    }
  }
}

/** Whose move is it? Dispatches on `state.acting` — promote interrupts land here. */
function pump() {
  if (!S.state) return;
  if (winner(S.state)) {
    S.overlay = 'over';
    renderOverlay();
    return;
  }
  if (S.state.acting === HUMAN) {
    if (S.state.phase === 'promote') {
      S.overlay = 'promote';
      renderOverlay();
    } else if (S.overlay === 'promote') {
      S.overlay = null;
      renderOverlay();
    }
    return;
  }
  if (S.overlay === 'promote') {
    S.overlay = null;
    renderOverlay();
  }
  if (!S.scripted) void aiLoop();
}

// ---------------------------------------------------------------------------
// the AI opponent
// ---------------------------------------------------------------------------

let aiPromise = null;

/** ai.js is written in parallel with this file; treat it as optional at all times. */
function loadAi() {
  if (!aiPromise) aiPromise = import('./ai.js').then((m) => m, () => null);
  return aiPromise;
}

function sameAction(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  for (const k of ['cardId', 'energyType', 'targetUid', 'toUid', 'uid', 'attackIndex']) {
    if (a[k] !== undefined || b[k] !== undefined) {
      if (a[k] !== b[k]) return false;
    }
  }
  return true;
}

/** Fallback brain: the first legal action (bench, then attach, then retreat, attack, endTurn). */
function stubChoose(options) {
  return options[0];
}

async function aiChoose(state) {
  const options = legalActions(state);
  if (options.length === 0) return null;
  const mode = AI_MODES[aiMode()] || AI_MODES[AI_MODE_DEFAULT];
  const seed =
    (state.rng ^ (state.turn * 7919) ^ (state.acting * 31) ^ (++aiDecisionCount * 2654435761)) | 0;
  if (mode.random) {
    const r = createRng(seed);
    return options[Math.floor(r() * options.length)];
  }
  const mod = await loadAi();
  if (mod && typeof mod.chooseAction === 'function') {
    try {
      const picked = mod.chooseAction(state, { noise: mode.noise, seed, rng: createRng(seed) });
      if (options.some((o) => sameAction(o, picked))) return picked;
    } catch {
      /* fall through to the stub — a half-written ai.js must not break the game */
    }
  }
  return stubChoose(options);
}

async function aiLoop() {
  if (S.aiBusy) return;
  S.aiBusy = true;
  try {
    let guard = 0;
    while (S.state && !winner(S.state) && S.state.acting === AI) {
      if (++guard > AI_ACTION_CAP) {
        pushLog({ text: 'They stall out. The turn passes.', cls: 'l-warn' });
        const outs = legalActions(S.state);
        const end = outs.find((a) => a.type === 'endTurn');
        if (end) step(end);
        break;
      }
      const action = await aiChoose(S.state);
      if (!action) break;
      if (!S.scripted) await delay(AI_DELAY);
      if (!S.state || winner(S.state) || S.state.acting !== AI) break;
      if (!step(action)) break;
    }
  } finally {
    S.aiBusy = false;
  }
  pump();
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

let pressTimer = null;
let pressStart = null;
let suppressClick = false;

function openZoom(cardId, uid) {
  if (!cardId) return;
  S.zoom = { cardId, uid: uid || null };
  S.overlay = 'zoom';
  renderOverlay();
}

function closeZoom() {
  if (S.overlay !== 'zoom') return;
  S.overlay = null;
  S.zoom = null;
  renderOverlay();
  pump();
}

function onPointerDown(ev) {
  const card = ev.target.closest && ev.target.closest('.card[data-cid]');
  if (!card || S.overlay === 'zoom') return;
  pressStart = { x: ev.clientX, y: ev.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    suppressClick = true;
    openZoom(card.getAttribute('data-cid'), card.getAttribute('data-uid'));
  }, 380);
}

function cancelPress(ev) {
  if (pressTimer && ev && ev.type === 'pointermove' && pressStart) {
    const dx = Math.abs(ev.clientX - pressStart.x);
    const dy = Math.abs(ev.clientY - pressStart.y);
    if (dx < 12 && dy < 12) return;
  }
  clearTimeout(pressTimer);
  pressTimer = null;
}

function onClick(ev) {
  if (suppressClick) {
    suppressClick = false;
    ev.preventDefault();
    return;
  }
  cancelPress();
  const hit = ev.target.closest && ev.target.closest('[data-act]');
  const act = hit && hit.getAttribute('data-act');

  // Overlay-level actions first.
  if (act === 'artmode') {
    // Lives inside the menu sheet, so it has to be handled before the overlay swallows clicks.
    setArtMode(hit.getAttribute('data-mode'));
    return;
  }
  if (act === 'aimode') {
    setAiMode(hit.getAttribute('data-mode'));
    renderOverlay(); // repaint the menu so the pressed state moves
    return;
  }
  if (act === 'pickdeck') {
    startGame({ humanDeck: hit.getAttribute('data-deck'), aiDeck: 'random' });
    return;
  }
  if (act === 'closezoom') {
    closeZoom();
    return;
  }
  if (act === 'rematch') {
    startGame({ humanDeck: S.decks.human, aiDeck: S.decks.ai });
    return;
  }
  if (act === 'menu') {
    S.overlay = 'menu';
    renderOverlay();
    return;
  }
  if (act === 'promote') {
    step({ type: 'promote', uid: hit.getAttribute('data-uid') });
    pump();
    return;
  }
  if (S.overlay === 'zoom') {
    closeZoom();
    return;
  }
  if (S.overlay) return; // menu / promote / over swallow everything else
  if (act === 'toggle-log') {
    S.logOpen = !S.logOpen;
    renderLog();
    renderStrip(S.state, myActions());
    return;
  }
  if (act === 'closelog') {
    S.logOpen = false;
    renderLog();
    renderStrip(S.state, myActions());
    return;
  }
  if (!S.state) return;

  const acts = myActions();
  switch (act) {
    case 'hand': {
      const i = Number(hit.getAttribute('data-i'));
      const cardId = S.state.players[HUMAN].hand[i];
      if (cardId === undefined) return;
      if (has(acts, (a) => a.type === 'setupActive' && a.cardId === cardId)) {
        step({ type: 'setupActive', cardId });
        pump();
        return;
      }
      if (has(acts, (a) => a.type === 'bench' && a.cardId === cardId)) {
        S.sel = S.sel && S.sel.kind === 'hand' && S.sel.cardId === cardId ? null : { kind: 'hand', cardId };
        render();
        return;
      }
      openZoom(cardId, null);
      return;
    }
    case 'benchslot': {
      if (S.sel && S.sel.kind === 'hand') {
        step({ type: 'bench', cardId: S.sel.cardId });
        pump();
      }
      return;
    }
    case 'setupslot': {
      if (S.sel && S.sel.kind === 'hand') {
        step({ type: 'setupActive', cardId: S.sel.cardId });
        pump();
      }
      return;
    }
    case 'creature': {
      const uid = hit.getAttribute('data-uid');
      const mine = hit.getAttribute('data-side') === 'you';
      if (mine && S.sel && S.sel.kind === 'energy') {
        if (has(acts, (a) => a.type === 'attach' && a.energyType === S.sel.energyType && a.targetUid === uid)) {
          step({ type: 'attach', energyType: S.sel.energyType, targetUid: uid });
          pump();
          return;
        }
      }
      if (mine && S.sel && S.sel.kind === 'retreat') {
        if (has(acts, (a) => a.type === 'retreat' && a.toUid === uid)) {
          step({ type: 'retreat', toUid: uid });
          pump();
          return;
        }
      }
      openZoom(hit.getAttribute('data-cid'), uid);
      return;
    }
    case 'energy': {
      const t = hit.getAttribute('data-t');
      S.sel = S.sel && S.sel.kind === 'energy' && S.sel.energyType === t ? null : { kind: 'energy', energyType: t };
      render();
      return;
    }
    case 'retreat': {
      S.sel = S.sel && S.sel.kind === 'retreat' ? null : { kind: 'retreat' };
      render();
      return;
    }
    case 'attack': {
      step({ type: 'attack', attackIndex: Number(hit.getAttribute('data-i')) });
      pump();
      return;
    }
    case 'end': {
      step({ type: 'endTurn' });
      pump();
      return;
    }
    default: {
      // A tap on a card with no pending affordance reads it instead.
      const card = ev.target.closest && ev.target.closest('.card[data-cid]');
      if (card) openZoom(card.getAttribute('data-cid'), card.getAttribute('data-uid'));
    }
  }
}

function onKeyDown(ev) {
  if (ev.key === 'Escape') {
    if (S.overlay === 'zoom') closeZoom();
    else if (S.logOpen) {
      S.logOpen = false;
      renderLog();
      renderStrip(S.state, myActions());
    }
    return;
  }
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const t = document.activeElement;
  if (!t || !t.getAttribute) return;
  if (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY') return; // native
  if (t.hasAttribute('data-act')) {
    ev.preventDefault();
    t.click();
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

export function boot() {
  DOM.app = $('#app');
  DOM.foeHud = $('#foeHud');
  DOM.foeBench = $('#foeBench');
  DOM.foeActive = $('#foeActive');
  DOM.strip = $('#strip');
  DOM.youActive = $('#youActive');
  DOM.youBench = $('#youBench');
  DOM.actions = $('#actions');
  DOM.hand = $('#hand');
  DOM.youHud = $('#youHud');
  DOM.log = $('#log');
  DOM.logBody = $('#logBody');
  DOM.overlay = $('#overlay');

  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('pointerup', cancelPress, { passive: true });
  document.addEventListener('pointercancel', cancelPress, { passive: true });
  document.addEventListener('pointermove', cancelPress, { passive: true });
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);

  // Flipping the art switch re-renders the live board *and* whatever overlay is up (the menu
  // holds the switch itself, and the zoom overlay is where the art is largest).
  artMode();
  onArtMode(() => {
    if (!DOM.app) return;
    if (S.state) render();
    else renderOverlay();
  });

  // A game exists behind the menu from the first frame, so the board is never blank.
  startGame({ humanDeck: 'random', aiDeck: 'random' });
  S.overlay = 'menu';
  renderOverlay();

  // Test/automation surface (used by test/ui-smoke.mjs). Read-only except for the drivers.
  const api = {
    version: 'm4.5',
    get state() {
      return S.state;
    },
    /** Art mode: read with no argument, write with 'ascii' | 'sigil'. Persists to localStorage. */
    artMode: (mode) => (mode === undefined ? artMode() : setArtMode(mode)),
    get log() {
      return S.log.slice();
    },
    decks: () => ({ ...S.decks }),
    aiLoaded: () => loadAi().then((m) => !!(m && typeof m.chooseAction === 'function')),
    newGame: (opts) => startGame(opts),
    openMenu: () => {
      S.overlay = 'menu';
      renderOverlay();
    },
    zoom: (cardId, uid) => openZoom(cardId, uid),
    closeZoom,
    /** Park/unpark the AI loop (the smoke test drives both seats itself). */
    scripted: (on) => {
      S.scripted = !!on;
      return S.scripted;
    },
    /** Apply one action through the real UI path (render + narrate + dispatch). */
    play: (action) => {
      const applied = step(action);
      pump();
      return applied;
    },
    setLog: (open) => {
      S.logOpen = !!open;
      renderLog();
      renderStrip(S.state, myActions());
    },
    /**
     * Deterministic auto-player for the headless smoke test: drives BOTH seats through the
     * real UI step path (so every board state is actually rendered) with the AI loop parked.
     */
    autoplay: ({ seed = 1234, deckA = 'gravemarch', deckB = 'goldenmaw', bias = 0.85, maxSteps = 4000 } = {}) => {
      S.scripted = true;
      try {
        startGame({ humanDeck: deckA, aiDeck: deckB, seed });
        const rng = createRng(`ui-smoke:${seed}`);
        let steps = 0;
        while (!winner(S.state) && steps < maxSteps) {
          const options = legalActions(S.state);
          if (options.length === 0) break;
          const attacks = options.filter((a) => a.type === 'attack');
          const action = attacks.length > 0 && rng() < bias ? attacks[rng.int(attacks.length)] : options[rng.int(options.length)];
          if (!step(action)) break;
          steps++;
        }
        pump();
        const w = winner(S.state);
        return {
          winner: w,
          turns: S.state.turn,
          phase: S.state.phase,
          steps,
          scores: S.state.players.map((p) => p.score),
          logLines: S.log.length,
          overlay: S.overlay,
        };
      } finally {
        S.scripted = false;
      }
    },
  };
  if (typeof window !== 'undefined') window.HELIOCIDE = api;
  return api;
}
