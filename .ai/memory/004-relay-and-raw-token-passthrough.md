# ADR-004: Relay 中转系统 + X-Raw-Token URL Passthrough

- **日期**: 2026-03-16 ~ 2026-03-20
- **状态**: 已实施
- **关联 commit**: 581a54b, 7e815ba, 831b42f, ab95810, 8efaa34, 63803e1

## 问题

### 问题 1：CF Worker IP 被 grok.com 全面拦截

Cloudflare Worker 的出口 IP 属于数据中心 IP 段，IP 信誉极低。grok.com 的 Cloudflare 保护对所有来自 CF Worker IP 的请求返回 HTTP 403（error code 1010: "The owner of this website has banned your access based on your browser's signature"）。

受影响的所有端点：
- `conversations/new` — 对话/生成
- `upload-file` — 图片上传
- `post/create` — 媒体帖子创建
- `assets.grok.com` — 媒体资源下载

### 问题 2：视频下载 403

远程部署的 CF Worker 无法从 `assets.grok.com` 拉取视频/图片文件，`/images/` 代理路由返回 403。

### 问题 3：住宅代理流量消耗

所有请求都走住宅代理则流量成本过高，需要区分哪些端点真正需要住宅代理。

## 排查过程

### 两层 Cloudflare 检测机制

通过对比不同 IP 类型和端点的测试结果，确认了两层检测：

**第一层：Cloudflare 平台层（IP 信誉）**
- CF Worker IP → 所有 grok.com 端点均 403（IP 信誉太低）
- VPS IP → upload-file、post/create 通过；conversations/new 仍 403
- 住宅 IP → 所有端点通过

**第二层：grok.com 业务层（conversations/new 专属）**
- 即使绕过第一层，conversations/new 还有额外的 anti-bot 检测
- 需要 Chrome TLS 指纹（curl_cffi impersonate="chrome"）+ 住宅 IP 才能通过
- 其他端点无此额外检测

### 关键证据

- 本地 residential IP + Node.js fetch → conversations/new 偶尔通过
- 本地 residential IP + curl_cffi(chrome) → conversations/new 稳定通过
- VPS IP + curl_cffi(chrome) → upload-file 通过，conversations/new 403
- CF Worker IP → 所有端点 403（error code 1010）

## 决策

### 1. Relay 中转系统（解决问题 1）

在日本 VPS 部署 Python Flask 中转服务 `relay_server.py`：
- 使用 `curl_cffi` + `impersonate="chrome"` 模拟 Chrome TLS 指纹
- CF Worker 通过 `relayFetch()` 将所有 grok.com 请求转发到 relay
- relay 通过 `X-Relay-Secret` Header 认证

### 2. 条件代理策略（解决问题 3）

通过 `configs/proxy_list.json` 配置 `proxy_routes`：
- `conversations/new` → 使用住宅代理（anti-bot 需要）
- `upload-file`、`post/create` 等 → VPS 直连（不消耗住宅代理流量）

### 3. X-Raw-Token URL Passthrough（解决问题 2）

X-Raw-Token 模式下，客户端已拥有 SSO token：
- `processor.ts` 的 `isRawToken` 标志控制 URL 改写行为
- `isRawToken === true` → 视频/图片 URL 直接返回 `assets.grok.com` 原始地址
- 客户端自行携带 `Cookie: sso=<token>` 直接下载
- 绕过了 CF Worker 无法访问 `assets.grok.com` 的问题
- `toFullAssetUrl()` 确保 grok 返回的相对路径被补全

## 变更

| 文件 | 变更 |
|------|------|
| `relay_server.py` | 新增：Flask 中转服务，curl_cffi + Chrome TLS，条件代理策略，流式响应 |
| `configs/proxy_list.json` | 格式升级：从 `[{proxy}]` 改为 `{proxy_routes, proxies}` |
| `src/grok/conversation.ts` | 新增 `RelayOption` 接口、`relayFetch()` 通用中转函数 |
| `src/grok/upload.ts` | `uploadImage()` 支持 relay 参数 |
| `src/grok/create.ts` | `createMediaPost()` 支持 relay 参数 |
| `src/routes/openai.ts` | 读取 relay 配置，传递给 upload/create/conversation；传递 `isRawToken` 给 processor |
| `src/grok/processor.ts` | `isRawToken` passthrough：跳过 URL 改写，返回原始 assets.grok.com URL；`toFullAssetUrl()` 辅助函数 |
| `src/routes/admin.ts` | relay 服务器管理 API（增删改查、测试连通性） |
| `grok_example.py` | `download_media()` 检测 assets.grok.com 时自动携带 SSO Cookie |
| `grok_video_example.py` | 新增：轻量视频生成示例（仅远程 + X-Raw-Token） |
| `docs/grok_cf_检测相关验证.md` | 新增：Cloudflare 检测机制分析 |
| `docs/grok_api视频生成说明.md` | 新增：视频 API 接口文档 |

## 遗留问题

- **数据库 Token 模式的视频下载**：`media.ts` 的 `/images/` 代理仍直接 fetch `assets.grok.com`，远程部署被 403。如需支持，需将 media.ts 也接入 relay。
- **CF Worker 不能直接访问 IP 地址**：Cloudflare error 1003，需使用 `sslip.io` 等域名服务提供 hostname。

## 教训

1. **分层检测**：Cloudflare 平台层（IP 信誉）和业务层（自定义 anti-bot）是独立的，需分别应对
2. **最小化代理使用**：只对需要住宅代理的端点使用，其他端点 VPS 直连，大幅降低代理成本
3. **客户端自主下载**：X-Raw-Token 模式下客户端已有认证信息，让客户端直接下载比服务端代理更简单可靠
4. **证据驱动**：不同 IP 类型 × 不同端点的组合测试是确认检测机制的唯一可靠方法，不能依赖推测
