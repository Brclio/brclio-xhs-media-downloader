# Brclio Pay 接入记录

目标产品仅为 `xhs-downloader`，支付中心为 `https://pay.bornforthis.cn`，环境为 `live`。2026-10-15 已应用新增配置；产品代码仍待部署，不能据此认定线上支付或真实权益开通已验收。

## 商品取证与对应关系

| SKU | CNY 金额 | 实际会员时长 | 依据 |
| --- | --- | --- | --- |
| `daily` | `3.00` | 1 天 | `lib/membership-plans.js:4` |
| `monthly` | `19.90` | 30 天 | `lib/membership-plans.js:5` |
| `yearly` | `69.90` | 365 天 | `lib/membership-plans.js:6` |

共享套餐表由 `server/auth/commerce.js` 的原人工订单以及 `server/auth/service.js` 的定向激活码发放读取；`docs/membership-purchase.md:7-13` 明确人民币、时长、按次购买、不自动续费。接入前 `membership.html:69-78` 的静态展示经交叉核对与上述规则一致，现已改为实时在线目录。本轮没有读取真实客户数据或订单。

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

**当前正式部署的唯一业务存储继续是原 GitHub 私有仓库。** 验签、产品/环境/币种/SKU/金额/订单核对通过后，去重事件、会员顺延、实收订单及审计记录在同一次 GitHub SHA 比较提交中保存。重复投递返回成功，临时存储故障返回非 2xx 供重试。人工核款和关联激活码接口不能处理自动支付订单。付款返回参数与 `payment-status=PAID` 都不会开通权益，须等待已提交的 webhook；正式接收端拒绝 sandbox。仓库原有独立 Node 服务器的可选 SQLite 模式仅保留兼容并进行隔离测试，本次没有新增数据库、迁移正式存储或改变 Cloudflare AccountRuntime 的存储职责。

## 后端 Secret 与上线边界

后端使用 `BRCLIO_PAY_CLIENT_ID`、`BRCLIO_PAY_API_SECRET`、`BRCLIO_PAY_WEBHOOK_SECRET`，以及非敏感的 `BRCLIO_PAY_BASE_URL`、`BRCLIO_PAY_MODE=live`。返回来源沿用 `AUTH_SITE_ORIGIN`。长期凭证仅由包内 CLI 独占写入任务专用、Git 忽略的 `0600` 文件；临时令牌没有写入文件或源码。

接入实现阶段没有部署或真实扣款。用户随后授权上线发布，v2.0.22 按现有原生构建门禁准备发布；长期凭证随指定主 Worker 的代码版本进入可信后端 Secret，现有变量与 Secret 保留。网页发布等待桌面附件公开，以保持下载链接有效。具体部署、公开附件与生产只读验证结果分别记录在该版本发布证据中，不能相互替代。不要把 Secret 或整个任务目录打包进前端/客户端；本轮不创建真实付款或执行真实扣款。

## 验证

- `npm test`：Node 1732 通过、13 跳过，Python 47 通过；包括支付专用 17 项、HTTP 与真实 workerd 边界 11 项，以及既有登录、人工订单、发码和存储回归。
- 真实 Electron 支付界面：11 个验证点通过，包括动态报价、改价二次确认、不确定失败重试原订单、支付返回不授予权益、已付但未开通提示、账户切换隔离、介绍页目录及 375px 布局。已查看桌面与手机宽度截图。
- 既有会员界面与商业界面验证通过；后台商业界面 17 个验证点通过，包括在线订单显示、禁止人工开通、原核款/发码/关联与账本行为。
- `npm run build:cloudflare` 与 `npm run cloudflare:check` 通过；后者为 `wrangler deploy --dry-run`，没有部署。
- 使用产品长期 HMAC 的真实只读 `GET /api/v1/catalog` 成功：产品 `xhs-downloader`、`mode=live`、`currency=CNY`，三个启用价格分别为 `3.00`、`19.90`、`69.90`。目录版本为 `1987dfb7406bf6a1363101411e25d86c75f0d2e031a4a2deb25a6cd7f9130ffb`；它是公开目录版本，区别于上面的接入配置版本。
- GitHub fixture 模拟服务验证通知写入失败、提交成功但响应丢失及并发重试，会员、订单、去重和审计最终只提交一次。SQLite 重启测试只验证原有可选独立服务器兼容性，不代表正式存储使用 SQLite。
- 源码与非忽略文件的真实凭证扫描通过；任务凭证文件为 `0600`，并被 Git、Docker、Vercel 及静态/桌面构建边界排除。

以上开通证据使用隔离测试账号和假的上游支付；没有真实扣款、生产订单或生产会员开通证据。上线后仍需验证公网回调到达、真实存储提交及客户端显示实际权益三个环节。
