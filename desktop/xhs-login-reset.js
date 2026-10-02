/** Serialize confirmation and session cleanup for repeated requests. */
export class XhsLoginReset {
  constructor({ manager, confirm }) {
    this.manager = manager;
    this.confirm = confirm;
    this.pending = null;
    this.revision = 0;
  }

  get busy() { return this.pending !== null; }

  assertIdle(revision = this.revision) {
    if (this.busy) throw new Error('正在清除小红书登录记录，请完成后再操作。');
    if (revision !== this.revision) throw new Error('小红书登录状态已变更，请重新操作。');
  }

  run() {
    if (this.pending) return this.pending;
    const pending = this._run();
    this.pending = pending;
    const finished = () => { if (this.pending === pending) this.pending = null; };
    void pending.then(finished, finished);
    return pending;
  }

  async _run() {
    if (!await this.confirm()) return { cancelled: true };
    this.revision += 1;
    const result = await this.manager.clearLoginData();
    return { ...result, message: '已清除小红书登录信息与缓存。点击“登录小红书 / 完成验证”即可登录其它账号。' };
  }
}
