// 全部弹窗：添加/编辑服务器、Token、手动安装、新建实例、危险操作确认

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
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
import { api, errText, fmtMB, CORE_LABEL, INSTALLER_SOURCES, type CoreCatalogs, type Instance, type ServerSummary, type SshCheckResult } from '@/lib/api';
import { uploadFile, uploadFileViaSftp } from '@/lib/upload';
import { UploadChannelSelect, type UploadChannel } from '@/components/upload-channel';
import { useToastHelpers } from '@/lib/toast';
import { FileUpload, type FileUploadItem } from '@/components/motion/file-upload';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';

// 目录还没拉回来时也保证下拉里有得选（顺序与后端 CORE_KINDS 一致）
const FALLBACK_KINDS = [
  { id: 'vanilla', label: CORE_LABEL.vanilla, api: true },
  { id: 'paper', label: CORE_LABEL.paper, api: true },
  { id: 'purpur', label: CORE_LABEL.purpur, api: true },
  { id: 'folia', label: CORE_LABEL.folia, api: true },
  { id: 'fabric', label: CORE_LABEL.fabric, api: true },
  { id: 'forge', label: CORE_LABEL.forge, api: true },
  { id: 'neoforge', label: CORE_LABEL.neoforge, api: true },
  { id: 'url', label: CORE_LABEL.url, api: false },
  { id: 'upload', label: CORE_LABEL.upload, api: false },
];

const CORE_HINT: Record<string, string> = {
  vanilla: 'Mojang 官方服务端，最稳但没优化',
  paper: '高性能、插件生态最好，最常用',
  purpur: 'Paper 的增强分支，可调项更多',
  folia: '多线程区域化，适合大量玩家',
  fabric: '轻量模组端，需跑安装器（约 1-3 分钟）',
  forge: '经典模组端，需跑安装器（约 3-8 分钟）',
  neoforge: 'Forge 的新分支，1.20.2+ 推荐',
  url: '填入任意 .jar 直链',
  upload: '创建后上传本地 .jar',
};

// ---------- 添加服务器 ----------

export function AddServerDialog({
  open,
  onOpenChange,
  panelPort,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  panelPort: number;
  onCreated: (s: ServerSummary) => void;
}) {
  const { error } = useToastHelpers();
  const [auth, setAuth] = useState<'password' | 'key'>('password');
  const [mode, setMode] = useState<'outbound' | 'inbound'>('outbound');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<SshCheckResult | null>(null);
  const defaultPanel = `ws://${location.hostname}:${panelPort}`;
  const AGENT_PORT = '3099';
  const [useTls, setUseTls] = useState(false);

  // 连接信息改动后，之前的验证结果作废，必须重新验证
  const invalidate = () => setCheck(null);

  const doCheck = async () => {
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value ?? '';
    const host = val('add-host').trim();
    if (!host) {
      error('请填写 SSH 主机');
      return;
    }
    if (auth === 'password' && !val('add-pass')) {
      error('请填写 SSH 密码');
      return;
    }
    if (auth === 'key' && !val('add-key').trim()) {
      error('请填写私钥路径或私钥内容');
      return;
    }
    setChecking(true);
    setCheck(null);
    try {
      const r = await api<SshCheckResult>('/servers/ssh-check', {
        method: 'POST',
        body: {
          host,
          sshPort: val('add-port'),
          sshUser: val('add-user').trim(),
          sshAuth: auth,
          sshPassword: auth === 'password' ? val('add-pass') : '',
          sshKey: auth === 'key' ? val('add-key').trim() : '',
        },
      });
      setCheck(r);
    } catch (e) {
      setCheck({ ok: false, error: errText(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="no-scrollbar max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>添加服务器</DialogTitle>
          <DialogDescription>
            填好主机与 SSH 账号后先点「验证连接」，通过后再保存；保存后进入详情页可一键安装 Agent。
          </DialogDescription>
        </DialogHeader>
        {/* 双列紧凑排布：主机/端口、用户/认证方式成对，密码与私钥独占整行 */}
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="add-name">名称</Label>
            <Input id="add-name" className="sm:max-w-sm" placeholder="例如：香港 1 号机" />
          </div>

          {/* 主机占满剩余宽度，端口按内容收敛为固定窄列 */}
          <div className="flex items-end gap-3 sm:col-span-2">
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Label htmlFor="add-host">SSH 主机</Label>
              <Input id="add-host" placeholder="1.2.3.4" onChange={invalidate} />
            </div>
            <div className="grid w-[110px] shrink-0 gap-1.5">
              <Label htmlFor="add-port">SSH 端口</Label>
              <Input id="add-port" defaultValue="22" onChange={invalidate} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="add-user">SSH 用户（建议 root）</Label>
            <Input id="add-user" defaultValue="root" onChange={invalidate} />
          </div>
          <div className="grid gap-1.5">
            <Label>认证方式</Label>
            <Select
              value={auth}
              onValueChange={(v) => {
                setAuth(v as 'password' | 'key');
                invalidate();
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="password">密码</SelectItem>
                <SelectItem value="key">私钥</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {auth === 'password' ? (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="add-pass">SSH 密码</Label>
              <Input
                id="add-pass"
                type="password"
                className="sm:max-w-sm"
                onChange={invalidate}
              />
            </div>
          ) : (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="add-key">私钥路径（本机文件）或直接粘贴私钥内容</Label>
              <Textarea
                id="add-key"
                rows={3}
                placeholder="C:\Users\you\.ssh\id_ed25519 或 -----BEGIN OPENSSH PRIVATE KEY-----"
                onChange={invalidate}
              />
            </div>
          )}

          {/* 验证结果：连接成功展示环境预检，失败展示原因 */}
          {check && !check.ok && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive sm:col-span-2">
              ✗ 验证失败：{check.error || '无法连接'}
            </p>
          )}
          {check?.ok && (
            <div className="grid gap-1.5 rounded-md border bg-muted/40 px-3 py-2.5 text-xs sm:col-span-2">
              {check.local ? (
                <span className="text-primary">✓ 本机服务器：保存后由面板直接托管 Agent，无需 SSH</span>
              ) : (
                <>
                  <span className="text-primary">✓ SSH 连接成功（{check.user}）</span>
                  <span className="text-muted-foreground">系统：{check.os || '未知'} · {check.arch || '—'}</span>
                  <span className="text-muted-foreground">
                    权限：{check.isRoot ? 'root' : check.sudoOk ? '普通用户（免密 sudo）' : '普通用户'}
                    {' · '}Node：{check.node || '未安装'}
                    {' · '}Java：{check.javaMajor ? `Java ${check.javaMajor}` : '未安装'}
                  </span>
                </>
              )}
              {check.warnings?.map((w, i) => (
                <span key={i} className="text-amber-600 dark:text-amber-400">
                  ⚠ {w}
                </span>
              ))}
            </div>
          )}

          {mode === 'outbound' ? (
            <>
              <div className="grid gap-1.5">
                <Label>连接方式</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as 'outbound' | 'inbound')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="outbound">面板连接 Agent（推荐，Agent 在公网）</SelectItem>
                    <SelectItem value="inbound">Agent 连接面板（面板有公网地址时）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid w-[110px] gap-1.5">
                <Label htmlFor="add-aPort">Agent 端口</Label>
                <Input id="add-aPort" defaultValue={AGENT_PORT} />
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground sm:col-span-2">
                Agent 会在服务器上监听该端口，面板主动连入；请在服务器安全组/防火墙放行此端口（TCP）。
              </p>
              <label className="flex items-start gap-2 text-sm sm:col-span-2">
                <Checkbox
                  className="mt-0.5"
                  checked={useTls}
                  onCheckedChange={(v) => setUseTls(v === true)}
                />
                <span>
                  使用 TLS 加密（wss）
                  <span className="block text-xs text-muted-foreground">
                    安装时在服务器上用 openssl 生成自签证书，面板固定其指纹防中间人；应用层本身已有 token 加密，此项用于隐藏传输元数据。
                  </span>
                </span>
              </label>
            </>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label>连接方式</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as 'outbound' | 'inbound')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="outbound">面板连接 Agent（推荐，Agent 在公网）</SelectItem>
                    <SelectItem value="inbound">Agent 连接面板（面板有公网地址时）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="add-panel">面板地址（Agent 回连用）</Label>
                <Input id="add-panel" defaultValue={defaultPanel} />
              </div>
              <p className="text-[11px] leading-snug text-amber-500/90 sm:col-span-2">
                ⚠ 必须是远程服务器能访问到本面板的地址；面板在 NAT 后时请填公网地址（frp / Tailscale 等）。
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="secondary" disabled={checking || busy} onClick={doCheck}>
            {checking ? '验证中…' : check?.ok ? '重新验证' : '验证连接'}
          </Button>
          <Button
            disabled={busy || checking || !check?.ok}
            title={check?.ok ? undefined : '请先通过「验证连接」'}
            onClick={async () => {
              setBusy(true);
              try {
                const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
                const body = {
                  name: val('add-name') || '未命名',
                  host: val('add-host').trim(),
                  sshPort: val('add-port'),
                  sshUser: val('add-user').trim(),
                  sshAuth: auth,
                  sshPassword: auth === 'password' ? val('add-pass') : '',
                  sshKey: auth === 'key' ? val('add-key').trim() : '',
                  agentMode: mode,
                  agentPort: mode === 'outbound' ? val('add-aPort').trim() : '',
                  agentTls: mode === 'outbound' && useTls,
                  panelUrl: mode === 'inbound' ? val('add-panel').trim() : '',
                };
                if (!body.host) throw new Error('请填写 SSH 主机');
                const s = await api<ServerSummary>('/servers', { method: 'POST', body });
                onOpenChange(false);
                onCreated(s);
              } catch (e) {
                error('添加失败', errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 编辑服务器 ----------

export function EditServerDialog({
  server,
  open,
  onOpenChange,
  onSaved,
}: {
  server: ServerSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [busy, setBusy] = useState(false);
  const [editTls, setEditTls] = useState(!!server.agent.tls);
  useEffect(() => {
    if (open) setEditTls(!!server.agent.tls);
  }, [open, server.agent.tls]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="no-scrollbar max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>编辑服务器</DialogTitle>
        </DialogHeader>
        {/* 与添加弹窗一致：双列紧凑排布，端口等短字段按内容收敛宽度 */}
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="e-name">名称</Label>
            <Input id="e-name" className="sm:max-w-sm" defaultValue={server.name} />
          </div>
          {/* 主机占满剩余宽度，端口按内容收敛为固定窄列 */}
          <div className="flex items-end gap-3 sm:col-span-2">
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Label htmlFor="e-host">SSH 主机</Label>
              <Input id="e-host" defaultValue={server.host} />
            </div>
            <div className="grid w-[110px] shrink-0 gap-1.5">
              <Label htmlFor="e-port">SSH 端口</Label>
              <Input id="e-port" defaultValue={String(server.ssh.port)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="e-user">SSH 用户</Label>
            <Input id="e-user" defaultValue={server.ssh.user} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="e-pass">SSH 密码（留空不修改）</Label>
            <Input id="e-pass" type="password" placeholder="••••••" />
          </div>
          <div className="grid gap-1.5">
            <Label>连接方式</Label>
            <Select value={server.agent.mode || 'outbound'} disabled>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="outbound">面板连接 Agent</SelectItem>
                <SelectItem value="inbound">Agent 连接面板</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(server.agent.mode || 'outbound') === 'inbound' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="e-panel">面板地址（Agent 回连）</Label>
              <Input id="e-panel" defaultValue={server.agent.panelUrl} />
            </div>
          ) : (
            <div className="grid w-[110px] gap-1.5">
              <Label htmlFor="e-aPort">Agent 端口</Label>
              <Input id="e-aPort" defaultValue={String(server.agent.port || 3099)} />
            </div>
          )}
          <p className="text-[11px] leading-snug text-muted-foreground sm:col-span-2">
            连接方式建好后不可改；如需更换请删除后重新添加。
          </p>
          {(server.agent.mode || 'outbound') === 'outbound' && (
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <Checkbox
                className="mt-0.5"
                checked={editTls}
                onCheckedChange={(v) => setEditTls(v === true)}
              />
              <span>
                使用 TLS 加密（wss）
                <span className="block text-xs text-muted-foreground">
                  改动后需重新安装 Agent 才会生效（安装时生成证书并记录指纹）。
                </span>
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
                const isOutbound = (server.agent.mode || 'outbound') === 'outbound';
                const body: Record<string, unknown> = {
                  name: val('e-name'),
                  host: val('e-host').trim(),
                  sshPort: val('e-port'),
                  sshUser: val('e-user').trim(),
                  ...(isOutbound
                    ? { agentPort: val('e-aPort').trim(), agentTls: editTls }
                    : { panelUrl: val('e-panel').trim() }),
                };
                const pass = val('e-pass');
                if (pass) body.sshPassword = pass;
                await api(`/servers/${server.id}`, { method: 'PUT', body });
                onOpenChange(false);
                success('已保存');
                onSaved();
              } catch (e) {
                error('保存失败', errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Token 查看 ----------

export function TokenDialog({
  server,
  open,
  onOpenChange,
}: {
  server: ServerSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    api<ServerSummary>(`/servers/${server.id}?token=1`)
      .then((s) => setToken(s.token || ''))
      .catch(() => setToken(''));
  }, [open, server.id]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>服务器 Token</DialogTitle>
          <DialogDescription>Agent 与面板加密通道的共享密钥，请妥善保管。</DialogDescription>
        </DialogHeader>
        <code className="block break-all rounded-md border bg-muted/50 p-3 font-mono text-xs text-primary">
          {token ?? '加载中…'}
        </code>
        <p className="text-xs text-muted-foreground">
          如怀疑泄露，可在「编辑」旁重置 token（需重新安装/更新远程 agent.json 后生效）。
        </p>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 手动安装 ----------

export function ManualInstallDialog({
  server,
  open,
  onOpenChange,
  panelPort,
}: {
  server: ServerSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  panelPort: number;
}) {
  const [cmds, setCmds] = useState('');
  const [panelHostIsLocalOnly, setPanelHostIsLocalOnly] = useState(false);
  useEffect(() => {
    if (!open) return;
    api<ServerSummary>(`/servers/${server.id}?token=1`)
      .then((s) => {
        const h = s.panelHost || '127.0.0.1';
        setPanelHostIsLocalOnly(h === '127.0.0.1' || h === 'localhost' || h === '::1');
      })
      .catch(() => {});
    api<ServerSummary>(`/servers/${server.id}?token=1`)
      .then((s) => {
        const outbound = (s.agent.mode || 'outbound') === 'outbound';
        setCmds(
          [
            `curl -fsSL http://${location.hostname}:${panelPort}/agent.js -o agent.js`,
            outbound
              ? `node agent.js --listen ${s.agent.port || 3099} --token ${s.token} --id ${s.id}` +
                (s.agent.tls ? ` --tls-cert ./cert.pem --tls-key ./key.pem` : '')
              : `node agent.js --panel ${s.agent.panelUrl} --token ${s.token} --id ${s.id}`,
          ].join('\n'),
        );
      })
      .catch((e) => setCmds('加载失败: ' + errText(e)));
  }, [open, server.id, panelPort]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>手动安装 Agent</DialogTitle>
          <DialogDescription>
            适用于 SSH 自动安装失败、或无 root 权限的环境。在目标服务器上执行：
          </DialogDescription>
        </DialogHeader>
        <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs text-primary">
          {cmds || '加载中…'}
        </pre>
        {panelHostIsLocalOnly && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            ⚠ 面板当前只监听本机（127.0.0.1），上面第一条 curl 命令在远程服务器上无法访问面板。
            请改用「安装 Agent（SSH）」自动部署，或把面板以 <code className="font-mono">--host 0.0.0.0</code> 启动后再用手工命令。
          </p>
        )}
        {server.agent.tls && (
          <p className="text-xs text-muted-foreground">
            TLS 已启用：请把安装时生成的 <code className="font-mono">cert.pem</code> /{' '}
            <code className="font-mono">key.pem</code> 放到工作目录，或用自动安装流程。
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          token 等于服务器控制权，请勿泄露。生产环境建议用 systemd 托管（自动安装流程会自动配置）。
        </p>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 新建实例 ----------

/** MSL 镜像署名：MSL 使用条款要求集成其下载服务时在页面注明来源 */
function MslCredit() {
  return (
    <p className="text-[11px] leading-snug text-muted-foreground">
      部分核心镜像下载由{' '}
      <a
        href="https://www.mslmc.cn"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        MSL 开服器
      </a>{' '}
      提供（mslmc.cn）
    </p>
  );
}

export function CreateInstanceDialog({
  server,
  open,
  onOpenChange,
  onCreated,
}: {
  server: ServerSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [source, setSource] = useState<string>('paper');
  const [cores, setCores] = useState<CoreCatalogs | null>(null);
  const [version, setVersion] = useState('');
  const [url, setUrl] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [onlineMode, setOnlineMode] = useState('true');
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [uploadInst, setUploadInst] = useState<string | null>(null); // 第二步：上传核心
  const [uploadItems, setUploadItems] = useState<FileUploadItem[]>([]);
  const [channel, setChannel] = useState<UploadChannel>('channel');
  const [memory, setMemory] = useState('2048'); // 预设值（MB）或 'custom'
  const [customMem, setCustomMem] = useState('');

  // 按服务器物理内存推荐：取一半，向下取 512 的倍数，上限 8GB（为系统与 Agent 留余量）
  const memTotalMB = server.info?.memTotalMB ?? null;
  const recommended = useMemo(() => {
    if (!memTotalMB) return null;
    return Math.max(512, Math.min(8192, Math.floor((memTotalMB * 0.5) / 512) * 512));
  }, [memTotalMB]);

  const resolveMemoryMB = (): number | null => {
    if (memory === 'custom') return Number(customMem);
    return Number(memory);
  };

  useEffect(() => {
    if (!open) return;
    setSource('paper');
    setCores(null);
    setLoadErr('');
    setVersion('');
    setUrl('');
    setVersionLabel('');
    setUploadInst(null);
    setUploadItems([]);
    // 上传通道沿用上次选择；但 SSH 凭据被移除时回退到加密通道
    if (channel === 'sftp' && !(server.ssh.hasPassword || server.ssh.hasKey)) setChannel('channel');
    // 内存默认落在推荐值上（无物理内存信息时退回 2 GB）
    setMemory(String(recommended ?? 2048));
    setCustomMem('');
    api<CoreCatalogs>(`/servers/${server.id}/cores`)
      .then((data) => {
        setCores(data);
        // 默认落在 Paper 的最新版；目录里没有 Paper 就退到第一个可用的核心
        const pick = (id: string) => data.catalogs[id]?.versions?.[0]?.id ?? '';
        setVersion(pick('paper') || pick('vanilla'));
      })
      .catch((e) => setLoadErr(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server.id]);

  /** 当前核心类型的版本目录 */
  const catalog = cores?.catalogs[source] ?? null;
  // 切换核心类型时把版本重置为该类型的第一个；目录还没回来时留空，由下面的 effect 补
  const onSourceChange = (v: string) => {
    setSource(v);
    const c = cores?.catalogs[v];
    setVersion(c && c.versions.length ? c.versions[0].id : '');
  };

  // 目录异步到达后兜底选中一个版本（用户可能在目录返回前就切换过核心类型）
  useEffect(() => {
    if (!catalog || !catalog.ok || catalog.versions.length === 0) return;
    setVersion((cur) => (cur && catalog.versions.some((v) => v.id === cur) ? cur : catalog.versions[0].id));
  }, [catalog]);

  const uploadCore = useCallback(
    async (item: FileUploadItem, file: File) => {
      if (!uploadInst) return;
      if (!/\.jar$/i.test(file.name)) {
        setUploadItems((cur) =>
          cur.map((u) => (u.id === item.id ? { ...u, status: 'error', error: '请上传 .jar 文件' } : u)),
        );
        return;
      }
      try {
        if (channel === 'sftp') {
          await uploadFileViaSftp(server.id, uploadInst, '', file, (pct) =>
            setUploadItems((cur) => cur.map((u) => (u.id === item.id ? { ...u, progress: pct } : u))),
          );
        } else {
          await uploadFile(
            server.id,
            uploadInst,
            '',
            file,
            (pct) => setUploadItems((cur) => cur.map((u) => (u.id === item.id ? { ...u, progress: pct } : u))),
          );
        }
        await api(`/servers/${server.id}/instances/${encodeURIComponent(uploadInst)}/setcore`, {
          method: 'POST',
          body: { filename: file.name },
        });
        setUploadItems((cur) => cur.map((u) => (u.id === item.id ? { ...u, status: 'success', progress: 100 } : u)));
        success('核心已就绪', `${file.name} → server.jar`);
        onOpenChange(false);
        onCreated();
      } catch (e) {
        // 出错不 abort：保留 Agent 侧半成品，「重试」会自动断点续传
        setUploadItems((cur) =>
          cur.map((u) => (u.id === item.id ? { ...u, status: 'error', error: errText(e) } : u)),
        );
        error('上传失败', errText(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server.id, uploadInst, channel],
  );

  const step2 = uploadInst !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {!step2 ? (
          <>
            <DialogHeader>
              <DialogTitle>新建 MC 实例</DialogTitle>
              <DialogDescription>
                选一个服务端核心，面板会自动下载安装（Fabric/Forge/NeoForge 会跑官方安装器，耗时稍长）；
                也可以填直链或上传本地 .jar。
              </DialogDescription>
              <MslCredit />
            </DialogHeader>
            {/* 两列紧凑排布：核心类型/版本、内存/正版验证成对，MOTD 独占整行 */}
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {/* 名称占满剩余宽度，端口按内容收敛为固定窄列 */}
              <div className="flex items-end gap-3 sm:col-span-2">
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <Label htmlFor="c-name">实例名称</Label>
                  <Input id="c-name" placeholder="survival" />
                </div>
                <div className="grid w-[104px] shrink-0 gap-1.5">
                  <Label htmlFor="c-port">端口</Label>
                  <Input id="c-port" defaultValue="25565" />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>核心类型</Label>
                <Select value={source} onValueChange={onSourceChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(cores?.kinds ?? FALLBACK_KINDS).map((k) => (
                      <SelectItem key={k.id} value={k.id}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-snug text-muted-foreground">{CORE_HINT[source] ?? ''}</p>
              </div>
              {source === 'url' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="c-url">核心下载 URL</Label>
                  <Input
                    id="c-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://... 直链 .jar"
                  />
                </div>
              ) : source === 'upload' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="c-vlabel2">版本名称（显示用，可留空）</Label>
                  <Input
                    id="c-vlabel2"
                    value={versionLabel}
                    onChange={(e) => setVersionLabel(e.target.value)}
                    placeholder="paper-1.21"
                  />
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    创建后会进入上传步骤，选择本地 .jar 即可。
                  </p>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label>MC 版本</Label>
                  {loadErr ? (
                    <p className="text-xs text-destructive">核心目录加载失败：{loadErr}</p>
                  ) : !catalog ? (
                    <div className="h-9 animate-pulse rounded-md bg-muted" />
                  ) : !catalog.ok ? (
                    <p className="text-xs text-destructive">
                      {catalog.error || '该核心的版本目录不可用'}
                      ，可改用「自定义 URL」或「上传本地核心」。
                    </p>
                  ) : (
                    <>
                      {catalog.stale && (
                        <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                          当前为缓存的目录（在线清单获取失败）；安装时若同样受限，建议改用自定义 URL 或上传本地核心。
                        </p>
                      )}
                      <Select value={version} onValueChange={setVersion}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="选择版本" />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          {catalog.versions.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {v.id}
                              {v.id === catalog.latest ? '（最新）' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  )}
                </div>
              )}
              {source === 'url' && (
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="c-vlabel">版本名称（显示用，可留空）</Label>
                  <Input
                    id="c-vlabel"
                    value={versionLabel}
                    onChange={(e) => setVersionLabel(e.target.value)}
                    placeholder="paper-1.21"
                  />
                </div>
              )}

              <div className="grid gap-1.5">
                <Label>最大内存</Label>
                <Select value={memory} onValueChange={setMemory}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {recommended && (
                      <SelectItem value={String(recommended)}>{fmtMB(recommended)}（推荐）</SelectItem>
                    )}
                    <SelectItem value="512">512 MB</SelectItem>
                    <SelectItem value="1024">1 GB</SelectItem>
                    <SelectItem value="2048">2 GB</SelectItem>
                    <SelectItem value="4096">4 GB</SelectItem>
                    <SelectItem value="8192">8 GB</SelectItem>
                    <SelectItem value="16384">16 GB</SelectItem>
                    <SelectItem value="custom">自定义…</SelectItem>
                  </SelectContent>
                </Select>
                {memory === 'custom' && (
                  <Input
                    inputMode="numeric"
                    value={customMem}
                    onChange={(e) => setCustomMem(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="输入确切内存（MB），如 1536"
                  />
                )}
              </div>
              <div className="grid gap-1.5">
                <Label>正版验证 (online-mode)</Label>
                <Select value={onlineMode} onValueChange={setOnlineMode}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">开启</SelectItem>
                    <SelectItem value="false">关闭（离线模式）</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="c-motd">MOTD</Label>
                <Input id="c-motd" defaultValue="A Minecraft Server" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={eula} onCheckedChange={(v) => setEula(v === true)} />
              <span>
                我已阅读并同意{' '}
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
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (!eula) {
                    error('需要先同意 EULA');
                    return;
                  }
                  const memMB = resolveMemoryMB();
                  if (!memMB || memMB < 512 || memMB > 32768) {
                    error('内存需在 512 - 32768 MB 之间');
                    return;
                  }
                  setBusy(true);
                  try {
                    const val = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value ?? '';
                    const body: Record<string, unknown> = {
                      name: val('c-name').trim(),
                      port: Number(val('c-port')),
                      source,
                      memoryMB: memMB,
                      onlineMode: onlineMode === 'true',
                      motd: val('c-motd'),
                      eula: true,
                    };
                    if (source === 'url') {
                      if (!url.trim()) {
                        error('请填写核心下载 URL');
                        setBusy(false);
                        return;
                      }
                      body.url = url.trim();
                      body.version = versionLabel.trim();
                    } else if (source === 'upload') {
                      body.version = versionLabel.trim();
                    } else {
                      if (!version) {
                        error('请选择 MC 版本');
                        setBusy(false);
                        return;
                      }
                      body.version = version;
                      // Forge/NeoForge 的目录项里带完整 maven 版本，用它精确定位构建
                      const hit = catalog?.versions.find((v) => v.id === version);
                      if (hit?.build) body.build = hit.build;
                    }
                    const name = body.name as string;
                    await api(`/servers/${server.id}/instances`, { method: 'POST', body });
                    if (source === 'upload') {
                      setUploadInst(name);
                      success('实例已创建', '上传你的服务端核心（.jar）');
                    } else {
                      onOpenChange(false);
                      success('创建中', INSTALLER_SOURCES.has(source) ? '正在下载并运行安装器，请留意控制台' : 'server.jar 开始下载');
                      onCreated();
                    }
                  } catch (e) {
                    error('创建失败', errText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {source === 'upload' ? '创建并上传' : '创建'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>上传服务端核心 · {uploadInst}</DialogTitle>
              <DialogDescription>上传完成后自动重命名为 server.jar；也可以稍后在「文件管理」中上传。</DialogDescription>
            </DialogHeader>
            <UploadChannelSelect server={server} value={channel} onChange={setChannel} />
            <FileUpload
              value={uploadItems}
              onValueChange={setUploadItems}
              onFilesAdded={(added, files) => files.forEach((f, i) => uploadCore(added[i], f))}
              onRetry={(item) => item.file && uploadCore(item, item.file)}
              accept=".jar"
              maxFiles={1}
              title="拖拽 .jar 到此处，或点击选择"
              description={
                channel === 'sftp' ? 'SFTP 直传到实例根目录，无大小限制' : '服务端核心（server.jar）'
              }
              browseLabel="选择文件"
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  onCreated();
                }}
              >
                稍后上传，先关闭
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- 编辑实例（备注 / 连接地址） ----------

export function EditInstanceDialog({
  server,
  instance,
  open,
  onOpenChange,
  onSaved,
}: {
  server: ServerSummary;
  instance: Instance | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [note, setNote] = useState('');
  const [address, setAddress] = useState('');
  const [memory, setMemory] = useState('2048'); // 预设值（MB）或 'custom'
  const [customMem, setCustomMem] = useState('');
  const [busy, setBusy] = useState(false);

  // 按服务器物理内存推荐：取一半，向下取 512 的倍数，上限 8GB（为系统与 Agent 留余量）
  const memTotalMB = server.info?.memTotalMB ?? null;
  const recommended = useMemo(() => {
    if (!memTotalMB) return null;
    return Math.max(512, Math.min(8192, Math.floor((memTotalMB * 0.5) / 512) * 512));
  }, [memTotalMB]);

  useEffect(() => {
    if (open && instance) {
      setNote(instance.note || '');
      setAddress(instance.address || '');
      const cur = Math.round(instance.memoryMB);
      // 命中预设就用预设，否则走自定义框
      const presets = [512, 1024, 2048, 4096, 8192, 16384];
      if (presets.includes(cur)) {
        setMemory(String(cur));
        setCustomMem('');
      } else {
        setMemory('custom');
        setCustomMem(String(cur));
      }
    }
  }, [open, instance]);

  if (!instance) return null;

  const resolveMemoryMB = (): number => (memory === 'custom' ? Number(customMem) : Number(memory));
  // 运行中的实例改内存要重启才生效
  const running = instance.status === 'running' || instance.status === 'starting';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑实例 · {instance.name}</DialogTitle>
          <DialogDescription>备注与连接地址只影响面板展示，不改变服务端配置。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ei-note">备注</Label>
            <Textarea
              id="ei-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：生存服，每周日凌晨重启"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ei-addr">连接地址（可选）</Label>
            <Input
              id="ei-addr"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="例如：mc.example.com 或 play.example.com:25565"
            />
            <p className="text-xs text-muted-foreground">
              填了之后会显示在实例卡片 IP 后面的括号里，方便玩家复制连接地址。
            </p>
          </div>
          <div className="grid gap-2">
            <Label>最大内存</Label>
            <Select value={memory} onValueChange={setMemory}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {recommended && (
                  <SelectItem value={String(recommended)}>{fmtMB(recommended)}（推荐）</SelectItem>
                )}
                <SelectItem value="512">512 MB</SelectItem>
                <SelectItem value="1024">1 GB</SelectItem>
                <SelectItem value="2048">2 GB</SelectItem>
                <SelectItem value="4096">4 GB</SelectItem>
                <SelectItem value="8192">8 GB</SelectItem>
                <SelectItem value="16384">16 GB</SelectItem>
                <SelectItem value="custom">自定义…</SelectItem>
              </SelectContent>
            </Select>
            {memory === 'custom' && (
              <Input
                inputMode="numeric"
                value={customMem}
                onChange={(e) => setCustomMem(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="输入确切内存（MB），如 1536"
              />
            )}
            <p className="text-xs text-muted-foreground">
              当前 {fmtMB(instance.memoryMB)}
              {running && ' · 实例正在运行，改动需重启后生效'}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const memMB = resolveMemoryMB();
              if (!memMB || memMB < 512 || memMB > 32768) {
                error('内存需在 512 - 32768 MB 之间');
                setBusy(false);
                return;
              }
              try {
                await api(`/servers/${server.id}/instances/${encodeURIComponent(instance.name)}`, {
                  method: 'PUT',
                  body: { note, address, memoryMB: memMB },
                });
                success('已保存', running ? '内存改动将在下次启动生效' : undefined);
                onOpenChange(false);
                onSaved();
              } catch (e) {
                error('保存失败', errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 重装核心：用于安装失败的实例。会清掉上次的安装残留再重来，
 * 也可以顺便换核心类型/版本（比如 Paper 装不动就换成原版）。
 */
export function ReinstallDialog({
  server,
  instance,
  open,
  onOpenChange,
  onStarted,
}: {
  server: ServerSummary;
  instance: Instance | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onStarted: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [source, setSource] = useState('');
  const [version, setVersion] = useState('');
  const [cores, setCores] = useState<CoreCatalogs | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !instance) return;
    setSource(instance.source || 'vanilla');
    setVersion(instance.version || '');
    setCores(null);
    setLoadErr('');
    api<CoreCatalogs>(`/servers/${server.id}/cores`)
      .then(setCores)
      .catch((e) => setLoadErr(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, instance?.name]);

  if (!instance) return null;
  const catalog = cores?.catalogs[source] ?? null;
  const onSourceChange = (v: string) => {
    setSource(v);
    const c = cores?.catalogs[v];
    setVersion(c && c.versions.length ? c.versions[0].id : '');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重装核心 · {instance.name}</DialogTitle>
          <DialogDescription>
            会先清掉上次安装的残留文件，再重新下载安装。世界存档、server.properties 与实例设置都会保留。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {instance.error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
              上次失败：{instance.error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>核心类型</Label>
              <Select value={source} onValueChange={onSourceChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FALLBACK_KINDS.filter((k) => k.api).map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>MC 版本</Label>
              {loadErr ? (
                <p className="text-xs text-destructive">目录加载失败：{loadErr}</p>
              ) : !catalog ? (
                <div className="h-9 animate-pulse rounded-md bg-muted" />
              ) : !catalog.ok || !catalog.versions.length ? (
                <p className="text-xs text-muted-foreground">该核心目录不可用</p>
              ) : (
                <Select value={version} onValueChange={setVersion}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择版本" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {catalog.versions.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {CORE_HINT[source] ?? ''}。若当前网络装不了某个核心，换个类型再试通常就能装上。
          </p>
          <MslCredit />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              if (!version) {
                error('请选择 MC 版本');
                return;
              }
              setBusy(true);
              try {
                const hit = catalog?.versions.find((v) => v.id === version);
                await api(`/servers/${server.id}/instances/${encodeURIComponent(instance.name)}/reinstall`, {
                  method: 'POST',
                  body: { source, version, build: hit?.build ?? '' },
                });
                success('已开始重装', '进度见下方控制台');
                onOpenChange(false);
                onStarted();
              } catch (e) {
                error('重装失败', errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <RotateCw className="h-4 w-4" /> 开始重装
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 危险操作确认 ----------

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: ReactNode;
  onConfirm: () => Promise<void>;
}) {
  const { error } = useToastHelpers();
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (err) {
                error(errText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            确认
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { fmtMB };
