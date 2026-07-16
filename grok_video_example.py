# -*- coding: utf-8 -*-
"""
Grok2API 视频生成示例（轻量版）
仅支持远程 Cloudflare Workers + X-Raw-Token 模式
生成的视频通过 assets.grok.com 直接下载，自动携带 SSO Cookie

图片输入支持两种形式（可混用）：
  1. 本地文件：脚本会读取并转成 base64 data URL 上传
  2. 公网 URL（http/https）：原样传给 CF，由 worker 下载后再上传 grok
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VIDEO_DIR = os.path.join(SCRIPT_DIR, "video")

# ── 配置 ────────────────────────────────────────────────────
# 远程 CF Worker 地址和 API Key（在管理后台创建）
BASE_URL = "https://grok2api.hawk-bc-1900.workers.dev"
API_KEY = "sk-kEw8uhn9rHirupUgP5guG8KWDqxBahcf"

# 视频模型
# 注意：0.9 / 1.0-video / 1.5 三个 ID 发给 grok 的请求完全一致（都走 imagine-video-gen，
# payload 不含版本字段），实际版本由 grok 服务端决定，无法通过 model ID 强制指定。默认用一个即可。
VIDEO_MODELS = ["grok-imagine-0.9", "grok-imagine-1.0-video", "grok-imagine-1.5"]
DEFAULT_MODEL = "grok-imagine-1.0-video"

# 视频参数可选值
ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]
RESOLUTIONS = ["480p", "720p"]


# ── 核心函数 ─────────────────────────────────────────────────

def generate_video(
    raw_token: str,
    image_paths: list[str],
    prompt: str,
    model: str = DEFAULT_MODEL,
    aspect_ratio: str = "16:9",
    video_length: int = 5,
    resolution: str = "720p",
    timeout: int = 300,
) -> dict:
    """
    调用 Grok2API 生成视频

    Args:
        raw_token:    grok.com SSO JWT（必须）
        image_paths:  参考图（1~7 项），每项可为本地文件路径或公网 http(s) URL
        prompt:       提示词，多图时可用 @图1 @图2 引用
        model:        视频模型 ID
        aspect_ratio: 宽高比
        video_length: 时长（秒）
        resolution:   分辨率 480p/720p
        timeout:      请求超时（秒）

    Returns:
        dict: {
            "video_url":     视频直链（assets.grok.com）,
            "thumbnail_url": 缩略图直链,
            "raw_content":   原始回复内容,
        }

    Raises:
        ValueError: 参数校验失败
        RuntimeError: API 请求失败
    """
    if not raw_token or not raw_token.strip():
        raise ValueError("raw_token 不能为空，请传入 grok.com SSO JWT")
    if not image_paths:
        raise ValueError("至少需要 1 张参考图片")
    if len(image_paths) > 7:
        raise ValueError("最多支持 7 张参考图片")

    raw_token = raw_token.strip()

    # 构建 multimodal messages（本地文件转 base64；公网 URL 原样透传给 CF 下载）
    content_parts = []
    for item in image_paths:
        content_parts.append({
            "type": "image_url",
            "image_url": {"url": _to_image_url(item)},
        })
    content_parts.append({"type": "text", "text": prompt})

    body = {
        "model": model,
        "messages": [{"role": "user", "content": content_parts}],
        "stream": False,
        "video_config": {
            "aspect_ratio": aspect_ratio,
            "video_length": video_length,
            "resolution": resolution,
        },
    }

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "User-Agent": "Grok2API-VideoExample/1.0",
        "X-Raw-Token": raw_token,
    }

    req = urllib.request.Request(
        f"{BASE_URL}/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.fp.read().decode("utf-8", errors="replace") if e.fp else ""
        raise RuntimeError(f"API 请求失败 HTTP {e.code}: {err_body[:500]}") from e

    if "error" in data:
        raise RuntimeError(f"API 返回错误: {data['error']}")

    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    video_url, thumbnail_url = _extract_video_urls(content)

    return {
        "video_url": video_url,
        "thumbnail_url": thumbnail_url,
        "raw_content": content,
    }


def download_video(url: str, raw_token: str, save_path: str, timeout: int = 120) -> str:
    """
    下载视频文件，自动携带 SSO Cookie 认证。
    视频可能需要等待 CDN 就绪，404 时自动重试。

    Args:
        url:        视频地址（assets.grok.com 或其他）
        raw_token:  grok.com SSO JWT（用于 Cookie 认证）
        save_path:  保存路径
        timeout:    下载超时（秒）

    Returns:
        str: 保存的文件路径

    Raises:
        RuntimeError: 下载失败
    """
    import time

    raw_token = raw_token.strip()
    headers = {"User-Agent": "Grok2API-VideoExample/1.0"}
    if "assets.grok.com" in url:
        headers["Cookie"] = f"sso={raw_token};sso-rw={raw_token}"

    retry_delays = [10, 15, 20, 30]
    attempts = [0] + retry_delays

    for i, delay in enumerate(attempts):
        if delay > 0:
            print(f"  [等待CDN] 视频可能还在处理中，{delay}秒后第{i}次重试...")
            time.sleep(delay)
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            os.makedirs(os.path.dirname(save_path) or ".", exist_ok=True)
            with open(save_path, "wb") as f:
                f.write(data)
            return save_path
        except urllib.error.HTTPError as e:
            if e.code == 404 and i < len(attempts) - 1:
                continue
            raise RuntimeError(f"下载失败 HTTP {e.code}: {e.reason}") from e

    raise RuntimeError("下载失败：重试次数用尽，视频仍不可用")


# ── 内部工具 ─────────────────────────────────────────────────

def _is_http_url(s: str) -> bool:
    return s.strip().lower().startswith(("http://", "https://"))


def _to_image_url(item: str) -> str:
    """本地文件 → base64 data URL；http(s) 链接 → 原样返回（交给 CF worker 下载）。"""
    if _is_http_url(item):
        return item.strip()
    return _image_to_data_url(item)


def _image_to_data_url(path: str) -> str:
    if not os.path.isfile(path):
        raise FileNotFoundError(f"图片不存在: {path}")
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    ext = os.path.splitext(path)[1].lower()
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"
    return f"data:{mime};base64,{b64}"


def _extract_video_urls(content: str) -> tuple[str, str]:
    """从回复 HTML 中提取视频 URL 和缩略图 URL"""
    video_url = ""
    thumbnail_url = ""
    # <video src="..."> 或 <a href="...">
    for pattern in [r'<video[^>]+src="([^"]+)"', r'<a[^>]+href="([^"]+)"']:
        m = re.search(pattern, content)
        if m:
            video_url = m.group(1)
            break
    # <img src="..."> 缩略图
    m = re.search(r'<img[^>]+src="([^"]+)"', content)
    if m:
        thumbnail_url = m.group(1)
    return video_url, thumbnail_url


# ── 交互式 CLI ───────────────────────────────────────────────

def _cli_collect_images() -> list[str]:
    """交互收集图片：支持本地文件名/路径，或公网 http(s) URL"""
    print("\n[图片选择] 最多 7 张，放在 video/ 目录下可只写文件名，也可粘贴 http(s) 图片链接")
    print("  逐行输入，空行结束；直接回车使用默认 test001.jpg")
    paths = []
    for i in range(7):
        try:
            hint = f"  图{i + 1}: " if paths else f"  图{i + 1} (回车=test001.jpg): "
            s = input(hint).strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not s:
            if not paths:
                default = os.path.join(VIDEO_DIR, "test001.jpg")
                if os.path.isfile(default):
                    paths.append(default)
                else:
                    print(f"    默认图片不存在: {default}")
            break
        if _is_http_url(s):
            paths.append(s)
            continue
        p = s if os.path.isabs(s) else os.path.join(VIDEO_DIR, s)
        if not os.path.isfile(p):
            print(f"    [跳过] 文件不存在: {p}")
            continue
        paths.append(p)
    return paths


def _cli_input_config() -> dict:
    """交互输入视频参数"""
    cfg = {"aspect_ratio": "16:9", "video_length": 5, "resolution": "720p"}
    print("\n[视频参数] 直接回车使用默认")
    try:
        ar = input(f"  宽高比 {ASPECT_RATIOS} (默认16:9): ").strip()
        if ar in ASPECT_RATIOS:
            cfg["aspect_ratio"] = ar
        length = input(f"  时长(秒) 1-10 (默认5): ").strip()
        if length and length.isdigit() and 1 <= int(length) <= 10:
            cfg["video_length"] = int(length)
        res = input(f"  分辨率 {RESOLUTIONS} (默认720p): ").strip()
        if res in RESOLUTIONS:
            cfg["resolution"] = res
    except (EOFError, KeyboardInterrupt):
        pass
    return cfg


def main():
    print("=" * 50)
    print("  Grok2API 视频生成（X-Raw-Token 模式）")
    print("=" * 50)

    # 1. 输入 SSO Token
    raw_token = input("\n请输入 grok.com SSO Token (JWT): ").strip()
    if not raw_token:
        print("[错误] Token 不能为空")
        return

    # 2. 视频模型（各版本内部请求一致，默认用 1.0-video；时长支持 1-10 秒；回车即可）
    model = input(f"\n视频模型 (回车默认 {DEFAULT_MODEL}): ").strip() or DEFAULT_MODEL
    if model not in VIDEO_MODELS:
        print(f"  [提示] {model} 非已知视频模型，仍按你输入的发送")
    print(f"  → 模型: {model}")
    print("  (0.9 / 1.0-video / 1.5 内部请求一致，实际版本由 grok 服务端决定)")

    # 3. 收集图片
    image_paths = _cli_collect_images()
    if not image_paths:
        print("[错误] 未提供有效图片")
        return
    print(f"\n已选择 {len(image_paths)} 张图片:")
    for i, p in enumerate(image_paths, 1):
        label = p if _is_http_url(p) else os.path.basename(p)
        print(f"  图{i} = {label}")

    # 4. 提示词
    if len(image_paths) > 1:
        refs = " ".join(f"@图{i}" for i in range(1, len(image_paths) + 1))
        default_prompt = f"{refs} 串成一个连贯的电影片段"
    else:
        default_prompt = "让画面中的人物动起来"
    prompt = input(f"\n请输入提示词 (回车默认): ").strip() or default_prompt
    print(f"  → {prompt}")

    # 5. 视频参数
    cfg = _cli_input_config()
    print(f"  → 参数: {cfg}")

    # 6. 生成
    local_imgs = [p for p in image_paths if not _is_http_url(p)]
    url_imgs = [p for p in image_paths if _is_http_url(p)]
    total_mb = sum(os.path.getsize(p) for p in local_imgs) / 1024 / 1024
    print(f"\n正在提交 {len(image_paths)} 张图片（本地 {len(local_imgs)} 张 {total_mb:.1f} MB，URL {len(url_imgs)} 张）并生成视频...")
    print("请稍候（约 1-3 分钟）...\n")

    try:
        result = generate_video(
            raw_token=raw_token,
            image_paths=image_paths,
            prompt=prompt,
            model=model,
            **cfg,
        )
    except Exception as e:
        print(f"[生成失败] {e}")
        return

    print(f"[原始回复]\n{result['raw_content']}\n")

    video_url = result["video_url"]
    if not video_url:
        print("[警告] 未从回复中提取到视频链接")
        return

    print(f"[视频链接] {video_url}")
    if result["thumbnail_url"]:
        print(f"[缩略图]   {result['thumbnail_url']}")

    # 7. 下载
    try:
        s = input("\n下载到 video/ 目录？(y/n，回车=y): ").strip().lower() or "y"
    except (EOFError, KeyboardInterrupt):
        return
    if s != "y":
        return

    os.makedirs(VIDEO_DIR, exist_ok=True)
    save_path = os.path.join(VIDEO_DIR, "generated_video.mp4")
    print(f"正在下载...")
    try:
        saved = download_video(video_url, raw_token, save_path)
        size_kb = os.path.getsize(saved) / 1024
        print(f"[已保存] {saved} ({size_kb:.1f} KB)")
    except Exception as e:
        print(f"[下载失败] {e}")


if __name__ == "__main__":
    main()
