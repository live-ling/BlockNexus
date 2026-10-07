'use strict';
// 邮件模板：把通知邮件排版成与面板一致的卡片样式（白卡 + 细描边 + 中性灰底），不再发纯文本。
//
// 兼容性取舍（邮件客户端对 CSS 的支持远弱于浏览器）：
//   - 一律用 <table> 布局 + 内联样式：Outlook / Gmail 都认，flex、grid、gap 一律不用；
//   - 配色取面板亮色主题（web/src/index.css 的 oklch 近似成 hex），暗色不做媒体查询——
//     各客户端 prefers-color-scheme 行为不一致，亮底卡片在暗色客户端里依然可读；
//   - 只外链一张 logo（PNG），图片被拦截时退化为纯文字品牌名，正文信息不受影响；
//   - 每封都同时提供 text 纯文本版本：既是图片被拦时的兜底，也给客户端生成摘要用。

const BRAND = 'BlockNexus';
const BRAND_SUB = 'Minecraft 服务器管理面板';
/** 项目 logo（PNG）；与 web/public/logo.png 同源，ico 版仅用于网站 favicon */
const LOGO_URL = 'https://img.liveling.top/i/2026/10/03/6ac098a6b2dd0.png';

// 面板亮色主题的近似 hex（oklch → sRGB）
const C = {
  page: '#f4f4f5', // --background 同级浅底，衬托白卡
  card: '#ffffff',
  border: '#e5e5e7', // --border
  fg: '#18181b', // --foreground
  muted: '#71717a', // --muted-foreground
  soft: '#fafafa', // --secondary / --muted
  primary: '#18181b', // --primary
  primaryFg: '#fafafa',
  danger: '#dc2626', // --destructive
  dangerSoft: '#fef2f2',
  ok: '#16a34a',
  okSoft: '#f0fdf4',
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** HTML 转义：正文里会插入服务器名、主机、时间等外部数据，必须转义后再进模板 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 邮件外框：浅灰底上的一张白卡，顶部为品牌头（logo + 名称），底部为脚注。
 * @param {object} o
 * @param {string} o.title     卡片主标题
 * @param {string} [o.preheader] 收件箱预览文字（隐藏区域，避免预览抓到模板碎屑）
 * @param {string} [o.badge]   标题上方的小标签，如「服务器离线」
 * @param {''|'danger'|'ok'} [o.badgeTone] 标签配色
 * @param {string} o.bodyHtml  卡片正文（由各具体模板拼好）
 * @param {string} [o.footer]  脚注，默认说明来源与忽略方式
 */
function layout({ title, preheader = '', badge = '', badgeTone = '', bodyHtml, footer }) {
  const toneBg = badgeTone === 'danger' ? C.dangerSoft : badgeTone === 'ok' ? C.okSoft : C.soft;
  const toneFg = badgeTone === 'danger' ? C.danger : badgeTone === 'ok' ? C.ok : C.muted;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${C.card};border:1px solid ${C.border};border-radius:14px;overflow:hidden;font-family:${FONT};">
        <!-- 品牌头：logo + 产品名，与登录卡片头部一致 -->
        <tr>
          <td style="padding:22px 32px;border-bottom:1px solid ${C.border};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:12px;">
                  <img src="${LOGO_URL}" width="40" height="40" alt="${esc(BRAND)}" style="display:block;width:40px;height:40px;border-radius:12px;border:1px solid ${C.border};" />
                </td>
                <td>
                  <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:${C.fg};">${esc(BRAND)}</div>
                  <div style="font-size:12px;color:${C.muted};padding-top:2px;">${esc(BRAND_SUB)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- 正文 -->
        <tr>
          <td style="padding:32px;">
            ${badge ? `<div style="display:inline-block;margin-bottom:14px;padding:4px 10px;border-radius:999px;background:${toneBg};color:${toneFg};font-size:12px;font-weight:600;">${esc(badge)}</div>` : ''}
            <h1 style="margin:0 0 12px;font-size:20px;line-height:1.4;font-weight:700;color:${C.fg};">${esc(title)}</h1>
            ${bodyHtml}
          </td>
        </tr>
        <!-- 脚注 -->
        <tr>
          <td style="padding:18px 32px;border-top:1px solid ${C.border};background:${C.soft};font-size:12px;line-height:1.7;color:${C.muted};">
            ${esc(footer || '这是一封由 BlockNexus 面板自动发送的系统邮件，请勿直接回复。')}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * 正文段落。
 *
 * ⚠ text **按纯文本转义**。本文件里其它插值点（kv 的值、页脚、品牌名）都走了 esc()，
 *   只有 p() 漏了。目前所有调用方传的都是静态文案，所以现在没有可注入点——
 *   但下一个「把服务器名 / 玩家名 / 错误信息塞进正文」的调用方会直接得到 HTML 注入，
 *   而邮件是发到管理员邮箱的，注入进去的标记会被邮件客户端渲染。
 *   默认转义让**正确用法成为默认**；确实要内嵌标记时用 pHtml()（并自行保证内容可信）。
 */
function p(text, style = '') {
  return `<p style="margin:0 0 12px;font-size:14px;line-height:1.75;color:${C.fg};${style}">${esc(text)}</p>`;
}

/**
 * 允许内嵌 HTML 标记的正文段落。
 * **只在内容可信（代码内写死的标记 + 已转义的变量）时使用**：
 * 传进来的 html 不会被转义。变量部分请自己包 esc()。
 */
function pHtml(html, style = '') {
  return `<p style="margin:0 0 12px;font-size:14px;line-height:1.75;color:${C.fg};${style}">${html}</p>`;
}

/** 键值信息行：左侧标签、右侧内容，对应面板里的字段行 */
function kv(rows) {
  const trs = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:7px 0;font-size:13px;color:${C.muted};white-space:nowrap;padding-right:16px;">${esc(k)}</td>` +
        `<td style="padding:7px 0;font-size:13px;color:${C.fg};word-break:break-all;">${esc(v)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 16px;border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};">${trs}</table>`;
}

/**
 * 6 位验证码：六格分列，对应登录页 OTP 输入框（每格 h-12 w-11）。
 * 数字同时以纯文本形式保留在下方，图片/样式被拦时仍能读到。
 */
function codeBlock(code) {
  const digits = String(code).split('');
  const cells = digits
    .map(
      (d) =>
        `<td style="padding:0 3px;"><div style="width:44px;height:52px;line-height:52px;text-align:center;background:${C.soft};border:1px solid ${C.border};border-radius:10px;font-family:${MONO};font-size:26px;font-weight:700;color:${C.fg};">${esc(d)}</div></td>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px;">
      <tr>${cells}</tr>
    </table>
    <p style="margin:0;font-size:13px;color:${C.muted};font-family:${MONO};letter-spacing:2px;">${esc(code)}</p>`;
}

/** 找回密码验证码邮件 */
function resetCodeMail({ code, minutes = 15 }) {
  return {
    text:
      `有人（可能是你）请求重置 ${BRAND} 面板密码。${minutes} 分钟内有效，在面板的验证码框里输入下面这 6 位数字：\n\n` +
      `${code}\n\n` +
      `如非本人操作，请忽略本邮件。`,
    html: layout({
      title: '重置面板密码',
      preheader: `验证码 ${code}，${minutes} 分钟内有效`,
      bodyHtml:
        p('有人（可能是你）请求重置 BlockNexus 面板密码。在面板的验证码输入框中填入下面这 6 位数字即可继续。') +
        codeBlock(code) +
        pHtml(`验证码 <strong>${minutes} 分钟</strong>内有效，用后即失效。`, `color:${C.muted};font-size:13px;`) +
        p(
          '如果这不是你本人操作，直接忽略本邮件即可——在验证码失效前，任何人都无法改动你的密码。',
          `color:${C.muted};font-size:13px;margin-bottom:0;`,
        ),
      footer: '本邮件由 BlockNexus 面板自动发送，请勿直接回复。非本人操作请忽略。',
    }),
  };
}

/** 服务器离线通知 */
function offlineMail({ name, host, time }) {
  return {
    text: `服务器「${name}」（${host}）的 Agent 连接已断开。\n时间：${time}\n\n面板会自动持续重连。`,
    html: layout({
      title: `服务器离线：${name}`,
      preheader: `服务器「${name}」的 Agent 连接已断开`,
      badge: '服务器离线',
      badgeTone: 'danger',
      bodyHtml:
        p('该服务器与面板之间的 Agent 连接已断开，当前无法执行启停、备份等远程操作。') +
        kv([
          ['服务器', name],
          ['主机', host],
          ['发生时间', time],
        ]) +
        p('面板会自动持续重连，恢复上线后（若已开启恢复通知）会再发一封邮件。', `color:${C.muted};font-size:13px;margin-bottom:0;`),
      footer: '你收到这封邮件是因为在面板「通知设置」中开启了服务器离线通知，可随时在面板中关闭。',
    }),
  };
}

/** 服务器恢复通知 */
function recoveryMail({ name, time }) {
  return {
    text: `服务器「${name}」的 Agent 已重新上线。\n时间：${time}`,
    html: layout({
      title: `服务器已恢复：${name}`,
      preheader: `服务器「${name}」已重新上线`,
      badge: '已恢复',
      badgeTone: 'ok',
      bodyHtml:
        p('该服务器的 Agent 已重新连上面板，远程操作恢复正常。') +
        kv([
          ['服务器', name],
          ['恢复时间', time],
        ]),
      footer: '你收到这封邮件是因为在面板「通知设置」中开启了恢复通知，可随时在面板中关闭。',
    }),
  };
}

/** SMTP 连通性测试邮件 */
function smtpTestMail() {
  return {
    text: '这是一封来自 BlockNexus 面板的测试邮件。收到即说明 SMTP 配置正确，离线通知与找回密码邮件可正常送达。',
    html: layout({
      title: 'SMTP 配置正确',
      preheader: '收到即说明 SMTP 配置正确',
      badge: '测试邮件',
      badgeTone: 'ok',
      bodyHtml:
        p('收到这封邮件，说明 SMTP 配置正确，以下邮件都能正常送达：') +
        `<ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.9;color:${C.fg};">
           <li>服务器离线 / 恢复通知</li>
           <li>找回密码的邮箱验证码</li>
         </ul>` +
        p('若样式显示不完整，属邮件客户端限制，内容以纯文本部分为准。', `color:${C.muted};font-size:13px;margin-bottom:0;`),
      footer: '本邮件由 BlockNexus 面板「保存并发送测试邮件」触发。',
    }),
  };
}

module.exports = {
  BRAND,
  LOGO_URL,
  esc,
  layout,
  resetCodeMail,
  offlineMail,
  recoveryMail,
  smtpTestMail,
};
