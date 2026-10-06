// 封禁目录：查看 banned-players / banned-ips（含理由、来源、期限）并解封
// 解封路径由 Agent 决定：运行中走 pardon / pardon-ip 命令；停止时直接改 JSON 文件

import { useCallback, useEffect, useState } from 'react';
import { Ban, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errText, getBanList, unbanTarget, type BanEntry, type BanList } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  if (iso === 'forever') return $('banList.forever');
  return iso.slice(0, 10);
}

function EntryRow({
  label,
  entry,
  busy,
  onUnban,
}: {
  label: string;
  entry: BanEntry;
  busy: boolean;
  onUnban: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <Ban className="h-3.5 w-3.5 shrink-0 text-destructive/70" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs" title={label}>
          {label}
        </p>
        <p className="truncate text-[11px] text-muted-foreground" title={entry.reason || ''}>
          {entry.reason || $('banList.noReason')} · {entry.source || 'Server'} ·{' '}
          {fmtDate(entry.created)} · {$('banList.until', fmtDate(entry.expires))}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={busy}
        onClick={onUnban}
      >
        <ShieldOff className="h-3.5 w-3.5" /> {$('banList.unban')}
      </Button>
    </div>
  );
}

interface Props {
  serverId: string;
  instance: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function BanListDialog({ serverId, instance, open, onOpenChange }: Props) {
  const { success, error } = useToastHelpers();
  const [list, setList] = useState<BanList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    getBanList(serverId, instance)
      .then(setList)
      .catch((e) => error($('banList.error.load'), errText(e)));
  }, [serverId, instance, error]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const doUnban = async (kind: 'player' | 'ip', target: string) => {
    setBusy(target);
    try {
      await unbanTarget(serverId, instance, kind, target);
      success($('banList.toast.unbanned', target), $('banList.toast.unbannedDetail'));
      reload();
    } catch (e) {
      error($('banList.error.unban'), errText(e));
    } finally {
      setBusy(null);
    }
  };

  const players = list?.players ?? [];
  const ips = list?.ips ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-destructive" /> {$('instanceDetail.banList')}
            <span className="font-mono text-xs font-normal text-muted-foreground">{instance}</span>
          </DialogTitle>
        </DialogHeader>

        {/* 主体自身滚动：未溢出时贴合内容，超出即进入滚动（对话框高度封顶） */}
        <div className="scrollbar-hide -mx-1 grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-1">
        {list && !list.running && (players.length > 0 || ips.length > 0) && (
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            {$('banList.notRunning')}
          </p>
        )}

        <div className="grid content-start gap-1.5">
          <p className="px-1 text-xs font-medium text-muted-foreground">
            {$('banList.players', players.length)}
          </p>
          {players.map((e) => (
            <EntryRow
              key={e.name ?? e.uuid ?? Math.random()}
              label={e.name || `(${$('common.unknown')})`}
              entry={e}
              busy={busy === e.name}
              onUnban={() => e.name && void doUnban('player', e.name)}
            />
          ))}
          {!players.length && (
            <p className="px-1 pb-1 text-xs text-muted-foreground">{$('banList.noPlayers')}</p>
          )}
        </div>

        <div className="grid content-start gap-1.5">
          <p className="px-1 text-xs font-medium text-muted-foreground">{$('banList.ips', ips.length)}</p>
          {ips.map((e) => (
            <EntryRow
              key={e.ip ?? Math.random()}
              label={e.ip || `(${$('common.unknown')})`}
              entry={e}
              busy={busy === e.ip}
              onUnban={() => e.ip && void doUnban('ip', e.ip)}
            />
          ))}
          {!ips.length && (
            <p className="px-1 pb-1 text-xs text-muted-foreground">{$('banList.noIps')}</p>
          )}
        </div>
        </div>

        <p className="shrink-0 text-[11px] leading-snug text-muted-foreground">
          {$('banList.hint')}
        </p>
      </DialogContent>
    </Dialog>
  );
}
