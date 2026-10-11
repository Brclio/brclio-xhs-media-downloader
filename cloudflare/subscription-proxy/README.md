# 免费网页抓取代理

此私有 Worker 使用 SQLite Durable Object，在 Workers Free 中直接实现 VLESS/WebSocket 与经证书链和域名校验的 TLS。无需 Mihomo、Docker、Container 或套餐升级。它没有公开路由，只有主 Worker 的 `SUBSCRIPTION_PROXY` 服务绑定可以调用。

订阅地址保存在主 Worker 的 Secret `WEB_PARSE_PROXY_SUBSCRIPTION_URL`，作为初始配置。管理员可在后台「网页抓取代理」启停、更换地址；保存后的配置使用原 `AUTH_SECRET_PEPPER` 派生密钥加密，沿用原业务状态仓库。后台不回显地址，不记录节点凭据。

每次笔记抓取都读取最新订阅，对兼容连接入口进行有界 HTTPS 测速，使用其中延迟最低的入口。媒体分块可复用同一订阅摘要对应的测速结果，最多 60 秒。Worker 使用经验证的 WSS 主机名，无法独立指定 Cloudflare 优选 IP 与 TLS SNI；相同主机、端口、路径的优选 IP 节点合并为一条兼容入口，因此不能把入口测速描述为每个优选 IP 的独立测速。

只支持 VLESS + WebSocket + TLS。订阅中其它协议、跳过证书校验、无法安全表示的入口均拒绝。目标仅限指定小红书笔记、媒体 CDN 与固定测速 URL；不会接受任意目标。验证码不触发节点轮换或自动解题。网页抓取失败时补一次直连，两条路径仍失败才沿用受限人工验证流程。

Python 的执行在用户浏览器的 Pyodide Web Worker 中。后台只抓取来源并重建所需的非执行数据；原网页脚本、订阅、节点配置和会员原视频地址不发送给浏览器。图片及普通视频由新网页专用接口获取，会员原视频守卫保持原流程。现有桌面本地解析、旧 Node/Python API 和更新代理配置保持各自原入口。

本地核验和部署：

```sh
npm ci --prefix cloudflare/subscription-proxy
npm test --prefix cloudflare/subscription-proxy
npx wrangler deploy --config cloudflare/subscription-proxy/wrangler.jsonc
# Then deploy the main Worker and Pages using the existing production profile.
```

正式发布使用已核对的生产账号与专用 Wrangler profile。不要把订阅值放入命令参数、配置文件、构建产物或 Git。临时验收入口必须具备过期时间和随机凭据，并在验收结束后删除。免费额度用完可能失败；部署免费服务不等于小红书保证放行，真实笔记、图片和视频必须分别验收。
