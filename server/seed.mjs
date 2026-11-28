/**
 * The studio's own build carried over from the old Apps Script site.
 *
 * A fresh database gets this once (tracked by settings.seed) so the new site
 * starts with the real portfolio instead of an empty Vault. The cover is a
 * relative path so it resolves on every host the site is served from.
 */
export const SEED_ID = 'vault-2026-11-28';

const FANTASY_HOUSE = {
  id: 'build-8bcb659b',
  created: 1795673072526,
  title: 'Massive Fantasy House',
  category: 'Buildings',
  tagline: 'A towering half-timbered house with terracotta roofs and three stone chimneys.',
  story:
    'A massive fantasy house in the half-timbered style.\n\n' +
    'Terracotta roof tiles cascade over intricate wooden beams, towering stone chimneys frame the peaked rooftops, ' +
    'tall arched windows add elegance to each level, and a rugged cobblestone base anchors the entire structure.',
  time: '3 hours',
  blocks: '',
  size: '',
  finished: '',
  edition: 'Bedrock',
  tags: ['Fantasy house', 'Medieval'],
  link: '',
  hidden: false,
  pos: '',
  cover: {
    id: 'massive-fantasy-house',
    name: 'massive-fantasy-house.jpg',
    size: 298776,
    url: 'media/massive-fantasy-house.jpg'
  },
  gallery: [],
  structure: null,
  world: null
};

/** Returns true when the database changed and needs saving. */
export function seedDatabase(db) {
  if (!db || typeof db !== 'object') return false;
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  if (db.settings.seed === SEED_ID) return false;

  if (!Array.isArray(db.builds)) db.builds = [];
  if (!db.builds.some((build) => build && build.id === FANTASY_HOUSE.id)) {
    db.builds.push({ ...FANTASY_HOUSE });
  }
  if (!db.settings.notify) db.settings.notify = 'pinnaclebuilds1@gmail.com';
  db.settings.seed = SEED_ID;
  return true;
}
