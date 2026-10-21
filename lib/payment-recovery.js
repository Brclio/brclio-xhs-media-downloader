const orderPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = phase => ['idle', 'confirmed', 'closed'].includes(phase);

// A checkout return and PAID provider response are only references. Completion
// requires the committed business order, a fresh account and refreshed guards.
export function createPaymentRecovery({ bridge, onChange = () => {}, onConfirmed = () => {},
  getStatusContext = () => undefined, onStatusChecked = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, automaticWindowMs = 10 * 60_000, confirmationWindowMs = 60_000 } = {}) {
  let account = null, generation = 0, timer = null, flight = null, flightEntry = null, restoring = null, restarting = null, releasing = false, disposed = false;
  let foreground = true, deadline = 0, attempts = 0, paidObservedAt = null, confirmationAttempts = 0, qrTimer = null, qrRevision = 0, qrIdentityEpoch = 0;
  let state = { ownerId: null, orderId: null, order: null, paymentStatus: null, phase: 'idle', busy: false, message: '', permissions: [], persistent: true, completedAccount: null, wechatQr: null };
  const qrCurrent = qr => Boolean(qr && !disposed && !releasing && account?.authenticated && account.verified
    && account.account?.user?.id === state.ownerId && qr.ownerId === state.ownerId && qr.orderId === state.orderId
    && state.order?.userId === state.ownerId && state.order.provider === 'wechat' && state.order.status === 'pending'
    && state.paymentStatus === 'PENDING' && ['waiting', 'retry'].includes(state.phase) && Date.parse(qr.expiresAt) > now());
  const snapshot = () => structuredClone({ ...state, accountRevision: qrIdentityEpoch, wechatQr: qrCurrent(state.wechatQr) ? state.wechatQr : null });
  const stopQrTimer = () => { qrRevision++; if (qrTimer !== null) clearTimer(qrTimer); qrTimer = null; };
  function scheduleQrExpiry() {
    stopQrTimer();
    const qr = state.wechatQr;
    if (!qr) return;
    const revision = qrRevision;
    // Expiry clears only the presentation. Keep the durable business-order
    // reference and status polling so a paid/closed result can still recover.
    qrTimer = setTimer(() => {
      if (disposed || revision !== qrRevision || state.wechatQr !== qr) return;
      qrTimer = null;
      if (Date.parse(qr.expiresAt) <= now()) emit({ wechatQr: null });
      else scheduleQrExpiry();
    }, Math.min(Math.max(0, Date.parse(qr.expiresAt) - now()), 2_147_483_647));
  }
  const emit = patch => {
    state = { ...state, ...patch };
    if (!qrCurrent(state.wechatQr)) state.wechatQr = null;
    scheduleQrExpiry();
    // Render observers cannot control payment completion or its retry lifecycle.
    if (!disposed) { try { onChange(snapshot()); } catch {} }
  };
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const current = (epoch, ownerId, orderId) => !disposed && generation === epoch
    && state.ownerId === ownerId && state.orderId === orderId && account?.authenticated;
  function schedule() {
    stopTimer();
    if (disposed || !foreground || releasing || !state.orderId || !state.ownerId || terminal(state.phase)) return;
    const activeQr = qrCurrent(state.wechatQr);
    if (activeQr) deadline = Math.max(deadline, Date.parse(state.wechatQr.expiresAt));
    const confirming = paidObservedAt !== null && now() - paidObservedAt < confirmationWindowMs;
    if (confirming) deadline = Math.max(deadline, paidObservedAt + confirmationWindowMs);
    if (now() >= deadline) {
      emit({ message: `${state.message} 自动查询已暂停；切回软件或点击查询可继续核实。` });
      return;
    }
    const delay = confirming ? [1000, 1500, 2000, 3000][Math.min(confirmationAttempts++, 3)]
      : activeQr ? 3000 : [3000, 5000, 10_000, 20_000, 30_000][Math.min(attempts, 4)];
    timer = setTimer(() => { timer = null; void check(); }, delay);
  }
  function scheduleRestore() {
    stopTimer();
    if (disposed || !foreground || state.orderId || !state.ownerId || state.phase !== 'restore-retry' || now() >= deadline) return;
    timer = setTimer(() => { timer = null; void restore(); }, [3000, 5000, 10_000, 30_000][Math.min(attempts++, 3)]);
  }
  function setAccount(value) {
    const wasVerified = account?.authenticated && account.verified && account.account?.user?.id === state.ownerId;
    const becameMember = value?.authenticated && value.verified && value.account?.membership?.active
      && (!account?.verified || !account.account?.membership?.active);
    account = value;
    const ownerId = value?.authenticated ? value.account?.user?.id || state.ownerId : null;
    if (ownerId !== state.ownerId || (wasVerified && (!value?.authenticated || !value.verified || value.account?.user?.id !== ownerId))) qrIdentityEpoch++;
    if (ownerId !== state.ownerId) {
      generation++; stopTimer(); flight = null; flightEntry = null; restoring = null; restarting = null; releasing = false; attempts = 0; paidObservedAt = null; confirmationAttempts = 0;
      emit({ ownerId, orderId: null, order: null, paymentStatus: null, phase: 'idle', busy: false, message: '', permissions: [], persistent: true, completedAccount: null });
    } else if (becameMember && state.orderId && ['waiting', 'confirming', 'retry'].includes(state.phase)) {
      // Another verified refresh may see the webhook's entitlement first.
      // That is a reason to check the order, never a payment confirmation.
      const epoch = generation, orderId = state.orderId;
      queueMicrotask(() => { if (current(epoch, ownerId, orderId)) void check({ followup: true }); });
    }
    // A same-owner loss of server verification must also revoke a displayed
    // code immediately, while preserving that owner's recoverable order.
    if (state.wechatQr && !qrCurrent(state.wechatQr)) emit({ wechatQr: null });
  }
  function track(orderId, { persistent = true } = {}) {
    if (disposed || !state.ownerId || !account?.authenticated || !orderPattern.test(orderId || '')) return false;
    if (orderId === state.orderId) return true;
    generation++; stopTimer(); flight = null; flightEntry = null; releasing = false; attempts = 0; paidObservedAt = null; confirmationAttempts = 0; deadline = now() + automaticWindowMs;
    emit({ orderId, order: null, paymentStatus: null, phase: 'waiting', busy: false, permissions: [], persistent, completedAccount: null,
      message: `订单 ${orderId} 等待付款与权益确认。软件会自动核实，请勿重复付款。` });
    schedule(); return true;
  }
  function mergeOrder(order, paymentStatus) {
    // An older response must never turn an already observed payment back into
    // an unpaid order, including a resume response racing automatic polling.
    const committed = state.order?.status === 'confirmed' ? state.order : order;
    const status = committed.status === 'confirmed' || committed.paymentStatus === 'PAID' || state.paymentStatus === 'PAID' || paymentStatus === 'PAID' ? 'PAID'
      : committed.paymentStatus === 'CLOSED' || state.paymentStatus === 'CLOSED' ? 'CLOSED' : paymentStatus || null;
    if (status === 'PAID' && paidObservedAt === null) { paidObservedAt = now(); confirmationAttempts = 0; }
    emit({ order: structuredClone(committed), paymentStatus: status });
    return { order: committed, paymentStatus: status };
  }
  function observeQr(result, accountRevision = qrIdentityEpoch) {
    // A response begun before identity verification was lost may still update
    // order recovery, but cannot redisplay that earlier account's payment code.
    if (accountRevision !== qrIdentityEpoch) return;
    if (!Object.hasOwn(result || {}, 'qrCodeUrl') && !Object.hasOwn(result || {}, 'qrCodeExpiresAt')) return;
    let qr = null;
    const codeUrl = result?.qrCodeUrl, expiresAt = result?.qrCodeExpiresAt;
    if (typeof codeUrl === 'string' && codeUrl.length <= 2048 && !/[\s\u0000-\u001f\u007f\\]/u.test(codeUrl)
      && typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt))) {
      try {
        const url = new URL(codeUrl), token = url.searchParams.get('pr');
        if (url.protocol === 'weixin:' && url.hostname === 'wxpay' && url.pathname === '/bizpayurl'
          && !url.username && !url.password && !url.port && !url.hash && url.searchParams.size === 1
          && /^[A-Za-z0-9_-]{1,1024}$/.test(token || '')) {
          qr = { ownerId: state.ownerId, orderId: state.orderId, codeUrl: url.href, expiresAt: new Date(Date.parse(expiresAt)).toISOString() };
        }
      } catch { /* Invalid presentation cannot affect order or entitlement recovery. */ }
    }
    emit({ wechatQr: qr });
  }
  function observe(result, { accountRevision = qrIdentityEpoch } = {}) {
    const order = result?.order;
    if (disposed || terminal(state.phase) || !state.orderId || !account?.authenticated || order?.id !== state.orderId
      || (order.userId && order.userId !== state.ownerId) || !['pending', 'confirmed'].includes(order.status)) return false;
    const merged = mergeOrder(order, result.paymentStatus || order.paymentStatus);
    observeQr(result, accountRevision);
    if (merged.paymentStatus === 'PAID' && state.phase !== 'refreshing') emit({ phase: 'confirming',
      message: `订单 ${state.orderId} 已付款，会员权益确认中。软件会继续自动核实，请勿重复付款。` });
    if (merged.paymentStatus === 'PAID') {
      if (flightEntry?.stage === 'status' && !flightEntry.followed) flightEntry.recheck = true;
      else if (!flight && !releasing) schedule();
    }
    return true;
  }
  async function restoreWork(entry) {
    if (disposed || !state.ownerId || !account?.authenticated || !bridge.getPendingPayment) return;
    const epoch = generation, ownerId = state.ownerId;
    stopTimer();
    // Until this read succeeds, an empty in-memory order is not evidence that
    // no persisted purchase exists. Expose the guard before the first await.
    emit({ phase: 'restoring', busy: true, message: '正在恢复待核实付款订单，请稍候，暂勿创建新订单。' });
    try {
      if (!account.verified) {
        const refreshed = await bridge.refreshAccount();
        if (disposed || generation !== epoch || state.ownerId !== ownerId) return;
        if (!refreshed?.ok || !refreshed.state?.verified || refreshed.state.account?.user?.id !== ownerId) {
          throw new Error('待核实订单仍保存在本机，联网刷新账号后会继续恢复。');
        }
        account = refreshed.state;
      }
      const reply = await bridge.getPendingPayment();
      if (disposed || generation !== epoch || state.ownerId !== ownerId) return;
      if (!reply?.ok) {
        if (reply?.state) setAccount(reply.state);
        if (reply?.error?.code === 'ACCOUNT_UNVERIFIED') setAccount({ ...account, verified: false });
        throw new Error(reply?.error?.message || '暂时无法恢复待核实订单，请稍后重试。');
      }
      const pending = reply.result;
      if (!pending || pending.userId !== ownerId || !orderPattern.test(pending.orderId || '')) {
        emit({ phase: 'idle', busy: false, message: '' }); return;
      }
      if (track(pending.orderId, { persistent: reply.recovery?.persistent !== false })) {
        // Tracking this restored order advances its epoch; keep the same
        // restoration in flight until its first status request also finishes.
        entry.generation = generation;
        await check();
      }
    } catch (error) {
      if (!disposed && generation === epoch && state.ownerId === ownerId) {
        emit({ phase: 'restore-retry', busy: false, message: `${error.message || '暂时无法恢复待核实订单，请稍后重试。'} 原付款记录仍已保留，恢复完成前暂不创建新订单。` });
        if (!deadline) deadline = now() + automaticWindowMs;
        scheduleRestore();
      }
    }
  }
  function restore() {
    if (disposed || ['confirmed', 'closed'].includes(state.phase)) return Promise.resolve();
    if (restoring?.generation === generation) return restoring.promise;
    if (state.orderId && !terminal(state.phase)) return check();
    const entry = { generation };
    entry.promise = restoreWork(entry).finally(() => { if (restoring === entry) restoring = null; });
    restoring = entry;
    return entry.promise;
  }
  function check({ followup = false } = {}) {
    if (disposed || releasing || !state.orderId || !state.ownerId || !account?.authenticated || terminal(state.phase)) return Promise.resolve();
    if (flight) {
      // A foreground return after this request started must not be satisfied by
      // its older PENDING snapshot. Coalesce every such wake into one tail read.
      if (followup && flightEntry?.stage === 'status' && !flightEntry.followed) flightEntry.recheck = true;
      return flight;
    }
    stopTimer();
    const epoch = generation, ownerId = state.ownerId, orderId = state.orderId;
    const entry = { stage: 'identity', recheck: false, followed: false };
    flightEntry = entry;
    emit({ busy: true });
    const work = (async () => {
      do {
        entry.recheck = false;
        entry.stage = 'identity';
        try {
          // A failed me/permission refresh may temporarily mark this same account
          // unverified. Recover it rather than abandoning its persisted order.
          if (!account.verified) {
            const refreshed = await bridge.refreshAccount();
            if (!current(epoch, ownerId, orderId)) return;
            if (!refreshed?.ok || !refreshed.state?.verified || refreshed.state.account?.user?.id !== ownerId) {
              throw new Error('订单已保留，暂时无法刷新当前账号；恢复联网后会继续核实。');
            }
            account = refreshed.state;
          }
          entry.stage = 'status';
          const qrAccountRevision = qrIdentityEpoch;
          // Capture presentation context for each actual read, including a tail
          // read after a foreground wake. A renderer failure cannot stop it.
          let statusContext;
          try { statusContext = getStatusContext(); } catch {}
          const reply = await bridge.commerceRequest('payment-status', { orderId, expectedUserId: ownerId });
          if (!current(epoch, ownerId, orderId)) return;
          if (!reply?.ok) {
            if (reply?.state) setAccount(reply.state);
            if (!current(epoch, ownerId, orderId)) return;
            if (['ACCOUNT_CHANGED', 'SESSION_CHANGED', 'ACCOUNT_UNVERIFIED'].includes(reply?.error?.code)) {
              setAccount({ ...account, verified: false });
            }
            if (reply?.error?.code === 'ORDER_NOT_FOUND') {
              entry.stage = 'persist';
              const cleared = await bridge.clearPendingPayment?.({ orderId, expectedUserId: ownerId });
              if (!current(epoch, ownerId, orderId)) return;
              if (cleared && !cleared.ok) throw new Error('暂时无法更新本机订单记录，请稍后重试。');
              emit({ phase: 'closed', message: '没有找到当前账号的支付订单。请检查付款时使用的软件账号。' });
              return;
            }
            throw new Error(reply?.error?.message || '暂时无法核实订单；订单已保留，会继续重试。');
          }
          const incoming = reply.result?.order;
          if (incoming?.id !== orderId || (incoming.userId && incoming.userId !== ownerId)
            || !['pending', 'confirmed'].includes(incoming.status)) throw new Error('订单状态返回异常，已保留原订单等待核实。');
          const { order, paymentStatus } = mergeOrder(incoming, reply.result?.paymentStatus || incoming.paymentStatus);
          observeQr(reply.result, qrAccountRevision);
          if (order.status === 'confirmed') {
            entry.stage = 'permissions';
            emit({ phase: 'refreshing', message: `订单 ${orderId} 已付款，正在刷新账号与功能权限…` });
            const refreshed = await (bridge.refreshAccountPermissions ? bridge.refreshAccountPermissions() : bridge.refreshAccount());
            if (!current(epoch, ownerId, orderId)) return;
            const fresh = refreshed?.state;
            const membership = fresh?.account?.membership;
            const expired = membership?.type === 'duration' && Number.isFinite(Date.parse(membership.expiresAt))
              && Number.isFinite(Date.parse(fresh.account.serverTime)) && Date.parse(membership.expiresAt) <= Date.parse(fresh.account.serverTime)
              && Number.isFinite(Date.parse(order.paidAt)) && Date.parse(order.paidAt) <= Date.parse(membership.expiresAt);
            if (!refreshed?.ok || !fresh?.authenticated || !fresh.verified || fresh.account?.user?.id !== ownerId
              || (!membership?.active && !expired) || refreshed.result?.complete === false) {
              throw new Error('付款已由服务端确认，账号或功能权限仍待刷新；原订单已保留，会继续重试。');
            }
            account = fresh;
            entry.stage = 'persist';
            const cleared = await bridge.clearPendingPayment?.({ orderId, expectedUserId: ownerId });
            if (!current(epoch, ownerId, orderId)) return;
            if (cleared && !cleared.ok) throw new Error('权益已刷新，本机待核实记录尚未保存成功；会继续重试，请勿重复付款。');
            const permissions = refreshed.result?.permissions || [];
            const limited = permissions.some(item => !item.authorized);
            // Completion is a durable result. UI observers may render or refresh
            // this same owner, but cannot turn success back into a pending order.
            emit({ phase: 'confirmed', completedAccount: structuredClone(fresh), permissions, message: expired
              ? `订单 ${orderId} 付款已确认，账号已刷新；该次会员时长现已到期。`
              : limited ? `订单 ${orderId} 已付款，会员权益已确认；当前设备的功能仍按授权限制执行。`
                : `订单 ${orderId} 已付款，会员权益已由服务端确认，账号与功能权限已刷新。` });
            try { onConfirmed({ orderId, ownerId, state: fresh, permissions }); }
            catch { /* Rendering must not undo the committed result. */ }
          } else if (paymentStatus === 'CLOSED') {
            entry.stage = 'persist';
            const cleared = await bridge.clearPendingPayment?.({ orderId, expectedUserId: ownerId });
            if (!current(epoch, ownerId, orderId)) return;
            if (cleared && !cleared.ok) throw new Error('订单已关闭，本机记录仍待更新，会继续重试。');
            emit({ phase: 'closed', message: `订单 ${orderId} 已关闭，未开通会员。` });
          } else if (paymentStatus === 'PAID') {
            emit({ phase: 'confirming', message: `订单 ${orderId} 已付款，会员权益确认中。软件会继续自动核实，请勿重复付款。` });
          } else {
            emit({ phase: 'waiting', message: `订单 ${orderId} 尚未完成付款，未开通会员。可继续支付原订单，或重新下单选择套餐；软件会自动查询付款结果。` });
          }
          // Only a successfully applied read for the same verified identity
          // may restore its presentation. Notify after the phase transition so
          // an automatic retry can recover a code hidden during an outage.
          if (current(epoch, ownerId, orderId) && qrAccountRevision === qrIdentityEpoch
            && account?.verified && account.account?.user?.id === ownerId) {
            try { onStatusChecked(statusContext, snapshot()); } catch {}
          }
        } catch (error) {
          if (current(epoch, ownerId, orderId) && !terminal(state.phase)) emit({ phase: 'retry', message: error.message || '暂时无法核实，原订单已保留。' });
        }
        attempts++;
        if (!entry.recheck || entry.followed || !foreground || !current(epoch, ownerId, orderId) || terminal(state.phase) || releasing) break;
        entry.followed = true;
      } while (true);
    })().finally(() => {
      if (flightEntry === entry) { flight = null; flightEntry = null; }
      if (current(epoch, ownerId, orderId)) { emit({ busy: false }); schedule(); }
    });
    flight = work; return work;
  }
  function restart() {
    if (restarting?.generation === generation) return restarting.promise;
    const epoch = generation, ownerId = state.ownerId, orderId = state.orderId;
    if (!orderId || !current(epoch, ownerId, orderId) || terminal(state.phase)) return Promise.resolve(false);
    const entry = { generation };
    entry.promise = (async () => {
      // A previously observed PENDING is insufficient: it may have been paid
      // since the last poll. Never abandon an unknown or paid order.
      await check();
      if (!current(epoch, ownerId, orderId) || state.phase !== 'waiting' || state.paymentStatus !== 'PENDING') return false;
      stopTimer(); releasing = true;
      emit({ busy: true });
      try {
        const cleared = await bridge.clearPendingPayment?.({ orderId, expectedUserId: ownerId });
        if (!current(epoch, ownerId, orderId)) return false;
        if (!cleared?.ok || cleared.result?.cleared !== true) throw new Error('暂时无法更新本机订单记录，原订单已保留，请稍后重试。');
        releasing = false; generation++; flight = null; flightEntry = null; restoring = null; attempts = 0; paidObservedAt = null; confirmationAttempts = 0;
        emit({ orderId: null, order: null, paymentStatus: null, phase: 'idle', busy: false, permissions: [], persistent: true, completedAccount: null,
          message: '已恢复套餐选择，请核对当前报价后前往付款。旧订单未关闭，请勿在新旧订单中重复付款；旧单仍可在「我的全部订单」核实。' });
        return true;
      } catch (error) {
        if (current(epoch, ownerId, orderId)) emit({ phase: 'retry', message: error.message || '原订单已保留，请稍后重试。' });
        return false;
      } finally {
        if (current(epoch, ownerId, orderId)) { releasing = false; emit({ busy: false }); schedule(); }
      }
    })().finally(() => { if (restarting === entry) restarting = null; });
    restarting = entry;
    return entry.promise;
  }
  function focus() {
    if (disposed) return Promise.resolve();
    if (!state.orderId) { deadline = now() + automaticWindowMs; return restore(); }
    if (terminal(state.phase)) return Promise.resolve();
    deadline = now() + automaticWindowMs; attempts = 0;
    if (state.paymentStatus === 'PAID') { paidObservedAt = now(); confirmationAttempts = 0; }
    return check({ followup: true });
  }
  function setForeground(value) {
    if (disposed || typeof value !== 'boolean' || foreground === value) return;
    foreground = value;
    if (!foreground) stopTimer();
    else if (!flight && !restoring) {
      if (state.phase === 'restore-retry') scheduleRestore();
      else schedule();
    }
  }
  function dismissResult() {
    if (disposed || state.busy || !['confirmed', 'closed'].includes(state.phase)) return false;
    generation++; stopTimer(); flight = null; flightEntry = null; restoring = null; attempts = 0; paidObservedAt = null; confirmationAttempts = 0;
    emit({ orderId: null, order: null, paymentStatus: null, phase: 'idle', busy: false, permissions: [], persistent: true, completedAccount: null, message: '' });
    return true;
  }
  function dispose() { disposed = true; generation++; stopTimer(); stopQrTimer(); state.wechatQr = null; flight = null; flightEntry = null; restoring = null; }
  return { setAccount, track, observe, restore, check, restart, focus, setForeground, dismissResult, dispose, snapshot };
}
