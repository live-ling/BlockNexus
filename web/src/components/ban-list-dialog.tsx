// 封禁目录：查看 banned-players / banned-ips（含理由、来源、期限）并解封
// 解封路径由 Agent 决定：运行中走 pardon / pardon-ip 命令；停止时直接改 JSON 文件

import { useCallback, useEffect, useState } from 'react';
import { Ban, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errText, getBanList, unbanTarget, type BanEntry, type BanList } from '@/lib/api';
import { useToastHelpers } from '@/lib/toast';

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  if (iso === 'forever') return '永久';
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
          {entry.reason || '未填写理由'} · {entry.source || 'Server'} · {fmtDate(entry.created)} ·
          至 {fmtDate(entry.expires)}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={busy}
        onClick={onUnban}
      >
        <ShieldOff className="h-3.5 w-3.5" /> 解封
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
      .catch((e) => error('封禁目录加载失败', errText(e)));
  }, [serverId, instance, error]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const doUnban = async (kind: 'player' | 'ip', target: string) => {
    setBusy(target);
    try {
      await unbanTarget(serverId, instance, kind, target);
      success(`已解封 ${target}`, '运行中的服务器立即生效');
      reload();
    } catch (e) {
      error('解封失败', errText(e));
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
            <Ban className="h-4 w-4 text-destructive" /> 封禁目录
            <span className="font-mono text-xs font-normal text-muted-foreground">{instance}</span>
          </DialogTitle>
        </DialogHeader>

        {/* 主体自身滚动：未溢出时贴合内容，超出即进入滚动（对话框高度封顶） */}
        <div className="scrollbar-hide -mx-1 grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-1">
        {list && !list.running && (players.length > 0 || ips.length > 0) && (
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            实例当前未运行：解封将直接修改 banned-*.json 文件。
          </p>
        )}

        <div className="grid content-start gap-1.5">
          <p className="px-1 text-xs font-medium text-muted-foreground">
            封禁玩家（{players.length}）
          </p>
          {players.map((e) => (
            <EntryRow
              key={e.name ?? e.uuid ?? Math.random()}
              label={e.name || '(未知)'}
              entry={e}
              busy={busy === e.name}
              onUnban={() => e.name && void doUnban('player', e.name)}
            />
          ))}
          {!players.length && <p className="px-1 pb-1 text-xs text-muted-foreground">没有封禁的玩家。</p>}
        </div>

        <div className="grid content-start gap-1.5">
          <p className="px-1 text-xs font-medium text-muted-foreground">封禁 IP（{ips.length}）</p>
          {ips.map((e) => (
            <EntryRow
              key={e.ip ?? Math.random()}
              label={e.ip || '(未知)'}
              entry={e}
              busy={busy === e.ip}
              onUnban={() => e.ip && void doUnban('ip', e.ip)}
            />
          ))}
          {!ips.length && <p className="px-1 pb-1 text-xs text-muted-foreground">没有封禁的 IP。</p>}
        </div>
        </div>

        <p className="shrink-0 text-[11px] leading-snug text-muted-foreground">
          数据来自实例目录的 banned-players.json / banned-ips.json；在控制台用 ban / ban-ip 添加，
          pardon / pardon-ip 解除。
        </p>
      </DialogContent>
    </Dialog>
  );
}
