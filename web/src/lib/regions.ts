// 服务器地区：值与文案的唯一来源（卡片旗帜 / 编辑弹窗共用）
//
// 地区由面板按 host 经 ipwho.is 自动推断（panel/geo.js），存的是**两位 ISO 国家码**
// （小写，如 cn / jp / us）。KNOWN_REGIONS 只是「面板内置旗帜 SVG + 中文名」的集合；
// 推断出的其他国家同样有效：名字回退成大写国家码，旗帜回退成地球图标。
import { $, type TranslationKey } from './i18n';

/** 内置了旗帜与译名的地区（推断结果不在其中也合法，只是没有专属旗帜图） */
export const KNOWN_REGIONS = ['cn', 'hk', 'tw', 'jp', 'kr', 'sg', 'us', 'de', 'gb', 'other'] as const;

/** 值合法性：两位 ISO 国家码或 'other'（ipwho.is 只回两位码；'other' 兼容旧手动数据） */
export function isValidRegion(code?: string): boolean {
  const v = String(code || '').toLowerCase();
  return /^[a-z]{2}$/.test(v) || v === 'other';
}

/** 地区显示名（未知国家码回退成大写码本身，绝不显示空白） */
export function regionLabel(code?: string): string {
  const v = String(code || '').toLowerCase();
  if (!v) return '';
  const key = `serverRegion.${v}` as TranslationKey;
  const text = $(key);
  return text === key ? v.toUpperCase() : text;
}
