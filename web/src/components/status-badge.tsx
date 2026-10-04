// 状态徽章：实例状态 / Agent 在线状态 → beUI AnimatedBadge

import { AnimatedBadge } from '@/components/motion/animated-badge';
import { latencyTone, type InstanceStatus } from '@/lib/api';

const INSTANCE_MAP: Record<
  string,
  { status: 'success' | 'neutral' | 'loading' | 'danger' | 'warning'; label: string; pulse?: boolean }
> = {
  running: { status: 'success', label: '运行中' },
  starting: { status: 'loading', label: '启动中', pulse: true },
  stopped: { status: 'neutral', label: '已停止' },
  downloading: { status: 'loading', label: '下载中', pulse: true },
  failed: { status: 'danger', label: '安装失败' },
  incomplete: { status: 'warning', label: '未完成' },
};

export function InstanceStatusBadge({ status }: { status: InstanceStatus | string }) {
  const conf = INSTANCE_MAP[status] || { status: 'neutral' as const, label: status };
  return (
    <AnimatedBadge
      size="sm"
      status={conf.status}
      pulse={conf.pulse}
      contentKey={status}
    >
      {conf.label}
    </AnimatedBadge>
  );
}

export function AgentBadge({ online, installing }: { online: boolean; installing?: boolean }) {
  if (installing) {
    return (
      <AnimatedBadge size="sm" status="loading" pulse contentKey="installing">
        安装中
      </AnimatedBadge>
    );
  }
  return online ? (
    <AnimatedBadge size="sm" status="success" pulse contentKey="online">
      Agent 在线
    </AnimatedBadge>
  ) : (
    <AnimatedBadge size="sm" status="neutral" contentKey="offline">
      离线
    </AnimatedBadge>
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
        安装中
      </AnimatedBadge>
    );
  }
  if (!online) {
    return (
      <AnimatedBadge size="sm" status="danger" pulse contentKey="offline">
        离线
      </AnimatedBadge>
    );
  }
  if (latency == null) {
    // 刚连上、首次测速还没回来
    return (
      <AnimatedBadge size="sm" status="success" contentKey="online">
        在线
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
      title="面板 → 服务器 实测往返延迟"
    >
      延迟 {latency === 0 ? '<1' : latency}ms
    </span>
  );
}
