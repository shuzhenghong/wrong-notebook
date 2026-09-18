/**
 * 构建后处理：把本地 OCR 的原生依赖与模型文件显式拷入 standalone 产物。
 *
 * 背景：onnxruntime-node（.node/.dll 二进制）、sharp（@img 平台包）与
 * @gutenye/ocr-models（fs 加载的 ONNX 模型）依赖文件追踪来进入
 * .next/standalone，但 Next 16 Turbopack 构建下追踪结果不稳定（动态 import
 * 的原生包可能缺失 bin 或 assets）。此脚本作为确定性兜底，幂等覆盖。
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const standaloneNodeModules = path.join(projectRoot, '.next', 'standalone', 'node_modules');

if (!fs.existsSync(path.join(projectRoot, '.next', 'standalone'))) {
    console.log('[postbuild-ocr] .next/standalone 不存在，跳过（未启用 standalone 输出）');
    process.exit(0);
}

// [源目录, 目标相对目录]；目标为空表示拷贝整个包目录
const targets = [
    ['node_modules/@gutenye', '@gutenye'],
    ['node_modules/onnxruntime-node', 'onnxruntime-node'],
    ['node_modules/onnxruntime-common', 'onnxruntime-common'],
    ['node_modules/sharp', 'sharp'],
    ['node_modules/@img', '@img'],
];

for (const [srcRel, destRel] of targets) {
    const src = path.join(projectRoot, srcRel);
    const dest = path.join(standaloneNodeModules, destRel);
    if (!fs.existsSync(src)) {
        console.warn(`[postbuild-ocr] 源缺失，跳过: ${srcRel}`);
        continue;
    }
    fs.cpSync(src, dest, { recursive: true, force: true });
    console.log(`[postbuild-ocr] copied ${srcRel} -> .next/standalone/node_modules/${destRel}`);
}

// 关键产物自检：缺失时让构建直接失败，避免带病发布
const checks = [
    'onnxruntime-node/bin',
    '@gutenye/ocr-models/assets/ch_PP-OCRv4_det_infer.onnx',
    '@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx',
    '@gutenye/ocr-models/assets/ppocr_keys_v1.txt',
];

const missing = checks.filter((rel) => !fs.existsSync(path.join(standaloneNodeModules, rel)));
if (missing.length > 0) {
    console.error('[postbuild-ocr] standalone 缺少关键文件:', missing.join(', '));
    process.exit(1);
}
console.log('[postbuild-ocr] standalone 本地 OCR 依赖完整');
