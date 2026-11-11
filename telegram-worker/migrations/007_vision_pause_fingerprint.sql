-- 图片识别鉴权失败暂停时记录触发它的模型配置指纹（docs/model-providers-design.md 第 13 节）。
-- 只有失败请求的指纹等于当前配置才暂停；管理员换了配置后，领取任务时自动解除暂停。
ALTER TABLE telegram_settings ADD COLUMN vision_pause_fingerprint TEXT;
