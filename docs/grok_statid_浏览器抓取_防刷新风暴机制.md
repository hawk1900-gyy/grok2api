# Grok statsig 抓取 —— 防"刷新风暴"机制（单飞 + 跨进程缓存）

> 关联代码：`relay_server.py`（`_get_statsig` / `_CrossProcessLock` / `_read_statsig_cache` / `_write_statsig_cache` / `_cache_fresh` / `_harvest_lock`）
> 关联文档：`grok_statid_浏览器抓取方案.md`（抓取本身）、`relay_server并发解决方案.md`

## 一、要解决的问题：并发抓取风暴

`x-statsig-id` 会过期，一旦过期，**几乎所有在途请求会同时撞 403**。若每个请求各自去开一个无头浏览器抓（单次 60~150s），在 gunicorn **多 worker（多进程）** 下会同时发生：

- 同时启动多个 Chromium → **内存暴涨 / OOM**；
- 每个请求都白等一次 60~150s 的抓取 → 延迟飙升；
- 高频抓取动作本身可能触发 grok 风控。

目标：**全机同一时刻只抓一次；一段时间（默认 90s）内所有请求复用同一个 id，不再开浏览器。** 这就是 single-flight（单飞）。

## 二、核心事实（为什么可以这样缓存）

`x-statsig-id` **账号无关、可跨 SSO / 跨 IP 复用一段时间**（见 `grok_statid_浏览器抓取方案.md`）。因此缓存可以是**全局的、不区分 SSO** —— A 请求抓到的 id，B 请求（哪怕是另一个 sso）也能直接复用。这是本机制成立的前提。

## 三、三个部件

| 部件 | 位置 | 作用 |
|---|---|---|
| **缓存文件** | 临时目录 `grok_statsig_cache.json`（`STATSIG_CACHE_PATH` 可覆盖） | 存 `x_statsig_id` + `harvested_at` 时间戳，原子写 |
| **新鲜期 TTL** | `_STATSIG_CACHE_TTL = 90`（`STATSIG_CACHE_TTL` 可覆盖） | 缓存在此窗口内直接复用 |
| **跨进程文件锁** | `_CrossProcessLock`（`grok_statsig_cache.json.lock`） | `O_CREAT\|O_EXCL` 原子建锁，多 worker 间串行化抓取 |

为什么必须用**文件锁**而不是 `threading.Lock`：gunicorn 是多**进程**，进程内的 `threading.Lock` 无法跨进程串行化。文件锁对 Linux/Windows 通用。

## 四、单飞主流程 `_get_statsig(sso, proxy_url, timeout_s)`

```
1. 读缓存 → real 形式且在 90s 内 → 直接返回 {..., cached:True}（不开浏览器）✅
2. 抢跨进程锁（最多等 timeout+15s）
   └─ 抢不到（别人正在抓）
        → 等到超时后回头再读一次缓存
             ├─ 已新鲜 → 用别人刚抓好的 {..., cached:True} ✅
             └─ 仍无   → 返回 "harvester busy（抓取任务超时未完成）"
3. 抢到锁 → 【双检】再读缓存（等锁期间别的 worker 可能刚抓完）→ 新鲜就直接用 ✅
4. 仍无新鲜缓存 → 真正 _harvest_statsig() 抓一次 → 成功则写缓存
5. finally 释放锁
```

关键代码：

```440:471:d:\develop\mysrc\cursor\iptag\grok2api\grok2api\relay_server.py
def _get_statsig(sso, proxy_url=None, timeout_s=90):
    """
    单飞获取 statsig id：命中缓存直接复用；否则抢跨进程锁抓取（全机唯一），抓完写缓存。
    未抢到锁的并发请求会等到锁释放后取到刚抓好的缓存。返回结构与 _harvest_statsig 一致，
    复用缓存时附带 cached=True。
    """
    cached = _read_statsig_cache()
    if _cache_fresh(cached):
        return {**cached, "cached": True}

    # 锁陈旧阈值 > 最长抓取耗时（timeout_s ≤ 150）+ 浏览器启动余量；等锁时长略大于一次抓取，
    # 以便"等待者"能撑到持有者抓完后拿到新缓存。
    lock = _CrossProcessLock(_STATSIG_LOCK_PATH, stale_seconds=max(210, timeout_s + 60))
    if not lock.acquire(wait_seconds=max(10, timeout_s + 15)):
        # 没抢到锁：持有者可能已抓完并写好缓存，回头再看一次
        cached = _read_statsig_cache()
        if _cache_fresh(cached):
            return {**cached, "cached": True}
        return {"ok": False, "error": "harvester busy（抓取任务超时未完成）", "captured": 0}

    try:
        # 双检：等锁期间别的 worker 可能刚抓好
        cached = _read_statsig_cache()
        if _cache_fresh(cached):
            return {**cached, "cached": True}

        result = _harvest_statsig(sso, proxy_url=proxy_url, timeout_s=timeout_s)
        if result.get("ok"):
            _write_statsig_cache(result)
        return result
    finally:
        lock.release()
```

## 五、关键正确性细节

1. **只缓存 `real` 形式**：`_write_statsig_cache` 与 `_cache_fresh` 都要求 `form == "real"`。降级错误串（`x0:`/`e:`/`x1:` + `TypeError`）不稳定，绝不缓存/复用。

```414:437:d:\develop\mysrc\cursor\iptag\grok2api\grok2api\relay_server.py
def _write_statsig_cache(result):
    """只缓存 real 形式的成功结果（error 形式不稳定，不复用）。原子写。"""
    if not (result.get("ok") and result.get("x_statsig_id") and result.get("form") == "real"):
        return
    payload = dict(result)
    payload["harvested_at"] = time.time()
    try:
        tmp = _STATSIG_CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, _STATSIG_CACHE_PATH)
    except Exception as e:
        debug_print(f"Warning:relay_server: statsig 缓存写入失败: {e}")


def _cache_fresh(cached):
    """缓存有效且在新鲜期内、且为 real 形式，才可复用。"""
    if not cached or not cached.get("ok") or not cached.get("x_statsig_id"):
        return False
    if cached.get("form") != "real":
        return False
    if time.time() - cached.get("harvested_at", 0) > _STATSIG_CACHE_TTL:
        return False
    return True
```

2. **锁陈旧阈值 `stale_seconds = max(210, timeout_s + 60)`**：必须**大于**一次最长抓取耗时。否则持有者还在抓（60~150s），锁却被判"陈旧"被别人抢走 → 又开一个浏览器，破坏单飞。`_CrossProcessLock` 用锁文件 mtime 判断陈旧，防止持有者崩溃后死锁。

3. **等锁时长 `wait_seconds = max(10, timeout_s + 15)`**：让"等待者"能撑到"持有者"抓完并写好缓存，从而**复用**而非自己重抓。

4. **双检（double-check）**：抢到锁后再读一次缓存——等锁期间别的 worker 可能刚好抓完，避免刚拿到锁又多抓一次。

5. **全局缓存、不分 SSO**：因 statsig 账号无关，缓存 key 不带 sso，命中率最大化。

6. **双层锁兜底**：
   - `_get_statsig` 的**跨进程文件锁**：应对多 worker（多进程）。
   - `_harvest_statsig` 内部的**进程内 `_harvest_lock`（threading.Lock）**：即使有人绕过缓存直接调抓取，同进程内也不会并发开浏览器。

7. **原子写缓存**：先写 `.tmp` 再 `os.replace`，避免读到半截 JSON。

## 六、对外可见性

- 该机制**只在 relay(Python) 侧**，对 CF Worker **完全透明**：`/relay/statsig` 返回结构不变，仅在复用缓存时多一个 `cached: true` 标记（并在日志里打印"命中缓存复用，单飞，未开浏览器"）。
- Worker 侧另有自己的 30s 节流 + D1 写回，与此机制叠加，进一步降低抓取频率。

## 七、可调参数与调优

| 参数 | 默认 | 说明 |
|---|---|---|
| `STATSIG_CACHE_TTL` | 90s | 缓存新鲜期。若实测 id 有效期更长，可调大以进一步减少抓取；反之调小更安全 |
| `STATSIG_CACHE_PATH` | 临时目录 `grok_statsig_cache.json` | 缓存文件位置 |
| `timeout` (请求体) | 90，clamp 到 60~150 | 单次抓取上限，同时影响锁的 stale/wait 计算 |

> 注：TTL 取 90s 是保守值（略大于一次抓取耗时，足以吸收一次并发爆发）。若要进一步降低抓取频率/延迟毛刺，可结合 `relay_server并发解决方案.md` 里的 stale-while-revalidate（后台预刷新）、定时预热、id 池化等进阶策略——当前实现为基础单飞，暂未做这些。

## 八、效果

- 第一个撞 403 的请求负责抓（**全机唯一**），抓到即写缓存；
- 之后 90s 内**所有请求（不论哪个 worker、哪个 sso）直接复用**，不再开浏览器；
- 等锁的并发请求最终拿"持有者刚抓好的缓存"，而非各自重抓；
- 从而杜绝多 Chromium 并发驻留导致的 OOM、抓取延迟毛刺与高频抓取风控。
