// 服务器列表页

import { useState } from 'react';
import { Plus, Server } from 'lucide-react';
import { AddServerDialog } from '@/components/dialogs';
import { ServerLinkBadge } from '@/components/status-badge';
import { TiltCard } from '@/components/motion/tilt-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CardField } from '@/components/card-field';
import { fmtDiskGB, fmtMB, timeago, type Me, type ServerSummary } from '@/lib/api';
import { MaskedText } from '@/components/masked-text';

export function ServersPage({
  me,
  servers,
  onAdd,
}: {
  me: Me;
  servers: ServerSummary[];
  onAdd: (s: ServerSummary) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-28 pt-7">
      <div className="flex items-center">
        <h2 className="text-lg font-semibold">我的服务器</h2>
        <Button className="ml-auto" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> 添加服务器
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          还没有服务器
          <br />
          <span className="text-xs">点击右上角「添加服务器」，面板会通过 SSH 自动安装 Agent</span>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {servers.map((s) => (
            <TiltCard key={s.id} max={10} className="rounded-xl">
              <Card
                className="h-full cursor-pointer border border-border transition-colors hover:border-muted-foreground/40"
                onClick={() => (location.hash = `#/server/${s.id}`)}
              >
                <CardContent className="grid gap-3.5 p-5">
                  {/* 标题区：eyebrow + 图标 + 名称 + 徽章（beUI TiltCard demo 风格） */}
                  <div className="flex items-start gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-muted/60 text-primary">
                      <Server className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Server
                      </div>
                      <h3 className="truncate text-base font-semibold text-foreground">{s.name}</h3>
                    </div>
                    <span className="shrink-0 self-start">
                      <ServerLinkBadge online={s.online} installing={s.installing} latency={s.latency} />
                    </span>
                  </div>

                  {/* 地址（默认脱敏，点击显示；不触发卡片跳转） */}
                  <div className="flex items-baseline gap-1.5 text-xs">
                    <span className="w-[2.6em] shrink-0 text-muted-foreground">IP</span>
                    <MaskedText value={s.host} className="text-muted-foreground" />
                  </div>

                  {/* 系统信息：两列网格 + 定宽标签对齐；内存/磁盘占用来自面板后台拉取的资源快照 */}
                  {s.info ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                      <CardField label="主机" value={s.info.hostname} className="col-span-2" />
                      <CardField
                        label="系统"
                        value={`${s.info.os} · ${s.info.arch}`}
                        className="col-span-2"
                      />
                      <CardField
                        label="内存"
                        value={
                          s.stats
                            ? `${fmtMB(s.stats.memUsedMB)} / ${fmtMB(s.stats.memTotalMB)}`
                            : fmtMB(s.info.memTotalMB)
                        }
                        className="col-span-2"
                      />
                      <CardField
                        label="磁盘"
                        value={
                          s.stats?.disk
                            ? fmtDiskGB(s.stats.disk.totalGB - s.stats.disk.freeGB, s.stats.disk.totalGB)
                            : '—'
                        }
                        className="col-span-2"
                      />
                      <CardField
                        label="Java"
                        value={s.info.java.installed ? String(s.info.java.major) : '未安装'}
                        tone={s.info.java.installed ? undefined : 'warn'}
                      />
                      <CardField label="Node" value={s.info.node.replace('v', '')} />
                      <CardField label="在线" value={timeago(s.lastSeen)} className="col-span-2" />
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      {s.installing ? 'Agent 安装中…' : 'Agent 离线，暂无系统信息'}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TiltCard>
          ))}
        </div>
      )}

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        panelPort={me.port}
        onCreated={(s) => {
          onAdd(s);
          location.hash = `#/server/${s.id}`;
        }}
      />
    </div>
  );
}
