# Current Session

- **Date**: 2026-03-20
- **Goal**: X-Raw-Token 模式视频直链下载 + Relay 代理路由优化
- **Phase**: 全部完成
- **Context**: 实现了 relay 中转系统绕过 CF Worker IP 被 grok.com 拦截的问题，优化了代理路由使住宅代理仅用于 conversations/new，实现了 X-Raw-Token 模式下视频/图片 URL 直接返回 assets.grok.com 原始地址（跳过 /images/ 代理），编写了轻量视频生成示例。

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
- [x] 修复 mapLimit 并发上传顺序 bug（改为按索引赋值，保证结果数组与输入顺序一致）
- [x] 新增 X-Token-Suffix 请求头：可指定 token 后缀强制使用特定 token（调试/测试用）
- [x] 新增 selectTokenBySuffix()：按 token 后缀精确查询（repo/tokens.ts）
- [x] addRequestLog 改为 fire-and-forget（.catch），避免日志写入失败阻塞主流程
- [x] **relay 中转系统**：relay_server.py（Python Flask + curl_cffi）部署在日本 VPS，转发所有 grok.com 请求
- [x] **relayFetch 通用函数**：conversation.ts 导出，upload.ts / create.ts / conversation.ts 统一使用
- [x] **管理后台 relay 管理**：admin.ts 支持 relay 服务器增删改查、测试连通性
- [x] **视频专用冷却**：video_cooldown_until 字段，视频 429 → 专用冷却，不影响文本请求
- [x] **流式 relay 响应**：relay_server.py 支持 streaming response（视频生成进度实时推送）
- [x] **条件代理策略**：relay_server.py 根据 proxy_list.json 中 proxy_routes 决定是否使用住宅代理
- [x] **proxy_list.json 格式升级**：从纯数组改为 {proxy_routes, proxies} 对象格式
- [x] **relay_server.py 健壮性**：兼容旧格式、过滤非字典 proxy 条目
- [x] **X-Raw-Token URL passthrough**：isRawToken 时视频/图片 URL 不改写，直接返回 assets.grok.com 原始地址
- [x] **toFullAssetUrl()**：补全 grok 返回的相对路径为完整 assets.grok.com URL
- [x] **grok_example.py 下载支持**：download_media 检测 assets.grok.com 时自动携带 SSO Cookie
- [x] **grok_video_example.py**：轻量视频生成示例（仅远程 + X-Raw-Token 模式）
- [x] **docs/grok_api视频生成说明.md**：视频 API 接口文档
- [x] **docs/grok_cf_检测相关验证.md**：Cloudflare 检测机制分析文档
- [x] 本地 + 远程部署测试验证通过

# Todo

- [ ] 数据库 Token 模式视频下载：media.ts 的 /images/ 代理需要走 relay 才能从 assets.grok.com 拉取（当前远程部署被 403）
- [ ] 监控：确认 token-owner 记忆命中率在生产环境表现
- [ ] 待观察：视频下载偶尔超时问题（网络层面，非代码问题）

# Notes

- Git remote: `hawk1900-gyy/grok2api`
- 部署方式：push 到 main → GitHub Actions → Deploy to Cloudflare Workers；或本地 `npx wrangler deploy`
- 后台地址：https://grok2api.hawk-bc-1900.workers.dev/admin
- relay 地址：http://54-178-35-110.sslip.io:9889（CF Worker 需使用 sslip.io 域名，不能直接用 IP）
- token-owner 映射 KV 键格式：`tok-own:<grok-user-uuid>`，TTL 7 天
- 住宅代理仅用于 conversations/new（proxy_routes 配置），其他端点走 VPS 直连以节省流量
- 部署排查教训：GitHub Actions 步骤 6 (Ensure D1+KV) 偶发 Cloudflare API 失败会导致 Deploy Worker 被跳过，需检查每个步骤状态而非仅看整体 conclusion
