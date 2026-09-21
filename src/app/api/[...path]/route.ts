/**
 * 渐进迁移专用 —— Next.js → FastAPI 的 catch-all 转发层.
 *
 * 匹配规则:
 *   Next.js 路由从"最具体"到"最泛化"匹配. 只要本地存在 route.ts,
 *   就优先走本地实现, 这个 catch-all 不会被触发.
 *   —— 所以本文件对现有 Next.js API 完全透明, 零侵入.
 *
 * 迁移动作 (物理级, 可随时回滚):
 *   想把某个 API 交给 FastAPI → 物理删除或重命名对应的 route.ts
 *   回滚 → 把 route.ts 改回来即可
 *
 * 环境变量:
 *   PYTHON_PROXY_ENABLED = true   启用转发 (默认 false, 未启用时返回 404)
 *   PYTHON_BACKEND_URL   目标后端 (默认 http://localhost:8000)
 */

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

export const runtime = "nodejs";

const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || "http://localhost:8000";
const PROXY_ENABLED = process.env.PYTHON_PROXY_ENABLED === "true";

/** NextAuth session 解析失败 / 用户信息. */
interface ProxyUser {
  id: string;
  email?: string;
  role: string;
}

/** 从 NextAuth cookie 拿到用户, 拿不到返回 null (公开请求). */
async function resolveUser(req: NextRequest): Promise<ProxyUser | null> {
  try {
    const token = await getToken({
      req,
      secret: process.env.NEXTAUTH_SECRET,
      cookieName: "next-auth.session-token",
    });
    if (!token || !token.sub) return null;
    return {
      id: token.sub as string,
      email: (token.email as string | undefined),
      role: (token.role as string) || "user",
    };
  } catch {
    return null;
  }
}

/** 白名单: 不转发给 FastAPI 的路径 (必须保留 Next.js 本地行为). */
const NO_PROXY_PREFIXES = [
  "/api/auth/",      // NextAuth 自己的登录/会话
  "/api/python/",     // rewrites 已经截走, 不该再进这里
];

async function proxy(
  method: string,
  pathSegments: string[],
  req: NextRequest,
): Promise<Response> {
  if (!PROXY_ENABLED) {
    return NextResponse.json(
      { error: "Python proxy disabled. Set PYTHON_PROXY_ENABLED=true." },
      { status: 404 },
    );
  }

  // 路径安全检查
  const joined = "/" + pathSegments.join("/");
  if (NO_PROXY_PREFIXES.some((p) => joined.startsWith(p))) {
    return NextResponse.json({ error: "Path not proxied" }, { status: 404 });
  }

  const user = await resolveUser(req);

  // 构造转发请求
  const backendUrl = `${PYTHON_BACKEND_URL}/api/${pathSegments.join("/")}${req.nextUrl.search}`;

  // 过滤掉 Next.js 内部 headers, 只保留有意义的
  const forwardHeaders: Record<string, string> = {};
  const skipHeaders = new Set([
    "host",
    "connection",
    "content-length",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ]);
  req.headers.forEach((value, key) => {
    if (skipHeaders.has(key.toLowerCase())) return;
    forwardHeaders[key] = value;
  });

  // 把 NextAuth 用户信息以 base64 JSON 编码塞过去 — FastAPI 侧信任它
  if (user) {
    const encoded = Buffer.from(JSON.stringify(user)).toString("base64");
    forwardHeaders["x-forwarded-user"] = encoded;
  } else {
    // 公开请求也显式告诉后端: 没有用户
    forwardHeaders["x-forwarded-user"] = "anonymous";
  }

  // 读 body (GET/HEAD 没有 body)
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await req.text();
    if (!body) body = undefined;
  }

  try {
    const backendResp = await fetch(backendUrl, {
      method,
      headers: forwardHeaders,
      body,
      signal: AbortSignal.timeout(120_000), // 2min 超时
    });

    // 透传响应
    const respHeaders = new Headers();
    backendResp.headers.forEach((value, key) => {
      // 不转发 set-cookie — Next.js 和 FastAPI 各自管理 cookie
      if (key.toLowerCase() === "set-cookie") return;
      respHeaders.set(key, value);
    });

    const text = await backendResp.text();
    return new Response(text, {
      status: backendResp.status,
      statusText: backendResp.statusText,
      headers: respHeaders,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Proxy error", detail: msg },
      { status: 502 },
    );
  }
}

// ------- HTTP method handlers -------
// 所有 handler 签名相同: 拿到 Next.js 解析好的 catch-all path segments
type Params = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { path } = await params;
  return proxy("GET", path, req);
}
export async function POST(req: NextRequest, { params }: Params) {
  const { path } = await params;
  return proxy("POST", path, req);
}
export async function PATCH(req: NextRequest, { params }: Params) {
  const { path } = await params;
  return proxy("PATCH", path, req);
}
export async function PUT(req: NextRequest, { params }: Params) {
  const { path } = await params;
  return proxy("PUT", path, req);
}
export async function DELETE(req: NextRequest, { params }: Params) {
  const { path } = await params;
  return proxy("DELETE", path, req);
}
