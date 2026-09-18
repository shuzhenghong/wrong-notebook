/**
 * 统一的服务器端鉴权辅助
 *
 * 十余个 API 路由都在复制粘贴 "getServerSession → prisma.user.findUnique → 返回 unauthorized"，
 * 这里收敛成一个入口，从根上消灭 IDOR 遗漏（例如 notes 路由漏校验 userId 归属）。
 */
import { getServerSession } from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions } from "./auth";
import { prisma } from "./prisma";
import { unauthorized, forbidden } from "./api-errors";

export interface AuthUser {
    id: string;
    email: string;
    name: string | null;
    role: string;
    isActive: boolean;
    mustChangePassword: boolean;
    educationStage: string | null;
    enrollmentYear: number | null;
}

export type AuthResult =
    | { ok: true; user: AuthUser }
    | { ok: false; response: ReturnType<typeof unauthorized> };

/**
 * 拿到当前登录用户（含 DB 记录，保证 session 中的邮箱确实存在且未被禁用）。
 * 未登录 / 账号被禁用 / session 里的邮箱在 DB 里消失，都返回 response 让 route 直接 return。
 */
export async function getCurrentUser(req?: NextRequest): Promise<AuthResult> {
    const session = req
        ? await getServerSession(authOptions)
        : await getServerSession(authOptions);

    if (!session?.user?.email) {
        return { ok: false, response: unauthorized("Authentication required") };
    }

    // 一次查询把常用字段都取回来，避免各路由再各自查一遍 user 表
    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            mustChangePassword: true,
            educationStage: true,
            enrollmentYear: true,
        },
    });

    if (!user) {
        return { ok: false, response: unauthorized("Authentication required") };
    }

    if (!user.isActive) {
        return { ok: false, response: forbidden("Account is disabled") };
    }

    return { ok: true, user };
}

/** 401 shortcut — 未登录。 */
export function requireUnauthenticated() {
    return unauthorized("Authentication required");
}

/** 403 shortcut — 需要管理员。 */
export function requireAdminResponse() {
    return forbidden("Admin role required");
}

export type AdminAuthResult =
    | { ok: true; user: AuthUser }
    | { ok: false; response: ReturnType<typeof unauthorized | typeof forbidden> };

/**
 * 需要管理员身份的路由统一入口：登录 + 账号启用 + role === 'admin' 一次校验完。
 * 与 middleware 的 /api/admin 门禁互为纵深防御。
 */
export async function getAdminUser(): Promise<AdminAuthResult> {
    const result = await getCurrentUser();
    if (!result.ok) return result;
    if (result.user.role !== 'admin') {
        return { ok: false, response: forbidden("Admin role required") };
    }
    return result;
}
