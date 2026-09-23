import type { en } from './en';

// 以英文词典为基准类型，中文词典必须满足同一结构（编译期校验形状一致）
export type Dict = typeof en;

export type Language = 'zh' | 'en';
