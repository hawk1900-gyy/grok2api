# Grok2API 调用说明

本文档说明如何通过 Grok2API 的 OpenAI 兼容接口进行**图片生成**、**单图视频生成**和**多图 @引用视频生成**。

---

## 一、前置条件

1. **Grok2API 服务**：本地运行 `wrangler dev` 或已部署到 Cloudflare Workers
2. **API Key**：在管理后台 Keys 中创建
3. **Grok Token**：在管理后台 Tokens 中添加有效的 SSO Token（获取方式见 `grok_cookies更新说明.md`）
4. **输入图片**（视频生成时需要）：放在 `video/` 目录下，支持 jpg/png

---

## 二、服务器环境

Grok2API 支持**本地开发**和**远程部署**两种环境：

| 环境 | 地址 | 说明 |
|------|------|------|
| 本地 | `http://127.0.0.1:8787` | `wrangler dev` 启动的本地开发服务 |
| 远程 | `https://grok2api.xxx.workers.dev` | Cloudflare Workers 线上服务 |

`grok_example.py` 启动时会让你选择环境，也可以用命令行参数跳过：

```bash
python grok_example.py            # 交互式选择（默认本地）
python grok_example.py --local    # 直接用本地
python grok_example.py --remote   # 直接用远程
```

---

## 三、API 端点

所有功能使用 **OpenAI 兼容** 的聊天补全接口：

```
POST {BASE_URL}/v1/chat/completions
```

请求头：

```
Authorization: Bearer {API_KEY}
Content-Type: application/json
X-Token-Suffix: XXXX          # 可选，指定使用后缀匹配的 Grok Token（调试用）
```

---

## 四、可用模型

| 模型 ID | 类型 | 说明 |
|---------|------|------|
| `grok-imagine-1.0` | 图片生成 | 文本描述 → 图片（每次 2 张） |
| `grok-imagine-0.9` | 视频生成 | 图片 + 提示词 → 视频（5/8 秒） |
| `grok-imagine-1.0-video` | 视频生成 | 图片 + 提示词 → 视频（1-15 秒，支持多图 @引用） |
| `grok-3` 等 | 对话 | 普通文本对话 |

---

## 五、请求体结构

### 5.1 基本字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | ✅ | 模型 ID |
| messages | array | ✅ | 消息列表，包含文本和图片 |
| stream | boolean | ❌ | 视频生成建议 `false` |
| video_config | object | ❌ | 视频参数，见 5.4 |

### 5.2 messages 格式 — 单图视频

传入 **1 张图片** + 文本提示词：

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/..."}},
        {"type": "text", "text": "女孩开心地跳起来"}
      ]
    }
  ]
}
```

### 5.3 messages 格式 — 多图 + @引用视频（重点）

传入 **2~7 张图片** + 带 `@图N` 引用的文本：

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,图片1的base64..."}},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,图片2的base64..."}},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,图片3的base64..."}},
        {"type": "text", "text": "@图1 她挂掉电话露出自信的微笑，然后 @图2 她看到手机上的秘密消息表情变得严肃，最后 @图3 她走进大厅与老人对峙"}
      ]
    }
  ]
}
```

#### @图N 引用规则

`@图N` 是 Grok Imagine 视频模式专用的多图引用语法，用于告诉 Grok 视频中各片段使用哪张图片作为参考：

| 规则 | 说明 |
|------|------|
| **按顺序编号** | content 数组中第 1 个 `image_url` = `@图1`，第 2 个 = `@图2`，以此类推 |
| **与文件名无关** | 编号纯粹取决于图片在请求中的排列顺序 |
| **最多 7 张** | 单次请求最多传入 7 张图片 |
| **仅视频模型有效** | `@图N` 引用仅在视频模型（`grok-imagine-0.9`、`grok-imagine-1.0-video`）下生效 |
| **不用也可以** | 多图时不写 `@图N` 也行，Grok 会自动参考所有图片 |

**对应关系示意**：

```
content 数组中的顺序          prompt 中的引用

image_url[0]  (photo_a.jpg)  →  @图1
image_url[1]  (photo_b.png)  →  @图2
image_url[2]  (photo_c.jpg)  →  @图3
```

**内部处理流程**：

```
用户 prompt:  "@图1 的人物跳舞，@图2 的场景作为背景"
                ↓
grok2api 上传图片，获得 fileId 列表: [id_a, id_b, id_c]
                ↓
替换后发给 Grok: "@id_a 的人物跳舞，@id_b 的场景作为背景"
```

### 5.4 video_config 参数

| 参数 | 类型 | 默认值 | 说明 | 可选值 |
|------|------|--------|------|--------|
| aspect_ratio | string | `"2:3"` | 宽高比 | 16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3 |
| video_length | number | `6` | 时长（秒） | 1-15（1.0-video）；5/8（0.9） |
| resolution | string | `"480p"` | 分辨率 | 480p, 720p |
| preset | string | `"normal"` | 风格 | normal, fun, spicy |

**preset 对应关系**：
- `normal` → 普通模式（`--mode=normal`）
- `fun` → 有趣/夸张（`--mode=extremely-crazy`）
- `spicy` → 刺激/强烈（`--mode=extremely-spicy-or-crazy`）

### 5.5 图片格式

`image_url.url` 支持两种格式：

| 格式 | 示例 | 说明 |
|------|------|------|
| base64 data URL | `data:image/jpeg;base64,/9j/...` | 本地图片需先转 base64 |
| 公网 URL | `https://example.com/photo.jpg` | 必须可公网访问 |

本地图片转 base64 的 Python 方法：

```python
import base64

def image_to_data_url(path):
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    ext = path.rsplit(".", 1)[-1].lower()
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else "image/png"
    return f"data:{mime};base64,{b64}"
```

---

## 六、响应格式

### 6.1 成功响应

返回 OpenAI 格式，`content` 中包含视频/图片 HTML：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "model": "grok-imagine-1.0-video",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<video src=\"https://grok2api.xxx/images/p_xxx\" controls=\"controls\" width=\"500\" height=\"300\"></video>\n"
      },
      "finish_reason": "stop"
    }
  ]
}
```

视频 URL 通过 Grok2API 的 `/images/` 代理访问，可绕过 Grok 直链 403 限制。

### 6.2 错误响应

```json
{
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "code": "错误码"
  }
}
```

---

## 七、完整请求示例

### 7.1 单图视频（curl）

```bash
curl -X POST "http://127.0.0.1:8787/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-imagine-1.0-video",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}},
          {"type": "text", "text": "女孩打完电话，开心地跳起来"}
        ]
      }
    ],
    "stream": false,
    "video_config": {
      "aspect_ratio": "9:16",
      "video_length": 10,
      "resolution": "480p"
    }
  }'
```

### 7.2 多图 @引用视频（curl）

```bash
curl -X POST "http://127.0.0.1:8787/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-imagine-1.0-video",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "image_url", "image_url": {"url": "data:image/png;base64,图片1..."}},
          {"type": "image_url", "image_url": {"url": "data:image/png;base64,图片2..."}},
          {"type": "image_url", "image_url": {"url": "data:image/png;base64,图片3..."}},
          {"type": "text", "text": "@图1 她挂掉电话 @图2 看到手机消息 @图3 走进大厅对峙，生成连贯的电影片段"}
        ]
      }
    ],
    "stream": false,
    "video_config": {
      "aspect_ratio": "9:16",
      "video_length": 10,
      "resolution": "480p"
    }
  }'
```

### 7.3 多图 @引用视频（Python）

```python
from grok_example import chat_completion, _image_to_data_url

img1 = _image_to_data_url("video/scene_phone.png")
img2 = _image_to_data_url("video/scene_message.png")
img3 = _image_to_data_url("video/scene_hall.png")

messages = [
    {
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": img1}},   # @图1
            {"type": "image_url", "image_url": {"url": img2}},   # @图2
            {"type": "image_url", "image_url": {"url": img3}},   # @图3
            {"type": "text", "text": "@图1 她挂掉电话 @图2 看到手机消息 @图3 走进大厅对峙"},
        ],
    }
]
video_config = {"aspect_ratio": "9:16", "video_length": 10, "resolution": "480p"}

out, content = chat_completion(
    messages, "grok-imagine-1.0-video", timeout=300, video_config=video_config
)
print(content)  # <video src="..."> 标签
```

### 7.4 单图视频（Python）

```python
from grok_example import chat_completion, _image_to_data_url

data_url = _image_to_data_url("video/test001.jpg")
messages = [
    {
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": data_url}},
            {"type": "text", "text": "让画面中的人物动起来"},
        ],
    }
]

out, content = chat_completion(
    messages, "grok-imagine-1.0-video", timeout=300,
    video_config={"aspect_ratio": "9:16", "video_length": 5, "resolution": "720p"}
)
print(content)
```

---

## 八、grok_example.py 使用指南

### 8.1 启动方式

```bash
python grok_example.py            # 交互式（选服务器 → 选模型 → 输入参数）
python grok_example.py --local    # 直接用本地环境
python grok_example.py --remote   # 直接用远程环境
python grok_example.py <URL>      # 下载媒体文件
python grok_example.py <URL> out.mp4  # 下载到指定路径
```

### 8.2 视频生成交互流程

```
启动
  ├─ _select_server()          # 选择：本地 / 远程
  ├─ list_models()             # 获取模型列表
  ├─ select_model()            # 选择模型（视频模型标 [视频]）
  └─ test_video_generate()
        ├─ _collect_images()        # 逐张输入图片（文件名或路径，最多 7 张）
        ├─ 显示图片编号对照表        # 图1=xxx.jpg, 图2=xxx.png ...
        ├─ 输入 prompt               # 多图时提示 @图N 写法
        ├─ _input_video_config()    # 输入宽高比、时长、分辨率、风格
        ├─ _build_video_messages()  # 图片 → base64, 组装 messages
        ├─ chat_completion()        # 发起 API 请求
        └─ _offer_download()        # 询问是否下载到 video/ 目录
```

### 8.3 多图输入示例

运行后提示逐张输入图片文件名（`video/` 目录下可省略路径），空行结束：

```
[图片选择] 最多 7 张，输入路径或文件名（video/ 目录下可只写文件名）
  图1 (回车=test001.jpg): test005_1.png
  图2: test005_2.png
  图3: test005_3.png
  图4:                              ← 空行结束

已选择 3 张图片:
  图1 = test005_1.png
  图2 = test005_2.png
  图3 = test005_3.png

[提示] 多图模式支持 @图N 引用，例如:
  「@图1 @图2 @图3 组成一个连贯的故事动画」
请输入提示词 (回车默认):
```

---

## 九、视频下载

生成的视频 URL 通过 Grok2API 的 `/images/` 代理访问：

### 方式 1：脚本内自动下载

视频生成完成后会自动询问是否下载到 `video/` 目录。

### 方式 2：命令行下载

```bash
python grok_example.py "http://127.0.0.1:8787/images/p_xxx..."
python grok_example.py "https://grok2api.xxx.workers.dev/images/p_xxx..." "video/my_video.mp4"
```

### 方式 3：代码调用

```python
from grok_example import download_media

download_media(video_url, "video/generated.mp4")
```

---

## 十、单图 vs 多图 — 内部处理差异

理解这部分有助于排查问题。Grok2API 内部对单图和多图的处理方式不同：

| | 单图 | 多图（2~7 张） |
|---|---|---|
| **图片上传** | 上传 1 张 → 获得 fileId | 并行上传多张 → 获得 fileId 列表 |
| **message 构造** | `https://assets.grok.com/{uri}  提示词 --mode=xxx` | `@{fileId1} ... @{fileId2} ... --mode=xxx` |
| **fileAttachments** | `[fileId]` | 不传 |
| **isReferenceToVideo** | 不设置 | `true` |
| **imageReferences** | 不设置 | `[assetUrl1, assetUrl2, ...]` |
| **parentPostId** | 通过 createPost(图片) 获取 | 通过 createMediaPost(视频容器) 获取 |

---

## 十一、注意事项

1. **超时**：视频生成约 1-3 分钟，请求 `timeout` 建议设为 300 秒
2. **模型差异**：`grok-imagine-1.0-video` 支持 1-15 秒；`grok-imagine-0.9` 可能仅 5/8 秒
3. **图片数量**：所有模型最多 7 张图片，超出的会被截断
4. **@引用限制**：`@图N` 引用仅在视频模型的 Imagine 模式下生效，普通对话模型中无效
5. **base_url**：管理后台需正确设置 `base_url`，否则返回的视频 URL 可能无法访问
6. **额度**：视频生成消耗 Grok Token 额度，可在管理后台查看剩余次数
7. **图片大小**：base64 编码后体积约增大 33%，注意请求体大小限制
8. **指定 Token**：请求头加 `X-Token-Suffix: <后缀>` 可强制使用后缀匹配的 Token（多 Token 环境下排查问题时有用）
