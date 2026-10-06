// 定时备份设置：按计划自动备份实例（每日固定时间 / 固定间隔）+ 保留份数自动清理
// 结构与 auto-restart-dialog.tsx 同构：同一套 daily/interval 规则，Agent 侧 30 秒轮询触发

import { useEffect, useState } from 'react';
import { Archive, Plus, Timer, Trash2 } from 'lucide-react';
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
import {
  errText,
  saveBackupSchedule,
  timeago,
  type BackupScheduleConfig,
  type BackupScheduleItem,
  type Instance,
  type ServerSummary,
} from '@/lib/api';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

// 星期文案存键名：模块顶层不能调用 $()（会把加载那一刻的语言固化）
const WEEKDAYS = [
  'backupSchedule.weekday.sun',
  'backupSchedule.weekday.mon',
  'backupSchedule.weekday.tue',
  'backupSchedule.weekday.wed',
  'backupSchedule.weekday.thu',
  'backupSchedule.weekday.fri',
  'backupSchedule.weekday.sat',
] as const;

/** 间隔预设（分钟）：5/15/30 → 每周 */
const INTERVAL_PRESETS = [5, 15, 30, 60, 180, 360, 720, 1440, 10080];

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return $('backupSchedule.interval.days', minutes / 1440);
  if (minutes % 60 === 0) return $('backupSchedule.interval.hours', minutes / 60);
  return $('backupSchedule.interval.minutes', minutes);
}

export function BackupScheduleDialog({
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
  const [cfg, setCfg] = useState<BackupScheduleConfig>({ enabled: false, keepCount: 10, schedules: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && instance) {
      setCfg({
        enabled: !!instance.backupSchedule?.enabled,
        // 未设置过时默认保留 10 份（Agent 侧默认 0 = 不清理，只为老数据保持现状）
        keepCount: instance.backupSchedule?.keepCount ?? 10,
        schedules: (instance.backupSchedule?.schedules ?? []).map((s) => ({ ...s })),
      });
    }
  }, [open, instance]);

  if (!instance) return null;

  const patchSchedule = (id: string, patch: Partial<BackupScheduleItem>) =>
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
            <Archive className="h-4 w-4" /> {$('backupSchedule.title', instance.name)}
          </DialogTitle>
          <DialogDescription>
            {$('backupSchedule.description')}
          </DialogDescription>
        </DialogHeader>

        {/* 内容区自身滚动：定时任务多时不撑爆窗口，底栏固定 */}
        <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <div className="grid gap-5">
          {/* 总开关 */}
          <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{$('backupSchedule.enable.label')}</span>
              <span className="text-xs text-muted-foreground">
                {$('backupSchedule.enable.desc')}
              </span>
            </span>
            <Switch
              checked={cfg.enabled}
              onCheckedChange={(v) => setCfg((c) => ({ ...c, enabled: v === true }))}
            />
          </label>
          {cfg.enabled && (
            <div className="grid grid-cols-[1fr_100px] items-center gap-3 pl-1">
              <span className="text-xs text-muted-foreground">
                {$('backupSchedule.keepCount.hint')}
              </span>
              <Input
                inputMode="numeric"
                value={String(cfg.keepCount)}
                onChange={(e) =>
                  setCfg((c) => ({
                    ...c,
                    keepCount: Number(e.target.value.replace(/[^\d]/g, '')) || 0,
                  }))
                }
              />
            </div>
          )}

          {/* 计划任务 */}
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Timer className="h-3.5 w-3.5 text-muted-foreground" />
              <b className="text-sm">{$('backupSchedule.list.title')}</b>
              <Button variant="outline" size="sm" className="ml-auto" onClick={addSchedule}>
                <Plus className="h-3.5 w-3.5" /> {$('backupSchedule.add')}
              </Button>
            </div>
            {cfg.schedules.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                {$('backupSchedule.empty')}
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
                          <SelectItem value="daily">{$('backupSchedule.type.daily')}</SelectItem>
                          <SelectItem value="interval">{$('backupSchedule.type.interval')}</SelectItem>
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
                          aria-label={$('backupSchedule.deleteAria')}
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
                          {s.days.length ? $('backupSchedule.selectedDaysOnly') : $('backupSchedule.everyDay')}
                        </span>
                      </div>
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      {s.lastFiredAt
                        ? $('backupSchedule.lastFired', timeago(s.lastFiredAt))
                        : $('backupSchedule.neverFired')}
                    </span>
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
                await saveBackupSchedule(server.id, instance.name, cfg);
                success($('backupSchedule.toast.saved'));
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
