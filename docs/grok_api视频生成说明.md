# Grok2API 视频生成接口说明

## 概述

通过 Grok2API 的 OpenAI 兼容接口生成视频。支持 1~7 张参考图片 + 提示词，生成 5~15 秒的短视频。

本文档基于 **X-Raw-Token 模式**：客户端直接提供 grok.com SSO Token，生成的视频通过 `assets.grok.com` 直接下载。

## 前置要求

| 项目 | 说明 |
|------|------|
| API 地址 | Cloudflare Worker 部署地址，如 `https://grok2api.xxx.workers.dev` |
| API Key | 在管理后台创建的 API Key |
| SSO Token | grok.com 登录后的 JWT（浏览器 Cookie 中的 `sso` 字段） |

### 获取 SSO Token

1. 浏览器登录 https://grok.com
2. 打开开发者工具（F12）→ Application → Cookies
3. 找到 `sso` 字段，复制其值（一段 JWT 字符串）

## 视频模型

| 模型 ID | 说明 |
|---------|------|
| `grok-imagine-0.9` | 经典视频模型，支持 5/8 秒 |
| `grok-imagine-1.0-video` | 新版模型，支持 1-15 秒，画质更高 |

## API 接口

### 请求

```
POST /v1/chat/completions
```

#### Headers

```
Authorization: Bearer <API_KEY>
Content-Type: application/json
X-Raw-Token: <SSO_TOKEN>
```

`X-Raw-Token` 是 X-Raw-Token 模式的关键：传入此 Header 后，Worker 不从数据库选 token，直接用你提供的 SSO Token 请求 grok.com。

#### Body

```json
{
  "model": "grok-imagine-0.9",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "image_url",
          "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ..." }
        },
        {
          "type": "text",
          "text": "让画面中的人物动起来"
        }
      ]
    }
  ],
  "stream": false,
  "video_config": {
    "aspect_ratio": "16:9",
    "video_length": 5,
    "resolution": "720p"
  }
}
```

#### 图片格式

图片通过 `data URL` 内嵌（base64 编码）：

```
data:image/jpeg;base64,/9j/4AAQSkZJRg...
data:image/png;base64,iVBORw0KGgo...
```

支持 JPEG 和 PNG，单张建议不超过 5 MB。

#### video_config 参数

| 参数 | 类型 | 可选值 | 默认 | 说明 |
|------|------|--------|------|------|
| `aspect_ratio` | string | `16:9` `9:16` `1:1` `4:3` `3:4` `3:2` `2:3` | `16:9` | 视频宽高比 |
| `video_length` | int | `5` `8` `10` `12` `15` | `5` | 视频时长（秒），0.9 模型仅 5/8 秒 |
| `resolution` | string | `480p` `720p` | `720p` | 分辨率 |

#### 多图 + @图N 引用

支持最多 7 张图片，提示词中可用 `@图N` 引用特定图片：

```json
{
  "content": [
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
    { "type": "text", "text": "@图1 @图2 @图3 串成一个连贯的电影片段" }
  ]
}
```

图片按 content 数组中出现的顺序编号：第 1 张 = `@图1`，第 2 张 = `@图2`，以此类推。

### 响应

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "model": "grok-imagine-0.9",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<video src=\"https://assets.grok.com/users/.../generated_video.mp4\" controls=\"controls\" width=\"500\" height=\"300\"></video>\n"
      },
      "finish_reason": "stop"
    }
  ]
}
```

**X-Raw-Token 模式下**，`content` 中的视频链接为 `assets.grok.com` 原始地址，需要携带 SSO Cookie 下载。

非 X-Raw-Token 模式下，链接会被改写为 Worker 代理地址（`/images/p_xxx`），可直接下载。

## 视频下载

### X-Raw-Token 模式

从响应 HTML 中提取 `<video src="...">` 或 `<a href="...">` 中的 URL，下载时在请求头附加 Cookie：

```
GET https://assets.grok.com/users/.../generated_video.mp4
Cookie: sso=<SSO_TOKEN>;sso-rw=<SSO_TOKEN>
```

### Python 示例

```python
import urllib.request

def download_video(url, sso_token, save_path, timeout=120):
    headers = {"User-Agent": "MyApp/1.0"}
    if "assets.grok.com" in url:
        headers["Cookie"] = f"sso={sso_token};sso-rw={sso_token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        with open(save_path, "wb") as f:
            f.write(resp.read())
```

### cURL 示例

```bash
curl -o video.mp4 \
  -H "Cookie: sso=eyJ0eXAi...;sso-rw=eyJ0eXAi..." \
  "https://assets.grok.com/users/.../generated_video.mp4"
```

## 完整调用流程

```
1. 准备图片 → base64 编码为 data URL
2. 构建请求 → POST /v1/chat/completions（带 X-Raw-Token）
3. 等待生成 → 约 1-3 分钟
4. 解析响应 → 提取 <video src="..."> 中的 URL
5. 下载视频 → GET URL + Cookie: sso=<token>
```

## 示例脚本

参见 `grok_video_example.py`，提供了封装好的 `generate_video()` 和 `download_video()` 函数：

```python
from grok_video_example import generate_video, download_video

SSO_TOKEN = "eyJ0eXAi..."

# 生成
result = generate_video(
    raw_token=SSO_TOKEN,
    image_paths=["photo.jpg"],
    prompt="让画面中的人物动起来",
    video_length=5,
)

# 下载
if result["video_url"]:
    download_video(result["video_url"], SSO_TOKEN, "output.mp4")
```

## 错误处理

| HTTP 状态码 | 含义 | 处理建议 |
|-------------|------|----------|
| 401 | Token 无效或 API Key 错误 | 检查 SSO Token 和 API Key |
| 429 | 请求频率超限或账号额度耗尽 | 等待冷却或更换账号 |
| 500 + `上传失败: 429 storage-exhausted` | grok.com 存储空间满 | 登录 grok.com 清理历史文件 |
| 500 + `上传失败: 403` | 反机器人拦截 | 确认 relay 已配置且正常工作 |
| 503 | 无可用 Token | 检查 Token 是否有效 |

## 注意事项

1. **SSO Token 有效期**：grok.com 的 SSO Token 会过期，过期后需重新从浏览器获取
2. **生成额度**：视频生成消耗 grok.com 账号的 SuperGrok 额度，需订阅 SuperGrok
3. **存储限制**：grok.com 对每个账号有文件存储上限，满了需清理后才能继续生成
4. **网络要求**：下载 `assets.grok.com` 需要能直接访问该域名（可能需要代理）
