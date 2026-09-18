import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/server-auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:stats:practice:clear');

export async function DELETE(req: Request) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    const userId = auth.user.id;

    try {
        const result = await prisma.practiceRecord.deleteMany({
            where: { userId },
        });

        return NextResponse.json({
            message: "Practice history cleared successfully",
            count: result.count
        });
    } catch (error) {
        logger.error({ error }, 'Error clearing practice stats');
        return internalError("Failed to clear stats");
    }
}
