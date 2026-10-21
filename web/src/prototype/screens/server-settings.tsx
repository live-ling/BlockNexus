// 原型屏 4：服务器设置（2026-10-21 第三版）。
// 左侧目录 + 右侧一次列出全部设置项；分区之间只有分隔线，不再套卡片。

import { Plug, RefreshCw, Trash2 } from 'lucide-react';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Field, FormGrid, INPUT_CLASS, KV, SaveBar, Select } from '../proto-ui';
import { SettingsLayout, type SettingsSection } from '../settings-layout';
import { PageHeader, type ProtoScreen } from '../shell';

export function ServerSettingsScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  const sections: SettingsSection[] = [
    {
      id: 'conn',
      label: $('proto.ss.conn'),
      content: (
        <div className="grid gap-3">
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
                className="w-full"
                options={[
                  { value: 'key', label: $('proto.ssh.key') },
                  { value: 'password', label: $('proto.ssh.password') },
                ]}
              />
            </Field>
            <Field label={$('proto.field.sshKey')} wide hint={$('proto.ss.connHint')}>
              <input className={INPUT_CLASS} defaultValue="/root/.ssh/id_ed25519" />
            </Field>
          </FormGrid>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline">
              <Plug className="size-3.5" />
              {$('proto.btn.test')}
            </Button>
            <span className="text-[11px] text-muted-foreground">{$('proto.ss.connTested')}</span>
          </div>
        </div>
      ),
    },
    {
      id: 'agent',
      label: 'Agent',
      content: (
        <div className="grid max-w-[620px] gap-3">
          <div className="grid gap-1.5">
            <KV label={$('proto.agent.version')} mono>
              0.5.4 (latest)
            </KV>
            <KV label={$('proto.col.status')}>
              <span className="text-emerald-600 dark:text-emerald-400">online · 12ms</span>
            </KV>
            <KV label={$('proto.agent.token')} mono>
              ••••••••••••3f9a
            </KV>
          </div>
          <div className="flex items-center gap-3 text-[12px]">
            <span>{$('proto.agent.autoUpdate')}</span>
            <Switch defaultChecked size="sm" className="ml-auto" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline">
              <RefreshCw className="size-3.5" />
              {$('proto.btn.reinstallAgent')}
            </Button>
            <Button size="sm" variant="ghost">
              {$('proto.btn.rotate')}
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
              {$('proto.btn.uninstallAgent')}
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: 'runtime',
      label: $('proto.ss.runtime'),
      content: (
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
              className="w-full"
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
      ),
    },
    {
      id: 'delete',
      label: $('proto.btn.deleteServer'),
      content: (
        <div className="grid max-w-[620px] gap-2.5">
          <p className="text-[11.5px] text-muted-foreground">{$('proto.server.deleteHint')}</p>
          <Button size="sm" variant="destructive" className="w-fit">
            <Trash2 className="size-3.5" />
            {$('proto.btn.deleteServer')}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        back={() => onScreen('servers')}
        title={<h1 className="truncate text-[13px] font-semibold">{$('proto.ss.title')}</h1>}
        subtitle={<span className="font-mono">survival-main · 192.168.1.10</span>}
      />

      <div className="flex min-h-0 flex-1 flex-col pb-16">
        <SettingsLayout sections={sections} />
        <SaveBar
          label={$('proto.save.dirty')}
          discardLabel={$('proto.save.discard')}
          saveLabel={$('proto.save.apply')}
          onDiscard={() => {}}
          onSave={() => {}}
        />
      </div>
    </>
  );
}
