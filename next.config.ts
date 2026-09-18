import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@prisma/client', 'bcryptjs', '@gutenye/ocr-node', 'onnxruntime-node', 'sharp'],
  // 本地 OCR 的 PP-OCRv4 模型文件由运行时 fs 读取，文件追踪抓不到，需显式包含
  outputFileTracingIncludes: {
    '/api/ocr': ['./node_modules/@gutenye/ocr-models/assets/**/*'],
  },
};

export default nextConfig;
