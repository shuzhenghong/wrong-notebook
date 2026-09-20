import { PrismaClient } from '@prisma/client'

const globalForPrisma = global as unknown as { prisma: PrismaClient }

export const prisma =
    globalForPrisma.prisma ||
    new PrismaClient({
        log: process.env.DEBUG_DB === 'true'
            ? ['query', 'error', 'warn']
            : (process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']),
    })

// SQLite 加固：开启 WAL + 设置 busy_timeout + synchronous=NORMAL
// - WAL 允许并发读，写入冲突概率显著下降
// - busy_timeout 让 Prisma 等待 SQLite 锁最多 5 秒再抛错
// - synchronous=NORMAL 在 WAL 模式下是安全推荐值：写入不再每次 fsync，
//   只在 checkpoint 时落盘，事务原子性仍由 WAL 保证（掉电最多丢最后一个 checkpoint 后的事务）
if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 注意：SQLite 的 PRAGMA（含带赋值形式）会返回一行结果（生效值），
    // 必须用 $queryRawUnsafe；$executeRaw* 遇到"返回结果集的语句"会直接报错：
    // "Execute returned results, which is not allowed in SQLite."
    Promise.resolve()
        .then(async () => {
            const mode = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode=WAL;');
            if (mode[0]?.journal_mode?.toLowerCase() !== 'wal') {
                console.warn('[prisma] WAL mode not active, got:', mode[0]);
            }
        })
        .then(() => prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000;'))
        .then(() => prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;'))
        .catch((err) => {
            // 如果 DB 文件还没建好就调用（首次启动），忽略错误
            console.warn('[prisma] failed to apply SQLite PRAGMA (may be first start):', err.message);
        });
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
