// server.properties 键的中文映射（用于可视化配置）
// type: text 文本 / textarea 长文本 / number 数值 / bool 开关 / select 下拉

import type { TranslationKey } from '@/lib/i18n';

export type PropType = 'text' | 'textarea' | 'number' | 'bool' | 'select';

/** 组键（组名文案见 property.group.*，由消费方在渲染期取词） */
export const PROP_GROUPS = ['basic', 'gameplay', 'world', 'performance', 'network', 'other'] as const;

export type PropGroup = (typeof PROP_GROUPS)[number];

/**
 * ⚠ 这里存的是 i18n 键（property.<键>.label / .hint / .option.<值>），不是文案；
 * 取词必须在渲染期调用 $() —— setLanguage() 不刷新页面，模块顶层的 $()
 * 会把那一刻的语言永久固化。
 */
export interface PropDef {
  labelKey: TranslationKey;
  type: PropType;
  /** 组键（PROP_GROUPS 之一），组名用 $('property.group.<组键>') 取词 */
  group: PropGroup;
  options?: string[];
  /** select 选项的 i18n 键（property.<键>.option.<值>），取词在渲染期 */
  optionLabelKeys?: Record<string, TranslationKey>;
  min?: number;
  max?: number;
  hintKey?: TranslationKey;
}

export const PROP_DEFS: Record<string, PropDef> = {
  // ---- 基础 ----
  motd: { labelKey: 'property.motd.label', type: 'text', group: 'basic', hintKey: 'property.motd.hint' },
  'server-port': { labelKey: 'property.server-port.label', type: 'number', group: 'basic', min: 1024, max: 65535, hintKey: 'property.server-port.hint' },
  'server-ip': { labelKey: 'property.server-ip.label', type: 'text', group: 'basic', hintKey: 'property.server-ip.hint' },
  'max-players': { labelKey: 'property.max-players.label', type: 'number', group: 'basic', min: 1, max: 1000 },
  'online-mode': { labelKey: 'property.online-mode.label', type: 'bool', group: 'basic', hintKey: 'property.online-mode.hint' },
  'white-list': { labelKey: 'property.white-list.label', type: 'bool', group: 'basic' },
  'enforce-whitelist': { labelKey: 'property.enforce-whitelist.label', type: 'bool', group: 'basic' },
  'enforce-secure-profile': {
    labelKey: 'property.enforce-secure-profile.label',
    type: 'bool',
    group: 'basic',
    hintKey: 'property.enforce-secure-profile.hint',
  },
  'enable-status': { labelKey: 'property.enable-status.label', type: 'bool', group: 'basic' },
  'hide-online-players': { labelKey: 'property.hide-online-players.label', type: 'bool', group: 'basic' },
  difficulty: {
    labelKey: 'property.difficulty.label',
    type: 'select',
    group: 'basic',
    options: ['peaceful', 'easy', 'normal', 'hard'],
    optionLabelKeys: {
      peaceful: 'property.difficulty.option.peaceful',
      easy: 'property.difficulty.option.easy',
      normal: 'property.difficulty.option.normal',
      hard: 'property.difficulty.option.hard',
    },
  },

  // ---- 玩法 ----
  gamemode: {
    labelKey: 'property.gamemode.label',
    type: 'select',
    group: 'gameplay',
    options: ['survival', 'creative', 'adventure', 'spectator'],
    optionLabelKeys: {
      survival: 'property.gamemode.option.survival',
      creative: 'property.gamemode.option.creative',
      adventure: 'property.gamemode.option.adventure',
      spectator: 'property.gamemode.option.spectator',
    },
  },
  'force-gamemode': { labelKey: 'property.force-gamemode.label', type: 'bool', group: 'gameplay' },
  hardcore: { labelKey: 'property.hardcore.label', type: 'bool', group: 'gameplay', hintKey: 'property.hardcore.hint' },
  pvp: { labelKey: 'property.pvp.label', type: 'bool', group: 'gameplay' },
  'allow-flight': { labelKey: 'property.allow-flight.label', type: 'bool', group: 'gameplay' },
  'spawn-protection': { labelKey: 'property.spawn-protection.label', type: 'number', group: 'gameplay', min: 0, max: 1000 },
  'player-idle-timeout': { labelKey: 'property.player-idle-timeout.label', type: 'number', group: 'gameplay', min: 0, max: 1440, hintKey: 'property.player-idle-timeout.hint' },
  'enable-command-block': { labelKey: 'property.enable-command-block.label', type: 'bool', group: 'gameplay' },
  'op-permission-level': { labelKey: 'property.op-permission-level.label', type: 'number', group: 'gameplay', min: 1, max: 4 },
  'function-permission-level': { labelKey: 'property.function-permission-level.label', type: 'number', group: 'gameplay', min: 1, max: 4 },
  'resource-pack': { labelKey: 'property.resource-pack.label', type: 'text', group: 'gameplay' },
  'resource-pack-id': { labelKey: 'property.resource-pack-id.label', type: 'text', group: 'gameplay', hintKey: 'property.resource-pack-id.hint' },
  'resource-pack-sha1': {
    labelKey: 'property.resource-pack-sha1.label',
    type: 'text',
    group: 'gameplay',
    hintKey: 'property.resource-pack-sha1.hint',
  },
  'resource-pack-prompt': {
    labelKey: 'property.resource-pack-prompt.label',
    type: 'text',
    group: 'gameplay',
    hintKey: 'property.resource-pack-prompt.hint',
  },
  'require-resource-pack': { labelKey: 'property.require-resource-pack.label', type: 'bool', group: 'gameplay' },

  // ---- 世界 ----
  'level-name': { labelKey: 'property.level-name.label', type: 'text', group: 'world', hintKey: 'property.level-name.hint' },
  'level-seed': { labelKey: 'property.level-seed.label', type: 'text', group: 'world' },
  'level-type': {
    labelKey: 'property.level-type.label',
    type: 'select',
    group: 'world',
    options: [
      'minecraft:normal',
      'minecraft:flat',
      'minecraft:large_biomes',
      'minecraft:amplified',
      'minecraft:single_biome_surface',
    ],
    optionLabelKeys: {
      'minecraft:normal': 'property.level-type.option.minecraft:normal',
      'minecraft:flat': 'property.level-type.option.minecraft:flat',
      'minecraft:large_biomes': 'property.level-type.option.minecraft:large_biomes',
      'minecraft:amplified': 'property.level-type.option.minecraft:amplified',
      'minecraft:single_biome_surface': 'property.level-type.option.minecraft:single_biome_surface',
    },
  },
  'generator-settings': {
    labelKey: 'property.generator-settings.label',
    type: 'textarea',
    group: 'world',
    hintKey: 'property.generator-settings.hint',
  },
  'generate-structures': { labelKey: 'property.generate-structures.label', type: 'bool', group: 'world' },
  'spawn-monsters': { labelKey: 'property.spawn-monsters.label', type: 'bool', group: 'world' },
  'spawn-animals': { labelKey: 'property.spawn-animals.label', type: 'bool', group: 'world' },
  'spawn-npcs': { labelKey: 'property.spawn-npcs.label', type: 'bool', group: 'world' },
  'allow-nether': { labelKey: 'property.allow-nether.label', type: 'bool', group: 'world' },
  'max-world-size': { labelKey: 'property.max-world-size.label', type: 'number', group: 'world', min: 1, max: 29999984 },

  // ---- 性能 ----
  'view-distance': { labelKey: 'property.view-distance.label', type: 'number', group: 'performance', min: 3, max: 32, hintKey: 'property.view-distance.hint' },
  'simulation-distance': { labelKey: 'property.simulation-distance.label', type: 'number', group: 'performance', min: 3, max: 32 },
  'max-tick-time': { labelKey: 'property.max-tick-time.label', type: 'number', group: 'performance', hintKey: 'property.max-tick-time.hint' },
  'entity-broadcast-range-percentage': { labelKey: 'property.entity-broadcast-range-percentage.label', type: 'number', group: 'performance', min: 10, max: 1000 },
  'pause-when-empty-seconds': { labelKey: 'property.pause-when-empty-seconds.label', type: 'number', group: 'performance', min: 0, max: 3600, hintKey: 'property.pause-when-empty-seconds.hint' },
  'sync-chunk-writes': { labelKey: 'property.sync-chunk-writes.label', type: 'bool', group: 'performance' },
  'use-native-transport': { labelKey: 'property.use-native-transport.label', type: 'bool', group: 'performance' },
  'region-file-compression': {
    labelKey: 'property.region-file-compression.label',
    type: 'select',
    group: 'performance',
    options: ['deflate', 'lz4', 'none'],
    optionLabelKeys: {
      deflate: 'property.region-file-compression.option.deflate',
      lz4: 'property.region-file-compression.option.lz4',
      none: 'property.region-file-compression.option.none',
    },
    hintKey: 'property.region-file-compression.hint',
  },
  'enable-jmx-monitoring': {
    labelKey: 'property.enable-jmx-monitoring.label',
    type: 'bool',
    group: 'performance',
    hintKey: 'property.enable-jmx-monitoring.hint',
  },

  // ---- 网络 ----
  'network-compression-threshold': { labelKey: 'property.network-compression-threshold.label', type: 'number', group: 'network', hintKey: 'property.network-compression-threshold.hint' },
  'rate-limit': { labelKey: 'property.rate-limit.label', type: 'number', group: 'network', min: 0 },
  'prevent-proxy-connections': { labelKey: 'property.prevent-proxy-connections.label', type: 'bool', group: 'network' },
  'enable-rcon': { labelKey: 'property.enable-rcon.label', type: 'bool', group: 'network' },
  'rcon.port': { labelKey: 'property.rcon.port.label', type: 'number', group: 'network', min: 1024, max: 65535 },
  'rcon.password': { labelKey: 'property.rcon.password.label', type: 'text', group: 'network' },
  'enable-query': { labelKey: 'property.enable-query.label', type: 'bool', group: 'network' },
  'query.port': { labelKey: 'property.query.port.label', type: 'number', group: 'network', min: 1024, max: 65535 },
  'accepts-transfers': {
    labelKey: 'property.accepts-transfers.label',
    type: 'bool',
    group: 'network',
    hintKey: 'property.accepts-transfers.hint',
  },

  // ---- 其他 ----
  'max-chained-neighbor-updates': { labelKey: 'property.max-chained-neighbor-updates.label', type: 'number', group: 'other' },
  'log-ips': { labelKey: 'property.log-ips.label', type: 'bool', group: 'other' },
  'text-filtering-config': { labelKey: 'property.text-filtering-config.label', type: 'text', group: 'other' },
  'initial-enabled-packs': { labelKey: 'property.initial-enabled-packs.label', type: 'text', group: 'other' },
  'initial-disabled-packs': { labelKey: 'property.initial-disabled-packs.label', type: 'text', group: 'other' },
  'bug-report-link': {
    labelKey: 'property.bug-report-link.label',
    type: 'text',
    group: 'other',
    hintKey: 'property.bug-report-link.hint',
  },
  'broadcast-console-to-ops': { labelKey: 'property.broadcast-console-to-ops.label', type: 'bool', group: 'other' },
  'broadcast-rcon-to-ops': { labelKey: 'property.broadcast-rcon-to-ops.label', type: 'bool', group: 'other' },
};

export const BOOL_OPTIONS = ['true', 'false'];

/** 值中被转义的冒号还原：MC 会写出 level-type=minecraft\:normal */
export function unescapeValue(v: string): string {
  return v.replace(/\\([:=])/g, '$1');
}

/** 回写时若原值用了转义冒号，新值里的冒号也一并转义，避免 Vanilla 读错 */
export function escapeValue(v: string, original: string): string {
  if (!v.includes(':') || v.includes('\\:')) return v;
  return /\\:/.test(original) ? v.replace(/:/g, '\\:') : v;
}

/** 单项：注释 / 空行 / 键值对（保留原始顺序用于回写） */
export type PropItem =
  | { kind: 'raw'; text: string }
  | { kind: 'pair'; key: string; value: string };

/** 解析 server.properties（保留注释与空行） */
export function parseProperties(content: string): { items: PropItem[]; eol: string } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const items: PropItem[] = content.split(/\r?\n/).map((line) => {
    // 等号右侧的空白必须用**惰性**量词：贪婪的 [ \t]* 会把值的前导空格也吃掉，
    // 与「无损回写」的承诺冲突（写回后值被悄悄 trim 了一侧）。
    // 也不能用 \s*：它连换行都匹配，脱离 split 场景时会越界。
    const m = /^\s*([A-Za-z0-9_.\-]+)[ \t]*=[ \t]*?(.*)$/.exec(line);
    if (m && !line.trim().startsWith('#')) return { kind: 'pair', key: m[1], value: m[2] };
    return { kind: 'raw', text: line };
  });
  return { items, eol };
}

/** 回写：仅更新值，注释/顺序/未知键原样保留；键不存在时追加到末尾 */
export function serializeProperties(
  items: PropItem[],
  values: Record<string, string>,
  eol: string,
): string {
  const seen = new Set<string>();
  const lines = items.map((it) => {
    if (it.kind === 'raw') return it.text;
    seen.add(it.key);
    const v = values[it.key];
    return `${it.key}=${v === undefined ? it.value : v}`;
  });
  // 追加新增的键（不覆盖已存在的）
  for (const [k, v] of Object.entries(values)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  // 去掉尾部多余空行再补一个换行
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join(eol) + eol;
}
