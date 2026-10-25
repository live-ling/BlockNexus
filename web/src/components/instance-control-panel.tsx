// 实例控制面板：设置类操作的唯一入口（工作区在页签，设置在这里）。
//
// 2026-10-25 改版：
//   · 尺寸 860×360 → min(1160px, 94vw) × min(760px, 86vh)，左导航 180，内容独立滚动——
//     原来 6 组内容挤在窄框里，是实例页头号「挤」源；
//   · 6 组 → 4 组：「玩家」（统计/封禁）与「备份」和页签完全重复，删除；
//     InstanceFrpDialog 死代码一并清掉，frp 只在这里的「网络」组；
//   · 入口去重：属性 / 插件配置 / 完整编辑只在「配置」页签，这里不再复刻。
//     基础组只留真正属于「设置」的：内存上限、备注（地址在「网络」组，不再两边都有）。
// 面板只做「汇总 + 入口」：复杂表单仍复用原来的对话框，
// 点击时先关面板再打开目标对话框（见父组件的 openFromPanel）。

import { useEffect, useState } from 'react';
import { CalendarClock, CloudDownload, Copy, Puzzle, Settings2, ShieldAlert, Terminal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InstanceStatusBadge } from '@/components/status-badge';
import { $ } from '@/lib/i18n';
import { api, errText, saveInstanceFrp, type Instance, type InstanceFrpInfo, type ServerSummary } from '@/lib/api';
import { useToastHelpers } from '@/lib/toast';

type PanelTab = 'basic' | 'network' | 'automation' | 'danger';

export function InstanceControlPanel({
  open,
  onOpenChange,
  server,
  instance,
  active,
  busy,
  frpInfo,
  watchdogOn,
  backupOn,
  onCopy,
  onWatchdog,
  onBackupSchedule,
  onReinstall,
  onPanelInstall,
  onDelete,
  onSaved,
  onFrpChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  server: ServerSummary;
  instance: Instance;
  active: boolean;
  busy: boolean;
  frpInfo: InstanceFrpInfo | null;
  watchdogOn: boolean;
  backupOn: boolean;
  onCopy: (text: string) => void;
  onWatchdog: () => void;
  onBackupSchedule: () => void;
  onReinstall: () => void;
  onPanelInstall: () => void;
  onDelete: () => void;
  onSaved: () => void;
  onFrpChanged: (info: InstanceFrpInfo) => void;
}) {
  const { success, error } = useToastHelpers();
  const [tab, setTab] = useState<PanelTab>('basic');
  const [mem, setMem] = useState(String(instance.memoryMB));
  const [note, setNote] = useState(instance.note || '');
  const [address, setAddress] = useState(instance.address || '');
  const [frpPort, setFrpPort] = useState(String(frpInfo?.remotePort || instance.port));
  const [saving, setSaving] = useState(false);
  const [frpBusy, setFrpBusy] = useState(false);

  useEffect(() => {
    if (!open) setTab('basic');
  }, [open]);

  // 打开面板或元信息变化时，把表单对齐到最新值（避免保存后仍显示旧值）
  useEffect(() => {
    setMem(String(instance.memoryMB));
    setNote(instance.note || '');
    setAddress(instance.address || '');
  }, [instance.memoryMB, instance.note, instance.address, open]);
  useEffect(() => {
    setFrpPort(String(frpInfo?.remotePort || instance.port));
  }, [frpInfo?.remotePort, instance.port, open]);

  const baseUrl = `/servers/${server.id}/instances/${encodeURIComponent(instance.name)}`;

  const saveBasic = async () => {
    const memoryMB = Number(mem);
    if (!Number.isFinite(memoryMB) || memoryMB < 256) {
      error($('instanceDetail.panel.saveFailed'), $('instanceDetail.panel.memoryInvalid'));
      return;
    }
    setSaving(true);
    try {
      await api(baseUrl, { method: 'PUT', body: { memoryMB, note } });
      success($('instanceDetail.panel.saved'));
      onSaved();
    } catch (e) {
      error($('instanceDetail.panel.saveFailed'), errText(e));
    } finally {
      setSaving(false);
    }
  };

  const saveAddress = async () => {
    setSaving(true);
    try {
      await api(baseUrl, { method: 'PUT', body: { address } });
      success($('instanceDetail.panel.saved'));
      onSaved();
    } catch (e) {
      error($('instanceDetail.panel.saveFailed'), errText(e));
    } finally {
      setSaving(false);
    }
  };

  const saveFrpPort = async (enabled: boolean) => {
    setFrpBusy(true);
    try {
      const r = await saveInstanceFrp(server.id, instance.name, {
        enabled,
        remotePort: enabled ? Number(frpPort) : undefined,
      });
      if (r.error) {
        error($('instanceDetail.frp.title'), r.error);
      } else {
        success(enabled ? $('instanceDetail.panel.saved') : $('instanceDetail.frp.unboundToast'));
      }
      onFrpChanged(r);
    } catch (e) {
      error($('instanceDetail.frp.title'), errText(e));
    } finally {
      setFrpBusy(false);
    }
  };

  const connectAddress = instance.address || `${server.host}:${instance.port}`;

  const tabs: { key: PanelTab; label: string; icon: typeof Settings2 }[] = [
    { key: 'basic', label: $('instanceDetail.panel.tab.basic'), icon: Settings2 },
    { key: 'network', label: $('instanceDetail.panel.tab.network'), icon: Terminal },
    { key: 'automation', label: $('instanceDetail.panel.tab.automation'), icon: CalendarClock },
    { key: 'danger', label: $('instanceDetail.panel.tab.danger'), icon: ShieldAlert },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,86vh)] w-[min(1160px,94vw)] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            {$('instanceDetail.panel.title')}
            <InstanceStatusBadge status={instance.status} />
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 text-[11px]">
            <span className="truncate font-mono">{instance.name}</span>
            <span>·</span>
            <span className="truncate font-mono">{connectAddress}</span>
            <button
              type="button"
              onClick={() => onCopy(connectAddress)}
              title={$('instanceDetail.copied.tooltip')}
              aria-label={$('instanceDetail.copied.tooltip')}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
            </button>
          </DialogDescription>
        </DialogHeader>

        {/* 内容区独立滚动：min-h-0 链从这里开始，别让某一组把整块撑破 */}
        <div className="flex min-h-0 flex-1">
          <nav className="w-[180px] shrink-0 border-r p-2.5">
            {tabs.map((t) => {
              const Icon = t.icon;
              const on = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                    on ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <Icon className="size-3.5 shrink-0" />
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {tab === 'basic' && (
              <div className="grid max-w-[620px] gap-4">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {$('instanceDetail.panel.basic.hint')}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-xs">
                    <span className="text-[11.5px] text-muted-foreground">{$('instanceDetail.field.memoryLimit')}</span>
                    <Input
                      value={mem}
                      onChange={(e) => setMem(e.target.value.replace(/[^\d]/g, ''))}
                      inputMode="numeric"
                      className="font-mono"
                      disabled={saving}
                    />
                  </label>
                  <label className="grid gap-1.5 text-xs">
                    <span className="text-[11.5px] text-muted-foreground">{$('instanceDetail.field.note')}</span>
                    <Input value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} maxLength={200} />
                  </label>
                </div>
                <div className="flex justify-end">
                  <Button size="sm" disabled={saving} onClick={saveBasic}>
                    {$('common.save')}
                  </Button>
                </div>

                {/* 只读信息：真正的编辑入口在「配置」页签（属性 / 插件 / Mod / 完整编辑），这里不复刻 */}
                <div className="mt-2 grid gap-0 border-t border-border/60 pt-1">
                  <InfoRow label={$('instanceDetail.field.core')} value={instance.version} />
                  <InfoRow label={$('instanceDetail.field.port')} value={String(instance.port)} />
                  <InfoRow
                    label={$('instanceDetail.field.onlineMode')}
                    value={instance.onlineMode ? $('instanceDetail.value.on') : $('instanceDetail.value.off')}
                  />
                  <InfoRow label={$('instanceDetail.motd.label')} value={instance.motd || $('instanceDetail.value.unset')} />
                </div>
              </div>
            )}

            {tab === 'network' && (
              <div className="grid max-w-[620px] gap-5">
                {/* 域名：唯一可编辑的对外地址字段（基础组不再重复） */}
                <section className="grid gap-3">
                  <h3 className="text-[12px] font-semibold">{$('instanceDetail.panel.network.domain')}</h3>
                  <label className="grid gap-1.5 text-xs">
                    <span className="text-[11.5px] text-muted-foreground">{$('instanceDetail.field.address')}</span>
                    <Input
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="mc.example.com"
                      className="font-mono"
                      disabled={saving}
                    />
                    <span className="text-[10.5px] leading-4 text-muted-foreground/80">
                      {$('instanceDetail.panel.domainHint')}
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving || address === (instance.address || '')}
                      onClick={saveAddress}
                    >
                      {$('common.save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onCopy(connectAddress)}>
                      <Copy className="size-3.5" /> {$('instanceDetail.copied.tooltip')}
                    </Button>
                  </div>
                </section>

                {/* frp：实例级端口映射的唯一入口（本地端口取实例端口，不用手填） */}
                <section className="grid gap-3 border-t border-border/60 pt-4">
                  <h3 className="text-[12px] font-semibold">{$('instanceDetail.frp.title')}</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <InfoRow label={$('instanceDetail.frp.localPort')} value={String(instance.port)} />
                    <label className="grid gap-1.5 text-xs">
                      <span className="text-[11.5px] text-muted-foreground">{$('instanceDetail.frp.remotePort')}</span>
                      <Input
                        value={frpPort}
                        onChange={(e) => setFrpPort(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                        className="font-mono"
                        disabled={frpBusy || (!!frpInfo && !frpInfo.supported)}
                      />
                    </label>
                  </div>
                  <InfoRow
                    label={$('instanceDetail.frp.title')}
                    value={
                      frpInfo?.bound
                        ? frpInfo.publicAddress
                        : frpInfo && !frpInfo.supported
                          ? frpInfo.reason === 'sakura'
                            ? $('instanceDetail.frp.sakura')
                            : $('instanceDetail.frp.notLocal')
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
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={frpBusy || !frpInfo?.supported}
                      onClick={() => saveFrpPort(true)}
                    >
                      {frpInfo?.bound ? $('instanceDetail.frp.manage') : $('instanceDetail.frp.enable')}
                    </Button>
                    {frpInfo?.bound && (
                      <Button size="sm" variant="outline" disabled={frpBusy} onClick={() => saveFrpPort(false)}>
                        {$('instanceDetail.frp.unbind')}
                      </Button>
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      {frpInfo?.frpcRunning ? $('instanceDetail.frp.frpcRunning') : frpInfo ? $('instanceDetail.frp.frpcStopped') : ''}
                    </span>
                  </div>
                </section>
              </div>
            )}

            {tab === 'automation' && (
              <div className="grid max-w-[620px] gap-3">
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

            {tab === 'danger' && (
              <div className="grid max-w-[620px] gap-3">
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
                  <Button size="sm" variant="outline" disabled={busy} onClick={onReinstall}>
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
    <div className="flex items-start gap-4 py-1.5 text-xs">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
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
