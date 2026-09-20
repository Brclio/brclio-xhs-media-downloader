import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readLoginSnapshot } from '../desktop/login-state.js';

const OWN = '111111111111111111111111';
const AUTHOR = '222222222222222222222222';
function snapshot(state, document = { querySelectorAll: () => [] }) {
  // Source execution catches accidental dependencies on imports or Node APIs.
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${readLoginSnapshot.toString()})()`, {
    window: { __INITIAL_STATE__: state }, document, URL
  })));
}
function accountLink(id, attributes = {}, name = '') {
  return {
    textContent: name,
    getAttribute: key => key === 'href' ? `https://www.xiaohongshu.com/user/profile/${id}` : attributes[key] || null,
    querySelector: () => null
  };
}

test('login state reads only the signed-in user, not the displayed profile author', () => {
  const result = snapshot({ user: {
    loggedIn: true, userInfo: { userId: OWN, nickname: '我的昵称' },
    userPageData: { userId: AUTHOR, basicInfo: { nickname: '正在看的作者' } }
  } });
  assert.deepEqual(result, { status: 'logged-in', loggedIn: true, nickname: '我的昵称', userId: OWN });
});

test('logged-out SSR defaults and stale account caches never display a logged-in nickname', () => {
  const result = snapshot({ user: {
    loggedIn: false, userInfo: { userId: OWN, nickname: '旧账号' },
    userPageData: { basicInfo: { nickname: '其他作者' } }
  }, account: { loggedIn: true, userInfo: { userId: OWN, nickname: '旧缓存' } } });
  assert.deepEqual(result, { status: 'logged-out', loggedIn: false, nickname: '', userId: '' });
  assert.equal(snapshot({ user: { loggedIn: false, userInfo: { userId: undefined, redId: undefined } } }).status, 'logged-out');
});

test('Vue ref wrappers, including false booleans, are unwrapped without truthiness errors', () => {
  const result = snapshot({ user: { _value: {
    loggedIn: { _value: true }, userInfo: { _value: { userId: { value: OWN }, nickName: { value: '账户名称' } } }
  } } });
  assert.deepEqual(result, { status: 'logged-in', loggedIn: true, nickname: '账户名称', userId: OWN });
  assert.equal(snapshot({ user: { loggedIn: { value: false }, userInfo: { userId: OWN } } }).status, 'logged-out');
});

test('missing or nonboolean authentication evidence is unknown even when profile/account data exists', () => {
  for (const flag of [undefined, null, 'false', 'true', 0, 1, {}]) {
    const result = snapshot({ user: { loggedIn: flag, userInfo: { userId: OWN, nickname: '缓存' }, userPageData: { basicInfo: { nickname: '作者' } } } });
    assert.deepEqual(result, { status: 'unknown', loggedIn: false, nickname: '', userId: '' });
  }
  assert.equal(snapshot(undefined).status, 'unknown');
});

test('verified login without a nickname stays logged-in and never reads author or note details', () => {
  const result = snapshot({ user: { loggedIn: true, userInfo: { userId: OWN },
    userPageData: { basicInfo: { nickname: '作者的昵称' } } },
    note: { noteDetailMap: { test: { user: { userId: AUTHOR, nickname: '帖子作者' } } } }
  });
  assert.deepEqual(result, { status: 'logged-in', loggedIn: true, nickname: '', userId: OWN });
});

test('a current-account store can supplement nickname only when its ID matches the account', () => {
  const own = snapshot({ user: { loggedIn: true, userInfo: { userId: OWN } },
    account: { currentUser: { user_id: OWN, nick_name: '账户资料' } } });
  assert.equal(own.nickname, '账户资料');
  const mismatched = snapshot({ user: { loggedIn: true, userInfo: { userId: OWN } },
    account: { currentUser: { user_id: AUTHOR, nickname: '另一个账号' } } });
  assert.equal(mismatched.nickname, '');
});

test('own-account navigation enriches missing nickname only for an exact own profile link', () => {
  let selector = '';
  const result = snapshot({ user: { loggedIn: true, userInfo: { userId: OWN } } }, {
    querySelectorAll(value) {
      selector = value;
      return [accountLink(AUTHOR, { 'data-nickname': '正在看的作者' }), accountLink(OWN, { 'data-nickname': '导航里的本人' })];
    }
  });
  assert.equal(result.nickname, '导航里的本人');
  assert.match(selector, /nav a\[href\]/);
  assert.doesNotMatch(selector, /profile-header|user-page|\.nickname$/);
});

test('generic own navigation labels do not become the displayed nickname', () => {
  for (const label of ['我', '我的主页', '头像', 'Profile', 'account']) {
    assert.equal(snapshot({ user: { loggedIn: true, userInfo: { userId: OWN } } }, {
      querySelectorAll: () => [accountLink(OWN, { title: label }, label)]
    }).nickname, '');
  }
});

test('without a known own user ID, navigation links cannot identify the current account', () => {
  const result = snapshot({ user: { loggedIn: true, userInfo: {} } }, {
    querySelectorAll() { throw new Error('must not inspect unrelated profiles'); }
  });
  assert.deepEqual(result, { status: 'logged-in', loggedIn: true, nickname: '', userId: '' });
});

test('snapshot is a fixed minimal shape and never exposes cookies, credentials, or raw user state', () => {
  const result = snapshot({ user: { loggedIn: true, userInfo: { userId: OWN, name: '个人名称',
    token: 'secret-token', cookie: 'secret-cookie', phone: '123456789' } } });
  assert.deepEqual(Object.keys(result).sort(), ['loggedIn', 'nickname', 'status', 'userId']);
  assert.doesNotMatch(JSON.stringify(result), /secret|123456789/);
});
