# ADR-001: 修复视频时长设置无效问题

- **日期**: 2026-02-25
- **状态**: 已实施
- **关联 commits**: be349f1, 4e99e75, 0b90324, 1d5aa54

## 问题

用户设置视频时长（如 10 秒、15 秒），生成的视频始终为 6 秒。
6 秒是 Grok 免费档的默认时长，说明时长参数未被 API 正确识别。

## 排查过程

1. **初始假设**：参数名错误。代码使用 `videoLength`，官方 xAI API 使用 `duration`。
   将 `responseMetadata` 中的 `videoLength` 改为 `duration`，`videoResolution` 改为 `resolution` → **无效**

2. **第二次假设**：需要在 `createMediaPost` 时传视频配置。
   在 `/rest/media/post/create` 请求体中加入 `duration`/`aspectRatio`/`resolution` → **无效**

3. **根因发现**：查阅上游 TQZHR/grok2api 源码，发现 `responseMetadata` 的结构**完全不同**。

## 根因

Grok.com 内部 API 的视频参数不在 `responseMetadata` 顶层，而是嵌套在：
```
responseMetadata.modelConfigOverride.modelMap.videoGenModelConfig
```

### 原始代码（错误）：
```json
{
  "responseMetadata": {
    "requestModelDetails": { "modelId": "grok-3" },
    "videoLength": 10,
    "aspectRatio": "16:9",
    "videoResolution": "720p"
  }
}
```

### 修复后（正确）：
```json
{
  "responseMetadata": {
    "experiments": [],
    "modelConfigOverride": {
      "modelMap": {
        "videoGenModelConfig": {
          "parentPostId": "xxx",
          "aspectRatio": "16:9",
          "videoLength": 10,
          "videoResolution": "HD"
        }
      }
    }
  }
}
```

## 其他修正

| 项目 | 修复前 | 修复后 |
|------|--------|--------|
| 分辨率值 | "480p" / "720p" | "SD" / "HD" |
| postId 位置 | 拼在 message URL 中 | `parentPostId` 字段 |
| referer | `https://grok.com/imagine/${postId}` | 固定 `https://grok.com/imagine` |
| message | 包含 post URL | 仅包含提示词 + mode flag |

## 教训

- Grok.com 内部 API 与官方 xAI API (api.x.ai) 参数格式完全不同，不能互相参考
- 上游 TQZHR/grok2api 是内部 API payload 格式的权威来源
- 遇到 API 参数问题时，优先对照上游代码，而非猜测或搜索官方文档
