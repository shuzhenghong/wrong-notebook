import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { internalError, notFound, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getCurrentUser } from "@/lib/server-auth";

const logger = createLogger('api:error-items:notes');

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const { userNotes } = await req.json();

        // 先确认这条错题属于当前用户 —— 补上报告点名的 IDOR 漏洞
        const existing = await prisma.errorItem.findUnique({
            where: { id },
            select: { userId: true },
        });

        if (!existing) {
            return notFound("Error item not found");
        }
        if (existing.userId !== auth.user.id) {
            logger.warn({ itemId: id, userId: auth.user.id }, 'User attempted to update notes on another user\'s item');
            return forbidden("Not owner");
        }

        const errorItem = await prisma.errorItem.update({
            where: { id },
            data: { userNotes },
        });

        return NextResponse.json(errorItem);
    } catch (error) {
        logger.error({ error }, 'Error updating notes');
        return internalError("Failed to update notes");
    }
}
