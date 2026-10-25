// 关于页：面板信息、开源依赖、引用服务与声明
// 路由 #/about —— 设置页底部进入
//
// 2026-10-25：改成与「面板设置 / 服务器设置」同一套骨架（SettingsLayout：左目录 + 右侧分区，
// 分区不套卡片、不用分隔线）。原来这里是「卡片 + 双列」，和设置页是两套视觉语言。
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { SettingsLayout } from '@/components/layout/settings-layout';
import { PageHeader } from '@/components/layout/page-header';
import { api, type Me } from '@/lib/api';
import { $, type TranslationKey } from '@/lib/i18n';

/**
 * 引用条目的形状：`desc` 一律走 i18n 键；`name` 二选一——
 * 要么是**品牌名/专有名词**（BMCLAPI、ssh2 等，不该翻译，直接写字面量），
 * 要么是 i18n 键。用**可辨识联合**而不是两个可选字段：
 * 后者会让 `item.name` 变成 `string | undefined`，取词处就得靠 `!` 或 `?? ''`
 * 掩盖问题，而 `?? ''` 一旦漏写就是渲染出一个空名字且不报错。
 */
type RefItem = { url: string; descKey: TranslationKey } & ({ name: string } | { nameKey: TranslationKey });

/** 取显示名：有字面量就用字面量（品牌名不翻），否则取 i18n 键 */
const refName = (item: RefItem): string => ('name' in item ? item.name : $(item.nameKey));

/** 引用服务：镜像与官方 API（MSL 条款要求在页面注明来源）；数据只存键名，渲染期取词 */
const SERVICES: RefItem[] = [
  {
    nameKey: 'about.service.msl.name',
    url: 'https://www.mslmc.cn',
    descKey: 'about.service.msl.desc',
  },
  {
    name: 'BMCLAPI',
    url: 'https://bmclapi2.bangbang93.com',
    descKey: 'about.service.bmclapi.desc',
  },
  {
    nameKey: 'about.service.mojang.name',
    url: 'https://www.minecraft.net',
    descKey: 'about.service.mojang.desc',
  },
  {
    name: 'Adoptium Temurin',
    url: 'https://adoptium.net',
    descKey: 'about.service.adoptium.desc',
  },
  {
    name: 'PaperMC / PurpurMC / FabricMC / Forge / NeoForge',
    url: 'https://papermc.io',
    descKey: 'about.service.cores.desc',
  },
];

/** 开源依赖：面板与前端构建在其上 */
const DEPS: RefItem[] = [
  { name: 'React + Vite + TypeScript', url: 'https://react.dev', descKey: 'about.dep.react.desc' },
  { name: 'Tailwind CSS 4 + shadcn/ui (Radix)', url: 'https://tailwindcss.com', descKey: 'about.dep.tailwind.desc' },
  { name: 'beUI', url: 'https://beui.dev', descKey: 'about.dep.beui.desc' },
  { name: 'Express + ws', url: 'https://expressjs.com', descKey: 'about.dep.express.desc' },
  { name: 'ssh2', url: 'https://github.com/mscdex/ssh2.js', descKey: 'about.dep.ssh2.desc' },
  { name: 'nodemailer', url: 'https://nodemailer.com', descKey: 'about.dep.nodemailer.desc' },
  { name: 'WebView2', url: 'https://developer.microsoft.com/microsoft-edge/webview2', descKey: 'about.dep.webview2.desc' },
  { nameKey: 'about.dep.node.name', url: 'https://nodejs.org', descKey: 'about.dep.node.desc' },
];

/** 引用行：名称 + 说明 + 外链（不要分隔线，靠间距分组） */
function RefRow({ name, url, desc }: { name: string; url: string; desc: string }) {
  return (
    <div className="-mx-1.5 flex items-start justify-between gap-4 rounded-md px-1.5 py-2.5 transition-colors hover:bg-muted/40">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{name}</p>
        <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{desc}</p>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-0.5 flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {$('about.link')} <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

/** 开源信息：仓库地址（许可证全文经 /api/license 直出展示） */
const REPO_URL = 'https://github.com/live-ling/BlockNexus';

export function AboutPage({ onBack }: { onBack: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [licOpen, setLicOpen] = useState(false);
  const [licText, setLicText] = useState<string | null>(null);

  useEffect(() => {
    api<Me>('/me').then(setMe).catch(() => {});
  }, []);

  /** 许可证全文懒加载：首次展开才拉取 */
  const toggleLicense = () => {
    setLicOpen((v) => {
      const next = !v;
      if (next && licText === null) {
        api<{ text: string }>('/license')
          .then((r) => setLicText(r.text))
          .catch(() => setLicText($('about.license.loadFailed')));
      }
      return next;
    });
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <PageHeader back={onBack} title={$('about.title')} subtitle={$('about.subtitle')} />

      <SettingsLayout
        contentClassName="mx-auto max-w-[920px]"
        sections={[
          {
            id: 'panel',
            label: $('about.title'),
            heading: false,
            content: (
              <div className="grid gap-4">
                <div className="flex items-center gap-4">
                  <img
                    src="/logo.png"
                    alt="BlockNexus"
                    className="size-14 shrink-0 rounded-xl object-cover ring-1 ring-border"
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[16px] font-semibold">BlockNexus</h2>
                      <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                        v{me?.version ?? '…'}
                      </span>
                    </div>
                    <p className="mt-1 max-w-[640px] text-[12px] leading-5 text-muted-foreground">
                      {$('about.description')}
                    </p>
                  </div>
                </div>

                <div className="grid gap-2 lg:grid-cols-2">
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex min-w-0 items-center justify-between gap-3 rounded-lg bg-muted/40 px-3.5 py-3 transition-colors hover:bg-muted/70"
                  >
                    <span className="shrink-0 text-[12px] text-muted-foreground">{$('about.repo')}</span>
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px]">
                      <span className="truncate">github.com/live-ling/BlockNexus</span>
                      <ExternalLink className="size-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-100" />
                    </span>
                  </a>
                  <button
                    type="button"
                    onClick={toggleLicense}
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3.5 py-3 text-left transition-colors hover:bg-muted/70"
                  >
                    <span className="text-[12px] text-muted-foreground">{$('about.license')}</span>
                    <span className="flex items-center gap-1.5 text-[12px]">
                      MIT
                      {licOpen ? (
                        <ChevronUp className="size-3.5 opacity-50" />
                      ) : (
                        <ChevronDown className="size-3.5 opacity-50" />
                      )}
                    </span>
                  </button>
                </div>

                {licOpen && (
                  <pre className="max-h-72 overflow-y-auto rounded-lg bg-muted/40 p-3.5 font-mono text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
                    {licText ?? $('common.loading')}
                  </pre>
                )}
              </div>
            ),
          },
          {
            id: 'services',
            label: $('about.services'),
            content: (
              <>
                <p className="text-[11px] text-muted-foreground">{$('about.services.desc')}</p>
                <div className="mt-2.5 grid gap-0.5">
                  {SERVICES.map((s) => (
                    <RefRow key={s.url} name={refName(s)} url={s.url} desc={$(s.descKey)} />
                  ))}
                </div>
              </>
            ),
          },
          {
            id: 'deps',
            label: $('about.deps'),
            content: (
              <>
                <p className="text-[11px] text-muted-foreground">{$('about.deps.desc')}</p>
                <div className="mt-2.5 grid gap-0.5">
                  {DEPS.map((d) => (
                    <RefRow key={d.url} name={refName(d)} url={d.url} desc={$(d.descKey)} />
                  ))}
                </div>
              </>
            ),
          },
          {
            id: 'disclaimer',
            label: $('about.disclaimer.title'),
            content: (
              <ul className="grid gap-2 text-[12px] leading-6 text-muted-foreground">
                <li>{$('about.disclaimer.mojang')}</li>
                <li>
                  {$('about.disclaimer.eula.pre')}
                  <a
                    className="underline underline-offset-2 hover:text-foreground"
                    href="https://aka.ms/MinecraftEULA"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Minecraft EULA
                  </a>
                  {$('about.disclaimer.eula.post')}
                </li>
                <li>{$('about.disclaimer.personal')}</li>
              </ul>
            ),
          },
        ]}
      />
    </div>
  );
}
