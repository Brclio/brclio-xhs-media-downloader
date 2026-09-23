# 账号业务数据结构与 API

唯一持久化文件为私有业务仓库 `state/accounts.json`。`schemaVersion: 1`。时间均为服务器 UTC ISO 8601；展示层转换为当地时间。所有跨记录操作由 `server/auth/store.js` 的 SHA 乐观并发事务提交，最多 6 次尝试，单文件安全容量上限为 900,000 字节。

## 顶层结构

| 字段 | 内容与索引 |
| --- | --- |
| `users` | UUID → 用户邮箱、注册时间、会员；保存角色快照，但管理员权限每次依据平台邮箱名单重新判断 |
| `sessions` | HMAC 会话令牌 → 用户 ID、公开会话 ID、客户端类型、创建/撤销时间、设备 ID、公钥；没有自动到期字段 |
| `devices` | UUID → 用户 ID、公钥/指纹、二次摘要后的稳定标识、系统、名称、绑定时间、最近校验时间、撤销状态 |
| `otps` | HMAC(客户端类型:邮箱) → 验证码摘要、随机发送 ID、创建/过期/消费时间、失败次数、校验记录、发送状态 |
| `otpHistory` | 被下一次验证码替代的旧记录，保留其校验轨迹 |
| `codes` | UUID → 激活码摘要、会员类型/天数、兑换截止时间、创建管理员、状态、兑换用户/时间、兑换请求 ID；套餐码另有指定收件账号、套餐与邮件状态 |
| `operations` | HMAC(管理员 ID:请求 ID) → 操作类型、输入摘要、时间、已提交返回结果；批次结果不保存原码 |
| `rateLimits` | 邮箱桶/IP 摘要桶/全局桶 → 最近一小时发送时间；Gmail 点号和加号别名共享发送桶 |
| `audit` | UUID、动作、操作者 ID/邮箱、目标 ID、服务器时间、原因、变更前后内容 |
| `mailStatus` | 最近一次发送结果与时间，不包含邮件凭据、验证码或收件正文 |

会员字段：`{type: "none" | "duration" | "permanent", startsAt, expiresAt}`。普通会员和永久会员 `expiresAt` 均为 `null`，必须结合 `type` 判断，不能将空日期直接解释成永久会员。响应额外计算 `active`，不会持久保存客户端提供的会员布尔值。

`devices.status` 为 `active` 或 `revoked`。撤销记录永久保留。未获绑定的桌面会话可以保留 `pendingDevice`，包含待授权的新公钥及必要设备元数据；只向管理员展示公开 `sessionId`、名称、系统和申请时间。定向恢复要求新密钥指纹从未绑定、会话仍有效、名额充足。管理员只能恢复选定会话，旧密钥永不因恢复操作重新有效。

`codes.status` 为 `unused`、`used`、`void`；过期根据 `redeemBy` 与服务器时间派生。通用激活码的 160 位随机原码仅在首次生成响应中出现，新码格式为 `Brclio-` 加 40 位大写十六进制。生成摘要与兑换校验均先去除首尾空白并统一为大写，因此兑换时不区分大小写。已发放的 `XHS-` 旧码继续按原摘要校验，无需重发或迁移数据。数据库和审计只保存摘要/ID/元数据。所有 HMAC 使用服务端 `AUTH_SECRET_PEPPER` 和不同用途前缀隔离。

指定邮箱的套餐码在同一 `codes` 结构中追加 `recipientId`、`recipientEmail`、`planId`、`planName`、`priceCents`、`derivationVersion: 1` 和 `delivery`。原码由随机记录 UUID、收件账号 ID、套餐 ID 和独立 HMAC 用途 `targeted-activation-v1` 派生，截取 160 位；服务端可恢复以重试邮件，无需明文持久化。摘要与派生版本不在公开管理员列表中返回；生成重试仍仅对经验证的管理员返回原码。已有通用码结构无需迁移。

`delivery` 初始为 `null`，发送时包含 `status: sending/sent/failed`、固定 `deliveryId`、`attempts`、`attemptedAt`、`sentAt`；发送预留另有 `leaseUntil` 和不公开的随机 `attemptId`，结束后记录 `finishedAt` 并删除预留。`failed` 表示未确认接受，可能已投递，应重试原码。邮件成功与否不改变 `codes.status` 或会员权益。

## 请求边界

所有请求发往 `POST /api/account`，`Content-Type: application/json`，请求体上限 16 KiB：

```json
{"action":"me","input":{},"proof":{"timestamp":0,"nonce":"uuid","signature":"base64"}}
```

桌面用 Bearer 随机会话令牌，管理员用 `__Host-xhs-admin` HttpOnly/Secure/SameSite Cookie。管理员流程严格验证 `AUTH_SITE_ORIGIN`，角色每次服务端检查。桌面 Ed25519 签名覆盖动作、时间戳、随机数、精确 JSON 输入和会话令牌；允许 120 秒时钟窗口。私钥仅存在系统安全存储加密的本地文件中。

| 动作 | 输入要点 |
| --- | --- |
| `send-code` | `email`, `client: desktop/admin` |
| `verify-code` | `email`, `code`, `client`；桌面另含 `device: {publicKey, stableIdHash, name, platform}` 并签名 |
| `me` / `authorize` | 读取账号 / 检查 `feature` 的实时权益及设备授权 |
| `logout` | 撤销当前会话，保留设备绑定 |
| `redeem` | `code`, 持久 `requestId` |
| `admin-users` / `admin-user` | 搜索 `query` / 查看 `userId` 及会员历史、设备、待授权会话 |
| `admin-membership` | `userId`, `operation: days/until/adjust/permanent/cancel`, `days` 或 `expiresAt`, `reason`, `requestId` |
| `admin-unbind` | `userId`, `deviceId`, `reason`, `requestId` |
| `admin-restore-device` | `userId`, 待授权 `sessionId`, `reason`, `requestId` |
| `admin-generate-codes` | `type: duration/permanent`, `days`, `count: 1..100`, 可选 `redeemBy`, `reason`, `requestId` |
| `admin-generate-codes`（套餐码） | `userId`, `planId: daily/monthly/yearly`, `count: 1`, 可选 `redeemBy`, `reason`, `requestId`；天数、价格由共享目录确定 |
| `admin-send-activation` | `codeId`, `reason`, `requestId`；收件地址与原码均由后端取得，不接收改投地址 |
| `admin-codes` / `admin-void-code` | 查询 `query/status` / 作废 `codeId`，附原因与请求 ID |
| `admin-audit` / `admin-status` | 查看操作日志 / 实际 GitHub 读取和邮件配置/连接检查结果 |

成功响应 `ok: true`，失败响应 `ok: false, error: {code,message}`；均有 `serverTime`，禁止缓存。设备/会员不足返回 403，会话无效 401，限流 429，存储故障 503。普通用户没有解绑、角色写入或会员写入接口。

## 事务和重试

- 验证码消费、账号创建、设备名额检查与占用、会话创建：一次 SHA 提交。并发验证仅一个成功。
- 激活码置为已用与会员权益增加：一次 SHA 提交。重放同一账号同一请求 ID 返回已有结果；不同请求或用户不能再次兑换。
- 管理员操作、设备撤销/恢复、审计与幂等回执：一次 SHA 提交。相同请求 ID 改变输入会被拒绝。
- 409 冲突重新读取并重新执行业务判断；GitHub 超时、限流、写入确认丢失均不返回假成功。已提交但响应丢失时，使用原请求 ID 恢复确认。
- 邮件先持久化发送预留和限流，再联系服务商，最后持久化发送结果。失败或未确认的验证码不能消费。邮件服务与 GitHub 不存在跨服务原子事务，响应异常需按提示重新发送，不承诺邮件只投递一次。
- 套餐激活码邮件持久化两分钟发送预留，跨实例共享；已确认发送不会再次投递。失败或预留过期后可显式重试，同一记录保持相同激活码和 `deliveryId`，不重复发码或续期。未确认的完成写入返回 `ACTIVATION_DELIVERY_UNCONFIRMED`，有效预留返回 `ACTIVATION_SEND_IN_PROGRESS`；不能据此重新生成会员权益。兑换始终校验指定账号。
- 高频授权读取不缓存权益；设备校验时间每天最多写一次。`me` 仅只读且永不绑定设备。

不会收集或保存小红书 Cookie、下载文件、任务记录、原始硬件 ID、GitHub 令牌、SMTP 密码、设备私钥、明文会话令牌或明文验证码。数据仓库访问权限、备份以及 Git 历史的保留由部署管理员管理。
