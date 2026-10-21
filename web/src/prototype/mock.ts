// 原型用假数据。形状刻意对齐真实接口的精简版：接入真实数据时只换数据源，不改布局。
//
// 名字/地址一律用拉丁字符：它们属于「用户数据」，双语切换时不该被翻译。

export type ProtoStatus = 'running' | 'stopped' | 'starting' | 'failed';

export type ProtoServer = {
  id: string;
  name: string;
  host: string;
  online: boolean;
  /** 安装中的百分比（有值时表示 Agent 正在装） */
  installing?: number;
  agent: string;
  system: string;
  /** 实例默认使用的 Java 主版本；未装/未探测时是 '—' */
  java: string;
  instances: number;
  latency: number | null;
  cpu: number;
  memUsed: number;
  memTotal: number;
  disk: number;
};

export type ProtoInstance = {
  serverId: string;
  name: string;
  note?: string;
  /** 实例自定义图标（data URL 或图片地址）；没有时卡片用服务器图标占位 */
  icon?: string;
  /** 最近一次成功的备份（人读的时间描述）；没有备份记录时为空 */
  lastBackup?: string;
  status: ProtoStatus;
  core: string;
  version: string;
  players: number | null;
  maxPlayers: number;
  memoryMB: number;
  memoryMaxMB: number;
  uptime: string | null;
  port: number;
  address?: string;
};

export const MOCK_SERVERS: ProtoServer[] = [
  {
    id: 's1',
    name: 'survival-main',
    host: '192.168.1.10',
    online: true,
    agent: '0.5.4',
    system: 'Ubuntu 22.04',
    java: '21',
    instances: 3,
    latency: 12,
    cpu: 42,
    memUsed: 6.2,
    memTotal: 16,
    disk: 61,
  },
  {
    id: 's2',
    name: 'creative-lab',
    host: '10.0.0.5',
    online: true,
    agent: '0.5.4',
    system: 'Debian 12',
    java: '21',
    instances: 2,
    latency: 5,
    cpu: 18,
    memUsed: 3.1,
    memTotal: 8,
    disk: 34,
  },
  {
    id: 's3',
    name: 'backup-node',
    host: '10.0.0.9',
    online: false,
    agent: '0.5.3',
    system: 'Debian 12',
    java: '17',
    instances: 2,
    latency: null,
    cpu: 0,
    memUsed: 0,
    memTotal: 4,
    disk: 44,
  },
  {
    id: 's4',
    name: 'edge-win',
    host: '172.16.4.21',
    online: false,
    installing: 62,
    agent: '—',
    system: 'Windows 11 (22631)',
    java: '—',
    instances: 0,
    latency: null,
    cpu: 0,
    memUsed: 0,
    memTotal: 8,
    disk: 20,
  },
];

export const MOCK_INSTANCES: ProtoInstance[] = [
  {
    serverId: 's1',
    name: 'survival',
    note: '主服 · 长期档',
    status: 'running',
    core: 'Fabric',
    version: '1.20.4',
    players: 4,
    maxPlayers: 20,
    memoryMB: 6144,
    memoryMaxMB: 8192,
    uptime: '3h12m',
    port: 25565,
    lastBackup: '今天 12:00',
    address: 'mc.example.com:25565',
  },
  {
    serverId: 's1',
    name: 'skyblock',
    status: 'stopped',
    core: 'Paper',
    version: '1.20.4',
    players: null,
    maxPlayers: 10,
    memoryMB: 2048,
    memoryMaxMB: 4096,
    uptime: null,
    port: 25566,
    lastBackup: '10-20 18:00',
  },
  {
    serverId: 's1',
    name: 'redstone-lab',
    note: '上次启动失败',
    status: 'failed',
    core: 'Forge',
    version: '1.20.1',
    players: null,
    maxPlayers: 8,
    memoryMB: 4096,
    memoryMaxMB: 4096,
    uptime: null,
    port: 25567,
  },
  {
    serverId: 's2',
    name: 'creative',
    status: 'running',
    core: 'Paper',
    version: '1.20.1',
    players: 1,
    maxPlayers: 20,
    memoryMB: 5600,
    memoryMaxMB: 8192,
    uptime: '1h05m',
    port: 25568,
    lastBackup: '今天 06:00',
  },
  {
    serverId: 's2',
    name: 'lobby',
    note: '等待端口 25569 释放',
    status: 'starting',
    core: 'Paper',
    version: '1.20.4',
    players: null,
    maxPlayers: 30,
    memoryMB: 2048,
    memoryMaxMB: 2048,
    uptime: null,
    port: 25569,
  },
  {
    serverId: 's3',
    name: 'archive',
    status: 'stopped',
    core: 'Vanilla',
    version: '1.19.4',
    players: null,
    maxPlayers: 10,
    memoryMB: 2048,
    memoryMaxMB: 4096,
    uptime: null,
    port: 25570,
    lastBackup: '10-18 22:00',
  },
  {
    serverId: 's3',
    name: 'testbed',
    status: 'stopped',
    core: 'Fabric',
    version: '1.20.4',
    players: null,
    maxPlayers: 4,
    memoryMB: 1024,
    memoryMaxMB: 2048,
    uptime: null,
    port: 25571,
  },
];

export const MOCK_PLAYERS = [
  { name: 'Steve', minutes: '1h02m' },
  { name: 'Alex', minutes: '12m' },
  { name: 'Herobrine', minutes: '3m' },
  { name: 'Notch', minutes: '45m' },
];

export const MOCK_EVENTS = [
  { time: '12:04', level: 'info' as const, text: '备份完成 survival-2026-10-21-1200.tar.gz' },
  { time: '11:58', level: 'warn' as const, text: "Can't keep up! Is the server overloaded?" },
  { time: '11:42', level: 'info' as const, text: 'Alex 加入游戏' },
  { time: '11:30', level: 'info' as const, text: '定时任务「每日备份」已触发' },
  { time: '10:55', level: 'error' as const, text: 'java.lang.OutOfMemoryError: Java heap space' },
];

export const MOCK_LOG = [
  '[12:04:31] [Server thread/INFO]: Saving chunks for level \'world\'',
  '[12:04:30] [Server thread/INFO]: Saving the game (this may take a moment!)',
  '[12:03:58] [Server thread/INFO]: <Alex> 有人要一起挖矿吗',
  '[12:03:11] [Server thread/INFO]: Steve joined the game',
  '[12:02:47] [Server thread/WARN]: Can\'t keep up! Is the server overloaded? Running 2143ms behind',
  '[12:02:47] [Server thread/INFO]: Time elapsed: 2181 ms',
  '[12:01:05] [Server thread/INFO]: Preparing spawn area: 83%',
  '[11:58:20] [Server thread/INFO]: Starting minecraft server version 1.20.4',
  '[11:58:19] [Server thread/INFO]: Loading properties',
  '[11:58:18] [Server thread/INFO]: Fabric Loader 0.15.6',
  '[11:58:12] [Server thread/INFO]: Starting java -Xmx8G -Xms8G -jar fabric-server-launch.jar nogui',
  '[11:58:11] [Server thread/INFO]: Java 21.0.2 (Microsoft), 8G heap',
];

export const MOCK_BACKUPS = [
  { name: 'survival-2026-10-21-1200.tar.gz', size: '412 MB', time: '今天 12:00', auto: true },
  { name: 'survival-2026-10-20-1200.tar.gz', size: '409 MB', time: '昨天 12:00', auto: true },
  { name: 'survival-2026-10-19-1200.tar.gz', size: '405 MB', time: '10-19 12:00', auto: true },
  { name: 'survival-manual-before-forge.tar.gz', size: '398 MB', time: '10-18 21:40', auto: false },
];
