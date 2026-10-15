const orderPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = phase => ['idle', 'confirmed', 'closed'].includes(phase);

// A checkout return and PAID provider response are only references. Completion
// requires the committed business order, a fresh account and refreshed guards.
export function createPaymentRecovery({ bridge, onChange = () => {}, onConfirmed = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, automaticWindowMs = 10 * 60_000 } = {}) {
  let account = null, generation = 0, timer = null, flight = null, restoring = null, disposed = false;
  let deadline = 0, attempts = 0;
  let state = { ownerId: null, orderId: null, order: null, phase: 'idle', busy: false, message: '', permissions: [], persistent: true };
  const snapshot = () => structuredClone(state);
  const emit = patch => { state = { ...state, ...patch }; if (!disposed) onChange(snapshot()); };
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const current = (epoch, ownerId, orderId) => !disposed && generation === epoch
    && state.ownerId === ownerId && state.orderId === orderId && account?.authenticated;
  function schedule() {
    stopTimer();
    if (disposed || !state.orderId || !state.ownerId || terminal(state.phase)) return;
    if (now() >= deadline) {
      emit({ message: `${state.message} 自动查询已暂停；切回软件或点击查询可继续核实。` });
      return;
    }
    const delay = [3000, 5000, 10_000, 20_000, 30_000][Math.min(attempts, 4)];
    timer = setTimer(() => { timer = null; void check(); }, delay);
  }
  function setAccount(value) {
    account = value;
    const ownerId = value?.authenticated ? value.account?.user?.id || state.ownerId : null;
    if (ownerId !== state.ownerId) {
      generation++; stopTimer(); flight = null; restoring = null; attempts = 0;
      emit({ ownerId, orderId: null, order: null, phase: 'idle', busy: false, message: '', permissions: [], persistent: true });
    }
  }
  function track(orderId, { persistent = true } = {}) {
    if (disposed || !state.ownerId || !account?.authenticated || !orderPattern.test(orderId || '')) return false;
    generation++; stopTimer(); flight = null; attempts = 0; deadline = now() + automaticWindowMs;
    emit({ orderId, order: null, phase: 'waiting', busy: false, permissions: [], persistent,
      message: `订单 ${orderId} 等待付款与权益确认。付款后切回软件会立即查询，请勿重复付款。` });
    schedule(); return true;
  }
  async function restoreWork(entry) {
    if (disposed || !state.ownerId || !account?.authenticated || !bridge.getPendingPayment) return;
    const epoch = generation, ownerId = state.ownerId;
    stopTimer();
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
        if (reply?.error?.code === 'ACCOUNT_UNVERIFIED') account = { ...account, verified: false };
        throw new Error(reply?.error?.message || '暂时无法恢复待核实订单，请稍后重试。');
      }
      const pending = reply.result;
      if (!pending || pending.userId !== ownerId || !orderPattern.test(pending.orderId || '')) {
        emit({ phase: 'idle', message: '' }); return;
      }
      if (track(pending.orderId, { persistent: reply.recovery?.persistent !== false })) {
        // Tracking this restored order advances its epoch; keep the same
        // restoration in flight until its first status request also finishes.
        entry.generation = generation;
        await check();
      }
    } catch (error) {
      if (!disposed && generation === epoch && state.ownerId === ownerId) {
        emit({ message: error.message });
        if (!deadline) deadline = now() + automaticWindowMs;
        if (!state.orderId && now() < deadline) {
          timer = setTimer(() => { timer = null; void restore(); }, [3000, 5000, 10_000, 30_000][Math.min(attempts++, 3)]);
        }
      }
    }
  }
  function restore() {
    if (restoring?.generation === generation) return restoring.promise;
    const entry = { generation };
    entry.promise = restoreWork(entry).finally(() => { if (restoring === entry) restoring = null; });
    restoring = entry;
    return entry.promise;
  }
  function check() {
    if (disposed || !state.orderId || !state.ownerId || !account?.authenticated || terminal(state.phase)) return Promise.resolve();
    if (flight) return flight;
    stopTimer();
    const epoch = generation, ownerId = state.ownerId, orderId = state.orderId;
    emit({ busy: true });
    const work = (async () => {
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
        const reply = await bridge.commerceRequest('payment-status', { orderId, expectedUserId: ownerId });
        if (!current(epoch, ownerId, orderId)) return;
        if (!reply?.ok) {
          if (reply?.state) setAccount(reply.state);
          if (!current(epoch, ownerId, orderId)) return;
          if (['ACCOUNT_CHANGED', 'SESSION_CHANGED', 'ACCOUNT_UNVERIFIED'].includes(reply?.error?.code)) {
            account = { ...account, verified: false };
          }
          if (reply?.error?.code === 'ORDER_NOT_FOUND') {
            const cleared = await bridge.clearPendingPayment?.({ orderId, expectedUserId: ownerId });
            if (!current(epoch, ownerId, orderId)) return;
            if (cleared && !cleared.ok) throw new Error('暂时无法更新本机订单记录，请稍后重试。');
            emit({ phase: 'closed', message: '没有找到当前账号的支付订单。请检查付款时使用的软件账号。' });
            return;
          }
          throw new Error(reply?.error?.message || '暂时无法核实订单；订单已保留，会继续重试。');
        }
        const order = reply.result?.order, paymentStatus = reply.result?.paymentStatus || order?.paymentStatus;
        if (order?.id !== orderId || (order.userId && order.userId !== ownerId)
          || !['pending', 'confirmed'].includes(order.status)) throw new Error('订单状态返回异常，已保留原订单等待核实。');
        emit({ order: structuredClone(order) });
        if (order.status === 'confirmed') {
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
          const cleared = await bridge.clearPendingPayment?.({ orderId, expectedUserId: ownerId });
          if (!current(epoch, ownerId, orderId)) return;
          if (cleared && !cleared.ok) throw new Error('权益已刷新，本机待核实记录尚未保存成功；会继续重试，请勿重复付款。');
          const permissions = refreshed.result?.permissions || [];
          const limited = permissions.some(item => !item.authorized);
          emit({ phase: 'confirmed', permissions, message: expired
            ? `订单 ${orderId} 付款已确认，账号已刷新；该次会员时长现已到期。`
            : limited ? `订单 ${orderId} 已付款，会员权益已确认；当前设备的功能仍按授权限制执行。`
              : `订单 ${orderId} 已付款，会员权益已由服务端确认，账号与功能权限已刷新。` });
          onConfirmed({ orderId, ownerId, state: fresh, permissions });
        } else if (paymentStatus === 'CLOSED') {
          const cleared = await bridge.clearPendingPayment?.({ orderId, expectedUserId: ownerId });
          if (!current(epoch, ownerId, orderId)) return;
          if (cleared && !cleared.ok) throw new Error('订单已关闭，本机记录仍待更新，会继续重试。');
          emit({ phase: 'closed', message: `订单 ${orderId} 已关闭，未开通会员。` });
        } else if (paymentStatus === 'PAID') {
          emit({ phase: 'confirming', message: `订单 ${orderId} 已付款，会员权益确认中。软件会继续自动核实，请勿重复付款。` });
        } else {
          emit({ phase: 'waiting', message: `订单 ${orderId} 尚未完成付款，未开通会员。软件正在等待并自动查询，切回软件会立即核实。` });
        }
      } catch (error) {
        if (current(epoch, ownerId, orderId)) emit({ phase: 'retry', message: error.message || '暂时无法核实，原订单已保留。' });
      } finally {
        if (current(epoch, ownerId, orderId)) {
          flight = null; attempts++; emit({ busy: false }); schedule();
        }
      }
    })();
    flight = work; return work;
  }
  function focus() {
    if (disposed) return Promise.resolve();
    if (!state.orderId) { deadline = now() + automaticWindowMs; return restore(); }
    if (terminal(state.phase)) return Promise.resolve();
    deadline = now() + automaticWindowMs; attempts = 0;
    return check();
  }
  function dispose() { disposed = true; generation++; stopTimer(); flight = null; restoring = null; }
  return { setAccount, track, restore, check, focus, dispose, snapshot };
}
