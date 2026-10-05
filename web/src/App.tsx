// App：左侧窄导航栏（logo）+ 底部中央展开式操作条（beUI ExpandableActionBar）+ 登录态管理

import { useCallback, useEffect, useState } from 'react';
import { LogOut, Server, Settings } from 'lucide-react';
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
import { api, type Me, type ServerSummary } from '@/lib/api';
import { closeSSE, connectSSE, subscribeSSE } from '@/lib/sse';

type Route =
  | { name: 'servers' }
  | { name: 'settings' }
  | { name: 'about' }
  | { name: 'reset'; token: string }
  | { name: 'server'; serverId: string }
  | { name: 'server-settings'; serverId: string }
  | { name: 'instance'; serverId: string; instance: string };

// 路由形态：
//   #/                       服务器列表
//   #/settings               面板设置
//   #/about                  关于页（设置页底部进入）
//   #/reset?token=…          重置密码（忘记密码邮件里的链接）
//   #/server/<id>            服务器详情（实例列表）
//   #/server/<id>/settings   服务器设置
//   #/server/<id>/instance/<名称>  实例详情（终端 + 控件）
function parseHash(): Route {
  const [hashPath, queryString = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const query = new URLSearchParams(queryString);
  const parts = hashPath.split('/').filter(Boolean);
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'about') return { name: 'about' };
  if (parts[0] === 'reset') return { name: 'reset', token: query.get('token') || '' };
  if (parts[0] === 'server' && parts[1]) {
    if (parts[2] === 'settings') return { name: 'server-settings', serverId: parts[1] };
    if (parts[2] === 'instance' && parts[3]) {
      return { name: 'instance', serverId: parts[1], instance: decodeURIComponent(parts.slice(3).join('/')) };
    }
    return { name: 'server', serverId: parts[1] };
  }
  return { name: 'servers' };
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined=启动中, null=未登录
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [route, setRoute] = useState<Route>(parseHash);

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
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
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
    return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">加载中…</div>;
  }

  // 重置密码页独立于登录态（邮件链接直达；已登录时也能打开）
  if (route.name === 'reset') {
    return <ResetPasswordPage token={route.token} onDone={() => (location.hash = '#/')} />;
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
            onBack={() => (location.hash = '#/')}
            onAuthChanged={(authEnabled) => setMe((cur) => (cur ? { ...cur, authEnabled } : cur))}
          />
        ) : route.name === 'about' ? (
          <AboutPage onBack={() => (location.hash = '#/settings')} />
        ) : route.name === 'instance' ? (
        <InstanceDetailPage
          key={`${route.serverId}/${route.instance}`}
          serverId={route.serverId}
          instanceName={route.instance}
          onBack={() => (location.hash = `#/server/${route.serverId}`)}
        />
      ) : route.name === 'server-settings' ? (
        <ServerSettingsPage
          key={route.serverId}
          serverId={route.serverId}
          me={me}
          onBack={() => (location.hash = `#/server/${route.serverId}`)}
          onDeleted={() => {
            setServers((cur) => cur.filter((s) => s.id !== route.serverId));
            location.hash = '#/';
          }}
        />
      ) : route.name === 'server' ? (
        <ServerDetailPage
          key={route.serverId}
          id={route.serverId}
          onOpenInstance={(name) => (location.hash = `#/server/${route.serverId}/instance/${encodeURIComponent(name)}`)}
          onOpenSettings={() => (location.hash = `#/server/${route.serverId}/settings`)}
        />
      ) : (
        <ServersPage
          me={me}
          servers={servers}
          onAdd={(s) => setServers((cur) => [...cur, { ...s, online: false }])}
        />
      )}
      </div>
    </div>
  );
}

// 401 时统一回到登录态
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : '';
  if (msg.includes('未登录')) {
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
      onClick: () => (location.hash = '#/'),
    },
    {
      id: 'servers',
      label: '服务器',
      icon: <Server className="h-[18px] w-[18px]" />,
      active: isServerArea,
      onClick: () => (location.hash = '#/'),
    },
    {
      id: 'settings',
      label: '设置',
      icon: <Settings className="h-[18px] w-[18px]" />,
      active: isSettings,
      onClick: () => (location.hash = '#/settings'),
    },
  ];
  // 未启用密码保护时无需登录，也就没有可退出的会话
  if (me.authEnabled) {
    items.push({
      id: 'logout',
      label: '退出',
      icon: <LogOut className="h-[18px] w-[18px]" />,
      onClick: onLogout,
    });
  }

  return (
    <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2">
      <ExpandableActionBar items={items} size="md" />
    </div>
  );
}
