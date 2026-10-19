// 快速添加服务器：填地址与账号 → 面板自动「装 Agent → 建实例 → 开服」，全过程在一个弹窗里。
//
// 为什么只有这一个入口（而不是再配一个「添加服务器」）：
//   · 两个入口在功能上是重合的——都只是「让一台机器进面板」，区别只在自动化的程度；
//   · 快速添加关心的是「我要一个能玩的 MC 服务器」，绝大多数选项由机器资源决定，
//     需要精细控制的部分（核心/版本/内存/端口/连接方式/TLS）全在「高级选项」里，一个不少；
//   · 少一个入口就少一套 SSH 预检/保存/再安装的状态机，也不会出现「填完忘了点安装」。
//
// 进度来源：**轮询** `GET /servers/:id/task-log?kind=install`。
// 刻意不用 SSE 增量推送——任务在 POST 返回前就已开始，SSE 订阅必然晚一步，
// 先到的几行会永久丢失；而服务端本来就缓存了完整日志，轮询天然幂等、刷新也能续上。

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Rocket, XCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/dialogs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { api, errText, type ServerSummary } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { subscribeServer } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';
import { navigate } from '@/lib/router';

/** 后端 /task-log 的响应（只有 done 之后 ok/error/instance 才有意义） */
interface TaskLog {
  lines: string;
  done: boolean | null;
  running: boolean;
  ok: boolean | null;
  error: string | null;
  code: string | null;
  instance: string | null;
  reused: boolean | null;
}

type Phase = 'form' | 'running' | 'done' | 'failed';

/** 目标机器：远程 SSH / 面板所在的本机 */
type Target = 'remote' | 'local';

/** 提交给后端的 mc 参数（见 panel/quick.js 的 normalizeOptions） */
interface McOptions {
  source: string;
  version?: string;
  memoryMB?: number;
  port?: number;
  name?: string;
  onlineMode: boolean;
  motd: string;
}

/** 一个可被「重试」复用的提交体 */
interface SubmitBody {
  name: string;
  host: string;
  sshPort: string;
  sshUser: string;
  sshAuth: 'password' | 'key';
  sshPassword: string;
  /** 直接粘贴的私钥内容（含 BEGIN/END 行） */
  sshKey: string;
  /** 本机私钥文件路径（由面板进程读取；与 sshKey 二选一） */
  sshKeyPath: string;
  agentMode: 'outbound' | 'inbound';
  agentPort: string;
  agentTls: boolean;
  panelUrl: string;
  /** 是否顺便创建并启动实例（默认不勾） */
  createInstance: boolean;
  eula: boolean;
  mc: McOptions;
}

const QUICK_SOURCES: { id: string; label: string }[] = [
  { id: 'paper', label: 'Paper' },
  { id: 'vanilla', label: 'Vanilla' },
  { id: 'purpur', label: 'Purpur' },
  { id: 'folia', label: 'Folia' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'forge', label: 'Forge' },
  { id: 'neoforge', label: 'NeoForge' },
];

/**
 * 面板地址默认值：用浏览器当前访问的主机名。
 * 只有 inbound 模式才用得到（Agent 要回连面板），面板监听 127.0.0.1 时这个值对
 * 远程服务器不可达——所以这个字段旁边必须保留那句 ⚠ 提示。
 */
function defaultPanelUrl(panelPort: number): string {
  try {
    return `ws://${location.hostname}:${panelPort}`;
  } catch {
    return `ws://127.0.0.1:${panelPort}`;
  }
}

export function QuickAddDialog({
  open,
  onOpenChange,
  panelPort,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  panelPort: number;
  /** 服务器记录建好后立刻回调（列表页据此把卡片显示为「安装中」） */
  onCreated: (s: ServerSummary) => void;
}) {
  const { success, error } = useToastHelpers();

  // ---------- 目标机器 ----------
  const [target, setTarget] = useState<Target>('remote');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [auth, setAuth] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');

  // ---------- 连接方式（只有远程需要） ----------
  const [mode, setMode] = useState<'outbound' | 'inbound'>('outbound');
  const [agentPort, setAgentPort] = useState('3099');
  const [tls, setTls] = useState(false);
  const [panelUrl, setPanelUrl] = useState(() => defaultPanelUrl(panelPort));

  // ---------- 实例（可选） ----------
  // 默认不勾：快速添加首先解决「把机器接进面板」，要不要顺手开服交给用户决定。
  const [createInstance, setCreateInstance] = useState(false);
  const [source, setSource] = useState('paper');
  const [version, setVersion] = useState('');
  const [memory, setMemory] = useState('');
  const [gamePort, setGamePort] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [onlineMode, setOnlineMode] = useState('true');
  const [motd, setMotd] = useState('A Minecraft Server');

  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);

  // ---------- 进度与结果 ----------
  const [phase, setPhase] = useState<Phase>('form');
  const [serverId, setServerId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState('');
  const [failed, setFailed] = useState<{ error: string; instance: string | null }>({ error: '', instance: null });
  const [created, setCreated] = useState<{ instance: string | null }>({ instance: null });
  const [progress, setProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const lastBody = useRef<SubmitBody | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  /** 回到表单（「再创建一个」/关闭后重开时用） */
  const resetForm = useCallback(() => {
    setPhase('form');
    setServerId(null);
    setLogLines('');
    setProgress(null);
    setCreated({ instance: null });
    setFailed({ error: '', instance: null });
    setPassword('');
    setKey('');
  }, []);

  // 重新打开时清掉凭据，避免把上次的密码误提交到另一台机器；
  // 上一次已成功完成的话直接回到表单（那个结果已经是过去式了）。
  useEffect(() => {
    if (!open) return;
    setPassword('');
    setKey('');
    if (phase === 'done') resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 日志自动滚到底（只在内容增长时；用户往上翻时不强拉）
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logLines]);

  // 下载百分比：Agent 的 install.progress 事件（仅用于展示，缺失也不影响流程）。
  // phase 有 download（核心）/ install（跑 Forge 等安装器）/ java（自动装 JRE）三种。
  useEffect(() => {
    if (!serverId || phase !== 'running') return;
    return subscribeServer(serverId, (e) => {
      if (e.type !== 'agent-event' || e.event !== 'install.progress') return;
      const d = e.data as { phase?: string; pct?: number } | null;
      const pct = Number(d?.pct);
      if (!Number.isFinite(pct)) return;
      setProgress({ phase: String(d?.phase || 'download'), pct });
    });
  }, [serverId, phase]);

  // 进度轮询：服务端有完整日志缓存，直接整体替换即可（不追加，天然幂等）
  useEffect(() => {
    if (!serverId || phase !== 'running') return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await api<TaskLog>(`/servers/${serverId}/task-log?kind=install`);
        if (stopped) return;
        setLogLines(r.lines || '');
        if (r.done !== null) {
          if (r.ok) {
            setCreated({ instance: r.instance });
            setPhase('done');
            setProgress(null);
          } else {
            setFailed({ error: r.error || '', instance: r.instance });
            setPhase('failed');
          }
          return;
        }
      } catch {
        // 面板重启/瞬时失败：继续轮询，不把一次抖动当失败
      }
      if (!stopped) timer = window.setTimeout(tick, 1200);
    };
    timer = window.setTimeout(tick, 300);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [serverId, phase]);

  const buildBody = (): SubmitBody | null => {
    const h = target === 'local' ? '127.0.0.1' : host.trim();
    if (!h) {
      error($('quickAdd.error.hostRequired'));
      return null;
    }
    if (target === 'remote') {
      if (auth === 'password' && !password) {
        error($('quickAdd.error.credentialsRequired'));
        return null;
      }
      if (auth === 'key' && !key.trim()) {
        error($('quickAdd.error.credentialsRequired'));
        return null;
      }
    }
    // 私钥输入框两种都收：贴进来的私钥内容（有 PEM 头）走 sshKey，
    // 否则当作本机文件路径交给面板进程去读（与本机 SSH 客户端的使用习惯一致）
    const keyText = key.trim();
    const pastedKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(keyText);
    return {
      name: name.trim() || (target === 'local' ? $('quickAdd.serverName.local') : h),
      host: h,
      sshPort,
      sshUser: sshUser.trim(),
      sshAuth: auth,
      sshPassword: target === 'remote' && auth === 'password' ? password : '',
      sshKey: target === 'remote' && auth === 'key' && pastedKey ? keyText : '',
      sshKeyPath: target === 'remote' && auth === 'key' && !pastedKey ? keyText : '',
      // 本机服务器固定 outbound：面板就在本机，直接连 127.0.0.1 最省事
      agentMode: target === 'local' ? 'outbound' : mode,
      agentPort,
      agentTls: target === 'remote' && mode === 'outbound' && tls,
      panelUrl: target === 'remote' && mode === 'inbound' ? panelUrl.trim() : '',
      // 不建实例时不需要 EULA 同意，eula 也如实传 false（后端同样只在建实例时校验）
      createInstance,
      eula: createInstance,
      mc: {
        source,
        version: version.trim() || undefined,
        memoryMB: memory ? Number(memory) : undefined,
        port: gamePort ? Number(gamePort) : undefined,
        name: instanceName.trim() || undefined,
        onlineMode: onlineMode === 'true',
        motd,
      },
    };
  };

  const submit = async () => {
    if (createInstance && !eula) {
      error($('quickAdd.error.eulaRequired'));
      return;
    }
    const body = buildBody();
    if (!body) return;
    lastBody.current = body;
    setBusy(true);
    try {
      const s = await api<ServerSummary>('/servers/quick-create', { method: 'POST', body });
      onCreated(s);
      setServerId(s.id);
      setLogLines('');
      setProgress(null);
      setPhase('running');
      success($('quickAdd.toast.created'), $('quickAdd.toast.createdDetail'));
    } catch (e) {
      error($('quickAdd.error.failed'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  /** 重试：沿用上次的参数；force = 连 Agent 一起重装（SSH 凭据改过时用） */
  const retry = async (force: boolean) => {
    const body = lastBody.current;
    if (!serverId || !body) return;
    setBusy(true);
    try {
      await api(`/servers/${serverId}/quick-setup`, {
        method: 'POST',
        body: { ...body, install: force ? 'force' : 'auto' },
      });
      setLogLines('');
      setProgress(null);
      setPhase('running');
      success($('quickAdd.retry.started'));
    } catch (e) {
      error($('quickAdd.error.failed'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async () => {
    if (!serverId) return;
    await api(`/servers/${serverId}`, { method: 'DELETE' });
    resetForm();
    onOpenChange(false);
  };

  const titleSuffix = phase === 'running' ? ' · ' + $('quickAdd.running') : '';

  return (
    <>
      {/* 运行中允许关闭：后台任务继续，列表页仍能看到「安装中」 */}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {$('quickAdd.title')}
              {titleSuffix}
            </DialogTitle>
            {phase === 'form' && <DialogDescription>{$('quickAdd.description')}</DialogDescription>}
          </DialogHeader>

          {phase === 'form' ? (
            <>
              <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  {/* 目标机器：本机时 SSH 字段全部隐藏 */}
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label>{$('quickAdd.target')}</Label>
                    <Select value={target} onValueChange={(v) => setTarget(v as Target)}>
                      <SelectTrigger className="w-full sm:max-w-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="remote">{$('quickAdd.target.remote')}</SelectItem>
                        <SelectItem value="local">{$('quickAdd.target.local')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {target === 'local' && (
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        {$('quickAdd.target.local.hint')}
                      </p>
                    )}
                  </div>

                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="q-name">{$('quickAdd.name')}</Label>
                    <Input
                      id="q-name"
                      className="sm:max-w-sm"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={$('quickAdd.name.placeholder')}
                    />
                  </div>

                  {target === 'remote' && (
                    <>
                      <div className="flex items-end gap-3 sm:col-span-2">
                        <div className="grid min-w-0 flex-1 gap-1.5">
                          <Label htmlFor="q-host">{$('quickAdd.host')}</Label>
                          <Input
                            id="q-host"
                            value={host}
                            onChange={(e) => setHost(e.target.value)}
                            placeholder={$('quickAdd.host.placeholder')}
                          />
                        </div>
                        <div className="grid w-[110px] shrink-0 gap-1.5">
                          <Label htmlFor="q-port">{$('quickAdd.sshPort')}</Label>
                          <Input id="q-port" value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
                        </div>
                      </div>

                      <div className="grid gap-1.5">
                        <Label htmlFor="q-user">{$('quickAdd.sshUser')}</Label>
                        <Input id="q-user" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>{$('quickAdd.auth')}</Label>
                        <Select value={auth} onValueChange={(v) => setAuth(v as 'password' | 'key')}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="password">{$('quickAdd.auth.password')}</SelectItem>
                            <SelectItem value="key">{$('quickAdd.auth.key')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {auth === 'password' ? (
                        <div className="grid gap-1.5 sm:col-span-2">
                          <Label htmlFor="q-pass">{$('quickAdd.sshPassword')}</Label>
                          <Input
                            id="q-pass"
                            type="password"
                            className="sm:max-w-sm"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                          />
                        </div>
                      ) : (
                        <div className="grid gap-1.5 sm:col-span-2">
                          <Label htmlFor="q-key">{$('quickAdd.keyPath')}</Label>
                          <Textarea
                            id="q-key"
                            rows={3}
                            placeholder={$('quickAdd.keyPath.placeholder')}
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                          />
                        </div>
                      )}

                      <div className="grid gap-1.5">
                        <Label>{$('quickAdd.mode')}</Label>
                        <Select value={mode} onValueChange={(v) => setMode(v as 'outbound' | 'inbound')}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="outbound">{$('quickAdd.mode.outbound')}</SelectItem>
                            <SelectItem value="inbound">{$('quickAdd.mode.inbound')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {mode === 'outbound' ? (
                        <div className="grid w-[130px] gap-1.5">
                          <Label htmlFor="q-aport">{$('quickAdd.agentPort')}</Label>
                          <Input id="q-aport" value={agentPort} onChange={(e) => setAgentPort(e.target.value)} />
                        </div>
                      ) : (
                        <div className="grid gap-1.5">
                          <Label htmlFor="q-panel">{$('quickAdd.panelUrl')}</Label>
                          <Input id="q-panel" value={panelUrl} onChange={(e) => setPanelUrl(e.target.value)} />
                        </div>
                      )}
                      <p className="text-[11px] leading-snug text-muted-foreground sm:col-span-2">
                        {mode === 'outbound' ? $('quickAdd.agentPort.hint') : $('quickAdd.panelUrl.hint')}
                      </p>
                      {mode === 'outbound' && (
                        <label className="flex items-start gap-2 text-sm sm:col-span-2">
                          <Checkbox className="mt-0.5" checked={tls} onCheckedChange={(v) => setTls(v === true)} />
                          <span>{$('quickAdd.tls')}</span>
                        </label>
                      )}
                    </>
                  )}

                  {/* 实例（可选）：默认不勾；勾了才建实例并开服。
                      这里**刻意不做折叠**——参数一眼可见，才看得出「不勾就只装 Agent」。 */}
                  <div className="sm:col-span-2 rounded-md border bg-muted/30 p-3">
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={createInstance}
                        onCheckedChange={(v) => setCreateInstance(v === true)}
                      />
                      <span>
                        {$('quickAdd.instance.toggle')}
                        <span className="block text-[11px] leading-snug text-muted-foreground">
                          {$('quickAdd.instance.toggle.hint')}
                        </span>
                      </span>
                    </label>

                    <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label>{$('quickAdd.core')}</Label>
                        <Select value={source} onValueChange={setSource}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {QUICK_SOURCES.map((k) => (
                              <SelectItem key={k.id} value={k.id}>
                                {k.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="q-ver">{$('quickAdd.version')}</Label>
                        <Input
                          id="q-ver"
                          value={version}
                          onChange={(e) => setVersion(e.target.value)}
                          placeholder={$('quickAdd.version.auto')}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="q-mem">{$('quickAdd.memory')}</Label>
                        <Input
                          id="q-mem"
                          inputMode="numeric"
                          value={memory}
                          onChange={(e) => setMemory(e.target.value.replace(/[^\d]/g, ''))}
                          placeholder={$('quickAdd.memory.auto')}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="q-gport">{$('quickAdd.port')}</Label>
                        <Input
                          id="q-gport"
                          inputMode="numeric"
                          value={gamePort}
                          onChange={(e) => setGamePort(e.target.value.replace(/[^\d]/g, ''))}
                          placeholder={$('quickAdd.port.auto')}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="q-inst">{$('quickAdd.instanceName')}</Label>
                        <Input
                          id="q-inst"
                          value={instanceName}
                          onChange={(e) => setInstanceName(e.target.value)}
                          placeholder={$('quickAdd.instanceName.auto')}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>{$('quickAdd.onlineMode')}</Label>
                        <Select value={onlineMode} onValueChange={setOnlineMode}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">{$('quickAdd.onlineMode.on')}</SelectItem>
                            <SelectItem value="false">{$('quickAdd.onlineMode.off')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label htmlFor="q-motd">{$('quickAdd.motd')}</Label>
                        <Input id="q-motd" value={motd} onChange={(e) => setMotd(e.target.value)} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* EULA 只在「要建实例」时需要同意（不建实例就装个 Agent，没有 EULA 可谈） */}
              {createInstance && (
                <label className="mt-3 flex shrink-0 items-center gap-2 text-sm">
                  <Checkbox checked={eula} onCheckedChange={(v) => setEula(v === true)} />
                  <span>
                    {$('quickAdd.eula.pre')}
                    <a
                      href="https://aka.ms/MinecraftEULA"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      Minecraft EULA
                    </a>
                  </span>
                </label>
              )}

              <DialogFooter className="shrink-0">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {$('common.cancel')}
                </Button>
                <Button disabled={busy} onClick={submit}>
                  <Rocket className="h-4 w-4" /> {$('quickAdd.submit')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                {/* 结果区：成功/失败给明确的下一步，运行中只给进度与提示 */}
                {phase === 'done' && (
                  <div className="mb-3 flex items-start gap-2.5 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="min-w-0 text-sm">
                      <div className="font-medium">{$('quickAdd.done.title')}</div>
                      <div className="mt-0.5 text-muted-foreground">
                        {created.instance
                          ? $('quickAdd.done.detail', created.instance)
                          : $('quickAdd.done.detailNoInstance')}
                      </div>
                    </div>
                  </div>
                )}
                {phase === 'failed' && (
                  <div className="mb-3 flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                    <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                    <div className="min-w-0 text-sm">
                      <div className="font-medium">{$('quickAdd.failed.title')}</div>
                      <div className="mt-0.5 break-words text-muted-foreground">
                        {failed.error || $('quickAdd.error.failed')}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{$('quickAdd.failed.hint')}</div>
                    </div>
                  </div>
                )}
                {phase === 'running' && (
                  <div className="mb-3 text-xs text-muted-foreground">
                    {progress === null
                      ? $('quickAdd.running.hint')
                      : progress.phase === 'java'
                        ? $('quickAdd.progress.java', Math.round(progress.pct))
                        : progress.phase === 'install'
                          ? $('quickAdd.progress.install')
                          : $('quickAdd.progress.download', Math.round(progress.pct))}
                  </div>
                )}

                <pre
                  ref={logRef}
                  className="max-h-[46vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
                >
                  {logLines || '…'}
                </pre>
              </div>

              <DialogFooter className="shrink-0 flex-wrap gap-2">
                {phase === 'done' ? (
                  <>
                    <Button variant="outline" onClick={resetForm}>
                      {$('quickAdd.again')}
                    </Button>
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>
                      {$('quickAdd.done.close')}
                    </Button>
                    <Button
                      onClick={() => {
                        onOpenChange(false);
                        navigate(`/server/${serverId}`);
                      }}
                    >
                      {created.instance ? $('quickAdd.done.view') : $('quickAdd.done.createInstance')}
                    </Button>
                  </>
                ) : phase === 'failed' ? (
                  <>
                    <Button variant="outline" className="mr-auto" disabled={busy} onClick={() => setDeleteOpen(true)}>
                      {$('quickAdd.failed.delete')}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => retry(true)}>
                      {$('quickAdd.failed.retryForce')}
                    </Button>
                    <Button disabled={busy} onClick={() => retry(false)}>
                      {$('quickAdd.failed.retry')}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="mr-auto self-center text-xs text-muted-foreground">
                      {$('quickAdd.running.hint')}
                    </span>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                      {$('common.close')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        onOpenChange(false);
                        navigate(`/server/${serverId}`);
                      }}
                    >
                      {$('quickAdd.done.view')}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={$('quickAdd.failed.delete')}
        description={$('quickAdd.delete.confirm')}
        onConfirm={removeServer}
      />
    </>
  );
}
