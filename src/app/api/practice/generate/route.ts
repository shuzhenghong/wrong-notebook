import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAIService } from "@/lib/ai";
import { notFound, internalError, tooManyRequests, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getCurrentUser } from "@/lib/server-auth";
import { rateLimit } from "@/lib/rate-limit";

const logger = createLogger('api:practice:generate');

const PRACTICE_RATE_LIMIT = 30;
const PRACTICE_RATE_WINDOW_MS = 60_000;

export async function POST(req: Request) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    const limitResult = rateLimit(`practice:${auth.user.id}`, PRACTICE_RATE_LIMIT, PRACTICE_RATE_WINDOW_MS);
    if (!limitResult.ok) {
        logger.warn({ userId: auth.user.id }, 'Practice generate rate limit exceeded');
        return tooManyRequests(limitResult.retryAfterSeconds);
    }

    try {
        const { errorItemId, language, difficulty } = await req.json();

        const errorItemWithSubject = await prisma.errorItem.findUnique({
            where: { id: errorItemId },
            include: { subject: true }
        });

        if (!errorItemWithSubject) {
            return notFound("Item not found");
        }

        // 归属校验：不能拿别人的错题去生成练习题（否则会泄露他人题目内容）
        if (errorItemWithSubject.userId !== auth.user.id) {
            logger.warn({ userId: auth.user.id, errorItemId }, 'Forbidden practice generate on foreign item');
            return forbidden("Not authorized to access this item");
        }

        let tags: string[] = [];
        try {
            tags = JSON.parse(errorItemWithSubject.knowledgePoints || "[]");
        } catch (e) {
            tags = [];
        }

        const aiService = getAIService();
        const similarQuestion = await aiService.generateSimilarQuestion(
            errorItemWithSubject.questionText || "",
            tags,
            language,
            difficulty || 'medium',
            errorItemWithSubject.gradeSemester
        );

        // Inject the subject from the database with type safety
        const validSubjects = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"] as const;
        const subjectName = errorItemWithSubject.subject?.name || "其他";
        similarQuestion.subject = validSubjects.includes(subjectName as any) ? subjectName as typeof validSubjects[number] : "其他";

        return NextResponse.json(similarQuestion);
    } catch (error) {
        logger.error({ error }, 'Error generating practice');
        const errorMessage = error instanceof Error ? error.message : "Failed to generate practice question";
        return internalError(errorMessage);
    }
}
