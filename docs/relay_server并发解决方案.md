# Relay Server 并发解决方案

> 版本：v1.0
> 范围：`grok2api`（CF Worker + `relay_server.py` + 住宅代理 + 无头浏览器抓 statsig）这一套
> 目标：在不改动"CF 前端天生可横向扩"的前提下，系统性消除后端三大并发瓶颈
> 定位：可排期的工程改造方案，分三条线推进，可独立落地

---

## 目录

- [1. 背景与现状](#1-背景与现状)
  - [1.1 真实部署配置](#11-真实部署配置)
  - [1.2 架构回顾](#12-架构回顾)
- [2. 瓶颈小结（本方案要解决的）](#2-瓶颈小结本方案要解决的)
- [3. 方案总览与优先级](#3-方案总览与优先级)
- [4. 方案一：Relay 独立服务化 + Worker 调优](#4-方案一relay-独立服务化--worker-调优)
  - [4.1 问题](#41-问题)
  - [4.2 目标](#42-目标)
  - [4.3 实现](#43-实现)
  - [4.4 涉及文件与改动](#44-涉及文件与改动)
  - [4.5 验收](#45-验收)
  - [4.6 风险](#46-风险)
- [5. 方案二：多 Relay 横向扩展 + 负载均衡/故障转移](#5-方案二多-relay-横向扩展--负载均衡故障转移)
  - [5.1 问题](#51-问题)
  - [5.2 目标](#52-目标)
  - [5.3 实现](#53-实现)
  - [5.4 涉及文件与改动](#54-涉及文件与改动)
  - [5.5 验收](#55-验收)
  - [5.6 风险](#56-风险)
- [6. 方案三：statsig 抓取治理（基础单飞 / 进阶预热）](#6-方案三statsig-抓取治理基础单飞--进阶预热)
  - [6.1 问题](#61-问题)
  - [6.2 目标](#62-目标)
  - [6.3 实现](#63-实现)
  - [6.4 涉及文件与改动](#64-涉及文件与改动)
  - [6.5 验收](#65-验收)
  - [6.6 风险](#66-风险)
- [7. 实施路线图](#7-实施路线图)
- [8. 总体风险与回滚](#8-总体风险与回滚)
- [9. 附录：关键代码位置](#9-附录关键代码位置)

---

## 1. 背景与现状

### 1.1 真实部署配置

当前 relay **嵌在客服主应用 `app_kefu:app` 内**，由 systemd 用 gunicorn 拉起：

```ini
ExecStart=/usr/local/bin/gunicorn \
    --access-logfile /home/ubuntu/roboletaikefu/access_log.txt \
    --error-logfile  /home/ubuntu/roboletaikefu/error_log.txt \
    --log-level info \
    --workers 8 \
    --threads 10 \
    --timeout 600 \
    -b 0.0.0.0:9889 app_kefu:app
```

解读：
- `8 workers × 10 threads` ≈ **80 个并发请求槽**（gthread 模型，IO 密集型够用）。
- `--timeout 600`：单请求最多 600 秒（适配长视频流，但卡住的请求会占线程 10 分钟）。
- **relay 与客服系统共用这 80 个槽**（同一个 `app_kefu:app`）。

> 结论：worker 数量本身不差（不是 Flask dev server）。真正的问题是**资源隔离**、**单机上限**、**statsig 抓取治理**三块。

### 1.2 架构回顾

```
客户端 → CF Worker(Hono, 自动横向扩) → relay_server.py(单台 VPS) → 住宅代理 → grok.com
                     │                          │
                   D1/KV                  无头浏览器抓 statsig
```

- **CF 前端**：无状态，V8 isolate 自动扩，基本不是瓶颈。
- **瓶颈全在后端**：relay VPS 吞吐、住宅代理并发、statsig 抓取、grok 每 token 限流。

---

## 2. 瓶颈小结（本方案要解决的）

| # | 瓶颈 | 位置 | 本方案对应 |
|---|---|---|---|
| B1 | relay 与客服共用 80 槽，长视频流可拖垮客服 | `app_kefu:app` 单进程组 | 方案一 |
| B2 | 单台 relay VPS 吞吐/带宽上限 | `relay_server.py` | 方案二 |
| B3 | statsig 抓取锁**仅进程内有效**，8 workers 下最多同时开 8 个 Chromium → OOM 风险 | `relay_server.py` `threading.Lock()` | 方案三-基础单飞 ✅ |
| B4 | statsig 集中失效时抓取串行（60~150s/次）阻塞生成 | `_harvest_statsig` | 方案三-基础单飞 ✅（并发只抓 1 次）/ 进阶预热 ⏸（消除首个等待） |
| B5 | 住宅代理并发/成本、grok 每 token 限流 | 外部资源 | 不在本方案（属采购/运营，见路线图备注） |

---

## 3. 方案总览与优先级

三条线相互独立，可分别落地；建议按下表顺序推进：

| 顺序 | 方案 | 主要收益 | 开发量 | 状态 |
|---|---|---|---|---|
| 1 | **方案一** Relay 独立服务化 + Worker 调优 | 视频流量不再拖垮客服；relay 可独立调优 | 小（配置为主 + 少量代码） | ✅ 已做（`create_app` 已改） |
| 2 | **方案三-基础单飞** relay 侧缓存 + 跨进程锁 | 一举消除 OOM 风险 **和** 刷新风暴（并发只抓 1 次） | 小（纯 Python，不动 CF） | ✅ 已做 |
| 3 | **方案二** 多 Relay 负载均衡 + 故障转移 | 突破单机上限，可线性扩容 + 单点容灾 | 中（数据结构已就绪，改 CF/TS） | 🔨 要做（本阶段重点） |
| 4 | **方案三-进阶** SWR + 定时预热 + id 池化 | 连"首个请求等抓取"也消除 | 中～大（含 CF/TS） | ⏸ 先不做（已规划，见 §6.3.C） |

> **关键洞察**：用户提出的"relay 侧保存最近 id + 刷新时间 + 并发排队复用"其实就是 **single-flight（单飞）**。它把原来拆成的"方案三-A 跨进程锁（防 OOM）"和"方案三-B 池化（治刷新风暴）"两件事，用一个纯 Python、对 CF 透明的机制**同时解决**了并发爆发场景：一场风暴里全机只抓 1 次，其余请求复用。故不再单列"方案三-A/B"，统一为"基础单飞（已做）"+"进阶 SWR/预热（先不做）"。

---

## 4. 方案一：Relay 独立服务化 + Worker 调优

### 4.1 问题

relay 挂在 `app_kefu:app` 里，和客服系统抢同一个 `8×10=80` 槽。视频是**流式长连接**（`_do_request` timeout=300，systemd timeout=600），一波视频高峰可能占满 80 槽，**连客服系统一起卡死**。

### 4.2 目标

- relay 拆成**独立的 gunicorn 服务**（独立端口、独立 worker 池），与客服系统**资源隔离**：视频再爆也压不垮客服。
- relay 服务可独立调优（worker/thread 数、超时、是否上 gevent）。

### 4.3 实现

**第 1 步：relay 独立进程入口**（代码已支持，`relay_server.py` 本就是 Blueprint + `create_app()`）

`relay_server.py` 末尾已有 `create_app()`，可直接被 gunicorn 加载：

```bash
# 独立 systemd 服务（示例），监听独立端口 9890
/usr/local/bin/gunicorn \
    --access-logfile /home/ubuntu/roboletaikefu/relay_access.txt \
    --error-logfile  /home/ubuntu/roboletaikefu/relay_error.txt \
    --log-level info \
    --workers 4 \
    --threads 25 \
    --timeout 600 \
    --graceful-timeout 30 \
    -b 0.0.0.0:9890 "relay_server:create_app()"
```

> 注意 `create_app()` 内需 `init_relay(secret=..., proxy_config=...)`，可在 `create_app` 里读环境变量后调用，避免用默认 secret。

**第 2 步：从客服应用中摘除 relay 蓝图**

`app_kefu.py` 里若有 `app.register_blueprint(relay_bp)`，改为**不再注册**（relay 由独立服务承载）。客服应用回归纯业务。

**第 3 步：CF Worker 侧改指向**

admin 后台把 relay 的 `url` 从 `:9889` 改到新端口/新域名 `:9890`（走 `sslip.io` 等域名，CF 不能直连 IP）。

**第 4 步：Worker 数调优（relay 专用）**

- relay 是纯 IO/流式转发，`--threads` 可以调大（如 `4 workers × 25 threads = 100`）。
- **暂不上 gevent**：`relay_server.py` 用了 `sync_playwright`（子进程 + 阻塞 API），与 gevent monkeypatch 易冲突。等方案三把抓取拆出去后，relay 主体再评估 gevent。

### 4.4 涉及文件与改动

| 文件 | 改动 | 类型 |
|---|---|---|
| `relay_server.py` | `create_app()` 内补 `init_relay(...)` 读环境变量 | 少量代码 |
| `app_kefu.py`（客服侧） | 移除 `register_blueprint(relay_bp)` | 少量代码 |
| systemd 单元（新增） | 新增 `grok-relay.service` 独立拉起 | 运维配置 |
| CF admin 后台 | relay url 指向新端口/域名 | 配置 |

### 4.5 验收

1. relay 独立服务 `curl :9890/relay/ping` 返回 ok。
2. 压测：并发 30 个视频提交打 relay，**客服系统接口响应不受影响**（对照改造前会被拖慢）。
3. 客服应用不再加载 relay 路由（`/relay` 在 `:9889` 返回 404）。

### 4.6 风险

- 端口/域名切换期间短暂不可用 → 灰度：先起新服务，admin 切流后再摘旧蓝图。
- `init_relay` secret 若配错 → relay 全 403；上线前用 `/relay/ping` 验证。

---

## 5. 方案二：多 Relay 横向扩展 + 负载均衡/故障转移

> 状态：🔨 第二阶段重点（本设计为实现级，暂未开发）。纯 CF/TS 侧，不改数据结构，与已上线的"relay 独立服务化 + 基础单飞"互不冲突。

### 5.1 问题

一台 relay VPS 的吞吐/带宽/干净 IP 都有上限。当前**数据结构已支持多台**（`RelayServer` 带 `id/name/url/secret/is_active/priority/last_check_time/last_check_ok`），但有两处硬伤：

**硬伤 1——选取只取第一个**（`src/routes/openai.ts` 169-174 一带）：

```ts
const active = relaySettings.servers
  .filter((s) => s.is_active)
  .sort((a, b) => a.priority - b.priority);
if (active.length > 0) {
  relay = { url: active[0]!.url, secret: active[0]!.secret };  // 永远只用第一台
}
```

**硬伤 2——`relayFetch` 只接单台**（`src/grok/conversation.ts` 216 一带）：某台不可达时只会返回 502，不会切换到其它台。

→ 结果：所有流量永远打到优先级最高的那一台，**没有分流，也没有单请求内的故障转移**。

**已有可复用点**：`src/routes/admin.ts`（782 一带）已实现 ping `/relay/ping` 并回写 `last_check_ok`/`last_check_time` 的逻辑，Cron 巡检可直接复用。

### 5.2 目标

- 多台 relay 之间**负载均衡**（同优先级分摊并发）。
- 某台 relay 失败/不健康时**请求内自动跳到下一台**（故障转移）。
- **健康感知**：自动避开被巡检标记为死的节点，恢复后自动回归。
- 数据结构**不改**（已就绪），只改选取、转发、调度三处逻辑。

### 5.3 实现

分四块：A 选取/负载均衡、B 请求内故障转移、C 调用点接入、D 健康巡检 Cron。

#### A. 选取策略 `pickRelays()`（新增 `src/grok/relayPool.ts`）

```ts
import type { RelaySettings, RelayServer } from "../settings";
import type { RelayOption } from "./conversation";

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export function pickRelays(settings: RelaySettings): RelayOption[] {
  if (!settings.enabled) return [];
  // 1) 过滤：启用 且 未被巡检标记为死（undefined 视为健康，兼容尚未跑过巡检）
  const usable = settings.servers.filter((s) => s.is_active && s.last_check_ok !== false);
  // 2) 按 priority 分层，同层内随机打散做负载均衡
  const byPriority = new Map<number, RelayServer[]>();
  for (const s of usable) {
    const arr = byPriority.get(s.priority) ?? [];
    arr.push(s);
    byPriority.set(s.priority, arr);
  }
  const ordered: RelayServer[] = [];
  for (const p of [...byPriority.keys()].sort((a, b) => a - b)) {
    ordered.push(...shuffle(byPriority.get(p)!));
  }
  // 3) 返回有序候选：[0]=本次首选，其余=failover 备选
  return ordered.map((s) => ({ url: s.url, secret: s.secret }));
}
```

- **负载均衡**：同 `priority` 视为一个均衡池，随机打散 → 天然分摊（CF isolate 无共享状态，随机比轮询更适合无状态边缘环境）。
- **主备语义**：`priority` 数字小 = 高优先层，只有高层全挂才落到下一层。例：两台主力都设 `priority:0`（均衡），一台 `priority:1` 当冷备。
- **避开死节点**：`last_check_ok === false` 的不进候选（靠 D 的巡检回写）。

#### B. 请求内故障转移 `relayFetchWithFailover()`（`src/grok/conversation.ts`）

```ts
export async function relayFetchWithFailover(
  targetUrl: string,
  init: { method: string; headers: Record<string, string>; body: string },
  relays: RelayOption[],
): Promise<Response> {
  if (relays.length === 0) return relayFetch(targetUrl, init, undefined); // 无 relay → 直连
  let last: Response | undefined;
  for (const relay of relays) {
    const resp = await relayFetch(targetUrl, init, relay);
    // 只有"relay 层故障"才换下一台
    if (resp.status !== 502 && resp.status !== 503) return resp;
    console.warn(`[relay] ${relay.url} 返回 ${resp.status}，切换下一台`);
    last = resp;
  }
  return last!; // 全挂，返回最后一次
}
```

**换 / 不换 的判定（关键）：**

| 情况 | 换 relay？ | 原因 |
|---|---|---|
| 网络不可达 / 502 / 503 | ✅ 换 | relay 层故障，换台可能好 |
| **403 反爬**（`/conversations/new`） | ❌ 不换 | statsig/代理问题，换台一样 403 → 交给方案三 statsig 刷新重试（`openai.ts` 237 一带） |
| 401 / 其它 4xx | ❌ 不换 | grok 业务结果，与 relay 无关 |
| 200 | ❌ 直接返回 | — |

> **流式安全**：失败分支（502/503）`relayFetch` 不消费 body，可安全丢弃再试下一台；成功响应直接返回给上层流式转发，不重复读。

#### C. 三个调用点接入（`src/routes/openai.ts`）

选取**每个请求算一次**候选列表，传给三处（内部改用 failover 变体）：

```ts
// 原来：relay = active[0]
const relays = pickRelays(await getRelaySettings(c.env)); // RelayOption[]
// uploadImage / createMediaPost / sendConversationRequest 的 relay 参数 → relays
```

`uploadImage`（`upload.ts`）、`createMediaPost`（`create.ts`）、`sendConversationRequest`（`conversation.ts`）三个函数签名由 `relay?: RelayOption` 改为 `relays: RelayOption[]`，内部把 `relayFetch(...)` 换成 `relayFetchWithFailover(...)`。同一请求的多个子调用各自独立从 `relays[0]` 起 failover（相互独立，可接受）。

#### D. 健康巡检 Cron（`src/index.ts` + `wrangler.toml`）

复用 admin 的 ping 逻辑抽成 `relayHealthCheck(env)`：遍历所有 `is_active` 的 server，ping `/relay/ping`，回写 `last_check_ok`/`last_check_time` 后 `saveRelaySettings`。

```ts
// index.ts scheduled：按 cron 名分流（现有每日 KV 清理保留）
scheduled: (event, env, ctx) => {
  if (event.cron === "0 16 * * *") ctx.waitUntil(runKvDailyClear(env));
  else ctx.waitUntil(relayHealthCheck(env));
},
```

```toml
# wrangler.toml：新增高频巡检（当前只有每日 "0 16 * * *"）
[triggers]
crons = ["0 16 * * *", "*/3 * * * *"]   # 每 3 分钟巡检
```

→ `pickRelays` 自动避开刚挂的节点，无需人工去 admin 关 `is_active`；节点恢复后巡检会重新标 `last_check_ok=true`，自动回到候选。

### 5.4 涉及文件与改动

| 文件 | 改动 | 类型 |
|---|---|---|
| `src/grok/relayPool.ts`（新增） | `pickRelays()` + `shuffle()` | 开发 |
| `src/grok/conversation.ts` | 加 `relayFetchWithFailover()`；`sendConversationRequest` 收 `relays[]` | 开发 |
| `src/grok/upload.ts` / `create.ts` | 参数 `relay` → `relays[]`，内部用 failover | 开发 |
| `src/routes/openai.ts` | `active[0]` → `pickRelays(...)`，三处传 `relays` | 开发 |
| `src/index.ts` `scheduled` | 按 cron 名分流，加 `relayHealthCheck` | 开发 |
| `src/routes/admin.ts` | 抽出 ping 逻辑供 Cron 复用（可选重构） | 开发 |
| `wrangler.toml` | crons 加 `*/3 * * * *` | 配置 |

### 5.5 验收

1. 配 2 台同 `priority:0`，压测看两台 access log **各分到约一半**流量。
2. 手动停掉一台，请求**自动切到另一台**，客户端成功率不掉。
3. `conversations/new` 的 403 **不**触发换 relay（仍走 statsig 刷新）。
4. 停掉的那台 3 分钟内被巡检标 `last_check_ok=false`，之后不再进候选；恢复后自动回归。

### 5.6 风险

- **failover 误判**：务必只对**网络错/502/503**换台；4xx/403 不换，否则会重复打上游。
- **健康过滤缺失**：同优先级随机若不过滤死节点，会把流量打给挂掉的台 → 依赖 D 的巡检回写，或 admin 手动置 `is_active=false`。
- **Cron 频率**：`*/3` 轻量 ping，对 CF 额度无压力；不宜过密。
- **回滚**：CF 改动经 GitHub Actions 部署，回退上个 Worker 版本即可；数据结构未动，relay 配置不受影响。
- **灰度**：先只配 1 台（等价现状）验证无回归，再加第 2 台观察分流。

---

## 6. 方案三：statsig 抓取治理（基础单飞 ✅ / 进阶预热 ⏸）

### 6.1 问题

- **B3（OOM 风险）**：`_harvest_lock` 是**进程内** `threading.Lock()`。8 个 gunicorn worker = 8 把独立锁 → 最坏**同时开 8 个 Chromium**，内存暴涨可能 OOM 拖垮整机。

```168:200:grok2api/grok2api/relay_server.py
# 串行化无头浏览器：同一时刻只允许一个抓取任务...
_harvest_lock = threading.Lock()
...
    if not _harvest_lock.acquire(timeout=max(5, timeout_s)):
        return {"ok": False, "error": "harvester busy（已有抓取任务在运行）", "captured": 0}
```

- **B4（串行阻塞）**：statsig 集中失效时，抓取一次 60~150s，多个刷新排队，期间生成受阻。虽有 D1 缓存 + 30s 刷新节流（`statsig.ts` `REFRESH_THROTTLE_MS`）缓解，但爆发场景仍脆。

### 6.2 目标

1. **基础单飞（本轮已做，纯 relay 侧）**：relay 缓存最近抓到的 real id + 抓取时间；并发刷新只抓 1 次，其余排队复用。一举同时解决 **OOM 风险** 和 **刷新风暴**，对 CF 透明。
2.（先不做，已规划）**SWR + 预热 + 池化**：连"首个请求踩到过期需现抓"的等待也消除。

### 6.3 实现

#### 6.3.A 基础单飞（✅ 本轮已实现于 `relay_server.py`）

> 由用户提出的"保存最近 id + 刷新时间 + 并发排队取最新"落地，等价于经典的 **single-flight**。

数据与锁都放在**进程间共享的文件**上（gunicorn 8 worker 是 8 个进程，进程内变量/`threading.Lock` 互不可见，必须跨进程）：

- **缓存文件** `grok_statsig_cache.json`（默认在系统临时目录，可用 `STATSIG_CACHE_PATH` 覆盖）：存 `x_statsig_id` / `form` / `harvested_at` 等，**只缓存 real 形式**（error 形式不稳定不复用）。
- **跨进程锁** `*.lock`：`O_CREAT|O_EXCL` 原子创建 + `mtime` 陈旧抢占（`_CrossProcessLock`），全机同一时刻最多 1 个 Chromium。

取用流程（`_get_statsig()`）：

```text
请求到达
  ├─ ① 缓存新鲜(<STATSIG_CACHE_TTL 且 form=real)? ── 是 → 直接返回(cached=True，不开浏览器)
  └─ 否 → ② 抢跨进程锁(等待 ~timeout_s)
            ├─ 抢到 → ③ 双检缓存(等锁期间别人可能刚抓好) ── 新鲜 → 返回缓存
            │           └─ 否 → ④ 真正抓取 → 写缓存 → 返回
            └─ 没抢到(别人正在抓，等到超时) → 回看缓存 ── 新鲜 → 返回；否则 busy
```

关键参数：

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `STATSIG_CACHE_TTL` | `90`（秒） | 缓存新鲜期。窗口内的 real id 直接复用。观测到 id 实际有效期更长可调大（更省抓取），反之调小（更保险） |
| `STATSIG_CACHE_PATH` | 系统临时目录 | 缓存/锁文件路径，多实例若共享同机可指向同一路径 |

- **锁陈旧阈值** `stale_seconds = max(210, timeout_s+60)` 必须 > 最长一次抓取耗时（`timeout_s ≤ 150`），否则抓取途中被误抢会重复开浏览器。
- **等锁时长** `max(10, timeout_s+15)`，略大于一次抓取，保证"等待者"能撑到持有者抓完后拿到新缓存。

**效果**：一场刷新风暴（大量并发 403 同时要刷新）里，**全机只抓 1 次浏览器**，其余请求要么命中缓存、要么排队等这 1 次抓完后复用——OOM 不再、抓取次数从 N 压到 1。

#### 6.3.B（⏸ 先不做，已规划）SWR + 定时预热 + id 池化

基础单飞仍有一个残留：真正过期后的**第 1 个**请求要等这次抓取（60~150s）。要连这个也消除，需要 CF 侧配合，属**下一阶段**：

- **SWR（stale-while-revalidate）**：到"软 TTL"先返回旧 id、后台悄悄刷新，只有硬过期才阻塞。
- **定时预热**：CF `scheduled`（`index.ts:43`）加 Cron，在 id 快过期前主动调 `/relay/statsig` 补新 id；`wrangler.toml` 配 Cron trigger。
- **id 池化**：D1/KV 存 3~5 个近期 real id，消费端（`headers.ts` `getDynamicHeaders`）优先取池内 id，池空才兜底现抓。

> 触发条件：待基础单飞上线观测后，若"首个请求等抓取"仍构成明显体验问题，再启动本阶段。

#### 6.3.C（⏸ 先不做，已规划）独立抓取机

把 `_harvest_statsig` 拆成独立小服务/独立 VPS（只跑 `/relay/statsig`），使转发主体**无 Playwright 依赖**、可安心上 gevent，抓取与转发彻底解耦。单机并发压满后再考虑。

### 6.4 涉及文件与改动

| 文件 | 改动 | 类型 | 状态 |
|---|---|---|---|
| `relay_server.py` | 新增 `_CrossProcessLock` + 缓存读写 + `_get_statsig()` 单飞编排；`/relay/statsig` 改调 `_get_statsig` | 开发 | ✅ 已做 |
| `src/index.ts` `scheduled` | （B 阶段）加 statsig 预热 Cron | 开发 | ⏸ 先不做 |
| `wrangler.toml` | （B 阶段）配 Cron triggers | 配置 | ⏸ 先不做 |
| `src/grok/statsig.ts` / `headers.ts` / `settings.ts` | （B 阶段）id 池读写与消费 | 开发 | ⏸ 先不做 |

### 6.5 验收

1. **单飞生效**：8 workers 下并发打 `/relay/statsig`，日志里**只有 1 条"抓取成功"**，其余为"命中缓存复用（未开浏览器）"；`ps` 看同一时刻 Chromium ≤ 1。
2. **缓存复用**：`STATSIG_CACHE_TTL` 窗口内重复请求直接返回 `cached:true`，`elapsed` 极小。
3. **陈旧抢占**：手动删/放旧锁文件，抓取仍能在 `stale_seconds` 后恢复，不会永久死锁。

### 6.6 风险

- 文件锁陈旧超时设太短 → 抓取还没完就被抢占，重复开浏览器。`stale_seconds` 必须 > 最长抓取时间（已取 `max(210, timeout+60)`）。
- `STATSIG_CACHE_TTL` 设得比 id 实际有效期还长 → 可能复用到已失效 id。默认 90s 偏保守；调大前先观测真实有效期。
- 缓存/锁文件默认在临时目录，多台 relay **不共享**该文件 → 各机各自单飞（符合预期）；若要跨机共享需换共享存储（属方案二范畴）。

---

## 7. 实施路线图

| 阶段 | 内容 | 预期收益 | 状态 |
|---|---|---|---|
| **P1** | 方案一：relay 独立服务化 + worker 调优 | 视频不再拖垮客服；relay 可独立调优 | ✅ 已做（`create_app` 已改，待运维起独立服务 + CF 改指向） |
| **P2** | 方案三-基础单飞：relay 侧缓存 + 跨进程锁 | 一举消除 OOM 风险 **和** 刷新风暴 | ✅ 已做（纯 Python，不动 CF） |
| **P3** | 方案二：多 relay 负载均衡 + 故障转移 | 突破单机上限、可线性扩容 + 单点容灾 | 🔨 本阶段重点（改 CF/TS，数据结构已就绪） |
| **P4** | 方案三-进阶：SWR + Cron 预热 + id 池化 | 消除"首个请求等抓取" | ⏸ 先不做（观测后再定） |
| **P5** | 方案三-独立抓取机 + relay 主体上 gevent | 抓取与转发彻底解耦、单机并发再上台阶 | ⏸ 先不做（量级更大时做） |

> **不在本方案（属采购/运营）**：住宅代理加并发套餐、加 sso/ssoSuper token 抬高 grok 每账号 429 天花板。这两项是外部资源投入，随并发规模同步跟进即可。

---

## 8. 总体风险与回滚

- **灰度切换**：方案一/二切 relay 指向时，先起新服务并 `/relay/ping` 验证，admin 切流后再摘旧配置；出问题可即时切回旧 relay。
- **计数/资源泄漏**：方案三改锁后必须验证异常路径也能释放锁（`finally` 里删锁文件），否则会死锁。
- **CF 端改动**：方案二/三的 Worker 改动通过 GitHub Actions 部署，注意步骤状态（偶发 CF API 失败会跳过 Deploy）。
- **回滚点**：三条线彼此独立，任一方案可单独回滚而不影响其他（方案二/三的 CF 改动可回退到上个 Worker 版本；方案一可把 relay 蓝图重新挂回 `app_kefu`）。

---

## 9. 附录：关键代码位置

| 关注点 | 位置 |
|---|---|
| relay 转发 + 流式响应 | `relay_server.py` `relay_forward()`（386）、`generate()`（465-473） |
| relay 请求超时（300s） | `relay_server.py` `_do_request()`（100/114） |
| statsig 进程内锁（保留为二级内保护） | `relay_server.py` `_harvest_lock` |
| statsig 跨进程单飞（缓存+锁+编排） | `relay_server.py` `_CrossProcessLock` / `_read_statsig_cache` / `_get_statsig()` |
| statsig 抓取实现 | `relay_server.py` `_harvest_statsig()` |
| statsig error 形式判定 | `relay_server.py` `_is_error_form_statsig()`（158） |
| relay 独立入口 | `relay_server.py` `create_app()`（478） |
| relay 选取（当前只取第一个） | `src/routes/openai.ts`（169-174） |
| relayFetch 通用中转 | `src/grok/conversation.ts` `relayFetch()`（216） |
| relay 数据结构（已支持多台） | `src/settings.ts` `RelayServer`/`RelaySettings`（34-54） |
| statsig 刷新 + 30s 节流 | `src/grok/statsig.ts`（`REFRESH_THROTTLE_MS`=6、`maybeRefreshStatsig`=49） |
| statsig 消费（生成请求头） | `src/grok/headers.ts` `getDynamicHeaders()`（42） |
| CF Cron 调度钩子 | `src/index.ts` `scheduled`（43-45） |

---

> 免责声明：本文档为工程改造方案。实施前请在测试/灰度环境验证，尤其是 relay 切换与 statsig 锁改造两处。
