/**
 * 前端 AI 模块的对外出口。
 *
 * AI 的实际调用已全部下沉到 Python 后端（/api/analyze、/api/ai/*），
 * 前端不再持有 openai / @google/genai 客户端。这里只保留与后端共享的契约部分：
 *   - types.ts    ParsedQuestion 等结构化题型定义（组件/页面渲染要用）
 *   - prompts.ts  默认提示词模板常量（设置页展示与重置要用）
 *   - schema.ts   ParsedQuestion 的 zod 校验（收到后端结果后做防御式解析）
 *
 * 原先的 provider（openai/gemini/azure）与 failover 实现已删除：
 * 迁移后无人引用，且会把上百 MB 的 SDK 依赖带进前端镜像。
 */
export * from "./types";
export * from "./prompts";
export * from "./schema";
