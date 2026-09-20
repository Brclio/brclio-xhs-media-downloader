const RUNNING_STATUSES = new Set(["discovering", "downloading", "waiting"]);
const STATUS_LABELS = {
  idle: "准备就绪",
  discovering: "发现笔记中",
  downloading: "正在下载",
  waiting: "间隔等待中",
  paused: "任务已暂停",
  completed: "全部处理完成",
  cancelled: "任务已停止",
  error: "任务遇到问题"
};
const ITEM_LABELS = {
  pending: "等待处理",
  queued: "等待处理",
  parsing: "正在解析",
  downloading: "正在下载",
  completed: "已下载",
  skipped: "已存在",
  failed: "下载失败"
};

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function validProfileUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["www.xiaohongshu.com", "xiaohongshu.com"].includes(url.hostname)
      && !url.username && !url.password && !url.port
      && /^\/user\/profile\/[a-f0-9]{24}\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

// The bridge is only present in the packaged desktop window. The web interface
// keeps its original single-note behavior and never invokes desktop APIs.
export async function initializeDesktopUI({ onInfo = () => {} } = {}) {
  const bridge = window.xhsDesktop;
  if (!bridge) return;

  const element = (id) => document.getElementById(id);
  const ui = {
    navigation: element("desktop-navigation"),
    version: element("desktop-version"),
    singleTab: element("single-note-tab"),
    profileTab: element("profile-tab"),
    singlePanel: element("single-note-panel"),
    panel: element("profile-panel"),
    form: element("profile-form"),
    url: element("profile-url"),
    directory: element("profile-directory"),
    chooseDirectory: element("profile-choose-directory"),
    interval: element("profile-interval"),
    jitter: element("profile-jitter"),
    timingHint: element("profile-timing-hint"),
    login: element("profile-login"),
    loginLabel: element("profile-login-label"),
    start: element("profile-start"),
    pause: element("profile-pause"),
    resume: element("profile-resume"),
    cancel: element("profile-cancel"),
    retry: element("profile-retry"),
    openDirectory: element("profile-open-directory"),
    error: element("profile-error"),
    status: element("profile-status"),
    discovered: element("profile-discovered"),
    completed: element("profile-completed"),
    skipped: element("profile-skipped"),
    failed: element("profile-failed"),
    progress: element("profile-progress"),
    discoveryHint: element("profile-discovery-hint"),
    message: element("profile-message"),
    current: element("profile-current"),
    countdown: element("profile-countdown"),
    resumeHint: element("profile-resume-hint"),
    details: element("profile-items-details"),
    items: element("profile-items"),
    itemsCount: element("profile-items-count"),
    itemsEmpty: element("profile-items-empty"),
    showMore: element("profile-show-more")
  };

  let snapshot = { status: "idle", items: [] };
  let operationPending = false;
  let initialized = false;
  let visibleItemCount = 100;
  let renderedItemsKey = "";
  let unsubscribe = () => {};
  let unsubscribeLogin = () => {};
  let loginRevision = 0;

  document.body.classList.add("is-desktop");
  document.title = "小红书媒体下载 · 本地版";
  ui.navigation.hidden = false;
  ui.singlePanel.setAttribute("role", "tabpanel");
  ui.singlePanel.setAttribute("aria-labelledby", "single-note-tab");
  ui.singlePanel.tabIndex = 0;
  const headerStatus = document.querySelector(".header-status");
  headerStatus.setAttribute("aria-label", "运行状态：本地桌面版");
  headerStatus.querySelector("span:last-child").textContent = "本地桌面版";
  document.querySelector(".hero-copy > p").textContent = "粘贴分享文案，解析笔记原图、实况图片与视频；也可以切换到主页下载，按你设定的节奏逐篇保存。";
  document.querySelector(".footer-brand strong").textContent = "喜欢的内容，保存在你的电脑。";
  document.querySelector("footer > p").textContent = "单篇笔记支持图片、实况 ZIP、视频与文案；主页内容按笔记归档到所选文件夹。";

  function selectTab(tab, focus = false) {
    for (const candidate of [ui.singleTab, ui.profileTab]) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    }
    ui.singlePanel.hidden = tab !== ui.singleTab;
    ui.panel.hidden = tab !== ui.profileTab;
    if (focus) tab.focus();
  }

  for (const tab of [ui.singleTab, ui.profileTab]) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? ui.singleTab
        : event.key === "End" ? ui.profileTab
          : tab === ui.singleTab ? ui.profileTab : ui.singleTab;
      selectTab(next, true);
    });
  }
  selectTab(ui.profileTab);

  function showError(message) {
    ui.error.textContent = message || "";
    ui.error.hidden = !message;
  }

  function renderLoginState(account) {
    const loggedIn = account?.loggedIn === true && account.status === "logged-in";
    const nickname = typeof account?.nickname === "string" ? account.nickname.trim() : "";
    const label = loggedIn ? nickname ? `已登录 · ${nickname}` : "已登录小红书" : "登录小红书 / 完成验证";
    ui.loginLabel.textContent = label;
    ui.login.dataset.loginStatus = loggedIn ? "logged-in" : account?.status === "logged-out" ? "logged-out" : "unknown";
    ui.login.setAttribute("aria-label", `${label}，打开小红书账号与验证窗口`);
    ui.login.title = loggedIn
      ? `${label}。当前账号使用本地版应用自己的登录状态，并保存在这台电脑。点击打开账号与验证窗口。`
      : "在本地版应用内登录，登录状态会保存在这台电脑；浏览器或 Codex 中的登录不会自动共享。";
  }

  function updateTimingHint() {
    const interval = Number(ui.interval.value);
    const jitter = Number(ui.jitter.value);
    if (!Number.isFinite(interval) || !Number.isFinite(jitter)) return;
    ui.timingHint.textContent = `每次抓取前等待 ${interval}–${interval + jitter} 秒。间隔适用于主页翻页、逐篇解析和媒体下载；延长间隔可减少请求频率，仍可能需要验证。`;
  }

  function updateControls() {
    const running = RUNNING_STATUSES.has(snapshot.status);
    const paused = snapshot.status === "paused";
    const locked = running || paused;
    const resumable = paused || (["cancelled", "error"].includes(snapshot.status) && snapshot.profileUrl && snapshot.directory);
    for (const input of [ui.url, ui.interval, ui.jitter, ui.chooseDirectory]) {
      input.disabled = !initialized || operationPending || locked;
    }
    ui.start.disabled = !initialized || operationPending || locked;
    ui.start.textContent = locked ? "当前任务进行中" : snapshot.status === "idle" ? "开始主页下载 ↓" : "开始新的主页下载 ↓";
    ui.pause.hidden = !running;
    ui.resume.hidden = !resumable;
    ui.resume.textContent = paused ? "继续任务" : "继续上次任务";
    ui.cancel.hidden = !locked;
    ui.retry.hidden = count(snapshot.failed) === 0 || running;
    for (const button of [ui.pause, ui.resume, ui.cancel, ui.retry, ui.login]) {
      button.disabled = operationPending;
    }
    ui.openDirectory.disabled = operationPending || !snapshot.directory;
    ui.openDirectory.title = snapshot.directory || "完成文件夹选择并开始任务后可打开";
    ui.resumeHint.hidden = !paused;
  }

  function updateCountdown() {
    const time = typeof snapshot.nextRequestAt === "number"
      ? snapshot.nextRequestAt : Date.parse(snapshot.nextRequestAt || "");
    const remaining = Math.ceil((time - Date.now()) / 1000);
    const visible = RUNNING_STATUSES.has(snapshot.status) && Number.isFinite(remaining) && remaining > 0;
    ui.countdown.hidden = !visible;
    if (visible) ui.countdown.textContent = `下一次抓取将在 ${remaining} 秒后开始`;
  }

  function renderItems() {
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    ui.itemsCount.textContent = String(items.length);
    ui.itemsEmpty.hidden = items.length > 0;
    const visible = items.slice(0, visibleItemCount);
    ui.showMore.hidden = visible.length >= items.length;
    ui.showMore.textContent = `显示更多记录（还有 ${Math.max(0, items.length - visible.length)} 篇）`;
    // Do not replace the list while only the waiting countdown changes.
    const key = JSON.stringify(visible.map(({ id, title, status, error }) => [id, title, status, error]));
    if (key === renderedItemsKey) return;
    renderedItemsKey = key;
    const fragment = document.createDocumentFragment();
    for (const item of visible) {
      const row = document.createElement("li");
      row.className = "profile-item";
      row.dataset.status = String(item.status || "pending");
      const title = document.createElement("span");
      title.className = "profile-item-title";
      title.textContent = String(item.title || item.id || "未命名笔记");
      const status = document.createElement("span");
      status.className = "profile-item-status";
      status.textContent = ITEM_LABELS[item.status] || "等待处理";
      row.append(title, status);
      if (item.error) {
        const error = document.createElement("p");
        error.className = "profile-item-error";
        error.textContent = String(item.error);
        row.append(error);
      }
      fragment.append(row);
    }
    const previousScroll = ui.items.scrollTop;
    ui.items.replaceChildren(fragment);
    ui.items.scrollTop = previousScroll;
  }

  function render(next) {
    if (!next || typeof next !== "object") return;
    snapshot = next;
    const discovered = count(next.discovered);
    const completed = count(next.completed);
    const skipped = count(next.skipped);
    const failed = count(next.failed);
    const processed = completed + skipped + failed;
    const complete = next.status === "completed" && next.discoveryComplete === true;
    ui.discovered.textContent = String(discovered);
    ui.completed.textContent = String(completed);
    ui.skipped.textContent = String(skipped);
    ui.failed.textContent = String(failed);
    ui.failed.dataset.hasFailures = String(failed > 0);
    ui.status.dataset.status = complete && failed > 0 ? "partial" : String(next.status || "idle");
    ui.status.textContent = next.status === "completed"
      ? complete ? failed > 0 ? "部分下载失败" : "全部处理完成" : "主页扫描未完成"
      : STATUS_LABELS[next.status] || "等待任务状态";
    ui.progress.max = Math.max(1, discovered);
    ui.progress.value = Math.min(processed, discovered);
    ui.progress.setAttribute("aria-valuetext", `已发现 ${discovered} 篇，成功保存 ${completed} 篇，已存在 ${skipped} 篇，失败 ${failed} 篇`);
    ui.discoveryHint.textContent = next.status === "idle" ? "主页尚未开始扫描。"
      : next.discoveryComplete ? `已读到主页末尾 · 已处理 ${processed} / ${discovered} 篇`
        : `尚未读到主页末尾 · 已发现 ${discovered} 篇，数量仍可能增加`;
    ui.message.textContent = next.message || (next.status === "idle" ? "选好主页和文件夹，就可以开始了。" : "正在更新任务状态……");
    ui.current.hidden = !next.currentTitle;
    ui.current.textContent = next.currentTitle ? `当前笔记：${next.currentTitle}` : "";
    updateCountdown();
    updateControls();
    renderItems();
  }

  function populateSettings(job) {
    if (job.profileUrl) ui.url.value = job.profileUrl;
    if (job.directory) ui.directory.value = job.directory;
    if (Number.isFinite(Number(job.intervalSeconds))) ui.interval.value = String(job.intervalSeconds);
    if (Number.isFinite(Number(job.jitterSeconds))) ui.jitter.value = String(job.jitterSeconds);
    updateTimingHint();
  }

  async function perform(action) {
    if (operationPending) return;
    operationPending = true;
    showError("");
    updateControls();
    try {
      const result = await action();
      if (result && typeof result.status === "string") render(result);
    } catch (error) {
      showError(error?.message || "操作未完成，请重试。");
    } finally {
      operationPending = false;
      updateControls();
    }
  }

  ui.interval.addEventListener("input", updateTimingHint);
  ui.jitter.addEventListener("input", updateTimingHint);
  ui.chooseDirectory.addEventListener("click", () => perform(async () => {
    const directory = await bridge.chooseDirectory();
    if (typeof directory === "string" && directory) ui.directory.value = directory;
  }));
  ui.login.addEventListener("click", () => perform(() => {
    const url = ui.url.value.trim();
    return bridge.openLogin(validProfileUrl(url) ? url : undefined);
  }));
  ui.pause.addEventListener("click", () => perform(() => bridge.pauseProfile()));
  ui.resume.addEventListener("click", () => perform(() => {
    populateSettings(snapshot);
    return bridge.resumeProfile();
  }));
  ui.cancel.addEventListener("click", () => perform(() => bridge.cancelProfile()));
  ui.retry.addEventListener("click", () => perform(() => bridge.retryFailed()));
  ui.openDirectory.addEventListener("click", () => perform(() => bridge.openDirectory()));
  ui.showMore.addEventListener("click", () => {
    visibleItemCount += 100;
    renderItems();
  });

  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (ui.start.disabled) return;
    showError("");
    const profileUrl = ui.url.value.trim();
    if (!validProfileUrl(profileUrl)) {
      showError("请粘贴 https://www.xiaohongshu.com/user/profile/ 开头的完整用户主页链接。");
      ui.url.focus();
      return;
    }
    if (!ui.directory.value) {
      showError("请先选择用于保存图片、视频和文案的文件夹。");
      ui.chooseDirectory.focus();
      return;
    }
    if (!ui.form.reportValidity()) return;
    visibleItemCount = 100;
    void perform(() => bridge.startProfile({
      profileUrl,
      directory: ui.directory.value,
      intervalSeconds: Number(ui.interval.value),
      jitterSeconds: Number(ui.jitter.value)
    }));
  });

  render(snapshot);
  const countdownTimer = setInterval(updateCountdown, 1000);
  window.addEventListener("pagehide", () => {
    clearInterval(countdownTimer);
    unsubscribe();
    unsubscribeLogin();
  }, { once: true });

  // Account state comes only from the app's own authenticated Xiaohongshu
  // session. A visited profile's author is never a substitute for that account.
  renderLoginState(null);
  if (typeof bridge.onLoginUpdate === "function") {
    const cleanup = bridge.onLoginUpdate((account) => {
      loginRevision += 1;
      renderLoginState(account);
    });
    if (typeof cleanup === "function") unsubscribeLogin = cleanup;
  }
  if (typeof bridge.getLoginState === "function") {
    const requestedRevision = loginRevision;
    void bridge.getLoginState().then((account) => {
      if (loginRevision === requestedRevision) renderLoginState(account);
    }).catch(() => {
      if (loginRevision === requestedRevision) {
        ui.login.title = "暂时无法读取登录状态。点击打开本地版的小红书窗口进行检查。";
      }
    });
  }

  try {
    // Subscribe first so no job transition can be lost during initialization.
    const cleanup = bridge.onProfileUpdate(render);
    if (typeof cleanup === "function") unsubscribe = cleanup;
    const [info, savedState] = await Promise.all([bridge.getInfo(), bridge.getProfileState()]);
    onInfo(info);
    ui.version.textContent = info.version ? `本地版 v${info.version}` : "本地下载工作台";
    initialized = true;
    // A newer update may have arrived while the initial snapshot was in flight.
    if (!snapshot.updatedAt || !savedState?.updatedAt || savedState.updatedAt >= snapshot.updatedAt) {
      populateSettings(savedState || {});
      render(savedState || snapshot);
    } else {
      populateSettings(snapshot);
      updateControls();
    }
  } catch (error) {
    showError(`本地下载功能暂未就绪：${error?.message || "请重新打开应用。"}`);
    updateControls();
  }
}
