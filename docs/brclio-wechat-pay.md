# Brclio 微信支付接入

2026-10-20 已为当前项目在 `https://paywc.bornforthis.cn` 登记独立产品 `p-2bb6d77a673327a2f8d881bac2d4fe26`。原 `https://pay.bornforthis.cn` / `xhs-downloader` 支付宝配置、回调和历史订单保留。支付中心登记、目标项目网页及生产后端现已部署。真实微信付款与生产会员开通仍未验收；桌面安装包及 Android 未重新发布。

## 中心配置与金额

- 固定通知：`https://xhs.download.brclio.com/api/brclio-wechat-payment`。
- 唯一返回来源：`https://xhs.download.brclio.com`；返回页 `/?payment_order=<本项目业务订单 UUID>`。
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

API 请求签名原文为 `METHOD + LF + pathAndQuery + LF + timestamp + LF + nonce + LF + rawBody + LF`；通知签名原文为 `timestamp + LF + nonce + LF + rawBody + LF`。独立 `brclio-wechat-pay-client.js` 不复用支付宝签名协议，不透传上游诊断、密钥或二维码地址。

`payment-catalog` / `payment-create` 通过 `input.provider='wechat'` 选择新渠道；缺省继续支付宝。`payment-resume` / `payment-status` 仅按已保存订单来源选渠道，随后验证原会话及订单所属用户。浏览器延续 HttpOnly Cookie 与 Origin 校验；桌面延续设备签名证明。

业务订单先与登录用户、商品、数量、整数分金额、币种、真实权益快照持久绑定，再以相同业务订单号签名下单。创建响应的中心 ID 落库且核对无误后才能把收银台链接交给客户端；重复请求和跨渠道复用请求 ID 不会创建第二笔收款。客户端在未付原单或创建结果不确定时锁定渠道，恢复原单继续支付。

新的 `brclio_wechat` 订单和 `wechatPaymentEvents` 继续保存在既有 GitHub 私有数据仓库。验签回调与服务端签名查单共用同一原子开通函数，严格核对产品、中心订单、业务单、用户绑定、SKU、数量、金额、CNY、交易号及付款时间。事件 ID、中心订单 ID、微信交易号均去重；收款、会员顺延、事件和审计在同一次 GitHub SHA 比较提交中保存。通知早于订单绑定时返回非 2xx 等待重试；存储失败也不报告成功。浏览器跳转、二维码和客户端成功标志不会授予权益。

会员顺延规则、永久会员不降级、历史人工核款与已有激活码兑换保留。按用户后续要求，已删除人工支付宝/微信购买界面、两张收款码文件及新付款报单；旧请求的既有结果可只读重放，新 `order-create` 返回 `MANUAL_PAYMENT_DISABLED`。静态构建和桌面包白名单排除两张旧码，Cloudflare 两个旧地址明确返回 404 / no-store。管理台与个人订单显示微信渠道，但自动订单禁止人工确认或关联激活码。Cloudflare Worker、AccountRuntime、Vercel 和独立 Node 入口均保留原回调并新增独立原始正文路由。没有增加数据库、存储资源或改变头像、收藏的既定 GitHub 存储边界。

## 验证与发布阶段

- 隔离测试覆盖新旧签名、金额/身份/产品篡改、原始正文验签、早到通知、重复交易、并发 CAS、存储失败及响应丢失、查询与通知乱序、会员顺延和永久权益。实际 workerd 测试经过 Worker → AccountRuntime → 付款服务 → GitHub CAS 完整链路。
- Chromium 验证包含支付宝保留、渠道切换、失败重试、微信原单恢复与 375px Native 提示。桌面 UI 源码兼容不等于已安装客户端已更新。
- 使用当前产品业务密钥的真实接口测试证实签名下单/查单成功，金额篡改返回 `CATALOG_PRICE_CHANGED`，同业务号重复创建返回同一中心订单。只创建一笔 300 分未付款联调单，没有扫码付款、真实到账或生产会员开通验收。
- 首次部署检查发现 Wrangler 登录身份不匹配；用户重新登录后，已确认可访问固定生产账号 `c8b059429c868f6d0e528f9e10325f46`。没有修改 `account_id` 或在其他账号创建替代资源。
- 业务密钥仅保存在 Git 忽略的本机 `0600` 文件及生产后端 Secret，未写入客户端、构建或公开文档；临时管理 Token 未写入文件，临时管理会话已清理。原有 27 个后端 Secret 保留，新增独立微信四项后为 31 个；生产存储与服务绑定保持一致。未构建或发布新的桌面安装包或 Android 包。
- 最终完整回归为 Node 1856 通过、13 跳过、0 失败，Python 47 通过；随后针对两条旧码路径的 Worker / Pages / 部署边界 22 项回归通过。

已先核对既有 Secret 名称、资源和部署，再使用 Wrangler 的 `--keep-vars --secrets-file` 将四项微信配置与新 Worker 版本一起发布。后续人工流程移除与旧码 404 修正使用 `--keep-vars` 发布；Pages 明确使用上述账号，只更新既有 `brclio-xhs-pages`。最终部署与生产检查见[操作审计](releases/2026-10-20-wechat-operation-audit.json)及[线上支付验证](releases/2026-10-20-wechat-production-verification.json)。真实付款仍由用户在自己的订单扫码完成。
