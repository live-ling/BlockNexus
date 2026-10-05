// 实例详情页：顶部常驻终端，下方控制按钮与实例信息
// 路由 #/server/<serverId>/instance/<name>

import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, Ban, CloudDownload, FolderOpen, Globe, LogOut, MoreVertical, Pencil, Play, Puzzle, RotateCw, Settings2, ShieldCheck, ShieldOff, Sparkles, Square, Terminal, Trash2, Users } from 'lucide-react';
import { AiLogPanel } from '@/components/ai-log-panel';
import { BackupDialog } from '@/components/backup-dialog';
import { ConsolePanel } from '@/components/console-panel';
import { ConfirmDialog, EditInstanceDialog, ReinstallDialog } from '@/components/dialogs';
import { FileManagerDialog } from '@/components/file-manager';
import { BanListDialog } from '@/components/ban-list-dialog';
import { ModManagerDialog } from '@/components/mod-manager';
import { AutoRestartDialog } from '@/components/auto-restart-dialog';
import { PropertiesDialog } from '@/components/properties-dialog';
import { InstanceStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  api,
  errText,
  fmtMB,
  fmtUptime,
  latencyTone,
  type Instance,
  type PlayersSnapshot,
  type ServerSummary,
} from '@/lib/api';
import { subscribeServer } from '@/lib/sse';
import { copyText } from '@/lib/clipboard';
import { useToastHelpers } from '@/lib/toast';

export function InstanceDetailPage({
  serverId,
  instanceName,
  onBack,
}: {
  serverId: string;
  instanceName: string;
  onBack: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [players, setPlayers] = useState<PlayersSnapshot[string] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [modsOpen, setModsOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [watchdogOpen, setWatchdogOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reinstallOpen, setReinstallOpen] = useState(false);
  const [backupBeforeDelete, setBackupBeforeDelete] = useState(true);
  const [busy, setBusy] = useState(false);
  // 玩家快捷管理：待确认的操作（踢出/封禁/封禁 IP 统一走模态框，原因可选）
  const [playerAction, setPlayerAction] = useState<{ name: string; kind: 'kick' | 'ban' | 'ban-ip' } | null>(null);
  // 域名连通检测状态
  const [domainCheck, setDomainCheck] = useState<
    { state: 'checking' | 'done'; result?: DomainCheckResult } | null
  >(null);
  const [bansOpen, setBansOpen] = useState(false);
  // 主区视图：终端 / AI 日志分析
  const [mainView, setMainView] = useState<'console' | 'ai'>('console');
  const [, forceTick] = useState(0);

  const loadServer = useCallback(() => {
    api<ServerSummary>(`/servers/${serverId}`)
      .then(setServer)
      .catch((e) => error(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const loadInstance = useCallback(() => {
    api<Instance[]>(`/servers/${serverId}/instances`)
      .then((list) => {
        const hit = list.find((i) => i.name === instanceName);
        if (hit) setInstance(hit);
        else setNotFound(true);
      })
      .catch((e) => error('实例信息获取失败', errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, instanceName]);

  const loadPlayers = useCallback(() => {
    api<PlayersSnapshot>(`/servers/${serverId}/players`)
      .then((snap) => setPlayers(snap[instanceName] ?? null))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, instanceName]);

  useEffect(() => {
    loadServer();
    loadInstance();
    loadPlayers();
  }, [loadServer, loadInstance, loadPlayers]);

  // 运行中：每 20 秒刷新在线人数；启动中不查询（服务端还没开始监听）
  const running = instance?.status === 'running';
  const starting = instance?.status === 'starting';
  const active = running || starting;
  useEffect(() => {
    if (!running) return;
    loadPlayers();
    const t1 = window.setInterval(loadPlayers, 20000);
    const t2 = window.setInterval(() => forceTick((n) => n + 1), 30000);
    return () => {
      window.clearInterval(t1);
      window.clearInterval(t2);
    };
  }, [running, loadPlayers]);

  // 实时事件：状态/延迟变化
  useEffect(() => {
    return subscribeServer(serverId, (e) => {
      if (e.type === 'latency') {
        setServer((cur) => (cur ? { ...cur, latency: e.latency } : cur));
        return;
      }
      if (e.type === 'status') {
        loadServer();
        loadInstance();
        if (e.status === 'online') loadPlayers();
        return;
      }
      if (e.type === 'agent-event' && e.event === 'instance.updated' && e.data?.instance === instanceName) {
        loadInstance();
        setTimeout(loadPlayers, 1500);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, instanceName]);

  /** 玩家快捷管理：向实例控制台发送指令（kick / ban / op / deop 等），返回是否成功 */
  const sendPlayerCmd = useCallback(
    async (cmd: string, okText: string) => {
      try {
        await api(`/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/command`, {
          method: 'POST',
          body: { cmd },
        });
        success(okText, `已执行：${cmd}`);
        return true;
      } catch (e) {
        error('指令发送失败', errText(e));
        return false;
      }
    },
    [serverId, instanceName, success, error],
  );

  /** 域名连通检测（Agent 侧解析 + TCP 探测）；序号防在途请求把已清空/过期的结果写回 */
  const checkSeq = useRef(0);
  const runDomainCheck = useCallback(() => {
    const seq = ++checkSeq.current;
    setDomainCheck({ state: 'checking' });
    api<DomainCheckResult>(
      `/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/domain-check`,
    )
      .then((r) => {
        if (seq === checkSeq.current) setDomainCheck({ state: 'done', result: r });
      })
      .catch((e) => {
        if (seq === checkSeq.current)
          setDomainCheck({ state: 'done', result: { error: errText(e) } as DomainCheckResult });
      });
  }, [serverId, instanceName]);

  // 只有实例运行中才自动检测（未运行时端口必然拒绝，检测只会报错）；
  // 域名改动（编辑后）或由停止转运行时重新检测，停止后清掉旧结果
  useEffect(() => {
    if (instance?.address && running) runDomainCheck();
    else {
      checkSeq.current++;
      setDomainCheck(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.address, running]);

  /** 复制到剪贴板（域名等玩家要用的地址） */
  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) success('已复制', text);
    else error('复制失败', '请手动选择复制');
  };

  const op = async (action: 'start' | 'stop' | 'restart') => {    setBusy(true);
    try {
      await api(`/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/${action}`, {
        method: 'POST',
        body: {},
      });
      success(action === 'start' ? '启动指令已发送' : action === 'stop' ? '停止指令已发送' : '重启中…');
      setTimeout(() => {
        loadInstance();
        loadPlayers();
      }, 1500);
    } catch (e) {
      error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // 面板代下：服务器侧下载核心反复失败时，由面板下载并经加密通道传过去安装
  const panelInstall = async () => {
    setBusy(true);
    try {
      await api(`/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/panel-install`, {
        method: 'POST',
        body: {},
      });
      success('面板已接手下载', '面板下载核心后自动传输安装，请留意控制台');
      setTimeout(loadInstance, 800);
    } catch (e) {
      error('面板代下失败', errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-5xl px-5 pt-10 text-center">
        <p className="text-sm text-muted-foreground">实例不存在或已被删除</p>
        <Button className="mt-4" variant="outline" onClick={onBack}>
          返回实例列表
        </Button>
      </div>
    );
  }

  if (!server || !instance) {
    return <div className="p-10 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  const tone = latencyTone(server.latency);
  // 安装失败：删除时跳过备份（目录里只有半成品，备份无意义且可能卡住）
  const isFailed = instance.status === 'failed';
  // 自动重启是否已启用（按钮上显示小绿点）
  const watchdogOn = !!instance.watchdog?.autoRestart || (instance.watchdog?.schedules ?? []).some((s) => s.enabled);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 pb-24 pt-7">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">{instance.name}</h2>
        <InstanceStatusBadge status={instance.status} />
        {active && server.latency != null && (
          <span
            className={`font-mono text-xs ${
              tone === 'good'
                ? 'text-emerald-600 dark:text-emerald-400'
                : tone === 'fair'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-destructive'
            }`}
            title="面板 → 服务器 实测往返延迟"
          >
            延迟 {server.latency === 0 ? '<1' : server.latency}ms
          </span>
        )}
      </div>

      {/* 左：信息 + 控件；中：终端；右：在线玩家（运行时才占位，保证终端不被无谓压缩） */}
      <div
        className={`mt-4 grid gap-3 lg:grid-cols-[270px_minmax(0,1fr)] ${
          running ? 'xl:grid-cols-[270px_minmax(0,1fr)_212px]' : ''
        }`}
      >
        <aside className="grid content-start gap-3 self-start">
          {/* 实例信息：备注/连接地址可点开就地修改（server-icon 在「编辑」里设置） */}
          <div className="grid content-start gap-2 rounded-xl border bg-card p-3.5">
            <InfoRow label={fmtLabel('备注')} value={instance.note || '未设置'} />
            <InfoRow label={fmtLabel('版本')} value={instance.version} />
            <InfoRow label={fmtLabel('内存')} value={fmtMB(instance.memoryMB)} />
            <InfoRow
              label={fmtLabel('在线玩家')}
              value={players ? `${players.online ?? '—'}/${players.max}` : `—/${instance.maxPlayers}`}
              tone={players && players.online ? 'good' : undefined}
            />
            <InfoRow label={fmtLabel('连接地址')} value={`${server.host}:${instance.port}`} />
            <CopyRow
              label={fmtLabel('域名')}
              value={instance.address}
              placeholder="未设置"
              onCopy={handleCopy}
            />
            {instance.address ? (
              <div className="flex min-w-0 items-start justify-between gap-2 px-1">
                {!running ? (
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    实例未启动，暂不检测域名连通
                  </span>
                ) : domainCheck?.state === 'checking' ? (
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    域名连通检测中…
                  </span>
                ) : domainCheck?.result ? (
                  domainCheck.result.error ? (
                    <span className="min-w-0 break-words text-[11px] leading-snug text-destructive" title={domainCheck.result.error}>
                      ✗ {domainCheck.result.error}
                    </span>
                  ) : (
                    <span className="min-w-0 break-words text-[11px] leading-snug text-emerald-600 dark:text-emerald-400" title={`${domainCheck.result.ip}:${domainCheck.result.port}`}>
                      ✓ {domainCheck.result.ip}:{domainCheck.result.port} · TCP {domainCheck.result.latencyMs}ms
                      {domainCheck.result.srv ? ' · SRV' : ''}
                    </span>
                  )
                ) : (
                  <span className="text-[11px] leading-snug text-muted-foreground">未检测</span>
                )}
                {running && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                    disabled={domainCheck?.state === 'checking'}
                    onClick={runDomainCheck}
                    aria-label="重新检测域名连通性"
                    title="检测域名连通性"
                  >
                    <Globe className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ) : null}
            <InfoRow label={fmtLabel('正版验证')} value={instance.onlineMode ? '开启' : '关闭（离线）'} />
            {active && (
              <InfoRow
                label={fmtLabel('运行时间')}
                value={starting ? '启动中…' : fmtUptime(instance.startedAt)}
              />
            )}
          </div>

          {/* Java 版本选择 + 安装（缺 Java 或版本低于 21 时显示） */}
          {server.online &&
            server.info &&
            (!server.info.java.installed || (server.info.java.major ?? 0) < 21) && (
              <JavaInstallRow serverId={server.id} onDone={loadServer} />
            )}

          {/* 控件（大按钮，间距紧凑；启动中可停止，重启等就绪后再用） */}
          <div className="grid content-start gap-1.5">
            {active ? (
              <>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={busy}
                  onClick={() => op('stop')}
                >
                  <Square className="h-4 w-4" /> {starting ? '停止启动' : '停止'}
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  disabled={busy || starting}
                  title={starting ? '服务器启动完成后可重启' : undefined}
                  onClick={() => op('restart')}
                >
                  <RotateCw className="h-4 w-4" /> 重启
                </Button>
              </>
            ) : (
              <Button size="lg" disabled={busy || instance.status !== 'stopped'} onClick={() => op('start')}>
                <Play className="h-4 w-4" /> 启动
              </Button>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="lg" variant="outline" onClick={() => setFilesOpen(true)}>
                <FolderOpen className="h-4 w-4" /> 文件
              </Button>
              <Button size="lg" variant="outline" onClick={() => setBackupOpen(true)}>
                <Archive className="h-4 w-4" /> 备份
              </Button>
              <Button size="lg" variant="outline" onClick={() => setModsOpen(true)}>
                <Puzzle className="h-4 w-4" /> Mod 管理
              </Button>
              <Button size="lg" variant="outline" onClick={() => setPropsOpen(true)}>
                <Settings2 className="h-4 w-4" /> 配置设置
              </Button>
              <Button size="lg" variant="outline" onClick={() => setWatchdogOpen(true)}>
                <RotateCw className="h-4 w-4" /> 自动重启
                {watchdogOn && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              </Button>
              <Button size="lg" variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> 编辑
              </Button>
              {instance.status === 'failed' && (
                <>
                  {instance.source !== 'upload' && (
                    <Button
                      size="lg"
                      variant="outline"
                      disabled={busy}
                      title="服务器拉不动核心站点时，由面板下载后经加密通道传到服务器"
                      onClick={panelInstall}
                    >
                      <CloudDownload className="h-4 w-4" /> 面板代下
                    </Button>
                  )}
                  <Button
                    size="lg"
                    variant="outline"
                    className="border-amber-600/60 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400"
                    onClick={() => setReinstallOpen(true)}
                  >
                    <RotateCw className="h-4 w-4" /> 重装核心
                  </Button>
                </>
              )}
              <Button
                size="lg"
                variant="outline"
                className="col-span-2 border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" /> 删除实例
              </Button>
            </div>
          </div>
        </aside>

        {/* 终端 / AI 日志分析（同一块区域切换，避免页面被拉得过长） */}
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-1">
            <Button
              size="sm"
              variant={mainView === 'console' ? 'secondary' : 'ghost'}
              onClick={() => setMainView('console')}
            >
              <Terminal className="h-3.5 w-3.5" /> 终端
            </Button>
            <Button
              size="sm"
              variant={mainView === 'ai' ? 'secondary' : 'ghost'}
              onClick={() => setMainView('ai')}
            >
              <Sparkles className="h-3.5 w-3.5" /> AI 分析
            </Button>
          </div>
          {/* 两个面板都常驻挂载，只切换可见性：
              条件渲染会在切走时卸载组件，AI 的对话记录与进行中的流会一起丢失，
              终端也会丢掉已拉取的日志与滚动位置。用 hidden 保住两边状态。 */}
          <div className={mainView === 'console' ? '' : 'hidden'}>
            <ConsolePanel
              server={server}
              instance={instance.name}
              instanceStatus={instance.status}
              heightClass="h-[45vh] lg:h-[60vh]"
            />
          </div>
          <div className={mainView === 'ai' ? '' : 'hidden'}>
            <AiLogPanel
              serverId={server.id}
              instanceName={instance.name}
              heightClass="h-[45vh] lg:h-[60vh]"
            />
          </div>
        </div>

        {/* 在线玩家名单（仅运行时显示） */}
        {running && (
          <aside className="rounded-xl border bg-card p-3 lg:col-span-2 xl:col-span-1">
            <div className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <b className="text-sm">在线玩家</b>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {players ? `${players.online ?? '—'}/${players.max}` : `—/${instance.maxPlayers}`}
              </span>
            </div>
            <div className="mt-2 max-h-[52vh] overflow-y-auto">
              {players && players.list && players.list.length > 0 ? (
                <ul className="grid gap-1">
                  {players.list.map((name) => (
                    <li
                      key={name}
                      className="group flex min-w-0 items-center gap-1 rounded-md bg-muted/60 py-1 pl-2 pr-1 font-mono text-xs text-foreground"
                      title={name}
                    >
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                            aria-label={`管理玩家 ${name}`}
                            title="玩家管理"
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40 font-sans">
                          <DropdownMenuItem onClick={() => setPlayerAction({ name, kind: 'kick' })}>
                            <LogOut className="h-3.5 w-3.5" /> 踢出
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPlayerAction({ name, kind: 'ban' })}>
                            <Ban className="h-3.5 w-3.5" /> 封禁
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPlayerAction({ name, kind: 'ban-ip' })}>
                            <Ban className="h-3.5 w-3.5" /> 封禁其 IP
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => void sendPlayerCmd(`op ${name}`, `${name} 已设为管理员`)}>
                            <ShieldCheck className="h-3.5 w-3.5" /> 设为管理员
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void sendPlayerCmd(`deop ${name}`, `已取消 ${name} 的管理员`)}>
                            <ShieldOff className="h-3.5 w-3.5" /> 取消管理员
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-1 py-3 text-xs text-muted-foreground">
                  {!players
                    ? '查询中…'
                    : players.unreachable
                      ? '服务器尚未响应（启动中？）'
                      : (players.online ?? 0) > 0
                        ? '服务端未提供玩家名单'
                        : '暂无玩家在线'}
                </p>
              )}
            </div>
            <div className="mt-2 border-t pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground hover:text-foreground"
                onClick={() => setBansOpen(true)}
              >
                <Ban className="h-3.5 w-3.5" /> 封禁目录
              </Button>
            </div>
          </aside>
        )}
      </div>

      <FileManagerDialog
        server={server}
        instance={instance.name}
        open={filesOpen}
        onOpenChange={setFilesOpen}
      />
      <ModManagerDialog
        serverId={server.id}
        instance={instance.name}
        open={modsOpen}
        onOpenChange={setModsOpen}
      />
      <BackupDialog
        server={server}
        instance={instance.name}
        open={backupOpen}
        onOpenChange={setBackupOpen}
      />
      <PropertiesDialog
        server={server}
        instance={instance}
        open={propsOpen}
        onOpenChange={setPropsOpen}
        onSaved={loadInstance}
        onRestart={() => op('restart')}
      />
      <AutoRestartDialog
        server={server}
        instance={instance}
        open={watchdogOpen}
        onOpenChange={setWatchdogOpen}
        onSaved={loadInstance}
      />
      <ReinstallDialog
        server={server}
        instance={instance}
        open={reinstallOpen}
        onOpenChange={setReinstallOpen}
        onStarted={loadInstance}
      />
      <EditInstanceDialog
        server={server}
        instance={instance}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={loadInstance}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除实例「${instance.name}」？`}
        description={
          <div>
            实例目录（含存档）将被永久删除。
            {isFailed ? (
              <p className="mt-2 text-xs text-muted-foreground">
                该实例上次安装失败，目录里只有半成品残留；将跳过备份直接清理
                （强行删除，无需等待备份完成）。
              </p>
            ) : (
              <label className="mt-3 flex items-center gap-2 text-sm font-normal text-foreground">
                <Checkbox
                  checked={backupBeforeDelete}
                  onCheckedChange={(v) => setBackupBeforeDelete(v === true)}
                />
                删除前自动创建备份（保留在服务器 .backups 目录，可事后恢复或下载）
              </label>
            )}
          </div>
        }
        onConfirm={async () => {
          await api(`/servers/${serverId}/instances/${encodeURIComponent(instance.name)}`, {
            method: 'DELETE',
            body: isFailed
              ? { backupFirst: false, force: true }
              : { backupFirst: backupBeforeDelete },
          });
          success(isFailed ? '已强制删除' : backupBeforeDelete ? '已删除（备份已保留）' : '已删除');
          onBack();
        }}
      />
      {playerAction && (
        <PlayerActionDialog
          target={playerAction}
          onClose={() => setPlayerAction(null)}
          onConfirm={sendPlayerCmd}
        />
      )}
      {server && (
        <BanListDialog
          serverId={server.id}
          instance={instance.name}
          open={bansOpen}
          onOpenChange={setBansOpen}
        />
      )}
    </div>
  );
}

/** 信息行骨架：两列 grid（标签列定宽、值列起点统一；列宽由模板决定，值列内的换行不影响对齐） */
function RowShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="group grid grid-cols-[5.2em_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** 只读信息行（静态展示） */
function InfoRow({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return (
    <RowShell label={label}>
      <span
        className={`min-w-0 break-words font-mono ${
          tone === 'good' ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-foreground'
        }`}
      >
        {value}
      </span>
    </RowShell>
  );
}

/** 点击复制的信息行（域名等玩家要用的地址）；为空时显示占位提示 */
function CopyRow({
  label,
  value,
  placeholder,
  onCopy,
}: {
  label: string;
  value: string;
  placeholder: string;
  onCopy: (text: string) => void;
}) {
  return (
    <RowShell label={label}>
      {value ? (
        <button
          type="button"
          onClick={() => onCopy(value)}
          title="点击复制"
          className="min-w-0 rounded break-words px-0.5 text-left font-mono text-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-4 hover:bg-muted hover:decoration-foreground"
        >
          {value}
        </button>
      ) : (
        <span className="min-w-0 break-words px-0.5 font-mono text-muted-foreground/70">{placeholder}</span>
      )}
    </RowShell>
  );
}

/** 标签格式化：统一加「：」；不足 4 字的标题中间补空格，使各行列对齐 */
function fmtLabel(text: string): string {
  const pad = text.length === 2 ? text[0] + ' ' + text[1] : text;
  return pad + '：';
}



/** 侧栏内：Java 版本选择 + 安装（缺 Java 或版本低于 21 时显示） */
function JavaInstallRow({ serverId, onDone }: { serverId: string; onDone: () => void }) {
  const { success, error } = useToastHelpers();
  const [busy, setBusy] = useState(false);
  const [major, setMajor] = useState('21');
  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <Select value={major} onValueChange={setMajor}>
        <SelectTrigger size="sm" className="w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="21">Java 21（推荐）</SelectItem>
          <SelectItem value="17">Java 17</SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="secondary"
        className="ml-auto"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ busy?: boolean }>(`/servers/${serverId}/java-install`, {
              method: 'POST',
              body: { major: Number(major) },
            });
            success(r.busy ? 'Java 安装已在进行中' : `Java ${major} 安装任务已下发`, '完成后系统信息自动更新');
          } catch (e) {
            error(errText(e));
          } finally {
            setBusy(false);
            setTimeout(onDone, 500);
          }
        }}
      >
        {busy ? '安装中…' : '安装'}
      </Button>
    </div>
  );
}

/** 域名连通检测结果（Agent 侧解析 + TCP 探测） */
interface DomainCheckResult {
  domain: string;
  srv: { host: string; port: number } | null;
  host: string;
  ip: string | null;
  port: number | null;
  tcp: boolean;
  latencyMs: number | null;
  error: string | null;
}

/** 玩家操作确认框：踢出 / 封禁 / 封禁 IP 统一走这里，原因可选（随指令下发给服务端） */
function PlayerActionDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: { name: string; kind: 'kick' | 'ban' | 'ban-ip' };
  onClose: () => void;
  /** 返回是否执行成功；成功后自动关闭 */
  onConfirm: (cmd: string, okText: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const meta = {
    kick: {
      title: `踢出玩家 ${target.name}`,
      cmd: `kick ${target.name}`,
      hint: '玩家会立即断开连接，可随时重新加入。',
    },
    ban: {
      title: `封禁玩家 ${target.name}`,
      cmd: `ban ${target.name}`,
      hint: '封禁后该玩家无法进入服务器；可在控制台用 pardon 解除。',
    },
    'ban-ip': {
      title: `封禁 ${target.name} 的 IP`,
      cmd: `ban-ip ${target.name}`,
      hint: '同一 IP 的所有玩家都会被拦截；可在控制台用 pardon-ip 解除。',
    },
  }[target.kind];
  const cmd = reason.trim() ? `${meta.cmd} ${reason.trim()}` : meta.cmd;
  const okText =
    target.kind === 'kick'
      ? `已踢出 ${target.name}`
      : target.kind === 'ban'
        ? `已封禁 ${target.name}`
        : `已封禁 ${target.name} 的 IP`;

  const submit = async () => {
    setBusy(true);
    try {
      const ok = await onConfirm(cmd, okText);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{meta.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              将向控制台发送{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{cmd}</code>
              。{meta.hint}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="原因（可选，将随指令下发给服务端）"
          maxLength={100}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              await submit();
            }}
          >
            {busy ? '执行中…' : '确认'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
