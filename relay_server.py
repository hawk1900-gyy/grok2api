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
import re
import json
import time
import base64
import threading

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


# ── statsig 抓取（无头浏览器）──

_STATSIG_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
)


def _parse_proxy_for_playwright(proxy_url):
    """把 http://user:pass@host:port 解析成 Playwright 需要的 dict。无代理返回 None。"""
    if not proxy_url:
        return None
    m = re.match(r"^(https?)://(?:([^:@]+):([^@]*)@)?([^:/@]+):(\d+)", proxy_url.strip())
    if not m:
        return None
    scheme, user, pwd, host, port = m.groups()
    out = {"server": f"{scheme}://{host}:{port}"}
    if user:
        out["username"] = user
        out["password"] = pwd or ""
    return out


def _is_error_form_statsig(statsig_b64):
    """判断是否为 grok SDK 的降级"错误字符串"形式（x0:/e:/x1: + TypeError），这种不稳定，应尽量避开。"""
    try:
        raw = base64.b64decode(statsig_b64 + "==")
        txt = raw.decode("ascii")
    except Exception:
        return False  # 解不成 ascii → 二进制真实指纹形式
    return txt.startswith(("x0:", "e:", "x1:")) or "TypeError" in txt


# 串行化无头浏览器：同一时刻只允许一个抓取任务，避免并发时多个 Chromium 同时驻留导致内存飙升
_harvest_lock = threading.Lock()


def _harvest_statsig(sso, proxy_url=None, timeout_s=90):
    """
    用无头 Chromium 打开 grok.com/imagine（登录态），**实际驱动一次视频生成动作**，
    拦截其发出的 POST /rest/app-chat/conversations/new 请求，抓取该请求携带的
    真实 x-statsig-id，随后 abort 掉该请求（不真正生成视频、不消耗配额）。

    为什么必须驱动视频生成：
      grok 的 statsig 是"按请求"生成的。页面加载时后台读请求（GET /rest/...）携带的
      statsig 对严格的写端点 /conversations/new 无效（会 403 anti-bot）。只有由真实
      "视频生成"动作触发的 /conversations/new 请求，其 statsig 才被该端点接受，且可
      跨 IP、跨 SSO 复用一段时间。纯文字 + 视频模式即可触发，无需上传图片。

    资源管理：
      - 全局锁串行执行，任意时刻最多 1 个浏览器进程；
      - browser 在 finally 中确保 close()，即使异常也不残留进程；
      - with sync_playwright() 退出时停止 driver，二次兜底回收。
    """
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        return {"ok": False, "error": f"playwright 未安装: {e}"}

    proxy_dict = _parse_proxy_for_playwright(proxy_url)
    captured = []  # (url, statsig)
    t0 = time.time()

    # 抢锁：若已有抓取在跑，最多等 timeout_s，仍拿不到就返回 busy（不再叠加新浏览器）
    if not _harvest_lock.acquire(timeout=max(5, timeout_s)):
        return {"ok": False, "error": "harvester busy（已有抓取任务在运行）", "captured": 0}

    try:
        with sync_playwright() as p:
            browser = None
            try:
                launch_kwargs = {
                    "headless": True,
                    "args": ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
                }
                if proxy_dict:
                    launch_kwargs["proxy"] = proxy_dict
                browser = p.chromium.launch(**launch_kwargs)
                ctx = browser.new_context(viewport={"width": 1280, "height": 800})
                ctx.add_cookies([
                    {"name": "sso", "value": sso, "domain": ".grok.com", "path": "/"},
                    {"name": "sso-rw", "value": sso, "domain": ".grok.com", "path": "/"},
                ])
                page = ctx.new_page()

                # 拦截目标写端点：抓到 statsig 立即 abort，避免真生成视频耗配额
                def route_new(route):
                    try:
                        sid = route.request.headers.get("x-statsig-id")
                        if sid:
                            captured.append((route.request.url, sid))
                    except Exception:
                        pass
                    try:
                        route.abort()
                    except Exception:
                        pass

                page.route("**/rest/app-chat/conversations/new", route_new)

                try:
                    page.goto("https://grok.com/imagine", wait_until="domcontentloaded",
                              timeout=min(60, timeout_s) * 1000)
                except Exception:
                    pass

                deadline = t0 + timeout_s
                # 1) 轮询：关促销弹窗；等输入条(提交按钮)与输入框就绪
                submit_geo = None
                input_geo = None
                while time.time() < deadline and not (submit_geo and input_geo):
                    state = page.evaluate("""() => {
                        const btns=[...document.querySelectorAll('button')];
                        const gs=btns.find(b=>(b.textContent||'').includes('Get Started'));
                        if(gs){gs.click(); return {act:'modal'};}
                        const g=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};};
                        const submit=document.querySelector("button[aria-label='提交']")||document.querySelector("button[aria-label='Submit']")||document.querySelector("button[type='submit']");
                        const field=document.querySelector("[contenteditable='true']")||document.querySelector("input:not([type='file'])")||document.querySelector("textarea");
                        return {act:'poll', submit:g(submit), field:g(field)};
                    }""")
                    if state.get("act") == "modal":
                        page.wait_for_timeout(1200)
                        continue
                    if state.get("submit") and state.get("field"):
                        submit_geo = state["submit"]
                        input_geo = state["field"]
                        break
                    page.wait_for_timeout(1500)

                if submit_geo and input_geo:
                    # 2) 切到「视频」模式（/conversations/new 由视频生成触发）
                    page.evaluate("""() => {
                        const btns=[...document.querySelectorAll('button')];
                        const v=btns.find(b=>['视频','Video'].includes((b.textContent||'').trim()));
                        if(v) v.click();
                    }""")
                    page.wait_for_timeout(1200)
                    # 3) 聚焦输入框并打字
                    page.evaluate("""() => {
                        const f=document.querySelector("[contenteditable='true']")||document.querySelector("input:not([type='file'])")||document.querySelector('textarea');
                        f?.focus();
                    }""")
                    page.mouse.click(input_geo["x"], input_geo["y"])
                    page.wait_for_timeout(300)
                    page.keyboard.type("a cat walking on the beach", delay=20)
                    page.wait_for_timeout(1000)
                    # 4) 点提交（坐标 + JS 兜底 + 回车）
                    page.mouse.click(submit_geo["x"], submit_geo["y"])
                    page.wait_for_timeout(400)
                    page.evaluate("""() => {
                        (document.querySelector("button[aria-label='提交']")||document.querySelector("button[aria-label='Submit']"))?.click();
                    }""")
                    try:
                        page.keyboard.press("Enter")
                    except Exception:
                        pass
                    # 5) 等待拦截到 /new
                    while time.time() < deadline and not captured:
                        page.wait_for_timeout(1000)
            finally:
                if browser is not None:
                    try:
                        browser.close()
                    except Exception:
                        pass
    except Exception as e:
        return {"ok": False, "error": f"harvest 异常: {e}", "captured": len(captured)}
    finally:
        _harvest_lock.release()

    if not captured:
        return {"ok": False,
                "error": "未抓到 /conversations/new 的 x-statsig-id（可能 SSO 失效、页面未登录或 UI 变化）",
                "captured": 0}

    # 优先真实指纹形式；其次退回任意（含错误串）。取最后一个（重试往往更稳定）
    real = [(u, s) for (u, s) in captured if not _is_error_form_statsig(s)]
    chosen_url, chosen = (real[-1] if real else captured[-1])
    return {
        "ok": True,
        "x_statsig_id": chosen,
        "form": "real" if not _is_error_form_statsig(chosen) else "error",
        "source": chosen_url,
        "captured": len(captured),
        "real_count": len(real),
        "elapsed_ms": int((time.time() - t0) * 1000),
    }


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


@relay_bp.route("/relay/statsig", methods=["POST"])
def relay_statsig():
    """
    用无头浏览器抓取一个真实、可用的 x-statsig-id。
    请求体: { "sso": "<grok sso token>", "timeout": 60(可选) }
    statsig 账号无关：可用专门的抓取小号 sso，抓到的 id 全池通用。
    返回: { "ok": true, "x_statsig_id": "...", "form": "real|error", ... }
    """
    if not _check_secret():
        return jsonify({"ok": False, "error": "invalid secret"}), 403

    try:
        data = request.get_json(force=True) or {}
    except Exception as e:
        return jsonify({"ok": False, "error": f"invalid JSON body: {e}"}), 400

    sso = (data.get("sso") or "").strip()
    if sso.startswith("sso="):
        sso = sso[4:]
    if not sso:
        return jsonify({"ok": False, "error": "missing sso"}), 400

    try:
        timeout_s = int(data.get("timeout", 90))
    except Exception:
        timeout_s = 90
    timeout_s = max(60, min(timeout_s, 150))

    # 选一个住宅代理（VPS 裸 IP 会被 grok 墙）；取优先级最高的已启用代理
    _, proxy_list = _load_proxy_config()
    proxy_url = proxy_list[0]["proxy"].strip() if proxy_list else None

    debug_print(f"relay_server: /relay/statsig 开始抓取 (proxy={'有' if proxy_url else '无(直连)'}, timeout={timeout_s}s)")
    result = _harvest_statsig(sso, proxy_url=proxy_url, timeout_s=timeout_s)

    if result.get("ok"):
        debug_print(f"relay_server: statsig 抓取成功 form={result['form']} "
                    f"real={result.get('real_count')}/{result.get('captured')} "
                    f"elapsed={result.get('elapsed_ms')}ms")
        return jsonify(result)
    else:
        debug_print(f"Error:relay_server: statsig 抓取失败: {result.get('error')}")
        return jsonify(result), 502


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
