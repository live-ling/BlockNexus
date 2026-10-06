'use strict';
// app 级错误兜底中间件（单独成模块以便与 server.js 共用同一份实现、并被测试直接覆盖）。
//
// 为什么必须有它：
//   `express.json()` 是 **app 级**中间件，在任何 router 之前运行。
//   它抛出的解析错误**不会**进入 router 内部的错误处理器
//   （panel/api.js 里那个只对 router 内的错误生效）。
//   如果 app 级没有错误处理器，错误就落到 Express 内置默认处理器——
//   而 NODE_ENV 未设为 production（本项目从不设置）时，默认处理器会把
//   **完整堆栈**写进响应体，泄露面板安装的绝对路径与模块布局。
//   未认证请求发一个畸形 JSON body 即可触发。
//
// 设计取舍：
//   · 只按 **status** 归类，不把原始 message 回给客户端（它含内部路径）。
//   · 原始错误只写服务端日志，便于排查。
//   · 文案按 Accept-Language 本地化，与其他错误路径保持一致。

const { errorResponse, langOf } = require('./error-codes');

/**
 * Express 错误处理中间件（4 个形参是 Express 识别签名所必需的，勿"简化"）。
 * 必须注册在**所有** app 级中间件之后。
 */
// eslint-disable-next-line no-unused-vars -- next 是 Express 识别错误中间件的签名要求
function requestErrorHandler(err, req, res, next) {
  // 响应头已发出时无法再改状态码，只能交回 Express 收尾，否则会二次写头
  if (res.headersSent) return next(err);

  // body-parser 的错误自带 status：400 = JSON 解析失败，413 = 体积超限。
  // 其它来源的（不该走到这里的）一律 500，避免把内部错误伪装成客户端错误。
  const raw = Number(err && (err.status || err.statusCode)) || 0;
  const status = raw === 413 ? 413 : raw === 400 ? 400 : 500;
  const code =
    status === 413 ? 'request.body-too-large' : status === 400 ? 'request.body-invalid' : 'internal.error';

  console.error(`[request-error] ${req.method} ${req.path} -> ${status}`, (err && err.message) || err);

  const r = errorResponse(code, undefined, { status, lang: langOf(req) });
  res.status(r.status).json(r.body);
}

module.exports = { requestErrorHandler, langOf };
