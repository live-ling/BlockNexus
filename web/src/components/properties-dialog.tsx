// 实例配置（server.properties）可视化编辑：中文标签 + 分组 + 类型化控件
// 只改值，注释、顺序与未识别的键原样保留；保存后可选择立即重启使其生效。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RotateCw, Save, Settings2 } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errText, type Instance, type ServerSummary } from '@/lib/api';
import {
  PROP_DEFS,
  PROP_GROUPS,
  parseProperties,
  serializeProperties,
  escapeValue,
  unescapeValue,
  type PropItem,
} from '@/lib/properties';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

export function PropertiesDialog({
  server,
  instance,
  open,
  onOpenChange,
  onSaved,
  onRestart,
}: {
  server: ServerSummary;
  instance: Instance | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  onRestart: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [items, setItems] = useState<PropItem[]>([]);
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [eol, setEol] = useState('\n');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState('');

  const load = useCallback(async () => {
    if (!instance) return;
    setLoading(true);
    try {
      const data = await api<{ content: string }>(
        `/servers/${server.id}/instances/${encodeURIComponent(instance.name)}/properties`,
      );
      const parsed = parseProperties(data.content);
      const map: Record<string, string> = {};
      for (const it of parsed.items) if (it.kind === 'pair') map[it.key] = it.value;
      // 编辑态用还原后的值（如 minecraft\:normal → minecraft:normal），回写时再按原值决定转义
      for (const k of Object.keys(map)) map[k] = unescapeValue(map[k]);
      setItems(parsed.items);
      setInitial(map);
      setValues(map);
      setEol(parsed.eol);
      setRawText(data.content);
      setShowRaw(false);
    } catch (e) {
      error($('property.error.load'), errText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, instance?.name]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // 已存在但未在映射表中的键（保存时原样保留，只在原始视图里编辑）
  const unknownKeys = useMemo(
    () => Object.keys(initial).filter((k) => !PROP_DEFS[k]),
    [initial],
  );
  const groups = useMemo(() => {
    const present = new Set(Object.keys(initial));
    return PROP_GROUPS.map((g) => ({
      name: g,
      keys: Object.keys(PROP_DEFS).filter((k) => PROP_DEFS[k].group === g && present.has(k)),
    })).filter((g) => g.keys.length);
  }, [initial]);

  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(values), ...Object.keys(initial)]);
    for (const k of keys) if ((values[k] ?? '') !== (initial[k] ?? '')) return true;
    return false;
  }, [values, initial]);

  const changedKeys = useMemo(
    () =>
      Object.keys(values).filter(
        (k) => PROP_DEFS[k] && (values[k] ?? '') !== (initial[k] ?? '') && initial[k] !== undefined,
      ),
    [values, initial],
  );

  const set = (k: string, v: string) => setValues((cur) => ({ ...cur, [k]: v }));

  const save = async (restartAfter: boolean) => {
    if (!instance) return;
    setBusy(true);
    try {
      // 原始视图直接保存文本；表单视图按映射回写（未知键取原值），冒号按原值的写法转义
      const rawMap: Record<string, string> = {};
      for (const it of items) if (it.kind === 'pair') rawMap[it.key] = it.value;
      const content = showRaw
        ? rawText
        : serializeProperties(
            items,
            Object.fromEntries(
              Object.entries(values)
                .filter(([k]) => PROP_DEFS[k] || initial[k] !== undefined)
                .map(([k, v]) => [k, escapeValue(v, rawMap[k] ?? '')]),
            ),
            eol,
          );
      const r = await api<{ ok: boolean; metaSynced: boolean }>(
        `/servers/${server.id}/instances/${encodeURIComponent(instance.name)}/properties`,
        { method: 'PUT', body: { content } },
      );
      success($('property.toast.saved'), r.metaSynced ? $('property.toast.synced') : undefined);
      setInitial(JSON.parse(JSON.stringify(values)));
      onSaved();
      if (restartAfter) {
        onRestart();
        onOpenChange(false);
      } else {
        await load();
      }
    } catch (e) {
      error($('property.error.save'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!instance) return null;
  // 进程在运行（含启动中）：改动要重启才生效
  const running = instance.status === 'running' || instance.status === 'starting';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" /> {$('instanceDetail.serverProperties')} · {instance.name}
          </DialogTitle>
          <DialogDescription>
            {/* 表达式边界不留空白；英文句尾空格写在键值里 */}
            {$('property.desc')}
            {running && <span className="text-amber-600 dark:text-amber-400">{$('property.desc.running')}</span>}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{$('property.loading')}</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {showRaw ? (
              <div className="grid gap-2">
                <p className="text-xs text-muted-foreground">
                  {$('property.raw.desc')}
                </p>
                <Textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  rows={20}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </div>
            ) : (
              <div className="grid gap-5">
                {groups.map((g) => (
                  <div key={g.name} className="grid gap-2.5">
                    <div className="text-xs font-medium text-muted-foreground">{$(`property.group.${g.name}`)}</div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {g.keys.map((k) => {
                        const def = PROP_DEFS[k];
                        return (
                          <div key={k} className="grid content-start gap-1.5">
                            <label className="flex items-baseline gap-1.5 text-xs">
                              <span className="text-foreground">{$(def.labelKey)}</span>
                              <code className="font-mono text-[10px] text-muted-foreground">{k}</code>
                            </label>
                            {def.type === 'bool' ? (
                              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Switch
                                  checked={values[k] === 'true'}
                                  onCheckedChange={(v) => set(k, v ? 'true' : 'false')}
                                />
                                {values[k] === 'true' ? $('property.on') : $('property.off')}
                              </label>
                            ) : def.type === 'select' ? (
                              <Select value={values[k]} onValueChange={(v) => set(k, v)}>
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {(def.options ?? []).map((o) => {
                                    const labelKey = def.optionLabelKeys?.[o];
                                    return (
                                      <SelectItem key={o} value={o}>
                                        {labelKey ? $('property.option.display', $(labelKey), o) : o}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectContent>
                              </Select>
                            ) : def.type === 'number' ? (
                              <Input
                                inputMode="numeric"
                                value={values[k] ?? ''}
                                onChange={(e) => set(k, e.target.value.replace(/[^\d-]/g, ''))}
                              />
                            ) : def.type === 'textarea' ? (
                              <Textarea
                                value={values[k] ?? ''}
                                onChange={(e) => set(k, e.target.value)}
                                rows={3}
                                spellCheck={false}
                                className="font-mono text-xs"
                              />
                            ) : (
                              <Input value={values[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
                            )}
                            {def.hintKey && <span className="text-[11px] text-muted-foreground">{$(def.hintKey)}</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {unknownKeys.length > 0 && (
                  <div className="grid gap-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      {$('property.unknown.count', unknownKeys.length)}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {$('property.unknown.desc')}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {unknownKeys.map((k) => (
                        <code
                          key={k}
                          className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        >
                          {k}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="!justify-between">
          <Button variant="ghost" size="sm" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? $('property.form.view') : $('property.raw.view')}
          </Button>
          <div className="flex items-center gap-2">
            {running && (
              <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" /> {$('property.needRestart')}
              </span>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {$('common.cancel')}
            </Button>
            {running ? (
              <Button disabled={busy || (!dirty && !showRaw)} onClick={() => save(true)}>
                <RotateCw className="h-4 w-4" /> {$('property.saveRestart')}
              </Button>
            ) : (
              <Button disabled={busy || (!dirty && !showRaw)} onClick={() => save(false)}>
                <Save className="h-4 w-4" /> {$('common.save')}{dirty ? $('property.changeCount', changedKeys.length) : ''}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
