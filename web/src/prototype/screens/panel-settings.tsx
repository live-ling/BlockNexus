// 原型屏 5：面板设置。7 个分区，表单双列，底部粘性保存条。
import { useState } from 'react';
import { Download, ExternalLink, RefreshCw, Send } from 'lucide-react';
import { cn } from 'cn';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Field, FormGrid, INPUT_CLASS, KV, Panel, SaveBar, Select, Segmented } from '../proto-ui';
import { PageHeader } from '../shell';

type Nav = 'access' | 'network' | 'notify' | 'ai' | 'update' | 'appearance' | 'about';

export function PanelSettingsScreen() {
  const [nav, setNav] = useState<Nav>('access');
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [density, setDensity] = useState<'compact' | 'standard'>('compact');

  const items: { id: Nav; label: string }[] = [
    { id: 'access', label: $('proto.ps.access') },
    { id: 'network', label: $('proto.ps.network') },
    { id: 'notify', label: $('proto.ps.notify') },
    { id: 'ai', label: $('proto.ps.ai') },
    { id: 'update', label: $('proto.ps.update') },
    { id: 'appearance', label: $('proto.ps.appearance') },
    { id: 'about', label: $('proto.ps.about') },
  ];

  return (
    <>
      <PageHeader
        title={<h1 className="truncate text-[13px] font-semibold">{$('proto.ps.title')}</h1>}
        subtitle={<span className="font-mono">v0.6.0</span>}
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
              )}
            >
              {it.label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {nav === 'access' && (
              <Panel title={$('proto.ps.access')}>
                <FormGrid>
                  <Field label={$('proto.field.loginEnabled')} hint={$('proto.ps.accessHint')}>
                    <div className="flex h-8 items-center">
                      <Switch defaultChecked />
                    </div>
                  </Field>
                  <Field label={$('proto.field.sessionTTL')}>
                    <Select
                      value="24h"
                      onChange={() => {}}
                      className="h-8 w-full"
                      options={[
                        { value: '1h', label: '1h' },
                        { value: '24h', label: '24h' },
                        { value: '7d', label: '7d' },
                      ]}
                    />
                  </Field>
                  <Field label={$('proto.field.password')} wide>
                    <div className="flex gap-1.5">
                      <input className={INPUT_CLASS} defaultValue="••••••••" disabled />
                      <Button size="sm" variant="outline">
                        {$('proto.btn.resetPassword')}
                      </Button>
                    </div>
                  </Field>
                </FormGrid>
              </Panel>
            )}

            {nav === 'network' && (
              <div className="grid max-w-[860px] gap-2">
                <Panel title={$('proto.field.panelDomain')}>
                  <FormGrid>
                    <Field label={$('proto.field.panelDomain')} wide hint="https://mc.example.com">
                      <input className={INPUT_CLASS} defaultValue="mc.example.com" />
                    </Field>
                  </FormGrid>
                </Panel>
                <Panel title="DDNS">
                  <FormGrid>
                    <Field label={$('proto.field.ddnsProvider')}>
                      <Select
                        value="cloudflare"
                        onChange={() => {}}
                        className="h-8 w-full"
                        options={[
                          { value: 'cloudflare', label: 'Cloudflare' },
                          { value: 'dnspod', label: 'DNSPod' },
                          { value: 'custom', label: 'Custom' },
                        ]}
                      />
                    </Field>
                    <Field label={$('proto.field.ddnsDomain')}>
                      <input className={INPUT_CLASS} defaultValue="mc.example.com" />
                    </Field>
                    <Field label={$('proto.field.ddnsToken')} wide>
                      <input className={INPUT_CLASS} defaultValue="••••••••••••" />
                    </Field>
                  </FormGrid>
                </Panel>
              </div>
            )}

            {nav === 'notify' && (
              <div className="grid max-w-[860px] gap-2">
                <Panel title={$('proto.ps.notify')}>
                  <FormGrid>
                    <Field label={$('proto.field.smtpHost')}>
                      <input className={INPUT_CLASS} defaultValue="smtp.example.com" />
                    </Field>
                    <Field label={$('proto.field.smtpUser')}>
                      <input className={INPUT_CLASS} defaultValue="panel@example.com" />
                    </Field>
                    <Field label={$('proto.field.smtpFrom')}>
                      <input className={INPUT_CLASS} defaultValue="BlockNexus <panel@example.com>" />
                    </Field>
                    <Field label={$('proto.notify.on')}>
                      <div className="grid h-8 content-center gap-0.5 text-[11.5px] text-muted-foreground">
                        <span>{$('proto.notify.instance')} · {$('proto.notify.player')}</span>
                      </div>
                    </Field>
                  </FormGrid>
                  <div className="mt-3 flex gap-1.5 border-t pt-3">
                    <Button size="sm" variant="outline">
                      <Send className="size-3.5" />
                      {$('proto.btn.testMail')}
                    </Button>
                  </div>
                </Panel>
              </div>
            )}

            {nav === 'ai' && (
              <Panel title={$('proto.ps.ai')}>
                <FormGrid>
                  <Field label={$('proto.field.aiProvider')}>
                    <Select
                      value="deepseek"
                      onChange={() => {}}
                      className="h-8 w-full"
                      options={[
                        { value: 'deepseek', label: 'DeepSeek' },
                        { value: 'openai', label: 'OpenAI' },
                        { value: 'custom', label: 'Custom' },
                      ]}
                    />
                  </Field>
                  <Field label={$('proto.field.aiModel')}>
                    <input className={INPUT_CLASS} defaultValue="deepseek-chat" />
                  </Field>
                  <Field label={$('proto.field.aiKey')} wide hint={$('proto.ps.aiKeyHint')}>
                    <input className={INPUT_CLASS} defaultValue="sk-••••••••••••••••" />
                  </Field>
                </FormGrid>
              </Panel>
            )}

            {nav === 'update' && (
              <div className="grid max-w-[860px] gap-2">
                <Panel
                  title={$('proto.ps.update')}
                  actions={
                    <Button size="xs" variant="outline">
                      <RefreshCw className="size-3" />
                      {$('proto.btn.checkUpdate')}
                    </Button>
                  }
                >
                  <div className="grid gap-1.5">
                    <KV label={$('proto.update.current')} mono>
                      0.6.0
                    </KV>
                    <KV label="Agent" mono>
                      0.5.4
                    </KV>
                    <div className="flex h-7 items-center gap-2 border-t pt-2 text-[12px]">
                      <span>{$('proto.update.policy')}</span>
                      <Switch defaultChecked size="sm" className="ml-auto" />
                      <span className="text-[11px] text-muted-foreground">{$('proto.update.auto')}</span>
                    </div>
                  </div>
                </Panel>
                <Panel title={$('proto.ps.changelog')}>
                  <div className="grid gap-1 text-[11.5px]">
                    <span className="flex items-center gap-1.5">
                      <Download className="size-3.5 text-muted-foreground" />
                      v0.6.0 — {$('proto.ps.changelogNote')}
                    </span>
                    <span className="text-muted-foreground">v0.5.2 — i18n、终端 dock、安装续装</span>
                  </div>
                </Panel>
              </div>
            )}

            {nav === 'appearance' && (
              <Panel title={$('proto.ps.appearance')}>
                <FormGrid>
                  <Field label={$('proto.field.language')}>
                    <Segmented<'zh' | 'en'>
                      value={lang}
                      onChange={setLang}
                      className="h-8"
                      options={[
                        { value: 'zh', label: '简体中文' },
                        { value: 'en', label: 'English' },
                      ]}
                    />
                  </Field>
                  <Field label={$('proto.field.density')}>
                    <Segmented<'compact' | 'standard'>
                      value={density}
                      onChange={setDensity}
                      className="h-8"
                      options={[
                        { value: 'compact', label: $('proto.density.compact') },
                        { value: 'standard', label: $('proto.density.standard') },
                      ]}
                    />
                  </Field>
                  <Field label={$('proto.field.theme')}>
                    <Select
                      value="system"
                      onChange={() => {}}
                      className="h-8 w-full"
                      options={[
                        { value: 'system', label: 'System' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                      ]}
                    />
                  </Field>
                </FormGrid>
              </Panel>
            )}

            {nav === 'about' && (
              <Panel title={$('proto.ps.about')}>
                <div className="grid max-w-[560px] gap-1.5">
                  <KV label={$('proto.about.version')} mono>
                    BlockNexus 0.6.0
                  </KV>
                  <KV label={$('proto.about.license')}>MIT</KV>
                  <KV label={$('proto.about.links')}>
                    <span className="flex gap-3">
                      <a className="flex items-center gap-1 text-primary hover:underline" href="https://github.com/live-ling/BlockNexus">
                        GitHub <ExternalLink className="size-3" />
                      </a>
                      <a className="flex items-center gap-1 text-primary hover:underline" href="https://github.com/live-ling/BlockNexus#readme">
                        {$('proto.about.docs')} <ExternalLink className="size-3" />
                      </a>
                    </span>
                  </KV>
                  <div className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">{$('proto.about.thanks')}</div>
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
