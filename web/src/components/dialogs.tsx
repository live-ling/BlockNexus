// 全部弹窗：添加/编辑服务器、Token、手动安装、新建实例、危险操作确认

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, RotateCw } from 'lucide-react';
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
import { api, errText, fmtMB, instanceIconUrl, setInstanceIcon, CORE_LABEL, INSTALLER_SOURCES, type CoreCatalogs, type Instance, type ServerSummary, type SshCheckResult } from '@/lib/api';
import { uploadFile, uploadFileViaSftp } from '@/lib/upload';
import { $, type TranslationKey } from '@/lib/i18n';
import { UploadChannelSelect, type UploadChannel } from '@/components/upload-channel';
import { useToastHelpers } from '@/lib/toast';
import { FileUpload, type FileUploadItem } from '@/components/motion/file-upload';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';

// 目录还没拉回来时也保证下拉里有得选（顺序与后端 CORE_KINDS 一致）
// ⚠ 只存 id：显示名在渲染期经 kindLabel() 取，模块顶层取词会把语言固化
const FALLBACK_KINDS: { id: string; api: boolean; label?: string }[] = [
  { id: 'vanilla', api: true },
  { id: 'paper', api: true },
  { id: 'purpur', api: true },
  { id: 'folia', api: true },
  { id: 'fabric', api: true },
  { id: 'forge', api: true },
  { id: 'neoforge', api: true },
  { id: 'url', api: false },
  { id: 'upload', api: false },
];

/** 核心类型显示名：目录已返回时用后端的 label，兜底项按 id 查 CORE_LABEL（渲染期取词） */
function kindLabel(k: { id: string; label?: string }): string {
  return k.label ?? CORE_LABEL[k.id] ?? k.id;
}

/**
 * 核心类型 → i18n 键。
 * ⚠ 存**键**而不是翻译后的文案：`$()` 在调用时按当前语言取词，
 * 若在这里就求值，模块加载时的语言会被永久固化（切语言后不生效）。
 */
const CORE_HINT_KEY: Record<string, TranslationKey> = {
  vanilla: 'core.hint.vanilla',
  paper: 'core.hint.paper',
  purpur: 'core.hint.purpur',
  folia: 'core.hint.folia',
  fabric: 'core.hint.fabric',
  forge: 'core.hint.forge',
  neoforge: 'core.hint.neoforge',
  url: 'core.hint.url',
  upload: 'core.hint.upload',
};

/** 取核心类型说明（渲染时调用，跟随当前语言）；未知类型返回空串 */
function coreHint(source: string): string {
  const key = CORE_HINT_KEY[source];
  return key ? $(key) : '';
}

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
      error($('addServer.error.hostRequired'));
      return;
    }
    if (auth === 'password' && !val('add-pass')) {
      error($('addServer.error.passwordRequired'));
      return;
    }
    if (auth === 'key' && !val('add-key').trim()) {
      error($('addServer.error.keyRequired'));
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
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{$('addServer.title')}</DialogTitle>
          <DialogDescription>
            {$('addServer.description')}
          </DialogDescription>
        </DialogHeader>
        {/* 表单区自身滚动（no-scrollbar 隐藏滚动条）：未溢出贴合内容，超出即滚，底栏固定可见 */}
        <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {/* 双列紧凑排布：主机/端口、用户/认证方式成对，密码与私钥独占整行 */}
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="add-name">{$('addServer.name')}</Label>
            <Input id="add-name" className="sm:max-w-sm" placeholder={$('addServer.name.placeholder')} />
          </div>

          {/* 主机占满剩余宽度，端口按内容收敛为固定窄列 */}
          <div className="flex items-end gap-3 sm:col-span-2">
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Label htmlFor="add-host">{$('addServer.sshHost')}</Label>
              <Input id="add-host" placeholder="1.2.3.4" onChange={invalidate} />
            </div>
            <div className="grid w-[110px] shrink-0 gap-1.5">
              <Label htmlFor="add-port">{$('addServer.sshPort')}</Label>
              <Input id="add-port" defaultValue="22" onChange={invalidate} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="add-user">{$('addServer.sshUser')}</Label>
            <Input id="add-user" defaultValue="root" onChange={invalidate} />
          </div>
          <div className="grid gap-1.5">
            <Label>{$('addServer.auth')}</Label>
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
                <SelectItem value="password">{$('addServer.auth.password')}</SelectItem>
                <SelectItem value="key">{$('addServer.auth.key')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {auth === 'password' ? (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="add-pass">{$('addServer.sshPassword')}</Label>
              <Input
                id="add-pass"
                type="password"
                className="sm:max-w-sm"
                onChange={invalidate}
              />
            </div>
          ) : (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="add-key">{$('addServer.keyPath')}</Label>
              <Textarea
                id="add-key"
                rows={3}
                placeholder={$('addServer.keyPath.placeholder')}
                onChange={invalidate}
              />
            </div>
          )}

          {/* 验证结果：连接成功展示环境预检，失败展示原因 */}
          {check && !check.ok && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive sm:col-span-2">
              {$('addServer.check.failed', check.error || $('dialog.cannotConnect'))}
            </p>
          )}
          {check?.ok && (
            <div className="grid gap-1.5 rounded-md border bg-muted/40 px-3 py-2.5 text-xs sm:col-span-2">
              {check.local ? (
                <span className="text-primary">{$('addServer.check.local')}</span>
              ) : (
                <>
                  <span className="text-primary">{$('addServer.check.ok', check.user ?? '')}</span>
                  <span className="text-muted-foreground">
                    {$('addServer.check.system', check.os || $('dialog.unknown'), check.arch || '—')}
                  </span>
                  <span className="text-muted-foreground">
                    {$('addServer.check.privilege',
                      check.isRoot
                        ? $('addServer.check.root')
                        : check.sudoOk
                          ? $('addServer.check.sudo')
                          : $('addServer.check.user'))}
                    {' · '}{$('addServer.check.node', check.node || $('dialog.notInstalled'))}
                    {' · '}{$('addServer.check.java', check.javaMajor ? `Java ${check.javaMajor}` : $('dialog.notInstalled'))}
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
                <Label>{$('addServer.mode')}</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as 'outbound' | 'inbound')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="outbound">{$('addServer.mode.outbound')}</SelectItem>
                    <SelectItem value="inbound">{$('addServer.mode.inbound')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid w-[110px] gap-1.5">
                <Label htmlFor="add-aPort">{$('addServer.agentPort')}</Label>
                <Input id="add-aPort" defaultValue={AGENT_PORT} />
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground sm:col-span-2">
                {$('addServer.agentPort.hint')}
              </p>
              <label className="flex items-start gap-2 text-sm sm:col-span-2">
                <Checkbox
                  className="mt-0.5"
                  checked={useTls}
                  onCheckedChange={(v) => setUseTls(v === true)}
                />
                <span>
                  {$('addServer.tls')}
                  <span className="block text-xs text-muted-foreground">
                    {$('addServer.tls.hint')}
                  </span>
                </span>
              </label>
            </>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label>{$('addServer.mode')}</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as 'outbound' | 'inbound')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="outbound">{$('addServer.mode.outbound')}</SelectItem>
                    <SelectItem value="inbound">{$('addServer.mode.inbound')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="add-panel">{$('addServer.panelUrl')}</Label>
                <Input id="add-panel" defaultValue={defaultPanel} />
              </div>
              <p className="text-[11px] leading-snug text-amber-500/90 sm:col-span-2">
                {$('addServer.panelUrl.hint')}
              </p>
            </>
          )}
        </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {$('common.cancel')}
          </Button>
          <Button variant="secondary" disabled={checking || busy} onClick={doCheck}>
            {checking ? $('addServer.verifying') : check?.ok ? $('addServer.reverify') : $('addServer.verify')}
          </Button>
          <Button
            disabled={busy || checking || !check?.ok}
            title={check?.ok ? undefined : $('addServer.verify.first')}
            onClick={async () => {
              setBusy(true);
              try {
                const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
                const body = {
                  name: val('add-name') || $('dialog.unnamed'),
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
                if (!body.host) throw new Error($('addServer.error.hostRequired'));
                const s = await api<ServerSummary>('/servers', { method: 'POST', body });
                onOpenChange(false);
                onCreated(s);
              } catch (e) {
                error($('addServer.error.addFailed'), errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {$('common.save')}
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
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{$('editServer.title')}</DialogTitle>
        </DialogHeader>
        {/* 表单区自身滚动，底栏固定（与添加弹窗一致） */}
        <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {/* 与添加弹窗一致：双列紧凑排布，端口等短字段按内容收敛宽度 */}
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="e-name">{$('addServer.name')}</Label>
            <Input id="e-name" className="sm:max-w-sm" defaultValue={server.name} />
          </div>
          {/* 主机占满剩余宽度，端口按内容收敛为固定窄列 */}
          <div className="flex items-end gap-3 sm:col-span-2">
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Label htmlFor="e-host">{$('addServer.sshHost')}</Label>
              <Input id="e-host" defaultValue={server.host} />
            </div>
            <div className="grid w-[110px] shrink-0 gap-1.5">
              <Label htmlFor="e-port">{$('addServer.sshPort')}</Label>
              <Input id="e-port" defaultValue={String(server.ssh.port)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="e-user">{$('addServer.sshUser')}</Label>
            <Input id="e-user" defaultValue={server.ssh.user} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="e-pass">{$('editServer.sshPassword')}</Label>
            <Input id="e-pass" type="password" placeholder="••••••" />
          </div>
          <div className="grid gap-1.5">
            <Label>{$('addServer.mode')}</Label>
            <Select value={server.agent.mode || 'outbound'} disabled>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="outbound">{$('editServer.mode.outbound')}</SelectItem>
                <SelectItem value="inbound">{$('editServer.mode.inbound')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(server.agent.mode || 'outbound') === 'inbound' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="e-panel">{$('addServer.panelUrl')}</Label>
              <Input id="e-panel" defaultValue={server.agent.panelUrl} />
            </div>
          ) : (
            <div className="grid w-[110px] gap-1.5">
              <Label htmlFor="e-aPort">{$('addServer.agentPort')}</Label>
              <Input id="e-aPort" defaultValue={String(server.agent.port || 3099)} />
            </div>
          )}
          <p className="text-[11px] leading-snug text-muted-foreground sm:col-span-2">
            {$('editServer.mode.hint')}
          </p>
          {(server.agent.mode || 'outbound') === 'outbound' && (
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <Checkbox
                className="mt-0.5"
                checked={editTls}
                onCheckedChange={(v) => setEditTls(v === true)}
              />
              <span>
                {$('addServer.tls')}
                <span className="block text-xs text-muted-foreground">
                  {$('editServer.tls.hint')}
                </span>
              </span>
            </label>
          )}
        </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {$('common.cancel')}
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
                success($('common.saved'));
                onSaved();
              } catch (e) {
                error($('editServer.error.saveFailed'), errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {$('common.save')}
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
          <DialogTitle>{$('token.title')}</DialogTitle>
          <DialogDescription>{$('token.description')}</DialogDescription>
        </DialogHeader>
        <code className="block break-all rounded-md border bg-muted/50 p-3 font-mono text-xs text-primary">
          {token ?? $('common.loading')}
        </code>
        <p className="text-xs text-muted-foreground">
          {$('token.hint')}
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
    // 这里只读 panelHost，**不要**带 ?token=1：带了就会把 Agent token 拉进响应体，
    // 而这份数据用不上——凭据应当只在真正需要它的那一次请求里出现（见下方安装命令处）。
    api<ServerSummary>(`/servers/${server.id}`)
      .then((s) => {
        const h = s.panelHost || '127.0.0.1';
        setPanelHostIsLocalOnly(h === '127.0.0.1' || h === 'localhost' || h === '::1');
      })
      .catch(() => {});
    // 这一处要用 s.token 拼安装命令，所以确实需要 ?token=1
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
      .catch((e) => setCmds($('manualInstall.loadFailed', errText(e))));
  }, [open, server.id, panelPort]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{$('manualInstall.title')}</DialogTitle>
          <DialogDescription>
            {$('manualInstall.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1 grid content-start gap-4">
        <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs text-primary">
          {cmds || $('common.loading')}
        </pre>
        {panelHostIsLocalOnly && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {$('manualInstall.localOnly.warn')}{' '}
            {$('manualInstall.localOnly.fix.pre')}<code className="font-mono">--host 0.0.0.0</code>{$('manualInstall.localOnly.fix.post')}
          </p>
        )}
        {server.agent.tls && (
          <p className="text-xs text-muted-foreground">
            {$('manualInstall.tls.warn.pre')}<code className="font-mono">cert.pem</code>
            {$('manualInstall.tls.warn.mid')}
            <code className="font-mono">key.pem</code>{$('manualInstall.tls.warn.post')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {$('manualInstall.tokenWarn')}
        </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 新建实例 ----------

/** MSL 镜像署名：MSL 使用条款要求集成其下载服务时在页面注明来源 */
function MslCredit() {
  return (
    <p className="text-[11px] leading-snug text-muted-foreground">
      {$('msl.credit.pre')}
      <a
        href="https://www.mslmc.cn"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        {$('msl.credit.name')}
      </a>
      {$('msl.credit.post')}
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
          cur.map((u) => (u.id === item.id ? { ...u, status: 'error', error: $('createInstance.upload.needJar') } : u)),
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
        success($('createInstance.upload.ready'), $('createInstance.upload.readyDetail', file.name));
        onOpenChange(false);
        onCreated();
      } catch (e) {
        // 出错不 abort：保留 Agent 侧半成品，「重试」会自动断点续传
        setUploadItems((cur) =>
          cur.map((u) => (u.id === item.id ? { ...u, status: 'error', error: errText(e) } : u)),
        );
        error($('createInstance.upload.failed'), errText(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server.id, uploadInst, channel],
  );

  const step2 = uploadInst !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-2xl">
        {!step2 ? (
          <>
            <DialogHeader className="shrink-0">
              <DialogTitle>{$('createInstance.title')}</DialogTitle>
              <DialogDescription>
                {$('createInstance.description')}
              </DialogDescription>
              <MslCredit />
            </DialogHeader>
            {/* 表单区自身滚动（no-scrollbar 隐藏滚动条），底栏固定 */}
            <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            {/* 两列紧凑排布：核心类型/版本、内存/正版验证成对，MOTD 独占整行 */}
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {/* 名称占满剩余宽度，端口按内容收敛为固定窄列 */}
              <div className="flex items-end gap-3 sm:col-span-2">
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <Label htmlFor="c-name">{$('createInstance.name')}</Label>
                  <Input id="c-name" placeholder="survival" />
                </div>
                <div className="grid w-[104px] shrink-0 gap-1.5">
                  <Label htmlFor="c-port">{$('createInstance.port')}</Label>
                  <Input id="c-port" defaultValue="25565" />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>{$('createInstance.coreType')}</Label>
                <Select value={source} onValueChange={onSourceChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(cores?.kinds ?? FALLBACK_KINDS).map((k) => (
                      <SelectItem key={k.id} value={k.id}>
                        {kindLabel(k)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-snug text-muted-foreground">{coreHint(source)}</p>
              </div>
              {source === 'url' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="c-url">{$('createInstance.url')}</Label>
                  <Input
                    id="c-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={$('createInstance.url.placeholder')}
                  />
                </div>
              ) : source === 'upload' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="c-vlabel2">{$('createInstance.versionLabel')}</Label>
                  <Input
                    id="c-vlabel2"
                    value={versionLabel}
                    onChange={(e) => setVersionLabel(e.target.value)}
                    placeholder="paper-1.21"
                  />
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {$('createInstance.uploadHint')}
                  </p>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label>{$('createInstance.mcVersion')}</Label>
                  {loadErr ? (
                    <p className="text-xs text-destructive">{$('createInstance.catalogLoadFailed', loadErr)}</p>
                  ) : !catalog ? (
                    <div className="h-9 animate-pulse rounded-md bg-muted" />
                  ) : !catalog.ok ? (
                    <p className="text-xs text-destructive">
                      {catalog.error || $('createInstance.catalogUnavailable')}
                      {$('createInstance.catalogUnavailable.suffix')}
                    </p>
                  ) : (
                    <>
                      {catalog.stale && (
                        <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                          {$('createInstance.catalogCached')}
                        </p>
                      )}
                      <Select value={version} onValueChange={setVersion}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={$('createInstance.version.placeholder')} />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          {catalog.versions.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {v.id}
                              {v.id === catalog.latest ? $('createInstance.version.latest') : ''}
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
                  <Label htmlFor="c-vlabel">{$('createInstance.versionLabel')}</Label>
                  <Input
                    id="c-vlabel"
                    value={versionLabel}
                    onChange={(e) => setVersionLabel(e.target.value)}
                    placeholder="paper-1.21"
                  />
                </div>
              )}

              <div className="grid gap-1.5">
                <Label>{$('createInstance.memory')}</Label>
                <Select value={memory} onValueChange={setMemory}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {recommended && (
                      <SelectItem value={String(recommended)}>{$('createInstance.memory.recommended', fmtMB(recommended))}</SelectItem>
                    )}
                    <SelectItem value="512">512 MB</SelectItem>
                    <SelectItem value="1024">1 GB</SelectItem>
                    <SelectItem value="2048">2 GB</SelectItem>
                    <SelectItem value="4096">4 GB</SelectItem>
                    <SelectItem value="8192">8 GB</SelectItem>
                    <SelectItem value="16384">16 GB</SelectItem>
                    <SelectItem value="custom">{$('createInstance.memory.custom')}</SelectItem>
                  </SelectContent>
                </Select>
                {memory === 'custom' && (
                  <Input
                    inputMode="numeric"
                    value={customMem}
                    onChange={(e) => setCustomMem(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder={$('createInstance.memory.customPlaceholder')}
                  />
                )}
              </div>
              <div className="grid gap-1.5">
                <Label>{$('createInstance.onlineMode')}</Label>
                <Select value={onlineMode} onValueChange={setOnlineMode}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">{$('createInstance.onlineMode.on')}</SelectItem>
                    <SelectItem value="false">{$('createInstance.onlineMode.off')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="c-motd">MOTD</Label>
                <Input id="c-motd" defaultValue="A Minecraft Server" />
              </div>
            </div>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-sm">
              <Checkbox checked={eula} onCheckedChange={(v) => setEula(v === true)} />
              <span>
                {$('createInstance.eula.pre')}
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
            <DialogFooter className="shrink-0">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {$('common.cancel')}
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (!eula) {
                    error($('createInstance.error.eula'));
                    return;
                  }
                  const memMB = resolveMemoryMB();
                  if (!memMB || memMB < 512 || memMB > 32768) {
                    error($('createInstance.error.memoryRange'));
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
                        error($('createInstance.error.urlRequired'));
                        setBusy(false);
                        return;
                      }
                      body.url = url.trim();
                      body.version = versionLabel.trim();
                    } else if (source === 'upload') {
                      body.version = versionLabel.trim();
                    } else {
                      if (!version) {
                        error($('createInstance.error.versionRequired'));
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
                      success($('createInstance.toast.created'), $('createInstance.toast.createdDetail'));
                    } else {
                      onOpenChange(false);
                      success($('createInstance.toast.creating'), INSTALLER_SOURCES.has(source)
                        ? $('createInstance.toast.installer')
                        : $('createInstance.toast.downloading'));
                      onCreated();
                    }
                  } catch (e) {
                    error($('createInstance.error.failed'), errText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {source === 'upload' ? $('createInstance.createAndUpload') : $('createInstance.create')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="shrink-0">
              <DialogTitle>{$('createInstance.upload.title', uploadInst ?? '')}</DialogTitle>
              <DialogDescription>{$('createInstance.upload.description')}</DialogDescription>
            </DialogHeader>
            <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            <UploadChannelSelect server={server} value={channel} onChange={setChannel} />
            <FileUpload
              value={uploadItems}
              onValueChange={setUploadItems}
              onFilesAdded={(added, files) => files.forEach((f, i) => uploadCore(added[i], f))}
              onRetry={(item) => item.file && uploadCore(item, item.file)}
              accept=".jar"
              maxFiles={1}
              title={$('createInstance.upload.dropzone')}
              description={
                channel === 'sftp' ? $('createInstance.upload.sftp') : $('createInstance.upload.jar')
              }
              browseLabel={$('createInstance.upload.browse')}
            />
            </div>
            <DialogFooter className="shrink-0">
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  onCreated();
                }}
              >
                {$('createInstance.upload.later')}
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
  // server-icon：预览缓存戳 / 404 标记 / 上传中 / 裁切源图
  const [iconV, setIconV] = useState(0);
  const [iconMissing, setIconMissing] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const iconFileRef = useRef<HTMLInputElement>(null);

  const applyIcon = async (b64: string) => {
    setIconBusy(true);
    try {
      await setInstanceIcon(server.id, instance?.name ?? '', b64);
      setIconMissing(false);
      setIconV(Date.now());
      setCropSrc(null);
      success($('editInstance.toast.iconUpdated'), $('editInstance.toast.iconUpdatedDetail'));
    } catch (e) {
      error($('editInstance.error.iconUpload'), errText(e));
    } finally {
      setIconBusy(false);
    }
  };

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
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>{$('editInstance.title', instance.name)}</DialogTitle>
          <DialogDescription>{$('editInstance.description')}</DialogDescription>
        </DialogHeader>
        <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1 grid content-start gap-4">
          <div className="flex items-center gap-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border bg-muted/40">
              {!iconMissing ? (
                <img
                  src={instanceIconUrl(server.id, instance.name) + '?v=' + iconV}
                  alt="server-icon"
                  className="h-full w-full object-cover"
                  onError={() => setIconMissing(true)}
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-muted-foreground">
                  <ImagePlus className="h-5 w-5" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">{$('editInstance.icon')}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {$('editInstance.icon.hint')}
              </p>
              <input
                ref={iconFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setCropSrc(URL.createObjectURL(f));
                  e.target.value = '';
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                disabled={iconBusy}
                onClick={() => iconFileRef.current?.click()}
              >
                <ImagePlus className="h-3.5 w-3.5" />
                {iconBusy ? $('editInstance.icon.uploading') : $('editInstance.icon.change')}
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ei-note">{$('editInstance.note')}</Label>
            <Textarea
              id="ei-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={$('editInstance.note.placeholder')}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ei-addr">{$('editInstance.address')}</Label>
            <Input
              id="ei-addr"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={$('editInstance.address.placeholder')}
            />
            <p className="text-xs text-muted-foreground">
              {$('editInstance.address.hint')}
            </p>
          </div>
          <div className="grid gap-2">
            <Label>{$('createInstance.memory')}</Label>
            <Select value={memory} onValueChange={setMemory}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {recommended && (
                  <SelectItem value={String(recommended)}>{$('createInstance.memory.recommended', fmtMB(recommended))}</SelectItem>
                )}
                <SelectItem value="512">512 MB</SelectItem>
                <SelectItem value="1024">1 GB</SelectItem>
                <SelectItem value="2048">2 GB</SelectItem>
                <SelectItem value="4096">4 GB</SelectItem>
                <SelectItem value="8192">8 GB</SelectItem>
                <SelectItem value="16384">16 GB</SelectItem>
                <SelectItem value="custom">{$('createInstance.memory.custom')}</SelectItem>
              </SelectContent>
            </Select>
            {memory === 'custom' && (
              <Input
                inputMode="numeric"
                value={customMem}
                onChange={(e) => setCustomMem(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={$('createInstance.memory.customPlaceholder')}
              />
            )}
            <p className="text-xs text-muted-foreground">
              {$('editInstance.memory.current', fmtMB(instance.memoryMB))}
              {running && $('editInstance.memory.needRestart')}
            </p>
          </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {$('common.cancel')}
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const memMB = resolveMemoryMB();
              if (!memMB || memMB < 512 || memMB > 32768) {
                error($('createInstance.error.memoryRange'));
                setBusy(false);
                return;
              }
              try {
                await api(`/servers/${server.id}/instances/${encodeURIComponent(instance.name)}`, {
                  method: 'PUT',
                  body: { note, address, memoryMB: memMB },
                });
                success($('editInstance.toast.saved'), running ? $('editInstance.toast.savedRestart') : undefined);
                onOpenChange(false);
                onSaved();
              } catch (e) {
                error($('editServer.error.saveFailed'), errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {$('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
      {cropSrc && (
        <IconCropDialog src={cropSrc} onConfirm={(b64) => void applyIcon(b64)} onClose={() => setCropSrc(null)} />
      )}
    </Dialog>
  );
}

/** server-icon 手动裁切：完整显示图片，按住左键拖出正方形选区（可移动/调大小），输出 64×64 PNG */
function IconCropDialog({
  src,
  onConfirm,
  onClose,
}: {
  src: string;
  onConfirm: (b64: string) => void;
  onClose: () => void;
}) {
  const VIEW_W = 336;
  const VIEW_H = 336;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  // 图片显示区域（VIEW 内居中的 contain 矩形）
  const [disp, setDisp] = useState({ x: 0, y: 0, w: 0, h: 0 });
  // 正方形选区（VIEW 坐标）；加载完成后默认取图片内最大居中方块
  const [sel, setSel] = useState({ x: 0, y: 0, size: 0 });
  const drag = useRef<{
    mode: 'draw' | 'move';
    px: number;
    py: number;
    ax: number;
    ay: number;
    sx: number;
    sy: number;
    size: number;
  } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const scale = Math.min(VIEW_W / img.width, VIEW_H / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (VIEW_W - w) / 2;
      const y = (VIEW_H - h) / 2;
      setDisp({ x, y, w, h });
      setSel({ x, y, size: Math.min(w, h) });
      setReady(true);
    };
    img.src = src;
    return () => {
      imgRef.current = null;
      setReady(false);
    };
  }, [src]);

  const clampSel = (x: number, y: number, size: number) => {
    const size2 = Math.min(size, disp.w, disp.h);
    return {
      x: Math.max(disp.x, Math.min(x, disp.x + disp.w - size2)),
      y: Math.max(disp.y, Math.min(y, disp.y + disp.h - size2)),
      size: size2,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const inside =
      px >= sel.x && px <= sel.x + sel.size && py >= sel.y && py <= sel.y + sel.size;
    if (inside) {
      drag.current = { mode: 'move', px, py, ax: 0, ay: 0, sx: sel.x, sy: sel.y, size: sel.size };
    } else {
      const ax = Math.max(disp.x, Math.min(px, disp.x + disp.w));
      const ay = Math.max(disp.y, Math.min(py, disp.y + disp.h));
      drag.current = { mode: 'draw', px, py, ax, ay, sx: 0, sy: 0, size: 0 };
      setSel(clampSel(ax, ay, 0));
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (d.mode === 'move') {
      setSel(clampSel(d.sx + (px - d.px), d.sy + (py - d.py), d.size));
      return;
    }
    // 画新选区：边长取两轴位移的较大者，方向跟随拖动，越界自动收
    const dx = px - d.ax;
    const dy = py - d.ay;
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    const x = dx < 0 ? d.ax - size : d.ax;
    const y = dy < 0 ? d.ay - size : d.ay;
    setSel(clampSel(x, y, size));
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const confirm = () => {
    const img = imgRef.current;
    if (!img || !sel.size) return;
    const scale = Math.min(VIEW_W / img.width, VIEW_H / img.height);
    const sx = (sel.x - disp.x) / scale;
    const sy = (sel.y - disp.y) / scale;
    const ssize = sel.size / scale;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, sx, sy, ssize, ssize, 0, 0, 64, 64);
    const url = canvas.toDataURL('image/png');
    onConfirm(url.slice(url.indexOf(',') + 1));
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{$('iconCrop.title')}</DialogTitle>
          <DialogDescription>
            {$('iconCrop.description')}
          </DialogDescription>
        </DialogHeader>
        <div
          className="relative mx-auto overflow-hidden rounded-lg border bg-muted/40"
          style={{ width: VIEW_W, height: VIEW_H, cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {ready && (
            <img
              src={src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute select-none"
              style={{ left: disp.x, top: disp.y, width: disp.w, height: disp.h }}
            />
          )}
          {sel.size > 0 && (
            <div
              className="absolute cursor-move"
              style={{
                left: sel.x,
                top: sel.y,
                width: sel.size,
                height: sel.size,
                boxShadow: '0 0 0 1px #fff, 0 0 0 9999px rgba(0,0,0,0.45)',
              }}
            >
              <div className="grid h-full w-full grid-cols-3 grid-rows-3">
                {Array.from({ length: 9 }).map((_, i) => (
                  <span key={i} className="border border-white/30" />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{$('iconCrop.size')}</span>
          <input
            type="range"
            min={24}
            max={Math.round(Math.min(disp.w, disp.h)) || 24}
            value={Math.round(sel.size)}
            onChange={(e) => {
              const size = Number(e.target.value);
              const cx = sel.x + sel.size / 2;
              const cy = sel.y + sel.size / 2;
              setSel(clampSel(cx - size / 2, cy - size / 2, size));
            }}
            className="flex-1"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {$('common.cancel')}
          </Button>
          <Button disabled={!ready || !sel.size} onClick={confirm}>
            {$('iconCrop.confirm')}
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
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>{$('reinstall.title', instance.name)}</DialogTitle>
          <DialogDescription>
            {$('reinstall.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1 grid content-start gap-4">
          {instance.error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
              {$('reinstall.lastError', instance.error)}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>{$('createInstance.coreType')}</Label>
              <Select value={source} onValueChange={onSourceChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FALLBACK_KINDS.filter((k) => k.api).map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {kindLabel(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{$('createInstance.mcVersion')}</Label>
              {loadErr ? (
                <p className="text-xs text-destructive">{$('reinstall.catalogLoadFailed', loadErr)}</p>
              ) : !catalog ? (
                <div className="h-9 animate-pulse rounded-md bg-muted" />
              ) : !catalog.ok || !catalog.versions.length ? (
                <p className="text-xs text-muted-foreground">{$('reinstall.catalogUnavailable')}</p>
              ) : (
                <Select value={version} onValueChange={setVersion}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={$('reinstall.version.placeholder')} />
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
            {coreHint(source)}{$('reinstall.hintSuffix')}
          </p>
          <MslCredit />
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {$('common.cancel')}
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              if (!version) {
                error($('reinstall.error.noVersion'));
                return;
              }
              setBusy(true);
              try {
                const hit = catalog?.versions.find((v) => v.id === version);
                await api(`/servers/${server.id}/instances/${encodeURIComponent(instance.name)}/reinstall`, {
                  method: 'POST',
                  body: { source, version, build: hit?.build ?? '' },
                });
                success($('reinstall.toast.started'), $('reinstall.toast.startedDetail'));
                onOpenChange(false);
                onStarted();
              } catch (e) {
                error($('reinstall.error.failed'), errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <RotateCw className="h-4 w-4" /> {$('reinstall.start')}
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
          <AlertDialogCancel>{$('common.cancel')}</AlertDialogCancel>
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
            {$('confirm.ok')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { fmtMB };
