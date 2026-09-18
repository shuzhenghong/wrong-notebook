import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";

const logger = createLogger('middleware');

// 登录/注册 这类公开页面
const PUBLIC_PAGES = ["/login", "/register", "/latex-test"];
// 首次登录强制改密的落地页
const CHANGE_PASSWORD_PAGE = "/change-password";
// admin 页面 + admin API — middleware 保护
const ADMIN_PREFIXES = ["/admin", "/api/admin"];

export async function middleware(req: NextRequest) {
    // Debug logging for middleware
    logger.debug({ method: req.method, path: req.nextUrl.pathname }, 'Processing request');

    const pathname = req.nextUrl.pathname;
    const isAdminPath = ADMIN_PREFIXES.some((p) => pathname.startsWith(p));
    const isPublicPage = PUBLIC_PAGES.some((p) => pathname.startsWith(p));

    let token;
    try {
        token = await getToken({
            req,
            secret: process.env.NEXTAUTH_SECRET,
            cookieName: "next-auth.session-token",
        });
    } catch (e) {
        // 认证失败 → fail-closed，除了公开页面直接放行，其余一律视为未登录
        logger.warn({ path: pathname, error: (e as Error).message }, 'Token resolution failed, treating as unauthenticated (fail-closed)');
        if (isPublicPage) return NextResponse.next();
        if (pathname.startsWith("/api/") && !isAdminPath) {
            // 普通 API 路由由 route 自身用 getServerSession 再校验一次，不要在这里返回重定向
            return NextResponse.next();
        }
        let from = pathname;
        if (req.nextUrl.search) from += req.nextUrl.search;
        return NextResponse.redirect(
            new URL(`/login?callbackUrl=${encodeURIComponent(from)}`, req.url)
        );
    }

    const isAuth = !!token;

    logger.debug({
        path: pathname,
        isAuth,
        isAdminPath,
        isPublicPage,
    }, 'Auth status');

    if (isPublicPage) {
        if (isAuth) {
            // 待改密用户直接送去改密页，不要落到首页
            if (token?.mustChangePassword === true) {
                logger.debug('Redirecting user with pending password change');
                return NextResponse.redirect(new URL(CHANGE_PASSWORD_PAGE, req.url));
            }
            logger.debug('Redirecting authenticated user to /');
            return NextResponse.redirect(new URL("/", req.url));
        }
        return NextResponse.next();
    }

    // 首次登录强制改密：除改密页自身与 API 外，其余页面一律拦下
    if (isAuth && token?.mustChangePassword === true && !pathname.startsWith("/api/") && pathname !== CHANGE_PASSWORD_PAGE) {
        logger.debug('Password change required, redirecting');
        return NextResponse.redirect(new URL(CHANGE_PASSWORD_PAGE, req.url));
    }

    // admin API / admin page — 必须登录 + 必须 admin 角色
    if (isAdminPath) {
        if (!isAuth) {
            // API 路径返回 401 JSON；页面返回 307 重定向
            if (pathname.startsWith("/api/")) {
                return NextResponse.json(
                    { message: "Authentication required" },
                    { status: 401 }
                );
            }
            let from = pathname;
            if (req.nextUrl.search) from += req.nextUrl.search;
            return NextResponse.redirect(
                new URL(`/login?callbackUrl=${encodeURIComponent(from)}`, req.url)
            );
        }
        if (token?.role !== "admin") {
            logger.warn({ userId: token?.id, path: pathname }, 'Non-admin user attempting admin route');
            if (pathname.startsWith("/api/")) {
                return NextResponse.json(
                    { message: "Admin role required" },
                    { status: 403 }
                );
            }
            return NextResponse.redirect(new URL("/", req.url));
        }
        return NextResponse.next();
    }

    // 普通 API 路由：由各个 route 自己用 getServerSession 校验 — 不在这里强制 redirect
    if (pathname.startsWith("/api/")) {
        return; // undefined = 放行，route 自行校验
    }

    // 普通页面：未登录 → 重定向登录
    if (!isAuth) {
        let from = pathname;
        if (req.nextUrl.search) from += req.nextUrl.search;

        logger.debug({ callbackUrl: from }, 'Redirecting unauthenticated user to login');
        return NextResponse.redirect(
            new URL(`/login?callbackUrl=${encodeURIComponent(from)}`, req.url)
        );
    }

    return; // undefined = 放行
}

export const config = {
    matcher: [
        // 覆盖所有页面 + /api/admin/*（admin API 由 middleware 统一鉴权）
        // 其他 /api/** 继续由 route 自行用 getServerSession 校验，不再被 matcher 排除
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
    ],
};
