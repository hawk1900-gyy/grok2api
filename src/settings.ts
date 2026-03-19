import { dbFirst, dbRun } from "./db";
import type { Env } from "./env";
import { nowMs } from "./utils/time";

export interface GlobalSettings {
  base_url?: string;
  log_level?: string;
  image_mode?: "url" | "base64";
  admin_username?: string;
  admin_password?: string;
  image_cache_max_size_mb?: number;
  video_cache_max_size_mb?: number;
}

export interface GrokSettings {
  api_key?: string;
  cf_clearance?: string; // stored as VALUE only (no "cf_clearance=" prefix)
  x_statsig_id?: string;
  dynamic_statsig?: boolean;
  filtered_tags?: string;
  show_thinking?: boolean;
  video_poster_preview?: boolean;
  temporary?: boolean;
  stream_first_response_timeout?: number;
  stream_chunk_timeout?: number;
  stream_total_timeout?: number;
  max_retry?: number;
  retry_codes?: number[];
  retry_status_codes?: number[];
}

export interface RelayServer {
  id: string;
  name: string;
  url: string;
  secret: string;
  is_active: boolean;
  priority: number;
  last_check_time?: number;
  last_check_ok?: boolean;
  note?: string;
}

export interface RelaySettings {
  enabled: boolean;
  servers: RelayServer[];
}

export const DEFAULT_RELAY_SETTINGS: RelaySettings = {
  enabled: false,
  servers: [],
};

export interface SettingsBundle {
  global: Required<GlobalSettings>;
  grok: Required<GrokSettings>;
  relay: RelaySettings;
}

export const DEFAULT_GLOBAL_SETTINGS: Required<GlobalSettings> = {
  base_url: "",
  log_level: "INFO",
  image_mode: "url",
  admin_username: "admin",
  admin_password: "admin",
  image_cache_max_size_mb: 512,
  video_cache_max_size_mb: 1024,
};

export const DEFAULT_GROK_SETTINGS: Required<GrokSettings> = {
  api_key: "",
  cf_clearance: "",
  x_statsig_id: "",
  dynamic_statsig: true,
  filtered_tags: "xaiartifact,xai:tool_usage_card",
  show_thinking: true,
  video_poster_preview: false,
  temporary: false,
  stream_first_response_timeout: 30,
  stream_chunk_timeout: 120,
  stream_total_timeout: 600,
  max_retry: 3,
  retry_codes: [401, 429, 403],
  retry_status_codes: [401, 429, 403],
};

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stripCfPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("cf_clearance=") ? trimmed.slice("cf_clearance=".length) : trimmed;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isPlainObject(value)) {
    const result: PlainObject = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = cloneValue(val);
    }
    return result as T;
  }
  return value;
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base)) {
    return isPlainObject(override) ? (cloneValue(override) as T) : cloneValue(base);
  }

  const result = cloneValue(base) as PlainObject;
  if (!isPlainObject(override)) {
    return result as T;
  }

  for (const [key, val] of Object.entries(override)) {
    const existing = result[key];
    if (isPlainObject(val) && isPlainObject(existing)) {
      result[key] = deepMerge(existing, val);
    } else {
      result[key] = cloneValue(val);
    }
  }

  return result as T;
}

export function normalizeCfCookie(value: string): string {
  const cleaned = stripCfPrefix(value);
  return cleaned ? `cf_clearance=${cleaned}` : "";
}

export function loadGlobalSettings(raw?: string): Required<GlobalSettings> {
  const parsed = raw ? safeParseJson<GlobalSettings>(raw, {}) : {};
  return deepMerge(DEFAULT_GLOBAL_SETTINGS, parsed);
}

export function loadGrokSettings(raw?: string): Required<GrokSettings> {
  const parsed = raw ? safeParseJson<GrokSettings>(raw, {}) : {};
  const merged = deepMerge(DEFAULT_GROK_SETTINGS, parsed);
  const parsedRetryCodes = Array.isArray(parsed.retry_codes);
  const parsedRetryStatusCodes = Array.isArray(parsed.retry_status_codes);
  const retryCodes = !parsedRetryCodes && parsedRetryStatusCodes ? merged.retry_status_codes : merged.retry_codes;
  return {
    ...merged,
    retry_codes: retryCodes,
    retry_status_codes: retryCodes,
    cf_clearance: stripCfPrefix(merged.cf_clearance ?? ""),
  };
}

export function loadRelaySettings(raw?: string): RelaySettings {
  if (!raw) return { ...DEFAULT_RELAY_SETTINGS, servers: [] };
  const parsed = safeParseJson<Partial<RelaySettings>>(raw, {});
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : false,
    servers: Array.isArray(parsed.servers) ? parsed.servers : [],
  };
}

export async function getSettings(env: Env): Promise<SettingsBundle> {
  const globalRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["global"],
  );
  const grokRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["grok"],
  );
  const relayRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["relay"],
  );

  return {
    global: loadGlobalSettings(globalRow?.value),
    grok: loadGrokSettings(grokRow?.value),
    relay: loadRelaySettings(relayRow?.value),
  };
}

export async function getRelaySettings(env: Env): Promise<RelaySettings> {
  const row = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["relay"],
  );
  return loadRelaySettings(row?.value);
}

export async function saveRelaySettings(env: Env, relay: RelaySettings): Promise<void> {
  const now = nowMs();
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["relay", JSON.stringify(relay), now],
  );
}

export async function saveSettings(
  env: Env,
  updates: { global_config?: GlobalSettings; grok_config?: GrokSettings },
): Promise<void> {
  const now = nowMs();
  const current = await getSettings(env);

  const nextGlobal: GlobalSettings = { ...current.global, ...(updates.global_config ?? {}) };
  const nextGrok: GrokSettings = {
    ...current.grok,
    ...(updates.grok_config ?? {}),
    cf_clearance: stripCfPrefix(updates.grok_config?.cf_clearance ?? current.grok.cf_clearance ?? ""),
  };
  const retryCodes = Array.isArray(nextGrok.retry_codes)
    ? nextGrok.retry_codes
    : Array.isArray(nextGrok.retry_status_codes)
      ? nextGrok.retry_status_codes
      : DEFAULT_GROK_SETTINGS.retry_codes;
  nextGrok.retry_codes = retryCodes;
  nextGrok.retry_status_codes = retryCodes;

  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["global", JSON.stringify(nextGlobal), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["grok", JSON.stringify(nextGrok), now],
  );
}
