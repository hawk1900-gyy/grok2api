# Grok2API 系统架构

## 概述

grok2api 将 Grok.com 网页端的内部 API 逆向封装为 OpenAI 兼容格式，部署在 Cloudflare Workers 上。
支持文本对话、图片生成、视频生成（文生视频 + 图生视频）。

## 技术栈

| 组件 | 技术 |
|------|------|
| Runtime | Cloudflare Workers (V8 isolate) |
| Framework | Hono |
| Database | Cloudflare D1 (SQLite) |
| Cache | Cloudflare Workers KV |
| Language | TypeScript (strict, exactOptionalPropertyTypes) |
| 前端 | 静态 HTML (app/template/) |

## 核心模块

```
src/
├── index.ts                 # 入口，路由注册 + Cron 调度
├── routes/
│   ├── openai.ts            # OpenAI 兼容 API (/v1/chat/completions, /v1/models)
│   ├── admin.ts             # 管理后台 API
│   └── media.ts             # 媒体代理 (/images/)
├── grok/
│   ├── conversation.ts      # 构建 Grok 对话 payload（核心）
│   ├── processor.ts         # 解析 Grok NDJSON 流响应
│   ├── models.ts            # 模型映射配置
│   ├── create.ts            # 创建媒体帖子 (/rest/media/post/create)
│   ├── upload.ts            # 图片上传
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
```

## 请求流程

```
客户端 → POST /v1/chat/completions
  → requireApiAuth (验证 API Key)
  → selectBestToken (从 D1 选择最佳 Token)
  → [视频模型] createMediaPost → 获取 postId
  → [有图片] uploadImage → 获取 fileId
  → buildConversationPayload (构建 Grok 内部 API payload)
  → sendConversationRequest (POST grok.com/rest/app-chat/conversations/new)
  → [流式] createOpenAiStreamFromGrokNdjson → SSE 响应
  → [非流式] parseOpenAiFromGrokNdjson → JSON 响应
  → recordTokenSuccess (重置失败计数)
```

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
          "aspectRatio": "16:9",
          "videoLength": 10,
          "videoResolution": "HD"
        }
      }
    }
  }
}
```

**关键参数映射：**
- `videoLength`: 整数秒（1-15），客户端传 `video_config.video_length`
- `videoResolution`: `"HD"` (720p) 或 `"SD"` (480p)，客户端传 `video_config.resolution`
- `aspectRatio`: 宽高比字符串，客户端传 `video_config.aspect_ratio`
- `parentPostId`: 通过 createMediaPost 获取的帖子 ID

## Token 管理机制

- **选择策略**: 优先未使用 Token，按剩余额度降序，随机打散
- **降级查询**: 严格条件（failed_count < 5 且无 cooldown）选不到时，忽略 failed_count 和 cooldown 重新选择，并自动重置该 token 状态（自愈机制）
- **失败处理**: 请求成功时重置 failed_count；仅 401 累积 5 次标记永久失效
- **冷却机制**: 429 → 1小时冷却；其他错误 → 30秒冷却；媒体代理下载失败不施加 cooldown
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

**关键设计：**
- `assets.grok.com` 要求用生成内容的账号 token 下载，其他账号 token 会 403
- token-owner 记忆机制通过 KV 建立 `grok-user-uuid → sso-token` 映射
- 首次下载可能需重试 1-2 次，之后同账号内容均一次命中
- 媒体下载失败不记录 token failure 也不施加 cooldown（避免阻塞 API 请求）

## 注意事项

- Grok.com 内部 API 与官方 xAI API (api.x.ai) 参数格式不同，勿混淆
- 上游参考：TQZHR/grok2api 的 conversation.ts 是 payload 格式的权威来源
- `cf_clearance` 绑定特定账号会话，多 Token 场景下建议不设置
