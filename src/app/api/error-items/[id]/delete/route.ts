import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { forbidden, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getCurrentUser } from "@/lib/server-auth";
import { deleteImage, deleteImageByUrl } from "@/lib/image-storage";

const logger = createLogger('api:error-items:delete');

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;
    const user = auth.user;

    try {
        // Verify ownership before deletion
        const errorItem = await prisma.errorItem.findUnique({
            where: { id: id },
            select: { id: true, userId: true, imageStorageKey: true, referenceImageUrl: true, wrongAnswerImageUrl: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to delete this item");
        }

        // Delete the item
        await prisma.errorItem.delete({
            where: { id: id },
        });

        // 清掉落盘图片（失败不影响删除结果）
        deleteImage(errorItem.imageStorageKey);
        deleteImageByUrl(errorItem.referenceImageUrl);
        deleteImageByUrl(errorItem.wrongAnswerImageUrl);

        return NextResponse.json({ message: "Deleted successfully" });
    } catch (error) {
        logger.error({ error }, 'Error deleting item');
        return internalError("Failed to delete error item");
    }
}
