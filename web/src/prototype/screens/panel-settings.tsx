// 原型屏 5：面板设置（2026-10-21 第三版）。左侧目录 + 右侧全部设置项，分区之间只有分隔线。

import { useState } from 'react';
import { Download, ExternalLink, RefreshCw, Send } from 'lucide-react';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Field, FormGrid, INPUT_CLASS, KV, Segmented, Select } from '../proto-ui';
import { SettingsLayout, type SettingsSection } from '../settings-layout';
import { PageHeader } from '../shell';

export function PanelSettingsScreen() {
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [density, setDensity] = useState<'compact' | 'standard'>('compact');

  const sections: SettingsSection[] = [
    {
      id: 'access',
      label: $('proto.ps.access'),
      content: (
        <FormGrid>
          <Field label={$('proto.field.loginEnabled')} hint={$('proto.ps.accessHint')}>
            <div className="flex h-9 items-center">
              <Switch defaultChecked />
            </div>
          </Field>
          <Field label={$('proto.field.sessionTTL')}>
            <Select
              value="24h"
              onChange={() => {}}
              className="w-full"
              options={[
                { value: '1h', label: '1h' },
                { value: '24h', label: '24h' },
                { value: '7d', label: '7d' },
              ]}
            />
          </Field>
          <Field label={$('proto.field.username')}>
            <input className={INPUT_CLASS} defaultValue="admin" autoComplete="username" />
          </Field>
          <Field label={$('proto.field.password')}>
            <div className="flex min-w-0 gap-1.5">
              <input className={INPUT_CLASS} defaultValue="••••••••" disabled />
              <Button size="sm" variant="outline" className="shrink-0">
                {$('proto.btn.resetPassword')}
              </Button>
            </div>
          </Field>
          <Field label={$('proto.field.passwordConfirm')} hint={$('proto.ps.passwordHint')}>
            <input className={INPUT_CLASS} defaultValue="••••••••" disabled />
          </Field>
        </FormGrid>
      ),
    },
    {
      id: 'network',
      label: $('proto.ps.network'),
      content: (
        <div className="grid max-w-[620px] gap-5">
          <div className="grid gap-2">
            <h3 className="text-[12px] font-medium">{$('proto.field.panelDomain')}</h3>
            <FormGrid>
              <Field label={$('proto.field.panelDomain')} wide hint="https://mc.example.com">
                <input className={INPUT_CLASS} defaultValue="mc.example.com" />
              </Field>
            </FormGrid>
          </div>
          <div className="grid gap-2">
            <h3 className="text-[12px] font-medium">DDNS</h3>
            <FormGrid>
              <Field label={$('proto.field.ddnsProvider')}>
                <Select
                  value="cloudflare"
                  onChange={() => {}}
                  className="w-full"
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
          </div>
        </div>
      ),
    },
    {
      id: 'notify',
      label: $('proto.ps.notify'),
      content: (
        <div className="grid max-w-[620px] gap-3">
          <FormGrid>
            <Field label={$('proto.field.smtpHost')}>
              <input className={INPUT_CLASS} defaultValue="smtp.example.com" />
            </Field>
            <Field label={$('proto.field.smtpUser')}>
              <input className={INPUT_CLASS} defaultValue="panel@example.com" />
            </Field>
            <Field label={$('proto.field.smtpFrom')} wide>
              <input className={INPUT_CLASS} defaultValue="BlockNexus <panel@example.com>" />
            </Field>
          </FormGrid>

          <div className="grid gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">{$('proto.notify.on')}</span>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-[11.5px]">
              {[$('proto.notify.instance'), $('proto.notify.player')].map((label) => (
                <label key={label} className="flex items-center gap-2">
                  <Switch defaultChecked size="sm" />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <Button size="sm" variant="outline" className="w-fit">
            <Send className="size-3.5" />
            {$('proto.btn.testMail')}
          </Button>
        </div>
      ),
    },
    {
      id: 'ai',
      label: $('proto.ps.ai'),
      content: (
        <FormGrid>
          <Field label={$('proto.field.aiProvider')}>
            <Select
              value="deepseek"
              onChange={() => {}}
              className="w-full"
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
      ),
    },
    {
      id: 'update',
      label: $('proto.ps.update'),
      content: (
        <div className="grid max-w-[620px] gap-3">
          <div className="grid gap-1.5">
            <KV label={$('proto.update.current')} mono>
              0.6.0
            </KV>
            <KV label="Agent" mono>
              0.5.4
            </KV>
          </div>
          <div className="flex items-center gap-3 text-[12px]">
            <span>{$('proto.update.policy')}</span>
            <Switch defaultChecked size="sm" />
            <span className="text-[11px] text-muted-foreground">{$('proto.update.auto')}</span>
            <Button size="sm" variant="outline" className="ml-auto">
              <RefreshCw className="size-3.5" />
              {$('proto.btn.checkUpdate')}
            </Button>
          </div>
          <div className="grid gap-1 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Download className="size-3.5" />
              v0.6.0 — {$('proto.ps.changelogNote')}
            </span>
            <span>v0.5.2 — i18n · terminal dock</span>
          </div>
        </div>
      ),
    },
    {
      id: 'appearance',
      label: $('proto.ps.appearance'),
      content: (
        <FormGrid>
          <Field label={$('proto.field.language')}>
            <Segmented<'zh' | 'en'>
              value={lang}
              onChange={setLang}
              className="h-9"
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
              className="h-9"
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
              className="w-full"
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Field>
        </FormGrid>
      ),
    },
    {
      id: 'about',
      label: $('proto.ps.about'),
      content: (
        <div className="grid max-w-[620px] gap-2">
          <KV label={$('proto.about.version')} mono>
            BlockNexus 0.6.0
          </KV>
          <KV label={$('proto.about.license')}>MIT</KV>
          <KV label={$('proto.about.links')}>
            <span className="flex gap-3">
              <a
                className="flex items-center gap-1 text-primary hover:underline"
                href="https://github.com/live-ling/BlockNexus"
              >
                GitHub <ExternalLink className="size-3" />
              </a>
              <a
                className="flex items-center gap-1 text-primary hover:underline"
                href="https://github.com/live-ling/BlockNexus#readme"
              >
                {$('proto.about.docs')} <ExternalLink className="size-3" />
              </a>
            </span>
          </KV>
          <p className="text-[11px] text-muted-foreground">{$('proto.about.thanks')}</p>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={<h1 className="truncate text-[13px] font-semibold">{$('proto.ps.title')}</h1>}
        subtitle={<span className="font-mono">v0.6.0</span>}
        actions={
          <>
            <Button size="sm" variant="outline">
              {$('proto.save.discard')}
            </Button>
            <Button size="sm">{$('proto.save.apply')}</Button>
          </>
        }
      />

      <SettingsLayout sections={sections} />
    </>
  );
}
