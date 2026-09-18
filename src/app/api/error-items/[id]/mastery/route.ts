import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, forbidden, badRequest, internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/server-auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:mastery');

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const user = auth.user;

        const body = await req.json().catch(() => ({}));
        const masteryLevel = body?.masteryLevel;

        if (!Number.isInteger(masteryLevel) || masteryLevel < 0 || masteryLevel > 5) {
            return badRequest("masteryLevel must be an integer between 0 and 5");
        }

        // Verify ownership before update
        const existingItem = await prisma.errorItem.findUnique({
            where: { id },
            select: { userId: true },
        });

        if (!existingItem) {
            return NextResponse.json({ message: "Item not found" }, { status: 404 });
        }

        if (existingItem.userId !== user.id) {
            return NextResponse.json({ message: "Not authorized to update this item" }, { status: 403 });
        }

        const errorItem = await prisma.errorItem.update({
            where: {
                id,
            },
            data: {
                masteryLevel,
            },
        });

        return NextResponse.json(errorItem);
    } catch (error) {
        logger.error({ error }, 'Error updating item');
        return internalError("Failed to update error item");
    }
}
