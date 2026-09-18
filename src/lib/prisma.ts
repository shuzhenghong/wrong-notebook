import { PrismaClient } from '@prisma/client'

const globalForPrisma = global as unknown as { prisma: PrismaClient }

export const prisma =
    globalForPrisma.prisma ||
    new PrismaClient({
        log: process.env.DEBUG_DB === 'true'
            ? ['query', 'error', 'warn']
            : (process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']),
    })

// SQLite 加固：开启 WAL + 设置 busy_timeout
// - WAL 允许并发读，写入冲突概率显著下降
// - busy_timeout 让 Prisma 等待 SQLite 锁最多 5 秒再抛错
if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 使用 $executeRawUnsafe 发 PRAGMA（SQLite 特有）
    Promise.resolve()
        .then(() => prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL;'))
        .then(() => prisma.$executeRawUnsafe('PRAGMA busy_timeout=5000;'))
        .catch((err) => {
            // 如果 DB 文件还没建好就调用（首次启动），忽略错误
            console.warn('[prisma] failed to apply SQLite PRAGMA (may be first start):', err.message);
        });
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
