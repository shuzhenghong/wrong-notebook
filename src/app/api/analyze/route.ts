import { NextResponse } from "next/server";
import { getAIService } from "@/lib/ai";
import { calculateGradeNumber, inferSubjectFromName } from "@/lib/knowledge-tags";
import { calculateGrade } from "@/lib/grade-calculator";
import { prisma } from "@/lib/prisma";
import { badRequest, createErrorResponse, tooManyRequests, ErrorCode } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { validateBaseUrlWithDns } from "@/lib/config";
import { getAIServiceWithCandidates } from "@/lib/ai";
import { getCurrentUser } from "@/lib/server-auth";
import { rateLimit } from "@/lib/rate-limit";

const logger = createLogger('api:analyze');

// 单张图片体积上限：8MB。按 base64 膨胀 4/3 折算成字符数上限
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3);

// AI 分析很贵：每用户每分钟最多 20 次
const ANALYZE_RATE_LIMIT = 20;
const ANALYZE_RATE_WINDOW_MS = 60_000;

export async function POST(req: Request) {
    logger.info('Analyze API called');

    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;
    const currentUser = auth.user;

    // 认证检查
    const limitResult = rateLimit(`analyze:${currentUser.id}`, ANALYZE_RATE_LIMIT, ANALYZE_RATE_WINDOW_MS);
    if (!limitResult.ok) {
        logger.warn({ userId: currentUser.id }, 'Analyze rate limit exceeded');
        return tooManyRequests(limitResult.retryAfterSeconds);
    }

    try {
        const body = await req.json();
        let { imageBase64, mimeType, language, subjectId, ocrText } = body;

        logger.debug({
            imageLength: imageBase64?.length,
            mimeType,
            language,
            subjectId
        }, 'Request received');

        const hasOcrText = typeof ocrText === 'string' && ocrText.trim().length > 0;

        if (hasOcrText) {
            logger.info({ ocrLen: ocrText.length }, 'OCR text provided — 走纯文本模式，省多模态成本');
        }

        if (!imageBase64 && !hasOcrText) {
            logger.warn('Missing image data and ocrText');
            return badRequest("Missing image data");
        }

        if (imageBase64 && (typeof imageBase64 !== 'string' || imageBase64.length > MAX_IMAGE_BASE64_CHARS)) {
            logger.warn({ size: typeof imageBase64 === 'string' ? imageBase64.length : 'n/a' }, 'Image payload too large');
            return badRequest(`Image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`);
        }

        // Parse Data URL if present
        if (imageBase64.startsWith('data:')) {
            const matches = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
                mimeType = matches[1];
                imageBase64 = matches[2];
                logger.debug({ mimeType, base64Length: imageBase64.length }, 'Parsed Data URL');
            }
        }

        // 先获取用户年级信息，用于动态生成 AI prompt 中的标签列表
        let userGrade: 7 | 8 | 9 | 10 | 11 | 12 | null = null;
        let userGradeSemester: string | null = null;
        let subjectName: 'math' | 'physics' | 'chemistry' | 'biology' | 'english' | 'chinese' | 'history' | 'geography' | 'politics' | null = null;

        try {
            // 用户信息已由 getCurrentUser 一次查回，这里不要再重复查库
            userGrade = calculateGradeNumber(currentUser.educationStage, currentUser.enrollmentYear);
            if (currentUser.educationStage && currentUser.enrollmentYear) {
                userGradeSemester = calculateGrade(currentUser.educationStage, currentUser.enrollmentYear, new Date(), 'zh');
            }
            logger.debug({ userGrade, userGradeSemester }, 'Calculated user grade');

            // 获取错题本信息以推断学科
            if (subjectId) {
                const subject = await prisma.subject.findUnique({
                    where: { id: subjectId },
                    select: { id: true, userId: true, name: true }
                });

                if (subject && subject.userId === currentUser.id) {
                    subjectName = inferSubjectFromName(subject.name);
                    logger.debug({ subjectName, subjectDisplayName: subject.name }, 'Inferred subject');
                }
            }
        } catch (error) {
            logger.error({ error }, 'Error fetching user/subject info');
            // 继续执行，不传递年级参数（会返回所有年级的标签）
        }


        // 将内部科目名称转换为中文科目名称
        const subjectNameMapping: Record<string, string> = {
            'math': '数学',
            'physics': '物理',
            'chemistry': '化学',
            'biology': '生物',
            'english': '英语',
            'chinese': '语文',
            'history': '历史',
            'geography': '地理',
            'politics': '政治',
        };
        const subjectChinese = subjectName ? subjectNameMapping[subjectName] : null;

        // 运行期再校验一次 AI 出口地址：配置文件可能被手工改成内网地址。
        // fallback 链上所有候选渠道的出口都要校验（主渠道失败会切到备选）。
        const { service: aiService, candidates: aiCandidates } = getAIServiceWithCandidates();
        for (const runtimeUrl of aiCandidates.map((c) => c.url)) {
            const check = await validateBaseUrlWithDns(runtimeUrl);
            if (!check.ok) {
                logger.error({ reason: check.reason }, 'Refusing to call AI provider with unsafe baseUrl');
                return badRequest(`Unsafe AI endpoint: ${check.reason}`);
            }
        }

        logger.info({ userGrade, userGradeSemester, subject: subjectChinese, channels: aiCandidates.length }, 'Calling AI service for image analysis');

        // SSE 流式模式：客户端带 Accept: text/event-stream 时，分阶段推送
        // status / delta（AI 增量文本）/ result / error 事件，替代长时间无反馈的阻塞等待
        const wantsSSE = (req.headers.get('accept') || '').includes('text/event-stream');
        if (wantsSSE) {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                    const send = (event: string, data: unknown) => {
                        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                    };
                    try {
                        send('status', { stage: 'calling_ai' });
                        const callFn = hasOcrText
                            ? aiService.analyzeText.bind(aiService, ocrText, language, userGrade, subjectChinese, userGradeSemester)
                            : aiService.analyzeImage.bind(aiService, imageBase64, mimeType, language, userGrade, subjectChinese, userGradeSemester);
                        const result = await callFn((delta) => send('delta', { text: delta }));
                        if (!result?.knowledgePoints?.length) {
                            logger.warn('Knowledge points is empty or null');
                        }
                        send('result', result);
                        logger.info({ mode: 'sse' }, 'AI analysis successful');
                    } catch (error: any) {
                        logger.error({ error: error.message, stack: error.stack }, 'Analysis error occurred (SSE)');
                        send('error', { message: normalizeAnalyzeError(error) });
                    } finally {
                        controller.close();
                    }
                },
            });
            return new Response(stream, {
                headers: {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                },
            });
        }

        const analysisResult = hasOcrText
            ? await aiService.analyzeText(ocrText, language, userGrade, subjectChinese, userGradeSemester)
            : await aiService.analyzeImage(imageBase64, mimeType, language, userGrade, subjectChinese, userGradeSemester);

        logger.debug({
            knowledgePointsCount: analysisResult.knowledgePoints?.length,
            knowledgePointsType: typeof analysisResult.knowledgePoints,
            isArray: Array.isArray(analysisResult.knowledgePoints)
        }, 'AI returned knowledge points');

        // AI 现在从数据库获取标签列表，返回的标签已经是标准化的，不需要额外处理
        if (!analysisResult.knowledgePoints || analysisResult.knowledgePoints.length === 0) {
            logger.warn('Knowledge points is empty or null');
        }

        logger.info('AI analysis successful');

        return NextResponse.json(analysisResult);
    } catch (error: any) {
        logger.error({
            error: error.message,
            stack: error.stack
        }, 'Analysis error occurred');

        // 只回传归一化后的错误码，不把上游原始报文透给前端（可能含 endpoint、密钥片段）
        return createErrorResponse(normalizeAnalyzeError(error), 500, ErrorCode.AI_ERROR);
    }
}

/** 把任意异常归一化为前端可识别的 AI_* 错误码（JSON 与 SSE 两条路径共用） */
function normalizeAnalyzeError(error: any): string {
    const message: string = error?.message || "Failed to analyze image";

    if (
        message === 'AI_CONNECTION_FAILED' ||
        message === 'AI_RESPONSE_ERROR' ||
        message.includes('AI_AUTH_ERROR') ||
        message === 'AI_TIMEOUT_ERROR' ||
        message === 'AI_QUOTA_EXCEEDED' ||
        message === 'AI_PERMISSION_DENIED' ||
        message === 'AI_NOT_FOUND' ||
        message === 'AI_SERVICE_UNAVAILABLE' ||
        message === 'AI_UNKNOWN_ERROR'
    ) {
        // 如果是 AI_AUTH_ERROR，提取出来
        return message.includes('AI_AUTH_ERROR') ? 'AI_AUTH_ERROR' : message;
    }
    if (message.includes('Zod') || message.includes('validate')) {
        return 'AI_RESPONSE_ERROR';
    }
    return message;
}
