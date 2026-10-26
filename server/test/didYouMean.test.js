import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { correctSearch, editDistance } from '../src/routes/catalog.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

const search = (q, extra = '') => t.call('GET', `/products?q=${encodeURIComponent(q)}${extra}`);

test('edit distance counts inserts, deletes, changes and swapped neighbours', () => {
  assert.equal(editDistance('samsng', 'samsung'), 1);
  assert.equal(editDistance('teh', 'the'), 1);
  assert.equal(editDistance('kettel', 'kettle'), 1);
  assert.equal(editDistance('voltix', 'voltix'), 0);
  assert.equal(editDistance('abc', 'xyz'), 3);
});

test('correcting a search: only words that match nothing, to the closest common word', () => {
  const words = new Map([
    ['voltix', 5],
    ['nova', 2],
    ['kettle', 3],
    ['kettles', 1],
    ['electric', 4],
    ['orbit', 3],
  ]);
  assert.equal(correctSearch('voltx nova', words), 'voltix nova');
  assert.equal(correctSearch('electirc kettel', words), 'electric kettle');
  assert.equal(correctSearch('volti', words), null); // already the start of a known word
  assert.equal(correctSearch('orbt', words), 'orbit');
  assert.equal(correctSearch('xyz', words), null); // nothing close
  assert.equal(correctSearch('nvoa', words), 'nova');
  assert.equal(correctSearch('ova', words), null); // three letters: the first must be right
  assert.equal(correctSearch('no', words), null); // too short to guess
  assert.equal(correctSearch('voltx qwertyuiop', words), null); // one word has no close match
  assert.equal(correctSearch('phones', words), null); // a synonym the search knows
});

test('a search with no results suggests the corrected one, with how many it finds', async () => {
  const res = await search('voltx');
  assert.equal(res.body.total, 0);
  assert.deepEqual(res.body.suggestion, { q: 'voltix', total: 2 });

  assert.equal((await search('arcbok')).body.suggestion.q, 'arcbook');
  assert.equal((await search('arcbook ari')).body.suggestion.q, 'arcbook air');
  assert.equal((await search('electirc kettel')).body.suggestion.q, 'electric kettle');
  assert.equal((await search('running shoos')).body.suggestion.q, 'running shoes');

  // With results, or nothing close: no suggestion.
  assert.equal((await search('voltix')).body.suggestion, null);
  assert.equal((await search('qwertyuiop')).body.suggestion, null);
  assert.equal((await t.call('GET', '/products')).body.suggestion, null);
});

test('a suggestion must find something with the same filters', async () => {
  assert.equal((await search('voltx', '&category=books')).body.suggestion, null);
  assert.equal((await search('voltx', '&maxPrice=100000')).body.suggestion, null); // ₹1,000 or less: no Voltix phone
  assert.deepEqual((await search('voltx', '&category=mobiles')).body.suggestion, { q: 'voltix', total: 2 });

  // Hidden products aren't suggested (the count leaves them out even while the word list is cached).
  await t.db.collection('products').updateMany({ brand: 'Voltix' }, { $set: { active: false } });
  assert.equal((await search('voltx')).body.suggestion, null);
  await t.db.collection('products').updateMany({ brand: 'Voltix' }, { $set: { active: true } });
});
