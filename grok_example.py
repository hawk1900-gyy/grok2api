# -*- coding: utf-8 -*-
"""
Grok2API 调用示例
兼容 OpenAI 格式，需在管理后台创建 API Key 后填入 GROK2API_API_KEY
重点测试：图片生成、视频生成
"""
import base64
import json
import os
import re
import sys

# ── 服务器配置 ──────────────────────────────────────────────
# 预设环境：local = 本地 wrangler dev，remote = Cloudflare Workers 线上
# eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uX2lkIjoiMWFhODUyMTQtZTcwOC00NGEwLTkzM2EtZjNlMDkxZjU3ZDdmIn0.nvb9uuBf5s0GMPYH3e5sYH9nli7sr6hAbxAqQp9PBYY
SERVERS = {
    "local": {
        "name": "本地 (wrangler dev)",
        "base_url": "http://127.0.0.1:8787",
        "api_key": "sk-trDls5adRUtXRQWho8yX0uJFy3SfURzk",
    },
    "remote": {
        "name": "远程 (Cloudflare Workers)",
        "base_url": "https://grok2api.hawk-bc-1900.workers.dev",
        "api_key": "sk-kEw8uhn9rHirupUgP5guG8KWDqxBahcf",
    },
}

# 运行时全局变量，由 _select_server() 设置
BASE_URL = ""
API_KEY = ""

# ── X-Raw-Token 模式 ─────────────────────────────────────────
# 填入 SSO token 后，选择 raw-token 模式可绕过数据库 token 选择，直接用此 token 请求
# 格式：JWT 字符串（不带 sso= 前缀）
X_RAW_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uX2lkIjoiMWFhODUyMTQtZTcwOC00NGEwLTkzM2EtZjNlMDkxZjU3ZDdmIn0.nvb9uuBf5s0GMPYH3e5sYH9nli7sr6hAbxAqQp9PBYY"
USE_RAW_TOKEN = False


# 本地图片路径（相对于脚本所在目录）
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VIDEO_DIR = os.path.join(SCRIPT_DIR, "video")
DEFAULT_IMAGE_PATH = os.path.join(VIDEO_DIR, "test001.jpg")

# 图片/视频生成模型
IMAGE_MODELS = ["grok-imagine-1.0"]
VIDEO_MODELS = ["grok-imagine-0.9", "grok-imagine-1.0-video"]


def _headers():
    """请求头，必须带 Authorization；USE_RAW_TOKEN 时附加 X-Raw-Token"""
    if not API_KEY:
        print("[错误] 请设置 GROK2API_API_KEY 环境变量，或在脚本中填入 API_KEY")
        sys.exit(1)
    h = {
        "Authorization": f"Bearer {API_KEY.strip()}",
        "Content-Type": "application/json",
        "User-Agent": "Grok2API-Python/1.0",
    }
    if USE_RAW_TOKEN and X_RAW_TOKEN:
        h["X-Raw-Token"] = X_RAW_TOKEN.strip()
    return h


def _do_request(req, timeout: int = 30):
    """统一请求，捕获 HTTP 错误并打印响应体便于排查"""
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = ""
        if e.fp:
            body = e.fp.read().decode("utf-8", errors="replace")
        print(f"[HTTP {e.code}] {e.reason}")
        if body:
            print(f"[响应体] {body[:500]}")
        raise


def list_models():
    """获取可用模型列表，返回 (data, models)"""
    import urllib.request

    url = f"{BASE_URL}/v1/models"
    req = urllib.request.Request(url, headers=_headers(), method="GET")
    raw = _do_request(req)
    data = json.loads(raw)
    models = data.get("data", [])
    return data, models


def select_model(models: list) -> str | None:
    """交互式选择模型，输入数字返回 model id"""
    print("\n[模型列表] 输入数字选择（直接回车跳过）:")
    for i, m in enumerate(models, 1):
        mid = m.get("id", "")
        name = m.get("display_name", "")
        tag = ""
        if mid in IMAGE_MODELS:
            tag = " [图片]"
        elif mid in VIDEO_MODELS:
            tag = " [视频]"
        print(f"  {i:2}. {mid}{tag} - {name}")
    try:
        s = input("\n请选择 (1-{}): ".format(len(models))).strip()
        if not s:
            return None
        idx = int(s)
        if 1 <= idx <= len(models):
            return models[idx - 1].get("id")
    except (ValueError, EOFError):
        pass
    return None


def _extract_media_urls(content: str) -> list[str]:
    """从回复内容中提取图片/视频 URL"""
    urls = []
    # <video src="..."> 或 <img src="...">
    for m in re.finditer(r'src="([^"]+)"', content):
        urls.append(m.group(1))
    # Markdown 图片 ![alt](url)
    for m in re.finditer(r'\]\(([^)]+)\)', content):
        u = m.group(1).strip()
        if u.startswith("http"):
            urls.append(u)
    return urls


def _offer_download(content: str, media_type: str, subdir: str = "video"):
    """从回复中提取 URL 并询问是否下载"""
    urls = _extract_media_urls(content)
    if not urls:
        return
    print(f"\n检测到 {len(urls)} 个媒体链接，是否下载？")
    try:
        s = input("下载到 video/ 目录？(y/n，回车=y): ").strip().lower() or "y"
        if s != "y":
            return
    except (EOFError, KeyboardInterrupt):
        return
    out_dir = os.path.join(SCRIPT_DIR, subdir)
    os.makedirs(out_dir, exist_ok=True)
    ext = ".mp4" if media_type == "video" else ".jpg"
    for i, url in enumerate(urls):
        name = f"generated_{media_type}_{i + 1}{ext}"
        save_path = os.path.join(out_dir, name)
        download_media(url, save_path)


def download_media(url: str, save_path: str, timeout: int = 120) -> bool:
    """下载图片/视频到本地。assets.grok.com 需要 SSO Cookie 认证。
    视频可能需要等待 CDN 就绪，404 时自动重试。"""
    import time
    import urllib.error
    import urllib.request

    headers = {"User-Agent": "Grok2API-Python/1.0"}
    if "assets.grok.com" in url and USE_RAW_TOKEN and X_RAW_TOKEN:
        token = X_RAW_TOKEN.strip()
        headers["Cookie"] = f"sso={token};sso-rw={token}"

    is_video = ".mp4" in url or "generated_video" in url
    retry_delays = [10, 15, 20, 30] if is_video else []
    attempts = [0] + retry_delays

    for i, delay in enumerate(attempts):
        if delay > 0:
            print(f"[等待CDN] 视频可能还在处理中，{delay}秒后第{i}次重试...")
            time.sleep(delay)
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            os.makedirs(os.path.dirname(save_path) or ".", exist_ok=True)
            with open(save_path, "wb") as f:
                f.write(data)
            print(f"[已保存] {save_path} ({len(data) / 1024:.1f} KB)")
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404 and i < len(attempts) - 1:
                continue
            print(f"[下载失败] HTTP Error {e.code}: {e.reason}")
            return False
        except Exception as e:
            print(f"[下载失败] {e}")
            return False
    return False


def _image_to_data_url(path: str) -> str:
    """将本地图片转为 data URL，供 API 使用"""
    if not os.path.isfile(path):
        raise FileNotFoundError(f"图片不存在: {path}")
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    ext = os.path.splitext(path)[1].lower()
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"
    return f"data:{mime};base64,{b64}"


def chat_completion(
    messages: list,
    model: str,
    timeout: int = 180,
    video_config: dict | None = None,
):
    """对话补全（非流式），支持图片/视频生成
    video_config: 视频参数 {aspect_ratio, video_length, resolution, preset}
    """
    import urllib.request

    url = f"{BASE_URL}/v1/chat/completions"
    body = {"model": model, "messages": messages, "stream": False}
    if video_config:
        body["video_config"] = video_config
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=_headers(), method="POST"
    )
    raw = _do_request(req, timeout=timeout)
    out = json.loads(raw)
    if "error" in out:
        print(f"[错误] {out['error']}")
        return None, None
    content = out.get("choices", [{}])[0].get("message", {}).get("content", "")
    return out, content


def test_image_generate(model: str = "grok-imagine-1.0"):
    """测试图片生成：文本描述 -> 图片"""
    print(f"\n[图片生成] 模型: {model}")
    print("提示: 输入如「画一个月亮」会生成 2 张图，消耗 4 次额度")
    prompt = input("请输入绘图提示词 (回车默认「画一个月亮」): ").strip() or "画一个月亮"
    messages = [{"role": "user", "content": prompt}]
    print("正在生成，请稍候（约 30-90 秒）...")
    try:
        out, content = chat_completion(messages, model, timeout=120)
        if out:
            print("[回复内容]")
            print(content)
            _offer_download(content, "image", "video")
    except Exception as e:
        print(f"[异常] {e}")


# 视频参数可选值（参考 xAI 官方文档 docs.x.ai）
# grok-imagine-1.0-video: duration 1-15 秒, aspect_ratio, resolution 720p/480p
# grok-imagine-0.9: 可能仅支持 5/8 秒，1.0-video 支持更长
VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]
VIDEO_LENGTHS = [5, 8, 10, 12, 15]  # 秒，1.0-video 支持 1-15 秒
VIDEO_RESOLUTIONS = ["480p", "720p"]  # 官方仅 480p/720p，无 1080p
VIDEO_PRESETS = ["normal", "fun", "spicy"]  # 风格：普通/有趣/刺激（grok2api 扩展）


def _input_video_config(model: str = "") -> dict:
    """交互式输入视频参数，回车使用默认。grok-imagine-1.0-video 支持 1-15 秒"""
    cfg = {}
    print("\n[视频参数] 直接回车使用默认")
    try:
        ar = input(f"  宽高比 {VIDEO_ASPECT_RATIOS} (默认16:9): ").strip() or "16:9"
        if ar in VIDEO_ASPECT_RATIOS:
            cfg["aspect_ratio"] = ar
        length = input(f"  时长(秒) {VIDEO_LENGTHS} (1.0-video支持10/15秒，默认5): ").strip()
        if length and length.isdigit():
            cfg["video_length"] = int(length)
        res = input(f"  分辨率 {VIDEO_RESOLUTIONS} (默认720p): ").strip() or "720p"
        if res in VIDEO_RESOLUTIONS:
            cfg["resolution"] = res
        preset = input(f"  风格 {VIDEO_PRESETS} (默认normal): ").strip().lower() or "normal"
        if preset in VIDEO_PRESETS:
            cfg["preset"] = preset
    except (EOFError, KeyboardInterrupt):
        pass
    return cfg


def _collect_images() -> list[str]:
    """交互式收集图片路径，返回路径列表（1~7 张）"""
    print("\n[图片选择] 最多 7 张，输入路径或文件名（video/ 目录下可只写文件名）")
    print("  - 逐行输入，每行一张图片")
    print("  - 输入空行结束")
    print("  - 直接回车使用默认: test001.jpg")
    paths: list[str] = []
    for i in range(7):
        try:
            hint = f"  图{i + 1}: " if paths else f"  图{i + 1} (回车=test001.jpg): "
            s = input(hint).strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not s:
            if not paths:
                paths.append(DEFAULT_IMAGE_PATH)
            break
        p = s if os.path.isabs(s) else os.path.join(VIDEO_DIR, s)
        if not os.path.isfile(p):
            print(f"    [跳过] 文件不存在: {p}")
            continue
        paths.append(p)
    return paths


def _build_video_messages(image_paths: list[str], prompt: str) -> list[dict]:
    """构建视频生成的 messages，图片按顺序编号（图1, 图2, ...）"""
    content_parts: list[dict] = []
    for p in image_paths:
        content_parts.append({"type": "image_url", "image_url": {"url": _image_to_data_url(p)}})
    content_parts.append({"type": "text", "text": prompt})
    return [{"role": "user", "content": content_parts}]


def test_video_generate(model: str = "grok-imagine-0.9", image_path: str = ""):
    """测试视频生成：单图/多图 + 提示词 -> 视频，支持 @图N 引用和 video_config"""
    print(f"\n[视频生成] 模型: {model}")

    # 单图快捷模式：传了 image_path 直接用
    if image_path:
        image_paths = [image_path] if os.path.isfile(image_path) else []
    else:
        image_paths = _collect_images()

    if not image_paths:
        print("[错误] 未提供有效图片")
        return

    print(f"\n已选择 {len(image_paths)} 张图片:")
    for i, p in enumerate(image_paths, 1):
        print(f"  图{i} = {os.path.basename(p)}")

    if len(image_paths) > 1:
        print("\n[提示] 多图模式支持 @图N 引用，例如:")
        refs = " ".join(f"@图{i + 1}" for i in range(len(image_paths)))
        print(f"  「{refs} 组成一个连贯的故事动画」")
        default_prompt = f"{refs} 这几个画面串成一个连贯的电影片段"
    else:
        default_prompt = "让画面中的人物动起来"

    prompt = input(f"请输入提示词 (回车默认): ").strip() or default_prompt
    print(f"  → {prompt}")

    video_config = _input_video_config(model)
    messages = _build_video_messages(image_paths, prompt)

    if video_config:
        print(f"视频参数: {video_config}")
    total_size = sum(os.path.getsize(p) for p in image_paths)
    print(f"正在上传 {len(image_paths)} 张图片 ({total_size / 1024 / 1024:.1f} MB) 并生成视频...")
    print("请稍候（约 1-3 分钟）...")
    try:
        out, content = chat_completion(
            messages, model, timeout=300, video_config=video_config or None
        )
        if out:
            print("[回复内容]")
            print(content)
            _offer_download(content, "video", "video")
    except Exception as e:
        print(f"[异常] {e}")


def _select_server() -> bool:
    """启动时选择服务器环境，设置全局 BASE_URL / API_KEY。返回 False 表示退出。"""
    global BASE_URL, API_KEY

    # 已通过命令行参数 (--local/--remote) 或环境变量预设
    if BASE_URL and API_KEY:
        return True

    env_url = os.environ.get("GROK2API_BASE_URL")
    env_key = os.environ.get("GROK2API_API_KEY")
    if env_url and env_key:
        BASE_URL, API_KEY = env_url, env_key
        print(f"[环境变量] {BASE_URL}")
        return True

    entries = list(SERVERS.items())
    print("=" * 50)
    print("  Grok2API 测试工具")
    print("=" * 50)
    print("\n选择服务器环境:")
    for i, (key, cfg) in enumerate(entries, 1):
        print(f"  {i}. [{key}] {cfg['name']}")
        print(f"     {cfg['base_url']}")
    print()
    try:
        s = input("请选择 (1/2，回车=1 本地): ").strip() or "1"
        idx = int(s) - 1
        if 0 <= idx < len(entries):
            chosen = entries[idx][1]
            BASE_URL = chosen["base_url"]
            API_KEY = chosen["api_key"]
            print(f"\n→ {chosen['name']}: {BASE_URL}")
            return True
    except (ValueError, EOFError, KeyboardInterrupt):
        pass
    print("未选择，退出")
    return False


def _ask_raw_token():
    """询问是否启用 X-Raw-Token 模式"""
    global USE_RAW_TOKEN
    if not X_RAW_TOKEN:
        return
    short = X_RAW_TOKEN[-12:] if len(X_RAW_TOKEN) > 12 else X_RAW_TOKEN
    try:
        s = input(f"启用 X-Raw-Token 模式？(y/n，回车=n) [token: ...{short}]: ").strip().lower()
        if s == "y":
            USE_RAW_TOKEN = True
            print(f"  → X-Raw-Token 已启用（绕过数据库 token 选择）")
        else:
            print(f"  → 使用数据库 token")
    except (EOFError, KeyboardInterrupt):
        pass


def main():
    if not _select_server():
        return
    _ask_raw_token()
    print("-" * 50)

    # 1. 获取模型列表
    _, models = list_models()
    if not models:
        print("[错误] 无法获取模型列表")
        return

    # 2. 交互选择
    model_id = select_model(models)
    if not model_id:
        print("未选择模型，退出")
        return

    print(f"\n已选择: {model_id}")
    print("-" * 50)

    # 3. 根据模型类型执行测试
    if model_id in IMAGE_MODELS:
        test_image_generate(model_id)
    elif model_id in VIDEO_MODELS:
        print("\n[视频模型] 支持 1~7 张参考图 + @图N 引用")
        print("  @图N 按上传顺序编号: 第 1 张=@图1, 第 2 张=@图2 ...")
        test_video_generate(model_id)
    else:
        # 普通对话/多图问答模型
        print("[对话] 输入问题，直接回车发送「你好」")
        print("  支持多图: 将图片放在 video/ 目录，按提示输入文件名")
        q = input("问题: ").strip() or "你好"
        messages = [{"role": "user", "content": q}]
        print("正在请求...")
        try:
            out, content = chat_completion(messages, model_id)
            if out:
                print(f"[回复] {content}")
        except Exception as e:
            print(f"[异常] {e}")


if __name__ == "__main__":
    # 用法:
    #   python grok_example.py                  # 交互式选择服务器
    #   python grok_example.py --local          # 直接用本地环境
    #   python grok_example.py --remote         # 直接用远程环境
    #   python grok_example.py --local --raw    # 本地 + X-Raw-Token 模式
    #   python grok_example.py <URL> [保存路径] # 直接下载媒体文件
    args = sys.argv[1:]

    if args and args[0].startswith("http"):
        url = args[0]
        save_path = args[1] if len(args) >= 2 else os.path.join(SCRIPT_DIR, "video", "downloaded.mp4")
        print(f"下载: {url}")
        download_media(url, save_path)
    else:
        flags = [a.lstrip("-") for a in args if a.startswith("--")]
        shortcut = next((f for f in flags if f in SERVERS), None)
        if shortcut:
            BASE_URL = SERVERS[shortcut]["base_url"]
            API_KEY = SERVERS[shortcut]["api_key"]
            print(f"→ {SERVERS[shortcut]['name']}: {BASE_URL}\n")
        if "raw" in flags:
            USE_RAW_TOKEN = True
            print(f"→ X-Raw-Token 模式已启用\n")
        main()
