# Grok2API IP 中转方案

## 1. 问题背景

### 1.1 现象

grok2api 部署在 Cloudflare Workers 后，对 `grok.com` 的请求被 Cloudflare anti-bot 规则拦截，返回 HTTP 403：

```json
{"error":{"code":7,"message":"Request rejected by anti-bot rules.","details":[]}}
```

### 1.2 根因

- grok.com 使用 Cloudflare 反爬保护
- Cloudflare Workers 出口 IP 属于数据中心 IP，IP 信誉低
- **核心判定因素是 IP 信誉**（非 TLS 指纹）——本机用 Node.js `fetch` 直连 grok.com 完全正常，说明 TLS 指纹不是主要问题

### 1.3 影响范围（实测验证）

| 端点 | 是否被拦截 | 说明 |
|------|-----------|------|
| `/rest/app-chat/upload-file` | ✅ 不拦截 | 图片上传，几百 KB~几 MB |
| `/rest/media/post/create` | ✅ 不拦截 | 创建媒体 post，几百字节 |
| `/rest/rate-limits` | ✅ 不拦截 | 查询限额，几百字节 |
| **`/rest/app-chat/conversations/new`** | **❌ 被拦截** | 对话/生成，唯一需要中转的端点 |

> **结论：只有 `conversations/new` 一个端点需要 IP 中转，其他请求可直连 grok.com。**

---

## 2. 流量分析

由于只需中转 `conversations/new`，流量开销极小：

| 方向 | 数据类型 | 大小 |
|------|---------|------|
| 请求体 | JSON payload（prompt + 参数） | 2~10 KB |
| 响应体 | NDJSON 流式文本 | 5~50 KB |
| 不走代理 | 图片上传、视频下载、限额查询 | 不计入 |

**单次请求代理流量 ≈ 10~60 KB**

每月估算（高频使用，每天 100 次请求）：
- 100 × 30 × 60 KB ≈ **180 MB/月**
- 远低于住宅代理服务商的 GB 级流量配额

---

## 3. 方案一：住宅代理服务

### 3.1 原理

住宅代理（Residential Proxy）使用真实家庭宽带 IP，IP 信誉与普通用户一致，不会触发数据中心 IP 检测。

```
调用方 → grok2api (CF Worker / VPS)
            │
            ├── upload-file ──────→ grok.com  (直连)
            ├── media/post/create ─→ grok.com  (直连)
            ├── rate-limits ──────→ grok.com  (直连)
            │
            └── conversations/new ─→ 住宅代理 ─→ grok.com  (中转)
```

### 3.2 主流服务商（含官网注册地址）

| 服务商 | 官网 | 起步价 | IP 池规模 | 协议 | 特点 |
|--------|------|--------|-----------|------|------|
| **FlashProxy** | [flashproxy.com](https://flashproxy.com/pricing/residential) | $0.70/GB (50GB起) | 1亿+ | HTTP/SOCKS5 | 入门便宜，新用户有试用 |
| **RapidProxy** | [rapidproxy.io](https://www.rapidproxy.io/pricing) | $0.65/GB | 9000万+ | HTTP/HTTPS/SOCKS5 | 新用户送500MB免费流量 |
| **KindProxy** | [kindproxy.com](https://www.kindproxy.com/products/residential-proxies/traffic/) | $0.75/GB | 5000万+ | HTTP/HTTPS/SOCKS5 | 注册送60积分可兑0.1GB |
| **Decodo** (原Smartproxy) | [decodo.com](https://www.decodo.com/) | $2/GB (1000GB) | 1.15亿+ | HTTP/HTTPS/SOCKS5 | 老牌稳定，99.86%成功率 |
| **IPRoyal** | [iproyal.com](https://iproyal.com/pricing/residential-proxies/) | $7/GB (1GB起) | 3200万+ | HTTP/HTTPS/SOCKS5 | 流量永不过期，买了不浪费 |
| **Bright Data** | [brightdata.com](https://brightdata.com/pricing/proxy-network/residential-proxies) | $4/GB (促销价) | 1.5亿+ | HTTP/HTTPS/SOCKS5 | 行业老大，150M+ IP，免费试用 |
| **Oxylabs** | [oxylabs.io](https://oxylabs.io/products/residential-proxy-pool) | $8/GB | 1亿+ | HTTP/HTTPS/SOCKS5 | 企业级，速度最快 |

> **推荐注册顺序**：FlashProxy / RapidProxy（最便宜入门）→ Decodo（稳定备用）→ IPRoyal（流量不过期兜底）

### 3.3 月成本估算

按 180 MB/月流量计算（每天 100 次请求，只中转 conversations/new 的文本）：

| 服务商 | 单价 | 月成本 |
|--------|------|--------|
| RapidProxy | $0.65/GB | **$0.12** |
| FlashProxy | $0.70/GB | **$0.13** |
| KindProxy | $0.75/GB | **$0.14** |
| Decodo | $2/GB | **$0.36** |
| IPRoyal | $7/GB | **$1.26** |
| Bright Data | $4/GB | **$0.72** |

> 因为只中转文本流量，成本极低。即使选最贵的服务商也不到 $2/月。
> 新用户建议先买 1GB 试用，按最低价 $0.65/GB 算，不到 1 美元够用半年。

### 3.4 优点

- **无需自建服务器**，代码改动最小
- **IP 池巨大**，可随机轮换，不易被封
- **按流量计费**，只中转 conversations/new 时成本极低
- 可保留 Cloudflare Workers 部署架构不变

### 3.5 缺点

- 增加一跳网络延迟（通常 100~300ms）
- 代理服务本身的稳定性是个变量
- Cloudflare Workers 环境不原生支持 SOCKS5，需用 HTTP 代理或通过中间层转发
- 部分住宅代理的 IP 质量参差不齐

### 3.6 实现要点

```
grok2api 代码改造（伪代码）:

if (endpoint === "conversations/new") {
    // 通过住宅代理转发
    fetch(url, {
        ...options,
        agent: new HttpsProxyAgent("http://user:pass@proxy.example.com:port")
    });
} else {
    // 直连 grok.com
    fetch(url, options);
}
```

> 注意：Cloudflare Workers 的 `fetch` 不支持自定义代理。如果继续使用 CF Workers 部署，需要通过一个外部代理网关（如一个轻量 VPS 上运行的代理转发服务）来做跳板。或者将 grok2api 整体迁移到 VPS。

---

## 4. 方案二：干净 IP 的 VPS

### 4.1 原理

将 grok2api 部署到拥有"干净 IP"的 VPS 上。所谓干净 IP，是指该 IP 没有被 Cloudflare 等反爬系统标记为数据中心/爬虫 IP，信誉接近住宅 IP。

```
调用方 → grok2api (干净IP的VPS)
            │
            ├── upload-file ──────→ grok.com  (直连)
            ├── media/post/create ─→ grok.com  (直连)
            ├── rate-limits ──────→ grok.com  (直连)
            └── conversations/new ─→ grok.com  (直连，IP 信誉好不被拦截)
```

### 4.2 关键：什么是"干净 IP"

- 不在 Cloudflare 的数据中心 IP 黑名单中
- 没被大量爬虫/机器人使用过
- 通常来自小型 VPS 提供商或冷门机房
- ISP 类型显示为 "hosting" 但未被标记为 abusive

### 4.3 推荐的 VPS 提供商

| 提供商 | 起步价 | 特点 |
|--------|--------|------|
| **BandwagonHost (搬瓦工)** | $49.99/年 | 中国用户常用，部分 IP 段较干净 |
| **Vultr** | $3.5/月 | 按小时计费，IP 不行可删机换一个 |
| **DigitalOcean** | $4/月 | 质量稳定，部分区域 IP 干净 |
| **Linode (Akamai)** | $5/月 | 老牌厂商 |
| **Oracle Cloud** | 免费层可用 | 永久免费 ARM 实例，IP 较干净 |
| **Hetzner** | €3.29/月 | 欧洲机房，价格极低 |
| **RackNerd** | $10.98/年 | 便宜，但 IP 质量需碰运气 |

### 4.4 选 IP 的技巧

1. **创建实例后先测试 IP**：用该 VPS 直接请求 `grok.com/rest/app-chat/conversations/new`，看是否返回 403
2. **不行就换**：Vultr 等按小时计费的厂商，删除实例重新创建通常会分配新 IP
3. **优先选冷门区域**：如 Dallas、Atlanta、Stockholm 等，热门区域（硅谷、东京）的 IP 更容易被标记
4. **检查 IP 信誉**：上线前在 [ipinfo.io](https://ipinfo.io) 查看 IP 类型，确保不是 "hosting (abusive)"

### 4.5 优点

- **所有请求直连**，无需区分端点，架构简单
- **延迟低**，没有额外代理跳转
- **月成本固定且低**（$3~5/月）
- 完全自控，不依赖第三方代理服务

### 4.6 缺点

- **失去 Cloudflare Workers 的全球 CDN 分发**——CF Workers 在全球数百个节点运行，用户访问时自动路由到最近节点；VPS 是单点部署
- **IP 有被封风险**：如果该 IP 被标记，需要手动更换
- **需要运维**：管理 VPS、部署、SSL 证书等
- grok2api 原本是 Cloudflare Workers 项目（Hono + D1），迁移到 Node.js/VPS 需要一定改造

---

## 5. 方案对比

| 维度 | 方案一：住宅代理 | 方案二：干净 IP VPS |
|------|----------------|-------------------|
| 月成本 | $0.2~$2 (按流量) | $3~$5 (固定) |
| 架构改动 | 中等（需代理网关） | 较大（迁移部署方式） |
| IP 可靠性 | 高（大池轮换） | 中（单 IP，可能被封） |
| 延迟 | +100~300ms | 最优（直连） |
| 运维复杂度 | 低 | 中 |
| CDN 加速 | 保留 CF Workers 全球分发 | 失去，单点部署 |
| 适合场景 | 保持现有 CF 架构 | 全新部署或不依赖 CF |

---

## 6. 推荐方案

### 6.1 短期（快速验证）

**方案二 — 干净 IP VPS**

理由：
- 架构最简单，所有请求直连，不需要区分端点
- Vultr/DigitalOcean 按小时计费，开机测试 IP 是否可用，不行删掉换，成本几美分
- grok2api 可以通过 `wrangler dev` 的类似方式在 VPS 上运行，改动最小

### 6.2 长期（生产级）

**方案一 + 方案二混合**

- grok2api 主体仍部署在 Cloudflare Workers（享受全球 CDN）
- 在一台干净 IP 的 VPS 上部署一个轻量代理转发服务
- CF Worker 中仅将 `conversations/new` 请求通过该 VPS 代理转发
- VPS 还可以作为住宅代理的备用方案（如果住宅代理不稳定时切换到 VPS 直连）

---

## 7. 附录：验证脚本

测试某个 IP 是否被 grok.com 拦截：

```javascript
// test_ip_check.mjs — 在目标 VPS 上运行
const TOKEN = "你的SSO_TOKEN";
const resp = await fetch("https://grok.com/rest/app-chat/conversations/new", {
  method: "POST",
  headers: {
    Cookie: `sso-rw=${TOKEN};sso=${TOKEN}`,
    "Content-Type": "application/json",
    Origin: "https://grok.com",
    Referer: "https://grok.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/133.0.0.0",
  },
  body: JSON.stringify({
    temporary: true,
    modelName: "grok-3",
    message: "hi",
  }),
});
console.log(`HTTP ${resp.status}`);
if (resp.status === 403) {
  console.log("❌ 该 IP 被 grok.com anti-bot 拦截");
} else {
  console.log("✅ 该 IP 可用");
}
```

---

## 8. 住宅代理配置指南

### 8.1 配置文件位置

`configs/proxy_list.json`（relay_server.py 同级 configs 目录下）

### 8.2 配置格式

```json
[
  {
    "name": "FlashProxy住宅",
    "proxy": "http://username:password@gate.flashproxy.com:7777",
    "priority": 1,
    "enabled": true,
    "note": "主用，按流量计费"
  },
  {
    "name": "RapidProxy备用",
    "proxy": "http://username:password@rp.proxyscrape.com:6060",
    "priority": 2,
    "enabled": true,
    "note": "备用代理"
  }
]
```

### 8.3 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 自定义名称，用于日志显示 |
| `proxy` | 是 | 代理地址，格式 `http://user:pass@host:port` 或 `socks5://user:pass@host:port` |
| `priority` | 是 | 优先级，数值越小越优先尝试 |
| `enabled` | 是 | `true` 启用 / `false` 禁用 |
| `note` | 否 | 备注 |

### 8.4 工作逻辑

1. relay_server.py 每次收到转发请求时，**热加载** `config/proxy_list.json`（改了不用重启）
2. 按 `priority` 从小到大依次尝试 `enabled: true` 的代理
3. 某个代理连接失败，自动跳到下一个
4. **所有代理都失败，回退到 VPS 自身 IP 直连**（兜底策略）

### 8.5 各服务商代理地址格式参考

注册后在各服务商控制台获取代理凭证，通常格式为：

| 服务商 | 代理地址格式 |
|--------|-------------|
| FlashProxy | `http://user-zone-resi:password@proxy.flashproxy.com:7777` |
| RapidProxy | `http://user:password@gate.rapidproxy.io:7777` |
| KindProxy | `http://user:password@proxy.kindproxy.com:port` |
| Decodo | `http://user:password@gate.decodo.com:7777` |
| IPRoyal | `http://user:password@geo.iproyal.com:12321` |
| Bright Data | `http://brd-customer-xxx-zone-resi:password@brd.superproxy.io:22225` |

> 具体格式以各服务商控制台提供的为准，以上仅供参考。
