/**
 * 渐进迁移专用 —— Next.js → FastAPI 的 catch-all 转发层.
 *
 * 关键设计:
 *   1. 用 Node.js 原生 http/https, **不经过 Next.js undici 全局代理**
 *      (global-agent/undici 的 setGlobalDispatcher 不尊重 NO_PROXY,
 *      导致 fetch("http://localhost:8000") 被送到 HTTP_PROXY 服务器)
 *
 *   2. Next.js 路由匹配优先级:
 *      有本地 route.ts → 本地处理 (不进 catch-all)
 *      没有 route.ts  → 落回本文件 → 转发到 FastAPI
 *
 *   3. NextAuth 桥接: catch-all 解析 session cookie → X-Forwarded-User
 *      FastAPI 侧 lazy mirror 用户自动创建
 *
 *   迁移动作 = 物理删除 src/app/api/<target>/route.ts
 *   回滚    = git checkout src/app/api/<target>/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export const runtime = "nodejs";

const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || "http://localhost:8000";
const PROXY_ENABLED = process.env.PYTHON_PROXY_ENABLED === "true";

const NO_PROXY_PREFIXES = [
  "/api/auth/",      // NextAuth 自己的登录/会话
  "/api/python/",     // rewrites 已经截走
];

interface ProxyUser {
  id: string;
  email?: string;
  role: string;
}

/** 转发的响应体必须保留**原始字节**。
 *
 * 之前这里做的是 Buffer -> utf-8 String -> Response，对 JSON 没问题，
 * 但图片二进制经过 UTF-8 解码会产生 U+FFFD 替换字符，图片直接损坏。
 * 因此统一以 Buffer 传递，`new Response(Uint8Array)` 支持二进制负载。
 */
interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** 逐出不应透传的 hop-by-hop / 长度类 header，由运行时按实际 body 重新计算。 */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
]);

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

/** 绕开 undici 全局代理的转发 (用 Node.js http.request). */
function forwardViaNodeHttp(
  method: string,
  backendUrl: string,
  headers: Record<string, string>,
  body: Buffer | null,
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(backendUrl);
    const lib = url.protocol === "https:" ? https : http;

    const reqHeaders: Record<string, string> = {
      ...headers,
      host: url.host,
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
        timeout: 120_000,
      },
      (res) => {
        // 收集响应体
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          // 归一化 headers 为 Record<string, string> (只取最后一个值)
          const normalized: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (k.toLowerCase() === "set-cookie") continue; // 不转发 cookie
            if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue; // 长度类交给运行时重算
            if (Array.isArray(v)) {
              normalized[k] = v.join(", ");
            } else if (v) {
              normalized[k] = String(v);
            }
          }
          resolve({
            status: res.statusCode || 500,
            headers: normalized,
            // 保留原始字节：图片等二进制响应不能被 UTF-8 解码
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Upstream timeout"));
    });

    if (body) req.write(body);
    req.end();
  });
}

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

  const joined = "/" + pathSegments.join("/");
  if (NO_PROXY_PREFIXES.some((p) => joined.startsWith(p))) {
    return NextResponse.json({ error: "Path not proxied (handled locally)" }, { status: 404 });
  }

  const user = await resolveUser(req);

  const backendUrl = `${PYTHON_BACKEND_URL}/api/${pathSegments.join("/")}${req.nextUrl.search}`;

  // 构造转发 headers (过滤 Next.js 内部 headers)
  // 安全关键: x-forwarded-user 必须在这里剥离 —— 它是前端→后端的身份桥接头，
  // 绝不能透传客户端自带的值，否则任何人都能伪造 base64 JSON 冒充任意用户(含 admin)。
  const forwardHeaders: Record<string, string> = {};
  const skipHeaders = new Set([
    "host", "connection", "content-length", "x-forwarded-for",
    "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto",
    "x-forwarded-user",
  ]);
  req.headers.forEach((value, key) => {
    if (skipHeaders.has(key.toLowerCase())) return;
    forwardHeaders[key] = value;
  });

  // NextAuth 用户 → X-Forwarded-User（服务端解析 session 后强制注入，
  // 客户端携带的同名头已在上面剥离，无法伪造身份）
  if (user) {
    forwardHeaders["x-forwarded-user"] = Buffer.from(JSON.stringify(user)).toString("base64");
  } else {
    forwardHeaders["x-forwarded-user"] = "anonymous";
  }

  // 读 body (GET/HEAD 无 body)。
  // 用 arrayBuffer 按原始字节透传 —— text() 会做 UTF-8 解码，
  // 一旦未来出现 multipart/二进制上传会被 U+FFFD 替换字符静默损坏。
  let body: Buffer | null = null;
  if (method !== "GET" && method !== "HEAD") {
    const raw = await req.arrayBuffer();
    body = raw.byteLength > 0 ? Buffer.from(raw) : null;
    if (body && !forwardHeaders["content-length"]) {
      forwardHeaders["content-length"] = String(body.length);
    }
  }

  try {
    const resp = await forwardViaNodeHttp(method, backendUrl, forwardHeaders, body);
    // Buffer<ArrayBufferLike> 不被 BodyInit 接受，这里显式拷成 Uint8Array<ArrayBuffer>。
    // 拷贝同时也切断了与上游 chunk 缓冲区的共享，响应构造更安全。
    const bytes = new Uint8Array(resp.body.byteLength);
    bytes.set(resp.body);
    return new Response(bytes, {
      status: resp.status,
      headers: resp.headers,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Proxy error", detail: msg, backendUrl },
      { status: 502 },
    );
  }
}

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
