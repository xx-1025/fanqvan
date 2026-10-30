/* =========================================================
   饭圈 · 安全控制台（前端）
   ---------------------------------------------------------
   只跟 /api/ops/* 说话，所有判断都在服务端。这里做三件事：
     1) 把「谁在干什么」排成能一眼扫过去的表；
     2) 把可疑度高的地址拎出来（可疑的人）；
     3) 一键挡住 / 放进来。
   ---------------------------------------------------------
   【文案原则】这一页是给不搞技术的人看的。
   不出现行为分、事件循环、UA、状态码、payload 这类词；
   能说人话就说人话，原始数值放 title / 详情里备查。
   ========================================================= */

(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hhmmss(t) {
    var d = new Date(t);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function ago(t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }

  function left(until) {
    var s = Math.round((until - Date.now()) / 1000);
    if (s <= 0) return '马上放行';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟后放行';
    if (s < 86400) return Math.round(s / 3600) + ' 小时后放行';
    return Math.round(s / 86400) + ' 天后放行';
  }

  /* ---------- 把技术值翻成人话 ---------- */

  // GET → 看、POST → 提交……普通人不关心「方法」，关心「在干什么」
  function actOf(m) {
    var x = String(m || '').toUpperCase();
    if (x === 'GET' || x === 'HEAD') return '看';
    if (x === 'POST') return '提交';
    if (x === 'PUT' || x === 'PATCH') return '修改';
    if (x === 'DELETE') return '删除';
    if (x === 'OPTIONS') return '试探';
    return x || '–';
  }

  // 200 / 404 / 403 这些数字，换成「成没成」
  function resOf(c) {
    var n = Number(c);
    if (n < 300) return '正常';
    if (n < 400) return '跳转';
    if (n === 401) return '要登录';
    if (n === 403) return '不让看';
    if (n === 404) return '没这页';
    if (n === 405) return '方式不对';
    if (n === 413) return '太大了';
    if (n === 415) return '格式不对';
    if (n === 429) return '太频繁';
    if (n < 500) return '没成';
    return '出错了';
  }

  function resCls(c) {
    var n = Number(c);
    if (n >= 500 || n === 403) return 'c5';
    if (n === 404 || n === 429 || n === 415) return 'c4';
    if (n === 401 || n === 405) return 'c3';
    return 'c2';
  }

  // security.log 里的 kind 是英文代号，全部翻成中文
  var KIND = {
    ip_block: '挡住了一个地址',
    ip_unblock: '放行了一个地址',
    enum_suspect: '在挨个翻别人的主页',
    probe_suspect: '在试探这个站（像在找漏洞）',
    csrf_block: '从别的网站冒充本站提交请求',
    csrf_samesite: '从别的网站跳过来，来源存疑但放过了',
    csrf_unverified: '来源查不清，先放过了',
    ctype_block: '用错误格式提交，被拒',
    captcha_fail: '验证码填错了',
    login_fail: '登录失败（密码或账号不对）',
    login_locked: '输错太多次，账号暂时锁了',
    login_banned: '被停用的账号在尝试登录',
    login_busy: '登录的人太多，排队中',
    login_weakpw: '这个账号还在用初始或太简单的密码',
    password_change: '改了密码',
    password_fail: '改密码时原密码填错了',
    pw_reset_by_config: '按配置文件重置了某个账号的密码',
    register: '新注册了一个账号',
    review: '审核了一条内容',
    upload_fake: '上传的图片是假的（文件内容对不上）',
    upload_full: '上传额度用满了',
    ops_denied: '有人想打开控制台但没权限'
  };

  var ADMIN_OP = {
    ban: '管理员停用了一个账号',
    unban: '管理员恢复了一个账号',
    role: '管理员改了某人的权限',
    delete: '管理员删掉了一个账号'
  };

  function kindOf(e) {
    var k = String(e.kind || '');
    if (k.indexOf('admin_user_') === 0) return ADMIN_OP[k.slice(11)] || '管理员改动了某个账号';
    if (k === 'ip_block') return e.auto ? '可疑度到线，系统自动挡住了' : '挡住了一个地址';
    return KIND[k] || '一条安全记录';
  }

  // 这些是「需要看一眼」的，标红
  var HI = ['ip_block', 'enum_suspect', 'probe_suspect', 'csrf_block', 'upload_fake', 'ops_denied'];

  // UA 是一长串英文，普通人看不出所以然，翻成「iPhone」「脚本程序」这种
  function uaWords(ua) {
    var s = String(ua || '');
    if (!s) return '（没说）';
    var low = s.toLowerCase();
    var m = low.match(/python-requests|python-urllib|curl|wget|scrapy|go-http-client|okhttp|java\/|libwww|apache-httpclient|axios|node-fetch|undici|headlesschrome|phantomjs|selenium/);
    if (m) return '脚本程序（' + m[0].replace(/\/$/, '') + '）';
    if (/iphone/.test(low)) return 'iPhone';
    if (/ipad/.test(low)) return 'iPad';
    if (/android/.test(low)) return '安卓手机';
    if (/windows/.test(low)) return 'Windows 电脑';
    if (/macintosh|mac os x/.test(low)) return 'Mac 电脑';
    if (/linux/.test(low)) return 'Linux 电脑';
    if (/bot|spider|crawler/.test(low)) return '爬虫';
    return s.slice(0, 16);
  }

  var state = {
    over: null,
    rows: [],          // 实时流量（最多留 260 条）
    seq: 0,
    paused: false,
    filter: '',
    blocked: Object.create(null)
  };

  /* ---------------- 请求 ---------------- */

  function get(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) {
            var e = new Error(d.error || ('HTTP ' + r.status));
            e.status = r.status;
            throw e;
          }
          return d;
        });
      });
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) {
          var e = new Error(d.error || ('HTTP ' + r.status));
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }

  var denied = false;
  function deny(msg) {
    if (denied) return;
    denied = true;
    $('#op-deny-msg').textContent = msg || '只有管理员能进安全控制台。';
    $('#op-deny').hidden = false;
  }

  /* ---------------- 顶部一句话结论 ---------------- */

  function paintVerdict(o) {
    var list = o.threats || [];
    var hot = 0, warm = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].score >= 60) hot++;
      else if (list[i].score >= 30) warm++;
    }
    var t, s, cls;

    if (o.lag > 400) {
      t = '服务器现在很吃力'; s = '访问可能会卡，先看看下面有没有人在猛刷。'; cls = 'bad';
    } else if (hot > 0) {
      t = '已经挡住 ' + hot + ' 个捣乱的地址';
      s = '它们刚才在爬你的站或找漏洞，系统自己处理了，你不用做什么。';
      cls = 'ok';
    } else if (warm > 0) {
      t = '有 ' + warm + ' 个地址在可疑地翻你的站';
      s = '还不算过分，右手边可以看是谁；拿不准就先放着观察。';
      cls = 'warn';
    } else if (o.blocked > 0) {
      t = '已经挡住 ' + o.blocked + ' 个地址';
      s = '暂时没有新的可疑行为。';
      cls = 'ok';
    } else {
      t = '一切正常';
      s = '现在没发现有人在爬站、扫后台或试探漏洞。';
      cls = 'ok';
    }

    var band = $('#op-v-t');
    band.textContent = t;
    band.className = cls;
    $('#op-v-s').textContent = s;
  }

  /* ---------------- 顶栏 ---------------- */

  function paintPills(o) {
    $('#p-rate').textContent = o.rate + ' 次';
    $('#p-inflight').textContent = o.inflight + ' / 200';
    $('#p-blocked').textContent = o.blocked + ' 个';

    var lagWord = o.lag > 400 ? '很吃力' : o.lag > 150 ? '有点忙' : '顺畅';
    $('#p-lag').textContent = lagWord;

    $('#p-lag').parentNode.title = '服务器延迟 ' + o.lag + ' ms，超过 300 会开始变卡';
    $('#p-rate').parentNode.title = '最近一分钟共 ' + o.rate + ' 次访问';
    $('#p-inflight').parentNode.title = '正在处理 ' + o.inflight + ' 个，满 200 开始排队';
    $('#p-blocked').parentNode.title = '当前挡住 ' + o.blocked + ' 个地址';

    $('#p-rate').parentNode.className = 'pill' + (o.rate > 300 ? ' hot' : o.rate > 120 ? ' warm' : '');
    $('#p-lag').parentNode.className = 'pill' + (o.lag > 300 ? ' hot' : o.lag > 120 ? ' warm' : '');
    $('#p-blocked').parentNode.className = 'pill' + (o.blocked > 0 ? ' hot' : '');
  }

  /* ---------------- 谁在访问 ---------------- */

  function paintFeed() {
    var box = $('#op-feed');
    var q = state.filter.trim();
    var rows = state.rows;
    if (q) rows = rows.filter(function (r) { return r.ip.indexOf(q) >= 0 || r.p.indexOf(q) >= 0; });

    if (!rows.length) {
      box.innerHTML = '<div class="op-empty">' +
        (q ? '这个地址最近没有动静，换个地址试试。'
           : '暂时没人在逛，等一会儿…（有人在打开页面时，这里就会一行行冒出来）') +
        '</div>';
      return;
    }

    var out = [];
    for (var i = rows.length - 1; i >= 0 && out.length < 120; i--) {
      var r = rows[i];
      var isBlocked = !!state.blocked[r.ip] || (r.c === 403 && r.ms === 0);
      out.push('<div class="op-row">' +
        '<span>' + hhmmss(r.t) + '</span>' +
        '<span class="c-ip' + (isBlocked ? ' c-blocked' : '') + '" title="' + esc(r.ip) + '">' + esc(r.ip) + '</span>' +
        '<span title="原始方法：' + esc(r.m) + '">' + esc(actOf(r.m)) + '</span>' +
        '<span class="c-path" title="' + esc(r.p) + '">' + esc(r.p) + '</span>' +
        '<span class="' + resCls(r.c) + '" title="原始状态码：' + r.c + '">' + resOf(r.c) + '</span>' +
        '<span>' + (r.ms ? (r.ms >= 1000 ? (r.ms / 1000).toFixed(1) + 's' : r.ms + 'ms') : '–') + '</span>' +
        '<span class="c-act"><button class="op-btn danger mini" data-block="' + esc(r.ip) + '" title="挡住这个地址 1 小时">挡住</button></span>' +
        '</div>');
    }
    box.innerHTML = out.join('');
  }

  /* ---------------- 可疑的人 ---------------- */

  function tagsOf(t) {
    var tags = [];
    if (t.ids >= 10) tags.push(['bad', '挨个翻了 ' + t.ids + ' 个人的主页']);
    if (t.qs >= 8) tags.push(['bad', '换了 ' + t.qs + ' 个搜索词']);
    if (t.scan > 0) tags.push(['bad', '在找后台入口 ' + t.scan + ' 次']);
    if (t.s404 >= 15) tags.push(['warn', '点了 ' + t.s404 + ' 次不存在的页面']);
    if (t.s403 >= 15) tags.push(['warn', '试了 ' + t.s403 + ' 次不该看的东西']);
    if (t.s401 >= 15) tags.push(['warn', t.s401 + ' 次没登录就去点']);
    if (t.s429 > 0) tags.push(['warn', '被限流 ' + t.s429 + ' 次']);
    if (t.bot) tags.push(['info', '不像真人在用浏览器']);
    if (t.pids >= 40) tags.push(['warn', '一口气看了 ' + t.pids + ' 篇内容']);
    if (t.n >= 200) tags.push(['info', '一分钟 ' + t.n + ' 次']);
    if (!tags.length) tags.push(['info', '只是来得勤，' + t.n + ' 次']);
    return tags;
  }

  function scoreWords(score) {
    if (score >= 60) return '该挡住';
    if (score >= 30) return '有点可疑';
    return '还算正常';
  }

  function paintThreats(list) {
    var box = $('#op-threats');
    if (!list || !list.length) {
      box.innerHTML = '<div class="op-empty">没有可疑的人。<br>有人开始挨个翻主页或在找后台入口时，会出现在这里。</div>';
      return;
    }
    box.innerHTML = list.map(function (t) {
      var cls = t.score >= 60 ? 'hot' : t.score >= 30 ? 'warm' : '';
      return '<div class="th ' + cls + '" data-ip="' + esc(t.ip) + '" title="点开看它都干了什么">' +
        '<div class="th-top"><span class="th-ip">' + esc(t.ip) + '</span>' +
        '<span class="th-verdict">' + esc(scoreWords(t.score)) + '</span>' +
        '<span class="th-score" title="可疑度，满 60 分系统自动挡住">' + t.score + '</span></div>' +
        '<div class="th-tags">' + tagsOf(t).map(function (x) {
          return '<span class="tag ' + x[0] + '">' + esc(x[1]) + '</span>';
        }).join('') + '</div>' +
        '<div class="th-ua" title="它自己报的身份：' + esc(t.ua || '无') + '">' + esc(uaWords(t.ua)) + '</div>' +
        '</div>';
    }).join('');
  }

  /* ---------------- 已经挡住的地址 ---------------- */

  function paintBlocks(list) {
    var box = $('#op-blocks');
    state.blocked = Object.create(null);
    (list || []).forEach(function (b) { state.blocked[b.ip] = true; });

    $('#op-block-sub').textContent = (list || []).length ? (list.length + ' 个') : '';
    if (!list || !list.length) {
      box.innerHTML = '<div class="op-empty">现在没挡着谁。</div>';
      return;
    }
    box.innerHTML = list.map(function (b) {
      return '<div class="bl">' +
        '<span class="bl-badge' + (b.auto ? '' : ' man') + '" title="' + (b.auto ? '可疑度到线，系统自己挡的' : '你手动挡的') + '">' +
          (b.auto ? '系统挡的' : '你挡的') + '</span>' +
        '<span class="bl-ip" title="' + esc(b.ip) + '">' + esc(b.ip) + '</span>' +
        (b.hits ? '<span class="bl-meta">挡了 ' + b.hits + ' 次</span>' : '') +
        '<span class="bl-meta">' + left(b.until) + '</span>' +
        '<button class="op-btn ghost mini" data-unblock="' + esc(b.ip) + '">放进来</button>' +
        '</div>';
    }).join('');
  }

  /* ---------------- 发生过什么 ---------------- */

  function extraOf(e) {
    var out = [];
    if (e.username) out.push(e.username);
    if (e.path) out.push(e.path);
    if (e.ids > 0) out.push('翻了 ' + e.ids + ' 个人的主页');
    if (e.q > 0) out.push('换了 ' + e.q + ' 个搜索词');
    if (e.score > 0) out.push('可疑度 ' + e.score);
    if (e.min) out.push('挡 ' + e.min + ' 分钟');
    if (e.auto) out.push('系统自动');
    if (e.reason) out.push(e.reason);
    if (e.from && !e.path) out.push('来自 ' + e.from);
    return out;
  }

  function paintEvents(list) {
    var box = $('#op-events');
    if (!list || !list.length) {
      box.innerHTML = '<div class="op-empty">还没有发生什么特别的事。</div>';
      return;
    }
    var rows = list.slice(-60).reverse();
    $('#op-ev-sub').textContent = '最近 ' + rows.length + ' 条';
    box.innerHTML = rows.map(function (e) {
      var hi = HI.indexOf(e.kind) >= 0;
      return '<div class="ev' + (hi ? ' hi' : '') + '">' +
        '<span>' + (e.t ? hhmmss(Date.parse(e.t)) : '') + '</span>' +
        '<span class="ev-ip" title="' + esc(e.ip || '') + '">' + esc(e.ip || '–') + '</span>' +
        '<span class="ev-x"><b>' + esc(kindOf(e)) + '</b> ' + esc(extraOf(e).join(' · ')) + '</span>' +
        '</div>';
    }).join('');
  }

  /* ---------------- 详情弹层 ---------------- */

  function closeModal() {
    $('#op-modal').hidden = true;
    $('#op-modal-box').innerHTML = '';
  }

  function openIp(ip) {
    $('#op-modal').hidden = false;
    $('#op-modal-box').innerHTML = '<h3>' + esc(ip) + '</h3><div class="m-sub">正在读取…</div>';

    get('/api/ops/ip?ip=' + encodeURIComponent(ip)).then(function (d) {
      var w = d.watch || {};
      var kv = [
        ['可疑度', (w.score || 0) + ' 分（满 60 自动挡住）' + (w.peak ? '，最高到过 ' + w.peak : '')],
        ['这一分钟', (w.n || 0) + ' 次访问']
      ];
      // 值为 0 的项不显示：一屏全写着「0 个」反而看不清重点
      if (w.ids > 0) kv.push(['翻过几个人的主页', w.ids + ' 个']);
      if (w.qs > 0) kv.push(['换过几个搜索词', w.qs + ' 个']);
      if (w.pids > 0) kv.push(['看了几篇内容', w.pids + ' 篇']);
      if ((w.s404 || 0) + (w.s403 || 0) + (w.s401 || 0) + (w.s429 || 0) > 0) {
        kv.push(['被拒的情况', '没这页 ' + (w.s404 || 0) + ' 次 · 不让看 ' + (w.s403 || 0) +
          ' 次 · 没登录 ' + (w.s401 || 0) + ' 次 · 太频繁 ' + (w.s429 || 0) + ' 次']);
      }
      if (w.scan > 0) kv.push(['找后台入口', w.scan + ' 次']);

      var who = uaWords(w.ua);
      if (w.bot) who += '，但一看就是程序，不是人在点';
      else if (w.scan > 0 || (w.s404 || 0) >= 10) who += '（不过干的事不像真人）';
      kv.push(['它自称是什么设备', who]);

      kv.push(['第一次出现', w.first ? ago(w.first) : '–']);
      kv.push(['最近一次动手', w.last ? ago(w.last) : '–']);
      kv.push(['会不会被自动挡', d.trusted ? '不会（在你放心的名单里）' : '会（可疑度到 60 就挡）']);

      var html = '<h3>' + esc(ip) + '</h3>' +
        '<div class="m-sub">' + (d.trusted ? '这个地址在你放心的名单里，系统不会自动挡它' : '它最近都干了什么') + '</div>' +
        '<div class="kv">' + kv.map(function (x) {
          return '<i>' + x[0] + '</i><span>' + esc(x[1]) + '</span>';
        }).join('') + '</div>';

      if (w.paths && w.paths.length) {
        html += '<div class="m-sub" style="margin:4px 0 6px">最近点开过</div><div class="m-paths">' +
          w.paths.map(function (p) { return '<div>' + esc(p) + '</div>'; }).join('') + '</div>';
      }

      if (d.events && d.events.length) {
        html += '<div class="m-sub" style="margin:14px 0 6px">最近 ' + d.events.length + ' 次访问</div>' +
          '<div class="m-paths">' + d.events.slice(0, 24).map(function (e) {
            return '<div>' + hhmmss(e.t) + '  ' + esc(actOf(e.m)) + ' ' + esc(e.p) + '  → ' + esc(resOf(e.c)) + '</div>';
          }).join('') + '</div>';
      }

      html += '<div class="m-acts">' +
        '<select id="op-min" title="挡住多久">' +
          '<option value="10">挡 10 分钟</option>' +
          '<option value="60" selected>挡 1 小时</option>' +
          '<option value="1440">挡 1 天</option>' +
          '<option value="43200">挡 30 天</option>' +
        '</select>' +
        '<button class="op-btn danger" id="op-do-block">挡住它</button>' +
        (d.block ? '<button class="op-btn ghost" id="op-do-unblock">放它进来</button>' : '') +
        '<button class="op-btn ghost" id="op-close">关闭</button>' +
        '</div>';

      $('#op-modal-box').innerHTML = html;

      $('#op-close').addEventListener('click', closeModal);
      $('#op-do-block').addEventListener('click', function () {
        var mins = Number(($('#op-min') || {}).value || 60);
        doBlock(ip, mins).then(closeModal);
      });
      var ub = $('#op-do-unblock');
      if (ub) ub.addEventListener('click', function () { doUnblock(ip).then(closeModal); });
    }).catch(function (e) {
      if (e.status === 403) return deny();
      $('#op-modal-box').innerHTML = '<h3>' + esc(ip) + '</h3><div class="m-sub">' + esc(e.message) + '</div>';
    });
  }

  /* ---------------- 动作 ---------------- */

  /* 排错工具：只在「控制台里所有人显示同一个地址」时才需要。 */
  function openDiag() {
    $('#op-modal').hidden = false;
    $('#op-modal-box').innerHTML = '<h3>排错工具</h3><div class="m-sub">正在读取…</div>';
    get('/api/ops/diag').then(function (d) {
      var plainIp = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(d.ip) || d.ip === '::1';
      var rows = [
        ['服务器以为你是谁', d.ip],
        ['实际连进来的地址', d.socket],
        ['结论', plainIp
          ? '看不出真实地址 —— 所有人的地址都长这样，挡住一个人会挡住所有人'
          : '正常，每个访客都能分开认出来']
      ];
      var html = '<h3>排错工具</h3>' +
        '<div class="m-sub">只有在「下面实时表里所有人都是同一个地址」时才需要看这里。<br>' +
        '正常情况你会看到每个人一个不同的公网地址。</div>' +
        '<div class="kv">' + rows.map(function (r) {
          return '<i>' + r[0] + '</i><span>' + esc(r[1]) + '</span>';
        }).join('') + '</div>';

      if (d.suspectIps && d.suspectIps.length) {
        html += '<div class="m-sub" style="margin:12px 0 6px">网关转发时带的线索</div>' +
          '<div class="m-paths">' + d.suspectIps.map(function (x) {
            return '<div>' + esc(x.header) + ' = ' + esc(x.value) +
              (x.usable ? '   ✅ 可以用' : '   ⚠️ 不是公网地址，不能用') + '</div>';
          }).join('') + '</div>';
      } else {
        html += '<div class="m-sub" style="margin:12px 0 6px">网关没留下任何来源线索 —— 真实地址被抹掉了</div>';
      }

      html += '<div class="m-sub" style="margin:12px 0 6px">原始请求头（技术细节，备查）</div><div class="m-paths">' +
        Object.keys(d.headers || {}).map(function (k) {
          return '<div>' + esc(k) + ': ' + esc(d.headers[k]) + '</div>';
        }).join('') + '</div>' +
        '<div class="m-acts"><button class="op-btn ghost" id="op-close">关闭</button></div>';

      $('#op-modal-box').innerHTML = html;
      $('#op-close').addEventListener('click', closeModal);
    }).catch(function (e) {
      $('#op-modal-box').innerHTML = '<h3>排错工具</h3><div class="m-sub">' + esc(e.message) + '</div>';
    });
  }

  function doBlock(ip, mins) {
    return post('/api/ops/block', { ip: ip, minutes: mins, reason: '管理员在控制台手动挡住' })
      .then(function () { return refresh(); })
      .catch(function (e) { alert(e.message); });
  }

  function doUnblock(ip) {
    return post('/api/ops/unblock', { ip: ip })
      .then(function () { return refresh(); })
      .catch(function (e) { alert(e.message); });
  }

  /* ---------------- 轮询 ---------------- */

  function refresh() {
    return get('/api/ops/overview').then(function (o) {
      state.over = o;
      paintVerdict(o);
      paintPills(o);
      paintThreats(o.threats);
      paintBlocks(o.blocks);
      paintEvents(o.events);
    }).catch(function (e) {
      if (e.status === 403) deny(e.message);
    });
  }

  function pullFeed() {
    if (state.paused) return Promise.resolve();
    return get('/api/ops/feed?after=' + state.seq).then(function (d) {
      if (d.events && d.events.length) {
        state.rows = state.rows.concat(d.events);
        if (state.rows.length > 260) state.rows = state.rows.slice(-260);
        paintFeed();
      }
      state.seq = d.seq || state.seq;
    }).catch(function (e) {
      if (e.status === 403) deny(e.message);
    });
  }

  var t1 = null, t2 = null;
  function start() {
    stop();
    t1 = setInterval(refresh, 2500);
    t2 = setInterval(pullFeed, 1200);
  }
  function stop() {
    if (t1) clearInterval(t1);
    if (t2) clearInterval(t2);
    t1 = t2 = null;
  }

  function setLive(on) {
    state.paused = !on;
    var dot = $('#op-live');
    dot.className = 'op-live' + (on ? '' : ' off');
    dot.innerHTML = '<i></i>' + (on ? '实时' : '已暂停');
    $('#op-pause').textContent = on ? '暂停' : '继续';
  }

  /* ---------------- 事件绑定 ---------------- */

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var blk = t.closest('[data-block]');
    if (blk) {
      ev.stopPropagation();
      doBlock(blk.getAttribute('data-block'), 60);
      return;
    }
    var ub = t.closest('[data-unblock]');
    if (ub) {
      ev.stopPropagation();
      doUnblock(ub.getAttribute('data-unblock'));
      return;
    }
    var th = t.closest('.th');
    if (th) { openIp(th.getAttribute('data-ip')); return; }
    if (t.id === 'op-modal') closeModal();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeModal();
  });

  document.addEventListener('DOMContentLoaded', function () {
    var q = $('#op-q');
    q.addEventListener('input', function () {
      state.filter = q.value;
      paintFeed();
    });
    q.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var v = q.value.trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v) || (v.indexOf(':') > 0 && v.length > 5)) openIp(v);
    });

    $('#op-pause').addEventListener('click', function () {
      setLive(state.paused);
    });

    $('#op-diag').addEventListener('click', openDiag);

    // 标签页切回前台时立刻刷一次，别让用户盯着一屏过期数据
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else { refresh(); pullFeed(); start(); }
    });

    // 先把当前 seq 对齐，页面打开时只显示「从现在开始」的流量
    get('/api/ops/feed?after=0').then(function (d) {
      state.seq = d.seq || 0;
      state.rows = [];
      paintFeed();
      return refresh();
    }).then(function () {
      setLive(true);
      start();
    }).catch(function (e) {
      if (e.status === 403) deny(e.message);
    });
  });
})();
