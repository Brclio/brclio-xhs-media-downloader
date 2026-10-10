# 软件更新网络配置

管理后台 `/admin/` 的“更新网络”页可保存、停用和更换更新订阅。管理员每行填写一个 HTTPS 订阅地址，最多保存 8 个不同来源，并填写变更说明后保存；客户端在下次检查更新时读取最新配置。地址默认遮挡，可点击“显示 / 编辑”查看和编辑列表，退出管理会话后清除表单内容。

这是分发给客户端使用的订阅。地址及其凭据会提供给软件，用户可以从运行时文件、配置接口或网络请求提取，因此应使用专门的更新订阅。真实订阅不得写入仓库源码、示例配置、日志或测试夹具。

所有操作通过 `POST /api/account`，`Content-Type: application/json`：

| action | 访问 | input | 返回字段 |
| --- | --- | --- | --- |
| `update-proxy-config` | 匿名读取 | `{}` | `proxyConfig` |
| `admin-update-proxy-config` | 管理员会话 | `{}` | `proxyConfig` |
| `admin-save-update-proxy-config` | 管理员会话及可信 Origin | `{enabled, subscriptionUrls: [], reason, requestId, expectedRevision?}` | `saved`, `appliedRevision`, `proxyConfig`, `replayed?` |

```json
{
  "proxyConfig": {
    "enabled": true,
    "subscriptionUrls": [
      "https://subscription.example.com/sub?token=EXAMPLE_ONLY",
      "https://second.example.com/sub?token=EXAMPLE_ONLY"
    ],
    "subscriptionUrl": "https://subscription.example.com/sub?token=EXAMPLE_ONLY",
    "revision": 1,
    "updatedAt": "2026-10-02T00:00:00.000Z"
  }
}
```

响应保持 `Cache-Control: no-store`。匿名读取允许尚未登录的客户端获取软件更新配置。管理员读取与保存沿用现有 HttpOnly 管理员会话、管理员邮箱白名单、Origin 校验和原子存储事务。

`subscriptionUrls` 是完整的订阅列表，保存时去除两侧空白、规范化 URL 并去重。响应同时保留 `subscriptionUrl`，其值等于列表第一项，无订阅时为空字符串。旧存储中的单个 `subscriptionUrl` 和旧客户端提交的单地址字段仍兼容；同一次提交含有两个字段时，以 `subscriptionUrls` 为准。

订阅仅来自管理后台，发行包不包含默认订阅或构建时订阅回退。`revision: 0` 表示后台从未保存配置，客户端不启用内置代理，软件更新使用系统网络。保存后版本从 1 开始递增；`revision > 0` 且 `enabled: false` 表示管理员已明确停用内置代理，软件更新同样使用系统网络。管理界面停用时保留列表供再次启用，也可在编辑时清空列表。启用必须填写至少一个有效订阅。

桌面客户端只缓存后台已经保存的配置（`revision > 0`）。配置接口暂时不可用时，可继续使用最后获取的后台配置；没有有效缓存时明确报告“无法获取软件更新网络配置”，下载操作按下述规则自动重试获取配置，避免把配置故障误当成管理员停用后静默直连。后台明确返回未配置或停用状态时，以该状态为准，使用系统网络。

`expectedRevision` 用于防止多个管理员覆盖他人刚保存的配置，冲突返回 `PROXY_CONFIG_CONFLICT`，刷新后可重新编辑。相同 `requestId` 及相同 input 的网络重试不重复递增版本或写审计。旧操作重试返回原 `appliedRevision` 和目前的 `proxyConfig`，避免恢复过时的订阅。

持久化字段是现有业务状态的 `updateProxyConfig`，兼容旧 schemaVersion 1。Vercel 与 Cloudflare 沿用私有 GitHub 业务存储；独立 Node 服务沿用 SQLite 存储，重启和存储迁移保留该字段。审计只保留各个订阅的来源域名，隐藏全部路径及查询参数，变更说明内的地址同样脱敏；操作去重记录保存版本号和 HMAC，不另存订阅凭据。

服务器验证每个规范化后长度不超过 4096 的公开 HTTPS DNS 地址，拒绝 IP 字面量、局域网域名、用户名密码、片段及控制字符。订阅列表最多 8 项，该保存接口允许 49,152 字节的请求体。保存只更新配置，不会在服务器发起订阅请求；节点延迟测试和操作期间的代理生命周期由客户端负责。

客户端在每次更新网络操作开始时先检测系统代理。系统代理已开启时，更新沿用系统网络，不抓取内置代理订阅、不测速，也不启动内置内核。Android 同时识别当前应用使用的 VPN 网络。桌面使用独立 Electron 会话读取系统代理规则，保持系统代理、默认会话和其它业务连接不变。

需要启用内置代理时，每次更新操作抓取各个订阅来源，合并可用节点后选择实测延迟最低的节点。单个来源抓取失败时可继续使用其余成功来源。桌面客户端保留可用节点的延迟排序：连接失败，或更新服务器返回 HTTP 403、429、502、503、504 时，按排序切换到下一最快节点重试，以处理节点出口 IP 被限流或暂时不可用的情况。切换仍限于软件更新允许的服务器；取消或结束操作会关闭该更新会话和代理进程。

桌面通过内置代理下载安装包时，网络中断、超时或可恢复的代理故障会自动续传。每次失败后关闭上一轮更新会话，等待 1 秒，再重新读取代理配置并建立连接；关于页面和更新弹窗实时显示连续失败次数及已保存的下载进度。同一次下载连续失败 10 次（含首次失败）后停止自动重试，由用户点击“继续下载”或“重试下载”开始新一轮，次数重新计算。暂停、退出软件或手动关闭内置代理会停止重试并保留进度。系统网络下载沿用原有手动重试；安装包校验、地址安全、缓存或磁盘错误不会自动重试。

尚无配置缓存时的配置获取故障也计入同一轮连续失败次数，最多尝试 10 次。缓存文件确实因权限不足而无法读写时，显示更新缓存权限提示并保留已下载字节，等待用户处理权限后重试。

开发验证：`npm run desktop:verify:update-retry` 在临时用户目录中使用确定性的断流请求，串联真实更新管理器、IPC、原始 preload 和界面，验证 1–10 次失败、停止、手动续传和清理；该模式不访问订阅，已加入桌面构建检查。显式执行 `npm run desktop:verify:update-retry -- --live` 则使用真实后台配置、订阅、已准备的 Mihomo 运行时和 GitHub 安装包，断开本次测试拥有的代理 10 次后继续下载并校验。真实验证需要可用的后台配置和本平台运行时，最多运行 60 分钟，会下载一个完整安装包；仅修改隔离测试会话的代理检测，不安装软件或改动用户的系统代理。结果和截图路径在命令输出中给出，临时配置及安装包在结束时清理。

桌面“关于软件”的升级区域和更新弹窗、Android 的升级区域提供“关闭软件内置代理”按钮。它会取消正在准备或使用内置代理的更新请求，并关闭内核、连接和临时配置；桌面保留已下载进度，Android 的未完成安装包仍需重新下载。手动关闭状态持久保存，重新打开软件或后台自动检查均不恢复。用户下一次明确点击检查更新、下载更新或浏览器下载安装包时，已接受的新操作自动恢复内置代理资格；重复点击或被拒绝的操作不恢复。检查、下载或下载地址获取完成、失败、取消后，内置代理自动关闭。该按钮不关闭用户的系统代理或 VPN，也不取消只使用系统网络的更新请求。

内置代理只服务客户端内部的更新请求。使用“浏览器下载安装包”等外部浏览器回退时，客户端通过更新会话获取最新下载地址，然后关闭该会话；外部浏览器的实际下载使用浏览器自身的网络设置，不能自动继承客户端代理。常规内置下载和本地安装不需要更改系统代理或浏览器代理。

## 部署后配置与核验

Cloudflare 后端和管理页需要一起发布。现有生产 Secrets 保持不变：先按 [Cloudflare 部署说明](cloudflare-deployment.md) 完成本地构建和 dry-run，再部署仓库根目录的主 Worker，最后运行 `npm run cloudflare:deploy:pages` 重建并发布网关静态资源。只发布 Pages 不会更新 `/api/account` 的后台逻辑。现有 Pages 项目沿用 Direct Upload，命令和顺序见 [网关说明](../cloudflare/pages/README.md)；此类部署可通过 [Wrangler Pages deploy](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) 执行。

使用现有管理员登录会话在正式域名 `/admin/` 保存列表，或运行 [管理工具](../scripts/manage-update-proxy-config.mjs)。工具默认只读，不发送验证码或创建会话；只有显式 `--apply` 才执行后台保存。它仅输出启用状态、配置版本和来源数量，不输出订阅或管理员会话。

订阅输入文件使用 `{enabled, subscriptionUrls, reason}`，已有管理员会话文件使用 `{adminSession: "已有会话令牌"}`。将两个 JSON 文件保存在仓库外的私有目录，目录权限为 `700`，文件权限为 `600`；不要把地址或令牌放到命令参数、聊天或日志中。

```sh
# 默认只读：检查正式后台是否已有配置
node scripts/manage-update-proxy-config.mjs

# 使用已有管理员会话读取配置并验证管理员访问权限，仍不写入
node scripts/manage-update-proxy-config.mjs --session-file /私有目录/admin-session.json

# 已获得配置授权且后台部署完成后，保存并通过公开客户端接口核验
node scripts/manage-update-proxy-config.mjs --apply --verify \
  --config-file /私有目录/update-network.json \
  --session-file /私有目录/admin-session.json \
  --operation-file /私有目录/update-network-operation.json
```

`operation-file` 仅保存请求 ID、原配置版本和输入摘要，首次写入权限为 `600`。响应不确定时使用同一文件及相同输入重新运行，沿用服务端去重机制；下一次不同配置使用新的操作文件。工具通过现有管理员 API、可信 Origin 和 HttpOnly 会话对应的 Cookie 保存，不直接改写 GitHub 业务状态。若没有有效管理员会话，应按现有登录流程取得会话后再保存，工具不会绕过登录门禁。
