// 面板设置页：登录保护 / 公网访问 / SMTP 邮件 / 通知设置
// 路由 #/settings —— 顶栏「设置」进入（替代原设置模态框）
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Bell, ChevronRight, Globe, Info, Lock, Mail, MailCheck, RefreshCw, Rocket, Sparkles } from 'lucide-react';
import { ThemeToggle } from '@/components/motion/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { aiListModels, aiTest, api, errText, getVersion, type AiTestResult, type AppVersion, type PanelSettings } from '@/lib/api';
import { useToastHelpers } from '@/lib/toast';

// 卡片主题色：图标底色 + 描边，让各设置分区一眼可辨（Tailwind 需静态类名，故用查表）
const ACCENTS = {
  security: 'border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  network: 'border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  mail: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  notify: 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  ai: 'border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  update: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  info: 'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-400',
} as const;

type Accent = keyof typeof ACCENTS;

export function PanelSettingsPage({
  onBack,
  onAuthChanged,
}: {
  onBack: () => void;
  onAuthChanged: (authEnabled: boolean) => void;
}) {
  const { error } = useToastHelpers();
  const [data, setData] = useState<PanelSettings | null>(null);

  const load = useCallback(() => {
    api<Partial<PanelSettings>>('/settings')
      .then((raw) => {
        // 兜底合并：面板是新后端、浏览器缓存了旧前端（或反之）时字段可能缺失
        setData({
          authEnabled: !!raw.authEnabled,
          username: raw.username ?? 'admin',
          domain: raw.domain ?? '',
          adminEmail: raw.adminEmail ?? '',
          smtp: {
            host: raw.smtp?.host ?? '',
            port: raw.smtp?.port ?? 465,
            secure: raw.smtp?.secure ?? true,
            user: raw.smtp?.user ?? '',
            from: raw.smtp?.from ?? '',
            hasPass: raw.smtp?.hasPass ?? false,
          },
          notify: {
            offline: raw.notify?.offline ?? true,
            recovery: raw.notify?.recovery ?? false,
          },
          smtpReady: !!raw.smtpReady,
          ai: {
            enabled: raw.ai?.enabled ?? false,
            baseUrl: raw.ai?.baseUrl ?? '',
            model: raw.ai?.model ?? '',
            hasKey: raw.ai?.hasKey ?? false,
          },
        });
      })
      .catch((e) => error('读取设置失败', errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return <div className="p-10 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 pb-24 pt-8">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">面板设置</h2>
        <div className="ml-auto">
          <ThemeToggle variant="circle-blur" />
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">安全凭据 · 对外访问域名 · SMTP 与通知</p>

      {/* 同排卡片等高（grid 默认 stretch）；内容密度不同的卡片靠留白对齐，避免「矮一截」 */}
      <div className="mt-6 grid grid-cols-12 gap-5">
        <AuthCard data={data} onAuthChanged={onAuthChanged} reload={load} accent="security" className="col-span-12 md:col-span-6" />
        <DomainCard data={data} reload={load} accent="network" className="col-span-12 md:col-span-6" />
        <SmtpCard data={data} reload={load} accent="mail" className="col-span-12 md:col-span-6" />
        <NotifyCard data={data} reload={load} accent="notify" className="col-span-12 md:col-span-6" />
        <AiCard data={data} reload={load} accent="ai" className="col-span-12" />
        <VersionCard accent="update" className="col-span-12 md:col-span-6" />
        <AboutEntryCard accent="info" className="col-span-12 md:col-span-6" />
      </div>
    </div>
  );
}

/** 统一卡片：图标 + 标题 + 说明 + 右上角状态 + 内容 */
function SettingsCard({
  title,
  description,
  icon,
  status,
  accent,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  icon: React.ReactNode;
  status?: React.ReactNode;
  accent?: Accent;
  children: React.ReactNode;
  className?: string;
}) {
  const iconClass = accent ? ACCENTS[accent] : 'bg-muted/60 text-foreground';
  return (
    <Card className={`ring-1 ring-border ${className}`}>
      <CardContent className="flex flex-col gap-4 p-5">
        {/* 头部（固定） */}
        <div className="flex items-center gap-3">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${iconClass}`}>
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <b className="text-sm">{title}</b>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {status && <div className="shrink-0 self-start">{status}</div>}
        </div>
      {/* 内容区拉伸，按钮沉底 */}
      <div className="flex flex-1 flex-col gap-4">
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

/** 设置页底部「关于」入口：跳转 #/about */
function AboutEntryCard({ accent, className = '' }: { accent: Accent; className?: string }) {
  const iconClass = ACCENTS[accent];
  return (
    <Card className={`ring-1 ring-border ${className}`}>
      <button
        type="button"
        onClick={() => (location.hash = '#/about')}
        className="flex w-full items-center gap-3 rounded-xl px-5 py-4 text-left transition-colors hover:bg-muted/50"
      >
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${iconClass}`}>
          <Info className="h-[18px] w-[18px]" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <b className="text-sm">关于 BlockNexus</b>
          <span className="text-xs text-muted-foreground">
            版本信息、引用服务与开源依赖、免责声明
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}

/** 版本与更新：当前版本 + GitHub 最新 Release 对比；进入页面自动检查一次（后端缓存 10 分钟） */
function VersionCard({ accent, className = '' }: { accent: Accent; className?: string }) {
  const { error: toastError } = useToastHelpers();
  const [info, setInfo] = useState<AppVersion | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(
    (refresh: boolean) => {
      setBusy(true);
      getVersion(refresh)
        .then(setInfo)
        .catch((e) => toastError('检查更新失败', errText(e)))
        .finally(() => setBusy(false));
    },
    [toastError],
  );

  useEffect(() => {
    check(false);
  }, [check]);

  const hasUpdate = !!info?.hasUpdate;
  return (
    <SettingsCard
      title="版本与更新"
      description="当前版本与 GitHub 最新 Release 对比"
      icon={<Rocket className="h-[18px] w-[18px]" />}
      accent={accent}
      className={className}
      status={
        info && !busy ? (
          hasUpdate ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              有新版本
            </span>
          ) : (
            <StateChip ok okText="已是最新" badText="" />
          )
        ) : undefined
      }
    >
      <div className="grid gap-x-6 gap-y-1.5 text-xs">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">当前版本</span>
          <span className="font-mono">v{info?.version ?? '…'}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">最新版本</span>
          <span className="font-mono">{info?.latest ? `v${info.latest}` : '—'}</span>
        </div>
        {info?.error && (
          <p className="text-xs leading-snug text-muted-foreground">
            检查失败：{info.error}（无网络或 GitHub 访问受限时不影响使用）
          </p>
        )}
        {hasUpdate && info?.releaseUrl && (
          <a
            href={info.releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-cyan-600 underline underline-offset-2 hover:text-cyan-500 dark:text-cyan-400"
          >
            前往 GitHub 查看新版本 →
          </a>
        )}
      </div>
      <div className="mt-auto flex items-center justify-end pt-1">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => check(true)}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          {busy ? '检查中…' : '检查更新'}
        </Button>
      </div>
    </SettingsCard>
  );
}

/** 开关行：图标 + 标题 + 说明 + 右侧开关 */
function ToggleRow({
  title,
  description,
  icon,
  checked,
  onCheckedChange,
  className = '',
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <label
      className={`flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5 ${className}`}
    >
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </span>
      <Switch
        className="ml-auto shrink-0"
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
      />
    </label>
  );
}

/** 表单字段：标签行内带提示/错误，控件宽度由调用方按需收敛 */
function Field({
  htmlFor,
  label,
  hint,
  error,
  className = '',
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  error?: string;
  /** 用于跨列（如 sm:col-span-2 让字段占满整行） */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`grid content-start gap-1.5 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && !error && <span className="text-[11px] text-muted-foreground">{hint}</span>}
        {error && <span className="text-[11px] text-destructive">{error}</span>}
      </div>
      {children}
    </div>
  );
}

/** 卡片右上角的配置状态小标 */
function StateChip({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        ok
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-border bg-muted/50 text-muted-foreground'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-muted-foreground/60'}`} />
      {ok ? okText : badText}
    </span>
  );
}

// ---------- 登录保护 ----------
function AuthCard({
  data,
  onAuthChanged,
  reload,
  accent,
  className = '',
}: {
  data: PanelSettings;
  onAuthChanged: (authEnabled: boolean) => void;
  reload: () => void;
  accent?: Accent;
  className?: string;
}) {
  const { success, error } = useToastHelpers();
  const [authOn, setAuthOn] = useState(data.authEnabled);
  const [username, setUsername] = useState(data.username);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAuthOn(data.authEnabled);
    setUsername(data.username);
  }, [data.authEnabled, data.username]);

  const newUser = username.trim();
  const userInvalid = authOn && !!newUser && !/^[A-Za-z0-9_.@-]{3,40}$/.test(newUser);
  const userEmpty = authOn && !newUser;
  // 密码：未填表示沿用旧密码（仅原先已启用时允许留空）
  const pwTooShort = authOn && pw1.length > 0 && pw1.length < 6;
  const pw2Mismatch = pw2.length > 0 && pw1 !== pw2;
  // 首次开启保护必须设密码；已开启时留空=保持不变
  const needPassword = authOn && !data.authEnabled;
  const pwMissing = needPassword && pw1.length === 0;
  // 只在用户真的输过东西后才报错，避免刚展开就红字警告；空值靠 hint 引导
  const pw1Error = pwTooShort ? '至少 6 位' : undefined;
  const pwHint = needPassword ? '至少 6 位，保存后需用它登录' : '已设置，留空表示不修改';

  // 没做任何改动时禁用保存（避免空请求）
  const nothingChanged = authOn === data.authEnabled && pw1.length === 0;

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { authEnabled: authOn, username: newUser };
      if (authOn && pw1) body.password = pw1;
      const r = await api<{ authEnabled: boolean }>('/settings', { method: 'PUT', body });
      success(r.authEnabled ? '密码保护已开启' : '密码保护已关闭');
      setPw1('');
      setPw2('');
      onAuthChanged(r.authEnabled);
      reload();
    } catch (e) {
      error('保存失败', errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title="登录保护"
      description="面板是本地服务，默认无需密码；暴露给局域网/公网时建议开启。"
      icon={<Lock className="h-4 w-4" />}
      accent={accent}
      className={className}
      status={
        <div className="flex items-center gap-2">
          <Switch
            className="shrink-0"
            checked={authOn}
            onCheckedChange={(v) => setAuthOn(v === true)}
          />
          <StateChip ok={authOn} okText="已启用" badText="未启用" />
        </div>
      }
    >
      {/* 表单区常驻渲染：开关只切换可用性，卡片高度不随开/关变化。
          关闭时整体置灰并禁用，配合头部「未启用」状态章表达不可用状态。 */}
      <div
        className={`grid gap-3 transition-opacity sm:grid-cols-2 ${
          authOn ? '' : 'pointer-events-none opacity-60'
        }`}
      >
        {/* 用户名跨整行：下方密码/确认才是稳定双列，避免长短行混排错位 */}
        <Field
          htmlFor="ps-user"
          label="用户名"
          hint="3-40 位，可用字母数字与 _ . @ -"
          error={authOn ? userInvalid ? '格式不符合要求' : undefined : undefined}
          className="sm:col-span-2"
        >
          <Input
            id="ps-user"
            autoComplete="username"
            className="sm:max-w-sm"
            disabled={!authOn}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
          />
        </Field>
        <Field
          htmlFor="ps-pw1"
          label="密码"
          hint={pwHint}
          error={authOn ? pw1Error || undefined : undefined}
        >
          <Input
            id="ps-pw1"
            type="password"
            autoComplete="new-password"
            disabled={!authOn}
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
          />
        </Field>
        <Field
          htmlFor="ps-pw2"
          label="确认密码"
          hint="再次输入上面的密码"
          error={authOn ? pw2Mismatch ? '两次输入不一致' : undefined : undefined}
        >
          <Input
            id="ps-pw2"
            type="password"
            autoComplete="new-password"
            disabled={!authOn}
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-auto flex justify-end">
        <Button
          size="sm"
          disabled={busy || nothingChanged || userInvalid || userEmpty || pwTooShort || pwMissing || pw2Mismatch}
          onClick={save}
        >
          保存
        </Button>
      </div>
    </SettingsCard>
  );
}

// ---------- 公网访问 ----------
function DomainCard({
  data,
  reload,
  accent,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
  accent?: Accent;
  className?: string;
}) {
  const { success, error } = useToastHelpers();
  const [domain, setDomain] = useState(data.domain);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDomain(data.domain), [data.domain]);

  return (
    <SettingsCard
      title="公网访问"
      description="面板部署到公网时的对外地址，用于通知邮件与找回密码邮件。"
      icon={<Globe className="h-4 w-4" />}
      accent={accent}
      className={className}
      status={<StateChip ok={!!domain.trim()} okText="已绑定" badText="未绑定" />}
    >
      <Field
        htmlFor="ps-domain"
        label="绑定域名"
        hint="例：panel.example.com 或 https://panel.example.com"
      >
        <Input
          id="ps-domain"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="panel.example.com"
        />
      </Field>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        HTTPS 证书由 nginx 等反向代理负责，面板本身无需配置 SSL；记得让面板监听{' '}
        <code className="font-mono">--host 0.0.0.0</code> 并开启登录保护。
      </p>
      <div className="mt-auto flex justify-end">
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/settings', { method: 'PUT', body: { domain } });
              success('已保存');
              reload();
            } catch (e) {
              error('保存失败', errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </div>
    </SettingsCard>
  );
}

// ---------- SMTP 邮件 ----------
function SmtpCard({
  data,
  reload,
  accent,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
  accent?: Accent;
  className?: string;
}) {
  const { success, error } = useToastHelpers();
  const [host, setHost] = useState(data.smtp.host);
  const [port, setPort] = useState(String(data.smtp.port));
  const [secure, setSecure] = useState(data.smtp.secure);
  const [user, setUser] = useState(data.smtp.user);
  const [pass, setPass] = useState('');
  const [from, setFrom] = useState(data.smtp.from);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    setHost(data.smtp.host);
    setPort(String(data.smtp.port));
    setSecure(data.smtp.secure);
    setUser(data.smtp.user);
    setFrom(data.smtp.from);
  }, [data.smtp]);

  const saveBody = () => ({
    smtp: {
      host,
      port: Number(port) || 465,
      secure,
      user,
      ...(pass ? { pass } : {}),
      from,
    },
  });
  
  const fromTrim = from.trim();
  const fromInvalid =
    !!fromTrim &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromTrim) &&
    !/^[\s\S]+ <[^\s@]+@[^\s@]+\.[^\s@]+>$/.test(fromTrim);

  return (
    <SettingsCard
      title="SMTP 邮件"
      description="用于服务器离线通知与找回密码邮件；QQ 邮箱用 smtp.qq.com:465，163 用 smtp.163.com:465，密码填授权码。"
      icon={<Mail className="h-4 w-4" />}
      status={<StateChip ok={data.smtpReady} okText="可发信" badText="未配置" />}
      accent={accent}
      className={className}
    >
      <div className="grid gap-3">
        {/* 与其它卡片一致用等宽双列：非对称模板会让不同卡片的控件左边界对不齐 */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field htmlFor="ps-smtp-host" label="SMTP 服务器" hint="例：smtp.qq.com">
            <Input
              id="ps-smtp-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.qq.com"
            />
          </Field>
          <Field htmlFor="ps-smtp-port" label="端口" hint="465 SSL / 587 STARTTLS">
            <Input
              id="ps-smtp-port"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="465"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field htmlFor="ps-smtp-user" label="用户名" hint="通常是邮箱">
            <Input
              id="ps-smtp-user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="you@qq.com"
            />
          </Field>
          <Field
            htmlFor="ps-smtp-pass"
            label="密码 / 授权码"
            hint={data.smtp.hasPass ? '已保存，留空不修改' : undefined}
          >
            <Input
              id="ps-smtp-pass"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="••••••"
            />
          </Field>
        </div>
        <div className="grid content-start gap-3 sm:grid-cols-2">
          <Field
            htmlFor="ps-smtp-from"
            label="发件人"
            hint="留空则使用 SMTP 用户名；可填「BlockNexus <你邮箱地址>」显示署名"
            error={fromInvalid ? '发件人应为邮箱地址，或「显示名 <邮箱地址>」格式' : undefined}
          >
            <Input
              id="ps-smtp-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="BlockNexus <你邮箱地址>"
            />
          </Field>
          {/* items-stretch 让开关块与左侧输入框等高，基线不再错位 */}
          <div className="flex">
            <ToggleRow
              title="SSL/TLS"
              description={secure ? '465 端口直连 SSL' : '587 STARTTLS 或明文'}
              checked={secure}
              onCheckedChange={setSecure}
              className="w-full"
            />
          </div>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            try {
              await api('/settings', { method: 'PUT', body: saveBody() });
              await api('/settings/smtp-test', { method: 'POST', body: {} });
              success('测试邮件已发送', '请查收管理员邮箱');
              reload();
            } catch (e) {
              error('测试失败', errText(e));
            } finally {
              setTesting(false);
            }
          }}
        >
          <MailCheck className="h-3.5 w-3.5" /> {testing ? '发送中…' : '保存并发送测试邮件'}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/settings', { method: 'PUT', body: saveBody() });
              success('SMTP 已保存');
              reload();
            } catch (e) {
              error('保存失败', errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </div>
    </SettingsCard>
  );
}

/** AI 连接测试结果：模型 / 状态 / 首字 / 总耗时 / Token */
function AiTestSummary({ result }: { result: AiTestResult }) {
  const ms = (n?: number) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n + ' ms');
  const u = result.usage;
  const tokens =
    u && u.totalTokens != null ? String(u.totalTokens) : u ? '—' : '未返回';
  const detail =
    u && (u.promptTokens != null || u.completionTokens != null)
      ? `（提示 ${u.promptTokens ?? '—'} / 补全 ${u.completionTokens ?? '—'}）`
      : '';
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">状态</span>
          <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {result.status ?? 200} 正常
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">模型</span>
          <span className="font-mono font-medium">{result.model || '—'}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">首字</span>
          <span className="font-mono">{ms(result.firstTokenMs)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">总耗时</span>
          <span className="font-mono">{ms(result.totalMs)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">Token</span>
          <span className="font-mono">
            {tokens}
            {detail && <span className="text-muted-foreground"> {detail}</span>}
          </span>
        </span>
      </div>
      {result.reply && (
        <div className="text-muted-foreground">
          回复：<span className="text-foreground">{result.reply}</span>
        </div>
      )}
    </div>
  );
}

// ---------- 通知设置 ----------
function NotifyCard({
  data,
  reload,
  accent,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
  accent?: Accent;
  className?: string;
}) {
  const { success, error } = useToastHelpers();
  const [adminEmail, setAdminEmail] = useState(data.adminEmail);
  const [offline, setOffline] = useState(data.notify.offline);
  const [recovery, setRecovery] = useState(data.notify.recovery);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAdminEmail(data.adminEmail);
    setOffline(data.notify.offline);
    setRecovery(data.notify.recovery);
  }, [data.adminEmail, data.notify]);

  const emailInvalid = !!adminEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim());

  return (
    <SettingsCard
      title="通知设置"
      description="管理员邮箱同时用于接收通知与找回密码（只有匹配该邮箱的请求才会发信）。"
      icon={<Bell className="h-4 w-4" />}
      accent={accent}
      className={className}
    >
      <Field
        htmlFor="ps-admin-email"
        label="管理员邮箱"
        hint="接收通知与重置验证码"
        error={emailInvalid ? '邮箱格式不正确' : undefined}
      >
        <Input
          id="ps-admin-email"
          className="sm:max-w-sm"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          placeholder="you@qq.com"
        />
      </Field>
      {/* 两个开关各占一行（面板宽度必然触发 sm，不能用 sm:flex-row 并排） */}
      <div className="flex flex-col gap-3">
        <ToggleRow
          title="服务器离线时通知"
          description="Agent 断开时发信；同一次离线只发一封（24 小时后补发提醒），抖动重连不刷屏"
          checked={offline}
          onCheckedChange={setOffline}
        />
        <ToggleRow
          title="恢复上线时通知"
          description="仅在发送过离线通知后生效"
          checked={recovery}
          onCheckedChange={setRecovery}
        />
      </div>
      <div className="mt-auto flex justify-end">
        <Button
          size="sm"
          disabled={busy || emailInvalid}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/settings', {
                method: 'PUT',
                body: { adminEmail, notify: { offline, recovery } },
              });
              success('通知设置已保存');
              reload();
            } catch (e) {
              error('保存失败', errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </div>
    </SettingsCard>
  );
}

// ---------- AI 日志分析 ----------
function AiCard({
  data,
  reload,
  accent,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
  accent?: Accent;
  className?: string;
}) {
  const { success, error } = useToastHelpers();
  const [aiOn, setAiOn] = useState(data.ai.enabled);
  const [baseUrl, setBaseUrl] = useState(data.ai.baseUrl);
  const [model, setModel] = useState(data.ai.model);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  // 服务商可用模型：查询得到后作为下拉候选；查不到就退回手填
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  // 依赖具体字段而非 data.ai 对象：对象每次 load 都是新引用，
  // 否则「查询模型」后若触发 reload，会把用户手填的地址/模型覆盖回初始值
  useEffect(() => {
    setAiOn(data.ai.enabled);
    setBaseUrl(data.ai.baseUrl);
    setModel(data.ai.model);
  }, [data.ai.enabled, data.ai.baseUrl, data.ai.model]);

  const baseTrim = baseUrl.trim();
  const modelTrim = model.trim();
  const baseInvalid = !!baseTrim && !/^https?:\/\//i.test(baseTrim);
  // 密钥：已有保存的可留空表示不修改；首次配置必须填
  const hasKey = data.ai.hasKey || !!apiKey.trim();
  const keyMissing = !hasKey;
  // 启用时必须三项齐全，否则保存后分析会直接报「未配置」
  const incomplete = aiOn && (!baseTrim || !modelTrim || !hasKey);
  const nothingChanged =
    aiOn === data.ai.enabled &&
    baseTrim === data.ai.baseUrl &&
    modelTrim === data.ai.model &&
    !apiKey.trim();

  const saveBody = () => ({
    ai: {
      enabled: aiOn,
      baseUrl: baseTrim,
      model: modelTrim,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    },
  });

  // 用当前表单值（含未保存的密钥）查询模型列表
  const fetchModels = async () => {
    if (!baseTrim || baseInvalid || !hasKey) return;
    setLoadingModels(true);
    try {
      const list = await aiListModels({
        baseUrl: baseTrim,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setModels(list);
      if (!list.length) error('未查到可用模型', '请检查接口地址与密钥，或手动填写模型名');
      else success(`查到 ${list.length} 个模型`);
    } catch (e) {
      error('查询模型失败', errText(e));
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <SettingsCard
      title="AI 日志分析"
      description="实例详情页「AI 分析」用它解读控制台日志；接口需兼容 OpenAI Chat Completions，密钥仅保存在本机。"
      icon={<Sparkles className="h-4 w-4" />}
      accent={accent}
      className={className}
      status={
        <div className="flex items-center gap-2">
          <Switch
            className="shrink-0"
            checked={aiOn}
            onCheckedChange={(v) => setAiOn(v === true)}
          />
          <StateChip ok={aiOn} okText="已启用" badText="未启用" />
        </div>
      }
    >
      {/* 配置区始终可编辑：开关只决定「是否启用分析」，不锁配置。
          否则未启用时既填不了地址密钥、也点不了「查询模型」，形成先有蛋后有鸡的死结。 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          htmlFor="ps-ai-base"
          label="接口地址"
          hint="例：https://api.liveling.cn/v1"
          error={baseInvalid ? '需以 http:// 或 https:// 开头' : undefined}
        >
          <Input
            id="ps-ai-base"
            className="sm:max-w-sm"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.liveling.cn/v1"
          />
        </Field>
        <Field
          htmlFor="ps-ai-model"
          label="模型"
          hint={models.length ? `${models.length} 个可选` : '可点右侧「查询模型」拉取列表'}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {models.length ? (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="ps-ai-model" className="w-60" aria-label="模型">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="ps-ai-model"
                className="sm:max-w-sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="cn:glm-5.3-flash"
              />
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={loadingModels || baseInvalid || !baseTrim || !hasKey}
              onClick={fetchModels}
              title="用上面的接口地址与密钥拉取服务商模型列表"
            >
              {loadingModels ? '查询中…' : '查询模型'}
            </Button>
          </div>
        </Field>
        <Field
          htmlFor="ps-ai-key"
          label="API 密钥"
          hint={data.ai.hasKey ? '已保存，留空不修改' : undefined}
          error={keyMissing ? '填写密钥后才能查询模型或测试连接' : undefined}
          className="sm:col-span-2"
        >
          <Input
            id="ps-ai-key"
            type="password"
            className="sm:max-w-sm"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data.ai.hasKey ? '已保存，留空不修改' : 'sk-…'}
          />
        </Field>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        分析时会把实例控制台日志（最多最近 500 行，即 Agent 缓冲的全部内容）发给模型；日志可能含玩家名与地址，请自行确认服务商可信。
      </p>
      {testResult && <AiTestSummary result={testResult} />}
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={testing || baseInvalid || !baseTrim || !modelTrim || !hasKey}
          onClick={async () => {
            setTesting(true);
            setTestResult(null);
            try {
              const r = await aiTest({
                baseUrl: baseTrim,
                model: modelTrim,
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              });
              setTestResult(r);
              success('连接成功', r.reply || '模型已正常响应');
            } catch (e) {
              error('测试失败', errText(e));
            } finally {
              setTesting(false);
            }
          }}
        >
          <Sparkles className="h-3.5 w-3.5" /> {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button
          size="sm"
          disabled={busy || baseInvalid || incomplete || nothingChanged}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/settings', { method: 'PUT', body: saveBody() });
              success(aiOn ? 'AI 日志分析已启用' : 'AI 日志分析已关闭');
              setApiKey('');
              reload();
            } catch (e) {
              error('保存失败', errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </div>
    </SettingsCard>
  );
}
