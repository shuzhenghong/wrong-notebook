/**
 * 进程内本地 OCR 引擎（@gutenye/ocr-node + onnxruntime-node）
 *
 * 模型：PP-OCRv4 中文（中档）
 *   - 检测 ch_PP-OCRv4_det_infer.onnx
 *   - 方向分类 ch_ppocr_mobile_v2.0_cls_infer.onnx
 *   - 识别 ch_PP-OCRv4_rec_infer.onnx + ppocr_keys_v1.txt 字典
 * 由 @gutenye/ocr-models 随 npm 包分发，Node 进程内直接推理，无需独立 OCR 服务。
 *
 * 注意：onnxruntime-node 必须固定在 1.20.x（1.30.0 在 Windows 上建会话即段错误）。
 * Next.js 需要 serverExternalPackages 包含 '@gutenye/ocr-node' / 'onnxruntime-node' / 'sharp'。
 *
 * 性能措施（不降模型档位）：
 *   1. 检测前预缩放：库内 Detection.run 未设 maxSize（标准 PP-OCR 是限制最长边 960），
 *      大图会按原尺寸推理；先 sharp 缩到最长边 OCR_DET_MAX_SIDE（默认 1280），检测计算量按面积下降。
 *   2. ONNX 会话参数：graphOptimizationLevel=all + 显式 intraOpNumThreads，避免与 Web 服务争核。
 *   3. 启动预热 warmupLocalOcr()：服务启动即后台加载模型并空跑一次，首次用户请求不再付 ~1.5s 冷启动。
 *   4. 结果缓存：相同图片（sha256）5 分钟内直接返回，重复识别零开销。
 */
import { createHash } from 'crypto';
import os from 'os';
import { createLogger } from './logger';
import type { OcrResult, OcrLine } from './ocr';

const logger = createLogger('ocr-local');

/** 检测前输入图最长边上限（px）。仅缩小、不放大。0 = 关闭预缩放。 */
const DET_MAX_SIDE = (() => {
    const n = Number(process.env.OCR_DET_MAX_SIDE);
    return Number.isFinite(n) && n >= 320 ? Math.floor(n) : 1280;
})();

/** 结果缓存：容量与 TTL */
const CACHE_MAX = 50;
const CACHE_TTL_MS = 5 * 60 * 1000;
const resultCache = new Map<string, { expires: number; result: OcrResult }>();

/** @gutenye/ocr-common 的识别结果行 */
interface DetectLine {
    text: string;
    mean: number;
    box?: number[][];
}

interface OcrInstance {
    // 库的类型签名只声明了 string 路径，但底层 sharp 支持原始像素/Buffer（已实测）
    detect(image: unknown): Promise<DetectLine[]>;
}

// 引擎单例：首次调用加载三套 ONNX 模型（约 1s），之后常驻复用
let ocrPromise: Promise<OcrInstance> | null = null;

function getOcrInstance(): Promise<OcrInstance> {
    if (!ocrPromise) {
        const onnxOptions = {
            graphOptimizationLevel: 'all' as const,
            // 显式限制线程数：默认会用满所有物理核，与 Next.js 服务争抢；4 核内取实际核数
            intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length)),
        };
        ocrPromise = (import('@gutenye/ocr-node') as Promise<{ default: { create(options?: unknown): Promise<OcrInstance> } }>)
            .then((mod) => mod.default.create({ onnxOptions }))
            .catch((error) => {
                // 加载失败允许下一次请求重试，而不是永久卡在失败态
                ocrPromise = null;
                throw error;
            });
    }
    return ocrPromise;
}

/**
 * 预缩放输入图（仅当超过最长边上限时）。解码失败等任何异常都回退原始字节，
 * 保证无效/罕见格式图片不会因预缩放而失败。
 */
async function downscaleIfNeeded(buffer: Buffer): Promise<Buffer> {
    if (DET_MAX_SIDE <= 0) return buffer;
    try {
        const sharp = (await import('sharp')).default;
        const metadata = await sharp(buffer).metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        const maxSide = Math.max(width, height);
        if (maxSide <= DET_MAX_SIDE) return buffer;
        const scale = DET_MAX_SIDE / maxSide;
        const resized = await sharp(buffer)
            .resize(Math.round(width * scale), Math.round(height * scale))
            .jpeg({ quality: 90 })
            .toBuffer();
        logger.debug({ originalSide: maxSide, scaledSide: DET_MAX_SIDE }, 'OCR input downscaled');
        return resized;
    } catch (error) {
        logger.debug({ error }, 'OCR downscale skipped, using original bytes');
        return buffer;
    }
}

function cacheGet(key: string): OcrResult | null {
    const hit = resultCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
        resultCache.delete(key);
        return null;
    }
    // LRU 触碰：删除后重新插入，保持插入序
    resultCache.delete(key);
    resultCache.set(key, hit);
    return hit.result;
}

function cacheSet(key: string, result: OcrResult): void {
    resultCache.set(key, { expires: Date.now() + CACHE_TTL_MS, result });
    while (resultCache.size > CACHE_MAX) {
        const oldest = resultCache.keys().next().value;
        if (oldest === undefined) break;
        resultCache.delete(oldest);
    }
}

/**
 * 用内置引擎识别一张编码图片（JPEG/PNG 等）。
 * 输出与 sidecar 客户端 (lib/ocr.ts) 完全同构的 OcrResult。
 */
export async function recognizeImageLocal(buffer: Buffer): Promise<OcrResult> {
    const cacheKey = createHash('sha256').update(buffer).digest('hex');
    const cached = cacheGet(cacheKey);
    if (cached) {
        logger.debug('Local engine cache hit');
        return cached;
    }

    const ocr = await getOcrInstance();
    const input = await downscaleIfNeeded(buffer);
    const t0 = Date.now();
    const detected = (await ocr.detect(new Uint8Array(input))) ?? [];
    logger.debug({ durationMs: Date.now() - t0, lineCount: detected.length, downscaled: input !== buffer }, 'Local engine inference done');

    const lines: OcrLine[] = detected
        .filter((item) => item && typeof item.text === 'string')
        .map((item) => ({
            text: item.text,
            score: typeof item.mean === 'number' ? item.mean : 0,
        }));

    const result: OcrResult = {
        text: lines.map((l) => l.text).join('\n'),
        lines,
        requestId: null,
    };
    cacheSet(cacheKey, result);
    return result;
}

/**
 * 启动预热：后台加载模型并用 64x64 空白图空跑一次完整流水线，
 * 让首次真实请求直接命中热路径（省去 ~1s 模型加载 + 首次推理的运行时初始化）。
 * 失败静默——预热只是优化，不能影响服务启动。
 */
export async function warmupLocalOcr(): Promise<void> {
    try {
        const sharp = (await import('sharp')).default;
        const blank = await sharp({
            create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
        })
            .jpeg()
            .toBuffer();
        const t0 = Date.now();
        await recognizeImageLocal(blank);
        logger.info({ durationMs: Date.now() - t0 }, 'Local OCR engine warmed up');
    } catch (error) {
        logger.warn({ error }, 'Local OCR warmup failed (will retry on first request)');
    }
}
