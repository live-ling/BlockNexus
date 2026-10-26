/**
 * 状态徽章（落地版）：与 `components/status-badge.tsx` 的 AnimatedBadge 不同——
 * 这里是静态 18px 胶囊，无动效、无呼吸点。
 *
 * 为什么另开一份而不是改旧的：旧徽章还用在服务器详情页/对话框里，
 * 一次性换掉会把「还没改造的页面」也带成新样式，回滚粒度就没了。
 * 逐页替换完成后再统一删除旧徽章。
 */

import { $, type TranslationKey } from '@/lib/i18n';
import type { InstanceStatus } from '@/lib/api';
import { Pill, type Tone } from './primitives';

const INSTANCE_TONE: Record<string, Tone> = {
  running: 'ok',
  starting: 'warn',
  downloading: 'warn',
  incomplete: 'warn',
  failed: 'bad',
  stopped: 'idle',
  deleted: 'idle',
};

const INSTANCE_LABEL: Record<string, TranslationKey> = {
  running: 'console.status.running',
  starting: 'console.status.starting',
  downloading: 'console.status.downloading',
  incomplete: 'console.status.incomplete',
  failed: 'console.status.failed',
  stopped: 'console.status.stopped',
};

export function InstanceStatusPill({ status, className }: { status: InstanceStatus | string; className?: string }) {
  const label = INSTANCE_LABEL[status];
  return (
    <Pill tone={INSTANCE_TONE[status] ?? 'idle'} className={className}>
      {label ? $(label) : status}
    </Pill>
  );
}

/** Agent 状态：安装中 > 在线 > 离线（与旧 AgentBadge 的优先级一致） */
export function AgentStatusPill({
  online,
  installing,
  className,
}: {
  online: boolean;
  installing?: boolean;
  className?: string;
}) {
  if (installing) {
    return (
      <Pill tone="warn" className={className}>
        {$('badge.installing')}
      </Pill>
    );
  }
  return (
    <Pill tone={online ? 'ok' : 'idle'} className={className}>
      {online ? $('badge.agent.online') : $('badge.offline')}
    </Pill>
  );
}
