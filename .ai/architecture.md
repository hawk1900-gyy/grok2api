# Grok2API 系统架构

## 概述

grok2api 将 Grok.com 网页端的内部 API 逆向封装为 OpenAI 兼容格式，部署在 Cloudflare Workers 上。
支持文本对话、图片生成、视频生成（文生视频 + 图生视频）、多图对话（最多 7 张 + @图N 引用）。

所有发往 grok.com 的请求通过 VPS 上的 relay 中转服务转发，绕过 Cloudflare Worker IP 被拦截的问题。

## 技术栈

| 组件 | 技术 |
|------|------|
| Runtime | Cloudflare Workers (V8 isolate) |
| Framework | Hono |
| Database | Cloudflare D1 (SQLite) |
| Cache | Cloudflare Workers KV |
| Language | TypeScript (strict, exactOptionalPropertyTypes) |
| 前端 | 静态 HTML (app/template/) |
| Relay | Python Flask + curl_cffi (VPS 部署) |
| 住宅代理 | Decodo（仅 conversations/new 使用） |

## 核心模块

```
src/
├── index.ts                 # 入口，路由注册 + Cron 调度
├── routes/
│   ├── openai.ts            # OpenAI 兼容 API (/v1/chat/completions, /v1/models)
│   ├── admin.ts             # 管理后台 API（含 relay 管理）
│   └── media.ts             # 媒体代理 (/images/)
├── grok/
│   ├── conversation.ts      # 构建 Grok 对话 payload + relayFetch 通用中转 + @引用解析
│   ├── processor.ts         # 解析 Grok NDJSON 流响应 + X-Raw-Token passthrough
│   ├── models.ts            # 模型映射配置
│   ├── create.ts            # 创建媒体帖子 (/rest/media/post/create，走 relay)
│   ├── upload.ts            # 图片上传（走 relay）
│   ├── headers.ts           # 请求头生成（含 x-statsig-id 动态生成）
│   ├── retry.ts             # 重试逻辑
│   └── rateLimits.ts        # 速率限制解析
├── repo/
│   ├── tokens.ts            # Token 管理（选择、失败记录、冷却）
│   ├── apiKeys.ts           # API Key 管理
│   ├── logs.ts              # 请求日志
│   └── cache.ts             # 缓存管理
├── settings.ts              # 全局/Grok 设置加载与保存
├── auth.ts                  # API 鉴权
└── env.ts                   # 环境类型定义

relay_server.py              # VPS 中转服务（Python Flask）
configs/proxy_list.json      # 代理路由 + 住宅代理列表配置
grok_video_example.py        # 轻量视频生成示例（X-Raw-Token 模式）
grok_example.py              # 完整功能示例（多模式）
```

## 网络架构

```
                                 ┌──────────────────────────┐
                                 │    grok.com / assets.grok │
                                 │    (Cloudflare 保护)       │
                                 └─────────┬────────────────┘
                                           │
                              ┌────────────┴─────────────┐
                              │     relay_server.py       │
                              │     (日本 VPS, Flask)      │
                              │  curl_cffi + Chrome TLS   │
                              │  住宅代理(仅/conversations/new)│
                              └────────────┬─────────────┘
                                           │
                              ┌────────────┴─────────────┐
                              │   Cloudflare Worker       │
                              │   grok2api (Hono)         │
                              │   D1 + KV Cache           │
                              └────────────┬─────────────┘
                                           │
                              ┌────────────┴─────────────┐
                              │       客户端               │
                              │  (grok_example.py 等)     │
                              └───────────────────────────┘
```

## Relay 中转系统

### 为什么需要 relay

Cloudflare Worker 的出口 IP 信誉极低（数据中心 IP），grok.com 的 Cloudflare 保护会拦截所有来自 CF Worker IP 的请求（HTTP 403, error code 1010）。所有 grok.com 端点均受影响：conversations/new、upload-file、post/create。

### relayFetch 通用函数

`conversation.ts` 中导出的 `relayFetch()` 是所有 grok.com 请求的统一入口：

```typescript
export async function relayFetch(
  targetUrl: string,
  init: { method: string; headers: Record<string, string>; body: string },
  relay?: RelayOption | undefined,
): Promise<Response>
```

当 relay 配置存在时，将请求 JSON 封装后 POST 到 `relay.url/relay`；否则直连。

以下模块均通过 relayFetch 发起请求：
- `conversation.ts` → `sendConversationRequest()` (conversations/new)
- `upload.ts` → `uploadImage()` (upload-file)
- `create.ts` → `createMediaPost()` (post/create)

### relay_server.py 架构

VPS 上运行的 Flask 服务，接收 CF Worker 转发的请求：

| 端点 | 说明 |
|------|------|
| `POST /relay` | 转发请求到 grok.com，支持流式响应 |
| `GET /relay/ping` | 健康检查 + 代理列表状态 |

**条件代理策略**：通过 `configs/proxy_list.json` 中的 `proxy_routes` 配置哪些路径需要住宅代理：

```json
{
  "proxy_routes": ["/conversations/new"],
  "proxies": [
    {"name": "Decodo-JP-1", "proxy": "http://...", "priority": 1, "enabled": true}
  ]
}
```

- URL 匹配 `proxy_routes` 中任一路径 → 使用住宅代理（curl_cffi + impersonate="chrome"）
- 其他路径（upload-file、post/create）→ VPS 直连（不消耗住宅代理流量）

### Relay 认证

CF Worker 与 relay 之间通过 `X-Relay-Secret` Header 认证，在管理后台配置。

## 请求流程

```
客户端 → POST /v1/chat/completions
  → requireApiAuth (验证 API Key)
  → selectBestToken / X-Raw-Token (选择 Token)
  → getRelaySettings (读取 relay 配置)
  → extractContent (提取文本 + 图片URL列表)
  → [非视频] 图片截断为最多 7 张
  → [有图片] mapLimit(uploadImage→relayFetch, 5) → 批量获取 fileId
  → [视频模型] createMediaPost(→relayFetch) → 获取 postId
  → buildConversationPayload (构建 payload，含 resolveImageReferences @图N→fileId)
  → sendConversationRequest(→relayFetch) (POST grok.com/conversations/new)
  → [流式] createOpenAiStreamFromGrokNdjson → SSE 响应
  → [非流式] parseOpenAiFromGrokNdjson → JSON 响应
  → recordTokenSuccess (重置失败计数)
```

## X-Raw-Token 模式

客户端通过 `X-Raw-Token` Header 直接提供 grok.com SSO JWT，跳过数据库 token 选择。

**关键行为差异：**
- Token 来源：使用客户端提供的 token，而非 `selectBestToken()` 从 D1 查询
- 失败处理：不调用 `recordTokenFailure`、`applyCooldown`（不影响数据库中其他 token）
- **URL passthrough**：`processor.ts` 中 `isRawToken === true` 时，视频/图片 URL 不经过 `/images/` 代理改写，直接返回 `assets.grok.com` 原始地址
- 客户端下载：客户端自行携带 `Cookie: sso=<token>;sso-rw=<token>` 从 `assets.grok.com` 直接下载

**URL 处理对比：**

| 模式 | 返回的视频 URL | 下载方式 |
|------|---------------|----------|
| 数据库 Token | `https://worker.dev/images/p_<base64>` | Worker 代理下载（KV 缓存） |
| X-Raw-Token | `https://assets.grok.com/users/.../video.mp4` | 客户端直接下载（带 Cookie） |

`toFullAssetUrl()` 辅助函数确保 grok 返回的相对路径被补全为完整 URL。

## 视频生成 payload 结构

视频参数通过 `responseMetadata.modelConfigOverride.modelMap.videoGenModelConfig` 传递：

```json
{
  "temporary": true,
  "modelName": "grok-3",
  "message": "提示词 --mode=normal",
  "toolOverrides": { "videoGen": true },
  "enableSideBySide": true,
  "responseMetadata": {
    "experiments": [],
    "modelConfigOverride": {
      "modelMap": {
        "videoGenModelConfig": {
          "parentPostId": "xxx",
          "aspectRatio": "2:3",
          "videoLength": 10,
          "resolutionName": "480p"
        }
      }
    }
  }
}
```

**关键参数映射：**
- `videoLength`: 整数秒（1-15），客户端传 `video_config.video_length`
- `resolutionName`: `"720p"` 或 `"480p"`，客户端传 `video_config.resolution`
- `aspectRatio`: 宽高比字符串（默认 "2:3"），客户端传 `video_config.aspect_ratio`
- `parentPostId`: 单图=createPost(imageUri) 返回的 ID；多图/无图=createMediaPost(VIDEO) 返回的 ID
- `isReferenceToVideo`: 多图 @ 引用时为 `true`
- `imageReferences`: 多图时的完整 asset URL 数组

## Token 管理机制

- **选择策略**: 优先未使用 Token，按剩余额度降序，随机打散
- **降级查询**: 严格条件（failed_count < 5 且无 cooldown）选不到时，忽略 failed_count 和 cooldown 重新选择，并自动重置该 token 状态（自愈机制）
- **指定 Token**: 请求头 `X-Token-Suffix: <后缀>` 可按 token 后缀强制选取特定 token（调试/测试用）
- **X-Raw-Token**: 请求头 `X-Raw-Token: <JWT>` 直接使用客户端提供的 token，绕过数据库选择
- **失败处理**: 请求成功时重置 failed_count；仅 401 累积 5 次标记永久失效
- **冷却机制**: 429 → 1小时冷却；视频模型 429 → 专用视频冷却；其他错误 → 30秒冷却；媒体代理下载失败不施加 cooldown
- **Token 类型**: `sso` (普通) / `ssoSuper` (超级会员)
- **一键重置**: `POST /admin/api/tokens/reset-all` 重置所有 token 的 failed_count、cooldown、status

## 媒体代理机制

```
客户端 → GET /images/p_<base64url(path)>
  → 解码路径：/users/<grok-user-uuid>/generated/<gen-id>/generated_video.mp4
  → 查 KV 缓存（已下载的内容直接返回）
  → Phase 1: 查 KV 记忆 tok-own:<grok-user-uuid> → 用对应 token 下载
  → Phase 2: 记忆未命中，selectBestToken 轮询（最多 4 个 token）
  → Phase 3: 成功后存 tok-own:<grok-user-uuid> → token（TTL 7 天）
  → 缓存到 KV（≤25MB，过期到次日凌晨）
```

**注意：** 此机制仅用于数据库 Token 模式。X-Raw-Token 模式下视频 URL 直接返回 `assets.grok.com` 地址，不走 `/images/` 代理。

**已知限制：** CF Worker IP 被 `assets.grok.com` 拦截（403），导致 `/images/` 代理在远程部署时无法直接从 `assets.grok.com` 拉取文件。数据库 Token 模式的视频下载需额外改造（将 media.ts 也走 relay）或使用 X-Raw-Token 模式规避。

**关键设计：**
- `assets.grok.com` 要求用生成内容的账号 token 下载，其他账号 token 会 403
- token-owner 记忆机制通过 KV 建立 `grok-user-uuid → sso-token` 映射
- 首次下载可能需重试 1-2 次，之后同账号内容均一次命中
- 媒体下载失败不记录 token failure 也不施加 cooldown（避免阻塞 API 请求）

## Cloudflare 检测与绕过

详细分析见 `docs/grok_cf_检测相关验证.md`。核心结论：

| 检测层 | 机制 | 影响范围 |
|--------|------|----------|
| Cloudflare 平台层 | IP 信誉检查 | CF Worker IP → 所有 grok.com 端点均 403 |
| grok.com 业务层 | TLS 指纹 + IP 信誉 | conversations/new 需要住宅代理 + Chrome TLS |

**各端点防护差异：**

| 端点 | VPS 直连 | 住宅代理 |
|------|----------|----------|
| conversations/new | 403（需住宅代理） | 通过 |
| upload-file | 通过 | 通过 |
| post/create | 通过 | 通过 |
| assets.grok.com | 通过 | 通过 |

## 多图 Imagine 视频支持

Grok Imagine 视频模式支持多图 + @ 引用。@ 引用**仅限 Imagine 视频模式**，普通问答模式不支持。

**单图 vs 多图 payload 对比：**

| | 单图 | 多图 + @引用 |
|---|---|---|
| message | `{assetUrl}  {prompt} --mode=...` | `@{fileId1} text @{fileId2} --mode=...` |
| fileAttachments | `[fileId]` | 无 |
| parentPostId | = fileId (image post) | 独立 ID (video post) |
| isReferenceToVideo | 无 | `true` |
| imageReferences | 无 | `[assetUrl1, assetUrl2, ...]` |
| resolutionName | `"480p"` | `"480p"` |

**处理流程：**
```
用户消息（OpenAI 格式，content 数组含多个 image_url + @图N 文本）
  → extractContent: 提取 images[] 和文本
  → images.slice(0, 7): 最多 7 张
  → mapLimit(uploadImage→relayFetch, 5): 并发上传（保序），获取 fileId[] 和 fileUri[]
  → [视频+多图] createMediaPost(VIDEO)→relayFetch → 获取容器 postId
  → [视频+单图] createPost(imageUri)→relayFetch → 获取 postId (= fileId)
  → buildConversationPayload:
      多图: resolveImageReferences(@图N → @fileId) + isReferenceToVideo + imageReferences
      单图: assetUrl 拼在 message 前面 + fileAttachments
```

**@图N 引用格式（OpenAI API 侧）：**
- 用户在 prompt 中写 `@图1`、`@图2`（1-based 索引）
- `resolveImageReferences()` 将 `@图N` 替换为 `@{fileId}`（Grok 内部格式：@ 直接跟 UUID）

## 注意事项

- Grok.com 内部 API 与官方 xAI API (api.x.ai) 参数格式不同，勿混淆
- 上游参考：TQZHR/grok2api 的 conversation.ts 是 payload 格式的权威来源
- `cf_clearance` 绑定特定账号会话，多 Token 场景下建议不设置
- `mapLimit` 并发上传必须保序（按索引赋值），否则 @图N 引用会映射到错误的 fileId
- `addRequestLog` 采用 fire-and-forget（`.catch(() => {})`），避免日志写入异常阻塞主流程返回
- 部署后务必检查 GitHub Actions 每个步骤状态，步骤 6 偶发 Cloudflare API 失败会导致 Deploy Worker 跳过
- CF Worker 不能直接用 IP 地址访问 relay（Cloudflare error 1003），需使用 `sslip.io` 等域名服务
- relay_server.py 的 `proxy_list.json` 路径取决于部署位置，确保路径正确
