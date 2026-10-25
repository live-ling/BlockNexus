// 服务器地区：值与文案的唯一来源（卡片旗帜 / 编辑弹窗 / 快速添加共用）
import { $, type TranslationKey } from './i18n';

export const REGIONS = ['cn', 'hk', 'tw', 'jp', 'kr', 'sg', 'us', 'de', 'gb', 'other'] as const;
export type Region = (typeof REGIONS)[number];

/** 地区显示名（未知值回退成原值，绝不显示空白） */
export function regionLabel(code?: string): string {
  const v = String(code || '').toLowerCase();
  if (!v) return '';
  const key = `serverRegion.${v}` as TranslationKey;
  const text = $(key);
  return text === key ? v.toUpperCase() : text;
}
