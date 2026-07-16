import type { Env } from "../env";
import { getSettings, saveSettings } from "../settings";
import type { RelayOption } from "./conversation";

// 两次自动刷新之间的最小间隔，避免并发 403 触发抓取风暴
const REFRESH_THROTTLE_MS = 30_000;

/**
 * 调用 relay 的 /relay/statsig 接口，用无头浏览器抓取一个真实可用的 x-statsig-id。
 * statsig 账号无关：任意能登录的 sso 抓到的 id 全池通用。
 */
export async function harvestStatsigId(
  relay: RelayOption,
  sso: string,
  timeoutSec = 75,
): Promise<string | null> {
  try {
    const resp = await fetch(`${relay.url}/relay/statsig`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Relay-Secret": relay.secret },
      body: JSON.stringify({ sso, timeout: timeoutSec }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error(`[statsig] 抓取失败 HTTP ${resp.status}: ${t.slice(0, 200)}`);
      return null;
    }
    const j = (await resp.json().catch(() => null)) as
      | { ok?: boolean; x_statsig_id?: string; form?: string }
      | null;
    if (j?.ok && typeof j.x_statsig_id === "string" && j.x_statsig_id) {
      console.log(`[statsig] 抓取成功 form=${j.form ?? "?"}`);
      return j.x_statsig_id;
    }
    console.error(`[statsig] 抓取返回无有效 id: ${JSON.stringify(j).slice(0, 200)}`);
    return null;
  } catch (e) {
    console.error(`[statsig] 抓取异常: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * 在遇到 403 反爬时尝试刷新 x-statsig-id：
 *  1. 重新读取最新设置（可能有并发请求刚刚刷新过 → 节流复用）
 *  2. 否则调 relay 抓新 id，写回 D1（同时关闭 dynamic_statsig），返回新 id
 * 失败返回 null。
 */
export async function maybeRefreshStatsig(
  env: Env,
  relay: RelayOption,
  sso: string,
): Promise<string | null> {
  const fresh = await getSettings(env).catch(() => null);
  const now = Date.now();
  if (fresh) {
    const last = Number(fresh.grok.statsig_last_refresh ?? 0);
    const currentId = (fresh.grok.x_statsig_id ?? "").trim();
    if (now - last < REFRESH_THROTTLE_MS && currentId) {
      console.log("[statsig] 最近已刷新，复用现有 id（节流）");
      return currentId;
    }
  }

  const id = await harvestStatsigId(relay, sso);
  if (!id) return null;

  await saveSettings(env, {
    grok_config: { x_statsig_id: id, dynamic_statsig: false, statsig_last_refresh: now },
  }).catch((e) => console.error(`[statsig] 写回 D1 失败: ${e instanceof Error ? e.message : e}`));

  return id;
}
