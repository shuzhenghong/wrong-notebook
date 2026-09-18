import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/server-auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:tags:suggestions');

/**
 * GET /api/tags/suggestions
 * 获取标签建议（支持搜索）
 * Query params:
 *   - q: 搜索词
 *   - subject: 学科 (可选, e.g., 'math')
 *   - stage: 学段 (可选)
 *
 * 现在从数据库 KnowledgeTag 表查询，包含系统标签和用户的自定义标签
 */
export async function GET(req: Request) {
    try {
        const auth = await getCurrentUser();
        if (!auth.ok) return auth.response;
        const user = auth.user;

        const { searchParams } = new URL(req.url);
        const query = searchParams.get("q")?.toLowerCase() || "";
        const subject = searchParams.get("subject") || undefined;
        const stage = searchParams.get("stage") || undefined;

        const whereCondition: any = {
            ...(subject ? { subject } : {}),
            OR: [
                { isSystem: true },
                { userId: user.id },
            ]
        };

        // Fetch all system tags AND user tags for the subject
        const allTags = await prisma.knowledgeTag.findMany({
            where: whereCondition,
            select: {
                id: true,
                name: true,
                parentId: true,
                userId: true,
                isSystem: true,
                children: { select: { id: true } }, // Check if leaf
            },
        });

        // Identify leaf nodes (suggestions candidates)
        // A node is a leaf if it has no children in the fetched set
        // Actually, we can check children array length from the query
        // But the query for 'children' relies on the relation.
        // Let's filter in memory.

        const tagMap = new Map<string, typeof allTags[0]>();
        allTags.forEach(t => tagMap.set(t.id, t));

        let suggestions = allTags.filter(t => t.children.length === 0);

        // Filter by stage if provided
        if (stage) {
            const allowedGradePatterns: Record<string, string[]> = {
                'primary': ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'],
                'junior_high': ['七年级', '八年级', '九年级'],
                'senior_high': ['高一', '高二', '高三'],
            };

            const filters = allowedGradePatterns[stage];
            if (filters) {
                suggestions = suggestions.filter(tag => {
                    // Always show user custom tags (non-system tags) regardless of stage filter
                    // unless we want to enforce structure on them too? Usually custom tags have flattened structure or no parent
                    if (!tag.isSystem) {
                        return true;
                    }

                    let current = tag;
                    // Traverse up to find root
                    while (current.parentId && tagMap.get(current.parentId)) {
                        current = tagMap.get(current.parentId)!;
                    }
                    // Current is now the root (or top-most loaded ancestor)
                    const isMatch = filters.some(f => current.name.includes(f));
                    return isMatch;
                });
            }
        }

        // Filter by query
        if (query) {
            suggestions = suggestions.filter((tag) =>
                tag.name.toLowerCase().includes(query)
            );
        }

        // Secondary sorting by name match position (optional) or just name
        const finalSuggestions = suggestions
            .slice(0, 30)
            .map(s => s.name);

        return NextResponse.json({
            suggestions: finalSuggestions,
            total: suggestions.length,
        });
    } catch (error) {
        logger.error({ error }, 'Error getting tag suggestions');
        return NextResponse.json(
            { message: "Failed to get tag suggestions" },
            { status: 500 }
        );
    }
}

