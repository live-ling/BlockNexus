// 实例控制面板：把编辑、属性、插件配置、自动重启、备份、危险操作收进一个模态。
//
// 为什么不是抽屉：这些操作都是「低频设置」，不需要和终端并排；模态足够，
// 而且现有 Dialog 组件现成、焦点/ESC 行为不用重写。
// 面板只做「汇总 + 入口」：具体的复杂表单仍复用原来的对话框，
// 点击时先关面板再打开目标对话框（见父组件的 openFromPanel）。

import { useEffect, useState } from 'react';
import { Ban, CalendarClock, CloudDownload, Copy, FileCog, Pencil, Puzzle, Settings2, ShieldAlert, Terminal, Trash2, Users, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InstanceStatusBadge } from '@/components/status-badge';
import { $ } from '@/lib/i18n';
import type { Instance, InstanceFrpInfo, ServerSummary } from '@/lib/api';
import { fmtMB } from '@/lib/api';

type PanelTab = 'basic' | 'network' | 'players' | 'automation' | 'backup' | 'danger';

export function InstanceControlPanel({
  open,
  onOpenChange,
  server,
  instance,
  active,
  busy,
  frpInfo,
  hasConfigDirs,
  watchdogOn,
  backupOn,
  onCopy,
  onEdit,
  onProps,
  onPluginConfig,
  onFrp,
  onWatchdog,
  onBackupSchedule,
  onBackup,
  onStats,
  onBans,
  onReinstall,
  onPanelInstall,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  server: ServerSummary;
  instance: Instance;
  active: boolean;
  busy: boolean;
  frpInfo: InstanceFrpInfo | null;
  hasConfigDirs: boolean;
  watchdogOn: boolean;
  backupOn: boolean;
  onCopy: (text: string) => void;
  onEdit: () => void;
  onProps: () => void;
  onPluginConfig: () => void;
  onFrp: () => void;
  onWatchdog: () => void;
  onBackupSchedule: () => void;
  onBackup: () => void;
  onStats: () => void;
  onBans: () => void;
  onReinstall: () => void;
  onPanelInstall: () => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>('basic');
  useEffect(() => {
    if (!open) setTab('basic');
  }, [open]);

  const address = instance.address || `${server.host}:${instance.port}`;

  const tabs: { key: PanelTab; label: string; icon: typeof Settings2 }[] = [
    { key: 'basic', label: $('instanceDetail.panel.tab.basic'), icon: Settings2 },
    { key: 'network', label: $('instanceDetail.panel.tab.network'), icon: Terminal },
    { key: 'players', label: $('instanceDetail.panel.tab.players'), icon: Users },
    { key: 'automation', label: $('instanceDetail.panel.tab.automation'), icon: CalendarClock },
    { key: 'backup', label: $('instanceDetail.panel.tab.backup'), icon: FileCog },
    { key: 'danger', label: $('instanceDetail.panel.tab.danger'), icon: ShieldAlert },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[860px] gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            {$('instanceDetail.panel.title')}
            <InstanceStatusBadge status={instance.status} />
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 text-[11px]">
            <span className="truncate font-mono">{instance.name}</span>
            <span>·</span>
            <span className="truncate font-mono">{address}</span>
            <button
              type="button"
              onClick={() => onCopy(address)}
              title={$('instanceDetail.copied.tooltip')}
              aria-label={$('instanceDetail.copied.tooltip')}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
            </button>
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[360px]">
          <nav className="w-[132px] shrink-0 border-r p-2">
            {tabs.map((t) => {
              const Icon = t.icon;
              const on = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    on ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1 p-4">
            {tab === 'basic' && (
              <div className="grid gap-3">
                <InfoRow label={$('instanceDetail.field.core')} value={instance.version} />
                <InfoRow label={$('instanceDetail.field.memoryLimit')} value={fmtMB(instance.memoryMB)} />
                <InfoRow label={$('instanceDetail.field.port')} value={String(instance.port)} />
                <InfoRow
                  label={$('instanceDetail.field.onlineMode')}
                  value={instance.onlineMode ? $('instanceDetail.value.on') : $('instanceDetail.value.off')}
                />
                <InfoRow label={$('instanceDetail.motd.label')} value={instance.motd || $('instanceDetail.value.unset')} />
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={onEdit}>
                    <Pencil className="h-3.5 w-3.5" /> {$('instanceDetail.edit')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={onProps}>
                    <Settings2 className="h-3.5 w-3.5" /> {$('instanceDetail.serverProperties')}
                  </Button>
                  {hasConfigDirs && (
                    <Button size="sm" variant="outline" onClick={onPluginConfig}>
                      <Wrench className="h-3.5 w-3.5" /> {$('instanceDetail.pluginConfig')}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {tab === 'network' && (
              <div className="grid gap-3">
                <InfoRow label={$('instanceDetail.field.address')} value={address} mono />
                <InfoRow label={$('instanceDetail.frp.localPort')} value={String(instance.port)} />
                <InfoRow
                  label={$('instanceDetail.frp.title')}
                  value={
                    frpInfo?.bound
                      ? frpInfo.publicAddress
                      : frpInfo && !frpInfo.supported
                        ? $('instanceDetail.frp.unsupported')
                        : $('instanceDetail.frp.unbound')
                  }
                  mono={!!frpInfo?.bound}
                />
                {frpInfo?.bound && (
                  <InfoRow
                    label={$('instanceDetail.frp.target')}
                    value={`${frpInfo.targetHost}:${frpInfo.localPort}`}
                    mono
                  />
                )}
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={!!frpInfo && !frpInfo.supported} onClick={onFrp}>
                    <Terminal className="h-3.5 w-3.5" />
                    {frpInfo?.bound ? $('instanceDetail.frp.manage') : $('instanceDetail.frp.enable')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={onEdit}>
                    <Pencil className="h-3.5 w-3.5" /> {$('instanceDetail.edit')}
                  </Button>
                </div>
              </div>
            )}

            {tab === 'players' && (
              <div className="grid gap-3">
                <p className="text-xs text-muted-foreground">{$('instanceDetail.panel.players.hint')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={onStats}>
                    <Users className="h-3.5 w-3.5" /> {$('instanceDetail.playerStats')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={onBans}>
                    <Ban className="h-3.5 w-3.5" /> {$('instanceDetail.banList')}
                  </Button>
                </div>
              </div>
            )}

            {tab === 'automation' && (
              <div className="grid gap-3">
                <ActionRow
                  title={$('instanceDetail.watchdog')}
                  desc={$('instanceDetail.panel.watchdog.desc')}
                  on={watchdogOn}
                  action={$('instanceDetail.panel.configure')}
                  onClick={onWatchdog}
                />
                <ActionRow
                  title={$('instanceDetail.backupSchedule')}
                  desc={$('instanceDetail.panel.backupSchedule.desc')}
                  on={backupOn}
                  action={$('instanceDetail.panel.configure')}
                  onClick={onBackupSchedule}
                />
              </div>
            )}

            {tab === 'backup' && (
              <div className="grid gap-3">
                <p className="text-xs text-muted-foreground">{$('instanceDetail.panel.backup.hint')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={onBackup}>
                    <CloudDownload className="h-3.5 w-3.5" /> {$('instanceDetail.overview.backupNow')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={onBackupSchedule}>
                    <CalendarClock className="h-3.5 w-3.5" /> {$('instanceDetail.backupSchedule')}
                  </Button>
                </div>
              </div>
            )}

            {tab === 'danger' && (
              <div className="grid gap-3">
                <p className="text-xs text-muted-foreground">{$('instanceDetail.panel.danger.hint')}</p>
                {active && (
                  <p className="rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                    {$('instanceDetail.panel.danger.running')}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {instance.source !== 'upload' && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={onPanelInstall}>
                      <CloudDownload className="h-3.5 w-3.5" /> {$('instanceDetail.panelInstall')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={onReinstall}>
                    <Puzzle className="h-3.5 w-3.5" /> {$('instanceDetail.reinstall')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-600 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                    onClick={onDelete}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {$('instanceDetail.delete')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-4 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 flex-1 break-words ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function ActionRow({
  title,
  desc,
  on,
  action,
  onClick,
}: {
  title: string;
  desc: string;
  on?: boolean;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
      <div className="min-w-0 flex-1">
        <b className="text-xs">{title}</b>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{desc}</p>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}
