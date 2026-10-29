/* =========================================================
   饭圈 · 安全控制台（前端）
   ---------------------------------------------------------
   只跟 /api/ops/* 说话，所有判断都在服务端。这里做三件事：
     1) 把「谁在干什么」排成能一眼扫过去的表；
     2) 把行为分高的人拎出来（威胁排行）；
     3) 一键封禁 / 解封。
   ========================================================= */

(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

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
    if (s <= 0) return '已到期';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟后解封';
    if (s < 86400) return Math.round(s / 3600) + ' 小时后解封';
    return Math.round(s / 86400) + ' 天后解封';
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

  /* ---------------- 顶栏 ---------------- */

  function paintPills(o) {
    $('#p-rate').textContent = o.rate + '/min';
    $('#p-inflight').textContent = o.inflight + '/200';
    $('#p-blocked').textContent = o.blocked;
    $('#p-lag').textContent = o.lag + ' ms';

    var ratePill = $('#p-rate').parentNode;
    ratePill.className = 'pill' + (o.rate > 300 ? ' hot' : o.rate > 120 ? ' warm' : '');
    var lagPill = $('#p-lag').parentNode;
    lagPill.className = 'pill' + (o.lag > 300 ? ' hot' : o.lag > 120 ? ' warm' : '');
    var blkPill = $('#p-blocked').parentNode;
    blkPill.className = 'pill' + (o.blocked > 0 ? ' hot' : '');
  }

  /* ---------------- 实时流量 ---------------- */

  function statusCls(c) {
    if (c === 403 && state.filter) return 'c5';
    if (c >= 500) return 'c5';
    if (c === 404) return 'c4';
    if (c === 429) return 'c4';
    if (c === 403) return 'c5';
    if (c === 401) return 'c3';
    return 'c2';
  }

  function paintFeed() {
    var box = $('#op-feed');
    var q = state.filter.trim();
    var rows = state.rows;
    if (q) rows = rows.filter(function (r) { return r.ip.indexOf(q) >= 0 || r.p.indexOf(q) >= 0; });

    if (!rows.length) {
      box.innerHTML = '<div class="op-empty">' + (q ? '这个过滤条件没有流量' : '暂时没有请求，等一会儿…') + '</div>';
      return;
    }

    var out = [];
    for (var i = rows.length - 1; i >= 0 && out.length < 120; i--) {
      var r = rows[i];
      var isBlocked = !!state.blocked[r.ip] || r.c === 403 && r.ms === 0;
      out.push('<div class="op-row">' +
        '<span>' + hhmmss(r.t) + '</span>' +
        '<span class="c-ip' + (isBlocked ? ' c-blocked' : '') + '">' + esc(r.ip) + '</span>' +
        '<span>' + esc(r.m) + '</span>' +
        '<span class="c-path">' + esc(r.p) + '</span>' +
        '<span class="' + statusCls(r.c) + '">' + r.c + '</span>' +
        '<span>' + (r.ms ? r.ms + 'ms' : '–') + '</span>' +
        '<span class="c-act"><button class="op-btn danger mini" data-block="' + esc(r.ip) + '">封</button></span>' +
        '</div>');
    }
    box.innerHTML = out.join('');
  }

  /* ---------------- 威胁排行 ---------------- */

  function tagsOf(t) {
    var tags = [];
    if (t.ids >= 10) tags.push(['bad', '翻 ' + t.ids + ' 个主页']);
    if (t.qs >= 8) tags.push(['bad', '换 ' + t.qs + ' 个搜索词']);
    if (t.scan > 0) tags.push(['bad', '扫路径 ' + t.scan + ' 次']);
    if (t.s404 >= 15) tags.push(['warn', '404 × ' + t.s404]);
    if (t.s403 >= 15) tags.push(['warn', '403 × ' + t.s403]);
    if (t.s401 >= 15) tags.push(['warn', '401 × ' + t.s401]);
    if (t.s429 > 0) tags.push(['warn', '被限流 × ' + t.s429]);
    if (t.bot) tags.push(['info', '脚本 UA']);
    if (t.pids >= 40) tags.push(['warn', '翻 ' + t.pids + ' 篇内容']);
    if (t.n >= 200) tags.push(['info', t.n + ' 次/分']);
    if (!tags.length) tags.push(['info', t.n + ' 次请求']);
    return tags;
  }

  function paintThreats(list) {
    var box = $('#op-threats');
    if (!list || !list.length) {
      box.innerHTML = '<div class="op-empty">没有异常行为。<br>有人开始遍历或扫路径时会出现在这里。</div>';
      return;
    }
    box.innerHTML = list.map(function (t) {
      var cls = t.score >= 60 ? 'hot' : t.score >= 30 ? 'warm' : '';
      return '<div class="th ' + cls + '" data-ip="' + esc(t.ip) + '">' +
        '<div class="th-top"><span class="th-ip">' + esc(t.ip) + '</span>' +
        '<span class="th-score">' + t.score + '</span></div>' +
        '<div class="th-tags">' + tagsOf(t).map(function (x) {
          return '<span class="tag ' + x[0] + '">' + esc(x[1]) + '</span>';
        }).join('') + '</div>' +
        '<div class="th-ua">' + esc(t.ua || '（无 UA）') + '</div>' +
        '</div>';
    }).join('');
  }

  /* ---------------- 封禁名单 ---------------- */

  function paintBlocks(list) {
    var box = $('#op-blocks');
    state.blocked = Object.create(null);
    (list || []).forEach(function (b) { state.blocked[b.ip] = true; });

    $('#op-block-sub').textContent = (list || []).length ? (list.length + ' 个') : '';
    if (!list || !list.length) {
      box.innerHTML = '<div class="op-empty">当前没有封禁的地址。</div>';
      return;
    }
    box.innerHTML = list.map(function (b) {
      return '<div class="bl">' +
        '<span class="bl-badge' + (b.auto ? '' : ' man') + '">' + (b.auto ? '自动' : '手动') + '</span>' +
        '<span class="bl-ip">' + esc(b.ip) + '</span>' +
        (b.hits ? '<span class="bl-meta">被拦 ' + b.hits + '</span>' : '') +
        '<span class="bl-meta">' + left(b.until) + '</span>' +
        '<button class="op-btn ghost mini" data-unblock="' + esc(b.ip) + '">解封</button>' +
        '</div>';
    }).join('');
  }

  /* ---------------- 安全事件 ---------------- */

  var HI = { ip_block: 1, ip_autoblock: 1, enum_suspect: 1, probe_suspect: 1, csrf_block: 1, upload_fake: 1 };

  function paintEvents(list) {
    var box = $('#op-events');
    if (!list || !list.length) {
      box.innerHTML = '<div class="op-empty">还没有安全事件。</div>';
      return;
    }
    box.innerHTML = list.slice(-60).reverse().map(function (e) {
      var extra = [];
      if (e.reason) extra.push(e.reason);
      if (e.path) extra.push(e.path);
      if (e.username) extra.push(e.username);
      if (e.ids != null) extra.push('翻 ' + e.ids + ' 个主页');
      if (e.q != null) extra.push(e.q + ' 个搜索词');
      if (e.score != null) extra.push('分 ' + e.score);
      if (e.min) extra.push(e.min + ' 分钟');
      if (e.reason == null && e.from) extra.push(e.from);
      return '<div class="ev' + (HI[e.kind] ? ' hi' : '') + '">' +
        '<span>' + (e.t ? hhmmss(Date.parse(e.t)) : '') + '</span>' +
        '<span class="ev-ip">' + esc(e.ip || '') + '</span>' +
        '<span class="ev-x"><b>' + esc(e.kind || '') + '</b> ' + esc(extra.join(' · ')) + '</span>' +
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
        ['行为分', (w.score || 0) + (w.peak ? '（峰值 ' + w.peak + '）' : '')],
        ['本分钟', (w.n || 0) + ' 次请求'],
        ['翻过的用户主页', (w.ids || 0) + ' 个'],
        ['换过的搜索词', (w.qs || 0) + ' 个'],
        ['翻过的内容', (w.pids || 0) + ' 篇'],
        ['状态码', '404×' + (w.s404 || 0) + '  403×' + (w.s403 || 0) + '  401×' + (w.s401 || 0) + '  429×' + (w.s429 || 0)],
        ['扫路径次数', (w.scan || 0)],
        ['脚本 UA', w.bot ? '是' : '否'],
        ['首次出现', w.first ? ago(w.first) : '–'],
        ['最近活动', w.last ? ago(w.last) : '–'],
        ['UA', w.ua || '（无）'],
        ['白名单', d.trusted ? '是（不会自动封）' : '否']
      ];

      var html = '<h3>' + esc(ip) + '</h3>' +
        '<div class="m-sub">' + (d.trusted ? '这个地址在白名单里，自动封禁会跳过它' : '实时行为画像') + '</div>' +
        '<div class="kv">' + kv.map(function (x) {
          return '<i>' + x[0] + '</i><span>' + esc(x[1]) + '</span>';
        }).join('') + '</div>';

      if (w.paths && w.paths.length) {
        html += '<div class="m-sub" style="margin:4px 0 6px">最近访问</div><div class="m-paths">' +
          w.paths.map(function (p) { return '<div>' + esc(p) + '</div>'; }).join('') + '</div>';
      }

      if (d.events && d.events.length) {
        html += '<div class="m-sub" style="margin:14px 0 6px">最近请求（' + d.events.length + ' 条）</div>' +
          '<div class="m-paths">' + d.events.slice(0, 24).map(function (e) {
            return '<div>' + hhmmss(e.t) + '  ' + esc(e.m) + ' ' + esc(e.p) + '  → ' + e.c + '</div>';
          }).join('') + '</div>';
      }

      html += '<div class="m-acts">' +
        '<select id="op-min">' +
          '<option value="10">10 分钟</option>' +
          '<option value="60" selected>1 小时</option>' +
          '<option value="1440">24 小时</option>' +
          '<option value="43200">30 天</option>' +
        '</select>' +
        '<button class="op-btn danger" id="op-do-block">封禁这个 IP</button>' +
        (d.block ? '<button class="op-btn ghost" id="op-do-unblock">解除当前封禁</button>' : '') +
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

  function doBlock(ip, mins) {
    return post('/api/ops/block', { ip: ip, minutes: mins, reason: '管理员在控制台手动封禁' })
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
      if (!d.events || !d.events.length) return;
      // 首次拉取时把 seq 一次性对齐，避免控制台一打开就灌满历史
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
