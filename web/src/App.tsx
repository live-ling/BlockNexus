// App：左侧窄导航栏（logo）+ 底部中央展开式操作条（beUI ExpandableActionBar）+ 登录态管理

import { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, Boxes, Server, Settings, ShieldAlert } from 'lucide-react';
import {
  ExpandableActionBar,
  type ExpandableActionBarItem,
} from '@/components/motion/expandable-action-bar';
import { ResetPasswordPage, LoginPage } from '@/pages/login';
import { AboutPage } from '@/pages/about';
import { PanelSettingsPage } from '@/pages/panel-settings';
import { InstanceDetailPage } from '@/pages/instance-detail';
import { ServerDetailPage } from '@/pages/server-detail';
import { ServerSettingsPage } from '@/pages/server-settings';
import { ServersPage } from '@/pages/servers';
import { InstancesPage } from '@/pages/instances';
import { ApiError, api, getPanelUpdateStatus, getVersion, versionAtLeast, type AppVersionRecommendation, type Me, type PanelUpdateState, type ServerSummary } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { closeSSE, connectSSE, subscribeSSE } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';
import { navigate, routeFromLocation, type Route } from '@/lib/router';
import { PrototypeApp } from '@/prototype';

// 更新进行中的状态（与 panel-settings.tsx 的 RUNNING_STATES 同一份语义）：
// 这些阶段面板随时会重启，期间不能再去请求 /version（会拿到连接失败），也不该再触发别的操作
const UPDATE_RUNNING_STATES: PanelUpdateState['state'][] = [
  'downloading',
  'verifying',
  'staging',
  'applying',
  'restarting',
];

/** 本地刚发起过更新时，最多轮询 3 分钟等面板带着新版本回来 */
const RELOAD_POLL_MAX_MS = 3 * 60 * 1000;
const RELOAD_POLL_INTERVAL_MS = 2000;

// 路由形态（history 路由，旧 #/hash 链接仍兼容）：
//   /                        实例总览（默认落地页：所有服务器的所有游戏实例）
//   /instances               同上（显式写法）
//   /servers                 服务器列表（卡片：Agent 状态、系统信息、资源占用）
//   /settings                面板设置
//   /about                   关于页（设置页底部进入）
//   /reset?token=…           重置密码（忘记密码邮件里的链接）
//   /server/<id>             服务器详情（实例列表）
//   /server/<id>/settings    服务器设置
//   /server/<id>/instance/<名称>  实例详情（终端 + 控件）

export function App() {
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToastHelpers();
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined=启动中, null=未登录
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [route, setRoute] = useState<Route>(routeFromLocation);
  // 更新建议（导航徽章用）。只存 recommendation，避免把整份版本信息塞进 App 的渲染依赖
  const [recommendation, setRecommendation] = useState<AppVersionRecommendation | null>(null);
  // 启动时的面板版本：用它判断「面板在页面开着的时候被换掉了」
  const bootVersionRef = useRef<string | null>(null);
  const [panelUpdate, setPanelUpdate] = useState<PanelUpdateState | null>(null);
  // 本地刚提交过更新（POST 受理到后端状态变成 restarting 之间有个窗口期）
  const [updateSubmitted, setUpdateSubmitted] = useState(false);
  // 轮询的版本基准：被 reload-check 改写后触发重新判断
  const [pollTick, setPollTick] = useState(0);

  /** 更新进行中（含刚提交的窗口期）：此时一切「再确认一次版本」的请求都要让路 */
  const updateBusy = !!panelUpdate && UPDATE_RUNNING_STATES.includes(panelUpdate.state);

  /** 拉一次更新状态（进页面/收到 SSE/轮询时都会调）。失败是更新期间的常态，静默处理 */
  const loadUpdateStatus = useCallback(async () => {
    try {
      const st = await getPanelUpdateStatus();
      setPanelUpdate(st);
      if (st.inFlight || st.state === 'restarting') setUpdateSubmitted(true);
    } catch {
      // 面板正在换包重启时这个请求必然失败；「等它回来」由下面的轮询负责，这里不打扰用户
    }
  }, []);

  const boot = useCallback(async () => {
    try {
      const meData = await api<Me>('/me');
      const list = await api<ServerSummary[]>('/servers');
      setMe(meData);
      setServers(list);
      connectSSE();
    } catch {
      setMe(null);
      closeSSE();
    }
  }, []);

  useEffect(() => {
    boot();
    const onRoute = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onRoute);
    window.addEventListener('routechange', onRoute);
    return () => {
      window.removeEventListener('popstate', onRoute);
      window.removeEventListener('routechange', onRoute);
    };
  }, [boot]);

  /**
   * 启动时取一次版本信息（导航徽章的**唯一**数据来源）。
   * 刻意不做全局定时轮询：面板是本地服务，用户实际关心更新的时刻就是打开设置页，
   * 而设置页自己会请求一次——这里再挂个每分钟的定时器只是白白唤醒后端去查 GitHub。
   */
  useEffect(() => {
    getVersion()
      .then((v) => {
        setRecommendation(v.recommendation ?? null);
        // 基准版本只在第一次拿到时记下：之后的重取（窗口获焦）是拿它做对比用的
        if (bootVersionRef.current === null) bootVersionRef.current = v.version ?? null;
      })
      .catch(() => {
        // 启动时检查失败不打扰用户（可能只是没网）；徽章不显示即可
      });
    // 顺手看一眼有没有正在跑的更新：有的话下面会自动切到轮询模式
    void loadUpdateStatus();
  }, [loadUpdateStatus]);

  // 更新过程的事件：App 只负责跟踪状态与徽章/重载，具体阶段文案由设置页渲染。
  // 状态每次变化都推进一次 pollTick：它同时驱动「重载判断」重跑，
  // 这样即便 SSE 丢帧，下一次 /status 也会把最新状态补上（lastResult/rollback 只由 /status 给）。
  useEffect(
    () =>
      subscribeSSE((e) => {
        if (e.type !== 'panel-update') return;
        setPanelUpdate(e);
        setPollTick((v) => v + 1);
      }),
    [],
  );

  // 版本卡提交更新后广播过来（跨组件通信走 window 事件，不引全局状态库）
  useEffect(() => {
    const onSubmitted = () => {
      setUpdateSubmitted(true);
      setPollTick((v) => v + 1);
    };
    window.addEventListener('panel-update-submitted', onSubmitted);
    return () => window.removeEventListener('panel-update-submitted', onSubmitted);
  }, []);

  /**
   * 自己发起过更新 → 每 2 秒看一次面板回来了没有（最多 3 分钟）。
   *
   * 为什么是轮询而不是等 SSE：换包意味着进程重启，重启期间 SSE 连接本身是断的，
   * 恰恰在「最需要知道结果」的那一刻没有推送可听——只能主动问。旧版本先返回也无妨，
   * versionAtLeast 会继续等，直到 /version 报出新版本才刷新页面。
   */
  useEffect(() => {
    if (!updateSubmitted && !updateBusy) return;
    const want = panelUpdate?.to || null;
    const deadline = Date.now() + RELOAD_POLL_MAX_MS;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        return;
      }
      try {
        const v = await getVersion();
        if (want && versionAtLeast(v.version, want)) {
          clearInterval(timer);
          location.reload();
        }
      } catch {
        // 面板还没起来，继续等
      }
    }, RELOAD_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
    // want 变化（后端进入更新态、拿到了 to）时要重新起算，否则会错过目标版本
  }, [updateSubmitted, updateBusy, panelUpdate?.to, pollTick]);

  /**
   * 窗口重新获焦时再看一眼版本：面板被别的途径升级过（手动装、另一个窗口点的更新），
   * 当前页面跑的还是旧前端，提示用户刷新。提示只在真的变了之后给一次，不重复打扰。
   */
  useEffect(() => {
    const onFocus = async () => {
      // 自己正在更新时不要检查：这时候 /version 大概率因为重启而失败，只会白弹一条错误
      if (updateBusy) return;
      try {
        const v = await getVersion();
        const boot = bootVersionRef.current;
        if (boot && v.version && v.version !== boot) {
          // 提供一个可点的 toast：点击后刷新。没有动作按钮组件，用一次性 click 监听承接
          toastInfo($('panelSettings.update.reload'), $('panelSettings.update.reloadDetail'));
          const reload = () => {
            window.removeEventListener('click', reload);
            location.reload();
          };
          window.addEventListener('click', reload, { once: true });
        }
      } catch {
        // 忽略：获焦时的静默检查失败不该打扰用户
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [toastInfo, updateBusy]);

  // 服务器状态变化 → 更新列表
  const refreshServer = useCallback((serverId: string) => {
    api<ServerSummary>(`/servers/${serverId}`)
      .then((fresh) => setServers((cur) => cur.map((s) => (s.id === serverId ? fresh : s))))
      .catch((e) => {
        // 服务器已被移除（如卸载时勾选「同时移除」）→ 从首页列表去掉
        if ((e as { status?: number }).status === 404) {
          setServers((cur) => cur.filter((s) => s.id !== serverId));
        }
      });
  }, []);

  useEffect(() => {
    return subscribeSSE((e) => {
      if (e.type === 'status') {
        setServers((cur) =>
          cur.map((s) =>
            s.id === e.serverId
              ? {
                  ...s,
                  status: e.status,
                  online: e.status === 'online',
                  // 上线即结束「安装中」状态（首页徽章据此显示延迟/离线）
                  installing: e.status === 'online' ? false : s.installing,
                  lastSeen: e.status === 'online' ? Date.now() : s.lastSeen,
                }
              : s,
          ),
        );
      }
      if (e.type === 'latency') {
        setServers((cur) =>
          cur.map((s) => (s.id === e.serverId ? { ...s, latency: e.latency } : s)),
        );
      }
      if (e.type === 'stats') {
        setServers((cur) =>
          cur.map((s) => (s.id === e.serverId ? { ...s, stats: e.stats } : s)),
        );
      }
      // hi = Agent 接入后的系统信息快照；java.updated = Java 状态变化 → 拉取最新服务器数据
      if (e.type === 'agent-event' && (e.event === 'hi' || e.event === 'java.updated')) {
        refreshServer(e.serverId);
        return;
      }
      // Agent 自动更新（版本落后时面板自动执行；结果也刷新服务器数据）
      if (e.type === 'agent-update') {
        const st = e.state as 'updating' | 'failed' | 'done';
        if (st === 'failed') toastError($('app.agentUpdate.failed'), e.error || '');
        if (st === 'done') toastSuccess($('app.agentUpdate.done'), $('app.agentUpdate.doneDetail'));
        setServers((cur) =>
          cur.map((s) =>
            s.id === e.serverId
              ? { ...s, agentUpdate: st === 'done' ? null : { state: st, error: e.error } }
              : s,
          ),
        );
        if (st === 'done') refreshServer(e.serverId);
      }
      // 安装/卸载收尾 → 拉取最新状态（失败时清「安装中」、卸载移除时清列表项）
      if ((e.type === 'install' || e.type === 'uninstall') && e.done) {
        refreshServer(e.serverId);
      }
    });
  }, [refreshServer]);

  const logout = async () => {
    await api('/logout', { method: 'POST', body: {} }).catch(() => {});
    location.reload();
  };

  // 布局原型：/proto 在登录态判断**之前**渲染——原型不读登录态、不发请求，
  // 未开启登录保护或已登录都能直接打开对照设计稿。确认排版后随原型代码一起删除。
  if (location.pathname === '/proto') {
    return <PrototypeApp />;
  }

  if (me === undefined) {
    return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">{$('common.loading')}</div>;
  }

  // 重置密码页独立于登录态（邮件链接直达；已登录时也能打开）
  if (route.name === 'reset') {
    return <ResetPasswordPage token={route.token} onDone={() => (navigate('/'))} />;
  }

  if (me === null) {
    return <LoginPage onLogin={boot} />;
  }

  // 实例详情页专注终端与控制，不显示导航栏（返回按钮在页面内）
  const showNav = route.name !== 'instance';

  return (
    <div className="min-h-screen">
      {showNav && <NavRail me={me} route={route} onLogout={logout} recommendation={recommendation} />}
      <div className={showNav ? 'pl-0' : ''}>
        {route.name === 'settings' ? (
          <PanelSettingsPage
            onBack={() => (navigate('/'))}
            onAuthChanged={(authEnabled) => setMe((cur) => (cur ? { ...cur, authEnabled } : cur))}
          />
        ) : route.name === 'about' ? (
          <AboutPage onBack={() => (navigate('/settings'))} />
        ) : route.name === 'instance' ? (
        <InstanceDetailPage
          key={`${route.serverId}/${route.instance}`}
          serverId={route.serverId}
          instanceName={route.instance}
          onBack={() => (navigate(`/server/${route.serverId}`))}
        />
      ) : route.name === 'server-settings' ? (
        <ServerSettingsPage
          key={route.serverId}
          serverId={route.serverId}
          me={me}
          onBack={() => (navigate(`/server/${route.serverId}`))}
          onDeleted={() => {
            setServers((cur) => cur.filter((s) => s.id !== route.serverId));
            navigate('/');
          }}
        />
      ) : route.name === 'server' ? (
        <ServerDetailPage
          key={route.serverId}
          id={route.serverId}
          onOpenInstance={(name) => (navigate(`/server/${route.serverId}/instance/${encodeURIComponent(name)}`))}
          onOpenSettings={() => (navigate(`/server/${route.serverId}/settings`))}
        />
      ) : route.name === 'instances' ? (
        // 默认落地页：所有服务器的所有游戏实例（按服务器分组）
        <InstancesPage
          me={me}
          servers={servers}
          onAdd={(s) => setServers((cur) => [...cur, { ...s, online: false }])}
        />
      ) : (
        <ServersPage
          me={me}
          servers={servers}
          onAdd={(s) => setServers((cur) => [...cur, { ...s, online: false }])}
          onReorder={(ids) =>
            setServers((cur) => ids.map((id) => cur.find((s) => s.id === id)).filter(Boolean) as ServerSummary[])
          }
        />
      )}
      </div>
    </div>
  );
}

// 会话失效时统一回到登录态。
// 判定只用**稳定且与语言无关**的信号：
//   · 后端错误码 ApiError.code（已迁移的接口）
//   · HTTP 401（覆盖所有尚未迁移 code 的接口）
// 刻意**不**匹配文案：面板是双语的，文案会随 Accept-Language 变化，
// 靠 `msg.includes('未登录')` 兜底在英文响应下会静默失效——
// 而 status===401 本就语言无关地覆盖了同样的场景，那条兜底是多余的。
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason;
  const isNotLoggedIn =
    (err instanceof ApiError && err.code === 'auth.not-logged-in') ||
    (err instanceof ApiError && err.status === 401);
  if (isNotLoggedIn) {
    closeSSE();
    location.reload();
  }
});

/** 左侧窄导航（logo）+ 底部中央展开式操作条（参考 beUI expandable-action-bar demo） */
function NavRail({
  me,
  route,
  onLogout,
  recommendation,
}: {
  me: Me;
  route: Route;
  onLogout: () => void;
  /** App 启动时那一次 /api/version 的结果；null = 还没检查到（徽章不显示） */
  recommendation: AppVersionRecommendation | null;
}) {
  // 「实例」区：实例总览 + 实例详情（详情页是全屏不显示导航的，但在概览里点进去也算同一区）
  const isInstanceArea = route.name === 'instances' || route.name === 'instance';
  // 「服务器」区：服务器列表 / 服务器详情 / 服务器设置。
  // 注意不再包含 instance——实例详情的所有权归「实例」区，
  // 否则从总览点进实例详情时，两个导航项会同时高亮。
  const isServerArea = route.name === 'servers' || route.name === 'server' || route.name === 'server-settings';
  // 关于页从设置页进入，导航上仍高亮「面板设置」
  const isSettings = route.name === 'settings' || route.name === 'about';

  // 「面板设置」上的小圆点：只有存在未跳过的更新建议时才挂。
  // security / critical 用红色（这是需要立刻处理的事），其余中性——不把「有个可选更新」渲染成告警。
  const updateSeverity = recommendation?.hasUpdate ? recommendation.severity : null;
  const updateBadgeDot =
    updateSeverity === 'security' || updateSeverity === 'critical' ? 'bg-destructive' : 'bg-primary';
  const settingsBadge = updateSeverity ? (
    <span
      title={$('panelSettings.version.hasNew')}
      className={`block h-1.5 w-1.5 rounded-full ${updateBadgeDot}`}
    />
  ) : undefined;

  const items: ExpandableActionBarItem[] = [
    {
      id: 'logo',
      label: 'BlockNexus',
      icon: (
        <img src="/logo.png" alt="BlockNexus" className="h-6 w-6 max-w-none rounded-full object-cover ring-1 ring-border" />
      ),
      // logo 是「回家」：默认落地页现在是实例总览
      active: isInstanceArea,
      onClick: () => (navigate('/')),
    },
    {
      id: 'instances',
      label: $('nav.instances'),
      icon: <Boxes className="h-[18px] w-[18px]" />,
      active: isInstanceArea,
      onClick: () => (navigate('/instances')),
    },
    {
      id: 'servers',
      label: $('nav.servers'),
      icon: <Server className="h-[18px] w-[18px]" />,
      active: isServerArea,
      onClick: () => (navigate('/servers')),
    },
    {
      id: 'settings',
      label: $('nav.settings'),
      icon: <Settings className="h-[18px] w-[18px]" />,
      active: isSettings,
      badge: settingsBadge,
      onClick: () => (navigate('/settings')),
    },
  ];
  // 未启用密码保护时无需登录，也就没有可退出的会话
  if (me.authEnabled) {
    items.push({
      id: 'logout',
      label: $('nav.logout'),
      icon: <LogOut className="h-[18px] w-[18px]" />,
      onClick: onLogout,
    });
  }

  return (
    <>
      {/*
        危险组合的持久横幅（审计 H5）：**对外可达 + 没开鉴权**。
        此时任何人打开这个地址就能完全接管面板——改配置、经 SSH 装 Agent、
        以 root 读写服务器文件。后端只给信号、不改默认行为（默认免密对
        「只听本机」的单用户场景是正当设计），所以这里必须显眼地提示。
        刻意不做成可关闭的 toast：这是持续存在的配置风险，不是一次性事件。
      */}
      {me.exposedWithoutAuth && (
        <div className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-destructive px-4 py-1.5 text-xs text-destructive-foreground">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          <b>{$('warning.exposedNoAuth.title')}</b>
          <span className="opacity-90">{$('warning.exposedNoAuth.desc')}</span>
        </div>
      )}
      {/* 全局语言切换已搬到「设置 → 语言」（panel-settings.tsx 的 LanguageCard）。
          不再放漂浮按钮——登录前由 initLanguage() 按浏览器自动判定登录页语言。 */}
      <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2">
        <ExpandableActionBar items={items} size="md" collapseOnBlur={false} />
      </div>
    </>
  );
}
