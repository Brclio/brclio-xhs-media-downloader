import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_NICKNAMES, defaultReviewNickname, randomReviewNickname, normalizeReviewNickname } from '../lib/review-nicknames.js';

function withRandomValues(implementation, callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: implementation } });
  try { return callback(); }
  finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
}

test('the built-in catalog contains exactly 1000 distinct, valid Chinese nicknames and is immutable', () => {
  assert.equal(REVIEW_NICKNAMES.length, 1000);
  assert.equal(new Set(REVIEW_NICKNAMES).size, 1000);
  assert.equal(Object.isFrozen(REVIEW_NICKNAMES), true);
  for (const name of REVIEW_NICKNAMES) {
    assert.match(name, /^\p{Script=Han}+$/u);
    assert.equal(normalizeReviewNickname(name), name);
    assert.equal(name.includes('@'), false);
  }
  assert.throws(() => { REVIEW_NICKNAMES[0] = '修改昵称'; }, TypeError);
  assert.throws(() => REVIEW_NICKNAMES.push('新增昵称'), TypeError);
});

test('default display names are stable pool members and never contain the supplied account identity', () => {
  for (const identity of ['user-fixture', 'another-user', '用户标识🌿', 'owner@example.test', '', null]) {
    const selected = defaultReviewNickname(identity);
    assert.equal(selected, defaultReviewNickname(identity));
    assert.equal(REVIEW_NICKNAMES.includes(selected), true);
    if (identity) assert.equal(selected.includes(identity), false);
  }
  // This fixture also catches unintentional catalog reordering across releases.
  assert.equal(defaultReviewNickname('user-fixture'), '爱做梦的山茶');
});

test('nickname normalization applies NFC and trimming while counting Unicode code points', () => {
  assert.equal(normalizeReviewNickname('  晒太阳的小鹿  '), '晒太阳的小鹿');
  assert.equal(normalizeReviewNickname(' Cafe\u0301 '), 'Café');
  assert.equal(normalizeReviewNickname('🌿🍋'), '🌿🍋');
  assert.equal(normalizeReviewNickname('🌿'.repeat(24)), '🌿'.repeat(24));
  assert.throws(() => normalizeReviewNickname('🌿'.repeat(25)), RangeError);
  assert.equal(normalizeReviewNickname('一'.repeat(24)), '一'.repeat(24));
  assert.throws(() => normalizeReviewNickname('一'.repeat(25)), RangeError);
  for (const value of ['', '   ', '一', '🌿']) assert.throws(() => normalizeReviewNickname(value), RangeError);
  for (const value of [null, undefined, 123, {}, []]) assert.throws(() => normalizeReviewNickname(value), TypeError);
});

test('nickname normalization rejects control, line and invisible format characters even at input edges', () => {
  for (const character of ['\n', '\r', '\t', '\0', '\x1b', '\x7f', '\u0085', '\u200b', '\u200d', '\u2028', '\u2029', '\u202e', '\ufeff']) {
    assert.throws(() => normalizeReviewNickname(`${character}小鹿`), RangeError, `leading ${JSON.stringify(character)}`);
    assert.throws(() => normalizeReviewNickname(`小${character}鹿`), RangeError, `internal ${JSON.stringify(character)}`);
    assert.throws(() => normalizeReviewNickname(`小鹿${character}`), RangeError, `trailing ${JSON.stringify(character)}`);
  }
});

test('display names may repeat and remain plain text; email redaction belongs to the backend', () => {
  assert.equal(normalizeReviewNickname('同一个昵称'), normalizeReviewNickname('同一个昵称'));
  assert.equal(normalizeReviewNickname('<小鹿>'), '<小鹿>');
  assert.equal(normalizeReviewNickname('a@b.co'), 'a@b.co');
  assert.equal(normalizeReviewNickname('小鹿 同学'), '小鹿 同学');
});

test('random selection uses crypto and can reach every built-in nickname', () => {
  let value = 0;
  withRandomValues(array => {
    assert.equal(array instanceof Uint32Array, true);
    array[0] = value++;
    return array;
  }, () => {
    const selected = Array.from({ length: 1000 }, () => randomReviewNickname());
    assert.equal(new Set(selected).size, 1000);
    assert.deepEqual(selected, REVIEW_NICKNAMES);
  });
});

test('random selection always changes a built-in previous nickname with string or object arguments', () => {
  withRandomValues(array => { array[0] = 0; return array; }, () => {
    for (const previous of REVIEW_NICKNAMES) {
      const direct = randomReviewNickname(previous);
      const object = randomReviewNickname({ previous });
      assert.equal(REVIEW_NICKNAMES.includes(direct), true);
      assert.notEqual(direct, previous);
      assert.equal(direct, object);
    }
    assert.notEqual(randomReviewNickname(` ${REVIEW_NICKNAMES[0]} `), REVIEW_NICKNAMES[0]);
    assert.equal(randomReviewNickname('我自己填写的昵称'), REVIEW_NICKNAMES[0]);
    assert.equal(randomReviewNickname({}), REVIEW_NICKNAMES[0]);
  });
});

test('crypto selection rejects the biased tail and never falls back to a weak random source', () => {
  let calls = 0;
  withRandomValues(array => { array[0] = calls++ === 0 ? 0xffffffff : 2; return array; }, () => {
    assert.equal(randomReviewNickname(), REVIEW_NICKNAMES[2]);
    assert.equal(calls, 2);
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    assert.throws(() => randomReviewNickname(), /手动填写昵称/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
});
