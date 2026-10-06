// 自动重启设置：崩溃后自动拉起 + 定时重启任务（每日固定时间 / 固定间隔）

import { useEffect, useState } from 'react';
import { Plus, RotateCw, Timer, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, errText, type Instance, type ServerSummary, type WatchdogConfig, type WatchdogSchedule } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

// 星期文案存键名：模块顶层不能调用 $()（会把加载那一刻的语言固化）
const WEEKDAYS = [
  'autoRestart.weekday.sun',
  'autoRestart.weekday.mon',
  'autoRestart.weekday.tue',
  'autoRestart.weekday.wed',
  'autoRestart.weekday.thu',
  'autoRestart.weekday.fri',
  'autoRestart.weekday.sat',
] as const;

/** 间隔预设（分钟）：5/15/30 → 每周 */
const INTERVAL_PRESETS = [5, 15, 30, 60, 180, 360, 720, 1440, 10080];

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return $('autoRestart.interval.days', minutes / 1440);
  if (minutes % 60 === 0) return $('autoRestart.interval.hours', minutes / 60);
  return $('autoRestart.interval.minutes', minutes);
}

export function scheduleLabel(s: WatchdogSchedule): string {
  if (s.type === 'daily') {
    const days = s.days.length ? s.days.map((d) => $(WEEKDAYS[d])).join('/') : $('autoRestart.everyDay');
    return `${days} ${s.time}`;
  }
  return intervalLabel(s.intervalMinutes);
}

export function AutoRestartDialog({
  server,
  instance,
  open,
  onOpenChange,
  onSaved,
}: {
  server: ServerSummary;
  instance: Instance | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [cfg, setCfg] = useState<WatchdogConfig>({ autoRestart: false, restartDelaySec: 5, schedules: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && instance) {
      setCfg({
        autoRestart: !!instance.watchdog?.autoRestart,
        restartDelaySec: instance.watchdog?.restartDelaySec ?? 5,
        schedules: (instance.watchdog?.schedules ?? []).map((s) => ({ ...s })),
      });
    }
  }, [open, instance]);

  if (!instance) return null;

  const patchSchedule = (id: string, patch: Partial<WatchdogSchedule>) =>
    setCfg((c) => ({ ...c, schedules: c.schedules.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const addSchedule = () =>
    setCfg((c) => ({
      ...c,
      schedules: [
        ...c.schedules,
        {
          id: Math.random().toString(36).slice(2, 10),
          enabled: true,
          type: 'daily',
          time: '04:00',
          days: [],
          intervalMinutes: 360,
        },
      ],
    }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RotateCw className="h-4 w-4" /> {$('autoRestart.title', instance.name)}
          </DialogTitle>
          <DialogDescription>
            {$('autoRestart.description')}
          </DialogDescription>
        </DialogHeader>

        {/* 内容区自身滚动：定时任务多时不撑爆窗口，底栏固定 */}
        <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <div className="grid gap-5">
          {/* 崩溃自动重启 */}
          <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{$('autoRestart.autoRestart.label')}</span>
              <span className="text-xs text-muted-foreground">
                {$('autoRestart.autoRestart.desc')}
              </span>
            </span>
            <Switch
              checked={cfg.autoRestart}
              onCheckedChange={(v) => setCfg((c) => ({ ...c, autoRestart: v === true }))}
            />
          </label>
          {cfg.autoRestart && (
            <div className="grid grid-cols-[1fr_100px] items-center gap-3 pl-1">
              <span className="text-xs text-muted-foreground">
                {$('autoRestart.delay.hint')}
              </span>
              <Input
                inputMode="numeric"
                value={String(cfg.restartDelaySec)}
                onChange={(e) =>
                  setCfg((c) => ({
                    ...c,
                    restartDelaySec: Number(e.target.value.replace(/[^\d]/g, '')) || 0,
                  }))
                }
              />
            </div>
          )}

          {/* 定时重启 */}
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Timer className="h-3.5 w-3.5 text-muted-foreground" />
              <b className="text-sm">{$('autoRestart.list.title')}</b>
              <Button variant="outline" size="sm" className="ml-auto" onClick={addSchedule}>
                <Plus className="h-3.5 w-3.5" /> {$('autoRestart.add')}
              </Button>
            </div>
            {cfg.schedules.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                {$('autoRestart.empty')}
              </p>
            ) : (
              <div className="grid gap-2">
                {cfg.schedules.map((s) => (
                  <div key={s.id} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Select
                        value={s.type}
                        onValueChange={(v) => patchSchedule(s.id, { type: v as 'daily' | 'interval' })}
                      >
                        <SelectTrigger size="sm" className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">{$('autoRestart.type.daily')}</SelectItem>
                          <SelectItem value="interval">{$('autoRestart.type.interval')}</SelectItem>
                        </SelectContent>
                      </Select>
                      {s.type === 'daily' ? (
                        <Input
                          type="time"
                          value={s.time}
                          onChange={(e) => patchSchedule(s.id, { time: e.target.value })}
                          className="h-8 w-28"
                        />
                      ) : (
                        <Select
                          value={String(s.intervalMinutes)}
                          onValueChange={(v) => patchSchedule(s.id, { intervalMinutes: Number(v) })}
                        >
                          <SelectTrigger size="sm" className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {!INTERVAL_PRESETS.includes(s.intervalMinutes) && (
                              <SelectItem value={String(s.intervalMinutes)}>
                                {intervalLabel(s.intervalMinutes)}
                              </SelectItem>
                            )}
                            {INTERVAL_PRESETS.map((m) => (
                              <SelectItem key={m} value={String(m)}>
                                {intervalLabel(m)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <span className="ml-auto flex items-center gap-2">
                        <Switch
                          checked={s.enabled}
                          onCheckedChange={(v) => patchSchedule(s.id, { enabled: v === true })}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={$('autoRestart.deleteAria')}
                          onClick={() =>
                            setCfg((c) => ({ ...c, schedules: c.schedules.filter((x) => x.id !== s.id) }))
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    </div>
                    {s.type === 'daily' && (
                      <div className="flex flex-wrap gap-1.5">
                        {WEEKDAYS.map((w, i) => {
                          const on = s.days.includes(i);
                          return (
                            <button
                              key={w}
                              type="button"
                              onClick={() =>
                                patchSchedule(s.id, {
                                  days: on ? s.days.filter((d) => d !== i) : [...s.days, i].sort(),
                                })
                              }
                              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                                on
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'text-muted-foreground hover:bg-muted'
                              }`}
                            >
                              {$(w)}
                            </button>
                          );
                        })}
                        <span className="self-center text-[11px] text-muted-foreground">
                          {s.days.length ? $('autoRestart.selectedDaysOnly') : $('autoRestart.everyDay')}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {$('common.cancel')}
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/servers/${server.id}/instances/${encodeURIComponent(instance.name)}/watchdog`, {
                  method: 'PUT',
                  body: cfg,
                });
                success($('autoRestart.toast.saved'));
                onOpenChange(false);
                onSaved();
              } catch (e) {
                error($('panelSettings.error.save'), errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {$('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
