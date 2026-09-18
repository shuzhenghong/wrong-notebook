import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, conflict, internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/server-auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:notebooks');

/**
 * GET /api/notebooks
 * 获取用户所有错题本（Subjects）
 */
export async function GET() {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const userId = auth.user.id;

        let notebooks = await prisma.subject.findMany({
            where: {
                userId,
            },
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        });

        // If no notebooks exist, create default ones
        if (notebooks.length === 0) {
            const defaultSubjects = ["数学", "英语"];

            await Promise.all(defaultSubjects.map(name =>
                prisma.subject.create({
                    data: {
                        name,
                        userId,
                    }
                })
            ));

            // Fetch again
            notebooks = await prisma.subject.findMany({
                where: {
                    userId,
                },
                include: {
                    _count: {
                        select: {
                            errorItems: true,
                        },
                    },
                },
                orderBy: {
                    createdAt: 'desc',
                },
            });
        }

        return NextResponse.json(notebooks);
    } catch (error) {
        logger.error({ error }, 'Error fetching notebooks');
        return internalError("Failed to fetch notebooks");
    }
}

/**
 * POST /api/notebooks
 * 创建新错题本
 */
export async function POST(req: Request) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const userId = auth.user.id;

        const body = await req.json();
        const { name } = body;

        if (!name || !name.trim()) {
            return badRequest("Notebook name is required");
        }

        // 检查是否已存在同名错题本
        const existing = await prisma.subject.findUnique({
            where: {
                name_userId: {
                    name: name.trim(),
                    userId,
                },
            },
        });

        if (existing) {
            return conflict("Notebook with this name already exists");
        }

        const notebook = await prisma.subject.create({
            data: {
                name: name.trim(),
                userId,
            },
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
        });

        return NextResponse.json(notebook, { status: 201 });
    } catch (error) {
        logger.error({ error }, 'Error creating notebook');
        return internalError("Failed to create notebook");
    }
}
