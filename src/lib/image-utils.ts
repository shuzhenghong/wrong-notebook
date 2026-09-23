/**
 * 图片处理 —— 面向"传给多模态模型"的场景优化。
 *
 * 成本要点: 多模态模型按图片像素切块计费（token 数随分辨率线性增长）。
 * 之前只在文件 > 1MB 时才压缩，结果一张 900KB 的 4000px 手机照片会原样上传，
 * 分辨率带来的 token 成本远高于文件体积本身。现在改为**按宽度无条件降采样**：
 * 只要宽度超过上限就重绘，与文件大小无关。
 *
 * 1600px 是保守取值：试卷题目通常是 A4 幅面文本，1600px 宽足以让模型看清
 * 公式与手写，再往上加分辨率对识别准确率几乎没有增益，却成倍增加 token。
 */

/** 传给模型的图片宽度上限（px） */
export const AI_IMAGE_MAX_WIDTH = 1600;
/** 超过该体积则继续降低 JPEG 质量 */
export const AI_IMAGE_MAX_MB = 1;

/**
 * 压缩图片文件
 * @param file 原始图片文件
 * @param maxSizeMB 最大文件大小（MB），默认 1MB
 * @param maxWidth 最大宽度，默认 1600px
 * @param quality 压缩质量 0-1，默认 0.8
 * @returns 压缩后的 Base64 字符串
 */
export async function compressImage(
    file: File,
    maxSizeMB: number = AI_IMAGE_MAX_MB,
    maxWidth: number = AI_IMAGE_MAX_WIDTH,
    quality: number = 0.8
): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                if (!ctx) {
                    reject(new Error('无法获取 Canvas 上下文'));
                    return;
                }

                // 计算新的尺寸（保持宽高比）
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;

                // 绘制图片
                ctx.drawImage(img, 0, 0, width, height);

                // 转换为 Base64，逐步降低质量直到满足大小要求
                let currentQuality = quality;
                let compressed = canvas.toDataURL('image/jpeg', currentQuality);

                // 检查大小（Base64 字符串长度约等于文件大小的 4/3）
                const sizeInMB = (compressed.length * 3) / 4 / 1024 / 1024;

                // 如果还是太大，继续降低质量
                while (sizeInMB > maxSizeMB && currentQuality > 0.1) {
                    currentQuality -= 0.1;
                    compressed = canvas.toDataURL('image/jpeg', currentQuality);
                    const newSize = (compressed.length * 3) / 4 / 1024 / 1024;

                    console.log(`压缩质量: ${currentQuality.toFixed(1)}, 大小: ${newSize.toFixed(2)}MB`);

                    if (newSize <= maxSizeMB) break;
                }

                console.log(
                    `原始: ${img.width}x${img.height} ${(file.size / 1024 / 1024).toFixed(2)}MB` +
                    ` → 输出: ${width}x${height} ${((compressed.length * 3) / 4 / 1024 / 1024).toFixed(2)}MB`
                );

                resolve(compressed);
            };

            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = e.target?.result as string;
        };

        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
    });
}

/** 读取文件为 data URL */
function readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/** 读取图片的原始像素尺寸 */
function getImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.width, height: img.height });
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = dataUrl;
    });
}

/**
 * data URL → Blob（用于 multipart 上传：
 * 图片以二进制随 FormData 发送，体积比 base64 JSON 省 ~33%）
 */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
    const res = await fetch(dataUrl);
    return await res.blob();
}

/**
 * 检查并压缩图片（如果需要）
 *
 * 触发条件（任一满足即重绘）:
 *   - 宽度超过 AI_IMAGE_MAX_WIDTH（降分辨率 = 直接省 token）
 *   - 文件超过 1MB（降质量 = 省带宽）
 * 都不满足时原样返回，避免无谓的 canvas 重绘带来的画质损失。
 *
 * @param file 图片文件
 * @returns Base64 字符串
 */
export async function processImageFile(file: File): Promise<string> {
    const fileSizeMB = file.size / 1024 / 1024;
    const dataUrl = await readAsDataURL(file);

    let tooWide = false;
    try {
        const { width } = await getImageSize(dataUrl);
        tooWide = width > AI_IMAGE_MAX_WIDTH;
    } catch {
        // 尺寸读不出来（异常格式）就走压缩分支兜底
        tooWide = fileSizeMB > AI_IMAGE_MAX_MB;
    }

    if (tooWide || fileSizeMB > AI_IMAGE_MAX_MB) {
        console.log(`需要压缩（宽度超限: ${tooWide}, 体积 ${fileSizeMB.toFixed(2)}MB）`);
        return await compressImage(file, AI_IMAGE_MAX_MB, AI_IMAGE_MAX_WIDTH);
    }

    console.log(`尺寸与体积均在阈值内（${fileSizeMB.toFixed(2)}MB），原样上传`);
    return dataUrl;
}
