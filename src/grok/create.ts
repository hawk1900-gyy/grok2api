import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import type { VideoConfig } from "./conversation";

const ENDPOINT = "https://grok.com/rest/media/post/create";

export type MediaPostType = "MEDIA_POST_TYPE_VIDEO" | "MEDIA_POST_TYPE_IMAGE";

export async function createMediaPost(
  args: { mediaType: MediaPostType; prompt?: string; mediaUrl?: string; videoConfig?: VideoConfig | undefined },
  cookie: string,
  settings: GrokSettings,
): Promise<{ postId: string }> {
  const headers = getDynamicHeaders(settings, "/rest/media/post/create");
  headers.Cookie = cookie;
  headers.Referer = "https://grok.com/imagine";

  const bodyObj: Record<string, unknown> = { mediaType: args.mediaType };
  if (args.mediaType === "MEDIA_POST_TYPE_IMAGE") {
    if (!args.mediaUrl) throw new Error("缺少 mediaUrl");
    bodyObj.mediaUrl = args.mediaUrl;
  } else {
    if (!args.prompt) throw new Error("缺少 prompt");
    bodyObj.prompt = args.prompt;
  }

  if (args.videoConfig) {
    if (args.videoConfig.video_length != null) bodyObj.duration = args.videoConfig.video_length;
    if (args.videoConfig.aspect_ratio) bodyObj.aspectRatio = args.videoConfig.aspect_ratio;
    if (args.videoConfig.resolution) bodyObj.resolution = args.videoConfig.resolution;
  }

  const body = JSON.stringify(bodyObj);
  console.log("[createMediaPost] payload:", body);
  const resp = await fetch(ENDPOINT, { method: "POST", headers, body });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`创建会话失败: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { post?: { id?: string } };
  return { postId: data.post?.id ?? "" };
}

export async function createPost(
  fileUri: string,
  cookie: string,
  settings: GrokSettings,
  videoConfig?: VideoConfig | undefined,
): Promise<{ postId: string }> {
  return createMediaPost(
    {
      mediaType: "MEDIA_POST_TYPE_IMAGE",
      mediaUrl: `https://assets.grok.com/${fileUri}`,
      ...(videoConfig ? { videoConfig } : {}),
    },
    cookie,
    settings,
  );
}
