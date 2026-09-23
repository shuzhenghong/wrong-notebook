export type { Language, Dict } from './types';

// 同步入口：默认语言中文（en 走 LanguageContext 懒加载，不在此 import，
// 否则会把英文词典重新拖回首屏 bundle）
export { zh as translations } from './zh';
