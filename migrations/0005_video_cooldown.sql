-- 为 tokens 表添加视频独立冷却字段
-- 视频 429 (Too many requests) 只冷却视频，不影响文本请求
ALTER TABLE tokens ADD COLUMN video_cooldown_until INTEGER;

CREATE INDEX IF NOT EXISTS idx_tokens_video_cooldown ON tokens(video_cooldown_until);
