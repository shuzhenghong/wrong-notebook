import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getCurrentUser } from '@/lib/server-auth';
import { badRequest } from '@/lib/api-errors';

const logger = createLogger('frontend-logs');

export const runtime = 'nodejs';

// 单条日志最大长度 / 批量条数 — 防止日志投毒
const MAX_LOG_ENTRIES = 50;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_CONTEXT_KEYS = 20;

interface FrontendLogEntry {
  level: 'info' | 'warn' | 'error';
  prefix: string;
  message: string;
  context?: Record<string, any>;
  timestamp: string;
  url?: string;
  userAgent?: string;
}

interface BatchLogRequest {
  logs: FrontendLogEntry[];
}

/**
 * POST /api/logs/frontend
 *
 * 接收前端日志并写入后端 logger。
 * - 必须登录（防止匿名日志投毒）
 * - 单条上限 2KB / 批量最多 50 条
 */
export async function POST(request: NextRequest) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const body = await request.json();

        const rawLogs: FrontendLogEntry[] = Array.isArray((body as BatchLogRequest).logs)
            ? (body as BatchLogRequest).logs
            : [body as FrontendLogEntry];

        if (rawLogs.length > MAX_LOG_ENTRIES) {
            return badRequest(`Too many logs in one batch (max ${MAX_LOG_ENTRIES})`);
        }

        let accepted = 0;

        for (const entry of rawLogs) {
            if (!entry || typeof entry.message !== 'string') continue;

            const trimmed = entry.message.slice(0, MAX_MESSAGE_LENGTH);
            const safeContext: Record<string, unknown> = {};
            const ctxObj = entry.context || {};
            let keys = 0;
            for (const [k, v] of Object.entries(ctxObj)) {
                if (keys >= MAX_CONTEXT_KEYS) break;
                safeContext[k] = typeof v === 'string' ? v.slice(0, 200) : v;
                keys++;
            }

            const logContext = {
                source: 'frontend',
                userId: auth.user.id,
                prefix: entry.prefix,
                url: entry.url || request.headers.get('referer'),
                clientTime: entry.timestamp,
                ...safeContext,
            };

            switch (entry.level) {
                case 'error':
                    logger.error(logContext, trimmed);
                    break;
                case 'warn':
                    logger.warn(logContext, trimmed);
                    break;
                case 'info':
                default:
                    logger.info(logContext, trimmed);
                    break;
            }
            accepted++;
        }

        return NextResponse.json({ success: true, count: accepted });
    } catch (error) {
        logger.error({ error }, 'Failed to process frontend log');
        return NextResponse.json({ success: false }, { status: 500 });
    }
}
