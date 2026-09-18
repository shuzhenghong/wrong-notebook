-- 错题列表固定按 userId + createdAt desc 分页查询（src/app/api/error-items/list/route.ts），
-- 单列 userId 索引升级为组合索引；组合索引同时覆盖仅按 userId 过滤的查询。
-- 历史库中该单列索引可能存在也可能缺失，故用 IF EXISTS / IF NOT EXISTS 保证幂等。
DROP INDEX IF EXISTS "ErrorItem_userId_idx";
CREATE INDEX IF NOT EXISTS "ErrorItem_userId_createdAt_idx" ON "ErrorItem"("userId", "createdAt");
