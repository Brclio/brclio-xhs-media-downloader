# Brclio Pay 接入记录

目标产品仅为 `xhs-downloader`，支付中心为 `https://pay.bornforthis.cn`，环境为 `live`。2026-10-15 已应用新增配置，并随 v2.0.22 部署正式后端与网页、发布三平台桌面安装包。生产目录和匿名边界检查已通过；当日随后按用户授权完成一笔 ¥3.00 日付实付、付款通知及实际后端会员开通验收，并在临时验收关闭后获得用户正式开放在线收款的明确授权，中心正式配置为 `PAYMENT_ENABLED=true`。其他套餐、客户端、手机渠道或退款的真实交易未据此标记通过。

## 商品取证与对应关系

| SKU | CNY 金额 | 实际会员时长 | 依据 |
| --- | --- | --- | --- |
| `daily` | `3.00` | 1 天 | `lib/membership-plans.js:4` |
| `monthly` | `19.90` | 30 天 | `lib/membership-plans.js:5` |
| `yearly` | `69.90` | 365 天 | `lib/membership-plans.js:6` |

共享套餐表由 `server/auth/commerce.js` 的原人工订单以及 `server/auth/service.js` 的定向激活码发放读取；`docs/membership-purchase.md:7-13` 明确人民币、时长、按次购买、不自动续费。接入前 `membership.html:69-78` 的静态展示经交叉核对与上述规则一致，现已改为实时在线目录。首次接入取证未导出或展示真实客户资料、订单或凭证，当时生产检查限匿名只读响应。

现有权益依据为 `lib/membership-policy.js:3-6`：桌面主页批量下载、网页与桌面原视频权限；账号、设备限制和上游原视频可用性继续适用。续期从当前时间与原到期时间的较晚者增加天数，永久会员不再购买时长套餐。独立 VIP 交流群不属于这三个后端 SKU，不纳入支付配置。未发现价格、币种或时长冲突。

## 已应用配置

- 原配置：`absent`，plan 的 `before=null`。
- 配置版本：`356a8ce348c8bb2959a1fc7279dec457ad958622c5c311c3bc5bb6d7606e0b60`。
- 应用时间：2026-10-15 09:19:33（Asia/Shanghai）。
- webhook：`https://xhs.download.brclio.com/api/brclio-payment`。
- 返回来源：`https://xhs.download.brclio.com`；具体返回页为 `/?payment_order=<业务订单 UUID>`。
- `addedOrigins=[]`：复用授权中的正式来源，没有增加域名、通配来源或修改 DNS。

正式来源的依据为 `desktop/account-config.json:2`、`docs/cloudflare-deployment.md` 以及本次公开 HTTPS 检查：首页 HTTP 200，`/api/health` 返回 Cloudflare / 2.0.21。只对该产品执行了 context、plan、apply；未修改其他产品。

## 代码入口与订单规则

- `server/auth/brclio-pay-client.js`：服务端 HMAC 目录读取、下单、查单及原始通知验签。支付请求关闭缓存。
- `server/auth/brclio-pay.js`：固定 SKU 与真实时长规则；复用原账号认证、`state.orders`、`state.operations` 和持久存储事务，新增 `state.paymentEvents` 去重。
- `api/account.js` 的 `payment-catalog`、`payment-create`、`payment-status`：公开启用目录、登录用户下单、本人查单；浏览器继续采用 HttpOnly Cookie 与 Origin 校验，桌面继续使用签名设备证明。
- `api/brclio-payment.js`：独立的原始请求体回调入口；Cloudflare Worker 经原 AccountRuntime 进入相同存储，Vercel 禁止 body parser 重建 JSON，独立 Node 服务也提供相同路由。
- `account-ui.js`、`membership.js`：实时在线报价、改价重新确认及 HTTPS 收银台。原人工扫码、核款发码、兑换和其他登录行为继续可用。

每笔业务订单保存用户确认报价、支付中心的权威金额和支付订单编号、目录版本、真实权益天数与功能快照。目录或下单期间改价时，旧请求不返回收银台链接，用户确认新报价后创建新业务订单。历史通知按订单快照核对，不使用当前目录覆盖承诺。支付中心的权益说明只用于展示，修改真实权益规则仍需同步产品实现。

目录中的 `enabled` 表示产品启用状态，新增 `acceptingPayments` 表示当前能否在线收款。暂停收款仍展示套餐报价，开通窗口会禁用付款按钮并提示刷新或使用人工扫码；服务端也在新建业务订单前核对收款状态，避免已知暂停期间留下无效待支付订单。旧版中心未提供该可选字段时保持兼容，下单错误仍由中心核验。

中心返回 HTTP 503 / `PAYMENTS_DISABLED` 时，产品后端只按这个白名单状态码与错误码转换成 `PAYMENT_SERVICE_DISABLED`，使用固定的“支付中心尚未启用在线收款”提示，不透传上游消息或诊断。旧版桌面也能显示该明确提示。其他未知失败继续返回脱敏的暂不可用错误；不确定请求与暂停前已经创建的业务订单都保留原请求 ID。刷新目录只更新可用性与当前报价，恢复后重试原请求仍保留原报价；若权威下单金额已变化则继续要求重新确认，不覆盖历史快照。暂停收款不妨碍已有订单查单、正式验签通知去重和开通。

**当前正式部署的唯一业务存储继续是原 GitHub 私有仓库。** 验签、产品/环境/币种/SKU/金额/订单核对通过后，去重事件、会员顺延、实收订单及审计记录在同一次 GitHub SHA 比较提交中保存。重复投递返回成功，临时存储故障返回非 2xx 供重试。人工核款和关联激活码接口不能处理自动支付订单。付款返回参数与 `payment-status=PAID` 都不会开通权益，须等待已提交的 webhook；正式接收端拒绝 sandbox。仓库原有独立 Node 服务器的可选 SQLite 模式仅保留兼容并进行隔离测试，本次没有新增数据库、迁移正式存储或改变 Cloudflare AccountRuntime 的存储职责。

## 后端 Secret 与上线边界

后端使用 `BRCLIO_PAY_CLIENT_ID`、`BRCLIO_PAY_API_SECRET`、`BRCLIO_PAY_WEBHOOK_SECRET`，以及非敏感的 `BRCLIO_PAY_BASE_URL`、`BRCLIO_PAY_MODE=live`。返回来源沿用 `AUTH_SITE_ORIGIN`。长期凭证仅由包内 CLI 独占写入任务专用、Git 忽略的 `0600` 文件；临时令牌没有写入文件或源码。

用户随后授权上线发布，v2.0.22 已通过现有三平台原生构建与升级门禁并公开。主 Worker 版本为 `089c78dd-02af-45ae-a82e-78f228a33803`，Pages 部署为 `https://7aec46f0.brclio-xhs-pages.pages.dev`；正式站点健康版本为 2.0.22。三项长期凭证随主 Worker 版本进入可信后端 Secret，原有 24 项 Secret 全部保留。网页在桌面附件公开并核验后部署。GitHub 权威存储和既有 Durable Object / 服务绑定不变，没有新增存储资源；私有 Python、订阅代理、Android 和 Vercel 未重新发布。具体证据见 [v2.0.22 操作审计](releases/v2.0.22-operation-audit.json)。

## 首次接入验证（历史记录）

- `npm test`：Node 1732 通过、13 跳过，Python 47 通过；包括支付专用 17 项、HTTP 与真实 workerd 边界 11 项，以及既有登录、人工订单、发码和存储回归。
- 真实 Electron 支付界面：11 个验证点通过，包括动态报价、改价二次确认、不确定失败重试原订单、支付返回不授予权益、已付但未开通提示、账户切换隔离、介绍页目录及 375px 布局。已查看桌面与手机宽度截图。
- 既有会员界面与商业界面验证通过；后台商业界面 17 个验证点通过，包括在线订单显示、禁止人工开通、原核款/发码/关联与账本行为。
- `npm run build:cloudflare` 与 `npm run cloudflare:check` 通过；后者为 `wrangler deploy --dry-run`，没有部署。
- 使用产品长期 HMAC 的真实只读 `GET /api/v1/catalog` 成功：产品 `xhs-downloader`、`mode=live`、`currency=CNY`，三个启用价格分别为 `3.00`、`19.90`、`69.90`。目录版本为 `1987dfb7406bf6a1363101411e25d86c75f0d2e031a4a2deb25a6cd7f9130ffb`；它是公开目录版本，区别于上面的接入配置版本。
- GitHub fixture 模拟服务验证通知写入失败、提交成功但响应丢失及并发重试，会员、订单、去重和审计最终只提交一次。SQLite 重启测试只验证原有可选独立服务器兼容性，不代表正式存储使用 SQLite。
- 源码与非忽略文件的真实凭证扫描通过；任务凭证文件为 `0600`，并被 Git、Docker、Vercel 及静态/桌面构建边界排除。

正式部署后 [17 项支付检查](releases/v2.0.22-payment-production-verification.json)全部通过：产品后端签名目录与中心目录一致、源码字节一致、匿名下单和查单被拒绝、错误通知被拒绝、返回页面不授予权益。主站 112 个资源、备用站 111 个资源与构建一致；真实匿名浏览器验证 10 项通过，生成 8 张桌面 / 375px 截图，已查看价格页和付款返回页布局。浏览器资料已清理，未允许登录或支付写入。

接入发布时的自动开通证据使用隔离测试账号和假的上游支付，当时没有真实扣款、生产订单或生产会员开通证据。后续受控实付验收记录见下文；后台会员开通不等于所有客户端实际下载权限均已逐平台复测。

### 2026-10-15 故障修复部署（历史）

2026-10-15 付款故障修复已更新主 Worker（版本 `3f9b7432-e366-4124-b1fa-3f9472df2c5c`）及 Pages（`https://a3cdb62a.brclio-xhs-pages.pages.dev`）。修复部署当时生产只读检查再次 17/17 通过，目录返回 `enabled=true`、`acceptingPayments=false`，报价版本与原来一致；当时中心总收款暂停，尚未进行真实扣款或生产会员开通。完整回归为 Node 1736 通过/13 跳过、Python 47 通过，Electron 14 项支付界面检查通过。发布前后 27 项后端 Secret 名称保持一致，未新增存储资源，未发布新的桌面或 Android 安装包；v2.0.22 可收到更新后端的明确暂停提示，新按钮状态在本次网页及后续更新客户端资产中生效。当时已运行客户端的重试操作未取得自动化后的最终截图，不能将模拟界面验证当作已安装客户端完成验收。

### 2026-10-15 临时实付验收（历史）

同日用户重新登录支付宝并授权临时开启后，现场核实正式应用已上线、电脑/手机网站支付已开通，完成一笔 ¥3.00 日付 live 付款。独立支付宝只读查单验签与金额核对通过；支付中心签名查询与私有 GitHub 订单一致为 PAID；对应 outbox 最终 HTTP 200，退出待投递队列。产品生产后台显示同一业务订单的唯一 `brclio-payment-paid` 变更记录及有效期会员，实际生效与到期相差 1 天，无人工补开或激活码。按临时授权在验收后恢复关闭新收款，既有通知和查询继续；长期正常开放另由用户决定。详细单笔验收投影仅留在付款项目被 Git 忽略的本机诊断目录，不把账号、凭证、交易号或完整账本复制进公开接入文档。

## 2026-10-15 正式开放在线收款

上述临时验收结束并恢复关闭后，用户明确确认“正式开放在线收款”，中心正式配置改为 `PAYMENT_ENABLED=true`。实时状态以中心健康接口及产品实时目录的 `acceptingPayments` 为准；刷新报价后可按当前服务端价格购买，原不确定请求继续复用原请求 ID，不把恢复收款当作付款成功或重复开通权益的依据。

正式开放基于上述一笔 ¥3.00 日付及实际后端会员开通证据。其他套餐、手机渠道、各平台客户端的实际使用和退款仍按需分别验收；未新增实付记录，也未因本次正式开放发布新的桌面或 Android 安装包。
