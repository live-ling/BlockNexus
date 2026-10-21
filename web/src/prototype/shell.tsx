// 原型外壳：左导航（208 / 折叠 56）+ PageHeader（52）+ 状态栏（28）。
// 这一层是「应用感」的来源：导航与状态常驻，页面内容只在中间滚动。

import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Boxes,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  User,
} from 'lucide-react';
import { cn } from 'cn';
import { $ } from '@/lib/i18n';
import { Dot } from './proto-ui';

export type ProtoScreen =
  | 'instances'
  | 'servers'
  | 'server-settings'
  | 'instance'
  | 'panel-settings'
  | 'login';

/**
 * 原型专用：屏幕切换器。真实应用里状态栏只有连接/任务/版本，没有这一项。
 * 选项在渲染时取词（不是模块级常量），否则切换语言后标签不会跟着变。
 */
export function ProtoScreenSelect({
  screen,
  onScreen,
  className,
}: {
  screen: ProtoScreen;
  onScreen: (s: ProtoScreen) => void;
  className?: string;
}) {
  const screens: { value: ProtoScreen; label: string }[] = [
    { value: 'instances', label: $('proto.screen.instances') },
    { value: 'servers', label: $('proto.screen.servers') },
    { value: 'server-settings', label: $('proto.screen.serverSettings') },
    { value: 'instance', label: $('proto.screen.instance') },
    { value: 'panel-settings', label: $('proto.screen.panelSettings') },
    { value: 'login', label: $('proto.screen.login') },
  ];

  return (
    <label
      className={cn(
        'flex items-center gap-1 rounded border border-dashed border-muted-foreground/40 pr-1 pl-1',
        className,
      )}
    >
      <span className="text-[9.5px] font-semibold tracking-wider text-muted-foreground/70">PROTO</span>
      <select
        aria-label="prototype screen"
        value={screen}
        onChange={(e) => onScreen(e.target.value as ProtoScreen)}
        className="h-5 max-w-[132px] bg-transparent text-[10.5px] text-foreground outline-none"
      >
        {screens.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ProtoShell({
  screen,
  onScreen,
  children,
}: {
  screen: ProtoScreen;
  onScreen: (s: ProtoScreen) => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // 导航高亮：实例详情属于「实例」区，服务器设置属于「服务器」区（与现状一致）
  const area =
    screen === 'instances' || screen === 'instance'
      ? 'instances'
      : screen === 'servers' || screen === 'server-settings'
        ? 'servers'
        : 'settings';

  const items = [
    { id: 'instances' as const, icon: Boxes, label: $('nav.instances'), to: 'instances' as ProtoScreen },
    { id: 'servers' as const, icon: Server, label: $('nav.servers'), to: 'servers' as ProtoScreen },
    { id: 'settings' as const, icon: Settings, label: $('nav.settings'), to: 'panel-settings' as ProtoScreen },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-[13px] text-foreground">
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            'flex shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-150',
            collapsed ? 'w-14' : 'w-52',
          )}
        >
          <div className={cn('flex h-13 shrink-0 items-center gap-2 border-b px-3', collapsed && 'justify-center px-0')}>
            <img src="/logo.png" alt="" className="size-6 shrink-0 rounded-full object-cover ring-1 ring-border" />
            {!collapsed && <span className="truncate text-[12.5px] font-semibold tracking-tight">BlockNexus</span>}
          </div>

          <nav className="flex flex-col gap-0.5 p-2">
            {items.map((it) => {
              const active = area === it.id;
              return (
                <button
                  key={it.id}
                  type="button"
                  title={collapsed ? it.label : undefined}
                  onClick={() => onScreen(it.to)}
                  className={cn(
                    'relative flex h-9 items-center gap-2.5 rounded-md text-[12.5px] transition-colors',
                    collapsed ? 'justify-center px-0' : 'px-2.5',
                    active
                      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                  )}
                >
                  {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-foreground/70" />}
                  <it.icon className="size-4 shrink-0" />
                  {!collapsed && <span className="truncate">{it.label}</span>}
                </button>
              );
            })}
          </nav>

          <div className={cn('mt-auto flex flex-col gap-1 border-t p-2', collapsed && 'items-center')}>
            <button
              type="button"
              onClick={() => onScreen('panel-settings')}
              title={$('proto.shell.update', '0.6.0')}
              className={cn(
                'flex h-8 items-center gap-2 rounded-md text-[11px] text-amber-700 hover:bg-sidebar-accent/60 dark:text-amber-400',
                collapsed ? 'w-8 justify-center' : 'px-2',
              )}
            >
              <Dot tone="warn" />
              {!collapsed && <span className="truncate">{$('proto.shell.update', '0.6.0')}</span>}
            </button>

            <div className={cn('flex h-9 items-center gap-2 rounded-md', collapsed ? 'justify-center' : 'px-1')}>
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                <User className="size-3.5" />
              </span>
              {!collapsed && (
                <span className="grid min-w-0 leading-tight">
                  <span className="truncate text-[11.5px] font-medium">admin</span>
                  <span className="truncate text-[10.5px] text-muted-foreground">{$('proto.shell.user')}</span>
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? $('proto.shell.expand') : $('proto.shell.collapse')}
              className={cn(
                'flex h-8 items-center gap-2 rounded-md text-[11.5px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                collapsed ? 'w-8 justify-center' : 'px-2',
              )}
            >
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
              {!collapsed && <span>{$('proto.shell.collapse')}</span>}
            </button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>

      <StatusBar screen={screen} onScreen={onScreen} />
    </div>
  );
}

/** 页面唯一标题栏：返回 / 标题 / 副标题 / 右侧操作 */
export function PageHeader({
  title,
  subtitle,
  back,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b px-4">
      {back && (
        <button
          type="button"
          onClick={back}
          title={$('proto.action.back')}
          className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
      )}
      <div className="flex min-w-0 items-baseline gap-2">
        {title}
        {subtitle && <span className="truncate text-[11.5px] text-muted-foreground">{subtitle}</span>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

function StatusBar({ screen, onScreen }: { screen: ProtoScreen; onScreen: (s: ProtoScreen) => void }) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-muted/40 px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Dot tone="ok" />
        {$('proto.shell.sse')}
      </span>
      <span className="flex items-center gap-1.5">
        <Dot tone="ok" />
        {$('proto.shell.online', 2, 3)}
      </span>
      <span className="flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" />
        {$('proto.shell.task', 62)}
        <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
          <span className="block h-full w-[62%] bg-sky-500" />
        </span>
      </span>

      <span className="ml-auto flex items-center gap-3">
        <span className="text-amber-700 dark:text-amber-400">{$('proto.shell.update', '0.6.0')}</span>
        <ProtoScreenSelect screen={screen} onScreen={onScreen} />
      </span>
    </footer>
  );
}
