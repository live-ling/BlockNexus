// AI 回复用的轻量 Markdown 渲染：只覆盖模型实际会输出的语法子集
// （标题 / 粗斜体 / 行内代码 / 代码块 / 列表 / 引用 / 表格 / 链接 / 分隔线）
// 不引入 markdown 库：流式场景下增量重解析开销大，且我们只需要固定几种结构。
// 代码块复用 beUI 的 CodeBlock（shiki 已在项目里，主题与终端风格一致）。

import { Fragment, memo, type ReactNode } from 'react';
import { CodeBlock } from '@/components/agents/code-block';
import { cn } from '@/lib/utils';

/** 把行内语法（**粗体** / *斜体* / `代码` / [文字](链接)）解析成节点 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyPrefix}-i${i++}`;
    if (m[2] !== undefined) {
      out.push(
        <strong key={k} className="font-semibold text-foreground">
          {m[2]}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      out.push(<em key={k}>{m[4]}</em>);
    } else if (m[5] !== undefined) {
      out.push(
        <code
          key={k}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {m[5]}
        </code>,
      );
    } else if (m[6] !== undefined) {
      // 只放行 http(s)，避免 javascript: 之类的协议被渲染成可点链接
      const safe = /^https?:\/\//i.test(m[7] || '');
      out.push(
        safe ? (
          <a
            key={k}
            href={m[7]}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {m[6]}
          </a>
        ) : (
          <span key={k}>{m[6]}</span>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 列表项前缀：- / * / 数字. / 数字) */
const LI_RE = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

const CodeFence = memo(function CodeFence({
  code,
  lang,
  streaming = false,
}: {
  code: string;
  lang: string;
  streaming?: boolean;
}) {
  // CodeBlock 只认这几种语言，其余（如 log/properties/java）回落到 text
  const known = ['bash', 'diff', 'json', 'text', 'tsx', 'typescript'] as const;
  const language = (known as readonly string[]).includes(lang)
    ? (lang as (typeof known)[number])
    : 'text';
  return (
    <CodeBlock
      code={code}
      language={language}
      // 流未结束时用 streaming，让代码块跟随输出自动滚动；完成后转 complete 停止滚动
      status={streaming ? 'streaming' : 'complete'}
      maxHeight={360}
      className="my-2"
    />
  );
});

export function Markdown({
  content,
  className,
  streaming = false,
}: {
  content: string;
  className?: string;
  /** 内容仍在增长中（流式输出未结束） */
  streaming?: boolean;
}) {
  const lines = content.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块（``` 包裹；语言可为空）
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || 'text';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾的 ```
      blocks.push(
        <CodeFence key={`b${key++}`} code={buf.join('\n')} lang={lang} streaming={streaming} />,
      );
      continue;
    }

    // 分隔线
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} className="my-3 border-border" />);
      i++;
      continue;
    }

    // 标题
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const cls = ['text-base', 'text-[0.95rem]', 'text-sm', 'text-sm', 'text-xs', 'text-xs'][
        Math.min(level - 1, 5)
      ];
      blocks.push(
        <p key={`b${key++}`} className={cn('mt-3 font-semibold text-foreground first:mt-0', cls)}>
          {renderInline(heading[2], `h${key}`)}
        </p>,
      );
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={`b${key++}`}
          className="my-2 border-l-2 border-border pl-3 text-muted-foreground"
        >
          {renderInline(buf.join(' '), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // 表格（首行 + |---|---| 分隔行）
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      const split = (s: string) =>
        s
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = split(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(split(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`b${key++}`} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {head.map((h, hi) => (
                  <th
                    key={hi}
                    className="border border-border bg-muted/50 px-2 py-1 font-semibold text-foreground"
                  >
                    {renderInline(h, `th${key}-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className="border border-border px-2 py-1 align-top">
                      {renderInline(c, `td${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 列表（连续的同类型项）
    const li = line.match(LI_RE);
    if (li) {
      const ordered = li[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LI_RE);
        if (!m) break;
        const isOrdered = m[2] !== undefined;
        if (isOrdered !== ordered) break;
        items.push(m[3]);
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List
          key={`b${key++}`}
          className={cn(
            'my-1.5 space-y-1 pl-5',
            ordered ? 'list-decimal' : 'list-disc',
            'marker:text-muted-foreground',
          )}
        >
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `li${key}-${ii}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    // 空行分段
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落：合并到下一个空行 / 块级开始
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*#{1,6}\s/.test(lines[i]) &&
      !LI_RE.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) {
      blocks.push(
        <p key={`b${key++}`} className="my-1.5 first:mt-0 last:mb-0">
          {renderInline(buf.join('\n'), `p${key}`)}
        </p>,
      );
    } else {
      i++; // 兜底防死循环
    }
  }

  return <div className={cn('text-sm leading-6 text-foreground', className)}>{blocks.map((b, bi) => <Fragment key={bi}>{b}</Fragment>)}</div>;
}
