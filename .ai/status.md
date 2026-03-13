# Current Session

- **Date**: 2026-03-13
- **Goal**: Grok 多图上传 + @引用 支持
- **Phase**: 多图 + @引用支持已完成
- **Context**: Grok Imagine 视频模式支持多图（最多 7 张）和 @ 引用。通过手动抓包分析 conversations/new payload，确认了 Grok 内部的多图引用格式并完成 grok2api 改造。

# Completed

- [x] 修复视频时长设置无效问题（responseMetadata 结构重构）
- [x] 修复 TypeScript exactOptionalPropertyTypes 类型错误
- [x] 优化 Token 失效判定机制（成功重置计数、仅 401 标记失效）
- [x] 创建 `.ai` 上下文目录及文档
- [x] 媒体代理多 Token 重试（跨账号视频下载 403 修复）
- [x] 媒体代理 token-owner 记忆机制（KV 存储 用户UUID→Token 映射）
- [x] 移除媒体代理中的 cooldown，避免阻塞视频生成请求
- [x] selectBestToken 降级查询（严格条件无结果时自动放宽）
- [x] 管理端 token 状态一键重置接口（POST /admin/api/tokens/reset-all）
- [x] 多图上传数量限制：所有模型最多 7 张（openai.ts）
- [x] 视频模型多图支持：移除视频模型单图限制，多图时创建视频容器 post
- [x] @图N 引用解析：resolveImageReferences() 将 @图N 映射为 @fileId（Imagine 视频模式专用）
- [x] 视频模型 payload 重构：单图=asset URL 拼 message + fileAttachments；多图=@fileId 引用 + isReferenceToVideo + imageReferences
- [x] 修复 videoResolution → resolutionName（"480p"/"720p" 替代 "SD"/"HD"）
- [x] 默认 aspectRatio 改为 "2:3"（与 Grok 网页端一致）

# Todo

- [ ] 监控：确认 token-owner 记忆命中率在生产环境表现
- [ ] 待观察：视频下载偶尔超时问题（网络层面，非代码问题）
- [x] 本地测试：多图视频生成（3 张图 + @图N 引用，wrangler dev 验证通过）
- [x] 本地测试：单图视频生成（resolutionName 兼容性验证通过）
- [ ] 部署测试：推送到 Cloudflare Workers 后验证多图/单图视频生成

# Notes

- Git remote 已从 `iptag/grok2api` 更新为 `hawk1900-gyy/grok2api`
- 部署方式：push 到 main → GitHub Actions → Deploy to Cloudflare Workers
- 后台地址：https://grok2api.hawk-bc-1900.workers.dev/admin
- token-owner 映射 KV 键格式：`tok-own:<grok-user-uuid>`，TTL 7 天
