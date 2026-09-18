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
 */
import { createLogger } from './logger';
import type { OcrResult, OcrLine } from './ocr';

const logger = createLogger('ocr-local');

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
        ocrPromise = (import('@gutenye/ocr-node') as Promise<{ default: { create(): Promise<OcrInstance> } }>)
            .then((mod) => mod.default.create())
            .catch((error) => {
                // 加载失败允许下一次请求重试，而不是永久卡在失败态
                ocrPromise = null;
                throw error;
            });
    }
    return ocrPromise;
}

/**
 * 用内置引擎识别一张编码图片（JPEG/PNG 等）。
 * 输出与 sidecar 客户端 (lib/ocr.ts) 完全同构的 OcrResult。
 */
export async function recognizeImageLocal(buffer: Buffer): Promise<OcrResult> {
    const ocr = await getOcrInstance();
    const t0 = Date.now();
    const detected = (await ocr.detect(new Uint8Array(buffer))) ?? [];
    logger.debug({ durationMs: Date.now() - t0, lineCount: detected.length }, 'Local engine inference done');

    const lines: OcrLine[] = detected
        .filter((item) => item && typeof item.text === 'string')
        .map((item) => ({
            text: item.text,
            score: typeof item.mean === 'number' ? item.mean : 0,
        }));

    return {
        text: lines.map((l) => l.text).join('\n'),
        lines,
        requestId: null,
    };
}
