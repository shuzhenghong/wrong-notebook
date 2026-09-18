
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { getAdminUser } from "@/lib/server-auth";
import { internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:admin:system-reset');

// 二次确认令牌：必须由客户端显式提交，防止误触/CSRF 一键清空
const CONFIRM_TOKEN = "DELETE ALL DATA";

/**
 * 把当前 SQLite 库整体备份到 data/backups 目录。
 * 使用 VACUUM INTO 而不是 copyFile，保证拿到的是一致性快照（含 WAL）。
 */
async function backupDatabase(): Promise<string | null> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !databaseUrl.startsWith('file:')) {
        logger.warn('DATABASE_URL is not a SQLite file url, skipping backup');
        return null;
    }

    const dbPath = databaseUrl.replace(/^file:/, '');
    const resolvedDbPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);

    // VACUUM INTO 无法参数化，路径会拼进 SQL 字符串。
    // 时间戳由服务端生成并已 sanitize，但若 DATABASE_URL 本身含引号则整条路径不可信 —— 直接中止备份（进而中止重置）。
    if (resolvedDbPath.includes("'")) {
        logger.error('DATABASE_URL path contains a single quote; refusing to build VACUUM INTO statement');
        throw new Error('DATABASE_URL path contains unsafe characters');
    }

    const backupDir = path.join(path.dirname(resolvedDbPath), 'backups');

    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(
        backupDir,
        `before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
    );

    // VACUUM INTO 不支持参数绑定；路径完全由服务端生成，不含用户输入
    await prisma.$executeRawUnsafe(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
    return backupFile;
}

export async function POST(req: Request) {
    const auth = await getAdminUser();

    // Strictly enforce Admin role
    if (!auth.ok) return auth.response;
    const adminEmail = auth.user.email;

    let confirm: string | undefined;
    try {
        const body = await req.json();
        confirm = typeof body?.confirm === 'string' ? body.confirm : undefined;
    } catch {
        confirm = undefined;
    }

    if (confirm !== CONFIRM_TOKEN) {
        logger.warn({ email: adminEmail }, 'System reset rejected: missing confirm token');
        return badRequest(`This action wipes all data. Send { "confirm": "${CONFIRM_TOKEN}" } to proceed.`);
    }

    try {
        // 1) 先备份；备份失败就绝不删数据
        let backupPath: string | null = null;
        try {
            backupPath = await backupDatabase();
        } catch (backupError) {
            logger.error({ error: backupError }, 'System reset aborted: backup failed');
            return internalError("Backup failed, reset aborted");
        }

        // 2) 统计一次，用于审计留痕
        const [items, users, subjects, tags] = await Promise.all([
            prisma.errorItem.count(),
            prisma.user.count(),
            prisma.subject.count(),
            prisma.knowledgeTag.count({ where: { isSystem: false } }),
        ]);

        logger.warn({ email: adminEmail, backupPath }, 'System reset initiated');

        await prisma.$transaction(async (tx) => {
            await tx.practiceRecord.deleteMany({});
            await tx.errorItem.deleteMany({});
            await tx.subject.deleteMany({});
            await tx.knowledgeTag.deleteMany({ where: { isSystem: false } });

            // 保留当前管理员，避免把自己锁在门外
            if (adminEmail) {
                await tx.user.deleteMany({
                    where: { email: { not: adminEmail } }
                });
            }
        });

        logger.warn({
            email: adminEmail,
            backupPath,
            deleted: { items, subjects, tags, usersBefore: users },
        }, 'System reset completed');

        return NextResponse.json({
            success: true,
            message: "System reset complete",
            backup: backupPath ? path.basename(backupPath) : null,
            deleted: { items, subjects, tags },
        });
    } catch (error) {
        logger.error({ error }, 'System reset error');
        return internalError("Failed to reset system");
    }
}
