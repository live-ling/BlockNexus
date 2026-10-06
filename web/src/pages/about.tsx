// 关于页：面板信息、开源依赖、引用服务与声明
// 路由 #/about —— 设置页底部进入
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, ExternalLink, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

function RefRow({ name, url, desc }: { name: string; url: string; desc: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/60">
      <div className="min-w-0">
        <p className="text-sm font-medium">{name}</p>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{desc}</p>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
    <div className="mx-auto w-full max-w-[1400px] px-6 pb-24 pt-7">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label={$('common.back')} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">{$('about.title')}</h2>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{$('about.subtitle')}</p>

      {/* 宽屏双列铺满，窄屏自动堆叠为单列 */}
      <div className="mt-5 grid items-start gap-4 xl:grid-cols-2">
        {/* 面板信息 */}
        <Card className="ring-1 ring-border xl:col-span-2">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <img
                src="/logo.png"
                alt="BlockNexus"
                className="h-14 w-14 rounded-xl object-cover ring-1 ring-border"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold">BlockNexus</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    v{me?.version ?? '…'}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{$('about.description')}</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="group flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3.5 py-2.5 transition-colors hover:border-foreground/20 hover:bg-muted/70"
              >
                <span className="shrink-0 text-xs text-muted-foreground">{$('about.repo')}</span>
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                  <span className="truncate">github.com/live-ling/BlockNexus</span>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-100" />
                </span>
              </a>
              <button
                type="button"
                onClick={toggleLicense}
                className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3.5 py-2.5 text-left transition-colors hover:border-foreground/20 hover:bg-muted/70"
              >
                <span className="text-xs text-muted-foreground">{$('about.license')}</span>
                <span className="flex items-center gap-1.5 text-xs">
                  MIT
                  {licOpen ? <ChevronUp className="h-3.5 w-3.5 opacity-50" /> : <ChevronDown className="h-3.5 w-3.5 opacity-50" />}
                </span>
              </button>
            </div>
            {licOpen && (
              <pre className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {licText ?? $('common.loading')}
              </pre>
            )}
          </CardContent>
        </Card>

        {/* 引用服务 */}
        <Card className="ring-1 ring-border">
          <CardContent className="p-5">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{$('about.services')}</h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{$('about.services.desc')}</p>
            <div className="mt-3 grid gap-0.5">
              {SERVICES.map((s) => (
                <RefRow key={s.url} name={refName(s)} url={s.url} desc={$(s.descKey)} />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 开源依赖 */}
        <Card className="ring-1 ring-border">
          <CardContent className="p-5">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{$('about.deps')}</h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{$('about.deps.desc')}</p>
            <div className="mt-3 grid gap-0.5">
              {DEPS.map((d) => (
                <RefRow key={d.url} name={refName(d)} url={d.url} desc={$(d.descKey)} />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 声明 */}
        <Card className="ring-1 ring-border xl:col-span-2">
          <CardContent className="p-5">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{$('about.disclaimer.title')}</h3>
            </div>
            <ul className="mt-2 grid gap-1.5 text-xs leading-relaxed text-muted-foreground">
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
