/**
 * 饭圈 反向代理（Cloudflare Workers）
 * ------------------------------------------------------------------
 * 作用：把站点本体仍跑在 WorkBuddy 托管环境里（不搬家），但所有流量先走
 *       Cloudflare 的全球边缘网络。两个收益：
 *         1) 用户连到就近的 Cloudflare 节点（快且稳），不再直连那条偶发抖动的平台回源链路；
 *         2) 平台上 CDN 从不缓存我们的静态资源（每次都回源），这里用 cf 缓存选项把
 *            app.js / style.css / assets/* 缓存到 Cloudflare 边缘，回源次数骤降。
 *
 * 两种用法（都不用买域名）：
 *   A. 免费 workers.dev 子域（推荐先试）：Workers 部署后自动得到 https://<名字>.workers.dev，
 *      直接把这个地址发给用户用即可，零成本。
 *   B. 自定义域 fanqvan.com：按下面注释的 DNS + 路由步骤绑定（需把域名托管到 Cloudflare）。
 *
 * 用法（网页版，无需命令行）：
 *   1. 注册 Cloudflare（免费），进入 Workers & Pages → 创建 Worker → 把本文件内容整体粘进去 → 部署。
 *   2. 部署后会得到 <名字>.workers.dev 地址，打开即可。要自定义域再走下面的步骤。
 *   3.（自定义域才做）域名托管到 Cloudflare，加 DNS：类型 A、名称 @、内容 192.0.2.1、橙色云点亮；
 *      然后 Worker → 设置 → 域和路由 → 添加自定义域 fanqvan.com、www.fanqvan.com；等 1~2 分钟证书签发。
 *
 * 注意：ORIGIN 必须写平台线上域名，别带结尾斜杠。
 */

const ORIGIN_HOST = '8810a05ca2994d829f9c56a36bea7c58.app.workbuddy.host';
const ORIGIN = 'https://' + ORIGIN_HOST;
const WWW = 'www.fanqvan.com';   // 仅自定义域模式用：www 统一跳裸域，避免两份登录态

// 这些路径是静态资源，可以让 Cloudflare 边缘缓存一整天。
// 带了 ?v= 版本号，版本一变就是新缓存键，天然失效；旧版本仍可被老用户命中。
const STATIC_RE = /^\/(assets\/|app\.js|style\.css|favicon\.ico|robots\.txt|intro\/)/;

export default {
  async fetch(request) {
    const inUrl = new URL(request.url);

    // www → 裸域（仅自定义域模式生效；workers.dev 下 hostname 不匹配，自动跳过）
    if (inUrl.hostname === WWW) {
      return Response.redirect('https://fanqvan.com' + inUrl.pathname + inUrl.search, 301);
    }

    const target = ORIGIN + inUrl.pathname + inUrl.search;

    // 复制请求：方法、头、body 全透传。Workers 里 Host 由 url 决定，不用手改。
    const headers = new Headers(request.headers);
    // 让后端知道真实来源与真实客户端 IP，方便以后看日志、做安全判定
    headers.set('X-Forwarded-Host', inUrl.hostname);
    headers.set('X-Forwarded-Proto', 'https');
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) headers.set('X-Forwarded-For', ip);

    const init = {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    };

    // 静态资源请求：交给 Cloudflare 边缘缓存（cacheEverything + 1 天 TTL）。
    // 动态请求（HTML、/api/*）不加缓存，保证版本号与数据实时。
    if (request.method === 'GET' && STATIC_RE.test(inUrl.pathname)) {
      init.cf = { cacheTtl: 86400, cacheEverything: true };
    }

    let resp;
    try {
      resp = await fetch(target, init);
    } catch (e) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>饭圈</title>' +
        '<div style="font:16px/1.9 system-ui;padding:15vh 22px;text-align:center;color:#3a2b21">' +
        '<b>饭圈正在路上</b><br>稍等几秒刷新看看</div>',
        { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }

    const out = new Response(resp.body, resp);

    // 后端若返回指向平台域名的绝对跳转，改回当前域，别把人甩到长链接上
    const loc = resp.headers.get('location');
    if (loc && loc.includes(ORIGIN_HOST)) {
      out.headers.set('location', loc.replace(ORIGIN, inUrl.origin));
    }

    // Set-Cookie 不能带 Domain 属性：后端没写 Domain 就别加，写了就剥掉，
    // 否则浏览器认为它属于 app.workbuddy.host，自定义域 / workers.dev 下收不到。
    const cookies = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : [];
    if (cookies.length) {
      out.headers.delete('set-cookie');
      for (const c of cookies) {
        out.headers.append('set-cookie', c.replace(/;\s*Domain=[^;]*/gi, ''));
      }
    }

    // 给静态资源补一层标准缓存头（双保险，浏览器也跟着缓存），HTML/API 保持 no-cache
    if (STATIC_RE.test(inUrl.pathname)) {
      out.headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    }

    return out;
  }
};
