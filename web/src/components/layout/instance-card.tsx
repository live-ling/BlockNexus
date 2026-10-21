/**
 * 实例卡片（列表用）：实例总览页与服务器详情页共用同一张卡，
 * 区别只在页脚的操作区（总览只读；服务器详情页带启停按钮）。
 *
 * 拆出来的原因：这两个页面的卡片必须长得一模一样——各写一份的话，
 * 改一次样式就要记得改两处，迟早会出现「同一个实例在两页里信息不同」的错位。
 */

import type { ReactNode } from 'react';
import { Copy, Server, Users } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { $ } from '@/lib/i18n';
import { copyText } from '@/lib/clipboard';
import {
  CORE_LABEL,
  fmtMB,
  fmtUptime,
  instanceIconUrl,
  type Instance,
  type PlayersSnapshot,
  type ServerSummary,
} from '@/lib/api';
import { InstanceStatusPill } from './status';
import { Bar, KV, Surface, usageTone } from './primitives';

/** 卡片里需要的玩家快照（与 PlayersSnapshot 的单实例项一致） */
export type PlayerInfo = PlayersSnapshot[string] | null;

/** 版本串常自带核心名（"Fabric-1.21.1"）：避免渲染成「Fabric Fabric-1.21.1」 */
function coreTextOf(inst: Instance): string {
  const label = CORE_LABEL[inst.source ?? 'vanilla'] ?? inst.source ?? '—';
  const version = inst.version ?? '';
  return version.toLowerCase().startsWith(label.toLowerCase()) ? version : `${label} ${version}`.trim();
}

export function InstanceCard({
  server,
  inst,
  players,
  onOpen,
  actions,
  extra,
  className,
}: {
  server: ServerSummary;
  inst: Instance;
  players: PlayerInfo;
  onOpen: () => void;
  /** 页脚右侧的操作（服务器详情页放启停按钮）；不传则显示「打开」 */
  actions?: ReactNode;
  /** 卡片底部附加区块（下载进度 / 失败原因与重试） */
  extra?: ReactNode;
  className?: string;
}) {
  const online = players?.online;
  const memPct = Math.round((inst.memoryMB / 1024 / Math.max(1, server.info?.memTotalMB ?? 0)) * 100);
  const address = inst.address || `${server.host}:${inst.port}`;

  return (
    <Surface
      className={cn(
        'group grid cursor-pointer content-start gap-2.5 transition-colors hover:border-muted-foreground/40',
        className,
      )}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="relative grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
          <Server className="size-3.5" />
          <img
            src={instanceIconUrl(server.id, inst.name)}
            alt=""
            className="absolute inset-0 size-full object-cover"
            onError={(e) => {
              // 没有自定义图标时后端返回 404：退成服务器图标占位，不留破图
              e.currentTarget.style.display = 'none';
            }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13px] font-medium">{inst.name}</b>
          <p className="truncate text-[11px] text-muted-foreground">{inst.note || server.name}</p>
        </div>
        <InstanceStatusPill status={inst.status} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
        <KV label={$('server.detail.field.core')} mono>
          {coreTextOf(inst)}
        </KV>
        <KV label={$('ui.col.server')}>{server.name}</KV>
        <KV label={$('ui.col.players')} mono>
          <span className="inline-flex items-center gap-1">
            {inst.status === 'running' && online ? <Users className="size-3 text-muted-foreground" /> : null}
            {inst.status === 'running' ? (online ?? '—') : '—'}/{players?.max ?? inst.maxPlayers}
          </span>
        </KV>
        <KV label={$('ui.col.uptime')} mono>
          {inst.status === 'starting'
            ? $('server.detail.starting')
            : inst.status === 'running'
              ? fmtUptime(inst.startedAt)
              : '—'}
        </KV>
        <KV label={$('ui.col.memory')}>
          <span className="inline-flex items-center gap-1.5">
            <Bar value={memPct} tone={usageTone(memPct)} />
            <span className="font-mono">{fmtMB(inst.memoryMB)}</span>
          </span>
        </KV>
        <KV label={$('ui.col.port')} mono>
          {inst.port}
        </KV>
      </div>

      {extra}

      <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span className="truncate font-mono">{address}</span>
        <button
          type="button"
          title={$('ui.action.copy')}
          aria-label={$('ui.action.copy')}
          onClick={(e) => {
            e.stopPropagation();
            void copyText(address);
          }}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
        >
          <Copy className="size-3" />
        </button>
        {actions ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            {$('ui.action.open')}
          </Button>
        )}
      </div>
    </Surface>
  );
}
