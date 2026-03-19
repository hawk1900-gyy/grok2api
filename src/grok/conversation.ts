import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { getModelInfo, toGrokModel } from "./models";

export interface OpenAIChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url?: string } }>;
}

export interface VideoConfig {
  aspect_ratio?: string;
  video_length?: number;
  resolution?: string;
  preset?: string;
}

export interface OpenAIChatRequestBody {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  video_config?: VideoConfig;
}

export const CONVERSATION_API = "https://grok.com/rest/app-chat/conversations/new";

export function extractContent(messages: OpenAIChatMessage[]): { content: string; images: string[] } {
  const formatted: string[] = [];
  const images: string[] = [];

  const roleMap: Record<string, string> = { system: "系统", user: "用户", assistant: "grok" };

  for (const msg of messages) {
    const role = msg.role ?? "user";
    const rolePrefix = roleMap[role] ?? role;
    const content = msg.content ?? "";

    const textParts: string[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "text") textParts.push(item.text ?? "");
        if (item?.type === "image_url") {
          const url = item.image_url?.url;
          if (url) images.push(url);
        }
      }
    } else {
      textParts.push(String(content));
    }

    const msgText = textParts.join("").trim();
    if (msgText) formatted.push(`${rolePrefix}：${msgText}`);
  }

  return { content: formatted.join("\n"), images };
}

/**
 * 将用户 prompt 中的 @图N 引用替换为 Grok 内部的 @fileId 格式。
 * 仅用于 Imagine 视频模式的多图 @ 引用场景。
 *
 * Grok 内部格式: @{fileId} (UUID 直接跟在 @ 后面)
 * 例: "@图1 变身为 @图2" → "@69fd8e5b-... 变身为 @6ca7fbfe-..."
 */
export function resolveImageReferences(message: string, imgIds: string[]): string {
  if (!imgIds.length) return message;

  return message.replace(/@图(\d+)/g, (_match, numStr) => {
    const idx = parseInt(numStr, 10) - 1;
    if (idx >= 0 && idx < imgIds.length) {
      return `@${imgIds[idx]}`;
    }
    return _match;
  });
}

export function buildConversationPayload(args: {
  requestModel: string;
  content: string;
  imgIds: string[];
  imgUris: string[];
  postId?: string;
  settings: GrokSettings;
  videoConfig?: VideoConfig | undefined;
}): { payload: Record<string, unknown>; referer?: string; isVideoModel: boolean } {
  const { requestModel, content, imgIds, imgUris, postId, settings, videoConfig } = args;
  const cfg = getModelInfo(requestModel);
  const { grokModel, mode, isVideoModel } = toGrokModel(requestModel);

  if (cfg?.is_video_model) {
    const aspectRatio = (videoConfig?.aspect_ratio ?? "").trim() || "2:3";
    const videoLengthRaw = Number(videoConfig?.video_length ?? 6);
    const videoLength = Number.isFinite(videoLengthRaw) ? Math.max(1, Math.floor(videoLengthRaw)) : 6;
    const resInput = (videoConfig?.resolution ?? "480p").trim();
    const resolutionName = resInput === "720p" || resInput === "HD" ? "720p" : "480p";
    const preset = (videoConfig?.preset ?? "normal").trim();

    let modeFlag = "--mode=custom";
    if (preset === "fun") modeFlag = "--mode=extremely-crazy";
    else if (preset === "spicy") modeFlag = "--mode=extremely-spicy-or-crazy";

    const assetUrls = imgUris.map((uri) => `https://assets.grok.com/${uri}`);
    const isMultiImage = imgIds.length > 1;
    const textContent = String(content || "").trim();

    let message: string;
    const payload: Record<string, unknown> = {
      temporary: true,
      modelName: grokModel,
      toolOverrides: { videoGen: true },
      enableSideBySide: true,
    };

    const videoGenModelConfig: Record<string, unknown> = {
      parentPostId: postId || (imgIds.length === 1 ? imgIds[0] : ""),
      aspectRatio,
      videoLength,
      resolutionName,
    };

    if (isMultiImage) {
      if (!postId) throw new Error("多图视频模型缺少 postId（需要先创建 media post）");
      message = `${resolveImageReferences(textContent, imgIds)} ${modeFlag}`.trim();
      videoGenModelConfig.isReferenceToVideo = true;
      videoGenModelConfig.imageReferences = assetUrls;
    } else if (imgIds.length === 1) {
      message = `${assetUrls[0]}  @${imgIds[0]} ${textContent} ${modeFlag}`.trim();
      payload.fileAttachments = [imgIds[0]];
    } else {
      if (!postId) throw new Error("无图视频模型缺少 postId（需要先创建 media post）");
      message = `${textContent} ${modeFlag}`.trim();
    }

    payload.message = message;
    payload.responseMetadata = {
      experiments: [],
      modelConfigOverride: {
        modelMap: { videoGenModelConfig },
      },
    };

    return { isVideoModel: true, referer: "https://grok.com/imagine", payload };
  }

  return {
    isVideoModel,
    payload: {
      temporary: settings.temporary ?? true,
      modelName: grokModel,
      message: content,
      fileAttachments: imgIds,
      imageAttachments: [],
      disableSearch: false,
      enableImageGeneration: true,
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      enableImageStreaming: true,
      imageGenerationCount: 2,
      forceConcise: false,
      toolOverrides: {},
      enableSideBySide: true,
      sendFinalMetadata: true,
      isReasoning: false,
      webpageUrls: [],
      disableTextFollowUps: true,
      responseMetadata: { requestModelDetails: { modelId: grokModel } },
      disableMemory: false,
      forceSideBySide: false,
      modelMode: mode,
      isAsyncChat: false,
    },
  };
}

export interface RelayOption {
  url: string;
  secret: string;
}

export async function sendConversationRequest(args: {
  payload: Record<string, unknown>;
  cookie: string;
  settings: GrokSettings;
  referer?: string;
  relay?: RelayOption;
}): Promise<Response> {
  const { payload, cookie, settings, referer, relay } = args;
  const headers = getDynamicHeaders(settings, "/rest/app-chat/conversations/new");
  headers.Cookie = cookie;
  if (referer) headers.Referer = referer;
  const body = JSON.stringify(payload);

  if (relay) {
    try {
      const relayBody = JSON.stringify({
        url: CONVERSATION_API,
        method: "POST",
        headers,
        body,
      });
      const relayResp = await fetch(`${relay.url}/relay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Relay-Secret": relay.secret,
        },
        body: relayBody,
      });
      if (relayResp.status === 502 || relayResp.status === 503) {
        console.error(`[relay] 中转服务内部错误 HTTP ${relayResp.status}`);
      } else if (relayResp.status === 403) {
        const txt = await relayResp.text().catch(() => "");
        if (txt.includes("invalid secret")) {
          console.error("[relay] 中转 Secret 验证失败，请检查管理后台中转配置");
        }
      }
      return relayResp;
    } catch (e) {
      console.error(`[relay] 中转服务不可达: ${e instanceof Error ? e.message : e}`);
      return new Response(JSON.stringify({ error: { code: 502, message: `Relay unreachable: ${e instanceof Error ? e.message : e}` } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return fetch(CONVERSATION_API, { method: "POST", headers, body });
}
