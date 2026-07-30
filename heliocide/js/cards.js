// HELIOCIDE — card data. DATA ONLY (plus id lookups). Imports nothing.
//
// The M2 roster: 20 creatures, 4 per type, tiers 1-3, and the 4 preset decks. Names, types,
// tiers and mechanical identities come from THEME.md and are fixed; the numbers here are the
// tunable layer (PLAN.md "Balance targets").
//
// Design conventions the numbers follow:
//   * HP by tier — T1 60-80, T2 90-120, T3 130-160.
//   * ~25-35 damage per point of attached energy; an attack that carries an effect trades
//     about 10 damage for it. Opening (cost-1) attacks on cards whose budget is spent on HP
//     or on an effect deliberately sit under that band — they are early access, not rate.
//   * Heavier types (bone/gold) hit harder for more energy and retreat worse; ember is cheap
//     and fast and pays in its own hp; rot trades tempo for attrition; song (breath) buys
//     shields and heals instead of damage.
//   * Weakness wheel (each type is answered by exactly one other): song → gold → bone →
//     ember → rot → song. Resistance is rare — 6 of 20 cards — and always flavour-led.

/** Energy/creature types. Display-only fields live here so theming never touches logic. */
// ⚠ ORDER IS LOAD-BEARING: the engine auto-discards energy in this order (PLAN.md addenda).
//
// Colours are the M4.5 palette (THEME.md "Palette", binding): one hex per type, taken from the
// Thoughts of an Eaten Sun cover's sunburst rays and the book site's stylesheet, picked as the
// most legible single stop of each type's ramp against the #0c0e3d navy ground. The full
// multi-stop ramps live in style.css as `--grad-*` and paint the ASCII art; these single hexes
// are what pips, glyphs and swatches use.
export const TYPES = [
  { id: 'bone', name: 'Marrow', color: '#d3c49d', glyph: '†' },
  { id: 'ember', name: 'Ember', color: '#f18142', glyph: '✸' },
  { id: 'rot', name: 'Rot', color: '#63a65d', glyph: '❋' },
  { id: 'gold', name: 'Gold', color: '#f9d253', glyph: '◈' },
  { id: 'breath', name: 'Song', color: '#76869f', glyph: '≋' },
];

/**
 * Card schema: { id, name, type, tier, hp, weakness, resistance, retreatCost,
 *                attacks: [{ name, cost, damage, effect?, text }], flavor, sigil }
 * Attack cost mixes typed and generic: { bone: 2, any: 1 } = 2 bone + 1 of anything.
 * Weakness/resistance name an attacker *type*; null means none.
 * Effect kinds are exactly the engine's eight: rot, stun, selfHeal, benchDamage, selfDamage,
 * discardOwnEnergy, drainEnergy, shield.
 */
export const CARDS = [
  // ---------------------------------------------------------------- Marrow (bone)
  {
    id: 'shattershard',
    name: 'Shattershard',
    type: 'bone',
    tier: 1,
    hp: 60,
    weakness: 'gold',
    resistance: 'ember',
    retreatCost: 1,
    attacks: [
      {
        name: 'Glass Bloom',
        cost: { bone: 1 },
        damage: 20,
        effect: { kind: 'shield', amount: 20 },
        text: 'It opens a facet and the light goes hard.',
      },
      {
        name: 'Petalfall',
        cost: { bone: 1, any: 1 },
        damage: 50,
        text: 'Every petal it drops is an edge on the way down.',
      },
    ],
    flavor: 'It flowers where something broke. The petals remember being a window.',
    sigil: 'shard',
  },
  {
    id: 'oceandwarf',
    name: 'Ocean Dwarf',
    type: 'bone',
    tier: 1,
    hp: 80,
    weakness: 'gold',
    resistance: null,
    retreatCost: 1,
    attacks: [
      {
        name: 'Break Against Stone',
        cost: { bone: 1 },
        damage: 20,
        text: 'It simply stands there and lets you be the wave.',
      },
      {
        name: 'Hammer of the Open Rock',
        cost: { bone: 1, any: 1 },
        damage: 50,
        text: 'The door swings once, and something is on the wrong side of it.',
      },
    ],
    flavor: 'They live inside a great rock on the coast, and they open to no one.',
    sigil: 'door',
  },
  {
    id: 'frozenhound',
    name: 'Frozen Hound',
    type: 'bone',
    tier: 2,
    hp: 100,
    weakness: 'gold',
    resistance: 'ember',
    retreatCost: 1,
    attacks: [
      {
        name: 'Long Cold Bite',
        cost: { bone: 1, any: 1 },
        damage: 50,
        text: 'It takes its time. The cold does most of the work.',
      },
      {
        name: 'Run the Warm Down',
        cost: { bone: 2, any: 1 },
        damage: 80,
        text: 'It has never once needed to sprint.',
      },
    ],
    flavor: 'Gaunt, patient, and allergic to anything still warm.',
    sigil: 'hound',
  },
  {
    id: 'ossuarywarden',
    name: 'Ossuary Warden',
    type: 'bone',
    tier: 3,
    hp: 160,
    weakness: 'gold',
    resistance: 'breath',
    retreatCost: 3,
    attacks: [
      {
        name: 'Wall of Names',
        cost: { bone: 2 },
        damage: 40,
        effect: { kind: 'shield', amount: 30 },
        text: 'It stacks another course of the dead in front of itself.',
      },
      {
        name: 'Ossuary Slam',
        cost: { bone: 3, any: 1 },
        damage: 100,
        effect: { kind: 'stun' },
        text: 'A tonne of tidy bone, arriving all at once.',
      },
    ],
    flavor: 'Stacked from the quiet dead, standing watch over the quiet dead.',
    sigil: 'ossuary',
  },

  // ---------------------------------------------------------------- Ember
  {
    id: 'cinderwisp',
    name: 'Cinderwisp',
    type: 'ember',
    tier: 1,
    hp: 60,
    weakness: 'bone',
    resistance: null,
    retreatCost: 0,
    attacks: [
      {
        name: 'Read By Its Light',
        cost: { ember: 1 },
        damage: 30,
        text: 'Close enough to see by. Close enough to blister.',
      },
      {
        name: 'Guttering Flare',
        cost: { ember: 2 },
        damage: 60,
        effect: { kind: 'selfDamage', amount: 10 },
        text: 'It spends itself to be briefly unbearable.',
      },
    ],
    flavor: 'A mote of agony bright enough to read by.',
    sigil: 'wisp',
  },
  {
    id: 'saddlesow',
    name: 'Saddlesow',
    type: 'ember',
    tier: 1,
    hp: 80,
    weakness: 'bone',
    resistance: null,
    retreatCost: 1,
    attacks: [
      {
        name: 'Contented Grazing',
        cost: { ember: 1 },
        damage: 10,
        effect: { kind: 'selfHeal', amount: 30 },
        text: 'It eats, it warms, it forgets it was ever hurt.',
      },
      {
        name: 'Warm Bulk',
        cost: { ember: 1, any: 1 },
        damage: 50,
        text: 'All that placid weight, suddenly in motion.',
      },
    ],
    flavor: 'Round, warm, and named after a flower it has never seen.',
    sigil: 'sow',
  },
  {
    id: 'geodeflyer',
    name: 'Geode-Pocket Flyer',
    type: 'ember',
    tier: 2,
    hp: 90,
    weakness: 'bone',
    resistance: null,
    retreatCost: 1,
    attacks: [
      {
        name: 'Steal the Warmth',
        cost: { ember: 1, any: 1 },
        damage: 40,
        effect: { kind: 'drainEnergy', count: 1 },
        text: 'It has spent its whole life learning where heat hides.',
      },
      {
        name: 'Sealed Sky',
        cost: { ember: 2 },
        damage: 60,
        text: 'It flies at the ceiling of the world as if it might give.',
      },
    ],
    flavor: 'Born in a sealed stone garden. It has never once seen the sky.',
    sigil: 'geode',
  },
  {
    id: 'elderdrake',
    name: 'Elder Drake',
    type: 'ember',
    tier: 3,
    hp: 130,
    weakness: 'bone',
    resistance: null,
    retreatCost: 2,
    attacks: [
      {
        name: 'Capacitor Breath',
        cost: { ember: 2 },
        damage: 50,
        effect: { kind: 'benchDamage', amount: 10, scope: 'all' },
        text: 'It exhales stored years. Everyone in the room ages.',
      },
      {
        name: 'Burn the First Potion',
        cost: { ember: 3, any: 1 },
        damage: 110,
        effect: { kind: 'selfDamage', amount: 20 },
        text: 'It opens its own blood and spends it like coin.',
      },
    ],
    flavor: 'The old dragons kept the heat. Their blood was the first medicine anyone stole.',
    sigil: 'drake',
  },

  // ---------------------------------------------------------------- Rot
  {
    id: 'bloodrush',
    name: 'Bloodrush',
    type: 'rot',
    tier: 1,
    hp: 70,
    weakness: 'ember',
    resistance: null,
    retreatCost: 0,
    attacks: [
      {
        name: 'Find the Wound',
        cost: { rot: 1 },
        damage: 20,
        effect: { kind: 'rot' },
        text: 'It only needs the smallest opening, and it has already found it.',
      },
      {
        name: 'Red Bloom',
        cost: { rot: 1, any: 1 },
        damage: 50,
        text: 'It flowers all at once, in a colour you know.',
      },
    ],
    flavor: 'A creeping red bloom that finds every wound, including the ones you hid.',
    sigil: 'bloom',
  },
  {
    id: 'sourthorn',
    name: 'Sourthorn',
    type: 'rot',
    tier: 1,
    hp: 70,
    weakness: 'ember',
    resistance: null,
    retreatCost: 1,
    attacks: [
      {
        name: 'Thorn Rake',
        cost: { rot: 1 },
        damage: 30,
        text: 'Four shallow lines, and a taste like standing water.',
      },
      {
        name: 'Hedge of Sour Thorn',
        cost: { rot: 1, any: 1 },
        damage: 50,
        effect: { kind: 'rot' },
        text: 'It grows around you while you are deciding what to do.',
      },
    ],
    flavor: 'It grows fastest where something died, and it grows very fast here.',
    sigil: 'thorn',
  },
  {
    id: 'bloodfallleech',
    name: 'Bloodfall Leech',
    type: 'rot',
    tier: 2,
    hp: 90,
    weakness: 'ember',
    resistance: 'bone',
    retreatCost: 1,
    attacks: [
      {
        name: 'Drink the Cliff',
        cost: { rot: 1, any: 1 },
        damage: 40,
        effect: { kind: 'drainEnergy', count: 1 },
        text: 'It takes the warm part first and leaves the rest standing.',
      },
      {
        name: 'Never Hungry',
        cost: { rot: 2, any: 1 },
        damage: 60,
        effect: { kind: 'selfHeal', amount: 30 },
        text: 'Whatever it opens, it closes on itself.',
      },
    ],
    flavor: 'It waits below the red cliffs. It has never once gone hungry.',
    sigil: 'leech',
  },
  {
    id: 'hellthing',
    name: 'Hell-Thing of the Deeps',
    type: 'rot',
    tier: 3,
    hp: 140,
    weakness: 'ember',
    resistance: 'gold',
    retreatCost: 2,
    attacks: [
      {
        name: 'Blink Into Air',
        cost: { rot: 2 },
        damage: 50,
        effect: { kind: 'benchDamage', amount: 20, scope: 'random' },
        text: 'It surfaces somewhere it was not, and something behind you screams.',
      },
      {
        name: 'The Layer With No Name',
        cost: { rot: 3, any: 1 },
        damage: 100,
        effect: { kind: 'rot' },
        text: 'For a moment you can smell where it was hauled up from.',
      },
    ],
    flavor: 'Hauled up blinking from a layer nobody says out loud.',
    sigil: 'maw',
  },

  // ---------------------------------------------------------------- Gold
  {
    id: 'goldenfork',
    name: 'Golden Fork',
    type: 'gold',
    tier: 1,
    hp: 60,
    weakness: 'breath',
    resistance: null,
    retreatCost: 1,
    attacks: [
      {
        name: 'Two Tines',
        cost: { gold: 1 },
        damage: 30,
        text: 'It leans, it chooses, it puts both points in.',
      },
      {
        name: 'Point at What It Wants',
        cost: { gold: 2 },
        damage: 60,
        effect: { kind: 'discardOwnEnergy', count: 1 },
        text: 'Wanting that much costs something. It pays without looking.',
      },
    ],
    flavor: 'Two tines, always pointed at whatever it wants next.',
    sigil: 'fork',
  },
  {
    id: 'farfingerpup',
    name: 'Far Finger Pup',
    type: 'gold',
    tier: 1,
    hp: 70,
    weakness: 'breath',
    resistance: null,
    retreatCost: 0,
    attacks: [
      {
        name: 'Chainpull',
        cost: { gold: 1 },
        damage: 20,
        text: 'It reaches the end of the chain and keeps trying.',
      },
      {
        name: "Whine at the World's Edge",
        cost: { gold: 1, any: 1 },
        damage: 40,
        effect: { kind: 'drainEnergy', count: 1 },
        text: 'You give it something. You did not decide to.',
      },
    ],
    flavor: 'Chained at the western edge of the world, and still glad to see you.',
    sigil: 'pup',
  },
  {
    id: 'goldtog',
    name: 'Goldtog',
    type: 'gold',
    tier: 2,
    hp: 110,
    weakness: 'breath',
    resistance: 'rot',
    retreatCost: 2,
    attacks: [
      {
        name: 'Squat and Swing',
        cost: { gold: 1, any: 1 },
        damage: 50,
        text: 'No footwork. No wasted motion. No discussion.',
      },
      {
        name: 'Impossible to Argue With',
        cost: { gold: 2, any: 1 },
        damage: 90,
        text: 'It makes its point the once, thoroughly.',
      },
    ],
    flavor: 'Squat, patient, and impossible to argue with.',
    sigil: 'tog',
  },
  {
    id: 'leviathan',
    name: 'Leviathan',
    type: 'gold',
    tier: 3,
    hp: 130,
    weakness: 'breath',
    resistance: null,
    retreatCost: 3,
    attacks: [
      {
        name: 'Summon > Kill',
        cost: { gold: 2 },
        damage: 60,
        text: 'Two steps, and it has never once confused their order.',
      },
      {
        name: 'Instinct Without a Name',
        cost: { gold: 3, any: 1 },
        damage: 120,
        effect: { kind: 'selfDamage', amount: 30 },
        text: 'It does not aim. It simply arrives everywhere it wanted to be.',
      },
    ],
    flavor: 'Summoned things act on instinct. Naming one hands it the rest.',
    sigil: 'coil',
  },

  // ---------------------------------------------------------------- Song (breath)
  {
    id: 'liamathensprite',
    name: 'Liamathen Sprite',
    type: 'breath',
    tier: 1,
    hp: 60,
    weakness: 'rot',
    resistance: null,
    retreatCost: 0,
    attacks: [
      {
        name: 'Bend the Light',
        cost: { breath: 1 },
        damage: 20,
        effect: { kind: 'shield', amount: 20 },
        text: 'The air in front of it goes quietly wrong.',
      },
      {
        name: 'Kind Crystal',
        cost: { breath: 1, any: 1 },
        damage: 50,
        text: 'A note struck once, and held far too long.',
      },
    ],
    flavor: 'Light bends toward the crystal, and the crystal is kind.',
    sigil: 'sprite',
  },
  {
    id: 'lamplightmote',
    name: 'Lamplight Mote',
    type: 'breath',
    tier: 1,
    hp: 70,
    weakness: 'rot',
    resistance: null,
    retreatCost: 0,
    attacks: [
      {
        name: 'Touched For Luck',
        cost: { breath: 1 },
        damage: 10,
        effect: { kind: 'selfHeal', amount: 30 },
        text: 'Somebody, somewhere, is still doing this every evening.',
      },
      {
        name: 'One Small Light',
        cost: { breath: 1, any: 1 },
        damage: 40,
        effect: { kind: 'selfHeal', amount: 10 },
        text: 'It gets brighter the longer you need it to.',
      },
    ],
    flavor: 'One small light, touched every day for luck.',
    sigil: 'lamp',
  },
  {
    id: 'thundermarcher',
    name: 'Thundermarcher',
    type: 'breath',
    tier: 2,
    hp: 100,
    weakness: 'rot',
    resistance: null,
    retreatCost: 1,
    attacks: [
      {
        name: 'Arrive With the Storm',
        cost: { breath: 1, any: 1 },
        damage: 40,
        effect: { kind: 'stun' },
        text: 'The thunder gets there first and does half the work.',
      },
      {
        name: 'Strike at the Worst Hour',
        cost: { breath: 2, any: 1 },
        damage: 80,
        text: 'It waits for the water to be at your knees.',
      },
    ],
    flavor: 'They march with the thunder and strike when the storm is worst.',
    sigil: 'storm',
  },
  {
    id: 'thawingdragon',
    name: 'The Thawing Dragon',
    type: 'breath',
    tier: 3,
    hp: 150,
    weakness: 'rot',
    resistance: 'gold',
    retreatCost: 2,
    attacks: [
      {
        name: 'Constellation of Ice',
        cost: { breath: 2 },
        damage: 40,
        effect: { kind: 'shield', amount: 30 },
        text: 'The pattern on its hide closes over like a shut hand.',
      },
      {
        name: 'Frozen Mathematics',
        cost: { breath: 3, any: 1 },
        damage: 110,
        text: 'It works the problem once and the answer is very cold.',
      },
    ],
    flavor: 'The stars of his constellation are the ice on his skin.',
    sigil: 'frost',
  },
];

/**
 * Preset decks: { id, name, profile:[t1,t2], cards:[15 ids], blurb }
 * 15 cards drawn only from the profile's two types, max 2 copies of any card — with 8 cards
 * to choose from that means seven pairs and one single, and the single is the deck's tell.
 */
export const DECKS = [
  {
    id: 'gravemarch',
    name: 'Gravemarch',
    profile: ['bone', 'rot'],
    cards: [
      'shattershard', 'shattershard',
      'oceandwarf', 'oceandwarf',
      'frozenhound', 'frozenhound',
      'ossuarywarden', 'ossuarywarden',
      'bloodrush', 'bloodrush',
      'sourthorn', 'sourthorn',
      'bloodfallleech', 'bloodfallleech',
      'hellthing',
    ],
    blurb: 'Outlast everything. Walls that will not fall, and a rot that never stops counting.',
  },
  {
    id: 'goldenmaw',
    name: 'The Golden Maw',
    profile: ['ember', 'gold'],
    cards: [
      'cinderwisp', 'cinderwisp',
      'saddlesow', 'saddlesow',
      'geodeflyer', 'geodeflyer',
      'elderdrake', 'elderdrake',
      'goldenfork', 'goldenfork',
      'farfingerpup', 'farfingerpup',
      'goldtog', 'goldtog',
      'leviathan',
    ],
    blurb: 'Burn fast, hit huge, pay in blood. Nothing here intends to be around for turn ten.',
  },
  {
    id: 'lastlight',
    name: 'The Last Light',
    profile: ['breath', 'ember'],
    cards: [
      'liamathensprite', 'liamathensprite',
      'lamplightmote', 'lamplightmote',
      'thundermarcher', 'thundermarcher',
      'thawingdragon', 'thawingdragon',
      'cinderwisp', 'cinderwisp',
      'saddlesow', 'saddlesow',
      'geodeflyer', 'geodeflyer',
      'elderdrake',
    ],
    blurb: 'Protect the flame. Shields, mending, and a dragon that does arithmetic in ice.',
  },
  {
    id: 'deephunger',
    name: 'Deep Hunger',
    profile: ['gold', 'rot'],
    cards: [
      'goldenfork', 'goldenfork',
      'farfingerpup', 'farfingerpup',
      'goldtog', 'goldtog',
      'bloodrush', 'bloodrush',
      'sourthorn', 'sourthorn',
      'bloodfallleech', 'bloodfallleech',
      'hellthing', 'hellthing',
      'leviathan',
    ],
    blurb: 'Drain and devour. It takes what is keeping you upright, then takes its time.',
  },
];

export function cardById(id) {
  const card = CARDS.find((c) => c.id === id);
  if (!card) throw new Error(`cardById: no card with id "${id}"`);
  return card;
}

export function deckById(id) {
  const deck = DECKS.find((d) => d.id === id);
  if (!deck) throw new Error(`deckById: no preset deck with id "${id}"`);
  return deck;
}

export function typeById(id) {
  const type = TYPES.find((t) => t.id === id);
  if (!type) throw new Error(`typeById: no type with id "${id}"`);
  return type;
}
