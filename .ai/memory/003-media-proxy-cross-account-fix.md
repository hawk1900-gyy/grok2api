# ADR-003: 媒体代理跨账号下载修复 + Token 选择自愈

- **日期**: 2026-02-25
- **状态**: 已实施
- **关联 commit**: c7a5301, b16544a, 7636f94, 43e785c

## 问题

50 个生成的视频中 17 个返回的下载链接无法访问（403）。
修复过程中又暴露出所有 token 不可用（NO_AVAILABLE_TOKEN 503）的连锁问题。

## 根因分析

### 问题 1：跨账号下载 403

视频 URL 格式为 `https://assets.grok.com/users/<grok-user-uuid>/generated/<id>/generated_video.mp4`。
`assets.grok.com` 要求用**生成该视频的账号的 token** 才能下载。
媒体代理 `media.ts` 通过 `selectBestToken` 随机选一个 token，选错账号就 403。

### 问题 2：cooldown 连锁导致 NO_AVAILABLE_TOKEN

第一版修复中，重试循环每次失败都调用 `applyCooldown`（30 秒）。
4 个 token 全试一遍 → 4 个 token 全在冷却中 → 新的视频生成请求无可用 token → 503。

### 问题 3：failed_count 积累导致永久排除

早期代码中 `recordTokenFailure` 被用于媒体下载失败（token 不匹配导致的 403）。
虽然 ADR-002 改为仅 401 标记 expired，但 `selectBestToken` 仍有 `failed_count < 5` 过滤条件。
累积的 failed_count 使所有 token 被排除，且无自愈路径。

## 决策

分四步修复（按 commit 顺序）：

### Step 1：多 Token 重试（c7a5301）
媒体代理下载失败时换不同 token 重试，最多 4 次。移除 `recordTokenFailure` 调用。

### Step 2：token-owner 记忆机制（b16544a）
- 从视频 URL 路径提取 `grok-user-uuid`
- Phase 1：查 KV `tok-own:<uuid>` 获取已知 owner token，优先使用
- Phase 2：记忆未命中时走 `selectBestToken` 重试循环
- Phase 3：成功后写入 KV 映射（TTL 7 天）

### Step 3：移除媒体代理 cooldown（7636f94）
媒体下载的 token 不匹配只是"选错了账号"，不代表 token 有问题。
彻底移除 `applyCooldown` 调用，避免阻塞视频生成等核心 API 请求。

### Step 4：selectBestToken 降级查询 + 重置接口（43e785c）
- 严格条件选不到 token 时，降级忽略 `failed_count` 和 `cooldown_until`，仅排除 `expired`
- 降级选中时自动重置该 token 的 `failed_count` 和 `cooldown`（自愈）
- 新增 `POST /admin/api/tokens/reset-all` 一键重置所有 token 状态

## 变更

| 文件 | 变更 |
|------|------|
| `src/routes/media.ts` | 重构下载逻辑：三阶段（记忆→重试→学习）；移除 cooldown 和 recordTokenFailure |
| `src/repo/tokens.ts` | `selectBestToken` 增加降级查询；新增 `resetAllTokenStates()` |
| `src/routes/admin.ts` | 新增 `POST /api/tokens/reset-all` 端点 |

## 教训

1. **媒体代理的 token 失败 ≠ API 请求的 token 失败**，不能共用相同的惩罚机制
2. **cooldown 是全局的**，在一个子系统施加 cooldown 会影响所有子系统
3. **需要自愈路径**：当所有 token 都被排除时，系统应能自动恢复而非彻底瘫痪
