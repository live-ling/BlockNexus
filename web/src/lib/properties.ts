// server.properties 键的中文映射（用于可视化配置）
// type: text 文本 / textarea 长文本 / number 数值 / bool 开关 / select 下拉

export type PropType = 'text' | 'textarea' | 'number' | 'bool' | 'select';

export interface PropDef {
  label: string;
  type: PropType;
  group: string;
  options?: string[];
  /** select 选项的中文说明 */
  optionLabels?: Record<string, string>;
  min?: number;
  max?: number;
  hint?: string;
}

export const PROP_GROUPS = ['基础', '玩法', '世界', '性能', '网络', '其他'] as const;

export const PROP_DEFS: Record<string, PropDef> = {
  // ---- 基础 ----
  motd: { label: '服务器描述 (MOTD)', type: 'text', group: '基础', hint: '多人游戏列表里显示的服务器名' },
  'server-port': { label: '服务器端口', type: 'number', group: '基础', min: 1024, max: 65535, hint: '改动会同步到面板的连接地址' },
  'server-ip': { label: '监听地址', type: 'text', group: '基础', hint: '留空表示监听所有网卡' },
  'max-players': { label: '最大玩家数', type: 'number', group: '基础', min: 1, max: 1000 },
  'online-mode': { label: '正版验证', type: 'bool', group: '基础', hint: '关闭后未登录账号也能进入（离线服）' },
  'white-list': { label: '启用白名单', type: 'bool', group: '基础' },
  'enforce-whitelist': { label: '白名单强制踢出', type: 'bool', group: '基础' },
  'enforce-secure-profile': {
    label: '强制安全档案',
    type: 'bool',
    group: '基础',
    hint: '要求客户端具备可验证的聊天签名（关闭后允许未验证签名的玩家进入）',
  },
  'enable-status': { label: '响应服务器列表查询', type: 'bool', group: '基础' },
  'hide-online-players': { label: '隐藏在线玩家名单', type: 'bool', group: '基础' },
  difficulty: {
    label: '游戏难度',
    type: 'select',
    group: '基础',
    options: ['peaceful', 'easy', 'normal', 'hard'],
    optionLabels: { peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' },
  },

  // ---- 玩法 ----
  gamemode: {
    label: '默认游戏模式',
    type: 'select',
    group: '玩法',
    options: ['survival', 'creative', 'adventure', 'spectator'],
    optionLabels: { survival: '生存', creative: '创造', adventure: '冒险', spectator: '旁观' },
  },
  'force-gamemode': { label: '强制使用默认模式', type: 'bool', group: '玩法' },
  hardcore: { label: '极限模式', type: 'bool', group: '玩法', hint: '死亡后自动变为旁观者' },
  pvp: { label: '允许玩家互相伤害', type: 'bool', group: '玩法' },
  'allow-flight': { label: '允许飞行', type: 'bool', group: '玩法' },
  'spawn-protection': { label: '出生点保护半径', type: 'number', group: '玩法', min: 0, max: 1000 },
  'player-idle-timeout': { label: '挂机踢出（分钟）', type: 'number', group: '玩法', min: 0, max: 1440, hint: '0 表示不踢' },
  'enable-command-block': { label: '启用命令方块', type: 'bool', group: '玩法' },
  'op-permission-level': { label: 'OP 权限等级', type: 'number', group: '玩法', min: 1, max: 4 },
  'function-permission-level': { label: '函数权限等级', type: 'number', group: '玩法', min: 1, max: 4 },
  'resource-pack': { label: '资源包地址', type: 'text', group: '玩法' },
  'resource-pack-id': { label: '资源包 UUID', type: 'text', group: '玩法', hint: '服务端提供资源包时由 Vanilla 自动生成，通常留空' },
  'resource-pack-sha1': {
    label: '资源包 SHA-1',
    type: 'text',
    group: '玩法',
    hint: '用于校验下载到的资源包，留空表示不校验',
  },
  'resource-pack-prompt': {
    label: '资源包提示语',
    type: 'text',
    group: '玩法',
    hint: '客户端确认界面上显示的自定义文字',
  },
  'require-resource-pack': { label: '强制使用资源包', type: 'bool', group: '玩法' },

  // ---- 世界 ----
  'level-name': { label: '世界存档目录', type: 'text', group: '世界', hint: '改动会生成/读取另一个世界' },
  'level-seed': { label: '世界种子', type: 'text', group: '世界' },
  'level-type': {
    label: '世界类型',
    type: 'select',
    group: '世界',
    options: [
      'minecraft:normal',
      'minecraft:flat',
      'minecraft:large_biomes',
      'minecraft:amplified',
      'minecraft:single_biome_surface',
    ],
    optionLabels: {
      'minecraft:normal': '默认',
      'minecraft:flat': '超平坦',
      'minecraft:large_biomes': '巨型生物群系',
      'minecraft:amplified': '放大化',
      'minecraft:single_biome_surface': '单一生物群系',
    },
  },
  'generator-settings': {
    label: '超平坦/自定义世界参数',
    type: 'textarea',
    group: '世界',
    hint: 'JSON 格式，仅在世界类型为超平坦或单一生物群系时生效；默认 {}',
  },
  'generate-structures': { label: '生成结构（村庄等）', type: 'bool', group: '世界' },
  'spawn-monsters': { label: '生成怪物', type: 'bool', group: '世界' },
  'spawn-animals': { label: '生成动物', type: 'bool', group: '世界' },
  'spawn-npcs': { label: '生成村民', type: 'bool', group: '世界' },
  'allow-nether': { label: '允许下界', type: 'bool', group: '世界' },
  'max-world-size': { label: '世界边界半径', type: 'number', group: '世界', min: 1, max: 29999984 },

  // ---- 性能 ----
  'view-distance': { label: '视距（区块）', type: 'number', group: '性能', min: 3, max: 32, hint: '越大越吃带宽与服务端性能' },
  'simulation-distance': { label: '模拟距离（区块）', type: 'number', group: '性能', min: 3, max: 32 },
  'max-tick-time': { label: '单 tick 超时（毫秒）', type: 'number', group: '性能', hint: '-1 表示不因超时崩溃' },
  'entity-broadcast-range-percentage': { label: '实体广播范围（%）', type: 'number', group: '性能', min: 10, max: 1000 },
  'pause-when-empty-seconds': { label: '空服暂停（秒）', type: 'number', group: '性能', min: 0, max: 3600, hint: '0 表示不暂停' },
  'sync-chunk-writes': { label: '同步写入区块', type: 'bool', group: '性能' },
  'use-native-transport': { label: '使用原生传输优化', type: 'bool', group: '性能' },
  'region-file-compression': {
    label: '区域文件压缩算法',
    type: 'select',
    group: '性能',
    options: ['deflate', 'lz4', 'none'],
    optionLabels: { deflate: 'deflate（默认，压缩率高）', lz4: 'lz4（读写更快）', none: 'none（不压缩）' },
    hint: '仅 1.20.2+ 支持',
  },
  'enable-jmx-monitoring': {
    label: '启用 JMX 监控',
    type: 'bool',
    group: '性能',
    hint: '允许外部用 JConsole 采样 JVM',
  },

  // ---- 网络 ----
  'network-compression-threshold': { label: '网络压缩阈值（字节）', type: 'number', group: '网络', hint: '-1 关闭压缩' },
  'rate-limit': { label: '限速（包/秒）', type: 'number', group: '网络', min: 0 },
  'prevent-proxy-connections': { label: '阻止代理连接', type: 'bool', group: '网络' },
  'enable-rcon': { label: '启用 RCON', type: 'bool', group: '网络' },
  'rcon.port': { label: 'RCON 端口', type: 'number', group: '网络', min: 1024, max: 65535 },
  'rcon.password': { label: 'RCON 密码', type: 'text', group: '网络' },
  'enable-query': { label: '启用 Query 协议', type: 'bool', group: '网络' },
  'query.port': { label: 'Query 端口', type: 'number', group: '网络', min: 1024, max: 65535 },
  'accepts-transfers': {
    label: '接受服务器转移',
    type: 'bool',
    group: '网络',
    hint: '允许玩家从其他服务器无缝转移进来（1.20.2+）',
  },

  // ---- 其他 ----
  'max-chained-neighbor-updates': { label: '连锁邻接更新上限', type: 'number', group: '其他' },
  'log-ips': { label: '日志记录玩家 IP', type: 'bool', group: '其他' },
  'text-filtering-config': { label: '文本过滤配置', type: 'text', group: '其他' },
  'initial-enabled-packs': { label: '初始启用数据包', type: 'text', group: '其他' },
  'initial-disabled-packs': { label: '初始禁用数据包', type: 'text', group: '其他' },
  'bug-report-link': {
    label: '漏洞报告链接',
    type: 'text',
    group: '其他',
    hint: '客户端崩溃界面里显示的报告地址，留空表示不显示',
  },
  'broadcast-console-to-ops': { label: '向 OP 广播控制台输出', type: 'bool', group: '其他' },
  'broadcast-rcon-to-ops': { label: '向 OP 广播 RCON 输出', type: 'bool', group: '其他' },
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
    const m = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(line);
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
