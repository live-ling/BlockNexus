'use strict';
// BlockNexus Agent — Agent 事件出口（sendEvent 注入点）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。
//
// 原单文件里 sendEvent 用 let 声明、由 Agent 构造函数重新赋值；拆分后改为可变 handler，
// 各功能模块继续直接调用 sendEvent(...)，调用点零改动。

let handler = () => {};

/** 向面板推送事件（未接管前为空操作） */
const sendEvent = (event, data) => handler(event, data);

/** Agent 启动时接管事件出口（见 src/agent.js 构造函数） */
function setHandler(fn) {
  handler = typeof fn === 'function' ? fn : () => {};
}

module.exports = { sendEvent, setHandler };
