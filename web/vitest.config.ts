import path from 'node:path'
import { defineConfig } from 'vitest/config'

// 前端单元测试配置（独立于 vite.config.ts，保持构建配置不被测试选项污染）
//
// 只用 node 环境：当前测试对象是纯逻辑模块（properties.ts / plugin-config.ts / upload.ts /
// 设置仓库等），不需要 DOM。等到需要测 React 组件时再引入 jsdom，并按需补 setupFiles。
//
// ⚠ alias 与 vite.config.ts 的 resolve.alias 保持一致；若改动构建别名，这里要同步。
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // 面板前端的测试都是纯函数，不做全局注入
    globals: false,
  },
})
