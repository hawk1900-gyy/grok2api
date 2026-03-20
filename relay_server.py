# -*- coding: utf-8 -*-
"""
Grok2API 中转模块 (Flask Blueprint)
部署在有干净 IP 的 VPS 上，接收 CF Worker 的请求并转发到 grok.com。

代理配置: configs/proxy_list.json（路径可通过 init_relay 自定义）
  按 priority 升序尝试，全部失败则 VPS 自身 IP 直连。

独立运行:
  python relay_server.py

嵌入现有 Flask 应用:
  from relay_server import relay_bp, init_relay
  init_relay(secret="your-secret", proxy_config="/path/to/proxy_list.json")
  app.register_blueprint(relay_bp)
"""
import os
import json

from curl_cffi import requests as cffi_requests
import requests as std_requests
from flask import Flask, Blueprint, request, Response, jsonify

from debug_print_manager import debug_print

# ── 模块配置（通过 init_relay 设置，或使用默认值）──

_config = {
    "secret": "grok2api-relay-secret-2024",
    "proxy_config_path": os.path.join(os.path.dirname(os.path.abspath(__file__)), "configs", "proxy_list.json"),
}


def init_relay(secret=None, proxy_config=None):
    """初始化中转模块配置，在 register_blueprint 之前调用"""
    if secret is not None:
        _config["secret"] = secret
    if proxy_config is not None:
        _config["proxy_config_path"] = proxy_config
    secret_display = _config["secret"][:8] + "..." if len(_config["secret"]) > 8 else _config["secret"]
    debug_print(f"relay_server: 模块初始化 secret={secret_display}, proxy_config={_config['proxy_config_path']}")


relay_bp = Blueprint("relay", __name__)


# ── 内部函数 ──

def _load_proxy_config():
    """
    从 proxy_list.json 加载代理配置。
    返回 (proxy_routes, proxy_list):
      proxy_routes: URL 路径关键词列表，命中则走住宅代理
      proxy_list:   已启用的代理列表，按 priority 排序
    """
    path = _config["proxy_config_path"]
    if not os.path.exists(path):
        return [], []
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)

        if isinstance(raw, dict):
            routes = raw.get("proxy_routes", ["/conversations/new"])
            proxies_raw = raw.get("proxies", [])
        else:
            # 兼容旧格式（纯数组）
            routes = ["/conversations/new"]
            proxies_raw = raw

        proxies = [p for p in proxies_raw if isinstance(p, dict) and p.get("enabled") and p.get("proxy", "").strip()]
        proxies.sort(key=lambda p: p.get("priority", 999))
        return routes, proxies
    except Exception as e:
        debug_print(f"Error:relay_server: 代理配置文件加载失败 ({path}): {e}")
        return [], []


def _do_request(method, url, headers, body, proxy_url=None):
    """
    发起 HTTP 请求，流式返回。
    走代理时用 curl_cffi（模拟浏览器 TLS），直连时用标准 requests。
    两者都开启 stream=True 以支持流式转发。
    返回 (resp, error)
    """
    if proxy_url:
        proxies = {"https": proxy_url, "http": proxy_url}
        try:
            resp = cffi_requests.request(
                method=method,
                url=url,
                headers=headers,
                data=body.encode("utf-8") if body else None,
                impersonate="chrome",
                proxies=proxies,
                timeout=300,
                stream=True,
            )
            return resp, None
        except Exception as e:
            return None, str(e)
    else:
        try:
            resp = std_requests.request(
                method=method,
                url=url,
                headers=headers,
                data=body.encode("utf-8") if body else None,
                stream=True,
                timeout=(10, 300),
            )
            return resp, None
        except std_requests.RequestException as e:
            return None, str(e)


def _check_secret():
    """验证请求头中的共享密钥"""
    secret = _config["secret"]
    token = request.headers.get("X-Relay-Secret", "")
    if not secret:
        debug_print("Warning:relay_server: RELAY_SECRET 未设置，跳过验证")
        return True
    if token != secret:
        token_display = token[:8] + "..." if len(token) > 8 else "(empty)"
        debug_print(f"Error:relay_server: Secret 验证失败，收到: {token_display}")
        return False
    return True


# ── 路由 ──

@relay_bp.route("/relay/ping", methods=["GET"])
def relay_ping():
    """健康检查，CF Worker 用来测试连通性"""
    if not _check_secret():
        return jsonify({"ok": False, "error": "invalid secret"}), 403
    _, proxy_list = _load_proxy_config()
    proxy_names = [p.get("name", "unnamed") for p in proxy_list]
    return jsonify({
        "ok": True,
        "service": "grok-relay",
        "proxies": len(proxy_list),
        "proxy_names": proxy_names,
    })


@relay_bp.route("/relay", methods=["POST"])
def relay_forward():
    """
    接收 CF Worker 的转发请求，格式:
    {
        "url": "https://grok.com/rest/app-chat/conversations/new",
        "method": "POST",
        "headers": { "Cookie": "...", ... },
        "body": "{...JSON string...}"
    }
    转发到目标 URL，回传响应。
    """
    if not _check_secret():
        return jsonify({"error": "invalid secret"}), 403

    try:
        data = request.get_json(force=True)
    except Exception as e:
        debug_print(f"Error:relay_server: JSON 解析失败: {e}")
        return jsonify({"error": "invalid JSON body"}), 400

    target_url = data.get("url", "")
    method = data.get("method", "POST").upper()
    headers = data.get("headers", {})
    body = data.get("body", "")

    if not target_url:
        debug_print("Error:relay_server: 请求缺少 url 字段")
        return jsonify({"error": "missing url"}), 400

    if not target_url.startswith("https://grok.com/"):
        debug_print(f"Error:relay_server: 安全拦截，目标 URL 非 grok.com: {target_url}")
        return jsonify({"error": "only grok.com URLs are allowed"}), 403

    debug_print(f"relay_server: 转发 {method} {target_url} (body {len(body)} bytes)")

    proxy_routes, proxy_list = _load_proxy_config()
    need_proxy = any(route in target_url for route in proxy_routes)

    upstream = None
    used_proxy = None

    if need_proxy:
        debug_print(f"relay_server: 命中代理路由规则，尝试住宅代理 (规则: {proxy_routes})")
        for px in proxy_list:
            px_url = px["proxy"].strip()
            px_name = px.get("name", px_url)
            debug_print(f"relay_server: 尝试代理 [{px_name}]")
            resp, err = _do_request(method, target_url, headers, body, proxy_url=px_url)
            if err:
                debug_print(f"Warning:relay_server: 代理 [{px_name}] 连接失败: {err}")
                continue
            if resp.status_code == 403:
                debug_print(f"Warning:relay_server: 代理 [{px_name}] 被 anti-bot 拦截 (403)")
                continue
            upstream = resp
            used_proxy = px_name
            break
        if upstream is None and proxy_list:
            debug_print("Error:relay_server: 所有代理均失败，回退到 VPS 直连")
    else:
        debug_print(f"relay_server: 非 anti-bot 端点，VPS 直连 (省住宅代理流量)")

    if upstream is None:
        resp, err = _do_request(method, target_url, headers, body)
        if err:
            debug_print(f"Error:relay_server: VPS 直连也失败: {err}")
            return jsonify({"error": f"upstream request failed: {err}"}), 502
        upstream = resp
        used_proxy = used_proxy or "直连(VPS自身IP)"

    debug_print(f"relay_server: 上游响应 HTTP {upstream.status_code} (via {used_proxy})")

    resp_headers = {}
    for key in ("content-type",):
        val = upstream.headers.get(key)
        if val:
            resp_headers[key] = val

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=4096):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(generate(), status=upstream.status_code, headers=resp_headers)


# ── 独立运行 ──

def create_app():
    app = Flask(__name__)
    app.register_blueprint(relay_bp)
    return app


if __name__ == "__main__":
    init_relay()
    app = create_app()
    app.run(host="0.0.0.0", port=5100, debug=True)
