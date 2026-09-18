import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getCurrentUser } from "@/lib/server-auth";
import { deleteUserImages } from "@/lib/image-storage";

const logger = createLogger('api:error-items:clear');

export async function DELETE(req: Request) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;
    const userId = auth.user.id;

    try {
        // Delete all error items for this user
        await prisma.errorItem.deleteMany({
            where: { userId }
        });

        // 一并清理该用户落盘的图片
        deleteUserImages(userId);

        return NextResponse.json({ message: "Error data cleared successfully" });
    } catch (error) {
        logger.error({ error }, 'Error clearing error data');
        return internalError("Failed to clear error data");
    }
}
