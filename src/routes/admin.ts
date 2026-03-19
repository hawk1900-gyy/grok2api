import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdminAuth } from "../auth";
import { getSettings, saveSettings, normalizeCfCookie, getRelaySettings, saveRelaySettings } from "../settings";
import type { RelayServer, RelaySettings } from "../settings";
import { ensureTosAndNsfw } from "../grok/accountSettings";
import {
  addApiKey,
  batchAddApiKeys,
  batchDeleteApiKeys,
  batchUpdateApiKeyStatus,
  deleteApiKey,
  listApiKeys,
  updateApiKeyName,
  updateApiKeyStatus,
} from "../repo/apiKeys";
import { displayKey } from "../utils/crypto";
import { createAdminSession, deleteAdminSession } from "../repo/adminSessions";
import {
  addTokens,
  deleteTokens,
  getAllTags,
  listTokens,
  tokenRowToInfo,
  updateTokenNote,
  updateTokenTags,
  updateTokenLimits,
  resetAllTokenStates,
} from "../repo/tokens";
import { checkRateLimits } from "../grok/rateLimits";
import { addRequestLog, clearRequestLogs, getRequestLogs, getRequestStats } from "../repo/logs";
import {
  deleteCacheRows,
  getCacheSizeBytes,
  listCacheRowsByType,
  listOldestRows,
  type CacheType,
} from "../repo/cache";

import { dbFirst } from "../db";
import { nowMs } from "../utils/time";

function jsonError(message: string, code: string): Record<string, unknown> {
  return { error: message, code };
}

const LEGACY_TOS_NSFW_KEY = "legacy_accounts_tos_nsfw_v1";

async function runTosNsfwFixForTokens(env: Env, rawTokens: string[], concurrency: number): Promise<{ ok: number; failed: number }> {
  const tokens = Array.from(
    new Set(
      rawTokens
        .map((t) => String(t ?? "").trim())
        .filter(Boolean)
        .map((t) => (t.startsWith("sso=") ? t.slice(4).trim() : t)),
    ),
  );
  if (!tokens.length) return { ok: 0, failed: 0 };

  const settings = await getSettings(env);
  const cf = String(settings.grok.cf_clearance ?? "").trim();
  const limit = Math.max(1, Math.min(10, Math.floor(concurrency || 10)));

  let ok = 0;
  let failed = 0;
  let i = 0;

  const worker = async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const idx = i++;
      if (idx >= tokens.length) return;
      const token = tokens[idx]!;
      const res = await ensureTosAndNsfw({ token, cf_clearance: cf });
      if (res.ok) ok += 1;
      else {
        failed += 1;
        console.warn(`[legacy-fix] token=${token.slice(0, 8)}… failed: ${res.error || "unknown"}`);
      }
      // Be nice to the upstream endpoints.
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return { ok, failed };
}

async function maybeStartLegacyTosNsfwFix(env: Env, ctx: ExecutionContext): Promise<void> {
  const now = nowMs();
  const row = await dbFirst<{ value: string; updated_at: number }>(env.DB, "SELECT value, updated_at FROM settings WHERE key = ?", [
    LEGACY_TOS_NSFW_KEY,
  ]);
  if (row?.value?.startsWith("done:")) return;

  const staleAfterMs = 60 * 60 * 1000;
  if (row?.value === "running" && now - (row.updated_at ?? 0) < staleAfterMs) return;

  if (!row) {
    const res = await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)")
      .bind(LEGACY_TOS_NSFW_KEY, "running", now)
      .run();
    if ((res.meta?.changes ?? 0) === 0) return;
  } else {
    const res = await env.DB.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND updated_at = ?")
      .bind("running", now, LEGACY_TOS_NSFW_KEY, row.updated_at)
      .run();
    if ((res.meta?.changes ?? 0) === 0) return;
  }

  ctx.waitUntil(
    (async () => {
      try {
        const tokens = (await listTokens(env.DB)).map((t) => t.token);
        const result = await runTosNsfwFixForTokens(env, tokens, 10);
        const doneValue = `done:${result.ok}/${tokens.length} failed:${result.failed}`;
        await env.DB.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
          .bind(doneValue, nowMs(), LEGACY_TOS_NSFW_KEY)
          .run();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await env.DB.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
          .bind(`error:${msg.slice(0, 180)}`, nowMs(), LEGACY_TOS_NSFW_KEY)
          .run();
      }
    })(),
  );
}

function parseBearer(auth: string | null): string | null {
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function validateTokenType(token_type: string): "sso" | "ssoSuper" {
  if (token_type !== "sso" && token_type !== "ssoSuper") throw new Error("无效的Token类型");
  return token_type;
}

function formatBytes(sizeBytes: number): string {
  const kb = 1024;
  const mb = 1024 * 1024;
  if (sizeBytes < mb) return `${(sizeBytes / kb).toFixed(1)} KB`;
  return `${(sizeBytes / mb).toFixed(1)} MB`;
}

async function clearKvCacheByType(
  env: Env,
  type: CacheType | null,
  batch = 200,
  maxLoops = 20,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < maxLoops; i++) {
    const rows = await listOldestRows(env.DB, type, null, batch);
    if (!rows.length) break;
    const keys = rows.map((r) => r.key);
    await Promise.all(keys.map((k) => env.KV_CACHE.delete(k)));
    await deleteCacheRows(env.DB, keys);
    deleted += keys.length;
    if (keys.length < batch) break;
  }
  return deleted;
}

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.post("/api/login", async (c) => {
  try {
    const body = (await c.req.json()) as { username?: string; password?: string };
    const settings = await getSettings(c.env);

    if (body.username !== settings.global.admin_username || body.password !== settings.global.admin_password) {
      return c.json({ success: false, message: "用户名或密码错误" });
    }

    const token = await createAdminSession(c.env.DB);
    return c.json({ success: true, token, message: "登录成功" });
  } catch (e) {
    return c.json(jsonError(`登录失败: ${e instanceof Error ? e.message : String(e)}`, "LOGIN_ERROR"), 500);
  }
});

adminRoutes.post("/api/logout", requireAdminAuth, async (c) => {
  try {
    const token = parseBearer(c.req.header("Authorization") ?? null);
    if (token) await deleteAdminSession(c.env.DB, token);
    return c.json({ success: true, message: "登出成功" });
  } catch (e) {
    return c.json(jsonError(`登出失败: ${e instanceof Error ? e.message : String(e)}`, "LOGOUT_ERROR"), 500);
  }
});

adminRoutes.get("/api/settings", requireAdminAuth, async (c) => {
  try {
    const settings = await getSettings(c.env);
    return c.json({ success: true, data: settings });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_SETTINGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/settings", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { global_config?: any; grok_config?: any };
    await saveSettings(c.env, { global_config: body.global_config, grok_config: body.grok_config });
    return c.json({ success: true, message: "配置更新成功" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_SETTINGS_ERROR"), 500);
  }
});

adminRoutes.get("/api/storage/mode", requireAdminAuth, async (c) => {
  return c.json({ success: true, data: { mode: "D1" } });
});

adminRoutes.get("/api/tokens", requireAdminAuth, async (c) => {
  try {
    // 后台自动为现有 token 执行 TOS/NSFW 修复（仅执行一次）
    if (c.executionCtx) await maybeStartLegacyTosNsfwFix(c.env, c.executionCtx);
    const rows = await listTokens(c.env.DB);
    const infos = rows.map(tokenRowToInfo);
    return c.json({ success: true, data: infos, total: infos.length });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { tokens?: string[]; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    const count = await addTokens(c.env.DB, tokens, token_type);
    // 为新添加的 token 自动执行 TOS/NSFW 修复
    if (tokens.length && c.executionCtx) {
      c.executionCtx.waitUntil(runTosNsfwFixForTokens(c.env, tokens, 5));
    }
    return c.json({ success: true, message: `添加成功(${count})` });
  } catch (e) {
    return c.json(jsonError(`添加失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { tokens?: string[]; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    const deleted = await deleteTokens(c.env.DB, tokens, token_type);
    return c.json({ success: true, message: `删除成功(${deleted})` });
  } catch (e) {
    return c.json(jsonError(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/tags", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string; tags?: string[] };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const tags = Array.isArray(body.tags) ? body.tags : [];
    await updateTokenTags(c.env.DB, token, token_type, tags);
    return c.json({ success: true, message: "标签更新成功", tags });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_TAGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/note", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string; note?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const note = String(body.note ?? "");
    await updateTokenNote(c.env.DB, token, token_type, note);
    return c.json({ success: true, message: "备注更新成功", note });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_NOTE_ERROR"), 500);
  }
});

adminRoutes.get("/api/tokens/tags/all", requireAdminAuth, async (c) => {
  try {
    const tags = await getAllTags(c.env.DB);
    return c.json({ success: true, data: tags });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_TAGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/reset-all", requireAdminAuth, async (c) => {
  try {
    const affected = await resetAllTokenStates(c.env.DB);
    return c.json({ success: true, message: `已重置 ${affected} 个 token 的状态`, data: { affected } });
  } catch (e) {
    return c.json({ success: false, message: e instanceof Error ? e.message : String(e) }, 500);
  }
});

adminRoutes.post("/api/tokens/refresh", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const settings = await getSettings(c.env);

    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    const cookie = cf ? `sso-rw=${token};sso=${token};${cf}` : `sso-rw=${token};sso=${token}`;

    const result = await checkRateLimits(cookie, settings.grok, "grok-4-fast");
    if (result) {
      const remaining = (result as any).remainingTokens ?? -1;
      const limit = (result as any).limit ?? -1;
      await updateTokenLimits(c.env.DB, token, { remaining_queries: typeof remaining === "number" ? remaining : -1 });
      return c.json({
        success: true,
        message: "Token有效",
        data: { valid: true, remaining_queries: typeof remaining === "number" ? remaining : -1, limit },
      });
    }

    // Fallback：根据本地状态判断原因
    const rows = await listTokens(c.env.DB);
    const row = rows.find((r) => r.token === token && r.token_type === token_type);
    if (!row) {
      return c.json({ success: false, message: "Token数据异常", data: { valid: false, error_type: "unknown" } });
    }
    const now = Date.now();
    if (row.status === "expired") {
      return c.json({ success: false, message: "Token已失效", data: { valid: false, error_type: "expired", error_code: 401 } });
    }
    if (row.cooldown_until && row.cooldown_until > now) {
      const remaining = Math.floor((row.cooldown_until - now + 999) / 1000);
      return c.json({
        success: false,
        message: "Token处于冷却中",
        data: { valid: false, error_type: "cooldown", error_code: 429, cooldown_remaining: remaining },
      });
    }
    const exhausted =
      token_type === "ssoSuper"
        ? row.remaining_queries === 0 || row.heavy_remaining_queries === 0
        : row.remaining_queries === 0;
    if (exhausted) {
      return c.json({
        success: false,
        message: "Token额度耗尽",
        data: { valid: false, error_type: "exhausted", error_code: "quota_exhausted" },
      });
    }
    return c.json({
      success: false,
      message: "服务器被 block 或网络错误",
      data: { valid: false, error_type: "blocked", error_code: 403 },
    });
  } catch (e) {
    return c.json(jsonError(`测试失败: ${e instanceof Error ? e.message : String(e)}`, "TEST_TOKEN_ERROR"), 500);
  }
});

// 手动触发 TOS/NSFW 修复
adminRoutes.post("/api/tokens/fix-tos-nsfw", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { tokens?: string[] };
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    if (!tokens.length) {
      // 如果没有指定 tokens，修复所有 token
      const rows = await listTokens(c.env.DB);
      const allTokens = rows.map((r) => r.token);
      const result = await runTosNsfwFixForTokens(c.env, allTokens, 10);
      return c.json({
        success: true,
        message: `TOS/NSFW 修复完成: ${result.ok} 成功, ${result.failed} 失败`,
        data: result,
      });
    }
    const result = await runTosNsfwFixForTokens(c.env, tokens, 5);
    return c.json({
      success: true,
      message: `TOS/NSFW 修复完成: ${result.ok} 成功, ${result.failed} 失败`,
      data: result,
    });
  } catch (e) {
    return c.json(jsonError(`修复失败: ${e instanceof Error ? e.message : String(e)}`, "FIX_TOS_NSFW_ERROR"), 500);
  }
});

// 获取 TOS/NSFW 修复状态
adminRoutes.get("/api/tokens/fix-tos-nsfw/status", requireAdminAuth, async (c) => {
  try {
    const row = await dbFirst<{ value: string; updated_at: number }>(c.env.DB, "SELECT value, updated_at FROM settings WHERE key = ?", [
      LEGACY_TOS_NSFW_KEY,
    ]);
    if (!row) return c.json({ success: true, data: { status: "not_started" } });
    return c.json({
      success: true,
      data: {
        status: row.value.startsWith("done:") ? "done" : row.value === "running" ? "running" : row.value.startsWith("error:") ? "error" : "unknown",
        detail: row.value,
        updated_at: row.updated_at,
      },
    });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_FIX_STATUS_ERROR"), 500);
  }
});

adminRoutes.get("/api/stats", requireAdminAuth, async (c) => {
  try {
    const rows = await listTokens(c.env.DB);
    const now = Date.now();

    const calc = (type: "sso" | "ssoSuper") => {
      const tokens = rows.filter((r) => r.token_type === type);
      const total = tokens.length;
      const expired = tokens.filter((t) => t.status === "expired").length;
      let cooldown = 0;
      let video_cooldown = 0;
      let exhausted = 0;
      let unused = 0;
      let active = 0;

      for (const t of tokens) {
        if (t.status === "expired") continue;
        if (t.cooldown_until && t.cooldown_until > now) {
          cooldown += 1;
          continue;
        }

        if (t.video_cooldown_until && t.video_cooldown_until > now) {
          video_cooldown += 1;
        }

        const isUnused = type === "ssoSuper" ? t.remaining_queries === -1 && t.heavy_remaining_queries === -1 : t.remaining_queries === -1;
        if (isUnused) {
          unused += 1;
          continue;
        }

        const isExhausted = type === "ssoSuper" ? t.remaining_queries === 0 || t.heavy_remaining_queries === 0 : t.remaining_queries === 0;
        if (isExhausted) {
          exhausted += 1;
          continue;
        }
        active += 1;
      }

      return { total, expired, active, cooldown, video_cooldown, exhausted, unused };
    };

    const normal = calc("sso");
    const superStats = calc("ssoSuper");
    return c.json({ success: true, data: { normal, super: superStats, total: normal.total + superStats.total } });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "STATS_ERROR"), 500);
  }
});

adminRoutes.get("/api/request-stats", requireAdminAuth, async (c) => {
  try {
    const stats = await getRequestStats(c.env.DB);
    return c.json({ success: true, data: stats });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "REQUEST_STATS_ERROR"), 500);
  }
});

// === API Keys ===
adminRoutes.get("/api/keys", requireAdminAuth, async (c) => {
  try {
    const keys = await listApiKeys(c.env.DB);
    const settings = await getSettings(c.env);
    const globalKeySet = Boolean((settings.grok.api_key ?? "").trim());
    const data = keys.map((k) => ({ ...k, display_key: displayKey(k.key) }));
    return c.json({ success: true, data, global_key_set: globalKeySet });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "KEYS_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { name?: string };
    const name = String(body.name ?? "").trim();
    if (!name) return c.json({ success: false, message: "name不能为空" });
    const row = await addApiKey(c.env.DB, name);
    return c.json({ success: true, data: row, message: "Key创建成功" });
  } catch (e) {
    return c.json(jsonError(`添加失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { name_prefix?: string; count?: number };
    const prefix = String(body.name_prefix ?? "").trim();
    const count = Math.max(1, Math.min(100, Number(body.count ?? 1)));
    if (!prefix) return c.json({ success: false, message: "name_prefix不能为空" });
    const rows = await batchAddApiKeys(c.env.DB, prefix, count);
    return c.json({ success: true, data: rows, message: `成功创建 ${rows.length} 个Key` });
  } catch (e) {
    return c.json(jsonError(`批量添加失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string };
    const key = String(body.key ?? "");
    if (!key) return c.json({ success: false, message: "Key不能为空" });
    const ok = await deleteApiKey(c.env.DB, key);
    return c.json(ok ? { success: true, message: "Key删除成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { keys?: string[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const deleted = await batchDeleteApiKeys(c.env.DB, keys);
    return c.json({ success: true, message: `成功删除 ${deleted} 个Key` });
  } catch (e) {
    return c.json(jsonError(`批量删除失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/status", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string; is_active?: boolean };
    const key = String(body.key ?? "");
    const ok = await updateApiKeyStatus(c.env.DB, key, Boolean(body.is_active));
    return c.json(ok ? { success: true, message: "状态更新成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_STATUS_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-status", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { keys?: string[]; is_active?: boolean };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const updated = await batchUpdateApiKeyStatus(c.env.DB, keys, Boolean(body.is_active));
    return c.json({ success: true, message: `成功更新 ${updated} 个Key 状态` });
  } catch (e) {
    return c.json(jsonError(`批量更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_STATUS_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/name", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string; name?: string };
    const ok = await updateApiKeyName(c.env.DB, String(body.key ?? ""), String(body.name ?? ""));
    return c.json(ok ? { success: true, message: "备注更新成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_NAME_ERROR"), 500);
  }
});

// === Logs ===
adminRoutes.get("/api/logs", requireAdminAuth, async (c) => {
  try {
    const limitStr = c.req.query("limit");
    const limit = Math.max(1, Math.min(5000, Number(limitStr ?? 1000)));
    const logs = await getRequestLogs(c.env.DB, limit);
    return c.json({ success: true, data: logs });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_LOGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/logs/clear", requireAdminAuth, async (c) => {
  try {
    await clearRequestLogs(c.env.DB);
    return c.json({ success: true, message: "日志已清空" });
  } catch (e) {
    return c.json(jsonError(`清空失败: ${e instanceof Error ? e.message : String(e)}`, "CLEAR_LOGS_ERROR"), 500);
  }
});

// Cache endpoints (Workers Cache API 无法枚举/统计；这里提供兼容返回，保持后台可用)
adminRoutes.get("/api/cache/size", requireAdminAuth, async (c) => {
  try {
    const bytes = await getCacheSizeBytes(c.env.DB);
    return c.json({
      success: true,
      data: {
        image_size: formatBytes(bytes.image),
        video_size: formatBytes(bytes.video),
        total_size: formatBytes(bytes.total),
        image_size_bytes: bytes.image,
        video_size_bytes: bytes.video,
        total_size_bytes: bytes.total,
      },
    });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_SIZE_ERROR"), 500);
  }
});

adminRoutes.get("/api/cache/list", requireAdminAuth, async (c) => {
  try {
    const t = (c.req.query("type") ?? "image").toLowerCase();
    const type: CacheType = t === "video" ? "video" : "image";
    const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    const { total, items } = await listCacheRowsByType(c.env.DB, type, limit, offset);
    const mapped = items.map((it) => {
      const name = it.key.startsWith(`${type}/`) ? it.key.slice(type.length + 1) : it.key;
      return {
        name,
        size: formatBytes(it.size),
        mtime: it.last_access_at || it.created_at,
        url: `/images/${name}`,
      };
    });

    return c.json({
      success: true,
      data: { total, items: mapped, offset, limit, has_more: offset + mapped.length < total },
    });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/cache/clear", requireAdminAuth, async (c) => {
  try {
    const deletedImages = await clearKvCacheByType(c.env, "image");
    const deletedVideos = await clearKvCacheByType(c.env, "video");
    return c.json({
      success: true,
      message: `缓存清理完成，已删除 ${deletedImages + deletedVideos} 个文件`,
      data: { deleted_count: deletedImages + deletedVideos },
    });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_CLEAR_ERROR"), 500);
  }
});
adminRoutes.post("/api/cache/clear/images", requireAdminAuth, async (c) => {
  try {
    const deleted = await clearKvCacheByType(c.env, "image");
    return c.json({ success: true, message: `图片缓存清理完成，已删除 ${deleted} 个文件`, data: { deleted_count: deleted, type: "images" } });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "IMAGE_CACHE_CLEAR_ERROR"), 500);
  }
});
adminRoutes.post("/api/cache/clear/videos", requireAdminAuth, async (c) => {
  try {
    const deleted = await clearKvCacheByType(c.env, "video");
    return c.json({ success: true, message: `视频缓存清理完成，已删除 ${deleted} 个文件`, data: { deleted_count: deleted, type: "videos" } });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "VIDEO_CACHE_CLEAR_ERROR"), 500);
  }
});

// A lightweight endpoint to create an audit log from the panel if needed (optional)
adminRoutes.post("/api/logs/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { model?: string; status?: number; error?: string };
    await addRequestLog(c.env.DB, {
      ip: "admin",
      model: String(body.model ?? "admin"),
      duration: 0,
      status: Number(body.status ?? 200),
      key_name: "admin",
      token_suffix: "",
      error: String(body.error ?? ""),
    });
    return c.json({ success: true });
  } catch (e) {
    return c.json(jsonError(`写入失败: ${e instanceof Error ? e.message : String(e)}`, "LOG_ADD_ERROR"), 500);
  }
});

// ── Relay 中转管理 ──────────────────────────────────────────

adminRoutes.get("/api/relay", requireAdminAuth, async (c) => {
  try {
    const relay = await getRelaySettings(c.env);
    return c.json({ success: true, data: relay });
  } catch (e) {
    return c.json(jsonError(`读取失败: ${e instanceof Error ? e.message : String(e)}`, "RELAY_READ_ERROR"), 500);
  }
});

adminRoutes.post("/api/relay", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as Partial<RelaySettings>;
    const current = await getRelaySettings(c.env);
    const next: RelaySettings = {
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      servers: Array.isArray(body.servers) ? body.servers : current.servers,
    };
    await saveRelaySettings(c.env, next);
    return c.json({ success: true, data: next });
  } catch (e) {
    return c.json(jsonError(`保存失败: ${e instanceof Error ? e.message : String(e)}`, "RELAY_SAVE_ERROR"), 500);
  }
});

adminRoutes.post("/api/relay/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as Partial<RelayServer>;
    if (!body.url?.trim()) return c.json(jsonError("URL 不能为空", "RELAY_URL_REQUIRED"), 400);
    if (!body.secret?.trim()) return c.json(jsonError("Secret 不能为空", "RELAY_SECRET_REQUIRED"), 400);

    const current = await getRelaySettings(c.env);
    const server: RelayServer = {
      id: crypto.randomUUID(),
      name: (body.name ?? "").trim() || "未命名",
      url: body.url.trim().replace(/\/+$/, ""),
      secret: body.secret.trim(),
      is_active: body.is_active !== false,
      priority: typeof body.priority === "number" ? body.priority : current.servers.length,
      note: (body.note ?? "").trim(),
    };
    current.servers.push(server);
    await saveRelaySettings(c.env, current);
    return c.json({ success: true, data: server });
  } catch (e) {
    return c.json(jsonError(`添加失败: ${e instanceof Error ? e.message : String(e)}`, "RELAY_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/relay/update", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as Partial<RelayServer> & { id: string };
    if (!body.id) return c.json(jsonError("缺少 id", "RELAY_ID_REQUIRED"), 400);

    const current = await getRelaySettings(c.env);
    const idx = current.servers.findIndex((s) => s.id === body.id);
    if (idx === -1) return c.json(jsonError("服务器不存在", "RELAY_NOT_FOUND"), 404);

    const s = current.servers[idx]!;
    if (body.name !== undefined) s.name = body.name.trim();
    if (body.url !== undefined) s.url = body.url.trim().replace(/\/+$/, "");
    if (body.secret !== undefined) s.secret = body.secret.trim();
    if (typeof body.is_active === "boolean") s.is_active = body.is_active;
    if (typeof body.priority === "number") s.priority = body.priority;
    if (body.note !== undefined) s.note = body.note.trim();

    await saveRelaySettings(c.env, current);
    return c.json({ success: true, data: s });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "RELAY_UPDATE_ERROR"), 500);
  }
});

adminRoutes.post("/api/relay/delete", requireAdminAuth, async (c) => {
  try {
    const { id } = (await c.req.json()) as { id?: string };
    if (!id) return c.json(jsonError("缺少 id", "RELAY_ID_REQUIRED"), 400);

    const current = await getRelaySettings(c.env);
    const before = current.servers.length;
    current.servers = current.servers.filter((s) => s.id !== id);
    if (current.servers.length === before) return c.json(jsonError("服务器不存在", "RELAY_NOT_FOUND"), 404);

    await saveRelaySettings(c.env, current);
    return c.json({ success: true });
  } catch (e) {
    return c.json(jsonError(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "RELAY_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/relay/test", requireAdminAuth, async (c) => {
  try {
    const { id } = (await c.req.json()) as { id?: string };
    if (!id) return c.json(jsonError("缺少 id", "RELAY_ID_REQUIRED"), 400);

    const current = await getRelaySettings(c.env);
    const server = current.servers.find((s) => s.id === id);
    if (!server) return c.json(jsonError("服务器不存在", "RELAY_NOT_FOUND"), 404);

    const start = Date.now();
    try {
      const resp = await fetch(`${server.url}/relay/ping`, {
        method: "GET",
        headers: { "X-Relay-Secret": server.secret },
      });
      const elapsed = Date.now() - start;
      const ok = resp.ok;
      const body = await resp.text().catch(() => "");

      server.last_check_time = Date.now();
      server.last_check_ok = ok;
      await saveRelaySettings(c.env, current);

      return c.json({
        success: true,
        data: { ok, status: resp.status, elapsed_ms: elapsed, body: body.slice(0, 500) },
      });
    } catch (fetchErr) {
      server.last_check_time = Date.now();
      server.last_check_ok = false;
      await saveRelaySettings(c.env, current);

      return c.json({
        success: true,
        data: { ok: false, status: 0, elapsed_ms: Date.now() - start, error: String(fetchErr) },
      });
    }
  } catch (e) {
    return c.json(jsonError(`测试失败: ${e instanceof Error ? e.message : String(e)}`, "RELAY_TEST_ERROR"), 500);
  }
});
