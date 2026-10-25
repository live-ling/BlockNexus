import { navigate } from '@/lib/router';
// 面板设置页：登录保护 / 公网访问 / SMTP 邮件 / 通知设置 / AI / 版本与更新 / 外观
// 路由 #/settings —— 顶栏「设置」进入（替代原设置模态框）
//
// 2026-10-25 排版改版（去卡中卡 + 分区重排）：
//   · 右侧内容列 680，表单 620 封顶——原来 760 宽 + 卡片铺满，控件被拉得又长又空；
//   · 不再套 SettingsCard 的边框/阴影/彩色图标，靠 13px 区块标题 + 28px 间距分层；
//   · 7 个分区并成 6 个：「外观」吸收语言与关于，不再出现只有一行内容的空旷分区；
//   · 低频内容下沉：更新日志进抽屉，DDNS 高级参数折叠，SMTP 高级项折叠。
//   保存方式不变：每块自己内联保存（不做整页脏检查）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Download, Info, MailCheck, Moon, RefreshCw, RotateCcw, Sparkles, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Markdown } from '@/components/markdown';
import { PageHeader } from '@/components/layout/page-header';
import { SettingsLayout } from '@/components/layout/settings-layout';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { FormActions, FormGrid, SettingsCard, Field, StateChip } from '@/components/settings-card';
import {
  aiListModels,
  aiTest,
  api,
  applyPanelUpdate,
  errText,
  fmtDownloadBytes,
  getPanelUpdatePreflight,
  getPanelUpdateStatus,
  getVersion,
  rollbackPanelUpdate,
  timeago,
  type AiTestResult,
  type AppVersion,
  type AppVersionRecommendation,
  type PanelSettings,
  type PanelUpdatePolicy,
  type PanelUpdatePreflight,
  type PanelUpdateState,
  type PanelUpdateStatus,
} from '@/lib/api';
import { $ } from '@/lib/i18n';
import { getLanguage, setLanguage, LANGUAGE_LABELS, type LanguageCode } from '@/lib/i18n';
import { subscribeSSE } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';
import { DdnsCard, FrpCard } from '@/pages/panel-settings-network';

/** 更新策略的兜底值：老后端不返回 update 字段时界面仍要能用（默认仅提醒） */
const DEFAULT_UPDATE_POLICY: PanelUpdatePolicy = { auto: 'notify', source: '', dismissed: {} };

/**
 * 正在跑的状态集合：这几个阶段都要显示进度并**禁用其它操作**（换包途中再点一次等于把面板拆了）
 */
const RUNNING_STATES: PanelUpdateState['state'][] = [
  'downloading',
  'verifying',
  'staging',
  'applying',
  'restarting',
];

/** 更新进入重启阶段后多久算「卡住了」（面板没起来，需要人工介入） */
const RESTART_STALL_MS = 3 * 60 * 1000;

/**
 * 更新过程的阶段文案；'idle' 与 'failed' 不会走到这里（前者无进度可显示，后者单独渲染错误块）。
 * 放在组件外面是为了让两处渲染（横幅与行内）共用同一份映射，避免新增阶段时只改一处。
 */
function phaseText(state: PanelUpdateState): string {
  switch (state.state) {
    case 'downloading':
      return $('panelSettings.update.phase.downloading');
    case 'verifying':
      return $('panelSettings.update.phase.verifying');
    case 'staging':
      return $('panelSettings.update.phase.staging');
    case 'applying':
      return $('panelSettings.update.phase.applying');
    case 'restarting':
      return $('panelSettings.update.phase.restarting');
    default:
      return $('panelSettings.update.phase.idle');
  }
}

/** severity → 徽章/横幅配色；security 用 destructive 语义色，critical 用 amber，其余中性 */
function severityBox(sev: AppVersionRecommendation['severity']): string {
  if (sev === 'security') return 'border-destructive/30 bg-destructive/10';
  if (sev === 'critical') return 'border-amber-500/30 bg-amber-500/10';
  return 'border-border bg-muted/30';
}

function severityChip(sev: AppVersionRecommendation['severity']): string {
  if (sev === 'security') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (sev === 'critical') return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return 'border-border bg-muted/50 text-muted-foreground';
}

function severityDot(sev: AppVersionRecommendation['severity']): string {
  if (sev === 'security') return 'bg-destructive';
  if (sev === 'critical') return 'bg-amber-500';
  return 'bg-muted-foreground/60';
}

function severityText(sev: AppVersionRecommendation['severity']): string {
  switch (sev) {
    case 'security':
      return $('panelSettings.update.severity.security');
    case 'critical':
      return $('panelSettings.update.severity.critical');
    case 'recommended':
      return $('panelSettings.update.severity.recommended');
    default:
      return $('panelSettings.update.severity.optional');
  }
}

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
          // 更新策略：后端老版本不返回 update，兜底成「仅提醒」，否则策略卡整块不可用
          update: {
            auto: raw.update?.auto ?? DEFAULT_UPDATE_POLICY.auto,
            source: raw.update?.source ?? '',
            dismissed: raw.update?.dismissed ?? {},
          },
        });
      })
      .catch((e) => error($('panelSettings.error.load'), errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return <div className="p-10 text-center text-sm text-muted-foreground">{$('common.loading')}</div>;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <PageHeader back={onBack} title={$('panelSettings.title')} subtitle={$('panelSettings.subtitle')} />

      {/*
        左目录 + 右侧全量分区（SettingsLayout）：各块自己内联保存，只是排布换了。
        每个分区用 heading:false —— 分区名在左目录里，正文由各块自己的 13px 标题承担，
        避免「访问」+「登录保护」两级标题叠在一起。
      */}
      <SettingsLayout
        contentClassName="max-w-[1160px]"
        sections={[
          {
            id: 'access',
            label: $('panelSettings.section.access'),
            heading: false,
            content: <AuthCard data={data} onAuthChanged={onAuthChanged} reload={load} />,
          },
          {
            id: 'network',
            label: $('panelSettings.section.network'),
            heading: false,
            content: (
              <div className="grid gap-5 lg:grid-cols-2">
                <DomainCard data={data} reload={load} className="lg:col-span-2" />
                {/* 网络助手（实验）：DDNS 解决"动态 IP"，frp 解决"没有公网 IP" */}
                <DdnsCard />
                <FrpCard />
              </div>
            ),
          },
          {
            id: 'notify',
            label: $('panelSettings.section.notify'),
            heading: false,
            content: (
              <div className="grid gap-5 lg:grid-cols-2">
                <SmtpCard data={data} reload={load} />
                <NotifyCard data={data} reload={load} />
              </div>
            ),
          },
          {
            id: 'ai',
            label: $('panelSettings.section.ai'),
            heading: false,
            content: <AiCard data={data} reload={load} />,
          },
          {
            id: 'update',
            label: $('panelSettings.section.update'),
            heading: false,
            content: (
              <div className="grid gap-5 lg:grid-cols-2">
                {/* 策略块紧随版本块：两者是同一件事（先看到「有新版本」，再决定以后怎么处理） */}
                <VersionCard data={data} reload={load} />
                <UpdatePolicyCard data={data} reload={load} />
              </div>
            ),
          },
          {
            id: 'appearance',
            label: $('panelSettings.section.appearance'),
            heading: false,
            content: (
              <div className="grid gap-5 lg:grid-cols-2">
                <LanguageCard />
                <AboutEntry />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/** 设置页底部「关于」入口：跳转 #/about（不再是独立分区，挂在「外观与关于」末尾） */
function AboutEntry({ className = '' }: { className?: string }) {
  return (
    <section className={className}>
      <button
        type="button"
        onClick={() => navigate('/about')}
        className="flex w-full max-w-[620px] items-center gap-2.5 rounded-lg border border-border/60 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <Info className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <b className="text-[12.5px] font-medium">{$('panelSettings.about.title')}</b>
          <span className="ml-2 text-[11px] text-muted-foreground">{$('panelSettings.about.desc')}</span>
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </section>
  );
}

/**
 * 语言与主题：把原先漂浮在顶栏的 LanguageToggle / ThemeToggle 搬进设置页。
 *
 * 为什么语言仍然 reload：`$()` 是同步取词，刷新一次即可让所有可见文案切换到目标语言，
 * 无需给所有组件做重渲染订阅。代价是未保存的表单内容会丢，但设置页通常没有未保存编辑。
 */
function LanguageCard({ className = '' }: { className?: string }) {
  const current = getLanguage();
  // options 按当前语言展示标签，避免自身翻译抖动（语言名用自家文字写自己是 i18n.ts 的约定）
  const options: LanguageCode[] = ['zh', 'en'];
  const { theme, setTheme } = useTheme();
  // 主题首帧可能还没读到（next-themes 在挂载后才给值），先按浅色画，避免闪烁
  const isDark = theme === 'dark';
  return (
    <SettingsCard
      title={$('panelSettings.language.title')}
      description={$('panelSettings.language.desc')}
      className={className}
    >
      <FormGrid>
        <Field label={$('panelSettings.language.current')}>
          <Select
            value={current}
            onValueChange={(v) => {
              if (v !== current) {
                setLanguage(v as LanguageCode);
                location.reload();
              }
            }}
          >
            <SelectTrigger aria-label={$('panelSettings.language.title')} className="w-full max-w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((code) => (
                <SelectItem key={code} value={code}>
                  {LANGUAGE_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={$('panelSettings.appearance.theme')} hint={$('panelSettings.appearance.theme.hint')}>
          <div className="inline-flex w-fit items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
            {(
              [
                { key: 'light', label: $('panelSettings.appearance.theme.light'), icon: Sun },
                { key: 'dark', label: $('panelSettings.appearance.theme.dark'), icon: Moon },
              ] as const
            ).map((o) => {
              const on = o.key === 'dark' ? isDark : !isDark;
              const Icon = o.icon;
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setTheme(o.key)}
                  aria-pressed={on}
                  className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11.5px] transition-colors ${
                    on ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="size-3.5" />
                  {o.label}
                </button>
              );
            })}
          </div>
        </Field>
      </FormGrid>
    </SettingsCard>
  );
}

/**
 * 版本与更新：当前版本 / 最新 Release / 更新建议 / 应用内自更新（预览 → 进度 → 结果 → 回滚）。
 *
 * 为什么「先预览再更新」而不是点一下直接升级：
 *   应用内更新会替换面板自己的文件并重启面板，代价（下载量、数据迁移、需要重装 Agent 的服务器、
 *   能不能回滚）必须先摊开给用户看；后端也把这套判断做成了独立的 preflight 接口。
 *   所以这里的流程固定为：点「立即更新」→ 取 preflight → 就地展开预览 → 用户确认 → POST 受理。
 */
function VersionCard({
  data,
  reload,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
  className?: string;
}) {
  const { success, error: toastError } = useToastHelpers();
  const [info, setInfo] = useState<AppVersion | null>(null);
  const [busy, setBusy] = useState(false);
  // 更新日志是长文（Markdown），低频但要看 —— 放进右侧抽屉，不占正文高度
  const [logOpen, setLogOpen] = useState(false);
  const [status, setStatus] = useState<PanelUpdateStatus | null>(null);
  const [preflight, setPreflight] = useState<PanelUpdatePreflight | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [irreversibleOk, setIrreversibleOk] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  // 「稍后提醒」是纯本地会话内状态：只为不打断当前手头的事，刷新页面即恢复提醒
  const [snoozed, setSnoozed] = useState<string | null>(null);
  // 上次结果一开始只在 GET /status 里；SSE 推 panel-update 时的负载不含它，合并时别把它抹掉
  const [lastResult, setLastResult] = useState<PanelUpdateStatus['lastResult']>(null);

  const check = useCallback(
    (refresh: boolean) => {
      setBusy(true);
      getVersion(refresh)
        .then(setInfo)
        .catch((e) => toastError($('panelSettings.version.error.check'), errText(e)))
        .finally(() => setBusy(false));
    },
    [toastError],
  );

  /** 拉更新状态；silent=true 给轮询用（一秒一次的错误 toast 会刷屏） */
  const loadStatus = useCallback(
    async (silent = false) => {
      try {
        const st = await getPanelUpdateStatus();
        setStatus(st);
        setLastResult(st.lastResult);
        return st;
      } catch (e) {
        if (!silent) toastError($('panelSettings.version.error.check'), errText(e));
        return null;
      }
    },
    [toastError],
  );

  useEffect(() => {
    check(false);
    void loadStatus();
  }, [check, loadStatus]);

  // 更新过程的实时进度：SSE 优先（后端在每次状态变化时推），拿不到就由下面的轮询兜底。
  // 事件负载与 PanelUpdateState 字段一一对应（同一个后端对象），所以能直接搬进状态。
  useEffect(
    () =>
      subscribeSSE((e) => {
        if (e.type !== 'panel-update') return;
        // SSE 负载里没有 inFlight/lastResult/rollback（那是 /status 才有的），
        // 所以只覆盖状态字段、其余保留上次 /status 的值——否则轮询间隙回滚按钮会闪没
        const { type: _type, ...state } = e;
        setStatus((cur) => ({
          ...state,
          inFlight: RUNNING_STATES.includes(state.state),
          installKind: cur?.installKind ?? '',
          canSelfUpdate: cur?.canSelfUpdate ?? false,
          lastResult: cur?.lastResult ?? null,
          rollback: cur?.rollback ?? { available: false, to: '', irreversible: false, reasonKey: '' },
        }));
      }),
    [],
  );

  const updateState = status ?? (info ? info.updateState : null);
  const running = !!updateState && RUNNING_STATES.includes(updateState.state);

  // 轮询只在「面板正在重启」或「本地刚刚提交、后端还没进入更新态」时启动。
  // 平时绝不轮询：状态变化本来就由 SSE 推送，多一个定时器只是白耗。
  const polling = updateState?.state === 'restarting' || applying;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void loadStatus(true), 2000);
    return () => clearInterval(timer);
  }, [polling, loadStatus]);

  const rec = info?.recommendation ?? null;
  const hasUpdate = !!info?.hasUpdate;
  const selfUpdate = !!info?.canSelfUpdate;
  const dismissed = !!(rec?.dismissed || (rec?.latest && data.update?.dismissed?.[rec.latest]));
  const snoozeHide = snoozed !== null && snoozed === rec?.latest;
  // 只有「能自动装 + 有新版本 + 没被跳过 + 没被本次会话稍后提醒」才出更新横幅
  const showBanner = selfUpdate && hasUpdate && !dismissed && !snoozeHide;

  /** 取升级预览并就地展开；失败用 toast 兜底（errText 已本地化） */
  const openPreflight = async (version: string) => {
    setPreflightBusy(true);
    try {
      const pf = await getPanelUpdatePreflight(version);
      setPreflight(pf);
      setIrreversibleOk(false);
    } catch (e) {
      toastError($('panelSettings.update.preflight.failed'), errText(e));
    } finally {
      setPreflightBusy(false);
    }
  };

  /**
   * 受理更新。`target` 默认取预览里的目标版本；bridge 模式传入中间版本（先升到它再继续）。
   * confirmIrreversible 只在预览标了不可逆、且用户二次确认后带上——后端据此把「不可逆」
   * 变成一次显式的知情同意，而不是前端自己判断后静默放行。
   */
  const startUpdate = async (pf: PanelUpdatePreflight, target?: string) => {
    const version = target || pf.to || pf.latest;
    if (!version) return;
    setApplying(true);
    try {
      await applyPanelUpdate({
        version,
        confirm: version,
        ...(pf.irreversible && (!target || target === pf.to) ? { confirmIrreversible: true as const } : {}),
      });
      // 通知 App：本地已发起更新，请开始轮询 /panel-update/status 并在版本变化后自动刷新。
      // 走 window 事件而不是 Context/全局 store：只有 App 一个监听者，不值得为此引入共享状态。
      window.dispatchEvent(new Event('panel-update-submitted'));
      success($('panelSettings.update.accepted'), $('panelSettings.update.acceptedDetail', version));
      setPreflight(null);
      setIrreversibleOk(false);
      void loadStatus(true);
    } catch (e) {
      // 失败必须可见：这里最常见的是「面板正忙 / 安装形态变了」，吞掉会让用户以为点空了
      toastError($('panelSettings.update.startFailed'), errText(e));
    } finally {
      setApplying(false);
    }
  };

  /** 跳过此版本（写进后端设置，换页/刷新后依然生效）；稍后提醒只藏本次会话 */
  const dismissVersion = async () => {
    if (!rec?.latest) return;
    try {
      await api('/settings', {
        method: 'PUT',
        body: { update: { dismissed: { ...(data.update?.dismissed ?? {}), [rec.latest]: Date.now() } } },
      });
      success($('panelSettings.saved'), $('panelSettings.update.dismissedDetail', rec.latest));
      reload();
    } catch (e) {
      toastError($('panelSettings.update.dismissFailed'), errText(e));
    }
  };

  // 回滚同样要重启面板换文件，所以先确认；这里用 window.confirm 足够，
  // 不值得为一次性动作再引一个对话框组件（也就不会跟服务端设置页的改动打架）
  const rollback = async () => {
    const to = status?.rollback?.to || '';
    if (!window.confirm($('panelSettings.update.rollback.confirm', to || '…'))) return;
    setRollbackBusy(true);
    try {
      await rollbackPanelUpdate();
      success($('panelSettings.update.rollback.accepted'));
      void loadStatus(true);
    } catch (e) {
      toastError($('panelSettings.update.rollback.failed'), errText(e));
    } finally {
      setRollbackBusy(false);
    }
  };

  // 失败时给出错误并停在原地（可重试）；进度条只在真正跑的时候出现
  const failedNow = updateState?.state === 'failed';
  /**
   * 重启态本身没有进度，只能靠「进入了多久」判断是不是卡住（面板没起来，需要人工介入）。
   * 计时从**进入重启的那一刻**开始，不能用 startedAt —— 那是持久化字段，
   * 上一次失败的更新时间会让刚打开的页面立刻误报卡住。
   * 离开重启态时不在这里写 state（渲染期同步 setState 会多一轮渲染）：
   * 「是不是重启中」本来就是渲染条件之一，旧值自然不会被读到。
   */
  const restartSince = useRef<number | null>(null);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (updateState?.state !== 'restarting') {
      restartSince.current = null;
      return;
    }
    if (restartSince.current === null) restartSince.current = Date.now();
    const timer = setTimeout(() => setStalled(true), RESTART_STALL_MS);
    return () => clearTimeout(timer);
  }, [updateState?.state]);

  return (
    <SettingsCard
      title={$('panelSettings.version.title')}
      description={$('panelSettings.version.desc')}
      className={className}
      status={
        info && !busy ? (
          hasUpdate ? (
            <span className={`inline-flex h-[18px] items-center gap-1.5 rounded border px-1.5 text-[10.5px] leading-none font-medium ${severityChip(rec?.severity ?? 'optional')}`}>
              <span className={`size-1.5 rounded-full ${severityDot(rec?.severity ?? 'optional')}`} />
              {$('panelSettings.version.hasNew')}
            </span>
          ) : failedNow ? (
            <span className="inline-flex h-[18px] items-center gap-1.5 rounded border border-destructive/30 bg-destructive/10 px-1.5 text-[10.5px] leading-none font-medium text-destructive">
              <span className="size-1.5 rounded-full bg-destructive" />
              {$('panelSettings.update.failed')}
            </span>
          ) : (
            <StateChip ok okText={$('panelSettings.version.latest')} badText="" />
          )
        ) : undefined
      }
    >
      <div className="grid max-w-[620px] gap-x-6 gap-y-1.5 text-[12px]">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">{$('panelSettings.version.current')}</span>
          <span className="font-mono">v{info?.version ?? '…'}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">{$('panelSettings.version.latestLabel')}</span>
          <span className="font-mono">{info?.latest ? `v${info.latest}` : '—'}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-muted-foreground">{$('panelSettings.version.repo')}</span>
          <a
            href={info?.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="truncate">github.com/live-ling/BlockNexus</span>
          </a>
        </div>
        {/* 更新日志是长文：只在抽屉里看，正文只留一行入口（没有日志时整行不出现） */}
        {info?.changelog && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{$('panelSettings.version.changelogLabel')}</span>
            <button
              type="button"
              onClick={() => setLogOpen(true)}
              className="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {$('panelSettings.version.changelog', info.latest)}
              <ChevronRight className="size-3" />
            </button>
          </div>
        )}
        {info?.error && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            {$('panelSettings.version.checkFailed', info.error)}
          </p>
        )}
        {/* 不能自更新时只说明原因（后端已本地化），不给按钮——点了也只会得到一个错误 */}
        {info && !selfUpdate && info.updateDisabledText && (
          <p className="text-[11px] leading-snug text-muted-foreground">{$('panelSettings.update.disabledPrefix')}{info.updateDisabledText}</p>
        )}
        {hasUpdate && info?.releaseUrl && (
          <a
            href={info.releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-cyan-600 underline underline-offset-2 hover:text-cyan-500 dark:text-cyan-400"
          >
            {$('panelSettings.version.goto')}
          </a>
        )}
      </div>

      {/* 进度：跑起来时占最显眼的位置；更新中其余操作由 disabled 关掉（见下） */}
      {running && updateState && (
        <div className="grid gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-medium">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {phaseText(updateState)}
          </div>
          {updateState.total > 0 ? (
            <Progress value={Math.round((updateState.progress / updateState.total) * 100)} showValue />
          ) : (
            /* 无总字节数（git 模式等）时给不确定态：宁可不给百分比，也不要编一个假的 */
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {$('panelSettings.update.restartHint')}
          </p>
          {stalled && <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">{$('panelSettings.update.stalled')}</p>}
        </div>
      )}

      {/* 更新失败：错误来自后端（已本地化），保留重试入口 */}
      {failedNow && updateState?.error && (
        <div className="grid gap-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            {$('panelSettings.update.failed')}
          </div>
          <p className="text-[11px] leading-relaxed text-destructive">{updateState.error}</p>
          {updateState.warnings?.map((w) => (
            <p key={w} className="text-[11px] leading-relaxed text-muted-foreground">
              {w}
            </p>
          ))}
        </div>
      )}

      {/* 建议横幅：颜色按 severity 分级，security 用 destructive、critical 用 amber，其余中性 */}
      {showBanner && !running && (
        <div className={`grid gap-2 rounded-lg border px-3 py-2.5 ${severityBox(rec?.severity ?? 'optional')}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${severityChip(rec?.severity ?? 'optional')}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${severityDot(rec?.severity ?? 'optional')}`} />
              {severityText(rec?.severity ?? 'optional')}
            </span>
            {rec?.summary && <span className="text-xs font-medium">{rec.summary}</span>}
          </div>
          <div className="grid gap-1 text-[11px] leading-relaxed">
            {rec?.breaking && <p>{$('panelSettings.update.warn.breaking')}</p>}
            {rec?.irreversible && <p>{$('panelSettings.update.warn.irreversible')}</p>}
            {rec?.requiresAgentReinstall && <p>{$('panelSettings.update.warn.agentReinstall')}</p>}
            {rec?.metaMissing && <p className="text-muted-foreground">{$('panelSettings.update.metaMissing')}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {rec?.notesUrl && (
              <a
                href={rec.notesUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-cyan-600 underline underline-offset-2 hover:text-cyan-500 dark:text-cyan-400"
              >
                {$('panelSettings.update.notes')}
              </a>
            )}
            {rec?.autoReason && <span className="text-[11px] text-muted-foreground">{rec.autoReason}</span>}
          </div>
        </div>
      )}

      {/* 升级预览（就地展开，不引新弹窗组件） */}
      {preflight && !running && (
        <div className="grid gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5">
          <b className="text-xs font-medium">{$('panelSettings.update.preflight.title')}</b>
          <div className="grid gap-x-6 gap-y-1 text-xs">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{$('panelSettings.update.preflight.target')}</span>
              <span className="font-mono">v{preflight.to || preflight.latest}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{$('panelSettings.update.preflight.size')}</span>
              <span className="font-mono">{fmtDownloadBytes(preflight.downloadBytes)}</span>
            </div>
          </div>
          {preflight.migrations?.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {$('panelSettings.update.preflight.migrations', preflight.migrations.length)}
            </p>
          )}
          {preflight.agentsToReinstall?.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {$(
                'panelSettings.update.preflight.agents',
                preflight.agentsToReinstall.map((a) => a.name).join('、'),
              )}
            </p>
          )}
          {preflight.warnings?.map((w) => (
            <p key={w.code} className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {w.text}
            </p>
          ))}
          {!preflight.nodeOk && (
            <p className="text-[11px] leading-relaxed text-destructive">
              {$('panelSettings.update.preflight.node', preflight.nodeRequired)}
            </p>
          )}
          {preflight.mode === 'bridge' && preflight.bridgeVersion && (
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {$('panelSettings.update.preflight.bridge', preflight.bridgeVersion)}
            </p>
          )}
          {preflight.needsFullPackage && (
            <div className="grid gap-1.5 rounded-md border bg-card px-2.5 py-2">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {$('panelSettings.update.preflight.manual')}
              </p>
              {preflight.fullPackageUrl && (
                <a
                  href={preflight.fullPackageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[11px] text-cyan-600 underline underline-offset-2 hover:text-cyan-500 dark:text-cyan-400"
                >
                  <Download className="h-3 w-3" />
                  {$('panelSettings.update.preflight.download')}
                </a>
              )}
            </div>
          )}
          {preflight.metaMissing && <p className="text-[11px] text-muted-foreground">{$('panelSettings.update.metaMissing')}</p>}
          {/* reasonText 是后端渲染好的拒绝说明：显示它并禁用按钮，而不是自己拼一句 */}
          {preflight.reasonText && <p className="text-[11px] leading-relaxed text-destructive">{preflight.reasonText}</p>}
          {preflight.error && <p className="text-[11px] leading-relaxed text-destructive">{preflight.error}</p>}
          {/*
            不可逆更新要一次显式勾选：这类更新没有回滚包，误点一次就没退路了。
            勾选状态不参与「能不能装」的后端判定，只是前端这道防误触的闸。
          */}
          {preflight.irreversible && (
            <label className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              <Checkbox
                className="mt-0.5"
                checked={irreversibleOk}
                onCheckedChange={(v) => setIrreversibleOk(v === true)}
                aria-label={$('panelSettings.update.preflight.irreversibleConfirm')}
              />
              <span>
                {$('panelSettings.update.warn.irreversible')}
                <br />
                {$('panelSettings.update.preflight.irreversibleConfirm')}
              </span>
            </label>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
            <Button variant="ghost" size="sm" onClick={() => setPreflight(null)} disabled={applying}>
              {$('panelSettings.update.cancel')}
            </Button>
            {preflight.mode === 'bridge' && preflight.bridgeVersion ? (
              // 跨版本不能一步到位：只允许先升到中间版本，文案与按钮都指向它
              <Button
                size="sm"
                disabled={applying || !preflight.allowed || !preflight.bridgeVersion}
                onClick={() => void startUpdate(preflight, preflight.bridgeVersion)}
              >
                {applying ? $('panelSettings.update.busy') : $('panelSettings.update.preflight.bridgeAction', preflight.bridgeVersion)}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={
                  applying ||
                  !preflight.allowed ||
                  preflight.needsFullPackage ||
                  !preflight.nodeOk ||
                  // 不可逆更新必须显式勾一次：二次点击本身就是确认动作（不引 Checkbox 依赖）
                  (preflight.irreversible && !irreversibleOk)
                }
                onClick={() => void startUpdate(preflight)}
              >
                {applying
                  ? $('panelSettings.update.busy')
                  : preflight.irreversible
                    ? $('panelSettings.update.confirmIrreversible')
                    : $('panelSettings.update.start')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* 上次更新结果（后端持久化）：成功/失败/已回滚 都在这条里说明 */}
      {lastResult && !running && (
        <div className="grid gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
          <b className="text-xs font-medium">
            {$('panelSettings.update.lastResult.title', timeago(lastResult.at))}
          </b>
          {lastResult.ok ? (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
              {$('panelSettings.update.lastResult.ok', lastResult.to)}
            </p>
          ) : (
            <p className="text-[11px] text-destructive">
              {$('panelSettings.update.lastResult.failed', lastResult.to, lastResult.error || '')}
            </p>
          )}
          {lastResult.rolledBack && (
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {$('panelSettings.update.lastResult.rolledBack')}
              {lastResult.restored ? ` · ${$('panelSettings.update.lastResult.restored', lastResult.restored)}` : ''}
            </p>
          )}
          {lastResult.dataBackup && (
            <p className="break-all font-mono text-[11px] text-muted-foreground">
              {$('panelSettings.update.lastResult.dataBackup', lastResult.dataBackup)}
            </p>
          )}
        </div>
      )}

      {/* 更新日志抽屉：低频长文，右侧滑出，读完即走，不占正文高度 */}
      <Sheet open={logOpen} onOpenChange={setLogOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[520px]">
          <SheetHeader className="border-b px-5 py-4">
            <SheetTitle className="text-[13px]">
              {$('panelSettings.version.changelog', info?.latest ?? '')}
            </SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <Markdown content={info?.changelog ?? ''} />
          </div>
        </SheetContent>
      </Sheet>

      {/*
        操作区。更新进行中一律禁用：换包（staging/applying/restarting）期间面板的文件正在被替换，
        此时再点一次更新、或触发别的会写配置的操作，后果都是半成品状态——前端这一层必须关掉入口。
        回滚按钮只在后端说 available 时出现（不可逆更新成功后它会被关掉）。
      */}
      <FormActions className="pt-1">
        {status?.rollback?.available && !running && (
          <Button variant="outline" size="sm" disabled={rollbackBusy} onClick={() => void rollback()}>
            <RotateCcw className="h-3.5 w-3.5" />
            {rollbackBusy
              ? $('panelSettings.update.rollback.busy')
              : $('panelSettings.update.rollback', status.rollback.to)}
          </Button>
        )}
        {showBanner && !running && (
          <>
            <Button variant="ghost" size="sm" onClick={() => setSnoozed(rec?.latest ?? null)}>
              {$('panelSettings.update.snooze')}
            </Button>
            <Button variant="ghost" size="sm" disabled={!rec?.latest} onClick={() => void dismissVersion()}>
              {$('panelSettings.update.dismiss')}
            </Button>
          </>
        )}
        {selfUpdate && hasUpdate && !running && (
          <Button
            size="sm"
            disabled={preflightBusy || applying}
            onClick={() => void openPreflight(rec?.latest || info?.latest || '')}
          >
            <Download className="h-3.5 w-3.5" />
            {preflightBusy ? $('panelSettings.update.preflight.checking') : $('panelSettings.update.apply')}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy || running} onClick={() => check(true)}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          {busy ? $('panelSettings.version.checking') : $('panelSettings.version.check')}
        </Button>
      </FormActions>
    </SettingsCard>
  );
}

/**
 * 更新策略：off / notify / auto 三选一 + 自定义下载源。
 *
 * 为什么 auto 也要「发布方声明可安全自动安装」才生效：
 *   面板自更新会替换自己的可执行文件并重启，出了问题是没法从界面上救回来的；
 *   所以自动只能用在发布方明确标注过、且**没有**破坏性/跨版本/不可逆属性的版本上。
 *   跨版本与破坏性更新永远要用户点确认——这条取舍不交给「用户开了自动就全自动」，
 *   否则一次自动升级就能把用户留在无法回滚的坏版本上。
 */
function UpdatePolicyCard({
  data,
  reload,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
  className?: string;
}) {
  const { success, error } = useToastHelpers();
  const [auto, setAuto] = useState<PanelUpdatePolicy['auto']>(data.update?.auto ?? DEFAULT_UPDATE_POLICY.auto);
  const [source, setSource] = useState(data.update?.source ?? '');
  const [saving, setSaving] = useState(false);

  // 依赖具体字段而非 data.update 整体：load() 每次都会造一个新对象，
  // 按对象引用同步会把用户正在编辑的下载源覆盖回旧值
  useEffect(() => {
    setAuto(data.update?.auto ?? DEFAULT_UPDATE_POLICY.auto);
    setSource(data.update?.source ?? '');
  }, [data.update?.auto, data.update?.source]);

  const modes: PanelUpdatePolicy['auto'][] = ['off', 'notify', 'auto'];
  const modeLabel: Record<PanelUpdatePolicy['auto'], string> = {
    off: $('panelSettings.update.auto.off'),
    notify: $('panelSettings.update.auto.notify'),
    auto: $('panelSettings.update.auto.auto'),
  };
  const modeHint: Record<PanelUpdatePolicy['auto'], string> = {
    off: $('panelSettings.update.auto.hint.off'),
    notify: $('panelSettings.update.auto.hint.notify'),
    auto: $('panelSettings.update.auto.hint.auto'),
  };
  const sourceTrim = source.trim();
  const sourceInvalid = !!sourceTrim && !/^https?:\/\//i.test(sourceTrim);
  // 与「保存后重进页面」看到的状态一致即视为没改动，避免空 PUT
  const nothingChanged = auto === (data.update?.auto ?? DEFAULT_UPDATE_POLICY.auto) && sourceTrim === (data.update?.source ?? '');

  return (
    <SettingsCard
      title={$('panelSettings.update.policy.title')}
      description={$('panelSettings.update.policy.desc')}
      className={className}
    >
      <FormGrid>
        {/* 三选一：用按钮组而不是下拉，选项只有三个且说明文字要随选择变化 */}
        <Field label={$('panelSettings.update.auto.title')} hint={modeHint[auto]}>
          <div className="inline-flex w-fit rounded-md border border-border bg-muted/40 p-0.5">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                disabled={saving}
                onClick={() => setAuto(m)}
                className={`h-6 rounded px-2 text-[11.5px] transition-colors disabled:opacity-60 ${
                  auto === m
                    ? 'bg-background font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {modeLabel[m]}
              </button>
            ))}
          </div>
        </Field>
        <Field
          htmlFor="ps-update-source"
          label={$('panelSettings.update.source')}
          hint={$('panelSettings.update.source.hint')}
          error={sourceInvalid ? $('panelSettings.update.source.invalid') : undefined}
        >
          <Input
            id="ps-update-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={$('panelSettings.update.source.placeholder')}
          />
        </Field>
      </FormGrid>
      <FormActions>
        <Button
          size="sm"
          disabled={saving || sourceInvalid || nothingChanged}
          onClick={async () => {
            setSaving(true);
            try {
              // 只发策略字段：dismissed 由版本卡单独维护，这里带上会让「跳过此版本」互相覆盖
              await api('/settings', { method: 'PUT', body: { update: { auto, source: sourceTrim } } });
              success($('panelSettings.update.policy.saved'));
              reload();
            } catch (e) {
              error($('panelSettings.update.policy.saveFailed'), errText(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          {$('panelSettings.update.policy.save')}
        </Button>
      </FormActions>
    </SettingsCard>
  );
}

/** 开关行：标题 + 说明 + 右侧开关（无边框，用一条发丝线分隔） */
function ToggleRow({
  title,
  description,
  checked,
  onCheckedChange,
  className = '',
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-3 py-2.5 ${className}`}>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-[12.5px] font-medium">{title}</span>
        {description && <span className="text-[11px] leading-4 text-muted-foreground">{description}</span>}
      </span>
      <Switch
        className="ml-auto shrink-0"
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
      />
    </label>
  );
}

// ---------- 登录保护 ----------
function AuthCard({
  data,
  onAuthChanged,
  reload,
  className = '',
}: {
  data: PanelSettings;
  onAuthChanged: (authEnabled: boolean) => void;
  reload: () => void;
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
  const pw1Error = pwTooShort ? $('panelSettings.auth.password.tooShort') : undefined;
  const pwHint = needPassword ? $('panelSettings.auth.password.hintSet') : $('panelSettings.auth.password.hintKeep');

  // 没做任何改动时禁用保存（避免空请求）
  const nothingChanged = authOn === data.authEnabled && pw1.length === 0;

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { authEnabled: authOn, username: newUser };
      if (authOn && pw1) body.password = pw1;
      const r = await api<{ authEnabled: boolean }>('/settings', { method: 'PUT', body });
      success(r.authEnabled ? $('panelSettings.auth.toast.enabled') : $('panelSettings.auth.toast.disabled'));
      setPw1('');
      setPw2('');
      onAuthChanged(r.authEnabled);
      reload();
    } catch (e) {
      error($('panelSettings.error.save'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title={$('panelSettings.auth.title')}
      description={$('panelSettings.auth.desc')}
      className={className}
      status={
        <div className="flex items-center gap-2">
          <Switch
            className="shrink-0"
            checked={authOn}
            onCheckedChange={(v) => setAuthOn(v === true)}
          />
          <StateChip ok={authOn} okText={$('panelSettings.auth.enabled')} badText={$('panelSettings.auth.disabled')} />
        </div>
      }
    >
      {/* 表单区常驻渲染：开关只切换可用性，区块高度不随开/关变化。
          关闭时整体置灰并禁用，配合右上角「未启用」状态章表达不可用状态。 */}
      <FormGrid
        className={
          authOn
            ? 'max-w-none sm:grid-cols-3'
            : 'pointer-events-none max-w-none opacity-60 transition-opacity sm:grid-cols-3'
        }
      >
        {/* 三列并排：用户名 / 密码 / 确认密码，宽屏下不再挤在左侧 620 里 */}
        <Field
          htmlFor="ps-user"
          label={$('panelSettings.auth.username')}
          hint={$('panelSettings.auth.username.hint')}
          error={authOn ? userInvalid ? $('panelSettings.auth.username.invalid') : undefined : undefined}
        >
          <Input
            id="ps-user"
            autoComplete="username"
            className="sm:max-w-[280px]"
            disabled={!authOn}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
          />
        </Field>
        <Field
          htmlFor="ps-pw1"
          label={$('panelSettings.auth.password')}
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
          label={$('panelSettings.auth.passwordConfirm')}
          hint={$('panelSettings.auth.passwordConfirm.hint')}
          error={authOn ? pw2Mismatch ? $('panelSettings.auth.passwordConfirm.mismatch') : undefined : undefined}
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
      </FormGrid>
      <FormActions className="max-w-none">
        <Button
          size="sm"
          disabled={busy || nothingChanged || userInvalid || userEmpty || pwTooShort || pwMissing || pw2Mismatch}
          onClick={save}
        >
          {$('common.save')}
        </Button>
      </FormActions>
    </SettingsCard>
  );
}

// ---------- 公网访问 ----------
function DomainCard({
  data,
  reload,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
  className?: string;
}) {
  const { success, error } = useToastHelpers();
  const [domain, setDomain] = useState(data.domain);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDomain(data.domain), [data.domain]);

  return (
    <SettingsCard
      title={$('panelSettings.domain.title')}
      description={$('panelSettings.domain.desc')}
      className={className}
      status={<StateChip ok={!!domain.trim()} okText={$('panelSettings.domain.bound')} badText={$('panelSettings.domain.unbound')} />}
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <Field
          htmlFor="ps-domain"
          label={$('panelSettings.domain.label')}
          hint={$('panelSettings.domain.hint')}
        >
          <Input
            id="ps-domain"
            className="font-mono"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="panel.example.com"
          />
        </Field>
        <p className="self-end text-[11px] leading-5 text-muted-foreground/80">
          {$('panelSettings.domain.sslHint.pre')}
          <code className="font-mono">--host 0.0.0.0</code>
          {$('panelSettings.domain.sslHint.post')}
        </p>
      </div>
      <FormActions>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/settings', { method: 'PUT', body: { domain } });
              success($('panelSettings.saved'));
              reload();
            } catch (e) {
              error($('panelSettings.error.save'), errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {$('common.save')}
        </Button>
      </FormActions>
    </SettingsCard>
  );
}

// ---------- SMTP 邮件 ----------
function SmtpCard({
  data,
  reload,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
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
      title={$('panelSettings.smtp.title')}
      description={$('panelSettings.smtp.desc')}
      status={<StateChip ok={data.smtpReady} okText={$('panelSettings.smtp.ready')} badText={$('panelSettings.smtp.notConfigured')} />}
      className={className}
    >
      <FormGrid>
        <Field htmlFor="ps-smtp-host" label={$('panelSettings.smtp.host')} hint={$('panelSettings.smtp.host.hint')}>
          <Input
            id="ps-smtp-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.qq.com"
          />
        </Field>
        <Field htmlFor="ps-smtp-port" label={$('panelSettings.smtp.port')} hint={$('panelSettings.smtp.port.hint')}>
          <Input
            id="ps-smtp-port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="465"
          />
        </Field>
        <Field htmlFor="ps-smtp-user" label={$('panelSettings.smtp.user')} hint={$('panelSettings.smtp.user.hint')}>
          <Input
            id="ps-smtp-user"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="you@qq.com"
          />
        </Field>
        <Field
          htmlFor="ps-smtp-pass"
          label={$('panelSettings.smtp.pass')}
          hint={data.smtp.hasPass ? $('panelSettings.smtp.pass.hintSaved') : undefined}
        >
          <Input
            id="ps-smtp-pass"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="••••••"
          />
        </Field>
        <Field
          htmlFor="ps-smtp-from"
          label={$('panelSettings.smtp.from')}
          hint={$('panelSettings.smtp.from.hint')}
          error={fromInvalid ? $('panelSettings.smtp.from.invalid') : undefined}
          className="sm:col-span-2"
        >
          <Input
            id="ps-smtp-from"
            className="sm:max-w-[380px]"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder={$('panelSettings.smtp.from.placeholder')}
          />
        </Field>
      </FormGrid>
      <ToggleRow
        title={$('panelSettings.smtp.tls')}
        description={secure ? $('panelSettings.smtp.secureOn') : $('panelSettings.smtp.secureOff')}
        checked={secure}
        onCheckedChange={setSecure}
        className="max-w-[620px]"
      />
      <FormActions>
        <Button
          variant="outline"
          size="sm"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            try {
              await api('/settings', { method: 'PUT', body: saveBody() });
              await api('/settings/smtp-test', { method: 'POST', body: {} });
              success($('panelSettings.smtp.testSent'), $('panelSettings.smtp.testSentDetail'));
              reload();
            } catch (e) {
              error($('panelSettings.smtp.testFailed'), errText(e));
            } finally {
              setTesting(false);
            }
          }}
        >
          <MailCheck className="h-3.5 w-3.5" /> {testing ? $('panelSettings.smtp.testing') : $('panelSettings.smtp.saveAndTest')}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/settings', { method: 'PUT', body: saveBody() });
              success($('panelSettings.smtp.saved'));
              reload();
            } catch (e) {
              error($('panelSettings.error.save'), errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {$('common.save')}
        </Button>
      </FormActions>
    </SettingsCard>
  );
}

/** AI 连接测试结果：模型 / 状态 / 首字 / 总耗时 / Token */
function AiTestSummary({ result }: { result: AiTestResult }) {
  const ms = (n?: number) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n + ' ms');
  const u = result.usage;
  const tokens =
    u && u.totalTokens != null ? String(u.totalTokens) : u ? '—' : $('panelSettings.ai.test.tokensMissing');
  const detail =
    u && (u.promptTokens != null || u.completionTokens != null)
      ? $('panelSettings.ai.test.usageDetail', u.promptTokens ?? '—', u.completionTokens ?? '—')
      : '';
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{$('panelSettings.ai.test.status')}</span>
          <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {$('panelSettings.ai.test.ok', result.status ?? 200)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{$('panelSettings.ai.test.model')}</span>
          <span className="font-mono font-medium">{result.model || '—'}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{$('panelSettings.ai.test.firstToken')}</span>
          <span className="font-mono">{ms(result.firstTokenMs)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{$('panelSettings.ai.test.totalTime')}</span>
          <span className="font-mono">{ms(result.totalMs)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{$('panelSettings.ai.test.tokens')}</span>
          <span className="font-mono">
            {tokens}
            {detail && <span className="text-muted-foreground"> {detail}</span>}
          </span>
        </span>
      </div>
      {result.reply && (
        <div className="text-muted-foreground">
          {$('panelSettings.ai.test.reply')}<span className="text-foreground">{result.reply}</span>
        </div>
      )}
    </div>
  );
}

// ---------- 通知设置 ----------
function NotifyCard({
  data,
  reload,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
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
      title={$('panelSettings.notify.title')}
      description={$('panelSettings.notify.desc')}
      className={className}
    >
      <Field
        htmlFor="ps-admin-email"
        label={$('panelSettings.notify.email')}
        hint={$('panelSettings.notify.email.hint')}
        error={emailInvalid ? $('panelSettings.notify.email.invalid') : undefined}
        className="max-w-[320px]"
      >
        <Input
          id="ps-admin-email"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          placeholder="you@qq.com"
        />
      </Field>
      {/* 两个开关各占一行（面板宽度必然触发 sm，不能用 sm:flex-row 并排） */}
      <div className="grid max-w-[620px]">
        <ToggleRow
          title={$('panelSettings.notify.offline')}
          description={$('panelSettings.notify.offline.desc')}
          checked={offline}
          onCheckedChange={setOffline}
        />
        <ToggleRow
          title={$('panelSettings.notify.recovery')}
          description={$('panelSettings.notify.recovery.desc')}
          checked={recovery}
          onCheckedChange={setRecovery}
        />
      </div>
      <FormActions>
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
              success($('panelSettings.notify.toast.saved'));
              reload();
            } catch (e) {
              error($('panelSettings.error.save'), errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {$('common.save')}
        </Button>
      </FormActions>
    </SettingsCard>
  );
}

// ---------- AI 日志分析 ----------
function AiCard({
  data,
  reload,
  className = '',
}: {
  data: PanelSettings;
  reload: () => void;
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
      if (!list.length) error($('panelSettings.ai.fetchModels.error.none'), $('panelSettings.ai.fetchModels.error.noneDetail'));
      else success($('panelSettings.ai.fetchModels.success', list.length));
    } catch (e) {
      error($('panelSettings.ai.fetchModels.error'), errText(e));
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <SettingsCard
      title={$('panelSettings.ai.title')}
      description={$('panelSettings.ai.desc')}
      className={className}
      status={
        <div className="flex items-center gap-2">
          <Switch
            className="shrink-0"
            checked={aiOn}
            onCheckedChange={(v) => setAiOn(v === true)}
          />
          <StateChip ok={aiOn} okText={$('panelSettings.ai.enabled')} badText={$('panelSettings.ai.disabled')} />
        </div>
      }
    >
      {/* 配置区始终可编辑：开关只决定「是否启用分析」，不锁配置。
          否则未启用时既填不了地址密钥、也点不了「查询模型」，形成先有蛋后有鸡的死结。 */}
      <FormGrid className="max-w-none">
        <Field
          htmlFor="ps-ai-base"
          label={$('panelSettings.ai.base')}
          hint={$('panelSettings.ai.base.hint')}
          error={baseInvalid ? $('panelSettings.ai.base.invalid') : undefined}
        >
          <Input
            id="ps-ai-base"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com"
          />
        </Field>
        <Field
          htmlFor="ps-ai-model"
          label={$('panelSettings.ai.model')}
          hint={models.length ? $('panelSettings.ai.model.hintCount', models.length) : $('panelSettings.ai.model.hintFetch')}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {models.length ? (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="ps-ai-model" className="w-60" aria-label={$('panelSettings.ai.model')}>
                  <SelectValue placeholder={$('panelSettings.ai.model.placeholder')} />
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
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="deepseek-flash"
              />
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={loadingModels || baseInvalid || !baseTrim || !hasKey}
              onClick={fetchModels}
              title={$('panelSettings.ai.fetchModels.tooltip')}
            >
              {loadingModels ? $('panelSettings.ai.fetching') : $('panelSettings.ai.fetchModels')}
            </Button>
          </div>
        </Field>
        <Field
          htmlFor="ps-ai-key"
          label={$('panelSettings.ai.key')}
          hint={data.ai.hasKey ? $('panelSettings.ai.key.hintSaved') : undefined}
          error={keyMissing ? $('panelSettings.ai.key.hintMissing') : undefined}
          className="sm:col-span-2"
        >
          <Input
            id="ps-ai-key"
            type="password"
            className="font-mono"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data.ai.hasKey ? $('panelSettings.ai.key.hintSaved') : 'sk-…'}
          />
        </Field>
      </FormGrid>
      <p className="max-w-none text-[11px] leading-4 text-muted-foreground/80">
        {$('panelSettings.ai.privacy')}
      </p>
      {testResult && <AiTestSummary result={testResult} />}
      <FormActions>
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
              success($('panelSettings.ai.test.success'), r.reply || $('panelSettings.ai.test.successDetail'));
            } catch (e) {
              error($('panelSettings.ai.test.failed'), errText(e));
            } finally {
              setTesting(false);
            }
          }}
        >
          <Sparkles className="h-3.5 w-3.5" /> {testing ? $('panelSettings.ai.test.busy') : $('panelSettings.ai.test.button')}
        </Button>
        <Button
          size="sm"
          disabled={busy || baseInvalid || incomplete || nothingChanged}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/settings', { method: 'PUT', body: saveBody() });
              success(aiOn ? $('panelSettings.ai.toast.enabled') : $('panelSettings.ai.toast.disabled'));
              setApiKey('');
              reload();
            } catch (e) {
              error($('panelSettings.error.save'), errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {$('common.save')}
        </Button>
      </FormActions>
    </SettingsCard>
  );
}
