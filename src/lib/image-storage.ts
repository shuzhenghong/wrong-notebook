/**
 * 错题图片落盘存储
 *
 * 背景：图片原本以 base64 直接写进 SQLite 的 ErrorItem.originalImageUrl，
 * 导致数据库体积随题目数量线性膨胀，列表接口也会把整张图片一起返回。
 * 现在新图片统一落盘，数据库只存相对路径；历史 base64 数据仍可正常渲染（只读兼容）。
 */
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const logger = createLogger('image-storage');

/** 图片存储根目录：优先环境变量，其次跟随 SQLite 数据目录，最后回落到 <cwd>/data/images */
function getImagesRoot(): string {
    if (process.env.IMAGE_STORAGE_DIR) return process.env.IMAGE_STORAGE_DIR;

    const databaseUrl = process.env.DATABASE_URL || '';
    if (databaseUrl.startsWith('file:')) {
        const dbPath = databaseUrl.replace(/^file:/, '');
        const resolved = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
        return path.join(path.dirname(resolved), 'images');
    }

    return path.join(process.cwd(), 'data', 'images');
}

export function isInlineImage(value: string | null | undefined): boolean {
    if (!value) return false;
    return value.startsWith('data:') || /^[A-Za-z0-9+/=]{200,}$/.test(value);
}

/** 从 data URL / 裸 base64 中拆出 mime 与二进制。 */
function decodeImage(input: string): { buffer: Buffer; mimeType: string } | null {
    const dataUrlMatch = input.match(/^data:([^;,]+)?(;[^,]*)?,/);
    if (dataUrlMatch) {
        const mimeType = dataUrlMatch[1] || 'image/jpeg';
        const payload = input.slice(dataUrlMatch[0].length);
        if (!dataUrlMatch[0].includes(';base64')) return null;
        return { buffer: Buffer.from(payload, 'base64'), mimeType };
    }

    if (/^[A-Za-z0-9+/=\s]+$/.test(input)) {
        return { buffer: Buffer.from(input, 'base64'), mimeType: 'image/jpeg' };
    }

    return null;
}

function extensionFor(mimeType: string): string {
    const map: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/bmp': 'bmp',
    };
    return map[mimeType.toLowerCase()] || 'img';
}

export interface StoredImage {
    storageKey: string;
    url: string;
    mimeType: string;
    bytes: number;
}

/**
 * 把图片写入磁盘。存储键形如 `<userId>/<errorItemId>.jpg`，
 * 便于图片接口按 userId 做归属校验。
 */
export function storeImage(userId: string, errorItemId: string, input: string): StoredImage | null {
    const decoded = decodeImage(input);
    if (!decoded || decoded.buffer.length === 0) return null;

    const storageKey = `${userId}/${errorItemId}.${extensionFor(decoded.mimeType)}`;
    const target = path.join(getImagesRoot(), storageKey);

    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, decoded.buffer);
        return {
            storageKey,
            url: `/api/images/${storageKey}`,
            mimeType: decoded.mimeType,
            bytes: decoded.buffer.length,
        };
    } catch (error) {
        logger.error({ error, storageKey }, 'Failed to store image on disk');
        return null;
    }
}

/** 删除磁盘上的图片（错题删除时调用，失败不影响主流程）。 */
export function deleteImage(storageKey: string | null | undefined): void {
    if (!storageKey) return;
    try {
        const target = path.join(getImagesRoot(), storageKey);
        fs.rmSync(target, { force: true });
    } catch (error) {
        logger.warn({ error, storageKey }, 'Failed to delete image file');
    }
}

/** 删除某个用户的全部落盘图片（清空错题本、删除账号时使用）。 */
export function deleteUserImages(userId: string): void {
    if (!userId || userId.includes('..') || userId.includes('/') || userId.includes('\\')) return;
    try {
        fs.rmSync(path.join(getImagesRoot(), userId), { recursive: true, force: true });
    } catch (error) {
        logger.warn({ error, userId }, 'Failed to delete user image directory');
    }
}

/**
 * 读取落盘图片。storageKey 只接受来自数据库的相对路径，且不允许向上穿越。
 */
export function readImage(storageKey: string): { buffer: Buffer; mimeType: string } | null {
    if (storageKey.includes('..') || storageKey.startsWith('/') || storageKey.includes('\\')) {
        return null;
    }

    const target = path.join(getImagesRoot(), storageKey);
    try {
        const buffer = fs.readFileSync(target);
        const ext = path.extname(target).toLowerCase();
        const mimeType = ext === '.png'
            ? 'image/png'
            : ext === '.webp'
                ? 'image/webp'
                : ext === '.gif'
                    ? 'image/gif'
                    : 'image/jpeg';
        return { buffer, mimeType };
    } catch {
        return null;
    }
}
