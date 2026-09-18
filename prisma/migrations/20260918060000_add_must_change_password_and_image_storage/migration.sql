-- 用户：首次登录强制改密标记（种子/管理员创建的账号会被置为 true）
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- 错题：图片落盘后的存储键与 MIME 类型
-- 历史数据仍以内联 base64 存在 originalImageUrl 中，保持只读兼容
ALTER TABLE "ErrorItem" ADD COLUMN "imageStorageKey" TEXT;
ALTER TABLE "ErrorItem" ADD COLUMN "imageMimeType" TEXT;
