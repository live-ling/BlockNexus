// 状态徽章：实例状态 / Agent 在线状态 → beUI AnimatedBadge

import { AnimatedBadge } from '@/components/motion/animated-badge';
import { latencyTone, type InstanceStatus } from '@/lib/api';
import { $, type TranslationKey } from '@/lib/i18n';

/** 实例状态 → 徽章外观 + i18n 键。未收录的状态回退显示原始值，绝不空白 */
const INSTANCE_MAP: Record<
  string,
  { status: 'success' | 'neutral' | 'loading' | 'danger' | 'warning'; key: TranslationKey; pulse?: boolean }
> = {
  running: { status: 'success', key: 'console.status.running' },
  starting: { status: 'loading', key: 'console.status.starting', pulse: true },
  stopped: { status: 'neutral', key: 'console.status.stopped' },
  downloading: { status: 'loading', key: 'console.status.downloading', pulse: true },
  failed: { status: 'danger', key: 'console.status.failed' },
  incomplete: { status: 'warning', key: 'console.status.incomplete' },
};

export function InstanceStatusBadge({ status }: { status: InstanceStatus | string }) {
  const conf = INSTANCE_MAP[status];
  const statusKind = conf?.status ?? 'neutral';
  return (
    <AnimatedBadge
      size="sm"
      status={statusKind}
      pulse={conf?.pulse}
      contentKey={status}
    >
      {conf ? $(conf.key) : status}
    </AnimatedBadge>
  );
}

export function AgentBadge({ online, installing }: { online: boolean; installing?: boolean }) {
  if (installing) {
    return (
      <AnimatedBadge size="sm" status="loading" pulse contentKey="installing">
        {$('badge.installing')}
      </AnimatedBadge>
    );
  }
  return online ? (
    <AnimatedBadge size="sm" status="success" pulse contentKey="online">
      {$('badge.agent.online')}
    </AnimatedBadge>
  ) : (
    <AnimatedBadge size="sm" status="neutral" contentKey="offline">
      {$('badge.offline')}
    </AnimatedBadge>
  );
}

/** 延迟徽章：仅文字，用于页头等紧凑位置（ServerLinkBadge 是带边框的胶囊版） */
export function LatencyBadge({ latency }: { latency: number }) {
  const tone = latencyTone(latency);
  const cls =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'fair'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-destructive';
  return (
    <span className={`font-mono text-xs ${cls}`} title={$('badge.latency.tooltip')}>
      {$('badge.latency', latency === 0 ? '<1' : latency)}
    </span>
  );
}

/** 首页服务器卡片徽章：在线显示实测延迟，离线显示红色「离线」，安装中显示进度 */
export function ServerLinkBadge({
  online,
  installing,
  latency,
}: {
  online: boolean;
  installing?: boolean;
  latency?: number | null;
}) {
  if (installing) {
    return (
      <AnimatedBadge size="sm" status="loading" pulse contentKey="installing">
        {$('badge.installing')}
      </AnimatedBadge>
    );
  }
  if (!online) {
    return (
      <AnimatedBadge size="sm" status="danger" pulse contentKey="offline">
        {$('badge.offline')}
      </AnimatedBadge>
    );
  }
  if (latency == null) {
    // 刚连上、首次测速还没回来
    return (
      <AnimatedBadge size="sm" status="success" contentKey="online">
        {$('badge.online')}
      </AnimatedBadge>
    );
  }
  const tone = latencyTone(latency);
  const cls =
    tone === 'good'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : tone === 'fair'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-destructive/30 bg-destructive/10 text-destructive';
  return (
    <span
      className={`inline-flex h-6 items-center rounded-full border px-2 font-mono text-[11px] ${cls}`}
      title={$('badge.latency.tooltip')}
    >
      {$('badge.latency', latency === 0 ? '<1' : latency)}
    </span>
  );
}
