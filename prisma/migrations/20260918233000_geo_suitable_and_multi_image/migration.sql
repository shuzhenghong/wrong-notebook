-- 新增：GeoGebra 适配性标志 + 多图（参考图 / 学生作答图）字段
-- 这些 ADD COLUMN 在 prisma migrate deploy 下只会执行一次；
-- 开发环境使用 `prisma db push` 时由 schema 自动同步，无需此文件。

ALTER TABLE "ErrorItem" ADD COLUMN "geogebraSuitable" BOOLEAN;
ALTER TABLE "ErrorItem" ADD COLUMN "referenceImageUrl" TEXT;
ALTER TABLE "ErrorItem" ADD COLUMN "wrongAnswerImageUrl" TEXT;
