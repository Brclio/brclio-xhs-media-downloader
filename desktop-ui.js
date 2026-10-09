import { openAccountUI } from "./account-ui.js";

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

function updateBytes(value) {
  const bytes = count(value);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
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
export async function initializeDesktopUI({ onInfo = () => {}, onCopyNoteLink, onOpenNote } = {}) {
  delete document.body.dataset.desktopReady;
  const bridge = window.xhsDesktop;
  if (!bridge) return;

  // Only uncaught error details are sent to the local diagnostics service.
  // User form contents, cookies, and downloaded media are never inspected here.
  if (typeof bridge.recordDiagnostic === "function") {
    let reported = 0;
    const report = (event, error, fallback) => {
      if (reported++ >= 20) return;
      void bridge.recordDiagnostic(event, {
        message: error instanceof Error ? error.message : fallback || "未知的界面错误",
        stack: error instanceof Error ? error.stack : undefined
      }).catch(() => {});
    };
    const onError = event => report("renderer.error", event.error, event.message);
    const onRejection = event => report("renderer.unhandledrejection", event.reason,
      typeof event.reason === "string" ? event.reason : "异步操作未捕获错误");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("pagehide", () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    }, { once: true });
  }

  const element = (id) => document.getElementById(id);
  const ui = {
    navigation: element("desktop-navigation"),
    version: element("desktop-version"),
    updateCheck: element("desktop-check-updates"),
    updatePanel: element("desktop-update-panel"),
    updateTitle: element("desktop-update-title"),
    updateMessage: element("desktop-update-message"),
    updateCheckNote: element("desktop-update-check-note"),
    updateDownload: element("desktop-update-download"),
    updateCancel: element("desktop-update-cancel"),
    updateInstall: element("desktop-update-install"),
    updateRetry: element("desktop-update-retry"),
    updateProgressWrap: element("desktop-update-progress-wrap"),
    updateProgress: element("desktop-update-progress"),
    updateProgressText: element("desktop-update-progress-text"),
    updateError: element("desktop-update-error"),
    updateProxy: element("desktop-update-proxy"),
    updateProxyStatus: element("desktop-update-proxy-status"),
    updateProxyToggle: element("desktop-update-proxy-toggle"),
    updateDialogProxy: element("desktop-update-dialog-proxy"),
    updateDialogProxyStatus: element("desktop-update-dialog-proxy-status"),
    updateDialogProxyToggle: element("desktop-update-dialog-proxy-toggle"),
    updateManual: element("desktop-update-manual"),
    updateManualDownload: element("desktop-update-manual-download"),
    updateManualStatus: element("desktop-update-manual-status"),
    updateInstallationHint: element("desktop-update-installation-hint"),
    updateNotesDetails: element("desktop-update-notes-details"),
    updateNotes: element("desktop-update-notes"),
    updateHistory: element("desktop-update-history"),
    updateHistoryMeta: element("desktop-update-history-meta"),
    updateHistoryOutcome: element("desktop-update-history-outcome"),
    updateHistoryAction: element("desktop-update-history-action"),
    updateHistoryDismiss: element("desktop-update-history-dismiss"),
    updateHistoryError: element("desktop-update-history-error"),
    updateDialog: element("desktop-update-dialog"),
    updateDialogTitle: element("desktop-update-dialog-title"),
    updateDialogVersion: element("desktop-update-dialog-version"),
    updateDialogNotes: element("desktop-update-dialog-notes"),
    updateDialogProgressWrap: element("desktop-update-dialog-progress-wrap"),
    updateDialogProgress: element("desktop-update-dialog-progress"),
    updateDialogProgressText: element("desktop-update-dialog-progress-text"),
    updateDialogCheckNote: element("desktop-update-dialog-check-note"),
    updateDialogError: element("desktop-update-dialog-error"),
    updateDialogManual: element("desktop-update-dialog-manual"),
    updateDialogManualActions: element("desktop-update-dialog-manual-actions"),
    updateDialogManualDownload: element("desktop-update-dialog-manual-download"),
    updateDialogManualStatus: element("desktop-update-dialog-manual-status"),
    updateDialogLater: element("desktop-update-dialog-later"),
    updateDialogAction: element("desktop-update-dialog-action"),
    installDialog: element("desktop-install-confirmation"),
    installCurrentVersion: element("desktop-install-current-version"),
    installLatestVersion: element("desktop-install-latest-version"),
    installReplacementTitle: element("desktop-install-replacement-title"),
    installReplacementDescription: element("desktop-install-replacement-description"),
    installDetails: element("desktop-install-details"),
    installTechnicalHint: element("desktop-install-technical-hint"),
    installError: element("desktop-install-confirmation-error"),
    installLater: element("desktop-install-later"),
    installConfirm: element("desktop-install-confirm"),
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
    clearLogin: element("profile-clear-login"),
    clearLoginStatus: element("profile-login-clear-status"),
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
    itemsAll: element("profile-items-all"),
    itemsFailed: element("profile-items-failed"),
    itemsHint: element("profile-items-hint"),
    showMore: element("profile-show-more")
  };

  let snapshot = { status: "idle", items: [] };
  let operationPending = false;
  let initialized = false;
  let visibleItemCount = 100;
  let renderedItemsKey = "";
  let itemFilter = "all";
  let previousFailedCount = 0;
  let unsubscribe = () => {};
  let unsubscribeLogin = () => {};
  let loginRevision = 0;
  let clearLoginPending = false;
  let unsubscribeUpdates = () => {};
  let updateRevision = 0;
  let updateHistoryRevision = 0;
  let updateHistory = null;
  let updateHistoryPending = false;
  let updateState = { status: "idle" };
  let updatePending = null;
  let updateProxyState = { mode: "off", manuallyDisabled: false };
  let updateProxyPending = "";
  let updateProxyRevision = 0;
  let updateProxyMessage = "";
  let updateRequestId = 0;
  let manualInstallerPending = false;
  let manualInstallerMessage = "";
  let manualInstallerFailed = false;
  let manualInstallerContext = "";
  const shownUpdateDialogs = new Set();
  let updateDialogPreviousFocus = null;
  let updateDialogNotesText = null;
  let installConfirmation = null;
  let installConfirmationPending = false;
  let installDecision = null;
  let installReturnFocus = null;
  let requestedInstallFocus = null;
  let installUnderlyingFocus = null;
  let installRestoreUpdateDialog = false;
  let pendingInstallFocus = null;
  let pendingInstallClosures = 0;
  let desktopInfo = {};
  const updatesAvailable = typeof bridge.getUpdateState === "function"
    && typeof bridge.checkForUpdates === "function";
  const proxyControlsAvailable = typeof bridge.getUpdateProxyState === "function"
    && typeof bridge.stopUpdateProxy === "function";

  document.body.classList.add("is-desktop");
  document.title = "Brclio 小红书下载器";
  ui.navigation.hidden = false;
  ui.singlePanel.setAttribute("role", "tabpanel");
  ui.singlePanel.setAttribute("aria-labelledby", "single-note-tab");
  ui.singlePanel.tabIndex = 0;
  const headerStatus = document.querySelector(".header-status");
  headerStatus.setAttribute("aria-label", "运行状态：本地桌面版");
  headerStatus.querySelector("span:last-child").textContent = "本地桌面版";
  document.querySelector(".hero-copy h1").textContent = "单篇笔记，随手保存。";
  document.querySelector(".hero-copy > p").textContent = "粘贴笔记链接或分享文案，解析图片、实况、视频与正文。单篇下载免费。";
  document.querySelector(".footer-brand strong").textContent = "喜欢的内容，保存在你的电脑。";
  document.querySelector("footer > p").textContent = "单篇笔记支持图片、实况 ZIP、视频与文案；主页内容按笔记归档到所选文件夹。";

  const pages = [
    ["single", ui.singleTab, ui.singlePanel],
    ["live", element("live-photo-tab"), element("desktop-live-photo-page")],
    ["profile", ui.profileTab, ui.panel],
    ["account", element("account-tab"), element("desktop-account-page")],
    ["reviews", element("reviews-tab"), element("desktop-reviews-page")],
    ["membership", element("desktop-membership-link"), element("desktop-membership-page")],
    ["feedback", element("feedback-tab"), element("desktop-feedback-page")],
    ["about", element("about-tab"), element("desktop-about-page")],
    ["vip", element("desktop-vip-link"), element("desktop-vip-page")],
    ["learning", element("desktop-learning-link"), element("desktop-learning-page")]
  ];
  for (const [, , page] of pages) page.classList.add("desktop-page");
  element("desktop-about-update-mount").append(ui.updatePanel);
  element("desktop-about-update-actions").append(ui.updateCheck);
  ui.details.open = true;
  let currentPage = "profile";
  let returnFromLearning = "profile";
  const learningFrame = element("desktop-learning-frame");
  const liveFrame = element("desktop-live-photo-frame");
  liveFrame.addEventListener("load", () => {
    const content = liveFrame.contentDocument;
    if (!content?.body) return;
    content.body.classList.add("live-embedded");
    content.addEventListener("click", event => {
      const link = event.target.closest?.("a[href]");
      if (!link) return;
      const target = new URL(link.href);
      if (target.protocol === location.protocol && target.host === location.host
        && ["/", "/index.html"].includes(target.pathname)) {
        event.preventDefault(); navigate("single");
      }
    });
  });
  let learningScroll = null;
  let learningScrollRevision = 0;
  let learningScrollPending = false;

  function restoreLearningScroll(revision) {
    if (!learningScroll || currentPage !== "learning" || !learningFrame.contentDocument?.body?.classList.contains("learning-embedded")) return;
    learningScrollPending = true;
    // Chromium can reset a hidden iframe's viewport before laying it out again,
    // particularly on Windows. Restore after both parent and child are visible.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (revision !== learningScrollRevision || currentPage !== "learning") return;
      learningFrame.contentWindow.scrollTo({ ...learningScroll, behavior: "instant" });
      learningScrollPending = false;
    }));
  }

  learningFrame.addEventListener("load", () => {
    const content = learningFrame.contentDocument;
    if (!content || new URL(content.URL).pathname !== "/learn.html") return;
    content.body.classList.add("learning-embedded");
    content.addEventListener("click", event => {
      const link = event.target.closest?.("a[href]");
      if (!link) return;
      const target = new URL(link.href);
      if (target.protocol === location.protocol && target.host === location.host && ["/", "/index.html"].includes(target.pathname)) {
        event.preventDefault();
        navigate(returnFromLearning);
      }
    });
    restoreLearningScroll(learningScrollRevision);
  });
  const vipFrame = element("desktop-vip-frame");
  let returnFromVip = "profile";
  let vipScroll = null;
  let vipRevision = 0;
  let vipScrollPending = false;
  function restoreVipScroll(revision) {
    if (!vipScroll || currentPage !== "vip" || !vipFrame.contentDocument?.body?.classList.contains("vip-embedded")) return;
    vipScrollPending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (revision !== vipRevision || currentPage !== "vip") return;
      vipFrame.contentWindow.scrollTo({ ...vipScroll, behavior: "instant" });
      vipScrollPending = false;
    }));
  }
  vipFrame.addEventListener("load", () => {
    const content = vipFrame.contentDocument;
    if (!content || new URL(content.URL).pathname !== "/vip.html") return;
    content.body.classList.add("vip-embedded");
    content.addEventListener("click", event => {
      const link = event.target.closest?.("a[href]");
      if (!link) return;
      const target = new URL(link.href);
      if (target.protocol === location.protocol && target.host === location.host && ["/", "/index.html"].includes(target.pathname)) {
        event.preventDefault();
        navigate(returnFromVip);
      }
    });
    restoreVipScroll(vipRevision);
  });
  const membershipFrame = element("desktop-membership-frame");
  let returnFromMembership = "profile";
  let membershipScroll = null;
  let membershipRevision = 0;
  let membershipScrollPending = false;
  function restoreMembershipScroll(revision) {
    if (!membershipScroll || currentPage !== "membership" || !membershipFrame.contentDocument?.body?.classList.contains("membership-embedded")) return;
    membershipScrollPending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (revision !== membershipRevision || currentPage !== "membership") return;
      membershipFrame.contentWindow.scrollTo({ ...membershipScroll, behavior: "instant" });
      membershipScrollPending = false;
    }));
  }
  membershipFrame.addEventListener("load", () => {
    const content = membershipFrame.contentDocument;
    if (!content) return;
    const source = new URL(content.URL);
    if (source.protocol !== location.protocol || source.host !== location.host || source.pathname !== "/membership.html") return;
    content.body.classList.add("membership-embedded");
    content.addEventListener("click", event => {
      if (currentPage !== "membership" || membershipFrame.contentDocument !== content) return;
      const link = event.target.closest?.("a[href]");
      if (!link) return;
      const target = new URL(link.href);
      if (target.protocol !== location.protocol || target.host !== location.host) return;
      if (["/", "/index.html"].includes(target.pathname)) {
        event.preventDefault();
        if (target.searchParams.get("membership") === "open") void openAccountUI({ purchase: true });
        else navigate(returnFromMembership);
      } else {
        const page = { "/vip.html": "vip", "/learn.html": "learning", "/membership.html": "membership" }[target.pathname];
        if (page && !target.hash) { event.preventDefault(); navigate(page); }
      }
    });
    restoreMembershipScroll(membershipRevision);
  });
  let dismissedUpdate = "";
  let announcedUpdate = "";
  const compactNavigation = window.matchMedia("(max-width: 600px)");
  const updateNavigationOrientation = () => {
    ui.navigation.querySelector('[role="tablist"]')
      .setAttribute("aria-orientation", compactNavigation.matches ? "horizontal" : "vertical");
    if (compactNavigation.matches) pages.find(([name]) => name === currentPage)?.[1]
      .scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  updateNavigationOrientation();
  compactNavigation.addEventListener("change", updateNavigationOrientation);
  window.addEventListener("resize", updateNavigationOrientation);
  window.addEventListener("pagehide", () => {
    compactNavigation.removeEventListener("change", updateNavigationOrientation);
    window.removeEventListener("resize", updateNavigationOrientation);
  }, { once: true });

  function selectTab(tab, focus = false) {
    const membershipTab = element("desktop-membership-link");
    const enteringMembership = tab === membershipTab && currentPage !== "membership";
    const leavingMembership = currentPage === "membership" && tab !== membershipTab;
    if (leavingMembership && !membershipScrollPending && membershipFrame.contentDocument?.body?.classList.contains("membership-embedded")) {
      membershipScroll = { left: membershipFrame.contentWindow.scrollX, top: membershipFrame.contentWindow.scrollY };
    }
    if (enteringMembership || leavingMembership) { membershipRevision++; membershipScrollPending = false; }
    if (enteringMembership) returnFromMembership = currentPage;
    const vipTab = element("desktop-vip-link");
    const enteringVip = tab === vipTab && currentPage !== "vip";
    const leavingVip = currentPage === "vip" && tab !== vipTab;
    if (leavingVip && !vipScrollPending && vipFrame.contentDocument?.body?.classList.contains("vip-embedded")) {
      vipScroll = { left: vipFrame.contentWindow.scrollX, top: vipFrame.contentWindow.scrollY };
    }
    if (enteringVip || leavingVip) { vipRevision++; vipScrollPending = false; }
    if (enteringVip) returnFromVip = currentPage;
    const learningTab = element("desktop-learning-link");
    const enteringLearning = tab === learningTab && currentPage !== "learning";
    const leavingLearning = currentPage === "learning" && tab !== learningTab;
    if (leavingLearning && !learningScrollPending) {
      const content = learningFrame.contentWindow;
      if (learningFrame.contentDocument?.body?.classList.contains("learning-embedded")) {
        learningScroll = { left: content.scrollX, top: content.scrollY };
      }
    }
    if (enteringLearning || leavingLearning) {
      learningScrollRevision++;
      learningScrollPending = false;
    }
    if (enteringLearning) returnFromLearning = currentPage;
    for (const [name, candidate, page] of pages) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      page.hidden = !selected;
      if (selected) currentPage = name;
    }
    document.body.dataset.desktopPage = currentPage;
    if (currentPage === "live" && !liveFrame.hasAttribute("src")) liveFrame.src = liveFrame.dataset.src;
    if (currentPage === "membership" && !membershipFrame.hasAttribute("src")) membershipFrame.src = membershipFrame.dataset.src;
    if (currentPage === "vip" && !vipFrame.hasAttribute("src")) vipFrame.src = vipFrame.dataset.src;
    if (currentPage === "learning" && !learningFrame.hasAttribute("src")) learningFrame.src = learningFrame.dataset.src;
    if (currentPage === "about") element("desktop-update-announcement").hidden = true;
    if (currentPage === "feedback") { void loadDiagnostics(); void loadFeedbackList(); }
    if (focus) tab.focus();
    if (compactNavigation.matches) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (enteringVip) restoreVipScroll(vipRevision);
    if (enteringLearning) restoreLearningScroll(learningScrollRevision);
    if (enteringMembership) restoreMembershipScroll(membershipRevision);
  }

  function navigate(page) {
    const selected = pages.find(([name]) => name === page);
    if (selected) selectTab(selected[1], true);
  }
  for (const [, tab] of pages) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = pages.findIndex(([, candidate]) => candidate === tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1
        : (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? pages.length - 1 : 1)) % pages.length;
      selectTab(pages[next][1], true);
    });
  }
  element("desktop-account-shortcut").addEventListener("click", () => navigate("account"));
  element("desktop-feedback-login").addEventListener("click", () => navigate("account"));
  element("desktop-about-feedback").addEventListener("click", () => navigate("feedback"));
  element("desktop-announcement-open").addEventListener("click", () => {
    navigate("about");
    openUpdateDialog();
  });
  element("desktop-announcement-dismiss").addEventListener("click", () => {
    dismissedUpdate = String(updateState.latestVersion || "");
    element("desktop-update-announcement").hidden = true;
  });
  if (typeof bridge.onNavigate === "function") {
    const cleanup = bridge.onNavigate((request) => {
      if (request?.page === "account" && request.purchase === true) void openAccountUI({ purchase: true });
      else navigate(request?.page);
    });
    if (typeof cleanup === "function") window.addEventListener("pagehide", cleanup, { once: true });
  }
  const headerBrand = document.querySelector(".app-header .brand");
  headerBrand.addEventListener("click", (event) => { event.preventDefault(); navigate("single"); });
  selectTab(ui.profileTab);

  // Desktop feedback never reads log files or credentials in the renderer.
  // The main process collects and sanitizes diagnostics before copying/exporting/uploading.
  let softwareAccount = null;
  let feedbackBusy = false;
  let diagnosticsPending = false;
  let diagnosticsOperation = false;
  let accountRevision = 0;
  let feedbackStatus = "idle";
  const feedbackSupported = typeof bridge.submitFeedback === "function";
  const conversationsSupported = ["listFeedback", "getFeedbackDetail", "replyFeedback"].every(method => typeof bridge[method] === "function");
  let feedbackIdentityRevision = 0;
  let feedbackSubmissionRevision = null;
  let feedbackListRequest = 0;
  let feedbackDetailRequest = 0;
  let feedbackListBusy = false;
  let feedbackDetailBusy = false;
  let feedbackReplyBusy = false;
  let selectedFeedbackId = "";
  let feedbackDetailReady = false;
  let currentFeedbackThread = null;
  const feedbackDrafts = new Map();
  const feedbackUserId = () => softwareAccount?.authenticated ? softwareAccount.account?.user?.id || "" : "";
  const feedbackStatusText = (value) => ({ uploading: "日志上传中", new: "待处理", in_progress: "处理中", resolved: "已解决", closed: "已关闭" }[value] || "已提交");
  const dateText = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "—";
  };
  const environmentText = () => {
    const system = { darwin: "macOS", win32: "Windows", linux: "Linux" }[desktopInfo.platform] || desktopInfo.platform || "桌面版";
    return `${system}${desktopInfo.arch ? ` · ${desktopInfo.arch}` : ""}${desktopInfo.version ? ` · v${desktopInfo.version}` : ""}`;
  };
  function renderFeedbackControls() {
    const authenticated = Boolean(feedbackUserId());
    element("desktop-feedback-account-hint").hidden = authenticated;
    element("desktop-feedback-submit").disabled = feedbackBusy || !authenticated || !feedbackSupported;
    element("desktop-feedback-submit").textContent = feedbackBusy ? "正在提交…" : "提交反馈与日志 ↗";
    for (const id of ["desktop-feedback-title", "desktop-feedback-description", "desktop-feedback-category"]) element(id).disabled = feedbackBusy;
    element("desktop-diagnostics-copy").disabled = diagnosticsOperation || typeof bridge.copyDiagnostics !== "function";
    element("desktop-diagnostics-export").disabled = diagnosticsOperation || typeof bridge.exportDiagnostics !== "function";
    element("desktop-diagnostics-refresh").disabled = diagnosticsPending || typeof bridge.getDiagnosticsInfo !== "function";
    if (!feedbackSupported) element("desktop-feedback-request-hint").textContent = "当前运行环境暂不支持在线反馈";
    element("desktop-feedback-refresh").disabled = !authenticated || !conversationsSupported || feedbackListBusy;
    element("desktop-feedback-refresh").textContent = feedbackListBusy ? "正在刷新…" : "刷新反馈";
    element("desktop-feedback-thread-refresh").disabled = !authenticated || feedbackDetailBusy;
    const pending = feedbackDrafts.get(selectedFeedbackId)?.pending;
    element("desktop-feedback-reply").disabled = !authenticated || !feedbackDetailReady || feedbackReplyBusy;
    element("desktop-feedback-reply").readOnly = Boolean(pending);
    element("desktop-feedback-reply-submit").disabled = !authenticated || !feedbackDetailReady || feedbackReplyBusy;
    element("desktop-feedback-reply-submit").textContent = feedbackReplyBusy ? "正在发送…" : pending ? "重试这条回复 ↗" : "发送回复 ↗";
    element("desktop-feedback-reply-hint").textContent = pending ? "保留了原文；重试会确认同一条回复，不会重复发送。" : "最多 8000 字";
  }
  function renderSoftwareAccount(next) {
    if (!next || typeof next !== "object") return;
    const previousUserId = feedbackUserId();
    softwareAccount = next;
    if (previousUserId !== feedbackUserId()) resetFeedbackIdentity();
    const account = next.account;
    element("desktop-account-summary").textContent = next.authenticated ? account?.user?.email || "已登录软件账号" : "登录软件账号";
    const membership = account?.membership;
    element("desktop-account-summary-status").textContent = !next.authenticated ? "查看会员与设备授权"
      : !next.verified ? "授权状态待刷新" : membership?.type === "permanent" ? "永久会员"
        : membership?.active ? "有效期会员" : membership?.type === "duration" ? "会员已到期" : "普通用户";
    renderFeedbackControls();
    if (previousUserId !== feedbackUserId() && currentPage === "feedback") void loadFeedbackList();
  }
  function feedbackNotice(id, message, error = false) {
    const node = element(id); node.textContent = message; node.dataset.status = error ? "error" : "idle";
  }
  function resetFeedbackIdentity() {
    feedbackIdentityRevision += 1; feedbackListRequest += 1; feedbackDetailRequest += 1;
    feedbackListBusy = false; feedbackDetailBusy = false; feedbackReplyBusy = false; feedbackBusy = false;
    feedbackSubmissionRevision = null; selectedFeedbackId = ""; feedbackDetailReady = false; currentFeedbackThread = null; feedbackDrafts.clear();
    element("desktop-feedback-list").replaceChildren();
    element("desktop-feedback-detail").hidden = true;
    for (const id of ["desktop-feedback-detail-title", "desktop-feedback-detail-meta", "desktop-feedback-question", "desktop-feedback-thread-status"]) element(id).textContent = "";
    element("desktop-feedback-messages").replaceChildren();
    for (const id of ["desktop-feedback-title", "desktop-feedback-description", "desktop-feedback-reply"]) element(id).value = "";
    element("desktop-feedback-result").hidden = true; element("desktop-feedback-result").textContent = "";
    element("desktop-feedback-progress-wrap").hidden = true; element("desktop-feedback-progress-text").textContent = "";
    feedbackNotice("desktop-feedback-list-status", feedbackUserId() ? "点击刷新反馈查看对话。" : "登录后可查看自己的反馈和回复。");
  }
  function renderFeedbackList(feedbacks) {
    const fragment = document.createDocumentFragment();
    for (const feedback of feedbacks) {
      const button = document.createElement("button"); button.type = "button"; button.className = "desktop-feedback-list-item";
      button.dataset.feedbackId = feedback.id; button.setAttribute("aria-current", String(feedback.id === selectedFeedbackId));
      const title = document.createElement("strong"); title.textContent = feedback.title || "未命名反馈";
      const summary = document.createElement("span");
      summary.textContent = `${feedbackStatusText(feedback.status)} · ${count(feedback.replyCount)} 条回复${feedback.lastMessageRole === "admin" ? " · 管理员已回复" : ""}\n${dateText(feedback.lastMessageAt || feedback.createdAt)}`;
      button.append(title, summary); button.addEventListener("click", () => void loadFeedbackDetail(feedback.id)); fragment.append(button);
    }
    element("desktop-feedback-list").replaceChildren(fragment);
  }
  async function loadFeedbackList({ selectFirst = true } = {}) {
    if (!feedbackUserId()) return;
    if (!conversationsSupported) { feedbackNotice("desktop-feedback-list-status", "当前版本暂不支持反馈对话，请更新软件。"); return; }
    const identity = feedbackIdentityRevision, request = ++feedbackListRequest;
    feedbackListBusy = true; renderFeedbackControls();
    feedbackNotice("desktop-feedback-list-status", "正在读取我的反馈…");
    try {
      const result = await bridge.listFeedback();
      if (identity !== feedbackIdentityRevision || request !== feedbackListRequest) return;
      if (result?.ok === false || !Array.isArray(result?.feedbacks)) throw new Error(result?.error?.message || "暂时无法读取反馈列表。");
      renderFeedbackList(result.feedbacks);
      feedbackNotice("desktop-feedback-list-status", result.feedbacks.length ? `共 ${count(result.total ?? result.feedbacks.length)} 条反馈` : "还没有反馈，遇到问题可在下方提交。");
      if (selectFirst && !selectedFeedbackId && result.feedbacks.length) void loadFeedbackDetail(result.feedbacks[0].id);
    } catch (error) {
      if (identity === feedbackIdentityRevision && request === feedbackListRequest) feedbackNotice("desktop-feedback-list-status", error?.message || "读取失败，请刷新重试。", true);
    } finally {
      if (identity === feedbackIdentityRevision && request === feedbackListRequest) { feedbackListBusy = false; renderFeedbackControls(); }
    }
  }
  function renderFeedbackThread(result) {
    currentFeedbackThread = result;
    const feedback = result.feedback;
    element("desktop-feedback-detail-title").textContent = feedback.title || "反馈对话";
    element("desktop-feedback-detail-meta").textContent = `${feedbackStatusText(feedback.status)} · ${dateText(feedback.createdAt)} · ${feedback.id}`;
    element("desktop-feedback-question").textContent = feedback.description || "";
    const fragment = document.createDocumentFragment();
    for (const message of result.messages) {
      const article = document.createElement("article"); article.className = "desktop-feedback-message"; article.dataset.role = message.authorRole; article.dataset.messageId = message.id;
      const meta = document.createElement("p"); meta.className = "desktop-feedback-message-meta"; meta.textContent = `${message.authorRole === "admin" ? "管理员" : "我"} · ${dateText(message.createdAt)}`;
      const content = document.createElement("p"); content.className = "desktop-feedback-message-content"; content.textContent = message.content;
      article.append(meta, content); fragment.append(article);
    }
    element("desktop-feedback-messages").replaceChildren(fragment);
    feedbackDetailReady = Boolean(feedback.submittedAt) && feedback.status !== "uploading";
    feedbackNotice("desktop-feedback-thread-status", !feedbackDetailReady ? "原问题的日志尚未上传完成，请使用相同内容重新提交以继续上传。"
      : !result.messages.length ? "暂时还没有回复，可以在下方补充问题。" : "");
  }
  async function loadFeedbackDetail(feedbackId) {
    if (!feedbackUserId() || !conversationsSupported || !feedbackId) return;
    const identity = feedbackIdentityRevision, request = ++feedbackDetailRequest;
    if (selectedFeedbackId !== feedbackId) {
      selectedFeedbackId = feedbackId; feedbackDetailReady = false; currentFeedbackThread = null;
      element("desktop-feedback-detail-title").textContent = "正在读取对话…";
      element("desktop-feedback-detail-meta").textContent = ""; element("desktop-feedback-question").textContent = "";
      element("desktop-feedback-messages").replaceChildren();
      element("desktop-feedback-reply").value = feedbackDrafts.get(feedbackId)?.content || "";
    }
    element("desktop-feedback-detail").hidden = false;
    for (const button of element("desktop-feedback-list").children) button.setAttribute("aria-current", String(button.dataset.feedbackId === feedbackId));
    feedbackDetailBusy = true; renderFeedbackControls(); feedbackNotice("desktop-feedback-thread-status", "正在刷新对话…");
    try {
      const result = await bridge.getFeedbackDetail(feedbackId);
      if (identity !== feedbackIdentityRevision || request !== feedbackDetailRequest) return;
      if (result?.ok === false || result?.feedback?.id !== feedbackId || !Array.isArray(result?.messages)) throw new Error(result?.error?.message || "暂时无法读取反馈对话。");
      renderFeedbackThread(result);
      return true;
    } catch (error) {
      if (identity === feedbackIdentityRevision && request === feedbackDetailRequest) feedbackNotice("desktop-feedback-thread-status", error?.message || "读取失败，请刷新重试。", true);
      return false;
    } finally {
      if (identity === feedbackIdentityRevision && request === feedbackDetailRequest) { feedbackDetailBusy = false; renderFeedbackControls(); }
    }
  }
  async function loadDiagnostics() {
    if (diagnosticsPending) return;
    if (typeof bridge.getDiagnosticsInfo !== "function") {
      element("desktop-diagnostics-files").textContent = "当前运行环境暂不支持";
      renderFeedbackControls();
      return;
    }
    diagnosticsPending = true;
    renderFeedbackControls();
    try {
      const result = await bridge.getDiagnosticsInfo();
      if (result?.ok === false) throw new Error(result.error?.message || result.message || "暂时无法读取日志概况。");
      element("desktop-diagnostics-files").textContent = `${count(result.fileCount)} 个文件 · ${updateBytes(result.totalBytes)}`;
      element("desktop-diagnostics-range").textContent = result.oldestAt ? `${dateText(result.oldestAt)} 至 ${dateText(result.newestAt)}` : "尚无可用日志";
      element("desktop-diagnostics-summary").textContent = `${result.summary || "日志不包含小红书 Cookie、登录凭据和下载文件内容。"}${result.truncated ? " 当前记录已轮转，早于上述时间的历史不包含在本次提交中。" : " 本次附带当前保留的全部诊断记录。"}`;
      element("desktop-diagnostics-environment").textContent = environmentText();
      element("desktop-diagnostics-result").textContent = "";
    } catch (error) {
      element("desktop-diagnostics-files").textContent = "暂时无法读取";
      element("desktop-diagnostics-result").textContent = error?.message || "读取日志失败，请稍后重试。";
    } finally { diagnosticsPending = false; renderFeedbackControls(); }
  }
  async function diagnosticsAction(method) {
    if (diagnosticsOperation || typeof bridge[method] !== "function") return;
    diagnosticsOperation = true;
    renderFeedbackControls();
    element("desktop-diagnostics-result").textContent = "正在整理诊断信息…";
    try {
      const result = await bridge[method]();
      if (result?.cancelled) element("desktop-diagnostics-result").textContent = "已取消导出。";
      else if (result?.ok === false) throw new Error(result.error?.message || result.message || "操作未完成，请重试。");
      else element("desktop-diagnostics-result").textContent = result?.message || (method === "copyDiagnostics" ? "诊断信息已复制。" : "日志文件已导出。");
    } catch (error) { element("desktop-diagnostics-result").textContent = error?.message || "诊断操作失败，请重试。"; }
    finally { diagnosticsOperation = false; renderFeedbackControls(); }
  }
  function renderFeedbackState(next) {
    if (!next || typeof next !== "object") return;
    feedbackStatus = next.status || "idle";
    const active = ["collecting", "uploading"].includes(feedbackStatus);
    element("desktop-feedback-progress-wrap").hidden = !active;
    const progress = Math.max(0, Math.min(100, Number(next.progress) || 0));
    element("desktop-feedback-progress").value = progress;
    const uploading = feedbackStatus === "uploading";
    element("desktop-feedback-progress-text").textContent = next.message || (uploading
      ? `正在上传 ${updateBytes(next.uploadedBytes)} / ${updateBytes(next.totalBytes)} · ${Math.round(progress)}%`
      : "正在整理当前保留的诊断日志…");
    element("desktop-feedback-progress").setAttribute("aria-valuetext", element("desktop-feedback-progress-text").textContent);
    if (feedbackStatus === "submitted") {
      const result = element("desktop-feedback-result"); result.hidden = false; result.dataset.status = "success";
      result.textContent = `反馈已提交${next.feedbackId ? `，编号 ${next.feedbackId}` : ""}。可在「我的反馈」查看回答并继续回复。`;
    } else if (feedbackStatus === "error") {
      const result = element("desktop-feedback-result"); result.hidden = false; result.dataset.status = "error";
      result.textContent = next.error?.message || next.message || "反馈未能确认提交，请保留描述并重试。";
    }
  }
  element("desktop-diagnostics-refresh").addEventListener("click", () => void loadDiagnostics());
  element("desktop-diagnostics-copy").addEventListener("click", () => void diagnosticsAction("copyDiagnostics"));
  element("desktop-diagnostics-export").addEventListener("click", () => void diagnosticsAction("exportDiagnostics"));
  element("desktop-feedback-refresh").addEventListener("click", () => {
    void loadFeedbackList(); if (selectedFeedbackId) void loadFeedbackDetail(selectedFeedbackId);
  });
  element("desktop-feedback-thread-refresh").addEventListener("click", () => void loadFeedbackDetail(selectedFeedbackId));
  element("desktop-feedback-reply").addEventListener("input", () => {
    if (!selectedFeedbackId || feedbackDrafts.get(selectedFeedbackId)?.pending) return;
    feedbackDrafts.set(selectedFeedbackId, { content: element("desktop-feedback-reply").value });
  });
  element("desktop-feedback-reply-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (feedbackReplyBusy || !feedbackUserId() || !feedbackDetailReady || !selectedFeedbackId || !conversationsSupported) return;
    const identity = feedbackIdentityRevision, feedbackId = selectedFeedbackId;
    const draft = feedbackDrafts.get(feedbackId) || { content: element("desktop-feedback-reply").value };
    if (!draft.content.trim() || draft.content.length > 8000) { feedbackNotice("desktop-feedback-thread-status", "回复内容需为 1–8000 字。", true); return; }
    if (!draft.pending) draft.pending = { feedbackId, content: draft.content, requestId: crypto.randomUUID() };
    feedbackDrafts.set(feedbackId, draft); feedbackReplyBusy = true; renderFeedbackControls();
    feedbackNotice("desktop-feedback-thread-status", "正在保存回复…");
    try {
      const result = await bridge.replyFeedback(draft.pending);
      if (identity !== feedbackIdentityRevision) return;
      if (result?.ok === false || !result?.message?.id) throw new Error(result?.error?.message || "回复尚未确认保存，请重试。");
      feedbackDrafts.delete(feedbackId);
      if (selectedFeedbackId === feedbackId) {
        element("desktop-feedback-reply").value = "";
        if (currentFeedbackThread?.feedback.id === feedbackId) {
          const messages = currentFeedbackThread.messages.filter(message => message.id !== result.message.id);
          renderFeedbackThread({ feedback: result.feedback || currentFeedbackThread.feedback, messages: [...messages, result.message] });
        }
        const refreshed = await loadFeedbackDetail(feedbackId);
        if (refreshed === false && identity === feedbackIdentityRevision && selectedFeedbackId === feedbackId) feedbackNotice("desktop-feedback-thread-status", "回复已保存，但对话刷新失败。请稍后刷新对话查看最新进展。", true);
      }
      void loadFeedbackList({ selectFirst: false });
    } catch (error) {
      if (identity === feedbackIdentityRevision && selectedFeedbackId === feedbackId) feedbackNotice("desktop-feedback-thread-status", `${error?.message || "回复尚未确认保存。"} 原文已保留，请重试这条回复。`, true);
    } finally {
      if (identity === feedbackIdentityRevision) { feedbackReplyBusy = false; renderFeedbackControls(); }
    }
  });
  element("desktop-feedback-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (feedbackBusy || !element("desktop-feedback-form").reportValidity()) return;
    if (!softwareAccount?.authenticated) { navigate("account"); return; }
    if (!feedbackSupported) return;
    const input = { title: element("desktop-feedback-title").value, description: element("desktop-feedback-description").value, category: element("desktop-feedback-category").value };
    if (input.title.trim().length < 3 || input.description.trim().length < 10) {
      renderFeedbackState({ status: "error", message: "标题至少 3 个字，详细描述至少 10 个字。" }); return;
    }
    const identity = feedbackIdentityRevision;
    feedbackSubmissionRevision = identity;
    feedbackBusy = true; renderFeedbackControls(); element("desktop-feedback-result").hidden = true;
    renderFeedbackState({ status: "collecting" });
    try {
      const result = await bridge.submitFeedback(input);
      if (identity !== feedbackIdentityRevision) return;
      if (!result?.ok) throw new Error(result?.error?.message || "反馈未能确认提交，请重试。");
      renderFeedbackState({ status: "submitted", feedbackId: result.feedbackId });
      if (conversationsSupported && result.feedbackId) {
        void loadFeedbackList({ selectFirst: false });
        await loadFeedbackDetail(result.feedbackId);
        if (identity === feedbackIdentityRevision) element("desktop-feedback-detail").scrollIntoView({ block: "nearest" });
      }
    } catch (error) { if (identity === feedbackIdentityRevision) renderFeedbackState({ status: "error", message: error?.message }); }
    finally { if (identity === feedbackIdentityRevision) { feedbackBusy = false; feedbackSubmissionRevision = null; renderFeedbackControls(); } }
  });
  if (typeof bridge.onFeedbackState === "function") {
    const cleanup = bridge.onFeedbackState(next => {
      if (feedbackBusy && feedbackSubmissionRevision === feedbackIdentityRevision && (!next?.userId || next.userId === feedbackUserId())) renderFeedbackState(next);
    });
    if (typeof cleanup === "function") window.addEventListener("pagehide", cleanup, { once: true });
  }
  if (typeof bridge.onAccountUpdate === "function") {
    const cleanup = bridge.onAccountUpdate((next) => { accountRevision += 1; renderSoftwareAccount(next); });
    if (typeof cleanup === "function") window.addEventListener("pagehide", cleanup, { once: true });
  }
  if (typeof bridge.getAccountState === "function") {
    const requested = accountRevision;
    void bridge.getAccountState().then((next) => { if (requested === accountRevision) renderSoftwareAccount(next); }).catch(() => renderFeedbackControls());
  }
  renderFeedbackControls();

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

  function showClearLoginStatus(message, status = "idle") {
    ui.clearLoginStatus.textContent = message || "";
    ui.clearLoginStatus.hidden = !message;
    ui.clearLoginStatus.dataset.status = status;
    ui.clearLoginStatus.setAttribute("role", status === "error" ? "alert" : "status");
    ui.clearLoginStatus.setAttribute("aria-live", status === "error" ? "assertive" : "polite");
  }

  async function clearXhsLogin() {
    if (operationPending || !initialized) return;
    if (typeof bridge.clearXhsLogin !== "function") {
      showClearLoginStatus("当前版本暂不支持清除登录记录，请更新软件。", "error");
      return;
    }
    operationPending = true;
    clearLoginPending = true;
    showError("");
    showClearLoginStatus("正在等待确认或清除登录记录……", "pending");
    updateControls();
    try {
      const result = await bridge.clearXhsLogin();
      if (result?.cancelled) {
        showClearLoginStatus("");
        return;
      }
      if (result?.loginState?.status !== "logged-out" || result.loginState.loggedIn !== false) {
        throw new Error("暂时无法确认登录记录已清除，请重试。");
      }
      // Invalidate the account snapshot requested during initialization so it
      // cannot restore the previous account after this successful reset.
      loginRevision += 1;
      renderLoginState(result.loginState);
      if (result.profileState && typeof result.profileState.status === "string") render(result.profileState);
      showClearLoginStatus(result.message || "小红书登录记录已清除，可重新登录其他账号。", "success");
    } catch (error) {
      showClearLoginStatus(error?.message || "清除登录记录失败，请稍后重试。", "error");
    } finally {
      clearLoginPending = false;
      operationPending = false;
      updateControls();
    }
  }

  function openUpdateDialog() {
    if (!ui.updateDialog || ui.installDialog?.open || !updateState.latestVersion
      || !["available", "downloading", "downloaded", "installing", "error"].includes(updateState.status)) return;
    if (!ui.updateDialog.open) {
      updateDialogPreviousFocus = document.activeElement;
      ui.updateDialog.showModal();
    }
    shownUpdateDialogs.add(String(updateState.latestVersion));
  }

  function closeUpdateDialog() {
    // Consume this dialog's focus before close queues its asynchronous event.
    // That event must not steal focus from a subsequent installation dialog.
    const previous = updateDialogPreviousFocus;
    updateDialogPreviousFocus = null;
    if (ui.updateDialog?.open) ui.updateDialog.close();
    if (!ui.installDialog?.open && previous?.isConnected && previous.getClientRects().length && !previous.disabled) {
      previous.focus({ preventScroll: true });
    }
  }

  function closeInstallConfirmation(restore = true) {
    const returnFocus = installReturnFocus;
    const underlyingFocus = installUnderlyingFocus;
    const reopenUpdate = installRestoreUpdateDialog;
    installConfirmation = null;
    installConfirmationPending = false;
    installDecision = null;
    installReturnFocus = null;
    installUnderlyingFocus = null;
    installRestoreUpdateDialog = false;
    if (ui.installDialog?.open) {
      pendingInstallClosures++;
      ui.installDialog.close();
    }
    if (restore && reopenUpdate) {
      openUpdateDialog();
      updateDialogPreviousFocus = underlyingFocus;
    }
    pendingInstallFocus = restore && (!reopenUpdate || ui.updateDialog?.open) ? returnFocus : underlyingFocus;
    restoreInstallFocus();
  }

  function restoreInstallFocus() {
    // Either the close event or the pending install invocation can finish
    // first. Wait for both, so native focus restoration and disabled controls
    // cannot overwrite our return focus on a later task or animation frame.
    if (!pendingInstallFocus || ui.installDialog?.open || pendingInstallClosures || updatePending === "install") return;
    if (!pendingInstallFocus.isConnected) { pendingInstallFocus = null; return; }
    if (!pendingInstallFocus.getClientRects().length || pendingInstallFocus.disabled) return;
    pendingInstallFocus.focus({ preventScroll: true });
    if (document.activeElement === pendingInstallFocus) pendingInstallFocus = null;
  }

  function showInstallConfirmation(request) {
    if (!ui.installDialog || !request || typeof request.id !== "string" || !request.id
      || typeof bridge.respondInstallConfirmation !== "function") return;
    if (installConfirmation?.id === request.id) return;
    if (installConfirmation) {
      void bridge.respondInstallConfirmation(installConfirmation.id, false).catch(() => {});
      closeInstallConfirmation(false);
    }
    installConfirmation = request;
    installConfirmationPending = false;
    installDecision = null;
    installReturnFocus = requestedInstallFocus?.isConnected ? requestedInstallFocus : document.activeElement;
    requestedInstallFocus = null;
    installRestoreUpdateDialog = Boolean(ui.updateDialog?.open);
    installUnderlyingFocus = installRestoreUpdateDialog ? updateDialogPreviousFocus : installReturnFocus;
    closeUpdateDialog();
    ui.installCurrentVersion.textContent = request.currentVersion ? `v${request.currentVersion}` : "当前版本";
    ui.installLatestVersion.textContent = request.latestVersion ? `v${request.latestVersion}` : "新版本";
    const portable = request.platform === "win32" && request.portable;
    ui.installReplacementTitle.textContent = portable ? "安装新版客户端" : "原位置替换客户端";
    ui.installReplacementDescription.textContent = portable ? "安装正式版，之后请使用新版快捷方式。"
      : request.platform === "darwin" ? "新版成功启动后，自动清理旧客户端备份。" : "覆盖当前安装版本，无需保留旧客户端。";
    ui.installDetails.open = false;
    ui.installTechnicalHint.textContent = String(request.installationHint || "安装期间会短暂退出应用，请等待更新完成。");
    ui.installError.hidden = true;
    ui.installError.textContent = "";
    ui.installLater.disabled = false;
    ui.installConfirm.disabled = false;
    ui.installConfirm.textContent = "安装并重启";
    ui.installDialog.showModal();
    ui.installLater.focus({ preventScroll: true });
  }

  async function respondInstallConfirmation(confirmed) {
    if (!installConfirmation || installConfirmationPending) return;
    const request = installConfirmation;
    installConfirmationPending = true;
    installDecision = confirmed;
    ui.installLater.disabled = true;
    ui.installConfirm.disabled = true;
    ui.installConfirm.textContent = confirmed ? "正在准备…" : "安装并重启";
    ui.installError.hidden = true;
    try {
      const accepted = await bridge.respondInstallConfirmation(request.id, confirmed);
      if (installConfirmation?.id !== request.id) return;
      if (accepted || !confirmed) closeInstallConfirmation(!confirmed);
      else {
        ui.installError.textContent = "安装确认已失效，请关闭后重新点击安装更新。";
        ui.installError.hidden = false;
      }
    } catch {
      if (installConfirmation?.id !== request.id) return;
      if (!confirmed) closeInstallConfirmation();
      else {
        ui.installError.textContent = "暂时无法确认安装，请稍后重试。";
        ui.installError.hidden = false;
      }
    } finally {
      if (installConfirmation?.id === request.id) {
        installConfirmationPending = false;
        installDecision = null;
        ui.installLater.disabled = false;
        ui.installConfirm.disabled = false;
        ui.installConfirm.textContent = "安装并重启";
      }
    }
  }

  function renderUpdateDialogNotes(notes) {
    if (updateDialogNotesText === notes) return;
    updateDialogNotesText = notes;
    ui.updateDialogNotes.replaceChildren();
    const plain = value => value.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|`)(.*?)\1/g, "$2");
    let lines = (notes || "此版本暂未提供更新说明。").split(/\r?\n/);
    const updateSection = lines.findIndex(line => /^\s{0,3}##\s+本次更新(?:\s+#+)?\s*$/.test(line));
    if (updateSection >= 0) {
      const nextSection = lines.findIndex((line, index) => index > updateSection && /^\s{0,3}#{1,2}\s+/.test(line));
      const contents = lines.slice(updateSection + 1, nextSection < 0 ? lines.length : nextSection);
      if (contents.some(line => line.trim())) lines = [lines[updateSection], ...contents];
    }
    let list = null;
    for (const line of lines) {
      if (!line.trim()) { list = null; continue; }
      const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
      const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
      if (bullet) {
        if (!list) { list = document.createElement("ul"); ui.updateDialogNotes.append(list); }
        const item = document.createElement("li");
        item.textContent = plain(bullet[1]);
        list.append(item);
      } else {
        list = null;
        const block = document.createElement(heading ? "h3" : "p");
        block.textContent = plain(heading ? heading[1] : line.trim());
        ui.updateDialogNotes.append(block);
      }
    }
  }

  function renderUpdateProxy(next) {
    if (next && typeof next === "object") updateProxyState = next;
    const disabled = updateProxyState.manuallyDisabled === true;
    const message = updateProxyMessage || (disabled
      ? "已手动关闭内置升级代理。下次点击检查更新或下载安装包时自动启用，完成后自动关闭。"
      : {
        system: "使用系统代理，内置升级代理未启动。",
        starting: "正在启动内置升级代理，遇到问题可手动关闭。",
        internal: "内置升级代理正在运行，仅用于软件更新。",
        error: "内置升级代理启动未完成，可关闭后重新检查更新。",
        off: "内置升级代理未运行；仅在检查更新、下载安装包时自动启用。"
      }[updateProxyState.mode] || "正在读取升级代理状态…");
    for (const container of [ui.updateProxy, ui.updateDialogProxy]) {
      if (container) container.hidden = !proxyControlsAvailable;
    }
    for (const status of [ui.updateProxyStatus, ui.updateDialogProxyStatus]) {
      if (status) status.textContent = message;
    }
    for (const button of [ui.updateProxyToggle, ui.updateDialogProxyToggle]) {
      if (!button) continue;
      button.disabled = Boolean(updateProxyPending) || !proxyControlsAvailable;
      button.textContent = updateProxyPending ? "正在关闭…" : "关闭软件内置代理";
      button.setAttribute("aria-busy", String(Boolean(updateProxyPending)));
    }
  }

  async function toggleUpdateProxy() {
    if (updateProxyPending || !proxyControlsAvailable) return;
    const requestedRevision = updateProxyRevision;
    updateProxyPending = "stop";
    updateProxyMessage = "";
    renderUpdateProxy();
    try {
      const next = await bridge.stopUpdateProxy();
      if (updateProxyRevision === requestedRevision) {
        updateProxyRevision++;
        renderUpdateProxy(next);
      }
    } catch {
      updateProxyMessage = "暂时无法关闭内置升级代理，请重试。";
    } finally {
      updateProxyPending = "";
      renderUpdateProxy();
    }
  }

  function renderManualInstaller() {
    const show = updateState.status === "error" && updateState.error?.phase === "install";
    const context = show ? JSON.stringify([updateState.latestVersion, updateState.error]) : "";
    if (manualInstallerContext !== context) {
      manualInstallerContext = context;
      manualInstallerMessage = "";
      manualInstallerFailed = false;
    }
    ui.updateManual.hidden = !show;
    ui.updateDialogManual.hidden = !show;
    ui.updateDialogManualActions.hidden = !show;
    ui.updateDialogNotes.hidden = show;
    const guidance = desktopInfo.platform === "win32" && desktopInfo.portable
      ? "下载后先退出旧版，运行安装包安装正式版，之后从新版快捷方式启动。旧便携文件不会自动删除。"
      : "下载后先退出旧版，再将新版安装到原位置并覆盖。";
    for (const container of [ui.updateManual, ui.updateDialogManual]) {
      container.querySelector("[data-manual-install-guidance]").textContent = guidance;
    }
    for (const button of [ui.updateManualDownload, ui.updateDialogManualDownload]) {
      button.disabled = manualInstallerPending;
      button.textContent = manualInstallerPending ? "正在获取安装包…" : "手动下载安装包";
      button.setAttribute("aria-busy", String(manualInstallerPending));
    }
    for (const message of [ui.updateManualStatus, ui.updateDialogManualStatus]) {
      message.hidden = !manualInstallerMessage;
      message.textContent = manualInstallerMessage;
      message.dataset.status = manualInstallerFailed ? "error" : "success";
    }
  }

  async function openManualInstaller() {
    if (manualInstallerPending || updateState.status !== "error" || updateState.error?.phase !== "install") return;
    const context = manualInstallerContext;
    manualInstallerPending = true;
    manualInstallerMessage = "";
    manualInstallerFailed = false;
    renderManualInstaller();
    try {
      const result = await bridge.openLatestInstaller();
      if (context !== manualInstallerContext) return;
      if (!result?.ok) {
        manualInstallerFailed = true;
        manualInstallerMessage = `未能打开安装包下载：${result?.error?.message || "暂时无法获取安装包，请稍后重试。"}`;
        return;
      }
      manualInstallerMessage = `已请求默认浏览器下载${result.version ? ` v${result.version}` : "最新版本"} 安装包，请查看浏览器下载进度。下载完成后再退出旧版并安装。`;
    } catch {
      if (context !== manualInstallerContext) return;
      manualInstallerFailed = true;
      manualInstallerMessage = "未能打开安装包下载：请检查网络和默认浏览器设置后重试。";
    } finally {
      manualInstallerPending = false;
      renderManualInstaller();
    }
  }

  function renderUpdateDialog(next, { status, version, failedPhase, mayRetry, canResume, savedProgress, percent, progressText, notes, checkNote, retryText, errorText }) {
    if (!ui.updateDialog) return;
    ui.updateDialog.dataset.status = status;
    if (["idle", "up-to-date"].includes(status)) { closeUpdateDialog(); return; }
    ui.updateDialogTitle.textContent = status === "downloaded" ? "新版本已准备好"
      : status === "installing" ? "正在安装更新" : status === "checking" ? "正在检查更新"
        : status === "error" ? "更新未完成" : retryText ? "正在自动重试下载" : "发现新版本";
    ui.updateDialogVersion.textContent = `${next.latestVersion ? `v${next.latestVersion}` : "新版本"}${version ? ` · 当前版本 v${version}` : ""}`;
    renderUpdateDialogNotes(notes);
    const showProgress = status === "downloading" || savedProgress;
    const showInstallMessage = status === "downloaded" || status === "installing";
    ui.updateDialogProgressWrap.hidden = !showProgress && !showInstallMessage;
    ui.updateDialogProgress.hidden = !showProgress;
    if (percent === null) ui.updateDialogProgress.removeAttribute("value");
    else ui.updateDialogProgress.value = percent;
    const message = status === "installing" ? "确认安装后会显示独立的安装进度窗口，完成后自动重新打开软件。"
      : status === "downloaded" ? "安装完成后会自动重新打开软件。"
        : retryText ? `${progressText} · ${retryText}`
          : savedProgress ? `${progressText} · 进度已保存` : progressText;
    ui.updateDialogProgressText.textContent = message;
    ui.updateDialogProgress.setAttribute("aria-valuetext", message);
    ui.updateDialogCheckNote.hidden = !checkNote;
    ui.updateDialogCheckNote.textContent = checkNote;
    ui.updateDialogError.hidden = status !== "error";
    ui.updateDialogError.textContent = status === "error" ? errorText : "";
    ui.updateDialogLater.textContent = status === "downloading" ? "后台下载" : "稍后再说";
    let action = "", label = "立即更新";
    if (status === "downloading") { action = "cancel"; label = updatePending === "cancel" ? "正在暂停…" : "暂停下载"; }
    else if (status === "downloaded") { action = "install"; label = "安装并重启"; }
    else if (status === "available") { action = "download"; label = canResume ? "继续下载" : "立即更新"; }
    else if (status === "error" && mayRetry) {
      action = failedPhase;
      label = failedPhase === "download" ? canResume ? "继续下载" : "重试下载"
        : failedPhase === "install" ? "重试安装" : "重新检查";
    } else if (status === "installing") label = "正在安装…";
    else if (status === "checking") label = "正在检查…";
    ui.updateDialogAction.dataset.action = action;
    ui.updateDialogAction.textContent = label;
    ui.updateDialogAction.disabled = !action || (action === "cancel" ? updatePending === "cancel" : Boolean(updatePending));
    if (status === "available" && next.latestVersion && !shownUpdateDialogs.has(String(next.latestVersion))) openUpdateDialog();
  }

  function renderUpdateState(next) {
    if (!next || typeof next !== "object") return;
    updateState = next;
    const status = next.status || "idle";
    if (installConfirmation && status !== "installing") closeInstallConfirmation(installDecision !== true);
    const version = String(next.currentVersion || desktopInfo.version || "");
    const latest = next.latestVersion ? `v${next.latestVersion}` : "新版本";
    const checkNote = status === "available" && next.checkError
      ? `暂时无法检查最新版本，仍可下载已发现的 ${latest}。` : "";
    ui.updateCheckNote.hidden = !checkNote;
    ui.updateCheckNote.textContent = checkNote;
    const failed = status === "error";
    const failedPhase = ["check", "download", "install"].includes(next.error?.phase) ? next.error.phase : "check";
    renderManualInstaller();
    const mayRetry = next.canRetry !== false;
    const received = count(next.download?.receivedBytes);
    const total = count(next.download?.totalBytes);
    const canResume = next.download?.canResume === true && received > 0;
    const savedProgress = canResume && (status === "available" || (failed && failedPhase === "download"));
    const retryFailures = count(next.retry?.consecutiveFailures);
    const retryLimit = count(next.retry?.limit) || 10;
    const retrying = status === "downloading" && next.retry?.active === true;
    const retryExhausted = failed && failedPhase === "download" && next.retry?.active === false && retryFailures >= retryLimit;
    const retryText = retrying ? `内置代理自动重试中（连续失败 ${retryFailures}/${retryLimit} 次）` : "";
    const exhaustedText = retryExhausted
      ? `连续失败 ${retryFailures} 次，自动重试已停止。点击“${canResume ? "继续下载" : "重试下载"}”重试。` : "";
    const lastErrorText = String(next.error?.message || next.retry?.lastError?.message || "操作未完成，请稍后重试。");
    const errorText = exhaustedText ? `${exhaustedText} ${lastErrorText}` : lastErrorText;
    const busy = Boolean(updatePending) || ["checking", "downloading", "installing"].includes(status);
    if (version) ui.version.textContent = `本地版 v${version}`;
    ui.updateCheck.disabled = !updatesAvailable || busy;
    ui.updateCheck.textContent = status === "checking" || updatePending === "check" ? "正在检查…" : "检查更新";
    ui.updateCheck.title = updatesAvailable ? "检查是否有新的本地版安装包" : "请手动安装带有更新功能的新版本";
    ui.updatePanel.hidden = false;
    ui.updatePanel.dataset.status = status;

    const text = {
      idle: ["应用更新", "点击“检查更新”，查看是否有新的安装包。"],
      checking: ["正在检查更新", "稍等片刻，检查完成后会在这里显示结果。"],
      "up-to-date": ["当前已是最新版本", version ? `你正在使用 v${version}。` : "暂时没有发现更新。"],
      available: [`发现新版本 ${latest}`, savedProgress ? "已保存下载进度，点击“继续下载”即可接着下载。" : "可以继续使用当前版本，准备好后再下载更新。"],
      downloading: [retrying ? `正在自动重试下载 ${latest}` : `正在下载 ${latest}`, retryText ? `${retryText}；已下载的进度会保留，可以随时暂停。` : "下载期间可以继续使用应用，也可以随时暂停；已下载的进度会保留。"],
      downloaded: [`${latest} 已准备好安装`, "确认后将暂停当前任务并开始安装更新，请先保存正在编辑的内容。"],
      installing: ["正在准备安装更新", "请在确认窗口中选择是否暂停任务并继续安装。"],
      error: [failedPhase === "install" ? "安装更新未完成" : failedPhase === "download" ? "更新下载失败" : "检查更新失败", exhaustedText ? `${exhaustedText}${savedProgress ? "已保存下载进度。" : ""}当前版本仍可继续使用。` : savedProgress ? "已保存下载进度，点击“继续下载”即可接着下载。当前版本仍可继续使用。" : "当前版本仍可继续使用。"]
    }[status] || ["应用更新", "正在读取更新状态。"];
    ui.updateTitle.textContent = text[0];
    ui.updateMessage.textContent = text[1];
    ui.updateDownload.hidden = !(status === "available" || (failed && failedPhase === "download" && mayRetry));
    ui.updateDownload.textContent = canResume ? "继续下载" : failed ? "重试下载" : "下载更新";
    ui.updateInstall.hidden = !(status === "downloaded" || (failed && failedPhase === "install" && mayRetry));
    ui.updateInstall.textContent = failed ? "重试安装" : "安装更新";
    ui.updateRetry.hidden = !(failed && failedPhase === "check" && mayRetry);
    ui.updateCancel.hidden = status !== "downloading";
    for (const button of [ui.updateDownload, ui.updateInstall, ui.updateRetry]) button.disabled = busy;
    // The download invocation may remain pending until all bytes are received.
    // Pausing stays available while that invocation is in flight.
    ui.updateCancel.disabled = updatePending === "cancel";
    ui.updateCancel.textContent = updatePending === "cancel" ? "正在暂停…" : "暂停下载";

    const percent = total > 0 ? Math.min(100, Math.round(received * 100 / total)) : null;
    ui.updateProgressWrap.hidden = status !== "downloading" && !savedProgress;
    if (percent === null) ui.updateProgress.removeAttribute("value");
    else ui.updateProgress.value = percent;
    const progressText = total > 0
      ? `${updateBytes(received)} / ${updateBytes(total)} · ${percent}%`
      : `已下载 ${updateBytes(received)} · ${savedProgress ? "进度已保存" : "正在接收安装包"}`;
    ui.updateProgressText.textContent = progressText;
    ui.updateProgress.setAttribute("aria-valuetext", progressText);
    ui.updateError.hidden = !failed;
    ui.updateError.textContent = failed ? errorText : "";
    const showInstallHint = ["available", "downloading", "downloaded", "installing"].includes(status) || (failed && failedPhase === "install");
    const fallbackHint = desktopInfo.platform === "darwin"
      ? "Mac：安装方式与是否需要退出重启会在确认窗口中说明。"
      : desktopInfo.platform === "win32" && desktopInfo.portable
        ? "当前为 Windows 便携版；本次更新会运行安装程序，安装正式版。"
        : "";
    const hint = String(next.installationHint || fallbackHint);
    ui.updateInstallationHint.hidden = !showInstallHint || !hint;
    ui.updateInstallationHint.textContent = hint;
    const notes = typeof next.releaseNotes === "string" ? next.releaseNotes.trim() : "";
    ui.updateNotesDetails.hidden = !notes || ["idle", "checking", "up-to-date"].includes(status);
    ui.updateNotes.textContent = notes;
    const newVersion = Boolean(next.latestVersion) && ["available", "downloading", "downloaded", "installing"].includes(status);
    element("desktop-update-badge").hidden = !newVersion;
    element("desktop-update-badge").textContent = status === "downloaded" ? "可安装" : status === "downloading" ? "下载中" : "新版本";
    if (status === "available" && newVersion && announcedUpdate !== next.latestVersion) {
      announcedUpdate = next.latestVersion;
      element("desktop-announcement-title").textContent = `新版本 ${latest}`;
      element("desktop-announcement-message").textContent = "可以继续当前任务，准备好后再下载更新。";
      element("desktop-update-announcement").hidden = currentPage === "about" || dismissedUpdate === next.latestVersion;
    }
    if (!newVersion) element("desktop-update-announcement").hidden = true;
    renderUpdateDialog(next, { status, version, failedPhase, mayRetry, canResume, savedProgress, percent, progressText, notes, checkNote, retryText, errorText });
    restoreInstallFocus();
  }

  async function performUpdate(action) {
    if (!["check", "download", "cancel", "install"].includes(action)) return;
    if (updatePending && !(action === "cancel" && updateState.status === "downloading")) return;
    if (action === "install") requestedInstallFocus = document.activeElement;
    const method = { check: "checkForUpdates", download: "downloadUpdate", cancel: "cancelUpdateDownload", install: "installUpdate" }[action];
    const requestId = ++updateRequestId;
    updatePending = action;
    renderUpdateState(updateState);
    try {
      const result = await bridge[method]();
      if (requestId === updateRequestId && result && typeof result.status === "string") renderUpdateState(result);
    } catch (error) {
      if (requestId === updateRequestId) renderUpdateState({
        ...updateState, status: "error", canRetry: true,
        error: { phase: action === "cancel" ? "download" : action, message: error?.message || "更新操作未完成，请稍后重试。" }
      });
    } finally {
      if (requestId === updateRequestId) {
        if (action === "install") requestedInstallFocus = null;
        updatePending = null;
        renderUpdateState(updateState);
        if (action === "check" && ["available", "downloaded"].includes(updateState.status)) openUpdateDialog();
        if (action === "install" && updateState.status === "error") openUpdateDialog();
      }
    }
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
    ui.retry.hidden = count(snapshot.failed) === 0;
    ui.retry.textContent = `重试全部失败（${count(snapshot.failed)}）`;
    for (const button of [ui.pause, ui.resume, ui.cancel, ui.retry, ui.login]) {
      button.disabled = operationPending;
    }
    ui.clearLogin.disabled = !initialized || operationPending || typeof bridge.clearXhsLogin !== "function";
    ui.clearLogin.textContent = clearLoginPending ? "清除中……" : "清除登录记录";
    ui.clearLogin.setAttribute("aria-busy", String(clearLoginPending));
    ui.clearLogin.title = typeof bridge.clearXhsLogin === "function"
      ? "清除本地版保存的小红书登录与缓存，之后可登录其他账号。"
      : "当前版本暂不支持清除登录记录，请更新软件。";
    ui.retry.disabled = operationPending || running;
    ui.retry.title = running ? "请先暂停任务，再重试失败笔记" : "重新处理全部失败笔记";
    for (const button of ui.items.querySelectorAll("button[data-retry-id]")) {
      button.disabled = !initialized || operationPending || running || typeof bridge.retryItem !== "function";
      button.title = running ? "请先暂停任务，再重试这篇笔记" : "重新下载这篇失败笔记";
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
    const failedCount = items.filter((item) => item.status === "failed").length;
    ui.itemsCount.textContent = String(items.length);
    ui.itemsAll.textContent = `全部（${items.length}）`;
    ui.itemsFailed.textContent = `只看失败（${failedCount}）`;
    ui.itemsAll.setAttribute("aria-pressed", String(itemFilter === "all"));
    ui.itemsFailed.setAttribute("aria-pressed", String(itemFilter === "failed"));
    ui.itemsHint.textContent = RUNNING_STATUSES.has(snapshot.status) && failedCount > 0
      ? "失败笔记可复制链接或转到单篇下载；在批量任务中重试前，请先暂停任务。"
      : failedCount > 0 ? "失败笔记可复制链接、转到单篇下载或重试，编号与文件夹顺序不变。"
        : "失败笔记优先显示，编号与文件夹顺序不变。";
    const filtered = items.map((item, index) => ({ ...item, sequence: count(item.sequence) || index + 1 }))
      .filter((item) => itemFilter !== "failed" || item.status === "failed")
      .sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed") || a.sequence - b.sequence);
    ui.itemsEmpty.hidden = filtered.length > 0;
    ui.itemsEmpty.textContent = itemFilter === "failed" ? "暂无失败笔记。" : "发现笔记后会在这里显示下载状态。";
    const visible = filtered.slice(0, visibleItemCount);
    ui.showMore.hidden = visible.length >= filtered.length;
    ui.showMore.textContent = `显示更多记录（还有 ${Math.max(0, filtered.length - visible.length)} 篇）`;
    // Do not replace the list while only the waiting countdown changes.
    const key = JSON.stringify(visible.map(({ id, url, title, status, error, sequence, directoryName }) => [id, url, title, status, error, sequence, directoryName]));
    if (key === renderedItemsKey) return;
    renderedItemsKey = key;
    const fragment = document.createDocumentFragment();
    for (const item of visible) {
      const row = document.createElement("li");
      row.className = "profile-item";
      row.dataset.status = String(item.status || "pending");
      const title = document.createElement("span");
      title.className = "profile-item-title";
      title.textContent = `${String(item.sequence).padStart(3, "0")} · ${String(item.title || item.id || "未命名笔记")}`;
      const actions = document.createElement("div");
      actions.className = "profile-item-actions";
      const status = document.createElement("span");
      status.className = "profile-item-status";
      status.textContent = ITEM_LABELS[item.status] || "等待处理";
      actions.append(status);
      if (item.status === "failed") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "profile-item-retry";
        retry.dataset.retryId = String(item.id);
        retry.textContent = "重试";
        retry.setAttribute("aria-label", `重试第 ${item.sequence} 篇：${item.title || item.id}`);
        actions.append(retry);
      }
      row.append(title, actions);
      if (item.directoryName) {
        const directory = document.createElement("p");
        directory.className = "profile-item-directory";
        directory.textContent = `文件夹：${item.directoryName}`;
        row.append(directory);
      }
      if (item.error) {
        const error = document.createElement("p");
        error.className = "profile-item-error";
        error.textContent = String(item.error);
        row.append(error);
      }
      if (item.status === "failed") {
        const noteUrl = String(item.url || (/^[a-f0-9]{24}$/i.test(item.id)
          ? `https://www.xiaohongshu.com/explore/${item.id}` : ""));
        if (noteUrl) {
          const recovery = document.createElement("div");
          recovery.className = "profile-item-recovery";
          const link = document.createElement("p");
          link.className = "profile-item-url";
          link.textContent = noteUrl;
          const linkActions = document.createElement("div");
          linkActions.className = "profile-item-link-actions";
          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "profile-item-retry";
          copy.dataset.copyNoteUrl = noteUrl;
          copy.textContent = "复制链接";
          copy.disabled = typeof onCopyNoteLink !== "function";
          copy.setAttribute("aria-label", `复制第 ${item.sequence} 篇失败笔记的链接`);
          const open = document.createElement("button");
          open.type = "button";
          open.className = "profile-item-retry";
          open.dataset.openNoteUrl = noteUrl;
          open.textContent = "去单篇下载";
          open.disabled = typeof onOpenNote !== "function";
          open.setAttribute("aria-label", `将第 ${item.sequence} 篇失败笔记转到单篇下载`);
          linkActions.append(copy, open);
          recovery.append(link, linkActions);
          row.append(recovery);
        }
      }
      fragment.append(row);
    }
    const previousScroll = ui.items.scrollTop;
    ui.items.replaceChildren(fragment);
    ui.items.scrollTop = previousScroll;
    updateControls();
  }

  function render(next) {
    if (!next || typeof next !== "object") return;
    snapshot = next;
    const taskActive = RUNNING_STATUSES.has(next.status);
    element("desktop-task-badge").hidden = !taskActive && next.status !== "paused";
    element("desktop-task-badge").textContent = taskActive ? "进行中" : "已暂停";
    const discovered = count(next.discovered);
    const completed = count(next.completed);
    const skipped = count(next.skipped);
    const failed = count(next.failed);
    if (failed > previousFailedCount) ui.details.open = true;
    previousFailedCount = failed;
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
    showClearLoginStatus("");
    const url = ui.url.value.trim();
    return bridge.openLogin(validProfileUrl(url) ? url : undefined);
  }));
  ui.clearLogin.addEventListener("click", () => void clearXhsLogin());
  ui.pause.addEventListener("click", () => perform(() => bridge.pauseProfile()));
  ui.resume.addEventListener("click", () => perform(() => {
    populateSettings(snapshot);
    return bridge.resumeProfile();
  }));
  ui.cancel.addEventListener("click", () => perform(() => bridge.cancelProfile()));
  ui.retry.addEventListener("click", () => perform(() => bridge.retryFailed()));
  ui.items.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !ui.items.contains(button)) return;
    if (button.dataset.copyNoteUrl) {
      void onCopyNoteLink(button.dataset.copyNoteUrl, button);
    } else if (button.dataset.openNoteUrl) {
      if (onOpenNote(button.dataset.openNoteUrl) === false) return;
      selectTab(ui.singleTab);
      element("share-text").focus();
      ui.singlePanel.scrollTop = 0;
    } else if (button.dataset.retryId) {
      void perform(() => bridge.retryItem(button.dataset.retryId));
    }
  });
  ui.openDirectory.addEventListener("click", () => perform(() => bridge.openDirectory()));
  for (const [button, filter] of [[ui.itemsAll, "all"], [ui.itemsFailed, "failed"]]) {
    button.addEventListener("click", () => {
      itemFilter = filter;
      visibleItemCount = 100;
      ui.items.scrollTop = 0;
      renderItems();
    });
  }
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
    itemFilter = "all";
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
    unsubscribeUpdates();
  }, { once: true });

  ui.updateCheck.addEventListener("click", () => void performUpdate("check"));
  ui.updateProxyToggle?.addEventListener("click", () => void toggleUpdateProxy());
  ui.updateDialogProxyToggle?.addEventListener("click", () => void toggleUpdateProxy());
  ui.updateRetry.addEventListener("click", () => void performUpdate("check"));
  ui.updateDownload.addEventListener("click", () => void performUpdate("download"));
  ui.updateCancel.addEventListener("click", () => void performUpdate("cancel"));
  ui.updateInstall.addEventListener("click", () => void performUpdate("install"));
  ui.updateManualDownload.addEventListener("click", () => void openManualInstaller());
  ui.updateDialogManualDownload.addEventListener("click", () => void openManualInstaller());
  ui.updateDialogLater?.addEventListener("click", closeUpdateDialog);
  ui.updateDialogAction?.addEventListener("click", () => {
    const action = ui.updateDialogAction.dataset.action;
    if (action && !ui.updateDialogAction.disabled) void performUpdate(action);
  });
  ui.updateDialog?.addEventListener("cancel", event => { event.preventDefault(); closeUpdateDialog(); });
  ui.updateDialog?.addEventListener("click", event => {
    if (event.target !== ui.updateDialog) return;
    const bounds = ui.updateDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeUpdateDialog();
  });
  ui.installLater?.addEventListener("click", () => void respondInstallConfirmation(false));
  ui.installConfirm?.addEventListener("click", () => void respondInstallConfirmation(true));
  ui.installDialog?.addEventListener("cancel", event => {
    event.preventDefault();
    void respondInstallConfirmation(false);
  });
  ui.installDialog?.addEventListener("click", event => {
    if (event.target !== ui.installDialog) return;
    const bounds = ui.installDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) void respondInstallConfirmation(false);
  });
  ui.installDialog?.addEventListener("close", () => {
    if (pendingInstallClosures) pendingInstallClosures--;
    if (installConfirmation && !ui.installDialog.open) void respondInstallConfirmation(false);
    restoreInstallFocus();
  });
  if (typeof bridge.onInstallConfirmation === "function") {
    const cleanup = bridge.onInstallConfirmation(showInstallConfirmation);
    if (typeof cleanup === "function") window.addEventListener("pagehide", cleanup, { once: true });
  }
  // Installation receipts belong to a previous attempt. They never enter the
  // live updater state, open a dialog, navigate, or claim the current download
  // has finished. Subscribe before reading so a late snapshot cannot resurrect
  // a dismissed receipt or overwrite a newer result.
  function renderUpdateHistory(next) {
    updateHistory = next && typeof next.id === "string" ? next : null;
    ui.updateHistory.hidden = !updateHistory;
    ui.updateHistoryError.hidden = true;
    ui.updateHistoryError.textContent = "";
    ui.updateHistoryDismiss.disabled = updateHistoryPending;
    if (!updateHistory) return;
    const metadata = [updateHistory.targetVersion ? `安装目标 v${updateHistory.targetVersion}` : "安装版本未记录"];
    if (updateHistory.previousVersion) metadata.push(`当时版本 v${updateHistory.previousVersion}`);
    if (updateHistory.currentVersion) metadata.push(`当前版本 v${updateHistory.currentVersion}`);
    const recordedAt = updateHistory.recordedAt ? new Date(updateHistory.recordedAt) : null;
    if (recordedAt && Number.isFinite(recordedAt.getTime())) metadata.push(recordedAt.toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }));
    ui.updateHistoryMeta.textContent = metadata.join(" · ");
    ui.updateHistoryOutcome.textContent = updateHistory.outcome || "此前安装的结果尚未确认。";
    ui.updateHistoryAction.textContent = updateHistory.action || "可重新检查更新，或前往发布记录获取完整安装包。";
  }
  ui.updateHistoryDismiss.addEventListener("click", async () => {
    if (!updateHistory || updateHistoryPending || typeof bridge.dismissUpdateHistory !== "function") return;
    const id = updateHistory.id;
    const requestedRevision = ++updateHistoryRevision;
    updateHistoryPending = true;
    ui.updateHistoryDismiss.disabled = true;
    ui.updateHistoryError.hidden = true;
    try {
      const next = await bridge.dismissUpdateHistory(id);
      if (updateHistoryRevision === requestedRevision) renderUpdateHistory(next);
    } catch {
      if (updateHistoryRevision === requestedRevision && updateHistory?.id === id) {
        ui.updateHistoryError.textContent = "暂时无法保存已读状态，请稍后重试。";
        ui.updateHistoryError.hidden = false;
      }
    } finally {
      updateHistoryPending = false;
      ui.updateHistoryDismiss.disabled = false;
    }
  });
  if (typeof bridge.onUpdateHistory === "function") {
    const cleanup = bridge.onUpdateHistory(next => {
      updateHistoryRevision++;
      renderUpdateHistory(next);
    });
    if (typeof cleanup === "function") window.addEventListener("pagehide", cleanup, { once: true });
  }
  if (typeof bridge.getUpdateHistory === "function") {
    const requestedRevision = updateHistoryRevision;
    void bridge.getUpdateHistory().then(next => {
      if (updateHistoryRevision === requestedRevision) renderUpdateHistory(next);
    }).catch(() => {});
  }
  renderUpdateProxy();
  if (proxyControlsAvailable) {
    if (typeof bridge.onUpdateProxy === "function") {
      const cleanup = bridge.onUpdateProxy(next => {
        updateProxyRevision++;
        updateProxyMessage = "";
        renderUpdateProxy(next);
      });
      if (typeof cleanup === "function") window.addEventListener("pagehide", cleanup, { once: true });
    }
    const requestedRevision = updateProxyRevision;
    void bridge.getUpdateProxyState().then(next => {
      if (updateProxyRevision === requestedRevision) renderUpdateProxy(next);
    }).catch(() => {
      if (updateProxyRevision === requestedRevision) {
        updateProxyMessage = "暂时无法读取升级代理状态，仍可手动关闭内置代理。";
        renderUpdateProxy();
      }
    });
  }
  renderUpdateState(updateState);
  if (typeof bridge.onUpdateState === "function") {
    const cleanup = bridge.onUpdateState((next) => {
      updateRevision += 1;
      renderUpdateState(next);
    });
    if (typeof cleanup === "function") unsubscribeUpdates = cleanup;
  }
  if (updatesAvailable) {
    const requestedRevision = updateRevision;
    void bridge.getUpdateState().then((next) => {
      if (updateRevision === requestedRevision) renderUpdateState(next);
    }).catch((error) => {
      if (updateRevision === requestedRevision) renderUpdateState({
        ...updateState, status: "error", canRetry: true,
        error: { phase: "check", message: error?.message || "暂时无法读取更新状态，请点击重新检查。" }
      });
    });
  }

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
    desktopInfo = info;
    element("desktop-about-version").textContent = `版本 ${info.version || "未知"}`;
    element("desktop-about-system").textContent = `${environmentText()}${info.portable ? " · 便携版" : ""}`;
    element("desktop-diagnostics-environment").textContent = environmentText();
    onInfo(info);
    renderUpdateState(updateState);
    initialized = true;
    // A newer update may have arrived while the initial snapshot was in flight.
    if (!snapshot.updatedAt || !savedState?.updatedAt || savedState.updatedAt >= snapshot.updatedAt) {
      populateSettings(savedState || {});
      render(savedState || snapshot);
    } else {
      populateSettings(snapshot);
      updateControls();
    }
    document.body.dataset.desktopReady = "true";
    window.dispatchEvent(new Event("xhs-desktop-ready"));
  } catch (error) {
    showError(`本地下载功能暂未就绪：${error?.message || "请重新打开应用。"}`);
    updateControls();
  }
}
