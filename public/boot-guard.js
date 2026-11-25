/* 前端崩溃上报 —— 必须比 app.js 先加载。
   为什么单独一个文件、不写在 app.js 开头：app.js 自己解析失败时整个文件都不会执行，
   那种「一打开就白屏」恰恰是最需要上报的情况。CSP 是 script-src 'self'，
   所以也不能写成 index.html 里的内联脚本，只能是这么一个小文件。

   三条硬规矩：
   1) 上报本身不许抛错（整段 try 包住，fetch 的 catch 吞掉）—— 监控代码不能自己制造故障。
   2) 同一个会话最多报 5 条、同一条消息只报一次 —— 死循环报错不能变成打服务器的循环。
   3) 只报「哪里错了」，不报用户数据（不发 cookie、不发表单内容、不发帖子文本）。 */
(function () {
  'use strict';
  var sent = 0;
  var seen = {};
  var MAX = 5;

  function send(kind, msg, stack) {
    try {
      if (sent >= MAX) return;
      msg = String(msg || '').slice(0, 300);
      if (!msg) return;
      var key = kind + '|' + msg.slice(0, 100);
      if (seen[key]) return;
      seen[key] = 1;
      sent++;

      var body = JSON.stringify({
        kind: kind,
        msg: msg,
        stack: String(stack || '').slice(0, 1200),
        url: String(location.href || '').slice(0, 200),
        ua: String(navigator.userAgent || '').slice(0, 200),
        /* 发版时改这一行：/ops 的报错列表靠它区分「是哪个版本在崩」。
           网页和 App 离线包用的是同一份文件，所以两边版本号天然一致。 */
        ver: '2.48.2',
        t: Date.now()
      });

      /* sendBeacon 优先：页面正在崩、或者用户马上要关页时，普通 fetch 会被中断，
         beacon 由浏览器接管发送。Blob 的 type 决定 Content-Type，
         服务端要求 application/json（不然会被 CSRF 第三层挡成 415）。 */
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon('/api/client-error', blob)) return;
      }
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* 上报失败就失败，绝不冒泡 */ }
  }

  /* 暴露给 app.js：业务代码捕获到的错误（比如某个接口返回了脏数据）可以带上下文主动报一条 */
  window.__fqReport = send;

  /* 捕获阶段（第三个参数 true）：图片/脚本加载失败这类事件不冒泡，
     只在捕获阶段能拿到。白屏十有八九是某个 script 没加载上。 */
  window.addEventListener('error', function (e) {
    if (!e) return;
    var t = e.target;
    if (t && t !== window && t.tagName) {
      /* 必须用 getAttribute 拿原始值：`<img src="">` 这种占位元素，
         浏览器会把 .src 读成当前页面地址，于是每次加载都报一条假的
         「img 加载失败 http://.../」—— 实测确实这么刷过一条。
         没有 src 的元素压根不算「加载失败」。 */
      var src = t.getAttribute('src') || t.getAttribute('href') || '';
      if (!src) return;
      send('asset', t.tagName.toLowerCase() + ' 加载失败 ' + String(src).slice(0, 160));
      return;
    }
    var err = e.error;
    send(
      'error',
      e.message || (err && err.message) || '未知错误',
      (err && err.stack) || (e.filename ? e.filename + ':' + e.lineno + ':' + e.colno : '')
    );
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var msg = (r && (r.message || r.msg)) || (typeof r === 'string' ? r : '未处理的异步错误');
    send('reject', msg, (r && r.stack) || '');
  });
})();
