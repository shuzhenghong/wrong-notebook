import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { forbidden, notFound, internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/server-auth";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { storeImage, isInlineImage, deleteImageByUrl } from "@/lib/image-storage";

const logger = createLogger('api:error-items:id');

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const user = auth.user;

        const errorItem = await prisma.errorItem.findUnique({
            where: {
                id: id,
            },
            include: {
                subject: true,
                tags: true, // 包含标签关联
            },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        // Ensure the user owns this item
        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to access this item");
        }

        return NextResponse.json(errorItem);
    } catch (error) {
        logger.error({ error }, 'Error fetching item');
        return internalError("Failed to fetch error item");
    }
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const user = auth.user;

        const body = await req.json();
        const { knowledgePoints, gradeSemester, paperLevel, questionText, answerText, analysis, subjectId,  wrongAnswerText, mistakeAnalysis, mistakeStatus, geogebraCommands, geogebraSuitable, referenceImageUrl, wrongAnswerImageUrl } = body;

        const errorItem = await prisma.errorItem.findUnique({
            where: { id },
            include: { subject: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to update this item");
        }

        // 构建更新数据
        const updateData: Prisma.ErrorItemUpdateInput = {};
        if (gradeSemester !== undefined) updateData.gradeSemester = gradeSemester;
        if (paperLevel !== undefined) updateData.paperLevel = paperLevel;
        if (questionText !== undefined) updateData.questionText = questionText;
        if (answerText !== undefined) updateData.answerText = answerText;
        if (analysis !== undefined) updateData.analysis = analysis;
        if (wrongAnswerText !== undefined) updateData.wrongAnswerText = wrongAnswerText || null;
        if (mistakeAnalysis !== undefined) updateData.mistakeAnalysis = mistakeAnalysis || null;
        if (subjectId !== undefined) {
            // 验证目标错题本存在且属于该用户
            const targetSubject = await prisma.subject.findUnique({ where: { id: subjectId } });
            if (!targetSubject || targetSubject.userId !== user.id) {
                return forbidden("Not authorized to move to this notebook");
            }
            updateData.subject = subjectId === "" ? { disconnect: true } : { connect: { id: subjectId } };
        }
        if (mistakeStatus !== undefined || wrongAnswerText !== undefined || mistakeAnalysis !== undefined) {
            const nextWrongAnswerText = wrongAnswerText !== undefined ? wrongAnswerText : errorItem.wrongAnswerText;
            const nextMistakeAnalysis = mistakeAnalysis !== undefined ? mistakeAnalysis : errorItem.mistakeAnalysis;
            updateData.mistakeStatus = normalizeMistakeStatusForSave(
                mistakeStatus,
                nextWrongAnswerText
            );
        }
        if (geogebraCommands !== undefined) updateData.geogebraCommands = geogebraCommands || null;
        if (geogebraSuitable !== undefined) updateData.geogebraSuitable = geogebraSuitable ?? null;

        // 附加图（参考图 / 学生作答图）：内联 base64 落盘；显式 url 或 null 原样写入；旧文件按需清理
        if (referenceImageUrl !== undefined) {
            if (referenceImageUrl && isInlineImage(referenceImageUrl)) {
                const stored = storeImage(user.id, `${id}__ref`, referenceImageUrl);
                if (stored) {
                    if (errorItem.referenceImageUrl) deleteImageByUrl(errorItem.referenceImageUrl);
                    updateData.referenceImageUrl = stored.url;
                }
            } else {
                if (errorItem.referenceImageUrl && errorItem.referenceImageUrl !== referenceImageUrl) {
                    deleteImageByUrl(errorItem.referenceImageUrl);
                }
                updateData.referenceImageUrl = referenceImageUrl || null;
            }
        }
        if (wrongAnswerImageUrl !== undefined) {
            if (wrongAnswerImageUrl && isInlineImage(wrongAnswerImageUrl)) {
                const stored = storeImage(user.id, `${id}__wrong`, wrongAnswerImageUrl);
                if (stored) {
                    if (errorItem.wrongAnswerImageUrl) deleteImageByUrl(errorItem.wrongAnswerImageUrl);
                    updateData.wrongAnswerImageUrl = stored.url;
                }
            } else {
                if (errorItem.wrongAnswerImageUrl && errorItem.wrongAnswerImageUrl !== wrongAnswerImageUrl) {
                    deleteImageByUrl(errorItem.wrongAnswerImageUrl);
                }
                updateData.wrongAnswerImageUrl = wrongAnswerImageUrl || null;
            }
        }

        // 处理 knowledgePoints (标签)
        if (knowledgePoints !== undefined) {
            const tagNames: string[] = Array.isArray(knowledgePoints)
                ? knowledgePoints
                : typeof knowledgePoints === 'string'
                    ? JSON.parse(knowledgePoints)
                    : [];

            // 推断学科
            const subjectKey = errorItem.subject?.name?.toLowerCase().includes('math') ||
                errorItem.subject?.name?.includes('数学')
                ? 'math'
                : errorItem.subject?.name?.toLowerCase().includes('english') ||
                    errorItem.subject?.name?.includes('英语')
                    ? 'english'
                    : 'other';

            const tagConnections: { id: string }[] = [];

            // 与创建接口保持一致：批量查 + 批量建，避免逐条往返
            if (tagNames.length > 0) {
                const existingTags = await prisma.knowledgeTag.findMany({
                    where: {
                        name: { in: tagNames },
                        OR: [
                            { isSystem: true },
                            { userId: user.id },
                        ],
                    },
                    select: { id: true, name: true },
                });

                const tagIdByName = new Map<string, string>();
                for (const tag of existingTags) {
                    if (!tagIdByName.has(tag.name)) tagIdByName.set(tag.name, tag.id);
                }

                const missingNames = tagNames.filter((name) => !tagIdByName.has(name));
                if (missingNames.length > 0) {
                    // Determine grade context for the new tag
                    // Use the incoming gradeSemester (priority) or the existing one on the item
                    const contextGrade = gradeSemester !== undefined ? gradeSemester : errorItem.gradeSemester;
                    const parentId = await findParentTagIdForGrade(contextGrade, subjectKey);

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

            // 更新标签关联: 先断开所有，再连接新的
            updateData.tags = {
                set: [], // 先清空
                connect: tagConnections,
            };

            // 保留旧字段兼容
            updateData.knowledgePoints = JSON.stringify(tagNames);
        }

        logger.info({ id }, 'Updating error item');

        const updated = await prisma.errorItem.update({
            where: { id },
            data: updateData,
            include: { tags: true },
        });

        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error updating item');
        return internalError("Failed to update error item");
    }
}
