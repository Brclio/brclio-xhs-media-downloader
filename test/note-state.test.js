import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readNoteSnapshot } from '../desktop/note-state.js';
import { parseNoteHtml } from '../lib/xhs.js';

const NOTE = '668d2967000000002500100a';
const OTHER = '222222222222222222222222';
const imageUrl = name => `https://sns-webpic-qc.xhscdn.com/202609200000/fixture/${name}!nd_dft_wlteh_webp_3`;
const videoUrl = name => `https://sns-video-bd.xhscdn.com/${name}.mp4`;
function read(state, id = NOTE, document = { querySelectorAll: () => [] }) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${readNoteSnapshot.toString()})(${JSON.stringify(id)})`, {
    window: { __INITIAL_STATE__: state }, document, TextEncoder
  })));
}
function parsed(result) {
  assert.equal(result.error, undefined);
  return parseNoteHtml(`<script>window.__INITIAL_STATE__=${result.serialized.replace(/</g, '\\u003c')}</script>`, { noteId: NOTE });
}
function note(overrides = {}) {
  return { noteId: NOTE, title: '当前帖子', desc: '完整正文\n第二行', imageList: [{ urlDefault: imageUrl('target') }], ...overrides };
}
function state(entry = note()) { return { note: { noteDetailMap: { [NOTE]: { note: entry } } } }; }
function ref(value) {
  const wrapper = { _value: value, __v_isRef: true, dep: {} };
  wrapper.dep.computed = wrapper;
  return wrapper;
}

test('circular store/comments siblings are excluded while exact note media and text parse normally', () => {
  const root = state();
  root.note.dep = { computed: root.note };
  root.note.noteDetailMap[NOTE].comments = { author: root.note };
  root.note.noteDetailMap[OTHER] = { note: note({ noteId: OTHER, title: '别的作者', imageList: [{ urlDefault: imageUrl('other') }] }) };
  assert.throws(() => JSON.stringify(root.note), /circular/i);
  const result = read(root);
  assert.doesNotMatch(result.serialized, /comments|computed|别的作者|other!/);
  const detail = parsed(result);
  assert.equal(detail.strategy, 'exact-initial-state');
  assert.equal(detail.images.length, 1);
  assert.equal(detail.images[0].token, 'target');
  assert.equal(detail.title, '当前帖子');
  assert.equal(detail.content, '完整正文\n第二行');
});

test('Vue refs unwrap targeted image and video data without copying cyclic dependency internals', () => {
  const live = { masterUrl: videoUrl('live'), backupUrls: [videoUrl('live-backup')], width: 720, height: 1280, videoCodec: 'h264' };
  const detail = note({
    title: ref('响应式标题'), desc: ref('响应式正文'),
    imageList: ref([
      ref({ urlDefault: ref(imageUrl('live-image')), livePhoto: ref(true), stream: ref({ h264: ref([ref(live)]) }) }),
      ref({ infoList: ref([{ url: imageUrl('second-image'), imageScene: 'WB_DFT' }]) })
    ]),
    video: ref({ media: ref({ stream: ref({ h264: ref([ref({ masterUrl: videoUrl('main'), backupUrls: [videoUrl('backup')], width: 1920, height: 1080, videoBitrate: 5000000 })]) }) }) })
  });
  const root = { note: ref({ noteDetailMap: ref({ [NOTE]: ref({ note: ref(detail), comments: ref({}) }) }) }) };
  const result = parsed(read(root));
  assert.equal(result.strategy, 'exact-initial-state');
  assert.equal(result.title, '响应式标题');
  assert.equal(result.content, '响应式正文');
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].liveVideo.url, videoUrl('live'));
  assert.deepEqual(result.images[0].liveVideo.backupUrls, [videoUrl('live-backup')]);
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].url, videoUrl('main'));
  assert.deepEqual(result.videos[0].backupUrls, [videoUrl('backup')]);
});

test('only the exact map entry is selected and explicit mismatching IDs are rejected', () => {
  const unrelated = read({ note: { noteDetailMap: { [OTHER]: { note: note({ noteId: OTHER }) } } } });
  assert.equal(unrelated.serialized, '');
  assert.equal(unrelated.error, undefined);
  const mismatched = read(state(note({ noteId: OTHER })));
  assert.equal(mismatched.serialized, '');
  assert.equal(mismatched.error.code, 'NOTE_ID_MISMATCH');
});

test('media recommendations, tracking and authentication fields are never cloned', () => {
  const result = read(state(note({
    token: 'top-secret', comments: [{ text: 'comment-secret' }], user: { cookie: 'cookie-secret' },
    imageList: [{ urlDefault: imageUrl('target'), recommendations: [{ url: imageUrl('recommendation') }], token: 'image-secret' }]
  })));
  assert.doesNotMatch(result.serialized, /secret|recommendation|comments|cookie/);
  assert.equal(parsed(result).images.length, 1);
});

test('oversized selected payload returns an explicit error instead of truncated JSON', () => {
  const result = read(state(note({ desc: 'x'.repeat(8 * 1024 * 1024 + 1) })));
  assert.equal(result.serialized, '');
  assert.equal(result.error.code, 'NOTE_STATE_TOO_LARGE');
  const tooMany = read(state(note({ imageList: new Array(2001).fill({ urlDefault: imageUrl('target') }) })));
  assert.equal(tooMany.error.code, 'NOTE_STATE_TOO_LARGE');
});

test('a real cycle in whitelisted media fails explicitly instead of silently omitting media', () => {
  const media = { h264: [] };
  media.media = media;
  const result = read(state(note({ video: { media } })));
  assert.equal(result.serialized, '');
  assert.equal(result.error.code, 'NOTE_STATE_INVALID');
});

test('duplicate shared image items preserve ordering and explicit legacy video keys', () => {
  const image = { urlDefault: imageUrl('same') };
  const result = parsed(read(state(note({ imageList: [image, image], video: { consumer: { originVideoKey: 'legacy/video' } } }))));
  assert.equal(result.images.length, 2);
  assert.equal(result.videos[0].url, 'https://sns-video-bd.xhscdn.com/legacy/video');
});

test('visible challenge/login gates retain the existing response flags', () => {
  const result = read({}, NOTE, { querySelectorAll: selector => selector.includes('captcha') ? [{ getClientRects: () => [1] }] : [] });
  assert.equal(result.challenge, true);
  assert.equal(result.login, false);
  assert.equal(result.serialized, '');
});

test('new mobile noteData wrappers resolve only the exact note and preserve audio metadata', () => {
  const video = { media: { stream: { h264: [{ masterUrl: videoUrl('with-audio'),
    audioCodec: 'aac', audioChannels: 2, audioBitrate: 64000, videoCodec: 'h264' }] } } };
  for (const root of [
    { noteData: { data: note({ type: 'video', video }) } },
    { noteData: ref({ data: ref({ noteData: ref(note({ type: 'video', video })) }) }) },
    { note: { noteDetailMap: { [NOTE]: note({ type: 'video', video }) } } }
  ]) {
    const result = read(root);
    assert.equal(parsed(result).videos[0].url, videoUrl('with-audio'));
    assert.match(result.serialized, /"audioCodec":"aac"/);
    assert.match(result.serialized, /"audioChannels":2/);
  }
  const untrusted = read({ noteData: { data: note({ noteId: OTHER }),
    comments: [{ noteId: NOTE, video }], recommendations: [{ noteId: NOTE, video }] } });
  assert.equal(untrusted.serialized, '');
});
