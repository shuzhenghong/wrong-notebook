import { NextResponse } from "next/server";
import { getAIService } from "@/lib/ai";
import { badRequest, createErrorResponse, tooManyRequests, ErrorCode } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getCurrentUser } from "@/lib/server-auth";
import { rateLimit } from "@/lib/rate-limit";

const logger = createLogger('api:reanswer');

const REANSWER_RATE_LIMIT = 20;
const REANSWER_RATE_WINDOW_MS = 60_000;

export async function POST(req: Request) {
    logger.info('Reanswer API called');

    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    const limitResult = rateLimit(`reanswer:${auth.user.id}`, REANSWER_RATE_LIMIT, REANSWER_RATE_WINDOW_MS);
    if (!limitResult.ok) {
        logger.warn({ userId: auth.user.id }, 'Reanswer rate limit exceeded');
        return tooManyRequests(limitResult.retryAfterSeconds);
    }

    try {
        const body = await req.json();
        const { questionText, language = 'zh', subject, imageBase64, gradeSemester } = body;

        logger.debug({
            questionLength: questionText?.length,
            language,
            subject,
            hasImage: !!imageBase64,
            gradeSemester
        }, 'Reanswer request received');

        if (!questionText || questionText.trim().length === 0) {
            logger.warn('Missing question text');
            return badRequest("Missing question text");
        }

        const aiService = getAIService();

        // 根据是否有图片选择不同的重新解题方式
        const result = await aiService.reanswerQuestion(questionText, language, subject, imageBase64, gradeSemester);

        logger.info('Reanswer successful');

        return NextResponse.json(result);
    } catch (error: unknown) {
        const errorMessageFromError = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error({ error: errorMessageFromError, stack }, 'Reanswer error occurred');

        let errorMessage = errorMessageFromError || "Failed to reanswer question";

        if (errorMessageFromError.includes('AI_AUTH_ERROR')) {
            errorMessage = 'AI_AUTH_ERROR';
        } else if (errorMessageFromError === 'AI_CONNECTION_FAILED') {
            errorMessage = 'AI_CONNECTION_FAILED';
        } else if (errorMessageFromError === 'AI_RESPONSE_ERROR') {
            errorMessage = 'AI_RESPONSE_ERROR';
        }

        return createErrorResponse(errorMessage, 500, ErrorCode.AI_ERROR);
    }
}
