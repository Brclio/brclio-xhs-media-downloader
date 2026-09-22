import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// This independent system process keeps its native window after Electron exits
// and its application bundle moves. Paths and version are arguments, never code.
const PROGRESS_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
  var resultPath = argv[0], readyPath = argv[1], version = argv[2];
  var alive = true, installedAt = 0, lastUpdate = Date.now(), missingSince = 0;
  var previous = '', terminal = false;
  var stages = { preparing: 0, opening: 1, verifying: 2, copying: 3, checking: 4,
    prepared: 5, ready: 5, waiting: 5, validating: 5, replacing: 6, launching: 7, installed: 8 };
  var messages = { preparing: '正在准备安装更新…', opening: '正在打开安装包…',
    verifying: '正在校验新版应用…', copying: '正在复制新版应用…',
    checking: '正在检查安装文件…', prepared: '安装准备已完成…',
    ready: '安装助手已准备好…', waiting: '正在等待当前应用退出…', validating: '正在复核安装文件…',
    replacing: '正在覆盖安装，旧版本已保留为备份…', launching: '正在重新打开新版应用…',
    installed: '安装成功，正在自动打开新版应用。' };

  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, 520, 232),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
    $.NSBackingStoreBuffered, false);
  window.title = '安装更新';
  window.releasedWhenClosed = false;
  window.center;
  var content = window.contentView;
  function label(text, x, y, width, height, size, bold) {
    var field = $.NSTextField.alloc.initWithFrame($.NSMakeRect(x, y, width, height));
    field.stringValue = text;
    field.editable = false;
    field.selectable = false;
    field.bezeled = false;
    field.drawsBackground = false;
    field.font = bold ? $.NSFont.boldSystemFontOfSize(size) : $.NSFont.systemFontOfSize(size);
    field.cell.wraps = true;
    field.cell.scrollable = false;
    content.addSubview(field);
    return field;
  }
  label('正在安装 v' + version, 24, 179, 472, 28, 18, true);
  var detail = label(messages.preparing, 24, 120, 472, 48, 13, false);
  var bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(24, 98, 472, 16));
  bar.style = $.NSProgressIndicatorStyleBar;
  bar.indeterminate = false;
  bar.minValue = 0;
  bar.maxValue = 8;
  bar.doubleValue = 0;
  content.addSubview(bar);
  var stageLabel = label('安装阶段 0 / 8 · 准备安装', 24, 63, 472, 22, 12, false);
  stageLabel.textColor = $.NSColor.secondaryLabelColor;
  var closeButton = $.NSButton.alloc.initWithFrame($.NSMakeRect(398, 15, 98, 30));
  closeButton.title = '关闭';
  closeButton.bezelStyle = $.NSBezelStyleRounded;
  closeButton.hidden = true;
  content.addSubview(closeButton);
  ObjC.registerSubclass({ name: 'BrclioInstallProgressDelegate', superclass: 'NSObject', methods: {
    'windowWillClose:': { types: ['void', ['id']], implementation: function () { alive = false; } },
    'closeProgress:': { types: ['void', ['id']], implementation: function () { window.close; alive = false; } }
  } });
  var delegate = $.BrclioInstallProgressDelegate.alloc.init;
  window.delegate = delegate;
  closeButton.target = delegate;
  closeButton.action = 'closeProgress:';

  function showFailure(message) {
    terminal = true;
    installedAt = 0;
    detail.stringValue = message;
    stageLabel.stringValue = '安装未完成 · 请查看提示';
    closeButton.hidden = false;
  }
  function refresh() {
    if (terminal) return;
    var raw = $.NSString.stringWithContentsOfFileEncodingError(resultPath, $.NSUTF8StringEncoding, null);
    var text = raw ? ObjC.unwrap(raw) : '';
    var state;
    try { state = JSON.parse(text); } catch (_) { state = null; }
    if (!state || typeof state.status !== 'string') {
      if (!missingSince) missingSince = Date.now();
      if (Date.now() - missingSince > 30000) showFailure('暂时无法读取安装进度。请查看应用中的更新结果或安装记录。');
      return;
    }
    missingSince = 0;
    if (text !== previous) { lastUpdate = Date.now(); previous = text; }
    if (Object.prototype.hasOwnProperty.call(stages, state.status)) {
      var stage = stages[state.status];
      bar.doubleValue = stage;
      detail.stringValue = typeof state.message === 'string' && state.message ? state.message : messages[state.status];
      stageLabel.stringValue = '安装阶段 ' + stage + ' / 8 · ' + messages[state.status].replace(/[…。]+$/, '');
      if (state.status === 'installed') { if (!installedAt) installedAt = Date.now(); }
      else if (Date.now() - lastUpdate > 15 * 60 * 1000) showFailure('安装进度长时间未更新。请查看应用中的更新结果或安装记录。');
    } else {
      showFailure(typeof state.message === 'string' && state.message ? state.message : '安装未完成，请查看安装记录。');
      if (state.status === 'cancelled') stageLabel.stringValue = '安装已取消';
      if (state.status === 'rolled_back') stageLabel.stringValue = '安装未完成 · 已恢复旧版';
    }
  }

  function pumpEvents() {
    var event = app.nextEventMatchingMaskUntilDateInModeDequeue($.NSEventMaskAny,
      $.NSDate.dateWithTimeIntervalSinceNow(0.1), $.NSDefaultRunLoopMode, true);
    if (event) app.sendEvent(event);
    app.updateWindows;
  }

  try {
    app.finishLaunching;
    refresh();
    window.makeKeyAndOrderFront(null);
    app.activateIgnoringOtherApps(true);
    pumpEvents();
    var ready = JSON.stringify({ ready: true, windowNumber: Number(window.windowNumber) });
    if (!$(ready).writeToFileAtomicallyEncodingError(readyPath, true, $.NSUTF8StringEncoding, null)) throw new Error('Unable to acknowledge progress window');
    while (alive) {
      refresh();
      if (installedAt && Date.now() - installedAt >= 1000) { window.close; break; }
      pumpEvents();
    }
  } finally {
    window.orderOut(null);
    $.NSFileManager.defaultManager.removeItemAtPathError($(readyPath).stringByDeletingLastPathComponent, null);
  }
}
`;

const fail = cause => Object.assign(new Error('无法显示安装进度窗口，请重试安装。', cause ? { cause } : undefined), { code: 'MAC_UPDATE_PROGRESS' });

/** A detached native progress window; installation is performed by a separate helper. */
export async function startMacInstallProgress({ resultPath, version }, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'darwin'
    || typeof resultPath !== 'string' || !path.isAbsolute(resultPath) || /[\0\r\n]/.test(resultPath)
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '')) throw fail();
  let directory;
  try { directory = await mkdtemp(path.join(tmpdir(), 'brclio-install-progress-')); }
  catch (cause) { throw fail(cause); }
  const readyPath = path.join(directory, 'ready.json');
  const spawnProgress = dependencies.spawn || spawn;
  let child, failure, exited = false, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child && !exited) {
      child.kill();
      const deadline = Date.now() + 1000;
      while (!exited && Date.now() < deadline) await delay(25);
      if (!exited) {
        child.kill('SIGKILL');
        const forceDeadline = Date.now() + 1000;
        while (!exited && Date.now() < forceDeadline) await delay(25);
      }
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    child = spawnProgress('/usr/bin/osascript', ['-l', 'JavaScript', '-', resultPath, readyPath, version], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore']
    });
    child.on('error', error => { failure = error; });
    child.on('exit', () => { exited = true; });
    child.stdin.on('error', error => { failure = error; });
    child.stdin.end(PROGRESS_SCRIPT);
    const deadline = Date.now() + (dependencies.readinessTimeoutMs ?? 8000);
    while (Date.now() < deadline) {
      if (failure || exited || dependencies.signal?.aborted) throw failure || dependencies.signal?.reason || new Error('Progress window closed');
      try {
        const ready = JSON.parse(await readFile(readyPath, 'utf8'));
        if (ready.ready === true && Number.isSafeInteger(ready.windowNumber) && ready.windowNumber > 0) {
          child.unref();
          return { close };
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(25);
    }
    throw new Error('Progress window readiness timed out');
  } catch (cause) {
    await close();
    throw fail(cause);
  }
}
