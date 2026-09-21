import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { calculateGrade } from "@/lib/grade-calculator";
import { internalError, validationError, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { getCurrentUser } from "@/lib/server-auth";
import { storeImage, isInlineImage } from "@/lib/image-storage";

const logger = createLogger('api:error-items');

// 图片最大 8MB（base64 膨胀后约 11M 字符）
const MAX_IMAGE_BASE64_CHARS = Math.ceil((8 * 1024 * 1024) * 4 / 3);

const createErrorItemSchema = z.object({
    questionText: z.string().max(20000).optional(),
    answerText: z.string().max(20000).optional(),
    analysis: z.string().max(50000).optional(),
    wrongAnswerText: z.string().max(20000).optional().nullable(),
    mistakeAnalysis: z.string().max(20000).optional().nullable(),
    mistakeStatus: z.string().max(50).optional(),
    // 历史客户端可能传 JSON 字符串，这里两种都收，后续统一成数组
    knowledgePoints: z.union([z.array(z.string().max(100)).max(20), z.string().max(5000)]).optional(),
    originalImageUrl: z.string().max(MAX_IMAGE_BASE64_CHARS).optional(),
    subjectId: z.string().max(100).optional().nullable(),
    gradeSemester: z.string().max(100).optional(),
    paperLevel: z.string().max(50).optional(),
    geogebraCommands: z.string().max(20000).optional().nullable(),
    geogebraSuitable: z.boolean().optional(),
    referenceImageUrl: z.string().max(MAX_IMAGE_BASE64_CHARS).optional(),
    wrongAnswerImageUrl: z.string().max(MAX_IMAGE_BASE64_CHARS).optional(),
});

export async function POST(req: Request) {
    logger.info('POST /api/error-items called');

    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;
    const currentUser = auth.user;

    try {
        const body = await req.json();

        const parsed = createErrorItemSchema.safeParse(body);
        if (!parsed.success) {
            logger.warn({ issues: parsed.error.issues }, 'Invalid create error item payload');
            return validationError("Invalid input", parsed.error.issues);
        }

        const {
            questionText,
            answerText,
            analysis,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            knowledgePoints,
            originalImageUrl,
            subjectId,
            gradeSemester,
            paperLevel,
            geogebraCommands,
            geogebraSuitable,
            referenceImageUrl: referenceImageUrlRaw,
            wrongAnswerImageUrl: wrongAnswerImageUrlRaw,
        } = parsed.data;

        // 记录请求参数（不记录完整图片数据）
        logger.debug({
            hasQuestionText: !!questionText,
            questionTextLength: questionText?.length || 0,
            hasAnswerText: !!answerText,
            hasAnalysis: !!analysis,
            hasWrongAnswerText: !!wrongAnswerText,
            hasMistakeAnalysis: !!mistakeAnalysis,
            mistakeStatus,
            knowledgePointsCount: Array.isArray(knowledgePoints) ? knowledgePoints.length : 0,
            hasImage: !!originalImageUrl,
            imageSize: originalImageUrl?.length || 0,
            subjectId,
            gradeSemester,
            paperLevel,
            hasGeogebraCommands: !!geogebraCommands,
        }, 'Request parameters received');

        const user = currentUser;

        // ========== 去重检查：2秒内同一用户提交相同题目视为重复 ==========
        const DEDUP_WINDOW_MS = 2000; // 2秒去重窗口
        const questionTextPrefix = questionText?.substring(0, 100) || ''; // 取前100字符比较

        if (questionTextPrefix) {
            const recentDuplicate = await prisma.errorItem.findFirst({
                where: {
                    userId: user.id,
                    questionText: {
                        startsWith: questionTextPrefix,
                    },
                    createdAt: {
                        gte: new Date(Date.now() - DEDUP_WINDOW_MS),
                    },
                },
                include: {
                    tags: true,
                },
            });

            if (recentDuplicate) {
                logger.info({
                    existingId: recentDuplicate.id,
                    userId: user.id,
                    timeDiff: Date.now() - recentDuplicate.createdAt.getTime()
                }, 'Duplicate submission detected within dedup window, returning existing record');

                return NextResponse.json({
                    ...recentDuplicate,
                    duplicate: true, // 标记为重复提交
                }, { status: 200 }); // 返回 200 而非 201
            }
        }

        // 计算年级
        let finalGradeSemester = gradeSemester;
        if (!finalGradeSemester && user.educationStage && user.enrollmentYear) {
            finalGradeSemester = calculateGrade(user.educationStage, user.enrollmentYear);
            logger.debug({ finalGradeSemester, educationStage: user.educationStage, enrollmentYear: user.enrollmentYear }, 'Grade calculated');
        }

        // 处理知识点标签（历史数据里可能是 JSON 字符串，统一归一成数组）
        let tagNames: string[] = [];
        if (Array.isArray(knowledgePoints)) {
            tagNames = knowledgePoints;
        } else if (typeof knowledgePoints === 'string') {
            try {
                const parsedTags = JSON.parse(knowledgePoints);
                if (Array.isArray(parsedTags)) tagNames = parsedTags.filter((t) => typeof t === 'string');
            } catch {
                tagNames = [];
            }
        }
        const tagConnections: { id: string }[] = [];

        // 推断学科
        const subject = subjectId
            ? await prisma.subject.findUnique({ where: { id: subjectId } })
            : null;
        // 归属校验：不能把错题挂到别人的错题本上（仅数据完整性，错题本身仍属当前用户）
        if (subjectId) {
            if (!subject) {
                logger.warn({ userId: user.id, subjectId }, 'Rejected error item create: subject not found');
                return validationError("Selected notebook not found");
            }
            if (subject.userId !== user.id) {
                logger.warn({ userId: user.id, subjectId }, 'Rejected error item create: subject belongs to another user');
                return forbidden("Not authorized to use this notebook");
            }
        }
        const subjectKey = inferSubjectFromName(subject?.name ?? null) || 'other';
        logger.debug({ subjectId, subjectName: subject?.name, subjectKey }, 'Subject inferred');

        // 批量解析标签：一次查已有 + 一次批量建 + 一次回查，取代原来的逐条往返
        if (tagNames.length > 0) {
            const existingTags = await prisma.knowledgeTag.findMany({
                where: {
                    name: { in: tagNames },
                    OR: [
                        { isSystem: true },
                        { userId: user.id },
                    ],
                },
                select: { id: true, name: true, isSystem: true },
            });

            const tagIdByName = new Map<string, string>();
            for (const tag of existingTags) {
                if (!tagIdByName.has(tag.name)) tagIdByName.set(tag.name, tag.id);
            }
            logger.debug({ existing: existingTags.length, tagNames }, 'Existing tags resolved in one query');

            const missingNames = tagNames.filter((name) => !tagIdByName.has(name));
            if (missingNames.length > 0) {
                const parentId = await findParentTagIdForGrade(finalGradeSemester, subjectKey);
                logger.debug({ missingNames, parentId, subjectKey }, 'Creating new custom tags in batch');

                await prisma.knowledgeTag.createMany({
                    data: missingNames.map((name) => ({
                        name,
                        subject: subjectKey,
                        isSystem: false,
                        userId: user.id,
                        parentId,
                    })),
                });

                const created = await prisma.knowledgeTag.findMany({
                    where: { name: { in: missingNames }, userId: user.id },
                    select: { id: true, name: true },
                });
                for (const tag of created) {
                    if (!tagIdByName.has(tag.name)) tagIdByName.set(tag.name, tag.id);
                }
            }

            for (const name of tagNames) {
                const id = tagIdByName.get(name);
                if (id) tagConnections.push({ id });
            }
        }

        logger.info({ tagNames, tagConnectionsCount: tagConnections.length }, 'Creating ErrorItem with tags');

        // 图片落盘：新数据只把路径写进数据库，避免 base64 撑爆 SQLite
        const newItemId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        let finalImageUrl = originalImageUrl ?? "";
        let imageStorageKey: string | null = null;
        let imageMimeType: string | null = null;

        if (originalImageUrl && isInlineImage(originalImageUrl)) {
            const stored = storeImage(user.id, newItemId, originalImageUrl);
            if (stored) {
                finalImageUrl = stored.url;
                imageStorageKey = stored.storageKey;
                imageMimeType = stored.mimeType;
                logger.info({ bytes: stored.bytes, storageKey: stored.storageKey }, 'Image stored on disk');
            } else {
                logger.warn('Image was inline but could not be stored, keeping inline value');
            }
        }

        // 附加图落盘：参考图 / 学生作答图（复用同一套 magic-byte 校验与归属目录）
        let referenceImageUrl: string | null = null;
        let wrongAnswerImageUrl: string | null = null;
        if (referenceImageUrlRaw && isInlineImage(referenceImageUrlRaw)) {
            const stored = storeImage(user.id, `${newItemId}__ref`, referenceImageUrlRaw);
            if (stored) {
                referenceImageUrl = stored.url;
                logger.info({ storageKey: stored.storageKey }, 'Reference image stored on disk');
            }
        }
        if (wrongAnswerImageUrlRaw && isInlineImage(wrongAnswerImageUrlRaw)) {
            const stored = storeImage(user.id, `${newItemId}__wrong`, wrongAnswerImageUrlRaw);
            if (stored) {
                wrongAnswerImageUrl = stored.url;
                logger.info({ storageKey: stored.storageKey }, 'Wrong-answer image stored on disk');
            }
        }

        // 创建错题记录
        try {
            const errorItem = await prisma.errorItem.create({
                data: {
                    id: newItemId,
                    userId: user.id,
                    subjectId: subjectId || undefined,
                    originalImageUrl: finalImageUrl,
                    imageStorageKey,
                    imageMimeType,
                    questionText,
                    answerText,
                    analysis,
                    wrongAnswerText: wrongAnswerText || null,
                    mistakeAnalysis: mistakeAnalysis || null,
                    mistakeStatus: normalizeMistakeStatusForSave(mistakeStatus, wrongAnswerText),
                    knowledgePoints: JSON.stringify(tagNames),
                    gradeSemester: finalGradeSemester,
                    paperLevel: paperLevel,
                    geogebraCommands: geogebraCommands || null,
                    geogebraSuitable: geogebraSuitable ?? null,
                    referenceImageUrl,
                    wrongAnswerImageUrl,
                    masteryLevel: 0,
                    tags: {
                        connect: tagConnections,
                    },
                },
                include: {
                    tags: true,
                },
            });

            logger.info({ errorItemId: errorItem.id, tagsCount: errorItem.tags?.length || 0 }, 'ErrorItem created successfully');
            return NextResponse.json(errorItem, { status: 201 });
        } catch (dbError) {
            logger.error({
                error: dbError,
                userId: user.id,
                subjectId,
                tagConnectionsCount: tagConnections.length
            }, 'Database error creating ErrorItem');
            throw dbError;
        }
    } catch (error) {
        logger.error({
            error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined
        }, 'Error saving item');
        return internalError("Failed to save error item");
    }
}
