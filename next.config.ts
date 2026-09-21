import type { NextConfig } from "next";

// Python FastAPI 后端地址 — 渐进迁移阶段用
const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@prisma/client', 'bcryptjs', '@gutenye/ocr-node', 'onnxruntime-node', 'sharp'],
  // 本地 OCR 的 PP-OCRv4 模型文件由运行时 fs 读取，文件追踪抓不到，需显式包含
  outputFileTracingIncludes: {
    '/api/ocr': ['./node_modules/@gutenye/ocr-models/assets/**/*'],
  },

  // ====== 渐进迁移: 直连 Python 后端的测试通道 ======
  // 访问 /api/python/xxx 会完全绕过 Next.js 本地 route.ts，直接打到 FastAPI
  rewrites: async () => [
    {
      source: "/api/python/:path*",
      destination: `${PYTHON_BACKEND_URL}/api/:path*`,
    },
  ],
};

export default nextConfig;
