import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env";
import { requireApiAuth } from "../auth";
import { getSettings, normalizeCfCookie } from "../settings";
import { isValidModel, MODEL_CONFIG } from "../grok/models";
import { extractContent, buildConversationPayload, sendConversationRequest } from "../grok/conversation";
import { uploadImage } from "../grok/upload";
import { createMediaPost, createPost } from "../grok/create";
import { createOpenAiStreamFromGrokNdjson, parseOpenAiFromGrokNdjson } from "../grok/processor";
import { addRequestLog } from "../repo/logs";
import { applyCooldown, recordTokenFailure, recordTokenSuccess, selectBestToken, selectTokenBySuffix } from "../repo/tokens";
import type { ApiAuthInfo } from "../auth";

function openAiError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: "invalid_request_error", code } };
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export const openAiRoutes = new Hono<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }>();

openAiRoutes.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

openAiRoutes.use("/*", requireApiAuth);

openAiRoutes.get("/models", async (c) => {
  const ts = Math.floor(Date.now() / 1000);
  const data = Object.entries(MODEL_CONFIG).map(([id, cfg]) => ({
    id,
    object: "model",
    created: ts,
    owned_by: "x-ai",
    display_name: cfg.display_name,
    description: cfg.description,
    raw_model_path: cfg.raw_model_path,
    default_temperature: cfg.default_temperature,
    default_max_output_tokens: cfg.default_max_output_tokens,
    supported_max_output_tokens: cfg.supported_max_output_tokens,
    default_top_p: cfg.default_top_p,
  }));
  return c.json({ object: "list", data });
});

openAiRoutes.get("/models/:modelId", async (c) => {
  const modelId = c.req.param("modelId");
  if (!isValidModel(modelId)) return c.json(openAiError(`Model '${modelId}' not found`, "model_not_found"), 404);
  const cfg = MODEL_CONFIG[modelId]!;
  const ts = Math.floor(Date.now() / 1000);
  return c.json({
    id: modelId,
    object: "model",
    created: ts,
    owned_by: "x-ai",
    display_name: cfg.display_name,
    description: cfg.description,
    raw_model_path: cfg.raw_model_path,
    default_temperature: cfg.default_temperature,
    default_max_output_tokens: cfg.default_max_output_tokens,
    supported_max_output_tokens: cfg.supported_max_output_tokens,
    default_top_p: cfg.default_top_p,
  });
});

openAiRoutes.post("/chat/completions", async (c) => {
  c.header("X-Build", "20260313a");
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";

  const origin = new URL(c.req.url).origin;

  let requestedModel = "";
  try {
    const body = (await c.req.json()) as {
      model?: string;
      messages?: any[];
      stream?: boolean;
      video_config?: {
        aspect_ratio?: string;
        video_length?: number;
        resolution?: string;
        preset?: string;
      };
    };

    requestedModel = String(body.model ?? "");
    if (!requestedModel) return c.json(openAiError("Missing 'model'", "missing_model"), 400);
    if (!Array.isArray(body.messages)) return c.json(openAiError("Missing 'messages'", "missing_messages"), 400);
    if (!isValidModel(requestedModel))
      return c.json(openAiError(`Model '${requestedModel}' not supported`, "model_not_supported"), 400);

    const settingsBundle = await getSettings(c.env);

    const retryCodes = Array.isArray(settingsBundle.grok.retry_status_codes)
      ? settingsBundle.grok.retry_status_codes
      : [401, 429];

    const stream = Boolean(body.stream);
    const videoConfig = body.video_config;
    const maxRetry = 3;
    let lastErr: string | null = null;

    const forceSuffix = c.req.header("X-Token-Suffix")?.trim() || "";

    for (let attempt = 0; attempt < maxRetry; attempt++) {
      const chosen = forceSuffix
        ? await selectTokenBySuffix(c.env.DB, forceSuffix)
        : await selectBestToken(c.env.DB, requestedModel);
      if (!chosen) return c.json(openAiError("No available token", "NO_AVAILABLE_TOKEN"), 503);

      const jwt = chosen.token;
      const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
      const cookie = cf ? `sso-rw=${jwt};sso=${jwt};${cf}` : `sso-rw=${jwt};sso=${jwt}`;

      const { content, images } = extractContent(body.messages as any);
      const cfg = MODEL_CONFIG[requestedModel]!;
      const isVideoModel = Boolean(cfg.is_video_model);
      const MAX_IMAGES = 7;
      const imgInputs = images.slice(0, MAX_IMAGES);
      const _dbg: Record<string, unknown> = {
        extractedImages: images.length,
        inputImages: imgInputs.length,
        isVideoModel,
        tokenSuffix: jwt.slice(-6),
        forceSuffix: forceSuffix || undefined,
      };

      try {
        const uploads = await mapLimit(imgInputs, 5, (u) => uploadImage(u, cookie, settingsBundle.grok));
        const imgIds = uploads.map((u) => u.fileId).filter(Boolean);
        const imgUris = uploads.map((u) => u.fileUri).filter(Boolean);
        _dbg.rawUploads = uploads.length;
        _dbg.imgIds = imgIds.length;
        _dbg.imgUris = imgUris.length;
        _dbg.uploadDetails = uploads.map((u, i) => ({
          idx: i,
          hasFileId: Boolean(u.fileId),
          fileIdPrefix: u.fileId?.slice(0, 12) || "(empty)",
          hasFileUri: Boolean(u.fileUri),
        }));

        let postId: string | undefined;
        if (isVideoModel) {
          const branch = imgIds.length > 1 ? "MULTI" : imgIds.length === 1 ? "SINGLE" : "NO_IMG";
          _dbg.videoBranch = branch;
          if (imgIds.length > 1) {
            // 多图: 创建视频容器 post（parentPostId 与图片 ID 独立）
            const post = await createMediaPost(
              { mediaType: "MEDIA_POST_TYPE_VIDEO", prompt: content },
              cookie,
              settingsBundle.grok,
            );
            postId = post.postId || undefined;
          } else if (imgUris.length === 1) {
            // 单图: 从图片创建 post
            const post = await createPost(imgUris[0]!, cookie, settingsBundle.grok);
            postId = post.postId || undefined;
          } else {
            // 无图: 创建视频 post
            const post = await createMediaPost(
              { mediaType: "MEDIA_POST_TYPE_VIDEO", prompt: content },
              cookie,
              settingsBundle.grok,
            );
            postId = post.postId || undefined;
          }
        }

        const { payload, referer } = buildConversationPayload({
          requestModel: requestedModel,
          content,
          imgIds,
          imgUris,
          ...(postId ? { postId } : {}),
          settings: settingsBundle.grok,
          videoConfig,
        });
        _dbg.grokMessage = String(payload.message ?? "").slice(0, 300);
        _dbg.imgIdOrder = imgIds.map((id) => id.slice(0, 12));
        _dbg.contentPreview = content.slice(0, 100);
        _dbg.hasAtRef = /\@图\d/.test(content);

        const upstream = await sendConversationRequest({
          payload,
          cookie,
          settings: settingsBundle.grok,
          ...(referer ? { referer } : {}),
        });

        if (!upstream.ok) {
          const txt = await upstream.text().catch(() => "");
          lastErr = `Upstream ${upstream.status}: ${txt.slice(0, 200)}`;
          await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
          await applyCooldown(c.env.DB, jwt, upstream.status);
          if (retryCodes.includes(upstream.status) && attempt < maxRetry - 1) continue;
          break;
        }

        await recordTokenSuccess(c.env.DB, jwt);

        if (stream) {
          const sse = createOpenAiStreamFromGrokNdjson(upstream, {
            cookie,
            settings: settingsBundle.grok,
            global: settingsBundle.global,
            origin,
            onFinish: async ({ status, duration }) => {
              await addRequestLog(c.env.DB, {
                ip,
                model: requestedModel,
                duration: Number(duration.toFixed(2)),
                status,
                key_name: keyName,
                token_suffix: jwt.slice(-6),
                error: status === 200 ? "" : "stream_error",
              });
            },
          });

          return new Response(sse, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        const json = await parseOpenAiFromGrokNdjson(upstream, {
          cookie,
          settings: settingsBundle.grok,
          global: settingsBundle.global,
          origin,
          requestedModel,
        }) as Record<string, unknown>;
        json._debug = _dbg;

        const duration = (Date.now() - start) / 1000;
        await addRequestLog(c.env.DB, {
          ip,
          model: requestedModel,
          duration: Number(duration.toFixed(2)),
          status: 200,
          key_name: keyName,
          token_suffix: jwt.slice(-6),
          error: "",
        });

        return c.json(json);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = msg;
        await recordTokenFailure(c.env.DB, jwt, 500, msg);
        await applyCooldown(c.env.DB, jwt, 500);
        if (attempt < maxRetry - 1) continue;
      }
    }

    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel,
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: lastErr ?? "unknown_error",
    });

    return c.json(openAiError(lastErr ?? "Upstream error", "upstream_error"), 500);
  } catch (e) {
    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel || "unknown",
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: e instanceof Error ? e.message : String(e),
    });
    return c.json(openAiError("Internal error", "internal_error"), 500);
  }
});

openAiRoutes.options("/*", (c) => c.body(null, 204));
