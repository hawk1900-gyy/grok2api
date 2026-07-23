# Grok `x-statsig-id` 无头浏览器抓取方案

> 关联代码：`relay_server.py`（`_harvest_statsig` / `/relay/statsig`）、`src/grok/statsig.ts`、`src/routes/openai.ts`
> 关联文档：`grok_cf_检测相关验证.md`、`relay_server并发解决方案.md`

## 一、背景与问题

Grok 的 `POST /rest/app-chat/conversations/new`（文本对话、图片/视频生成都走它）受**业务层 anti-bot** 保护，请求头里的 `x-statsig-id` 会被服务端校验。校验失败返回 **403 `{"code":7,"message":"Request rejected by anti-bot rules."}`**（空 body / 非 JSON）。

历史上项目用两类**伪造** statsig：
- `btoa("e:TypeError...")`（老项目 `generateStatsigId()`）
- `x1:...`（参考项目）

这些形式**已被 grok 拒绝**，导致 `conversations/new` 全线 403。手动从浏览器抓一个**真实静态** `x-statsig-id` 填进后台可临时解决，但它**会过期**（实测几小时到十几天），需要一套**自动刷新**机制。

### 错误类型的判别（这决定"该不该去抓 statsig"）

| 症状 | HTTP | 响应体特征 | 含义 | 处理 |
|---|---|---|---|---|
| statsig / 反爬失败 | **403** | 空 body 或 CF HTML，无 JSON | statsig 过期 / IP / TLS | 触发抓新 id 后重试 |
| SSO 失效 | **401** | JSON：`code:16, "Failed to look up session ID ... invalid-credentials"` | 会话死了 | 标记 token、换号（抓 id 没用） |

## 二、关键认知（排查得出的结论）

1. **真 statsig 是唯一决定因素**：同一住宅 IP 下，真 statsig（带或不带 cf_clearance）→ 200；伪造 statsig（即使带 cf_clearance）→ 403。**cf_clearance 非必需**。
2. **statsig 账号无关、可跨 IP/SSO 复用一段时间**：用 A 会话抓到的 id 配 B 会话的 SSO 也能 200（多次实测）。其字面值每次都不同（内嵌随机 nonce + 时间戳），所以"值是否相同"不是有效判据。
3. **statsig 是"按请求"生成、且和端点强度相关**——这是本方案的**核心突破**：
   - 页面加载时后台**读请求**（`GET /rest/...`）携带的 statsig，对严格的**写端点** `/conversations/new` **无效**（仍 403）。
   - 只有由**真实"视频生成"动作**触发的 `/conversations/new` 请求，它携带的 statsig 才被该端点接受，并可复用。
   - **纯文字 + 视频模式即可触发 `/conversations/new`，无需上传图片**。
4. **之前无头抓取失败不是因为无头被识破**，而是只抓了页面加载的读请求 statsig（对 `/new` 无效）。
5. `conversations/new` 之上还有**独立的 IP 信誉层**（CF 边缘）：真 statsig 解决指纹层，但机房 IP 仍可能被该端点降权，故仍需**住宅代理 + Chrome TLS 指纹**。伪造串（`x0:` 等）在新鲜 IP 下偶尔蒙混，承压即挂，**不可靠，不采用**。

## 三、最终方案：无头浏览器驱动 Imagine 视频生成，拦截 `/new` 抓 statsig

在 VPS relay（本就有住宅代理、能直连 grok）上跑 Playwright 无头 Chromium：

1. **导航前**用 `add_init_script` 预注入 onboarding 标记（见第八节），让新版引导层根本不弹。
2. 注入 SSO cookie + 真实 Chrome UA，打开 `https://grok.com/imagine`（登录态）。
3. 等待输入框 `contenteditable` 就绪（保留兜底点掉残留 `Get Started`/`下一个`）。
4. **切换到「视频」模式**：新版是纯图标 `role=radio`（无文字），按 `aria-label` 含 `视频/Video` 定位，否则点第 2 个 radio（摄像机图标）。
5. 输入一句提示词（如 `a cat walking on the beach`）→ 点提交（`aria-label='提交'` + 右下角上箭头兜底 + 回车）。
6. **拦截即将发出的 `POST **/rest/app-chat/conversations/new`**：读取其 `x-statsig-id` 后**立即 `route.abort()`**——请求被掐断，**不真正生成视频、不消耗账号配额**。
7. 返回抓到的 statsig。

> ⚠️ **必须切到视频模式**：新版 imagine 的**图片生成不再走 `/conversations/new`**（改走别的端点），只有视频模式的生成才触发 `/new`。若停在默认图片模式提交，会真生成图片却一个 `/new` 都拦不到（实测踩坑）。

### 为什么 `route.abort()` 后 statsig 仍有效

statsig 是浏览器在**构造请求时**由 grok 前端 JS 现场算好并挂在请求头上的。我们在请求**离开浏览器前**就读到了这个头，再 abort 只是阻止它真正抵达上游——抓到的值本身已经是"合法视频生成请求"的 statsig，因此可原样 replay。

### form 过滤：只要"真实指纹形式"

抓到的 statsig 分两类：
- **真实指纹形式**：base64 解出来是二进制（非 ascii）——稳定，优先选用。
- **降级错误串形式**：解出来是 `x0:` / `e:` / `x1:` + `TypeError`——不稳定，尽量避开。

```159:166:d:\develop\mysrc\cursor\iptag\grok2api\grok2api\relay_server.py
def _is_error_form_statsig(statsig_b64):
    """判断是否为 grok SDK 的降级"错误字符串"形式（x0:/e:/x1: + TypeError），这种不稳定，应尽量避开。"""
    try:
        raw = base64.b64decode(statsig_b64 + "==")
        txt = raw.decode("ascii")
    except Exception:
        return False  # 解不成 ascii → 二进制真实指纹形式
    return txt.startswith(("x0:", "e:", "x1:")) or "TypeError" in txt
```

抓多个时优先取 `real` 形式的最后一个（重试往往更稳），无 real 才退回任意。

## 四、实现要点（`relay_server.py`）

### 抓取核心 `_harvest_statsig(sso, proxy_url, timeout_s)`

拦截 + abort 的关键片段：

```248:260:d:\develop\mysrc\cursor\iptag\grok2api\grok2api\relay_server.py
                def route_new(route):
                    try:
                        sid = route.request.headers.get("x-statsig-id")
                        if sid:
                            captured.append((route.request.url, sid))
                    except Exception:
                        pass
                    try:
                        route.abort()
                    except Exception:
                        pass

                page.route("**/rest/app-chat/conversations/new", route_new)
```

返回结构：
```json
{
  "ok": true,
  "x_statsig_id": "<抓到的真实 id>",
  "form": "real",
  "source": "https://grok.com/rest/app-chat/conversations/new",
  "captured": 2,
  "real_count": 2,
  "elapsed_ms": 14000
}
```

### 资源管理（防内存/僵尸进程）

- **全局线程锁 `_harvest_lock`**：同一时刻只允许 1 个 Chromium，避免并发时多浏览器驻留导致 OOM。
- `browser` 在 `finally` 中确保 `close()`；`with sync_playwright()` 退出再兜底回收 driver。
- 抢不到锁则最多等 `timeout_s`，仍拿不到返回 `busy`，不叠加新浏览器。

### HTTP 端点 `POST /relay/statsig`

- 入参：`{ "sso": "..." }`（statsig 账号无关，可用专用小号，也可传当前号 sso）。
- 需 `X-Relay-Secret` 鉴权；内部走同一套住宅代理。

### 跨进程单飞缓存（single-flight，应对 gunicorn 多 worker）

statsig 全局有效、可复用，因此加了缓存避免"刷新风暴"：
1. 先看缓存：`STATSIG_CACHE_TTL`（默认 **90s**，可环境变量覆盖）内有 real id 直接复用，不开浏览器；
2. 需抓取时抢一把**跨进程文件锁**（`O_CREAT|O_EXCL` + 陈旧保护），全机同一时刻仅 1 个抓取任务；
3. 抢到锁后**双检**缓存（等锁期间别的 worker 可能刚抓好）；
4. 没抢到锁的并发请求，等超时后回读缓存，直接用别人刚抓好的结果。

> 对 CF Worker 完全透明（返回字段不变，仅多一个 `cached` 标记）。进阶的 stale-while-revalidate / 定时预热 / id 池化见 `relay_server并发解决方案.md`。

## 五、Worker 端自愈闭环

`src/routes/openai.ts` + `src/grok/statsig.ts`：

1. 客户端（可用 `X-Raw-Token` 传 sso）调 Worker。
2. Worker 发 `/conversations/new` 撞 **403 anti-bot**（与 401 SSO 失效区分开）。
3. Worker 调 relay `POST /relay/statsig` → 无头驱动 Imagine 视频模式抓 `/new` statsig（route abort，不耗配额）。
4. 新 id 写回 D1、关闭 `dynamic_statsig`；带 30s 节流防抓取风暴。
5. 用新 id 重试 → 成功；后续请求直接命中缓存。

## 六、验证结果（三层均通过）

| 环节 | 结果 |
|---|---|
| 本机无头驱动抓 `/new`（route abort） | ✅ ~29s，`form=real`，replay `/new` → 200 |
| 海外服 `54.178.35.110:9889` `/relay/statsig` | ✅ ~14s，`source=/conversations/new`，replay → 200 |
| CF Worker 端到端（403 → 自动抓 → 写 D1 → 重试） | ✅ 文本 200（首次 23s 含抓取，之后缓存 5.6s）；单图视频 200，46s 出片并下载 3.1MB mp4 |
| **新版前端适配后复测（2026-07-23）** | ✅ 生产函数 `_harvest_statsig` 2/2 抓到 `form=real`（各 ~30s）；CF Worker 单图视频端到端 200，42s 出片下载 727KB mp4 |

## 七、注意事项 / 已知边界

- **statsig 有时间窗**：id 内嵌时间戳，过了 grok 新鲜度窗口即失效（窗口由 grok 决定，可能随时收紧）。靠 403 触发重抓即可自愈。
- **仍需住宅代理 + Chrome 指纹**：`conversations/new` 的 IP 信誉层独立于 statsig，机房 IP 直连仍可能 403。
- **不要用伪造错误串**（`x0:`/`e:`/`x1:`）：新鲜 IP 偶尔能过，承压即挂，不可靠。
- **UI 依赖（脆弱点）**：抓取依赖 Imagine 页的引导层/模式选择/输入框/提交键结构。grok 前端改版会直接打断抓取——2026-07-23 的改版就一次性动了这三块（详见第八节）。**排查前端问题的标准姿势**：无头 headless=True 下截图 + `page.evaluate` dump 出所有可见 `button` 的 `text/aria-label`、`role=radio`、`contenteditable`、`localStorage`，逐帧对比真实 F12 抓包，不要凭猜改选择器。
- **抓取耗时 ~14–60s**：跨进程锁的 `stale_seconds` 必须大于最长一次抓取耗时，否则会在抓取途中被误抢。
- **成本**：route abort 不消耗视频配额；但会真实打开一次无头浏览器（CPU/内存），靠缓存 + 单飞把频率压到最低。
- **住宅代理按流量计费**：反复抓取（每次整页加载几 MB）会吃额度。额度耗尽时所有出口返回 `407 Proxy Authentication Required`（不是抓取逻辑坏了），充值/换凭证后即恢复。
- **图片 URL 透传受图床反盗链影响**：worker 下载公网图时，若图床（如 wikimedia）拦截其 UA 会返回 `下载图片失败: 403`。给最终用户用**不反盗链的存储**（自有 OSS/带签名直链）或改用 base64。

## 八、新版前端适配（2026-07-23，Chrome150 时代）

grok imagine 前端改版后，服务器无头抓取"总失败"。本地无头复现 + dump UI 后定位到**三点叠加**，均已在 `_harvest_statsig` 修复：

1. **新增引导层挡住输入栏**：每个新会话弹「**Imagine Video 1.5 快速现已可用**」弹窗 + 多步「下一个」浮层。旧脚本只点 `Get Started`、时机不稳，关不干净 → 输入栏点不到。
   - **修法**：导航前 `add_init_script` 预注入以下 localStorage 标记（实测抓到的开关），引导层直接不出现：

```233:240:d:\develop\mysrc\cursor\iptag\grok2api\grok2api\relay_server.py
                ctx.add_init_script(
                    "try{"
                    "localStorage.setItem('visited-imagine3','true');"
                    "localStorage.setItem('tour-guide-state',JSON.stringify("
                    "{teamIdsVisited:[],dismissedTooltips:['imagineNewImagineModal']}));"
                    "localStorage.setItem('new-feature-user:imagine:first-use',String(Date.now()));"
                    "}catch(e){}"
                )
```

2. **模式选择器变成纯图标 `role=radio`（无文字）**：`图片`/摄像机(视频)/第三个图标。旧脚本按文字搜「视频」永远找不到 → 切不到视频模式。
   - **修法**：按 `role=radio` + `aria-label` 含 `视频/Video` 定位，兜底点第 2 个 radio（摄像机图标）。

3. **图片模式的生成不再走 `/conversations/new`**：只有视频模式才触发 `/new`。停在默认图片模式提交会真出图却拦不到 statsig。
   - **修法**：必须先切视频模式再提交（见第 2 点）。

配套还加了 **Chrome/150 真实 UA + `zh-CN` locale**，让指纹更接近真实浏览器。

> **经验沉淀**：grok 前端每次改版都可能同时动"引导层 / 模式控件 / 生成端点"三处。定位时优先 dump `localStorage`——很多引导弹窗都有对应的 `visited-*` / `tour-guide-state.dismissedTooltips` 开关，**预注入跳过引导**比"循环点关闭按钮"稳得多。
