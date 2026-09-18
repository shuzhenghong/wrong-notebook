import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/server-auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:practice:record');

export async function POST(req: Request) {
    const auth = await getCurrentUser();
    if (!auth.ok) return auth.response;

    try {
        const { subject, difficulty, isCorrect } = await req.json();

        if (!subject || typeof isCorrect !== 'boolean') {
            return badRequest("subject and isCorrect are required");
        }

        const record = await prisma.practiceRecord.create({
            data: {
                userId: auth.user.id,
                subject,
                difficulty,
                isCorrect,
            },
        });

        return NextResponse.json(record);
    } catch (error) {
        logger.error({ error }, 'Error saving practice record');
        return internalError("Failed to save record");
    }
}
