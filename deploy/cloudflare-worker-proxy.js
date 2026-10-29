/**
 * fanqvan.com 反向代理（Cloudflare Workers）
 * ------------------------------------------------------------------
 * 结构（用户确认）：fanqvan.com 打开就是饭圈应用；官网介绍页在同域 /intro/。
 * 作用：地址栏保留 fanqvan.com，站点本体仍跑在 WorkBuddy 托管环境里（不搬家）。
 *
 * 用法（网页版，无需命令行）：
 *   1. 域名托管到 Cloudflare（免费套餐即可），加一条 DNS：类型 A、名称 @、
 *      内容 192.0.2.1、代理状态点亮橙色小云（占位，Worker 会接管）。
 *   2. Workers & Pages → 创建 Worker → 把本文件内容整体粘进去 → 部署。
 *   3. 该 Worker → 设置 → 域和路由 → 添加自定义域：fanqvan.com、www.fanqvan.com。
 *   4. 等 1~2 分钟，Cloudflare 自动签发证书，打开 https://fanqvan.com 即可。
 *      官网直接访问 https://fanqvan.com/intro/。
 *
 * 注意：ORIGIN 必须写平台线上域名，别带结尾斜杠。
 */

const ORIGIN_HOST = '8810a05ca2994d829f9c56a36bea7c58.app.workbuddy.host';
const ORIGIN = 'https://' + ORIGIN_HOST;
const WWW = 'www.fanqvan.com';   // www 统一跳到主域，避免两份登录态

export default {
  async fetch(request) {
    const inUrl = new URL(request.url);

    // www → 裸域（301）
    if (inUrl.hostname === WWW) {
      return Response.redirect('https://fanqvan.com' + inUrl.pathname + inUrl.search, 301);
    }

    const target = ORIGIN + inUrl.pathname + inUrl.search;

    // 复制请求：方法、头、body 全透传。Workers 里 Host 由 url 决定，不用手改。
    const init = {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    };
    // 让后端知道真实来源，方便以后看日志
    init.headers = new Headers(request.headers);
    init.headers.set('X-Forwarded-Host', inUrl.hostname);
    init.headers.set('X-Forwarded-Proto', 'https');
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) init.headers.set('X-Forwarded-For', ip);

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

    // 后端若返回指向平台域名的绝对跳转，改回自定义域，别把人甩到长链接上
    const loc = resp.headers.get('location');
    if (loc && loc.includes(ORIGIN_HOST)) {
      out.headers.set('location', loc.replace(ORIGIN, inUrl.origin));
    }

    // Set-Cookie 不能带 Domain 属性：后端没写 Domain 就别加，写了就剥掉，
    // 否则浏览器认为它属于 app.workbuddy.host，自定义域下收不到。
    const cookies = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : [];
    if (cookies.length) {
      out.headers.delete('set-cookie');
      for (const c of cookies) {
        out.headers.append('set-cookie', c.replace(/;\s*Domain=[^;]*/gi, ''));
      }
    }

    return out;
  }
};
