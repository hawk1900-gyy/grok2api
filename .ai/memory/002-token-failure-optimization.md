# ADR-002: 优化 Token 失效判定机制

- **日期**: 2026-02-25
- **状态**: 已实施
- **关联 commit**: 0cf7809

## 问题

用户添加 4 个有效的 SuperSSO Token 后，3 个很快被标记为"失效"。
但这些 Token 在 Grok 官网上可以正常使用，说明并未真正过期。

## 根因

原有逻辑过于激进：
- 任何 4xx 错误（包括 403 临时限流）累积 3 次就永久标记 Token 为 `expired`
- 请求成功后不会重置 `failed_count`，导致偶尔的错误不断累积
- `MAX_FAILURES = 3`，容错空间极小

## 决策

### 方案 A：仅调高阈值（保守）
将 MAX_FAILURES 从 3 调到 10。简单但治标不治本。

### 方案 B：成功重置 + 区分错误类型（采纳）
1. 请求成功时重置 `failed_count` 并恢复 `expired` 状态
2. 仅 401（认证失败）才标记永久失效，403 等临时错误只做冷却
3. 适当提高阈值到 5

选择方案 B，因为：
- 403 通常是临时限流或反爬，不代表 Token 失效
- 只有 401 才明确表示 Token/Cookie 已过期
- 成功重置确保偶发错误不会累积

## 变更

| 文件 | 变更 |
|------|------|
| `src/repo/tokens.ts` | 新增 `recordTokenSuccess()`；`recordTokenFailure()` 仅 401 触发 expired；MAX_FAILURES 3→5 |
| `src/routes/openai.ts` | 上游请求成功后调用 `recordTokenSuccess()` |

## 相关发现

- 后台"可重试状态码"默认为 `401,429`，不含 403。建议用户改为 `401,429,403` 以便 403 时自动换 Token 重试
- `cf_clearance` 绑定特定账号会话，多 Token 场景下不建议设置
