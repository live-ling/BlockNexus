// 原型屏 4：服务器设置。左侧子导航 + 分区表单 + 底部粘性保存条。
import { useState } from 'react';
import { Plug, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Field, FormGrid, INPUT_CLASS, KV, Panel, SaveBar, Select } from '../proto-ui';
import { PageHeader, type ProtoScreen } from '../shell';

type Nav = 'conn' | 'agent' | 'runtime' | 'danger';

export function ServerSettingsScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  const [nav, setNav] = useState<Nav>('conn');

  const items: { id: Nav; label: string }[] = [
    { id: 'conn', label: $('proto.ss.conn') },
    { id: 'agent', label: 'Agent' },
    { id: 'runtime', label: $('proto.ss.runtime') },
    { id: 'danger', label: $('proto.ss.danger') },
  ];

  return (
    <>
      <PageHeader
        back={() => onScreen('servers')}
        title={<h1 className="truncate text-[13px] font-semibold">{$('proto.ss.title')}</h1>}
        subtitle={<span className="font-mono">survival-main · 192.168.1.10</span>}
      />

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r p-2">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => setNav(it.id)}
              className={cn(
                'flex h-8 items-center rounded-md px-2 text-[12px] transition-colors',
                nav === it.id
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                it.id === 'danger' && nav === it.id && 'bg-destructive/10 text-destructive',
                it.id === 'danger' && nav !== it.id && 'text-destructive/80 hover:text-destructive',
              )}
            >
              {it.label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {nav === 'conn' && (
              <Panel title={$('proto.ss.conn')} hint={$('proto.ss.connHint')}>
                <FormGrid>
                  <Field label={$('proto.field.sshHost')}>
                    <input className={INPUT_CLASS} defaultValue="192.168.1.10" />
                  </Field>
                  <Field label={$('proto.field.sshPort')}>
                    <input className={INPUT_CLASS} defaultValue="22" />
                  </Field>
                  <Field label={$('proto.field.sshUser')}>
                    <input className={INPUT_CLASS} defaultValue="root" />
                  </Field>
                  <Field label={$('proto.field.sshAuth')}>
                    <Select
                      value="key"
                      onChange={() => {}}
                      className="h-8 w-full"
                      options={[
                        { value: 'key', label: $('proto.ssh.key') },
                        { value: 'password', label: $('proto.ssh.password') },
                      ]}
                    />
                  </Field>
                  <Field label={$('proto.field.sshKey')} wide hint="/root/.ssh/id_ed25519">
                    <input className={INPUT_CLASS} defaultValue="/root/.ssh/id_ed25519" />
                  </Field>
                </FormGrid>
                <div className="mt-3 flex items-center gap-2 border-t pt-3">
                  <Button size="sm" variant="outline">
                    <Plug className="size-3.5" />
                    {$('proto.btn.test')}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">{$('proto.ss.connTested')}</span>
                </div>
              </Panel>
            )}

            {nav === 'agent' && (
              <div className="grid max-w-[860px] gap-2">
                <Panel
                  title="Agent"
                  actions={
                    <>
                      <Button size="xs" variant="outline">
                        <RefreshCw className="size-3" />
                        {$('proto.btn.reinstallAgent')}
                      </Button>
                      <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive">
                        {$('proto.btn.uninstallAgent')}
                      </Button>
                    </>
                  }
                >
                  <div className="grid gap-1.5">
                    <KV label={$('proto.agent.version')} mono>
                      0.5.4 (latest)
                    </KV>
                    <KV label={$('proto.col.status')}>
                      <span className="text-emerald-600 dark:text-emerald-400">online · 12ms</span>
                    </KV>
                    <KV label={$('proto.agent.token')} mono>
                      ••••••••••••3f9a
                      <Button size="xs" variant="ghost" className="ml-2">
                        {$('proto.btn.rotate')}
                      </Button>
                    </KV>
                    <div className="flex h-7 items-center gap-2 border-t pt-2 text-[12px]">
                      <span>{$('proto.agent.autoUpdate')}</span>
                      <Switch defaultChecked size="sm" className="ml-auto" />
                    </div>
                  </div>
                </Panel>
              </div>
            )}

            {nav === 'runtime' && (
              <Panel title={$('proto.ss.runtime')}>
                <FormGrid>
                  <Field label={$('proto.field.workDir')} wide hint="/opt/blocknexus/instances">
                    <input className={INPUT_CLASS} defaultValue="/opt/blocknexus/instances" />
                  </Field>
                  <Field label={$('proto.field.javaPath')} wide hint="/opt/blocknexus-java/21/bin/java">
                    <input className={INPUT_CLASS} defaultValue="/opt/blocknexus-java/21/bin/java" />
                  </Field>
                  <Field label={$('proto.field.javaMajor')}>
                    <Select
                      value="21"
                      onChange={() => {}}
                      className="h-8 w-full"
                      options={[
                        { value: '21', label: 'Java 21' },
                        { value: '17', label: 'Java 17' },
                      ]}
                    />
                  </Field>
                  <Field label={$('proto.field.defaultMemory')}>
                    <input className={INPUT_CLASS} defaultValue="4096" />
                  </Field>
                  <Field label={$('proto.field.portRange')}>
                    <input className={INPUT_CLASS} defaultValue="25565-25600" />
                  </Field>
                </FormGrid>
              </Panel>
            )}

            {nav === 'danger' && (
              <Panel title={$('proto.ss.danger')}>
                <div className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="grid gap-2">
                    <p className="text-[11.5px] text-muted-foreground">{$('proto.danger.hint')}</p>
                    <Button size="sm" variant="destructive" className="w-fit">
                      <Trash2 className="size-3.5" />
                      {$('proto.btn.deleteServer')}
                    </Button>
                  </div>
                </div>
              </Panel>
            )}
          </div>

          <SaveBar
            label={$('proto.save.dirty')}
            discardLabel={$('proto.save.discard')}
            saveLabel={$('proto.save.apply')}
            onDiscard={() => {}}
            onSave={() => {}}
          />
        </div>
      </div>
    </>
  );
}
