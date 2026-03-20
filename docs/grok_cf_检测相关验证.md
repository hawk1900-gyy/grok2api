# Grok.com Cloudflare 检测机制验证报告

> 基于 grok2api 项目开发过程中的多轮实际测试总结，记录 Cloudflare 对 grok.com 各端点的检测行为、IP 信誉与 TLS 指纹的交叉影响。

---

## 一、背景

grok2api 部署在 Cloudflare Workers 上，通过 `fetch()` 调用 grok.com API。  
2026 年 3 月起发现远程 CF Worker 无法直接访问 grok.com，返回 403。  
经过多轮排查，确认原因是 grok.com 启用了 Cloudflare Bot Management 保护。

---

## 二、涉及的 grok.com 端点

| 端点 | 用途 |
|------|------|
| `/rest/app-chat/conversations/new` | 核心：文本对话、视频生成 |
| `/rest/app-chat/upload-file` | 图片上传（base64） |
| `/rest/media/post/create` | 创建媒体 post（视频生成前置步骤） |
| `/rest/rate-limits` | 查询配额 |

---

## 三、检测层次：OSI 模型视角

Cloudflare 的检测发生在三个层次：

```
第 7 层 (应用层/HTTP)
│  检查 URL 路径 → conversations/new 启用 anti-bot 规则，其他端点不启用
│
第 6 层 (表示层/TLS)
│  检查 TLS Client Hello 的密码套件、扩展列表、曲线顺序
│  → 计算 JA3/JA4 指纹，识别客户端类型 (Chrome / Node.js / curl / CF Worker)
│
第 3 层 (网络层/IP)
│  检查源 IP → 查询 IP 信誉数据库
│  → 住宅 IP 信誉高，数据中心 IP 信誉低，CF Worker IP 信誉极低
```

关键点：**TLS 指纹在 HTTP 请求发出之前就已产生**，我们在代码中设置的 headers、body、cookie 都属于第 7 层，无法影响第 6 层的 TLS 握手特征。

---

## 四、实际测试记录

### 4.1 不同客户端工具 × 不同 IP 的测试结果

#### conversations/new 端点

| # | 来源 IP | 客户端工具 | TLS 指纹 | 结果 | 备注 |
|---|---------|-----------|---------|------|------|
| 1 | 用户本机（住宅宽带） | Node.js fetch (undici) | Node.js | **200 通过** | 住宅 IP + 非黑名单 TLS → 放行 |
| 2 | 用户本机（住宅宽带） | curl.exe | curl/OpenSSL | **403 被拦** | curl 的 TLS 指纹被 Cloudflare 列入黑名单 |
| 3 | 用户本机（住宅宽带） | Node.js fetch (undici) | Node.js | **429 业务拒绝** | 通过了 anti-bot，后端因额度不足拒绝 |
| 4 | 用户本机（AWS VPN） | Python requests | Python/urllib3 | **403 被拦** | IP 变为 AWS 数据中心 → 信誉下降 |
| 5 | 用户本机（某次 IP 不明） | Node.js fetch (undici) | Node.js | **403 被拦** | 可能 IP 变化或 CF 规则收紧 |
| 6 | Decodo 住宅代理池 IP | Python requests | Python/urllib3 | **403 被拦** | "住宅"代理池 IP 被 CF 标记 + Python TLS 差 |
| 7 | Decodo 住宅代理池 IP | curl_cffi (impersonate=chrome) | Chrome | **200 通过** | 同样的代理 IP，Chrome TLS 通过 |
| 8 | CF Worker 出口 IP | CF Worker fetch | CF 内部 | **403 被拦** | CF Worker IP 信誉极低，任何 TLS 都无法通过 |
| 9 | CF Worker 出口 IP + cf_clearance | CF Worker fetch | CF 内部 | **403 被拦** | cf_clearance 绑定原始 IP，跨 IP 使用无效 |

#### upload-file / post/create / rate-limits 端点

| # | 来源 IP | 客户端工具 | 结果 | 备注 |
|---|---------|-----------|------|------|
| 10 | 用户本机 | Node.js fetch | **通过** (400/200/200) | upload-file 返回 400 是因为假图片数据，但请求到达了后端 |
| 11 | 用户本机 | Node.js fetch | **通过** | 多次重复验证，结果一致 |
| 12 | CF Worker 出口 IP | CF Worker fetch | **403 被拦** | CF Worker 对所有 grok.com 端点都被拦 |

#### 未测试的场景（缺失数据）

| 来源 IP | 客户端工具 | 端点 | 状态 |
|---------|-----------|------|------|
| VPS (AWS Japan) 直连 | curl_cffi Chrome TLS | conversations/new | **未测试** |
| VPS (AWS Japan) 直连 | Python requests | upload-file | **未测试** |
| VPS (AWS Japan) 直连 | 任意 | 任意 | **未测试** |

> 注意：relay_server 本地调试时显示的 "via 直连(VPS自身IP)" 实际上使用的是用户本机 IP（relay 跑在 localhost），不是真正的 VPS IP。

---

## 五、核心发现

### 发现 1：conversations/new 有独立的 anti-bot 规则

**证据**：同一台机器、同一个 Node.js fetch、同一时刻运行：

- `upload-file` → 400（到达后端）
- `post/create` → 200（成功）
- `rate-limits` → 200（成功）
- `conversations/new` → 403（anti-bot 拦截）

此测试重复验证多次，结果一致。

**结论**：grok.com 在 Cloudflare 后台对 conversations/new 配置了额外的 Bot Management 规则（类似 WAF 规则 `URI Path = /rest/app-chat/conversations/new → Managed Challenge`），其他端点未配置。

### 发现 2：CF Worker 的 IP 对所有端点都被拦

**证据**：

- CF Worker → conversations/new → 403 Cloudflare challenge HTML
- CF Worker → upload-file → 403 Cloudflare challenge HTML（远程视频生成测试发现）

**结论**：CF Worker 的出口 IP 属于 Cloudflare 自身的数据中心 IP，在 Cloudflare 的 IP 信誉数据库中评分极低。grok.com 的 Cloudflare 保护层对这类 IP 在平台级别直接拦截，不区分端点。

### 发现 3：IP 信誉与 TLS 指纹是组合判定

**证据（关键对比）**：

同一批 Decodo 住宅代理 IP，仅改变客户端工具：

| IP | TLS | 结果 |
|----|-----|------|
| Decodo 住宅代理 | Python requests (urllib3 TLS) | 403 被拦 |
| Decodo 住宅代理 | curl_cffi (Chrome TLS) | **200 通过** |

同时，用户干净的住宅 IP + Node.js (非 Chrome TLS) → 200 通过。

**结论**：Cloudflare 对 conversations/new 的检测是 **IP 信誉 + TLS 指纹** 的组合评分：

| IP 信誉 | TLS 要求 | 示例 |
|---------|---------|------|
| 高（干净住宅 IP） | 宽松，Node.js 即可 | 用户家庭宽带 |
| 中（已知代理池 IP） | 严格，需要 Chrome TLS | Decodo 住宅代理 |
| 极低（CF Worker IP） | 无法通过 | Cloudflare Workers |

### 发现 4：cf_clearance 绑定 IP

**证据**：从浏览器获取的 cf_clearance cookie 附加到 CF Worker 请求后，结果不变（仍然 403）。

**结论**：cf_clearance 是 Cloudflare 发给通过挑战的客户端的凭证，绑定了通过挑战时的 IP 地址。从不同 IP 使用该 cookie 无效。

---

## 六、当前解决方案

基于以上发现，采用 VPS 中转架构：

```
客户端
  → grok2api (Cloudflare Workers)
    → relay_server.py (日本 VPS, Flask)
      ├── conversations/new → 住宅代理 + curl_cffi Chrome TLS → grok.com
      └── upload-file / post/create 等 → VPS 直连 (std_requests) → grok.com
```

### relay_server.py 的关键设计

```python
# 只有 conversations/new 需要住宅代理（anti-bot），其他端点 VPS 直连即可
need_proxy = "/conversations/new" in target_url

if need_proxy:
    # curl_cffi + impersonate="chrome" + 住宅代理
    resp = cffi_requests.request(..., impersonate="chrome", proxies=proxies)
else:
    # 标准 requests 直连，节省住宅代理流量
    resp = std_requests.request(...)
```

### 流量优化

| 步骤 | 端点 | 数据量 | 走向 |
|------|------|--------|------|
| 图片上传 | upload-file | 大（几百 KB ~ 几 MB） | VPS 直连 |
| 创建媒体 post | post/create | 极小 | VPS 直连 |
| 查限额 | rate-limits | 极小 | VPS 直连 |
| **对话/生成** | **conversations/new** | **小（几 KB ~ 几十 KB）** | **住宅代理** |

住宅代理流量消耗极小（每次请求约几十 KB），大体积的图片上传走 VPS 直连，不消耗住宅代理流量。

---

## 七、待验证事项

| 场景 | 目的 |
|------|------|
| VPS (AWS Japan) + curl_cffi Chrome TLS → conversations/new | 确认 VPS 数据中心 IP 是否能通过（如果能，可以不用住宅代理） |
| VPS (AWS Japan) + std_requests → upload-file / post/create | 确认 VPS IP 对非 anti-bot 端点是否畅通 |
| 长期运行后 VPS IP 信誉变化 | 观察高频请求是否导致 VPS IP 被降级 |
| Cloudflare 规则更新 | grok.com 可能随时收紧或放松 anti-bot 规则 |

---

## 八、附录：TLS 指纹原理

### 什么是 TLS 指纹

HTTPS 连接建立时，客户端在第一个 TLS 包（Client Hello）中发送：

- 支持的密码套件列表及顺序
- TLS 扩展列表及顺序
- 支持的椭圆曲线
- 签名算法
- ...

不同的 HTTP 客户端库（Chrome、Node.js undici、Python urllib3、curl）底层的 TLS 实现不同，Client Hello 的内容也不同。Cloudflare 将这些特征计算为 JA3/JA4 哈希值，用于识别客户端类型。

### 各客户端的 TLS 指纹对比

| 客户端 | 底层 TLS 库 | Cloudflare 识别为 | anti-bot 严格度 |
|--------|-----------|------------------|----------------|
| Chrome 浏览器 | BoringSSL | Chrome → 可信 | 宽松 |
| curl_cffi impersonate=chrome | BoringSSL (伪装) | Chrome → 可信 | 宽松 |
| Node.js (undici) | OpenSSL | Node.js → 未黑名单 | 中等 |
| Python requests (urllib3) | OpenSSL | Python → 常见爬虫 | 严格 |
| curl.exe | OpenSSL/Schannel | curl → 已知自动化工具 | 严格 |
| CF Worker fetch | Cloudflare 内部 | CF Worker → 极低信任 | 直接拦截 |

### curl_cffi 的作用

```python
# 普通 Python requests — TLS 指纹暴露为 Python/urllib3
requests.post("https://grok.com/...", headers=headers, json=body)

# curl_cffi — TLS 握手伪装为 Chrome
from curl_cffi import requests
requests.post("https://grok.com/...", headers=headers, json=body, impersonate="chrome")
```

两行代码的 HTTP 层（headers、body）完全一样，差异在第 6 层（TLS 握手）：curl_cffi 重新编排了密码套件、扩展列表、曲线顺序，使其与 Chrome 一致。
