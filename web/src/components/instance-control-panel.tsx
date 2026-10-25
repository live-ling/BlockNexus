// 实例控制面板：设置类操作的唯一入口（工作区在页签，设置在这里）。
//
// 2026-10-25 改版（第二次）：
//   · **修宽度**：`DialogContent` 自带 `sm:max-w-sm`（384px），之前只写 `max-w-none`
//     在 sm 断点被压回 384px——面板一直很窄的真正原因。现在 `max-w-none!` + `sm:max-w-none!`，
//     实测 1160×774（nav 200 + 内容 960），无横向溢出。
//   · 内容区 620px 单栏 → 自适应双栏：基础信息＝表单 + 只读侧栏，网络＝域名 / frp 两张卡，
//     自动化＝两张并排卡；字号收敛 11/12/13/16，控件高度 36px。
//   · 尺寸 min(1160px, 94vw) × min(780px, 90vh)，左导航 200，内容独立滚动。
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
      {/*
        宽度必须同时覆盖 base 的 `sm:max-w-sm`（24rem = 384px），否则会被压成窄条——
        这是这版之前「控制面板一直很窄」的真正原因：类名写了 w-[1160px]，
        但 sm 断点的 max-w-sm 优先级更高，实测只有 384px。
      */}
      <DialogContent className="flex h-[min(780px,90vh)] w-[min(1160px,94vw)] max-w-none! flex-col gap-0 overflow-hidden p-0 sm:max-w-none!">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            {$('instanceDetail.panel.title')}
            <InstanceStatusBadge status={instance.status} />
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 text-[12px]">
            <span className="truncate font-mono">{instance.name}</span>
            <span>·</span>
            <span className="truncate font-mono">{connectAddress}</span>
            <button
              type="button"
              onClick={() => onCopy(connectAddress)}
              title={$('instanceDetail.copied.tooltip')}
              aria-label={$('instanceDetail.copied.tooltip')}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </DialogDescription>
        </DialogHeader>

        {/* 内容区独立滚动：min-h-0 链从这里开始，别让某一组把整块撑破 */}
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav className="flex w-full shrink-0 flex-wrap gap-1 border-b bg-muted/20 p-2 sm:w-[200px] sm:flex-col sm:border-r sm:border-b-0 sm:p-3">
            {tabs.map((t) => {
              const Icon = t.icon;
              const on = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`flex h-9 items-center gap-2.5 rounded-md px-3 text-left text-[13px] transition-colors sm:mb-1 sm:w-full ${
                    on ? 'bg-background font-medium text-foreground shadow-xs ring-1 ring-border/60' : 'text-muted-foreground hover:bg-muted/70'
                  }`}
                >
                  <Icon className="size-4 shrink-0" />
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {tab === 'basic' && (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                <section className="grid content-start gap-4">
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    {$('instanceDetail.panel.basic.hint')}
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="grid gap-1.5">
                      <span className="text-[12px] text-muted-foreground">{$('instanceDetail.field.memoryLimit')}</span>
                      <Input
                        value={mem}
                        onChange={(e) => setMem(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                        className="h-9 font-mono"
                        disabled={saving}
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span className="text-[12px] text-muted-foreground">{$('instanceDetail.field.note')}</span>
                      <Input value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} maxLength={200} className="h-9" />
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <Button className="h-9 px-4 text-[13px]" disabled={saving} onClick={saveBasic}>
                      {$('common.save')}
                    </Button>
                  </div>
                </section>

                {/* 只读信息：真正的编辑入口在「配置」页签，这里只做汇总，不复刻表单 */}
                <aside className="h-fit rounded-xl border bg-muted/20 p-4">
                  <h3 className="text-[13px] font-semibold">{$('instanceDetail.panel.readonly')}</h3>
                  <div className="mt-2 divide-y divide-border/60">
                    <InfoRow label={$('instanceDetail.field.core')} value={instance.version} />
                    <InfoRow label={$('instanceDetail.field.port')} value={String(instance.port)} />
                    <InfoRow
                      label={$('instanceDetail.field.onlineMode')}
                      value={instance.onlineMode ? $('instanceDetail.value.on') : $('instanceDetail.value.off')}
                    />
                    <InfoRow label={$('instanceDetail.motd.label')} value={instance.motd || $('instanceDetail.value.unset')} />
                  </div>
                </aside>
              </div>
            )}

            {tab === 'network' && (
              <div className="grid gap-5 xl:grid-cols-2">
                {/* 域名：唯一可编辑的对外地址字段（基础组不再重复） */}
                <section className="grid content-start gap-3 rounded-xl border p-4">
                  <h3 className="text-[13px] font-semibold">{$('instanceDetail.panel.network.domain')}</h3>
                  <label className="grid gap-1.5">
                    <span className="text-[12px] text-muted-foreground">{$('instanceDetail.field.address')}</span>
                    <Input
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="mc.example.com"
                      className="h-9 font-mono"
                      disabled={saving}
                    />
                    <span className="text-[11px] leading-4 text-muted-foreground/80">
                      {$('instanceDetail.panel.domainHint')}
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      className="h-9 px-4 text-[13px]"
                      variant="outline"
                      disabled={saving || address === (instance.address || '')}
                      onClick={saveAddress}
                    >
                      {$('common.save')}
                    </Button>
                    <Button className="h-9 text-[13px]" variant="ghost" onClick={() => onCopy(connectAddress)}>
                      <Copy className="size-3.5" /> {$('instanceDetail.copied.tooltip')}
                    </Button>
                  </div>
                </section>

                {/* frp：实例级端口映射的唯一入口（本地端口取实例端口，不用手填） */}
                <section className="grid content-start gap-3 rounded-xl border p-4">
                  <h3 className="text-[13px] font-semibold">{$('instanceDetail.frp.title')}</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <InfoRow label={$('instanceDetail.frp.localPort')} value={String(instance.port)} />
                    <label className="grid gap-1.5">
                      <span className="text-[12px] text-muted-foreground">{$('instanceDetail.frp.remotePort')}</span>
                      <Input
                        value={frpPort}
                        onChange={(e) => setFrpPort(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                        className="h-9 font-mono"
                        disabled={frpBusy || (!!frpInfo && !frpInfo.supported)}
                      />
                    </label>
                  </div>
                  <div className="grid gap-1 border-t border-border/60 pt-2">
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
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      className="h-9 px-4 text-[13px]"
                      disabled={frpBusy || !frpInfo?.supported}
                      onClick={() => saveFrpPort(true)}
                    >
                      {frpInfo?.bound ? $('instanceDetail.frp.manage') : $('instanceDetail.frp.enable')}
                    </Button>
                    {frpInfo?.bound && (
                      <Button className="h-9 text-[13px]" variant="outline" disabled={frpBusy} onClick={() => saveFrpPort(false)}>
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
              <div className="grid content-start gap-3 sm:grid-cols-2">
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
              <div className="grid max-w-[880px] content-start gap-4">
                <p className="text-[12px] text-muted-foreground">{$('instanceDetail.panel.danger.hint')}</p>
                {active && (
                  <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-400">
                    {$('instanceDetail.panel.danger.running')}
                  </p>
                )}
                <div className="grid gap-2 rounded-xl border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {instance.source !== 'upload' && (
                      <Button className="h-9 text-[13px]" variant="outline" disabled={busy} onClick={onPanelInstall}>
                        <CloudDownload className="h-3.5 w-3.5" /> {$('instanceDetail.panelInstall')}
                      </Button>
                    )}
                    <Button className="h-9 text-[13px]" variant="outline" disabled={busy} onClick={onReinstall}>
                      <Puzzle className="h-3.5 w-3.5" /> {$('instanceDetail.reinstall')}
                    </Button>
                    <Button
                      className="h-9 border-red-300 text-red-600 hover:bg-red-50 hover:text-red-600 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40 text-[13px]"
                      variant="outline"
                      onClick={onDelete}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> {$('instanceDetail.delete')}
                    </Button>
                  </div>
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
    <div className="flex items-start gap-4 py-2 text-[12px]">
      <span className="w-24 shrink-0 text-[11px] leading-5 text-muted-foreground">{label}</span>
      <span className={`min-w-0 flex-1 break-words leading-5 ${mono ? 'font-mono' : ''}`}>{value}</span>
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
    <div className="flex items-center gap-3 rounded-xl border px-4 py-3.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
      <div className="min-w-0 flex-1">
        <b className="text-[13px]">{title}</b>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{desc}</p>
      </div>
      <Button size="sm" variant="outline" className="h-9 shrink-0 text-[13px]" onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}
