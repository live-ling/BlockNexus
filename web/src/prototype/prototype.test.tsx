import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PrototypeApp } from './index';
import { ServersScreen } from './screens/servers';

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

  it('渲染出外壳与默认屏（实例卡片）', () => {
    expect(html).toContain('BlockNexus');
    expect(html).toContain('survival');
    expect(html).toContain('主服 · 长期档');
  });

  it('筛选默认隐藏，只在右边缘留一个抽屉入口', () => {
    expect(html).toContain('筛选');
    // 抽屉关着的时候，里面才有搜索框、状态筛选这些控件；页面里不该出现第二条搜索框
    expect(html.match(/placeholder="搜索实例、服务器或地址"/g) ?? []).toHaveLength(0);
  });

  it('没有任何未定义的文案键（缺键会原样渲染成 proto.xxx）', () => {
    expect(html).not.toMatch(/proto\.[a-zA-Z]+\.[a-zA-Z]+/);
  });

  it('页头挂着原型屏幕切换器', () => {
    expect(html).toContain('PROTO');
  });

  it('服务器卡片带 Java 版本', () => {
    const markup = renderToStaticMarkup(createElement(ServersScreen, { onScreen: () => {} }));
    expect(markup).toContain('Java 21');
    expect(markup).toContain('Java 17');
  });
});
