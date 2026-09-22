import type { NextConfig } from "next";

// Python FastAPI 后端地址 — 渐进迁移阶段用
const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  output: 'standalone',
  // 只保留真正需要保留外部形态的包；本地 OCR 的原生依赖已随 OCR 迁到 Python 后端移除
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],

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
