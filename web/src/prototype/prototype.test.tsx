import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PrototypeApp } from './index';

/**
 * `/proto` 布局原型的冒烟测试（本仓库测试环境是 node，没有 jsdom，所以走静态渲染）。
 *
 * 为什么值得钉：
 *   ① 原型是给人看排版的，一旦渲染抛错，整屏白——静态渲染能在 CI 里提前发现；
 *   ② `$()` 缺键时会**原样显示键名**，所以「markup 里不出现 proto.xxx」等价于
 *      "所有原型文案都已在 zh/en 里定义"，比人工核对 229 个键可靠；
 *   ③ 这个文件随原型一起删除（F6 清理阶段），不是长期测试。
 */
describe('/proto 原型', () => {
  const html = renderToStaticMarkup(createElement(PrototypeApp));

  it('渲染出外壳与默认屏（实例总览）', () => {
    expect(html).toContain('BlockNexus');
    expect(html).toContain('Agent 0.5.4');
    expect(html).toContain('survival');
  });

  it('没有任何未定义的文案键（缺键会原样渲染成 proto.xxx）', () => {
    expect(html).not.toMatch(/proto\.[a-zA-Z]+\.[a-zA-Z]+/);
  });

  it('状态栏挂着原型屏幕切换器', () => {
    expect(html).toContain('PROTO');
  });
});
