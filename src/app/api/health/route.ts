import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:health');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health
 *
 * 供容器编排与部署后自检使用：只暴露必要的连通性信息，不返回任何用户数据。
 */
export async function GET() {
    let dbStatus: 'ok' | 'error' = 'ok';

    try {
        await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
        dbStatus = 'error';
        logger.error({ error }, 'Health check: database unreachable');
    }

    return NextResponse.json(
        {
            status: dbStatus === 'ok' ? 'ok' : 'degraded',
            db: dbStatus,
            uptimeSeconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
        },
        { status: dbStatus === 'ok' ? 200 : 503 }
    );
}
