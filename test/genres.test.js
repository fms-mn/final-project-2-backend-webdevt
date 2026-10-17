const test = require('node:test');
const assert = require('node:assert/strict');
const Setting = require('../models/Setting');
const { fakeModel } = require('./fakeDb');
const { getSettings, updateSettings, DEFAULTS } = require('../services/settings');
const { normalizeGenres } = require('../utils/genres');

const rows = [];
test.before(() => fakeModel(Setting, rows, { uniqueOn: 'key' }));
test.beforeEach(() => { rows.length = 0; });

test('old settings receive default genres without overwriting scheduling rules', async () => {
  rows.push(new Setting({ key: 'cinema', turnaroundMinutes: 25, salesCutoffMinutes: 10 }));
  assert.deepEqual((await getSettings()).genres, DEFAULTS.genres);
  await updateSettings({ genres: [' Action ', 'Local Cinema'] });
  assert.deepEqual((await getSettings()).genres, ['Action', 'Local Cinema']);
  assert.equal((await getSettings()).turnaroundMinutes, 25);
  await updateSettings({ salesCutoffMinutes: 20 });
  assert.deepEqual((await getSettings()).genres, ['Action', 'Local Cinema']);
});

test('genre additions and deletions persist, including an explicitly empty list', async () => {
  await updateSettings({ genres: ['Drama', 'Local Cinema'] });
  assert.deepEqual((await getSettings()).genres, ['Drama', 'Local Cinema']);
  await updateSettings({ genres: ['Local Cinema'] });
  assert.deepEqual((await getSettings()).genres, ['Local Cinema']);
  await updateSettings({ genres: [] });
  assert.deepEqual((await getSettings()).genres, []);
});

test('invalid genre writes fail before changing saved settings', async () => {
  await updateSettings({ genres: ['Drama'] });
  for (const genres of [null, 'Drama', [42], [''], ['a'.repeat(41)], ['Drama', ' drama '], ['Action, Drama'], ['A/B'], ['A;B'], ['A|B'], ['A\nB'], Array(101).fill('Drama')]) {
    await assert.rejects(updateSettings({ genres }), err => err.status === 400 && Boolean(err.errors?.genres));
    assert.deepEqual((await getSettings()).genres, ['Drama']);
  }
  assert.deepEqual(normalizeGenres(['  Local Cinema  ']), ['Local Cinema']);
});

test('server and client initial genre catalogs agree', async () => {
  const { MOVIE_GENRES } = await import('../../client/src/utils/genres.js');
  assert.deepEqual(DEFAULTS.genres, MOVIE_GENRES);
});
