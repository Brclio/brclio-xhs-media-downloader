import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileUrl, normalizeProfileNote, parsePostedResponse, readProfileSnapshot } from '../desktop/profile-source.js';
import { XhsBrowser } from '../desktop/profile-browser.js';

const PROFILE = '5e413a430000000001000f4c';
const NOTE = '6a68c6d3000000001303f099';
const URL = `https://www.xiaohongshu.com/user/profile/${PROFILE}`;

test('profile URL validates actual hostname, full author ID and preserves signatures', () => {
  assert.equal(parseProfileUrl(`主页 ${URL}?xsec_token=abc`).id, PROFILE);
  assert.equal(parseProfileUrl(`${URL}?xsec_token=abc`).url, `${URL}?xsec_token=abc`);
  for (const value of [URL.replace('https:', 'http:'), URL.replace('.com/', '.com.evil.test/'), URL.replace('www.', 'foo@www.'), `${URL}/extra`, URL.replace('.com/', '.com:8443/'), 'https://127.0.0.1/']) {
    assert.throws(() => parseProfileUrl(value), { code: 'INVALID_PROFILE' });
  }
});

test('posted cards retain xsec tokens and reject other authors and URL mismatches', () => {
  const raw = { note_id: NOTE, xsec_token: 'abc=', note_card: { display_title: '标题', user: { user_id: PROFILE } } };
  const note = normalizeProfileNote(raw, PROFILE);
  assert.equal(new globalThis.URL(note.url).searchParams.get('xsec_token'), 'abc=');
  assert.equal(note.title, '标题');
  assert.equal(normalizeProfileNote({ ...raw, note_card: { user: { user_id: 'another' } } }, PROFILE), null);
  assert.equal(normalizeProfileNote({ id: NOTE, url: `https://evil.test/explore/${NOTE}` }, PROFILE), null);
  assert.equal(normalizeProfileNote({ id: NOTE, url: `https://www.xiaohongshu.com/explore/${PROFILE}` }, PROFILE), null);
  assert.match(normalizeProfileNote({ id: NOTE, url: `${URL}/${NOTE}?xsec_token=xyz` }, PROFILE).url, /explore\/.+xsec_token=xyz/);
});

test('only explicit successful last-page evidence completes profile discovery', () => {
  assert.equal(parsePostedResponse({ success: true, data: { notes: [] } }, PROFILE).done, false);
  assert.equal(parsePostedResponse({ success: true, data: { notes: [], has_more: false } }, PROFILE).done, true);
  assert.equal(parsePostedResponse({ success: true, data: { notes: [], has_more: 'false' } }, PROFILE).done, false);
  assert.equal(parsePostedResponse({ success: true, data: {} }, PROFILE), null);
  assert.throws(() => parsePostedResponse({ success: false, msg: '请先登录' }, PROFILE), { code: 'AUTH_REQUIRED' });
  assert.throws(() => parsePostedResponse({ code: -1, msg: '访问过于频繁' }, PROFILE), { code: 'RATE_LIMITED' });
  assert.throws(() => parsePostedResponse({ data: { notes: [{ id: 'unknown' }], has_more: false } }, PROFILE), { code: 'DISCOVERY_INCOMPLETE' });
});

test('SSR empty defaults never mean all downloaded; target query may prove zero posts', () => {
  const old = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  try {
    globalThis.location = { pathname: `/user/profile/${PROFILE}` };
    globalThis.document = { querySelectorAll: () => [], body: { innerText: '登录后查看' } };
    globalThis.window = { __INITIAL_STATE__: { user: { notes: [[], [], []], noteQueries: [{ userId: '', hasMore: false }] } } };
    assert.equal(readProfileSnapshot(PROFILE).done, false);
    window.__INITIAL_STATE__.user.noteQueries[0].userId = PROFILE;
    assert.equal(readProfileSnapshot(PROFILE).done, true);
    window.__INITIAL_STATE__.user.isFetchingNotes = [true];
    assert.equal(readProfileSnapshot(PROFILE).done, false);
  } finally {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('detail adapter rejects a mismatched note before creating a browser', async () => {
  const browser = new XhsBrowser();
  await assert.rejects(browser.resolveNote({ id: PROFILE, url: `https://www.xiaohongshu.com/explore/${NOTE}` }), { code: 'INVALID_NOTE' });
});
