// 原型外壳（2026-10-21 第二版）：
//   去掉左侧栏，回到旧的底部悬浮导航（直接复用 ExpandableActionBar）；
//   连接状态 / 安装进度 / 版本 / PROTO 切换器并入页头右侧的状态簇。
//
// 为什么不做「底部状态栏」：悬浮导航本身就在底部，再加一条 28px 状态栏会在窄窗口里挤在一起，
// 而状态信息本来就是常驻的少量文本，放在页头右侧更省纵向空间。

import { createContext, useContext, type ReactNode } from 'react';
import { ArrowLeft, Boxes, Server, Settings } from 'lucide-react';
import { $ } from '@/lib/i18n';
import { ExpandableActionBar, type ExpandableActionBarItem } from '@/components/motion/expandable-action-bar';

export type ProtoScreen =
  | 'instances'
  | 'servers'
  | 'server-settings'
  | 'instance'
  | 'panel-settings'
  | 'login';

type Nav = { screen: ProtoScreen; onScreen: (s: ProtoScreen) => void };

const NavContext = createContext<Nav>({ screen: 'instances', onScreen: () => {} });

export function ProtoShell({
  screen,
  onScreen,
  hideNav,
  children,
}: {
  screen: ProtoScreen;
  onScreen: (s: ProtoScreen) => void;
  /** 实例工作台不显示导航（与现状一致：页面内有返回按钮和终端） */
  hideNav?: boolean;
  children: ReactNode;
}) {
  const area =
    screen === 'instances' || screen === 'instance'
      ? 'instances'
      : screen === 'servers' || screen === 'server-settings'
        ? 'servers'
        : 'settings';

  const items: ExpandableActionBarItem[] = [
    {
      id: 'logo',
      label: 'BlockNexus',
      icon: <img src="/logo.png" alt="BlockNexus" className="h-6 w-6 max-w-none rounded-full object-cover ring-1 ring-border" />,
      active: area === 'instances',
      onClick: () => onScreen('instances'),
    },
    {
      id: 'instances',
      label: $('nav.instances'),
      icon: <Boxes className="h-[18px] w-[18px]" />,
      active: area === 'instances',
      onClick: () => onScreen('instances'),
    },
    {
      id: 'servers',
      label: $('nav.servers'),
      icon: <Server className="h-[18px] w-[18px]" />,
      active: area === 'servers',
      onClick: () => onScreen('servers'),
    },
    {
      id: 'settings',
      label: $('nav.settings'),
      icon: <Settings className="h-[18px] w-[18px]" />,
      active: area === 'settings',
      onClick: () => onScreen('panel-settings'),
    },
  ];

  return (
    <NavContext.Provider value={{ screen, onScreen }}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-[13px] text-foreground">
        {/*
          min-h-0 是必须的：main 是 column flex 的子项，自动最小高度会取「内容高度」，
          不写这行时它会被撑到内容那么高（实测 1181 > 窗口 578），里面的 overflow-auto
          就拿到内容高度、scrollHeight == clientHeight，滚动与目录跳转全部失效。
          overflow-hidden 顺手兜住内容，避免任何一页把外壳撑出滚动条。
        */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
        {!hideNav && (
          <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center">
            <div className="pointer-events-auto">
              <ExpandableActionBar items={items} size="md" collapseOnBlur={false} />
            </div>
          </div>
        )}
      </div>
    </NavContext.Provider>
  );
}

/** 页面唯一标题栏：返回 / 标题 / 副标题 / 页面操作（右侧不再挂连接状态与版本） */
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
  const { screen, onScreen } = useContext(NavContext);
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b px-5">
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
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {actions}
        {actions && <span className="h-4 w-px bg-border" />}
        {/* 原型专用切换器；真实应用页头右侧只有页面自己的操作 */}
        <ProtoScreenSelect screen={screen} onScreen={onScreen} />
      </div>
    </header>
  );
}

/**
 * 原型专用：屏幕切换器。真实应用里页头右侧只有连接/任务/版本，没有这一项。
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
      className={
        'flex items-center gap-1 rounded border border-dashed border-muted-foreground/40 pr-1 pl-1 ' +
        (className ?? '')
      }
    >
      <span className="text-[9.5px] font-semibold tracking-wider text-muted-foreground/70">PROTO</span>
      <select
        aria-label="prototype screen"
        value={screen}
        onChange={(e) => onScreen(e.target.value as ProtoScreen)}
        className="h-5 max-w-[128px] bg-transparent text-[10.5px] text-foreground outline-none"
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
