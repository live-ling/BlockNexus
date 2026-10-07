// App：左侧窄导航栏（logo）+ 底部中央展开式操作条（beUI ExpandableActionBar）+ 登录态管理

import { useCallback, useEffect, useState } from 'react';
import { LogOut, Server, Settings, ShieldAlert } from 'lucide-react';
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
import { ApiError, api, type Me, type ServerSummary } from '@/lib/api';
import { LanguageToggle } from '@/components/language-toggle';
import { $ } from '@/lib/i18n';
import { closeSSE, connectSSE, subscribeSSE } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';
import { navigate, routeFromLocation, type Route } from '@/lib/router';

// 路由形态（history 路由，旧 #/hash 链接仍兼容）：
//   /                        服务器列表
//   /settings                面板设置
//   /about                   关于页（设置页底部进入）
//   /reset?token=…           重置密码（忘记密码邮件里的链接）
//   /server/<id>             服务器详情（实例列表）
//   /server/<id>/settings    服务器设置
//   /server/<id>/instance/<名称>  实例详情（终端 + 控件）

export function App() {
  const { success: toastSuccess, error: toastError } = useToastHelpers();
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined=启动中, null=未登录
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [route, setRoute] = useState<Route>(routeFromLocation);

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
      {showNav && <NavRail me={me} route={route} onLogout={logout} />}
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
function NavRail({ me, route, onLogout }: { me: Me; route: Route; onLogout: () => void }) {
  const isServersPage = route.name === 'servers';
  const isServerArea =
    route.name === 'servers' ||
    route.name === 'server' ||
    route.name === 'server-settings' ||
    route.name === 'instance';
  // 关于页从设置页进入，导航上仍高亮「面板设置」
  const isSettings = route.name === 'settings' || route.name === 'about';

  const items: ExpandableActionBarItem[] = [
    {
      id: 'logo',
      label: 'BlockNexus',
      icon: (
        <img src="/logo.png" alt="BlockNexus" className="h-6 w-6 max-w-none rounded-full object-cover ring-1 ring-border" />
      ),
      active: isServersPage,
      onClick: () => (navigate('/')),
    },
    {
      id: 'servers',
      label: $('nav.servers'),
      icon: <Server className="h-[18px] w-[18px]" />,
      active: isServerArea,
      onClick: () => (navigate('/')),
    },
    {
      id: 'settings',
      label: $('nav.settings'),
      icon: <Settings className="h-[18px] w-[18px]" />,
      active: isSettings,
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
      {/* 语言切换：登录后也能改（登录页另有一份，因为那时还没进 App） */}
      <LanguageToggle className="fixed right-4 top-4 z-40 bg-background/60 backdrop-blur" />
      <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2">
        <ExpandableActionBar items={items} size="md" collapseOnBlur={false} />
      </div>
    </>
  );
}
