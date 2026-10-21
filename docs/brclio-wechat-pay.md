# Brclio 微信支付接入

2026-10-20 已为当前项目在 `https://paywc.bornforthis.cn` 登记独立产品 `p-2bb6d77a673327a2f8d881bac2d4fe26`。原 `https://pay.bornforthis.cn` / `xhs-downloader` 支付宝配置、回调和历史订单保留。支付中心登记、目标项目网页及生产后端已部署，Mac / Windows v2.0.27 于北京时间 2026-10-21 正式发布并完成生产只读核验。Android 保持 1.0.15。v2.0.36 已增加客户端内 Native 二维码和自动会员结果，见[版本说明](releases/v2.0.36.md)与[操作审计](releases/v2.0.36-operation-audit.json)。本轮未追加实付验收，用户既有成功付款及权益保留。

## 中心配置与金额

- 固定通知：`https://xhs.download.brclio.com/api/brclio-wechat-payment`。
- 唯一返回来源：`https://xhs.download.brclio.com`；网页返回 `/?payment_order=<本项目业务订单 UUID>`，新桌面订单返回 `/payment-return?payment_order=<本项目业务订单 UUID>&client=desktop`，由认证会话类型选择，不信任客户端自行填写的来源。
- 商户实时报出的唯一开放渠道：`native`。仅提供微信跨设备扫码，不提供 H5、公众号 JSAPI 或原生 APP 支付。
- `daily`：300 分，1 天；`monthly`：1990 分，30 天；`yearly`：6990 分，365 天；数量固定为 1，按次购买、不自动续费。
- 商品金额和权益沿用 `lib/membership-plans.js`。支付中心没有商品目录 API；微信展示本地登记报价，服务端下单发送 `expectedTotal`，中心改价后拒绝金额不符的订单并要求核对配置。支付宝继续读取原中心实时目录。

只对授权路径中的这一产品执行 GET / PUT / skill 读取，未修改其他产品、全局商户设置或凭据。产品暂停时，中心拒绝新单；当前接入不具备重新启用产品的能力。

## 服务端与持久化

服务端私有配置使用独立名称，避免覆盖已有支付宝 Secret：

```
BRCLIO_WECHAT_PAY_BASE_URL
BRCLIO_WECHAT_PAY_CLIENT_ID
BRCLIO_WECHAT_PAY_API_KEY
BRCLIO_WECHAT_PAY_WEBHOOK_SECRET
```

API 请求签名原文为 `METHOD + LF + pathAndQuery + LF + timestamp + LF + nonce + LF + rawBody + LF`；通知签名原文为 `timestamp + LF + nonce + LF + rawBody + LF`。独立 `brclio-wechat-pay-client.js` 不复用支付宝签名协议，不透传上游诊断或密钥；二维码仅按下述规则返回已校验的当前用户订单投影。

`payment-catalog` / `payment-create` 通过 `input.provider='wechat'` 选择新渠道；缺省继续支付宝。`payment-resume` / `payment-status` 仅按已保存订单来源选渠道，随后验证原会话及订单所属用户。浏览器延续 HttpOnly Cookie 与 Origin 校验；桌面延续设备签名证明。

业务订单先与登录用户、商品、数量、整数分金额、币种、真实权益快照持久绑定，再以相同业务订单号签名下单。创建响应的中心 ID 落库且核对无误后才能把收银台链接交给客户端；重复请求和跨渠道复用请求 ID 不会创建第二笔收款。客户端在未付原单或创建结果不确定时锁定渠道，恢复原单继续支付。

新的 `brclio_wechat` 订单和 `wechatPaymentEvents` 继续保存在既有 GitHub 私有数据仓库。验签回调与服务端签名查单共用同一原子开通函数，严格核对产品、中心订单、业务单、用户绑定、SKU、数量、金额、CNY、交易号及付款时间。事件 ID、中心订单 ID、微信交易号均去重；收款、会员顺延、事件和审计在同一次 GitHub SHA 比较提交中保存。通知早于订单绑定时返回非 2xx 等待重试；存储失败也不报告成功。浏览器跳转、二维码和客户端成功标志不会授予权益。

会员顺延规则、永久会员不降级、历史人工核款与已有激活码兑换保留。按用户后续要求，已删除人工支付宝/微信购买界面、两张收款码文件及新付款报单；旧请求的既有结果可只读重放，新 `order-create` 返回 `MANUAL_PAYMENT_DISABLED`。静态构建和桌面包白名单排除两张旧码，Cloudflare 两个旧地址明确返回 404 / no-store。管理台与个人订单显示微信渠道，但自动订单禁止人工确认或关联激活码。Cloudflare Worker、AccountRuntime、Vercel 和独立 Node 入口均保留原回调并新增独立原始正文路由。没有增加数据库、存储资源或改变头像、收藏的既定 GitHub 存储边界。

## 当前用户的 Native 二维码（本轮开发，尚未发布）

签名下单、读取和刷新响应中的 `payment.codeUrl` 是微信 Native 二维码载荷，`expiresAt` 是中心给出的绝对到期时间。现有签名客户端已保留这些原始字段，不需要新增中心接口、管理授权或商品配置。公开收银页脚本也按这两个字段展示二维码和倒计时；本轮仅核对该静态脚本，没有新建真实订单来探索协议。

`payment-create`、`payment-resume` 和 `payment-status` 对微信订单统一增加两个顶层字段：

| 字段 | 可展示时 | 不可展示时 |
| --- | --- | --- |
| `qrCodeUrl` | 已校验的 Native 载荷字符串 | `null` |
| `qrCodeExpiresAt` | 中心真实到期时间，规范为 UTC ISO 字符串 | `null` |

先验证原网页或桌面会话、`expectedUserId` 与业务订单归属，再请求支付中心。产品、中心订单 ID、业务订单 ID、SKU、数量、整数分金额和 CNY 必须与持久快照一致；中心 ID 必须已经持久绑定。只有最终重新读取仍为 `pending` / `PENDING` 的当前用户订单可以拿到二维码。创建接口只返回部分订单投影时，先签名读取完整订单，不能用未核对的二维码投影替代身份和金额检查。

二维码载荷只接受 `weixin://wxpay/bizpayurl`，仅允许一个非空 `pr` 参数，禁止其他地址、userinfo、端口、片段、空白及控制字符。载荷上限 2048 字符，`pr` 仅允许 1–1024 个 ASCII 字母、数字、下划线或连字符。到期时间必须有明确时区且在服务端当前时间之后；不为缺失或异常时间编造有效期。二维码缺失、格式异常、已过期、订单 `PAID` 或 `CLOSED` 时，两字段都返回 `null`。原 `checkoutUrl` 保留为浏览器收银台兜底，支付宝行为不变。

`payment-status` 只对原中心订单签名读取和必要刷新，不调用下单接口。恢复和重试继续复用同一个业务订单号，中心幂等规则不变。查询过程中收到已付款回调时，以最后持久读取的状态为准，返回已确认状态并撤销二维码；查询和回调仍使用同一个原子幂等开通函数。持久化失败返回错误，不能把二维码、客户端计时结束或回跳当作付款成功。

这两项是当前账号响应中的短期敏感数据，沿用 `/api/account` 的 `no-store`、Origin、Cookie 或桌面签名校验。不写入业务订单、操作重放结果或审计记录，也不出现在公开目录、历史订单列表和错误诊断中。客户端应在内存中使用本地二维码编码器，避免第三方二维码 URL；清码不应删除原业务订单或自动新建付款。服务端确认付款后，再由现有账号和权限刷新流程显示会员结果。

本轮隔离测试覆盖归属越权、中心产品与金额篡改、异常载荷和时间、过期清码、部分下单响应、回调与查单竞态、持久化失败及原单重试；真实 Worker → AccountRuntime → 签名支付客户端 → GitHub CAS 的隔离链路也验证无缓存响应、查单不创建新单、已付款清码和只开通一次。本轮没有新实付或生产会员写入，不要求用户为界面验收重复付款，原已付款订单与权益保留。

## 验证与发布阶段

- 隔离测试覆盖新旧签名、金额/身份/产品篡改、原始正文验签、早到通知、重复交易、并发 CAS、存储失败及响应丢失、查询与通知乱序、会员顺延和永久权益。实际 workerd 测试经过 Worker → AccountRuntime → 付款服务 → GitHub CAS 完整链路。
- Chromium 验证包含支付宝保留、渠道切换、失败重试、微信原单恢复与 375px Native 提示。桌面 UI 源码兼容不等于已安装客户端已更新。
- 使用当前产品业务密钥的真实接口测试证实签名下单/查单成功，金额篡改返回 `CATALOG_PRICE_CHANGED`，同业务号重复创建返回同一中心订单。只创建一笔 300 分未付款联调单，没有扫码付款、真实到账或生产会员开通验收。
- 首次部署检查发现 Wrangler 登录身份不匹配；用户重新登录后，已确认可访问固定生产账号 `c8b059429c868f6d0e528f9e10325f46`。没有修改 `account_id` 或在其他账号创建替代资源。
- 业务密钥仅保存在 Git 忽略的本机 `0600` 文件及生产后端 Secret，未写入客户端、构建或公开文档；临时管理 Token 未写入文件，临时管理会话已清理。原有 27 个后端 Secret 保留，新增独立微信四项后为 31 个；生产存储与服务绑定保持一致。后续 v2.0.27 发布未再次改写 Secret，也未发布新 Android 包。
- 全面核查补充了在线微信与历史人工补录共用的交易唯一性检查，并修复启动查单未完成时误建新单的问题。本地最终回归为 Node 1865 通过、13 跳过、0 失败，Python 47 通过；支付 Chromium 32 项、会员 12 项及历史订单与评价 17 项通过。
- v2.0.27 的三平台原生构建、完整打包、安装升级与重启门禁均通过，11 个公开附件、SHA-256、新旧更新器及历史发布附件已核验。网站与后端已部署；线上支付 29 项、接口 58 项、112 个头像账号资源和主站 / 备用站 / 部署地址文件一致性核验通过。见[版本说明](releases/v2.0.27.md)、[公开附件核验](releases/v2.0.27-publication-verification.json)及[发布操作审计](releases/v2.0.27-operation-audit.json)。用户已安装的桌面客户端需自行升级，隔离环境的安装验收不表示用户本机已更新。

已先核对既有 Secret 名称、资源和部署，再使用 Wrangler 的 `--keep-vars --secrets-file` 将四项微信配置与新 Worker 版本一起发布。后续人工流程移除、旧码 404 修正与 v2.0.27 发布使用 `--keep-vars`，保留全部 31 项 Secret；Pages 明确使用上述账号，只更新既有 `brclio-xhs-pages`。首次网页接入阶段见[初次操作审计](releases/2026-10-20-wechat-operation-audit.json)及[初次线上支付验证](releases/2026-10-20-wechat-production-verification.json)，正式版本结果见上方 v2.0.27 记录。真实付款仍由用户在自己的订单扫码完成。
