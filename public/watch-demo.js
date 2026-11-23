/* 实时盯锅 · 独立演示
   不依赖 app.js，也不进 SPA 路由。整个页面只在 FQ_WATCH_DEMO=1 时存在。

   为什么是「定时截帧」而不是真视频流：模型端点是一问一答的 HTTP，单帧就要 2.7 秒。
   传 30fps 上去它也只能每 2.7 秒回一次，多传的帧纯烧钱。

   ── 提速这一轮（第一版是 15 秒一拍） ──────────────────────────
   原来「检测周期 = 发送周期」，锅里刚冒烟得等下一拍才被发现，
   平均 7.5 秒、最坏 15 秒，再加模型 2.7 秒和排队，最坏能到 30 秒。

   现在拆成两层：
     探针  0.8 秒一拍，只把画面缩成 16×16 算差分，不联网、几乎不耗电
            → 发现突变或累计变化够大，立刻发帧
     发帧  按需，最快 3.5 秒一次，带预算控制
   检测延迟 7.5 秒 → 0.4 秒，端到端 ~18 秒 → ~3.8 秒。

   模型那 2.7 秒是固定的，前端再怎么改也压不掉 —— 速度的余量全在「什么时候决定要问」这一步。
*/
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var video = $('#cam');
  var stage = $('#stage');
  var setup = $('#setup');
  var pill = $('#pill');
  var stEl = $('#st');
  var statEl = $('#stat');
  var seeEl = $('#see');
  var peekBtn = $('#peek');
  var trendEl = $('#trend');

  var PROBE_MS = 800;     // 探针节拍
  var MIN_GAP = 3500;     // 两次发帧最短间隔，别把限额烧穿
  var MAX_FLY = 2;        // 同时在飞的请求数
  var BUDGET_N = 12;      // 60 秒内超过这么多帧就降频
  var BUDGET_MS = 12000;  // 降频时改用的间隔

  var S = {
    stream: null,
    probeTimer: null,
    running: false,
    inflight: 0,
    frames: 0,          // 探针扫描次数
    sent: 0,            // 真正问过模型的次数
    skipped: 0,         // 被省掉的次数
    every: 15000,       // 保底心跳：这么久没问过就问一次（抓渐进变化）
    sens: 3,
    dish: '',
    prevF: null,        // 上一拍（0.8 秒前）的整帧样本：灰度 + 色相 + 权重
    refF: null,         // 上一次发帧时的样本，渐进变化靠它累积
    hist: [],           // 食材区的色相/亮度/饱和，每 0.8 秒一条，趋势就靠它
    lastSee: '',        // 上一次模型说的「看见了什么」—— 传回去它才说得出「比刚才深了」
    lastSentAt: 0,
    sentLog: [],        // 最近发帧时间戳，算预算
    quietStreak: 0,     // 模型连续说了几次「没事」——用它来放慢追问频率
    startedAt: 0,
    wake: null,
    lastSay: { text: '', at: 0 },
    lastTalkAt: 0,     // 最后一次真正开口的时间 —— 沉默太久要说句话证明还在
    lastAlive: 0,      // 上一次「我还看着」的报平安
    blind: 0,          // 连续几眼看不清 —— 镜头没对准锅时得开口教他摆
    blindAt: 0,        // 上次因为看不清开口的时间（两分钟内不重复）
    spoke: false,      // 这次会话有没有真的出过声（查语音引擎在不在）
    voiced: { level: '', at: 0 },  // 上一次开口的档位与时间，用来压住同一件事的重复播报
    step: null         // 当前停在第几步（来自做饭模式的剧本），见 readStep()
  };

  /* 从 URL 接一个「当前步骤」进来，只为验证接进做饭模式之后的效果。
     真接进站内时这几个值直接取 state.cook.steps[state.cook.i] 和 state.cook.i，
     不需要 URL —— 这里留着是为了能单独测「带步骤」和「不带步骤」的差别。 */
  (function readStep() {
    try {
      var u = new URLSearchParams(location.search);
      var t = (u.get('task') || '').trim();
      if (!t) return;
      S.step = {
        i: Math.max(0, Number(u.get('step') || 1) - 1),
        of: Number(u.get('of') || 0),
        t: t.slice(0, 40),
        d: (u.get('desc') || '').trim().slice(0, 120),
        w: (u.get('why') || '').trim().slice(0, 60)
      };
    } catch (e) {}
  })();

  /* 带着步骤进来时，开始页就说清是哪一步 —— 不然没法分辨「带步骤」和「没带」的差别。 */
  (function showStepHint() {
    if (!S.step) return;
    var lead = document.querySelector('#setup .lead');
    if (!lead) return;
    var p = document.createElement('p');
    p.className = 'fine';
    p.textContent = '这次带着第 ' + (S.step.i + 1) + (S.step.of ? ' / ' + S.step.of : '') +
      ' 步来：' + S.step.t;
    lead.parentNode.insertBefore(p, lead.nextSibling);
  })();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 一次采样，四样东西 ----------------
     只 drawImage 一次（缩到 16×16，GPU 上几乎没成本），同时算出灰度、色相、饱和度。

     为什么非要色相：灰度分不清「肉变褐」和「灯变暗」。
     用 10 张真实菜品图实测（4×4 分块，取平均）：

       变化          灰度    色相     饱和
       光暗 25%      34.0    0.3°     0.00
       蒸汽掠过      43.5    0.5°     0.23
       肉变褐        36.7    4.4°     0.11     ← 灰度上和「灯暗了」差 2.7，比噪声还小
       菜变黄        11.4   21.0°     0.00     ← 灰度低于 15，旧版直接当「没动静」跳过
       手挡镜头     120.7    0.0°     0.15

     结论：灰度只能回答「画面动没动」，色相才能回答「是不是吃的在变色」。
     饱和度对肉变褐只有 0.11（比蒸汽的 0.23 还小），不能当判据，
     但它决定色相可不可信 —— 一个几乎没颜色的像素可以报任意色相。 */
  var DIF_N = 16;
  var BLK = 4;
  var PER = DIF_N / BLK;

  var difCv = document.createElement('canvas');
  difCv.width = DIF_N; difCv.height = DIF_N;
  var difCtx = difCv.getContext('2d', { willReadFrequently: true });

  function sampleFrame() {
    difCtx.drawImage(video, 0, 0, DIF_N, DIF_N);
    var d = difCtx.getImageData(0, 0, DIF_N, DIF_N).data;
    var n = DIF_N * DIF_N;
    var gray = new Float32Array(n);
    var hue = new Float32Array(n);
    var satA = new Float32Array(n);
    var wt = new Float32Array(n);      // 色相权重：暗处、灰处记 0
    var lumSum = 0, satSum = 0;

    for (var i = 0, p = 0; p < n; i += 4, p++) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var dl = mx - mn;

      gray[p] = r * 0.299 + g * 0.587 + b * 0.114;
      lumSum += gray[p];

      var s = mx > 0 ? dl / mx : 0;
      satA[p] = s;
      satSum += s;

      var h = 0;
      if (dl > 0) {
        if (mx === r) h = 60 * (((g - b) / dl) % 6);
        else if (mx === g) h = 60 * ((b - r) / dl + 2);
        else h = 60 * ((r - g) / dl + 4);
      }
      if (h < 0) h += 360;
      hue[p] = h;
      wt[p] = (mx >= 28 && s >= 0.18) ? s : 0;
    }
    return { gray: gray, hue: hue, satA: satA, wt: wt, lum: lumSum / n, sat: satSum / n };
  }

  /* 灰度差分：分成 4×4 块，取最差的那块。
     原来算全画面平均，锅只占中间一块，边上静止的墙面把平均值稀释掉好几倍 ——
     烟都起来了 avg 还只有一点几，于是被判成「画面没变」。 */
  function blkDiff(g, ref) {
    var maxD = 0, sumD = 0, n = 0;
    for (var by = 0; by < BLK; by++) {
      for (var bx = 0; bx < BLK; bx++) {
        var s = 0, c = 0;
        for (var y = by * PER; y < (by + 1) * PER; y++) {
          var row = y * DIF_N;
          for (var x = bx * PER; x < (bx + 1) * PER; x++) {
            s += Math.abs(g[row + x] - ref[row + x]);
            c++;
          }
        }
        var dd = s / c;
        if (dd > maxD) maxD = dd;
        sumD += dd; n++;
      }
    }
    return { max: maxD, avg: sumD / n };
  }

  /* 色相差分：带符号、按饱和度加权、逐块算。
     带符号是为了分清「往黄褐偏」和「往绿偏」，一个 +、一个 −。
     逐块算是因为手机自动白平衡是**全局同向**的偏色，而肉变褐只发生在食材那几块 ——
     用「同号比例」就能把「手机自己调色」和「真的上色」分开。 */
  function hueShift(a, b) {
    var shifts = new Float32Array(BLK * BLK);
    var wts = new Float32Array(BLK * BLK);

    for (var by = 0; by < BLK; by++) {
      for (var bx = 0; bx < BLK; bx++) {
        var sx = 0, sy = 0, sw = 0;
        for (var y = by * PER; y < (by + 1) * PER; y++) {
          var row = y * DIF_N;
          for (var x = bx * PER; x < (bx + 1) * PER; x++) {
            var k = row + x;
            var w = Math.min(a.wt[k], b.wt[k]);
            if (w <= 0) continue;
            var rad = (a.hue[k] - b.hue[k]) * Math.PI / 180;
            sx += Math.cos(rad) * w;
            sy += Math.sin(rad) * w;
            sw += w;
          }
        }
        var bi = by * BLK + bx;
        if (sw >= 2) {
          // 矢量平均：跨 ±180° 也不会算错
          shifts[bi] = Math.atan2(sy, sx) * 180 / Math.PI;
          wts[bi] = Math.min(sw / (PER * PER), 1);
        }
      }
    }

    var arr = [];
    for (var j = 0; j < shifts.length; j++) if (wts[j] > 0) arr.push(shifts[j]);
    if (!arr.length) return { top: 0, same: 0, n: 0 };

    // 取变化最猛的 3 块 —— 用中位数会被大片没变的背景稀释成 0
    var abs = arr.map(function (v) { return Math.abs(v); }).sort(function (p, q) { return q - p; });
    var take = Math.min(3, abs.length);
    var topSum = 0;
    for (var q = 0; q < take; q++) topSum += abs[q];

    var pos = 0, neg = 0;
    for (var m = 0; m < arr.length; m++) { if (arr[m] >= 0) pos++; else neg++; }

    return {
      top: topSum / take,
      same: Math.max(pos, neg) / arr.length,
      n: arr.length
    };
  }

  /* 「食材区」的颜色：取饱和度最高的 4 块。
     餐桌、墙面、锅沿、灶台都是低饱和的，盘里的菜是画面里最艳的东西。
     这块区域的平均色相/亮度随时间怎么走，就是「上色到哪一步了」的量化描述。 */
  function foodStats(f) {
    var blocks = [];
    for (var by = 0; by < BLK; by++) {
      for (var bx = 0; bx < BLK; bx++) {
        var sat = 0, lum = 0, sx = 0, sy = 0, sw = 0, c = 0;
        for (var y = by * PER; y < (by + 1) * PER; y++) {
          var row = y * DIF_N;
          for (var x = bx * PER; x < (bx + 1) * PER; x++) {
            var k = row + x;
            sat += f.satA[k]; lum += f.gray[k]; c++;
            var w = f.wt[k];
            if (w > 0) {
              var rad = f.hue[k] * Math.PI / 180;
              sx += Math.cos(rad) * w;
              sy += Math.sin(rad) * w;
              sw += w;
            }
          }
        }
        blocks.push({ sat: sat / c, lum: lum / c, sx: sx, sy: sy, sw: sw });
      }
    }
    blocks.sort(function (p, q) { return q.sat - p.sat; });
    var top = blocks.slice(0, 4);
    var hx = 0, hy = 0, sw = 0, lumS = 0, satS = 0;
    for (var i = 0; i < top.length; i++) {
      hx += top[i].sx; hy += top[i].sy; sw += top[i].sw;
      lumS += top[i].lum; satS += top[i].sat;
    }
    if (sw <= 0) return { ok: false };
    var hue = Math.atan2(hy, hx) * 180 / Math.PI;
    if (hue < 0) hue += 360;
    return { ok: true, hue: hue, lum: lumS / top.length, sat: satS / top.length };
  }

  /* ---------------- 截帧 ----------------
     长边压到 896、JPEG q0.72 —— 跟「拍给我看」那边用的是同一套参数，
     手机原图几 MB，这样出来大概 40~90KB。 */
  var snapCv = document.createElement('canvas');

  function snap() {
    var vw = video.videoWidth || 640;
    var vh = video.videoHeight || 480;
    var w = vw, h = vh, max = 896;
    if (Math.max(w, h) > max) {
      var k = max / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    snapCv.width = w; snapCv.height = h;
    snapCv.getContext('2d').drawImage(video, 0, 0, w, h);
    return snapCv.toDataURL('image/jpeg', 0.72);
  }

  /* ---------------- 说话 / 震动 / 提示音 ---------------- */
  var actx = null;

  /* ---------------- 形象 ----------------
     为什么不是「眨眨眼、动动嘴」：mascot-cut.webp 是一张整图，没有分层，
     硬做只能让整张贴纸上下抖，比不动更廉价。所以做状态对应的身体语言 ——
     待机呼吸 / 想的时候左右摇 / 说话时点头 + 并排声波 / 危险时跳两下。
     每个动作背后都有真实事件，不是随缘飘。 */
  var chefEl = document.getElementById('chef');
  /* ---------------- 只有一张站姿 ----------------
     2.24 做过第二张坐姿（拖到底边就坐下），已经不用了：台球模式里
     撞到底墙是「弹回来」，不是「坐下」—— 弹一下还顺手换个姿势才叫怪。
     文件留在 assets 里没删，将来真要做「它自己找地方歇着」还能用。 */
  var chefImg = chefEl ? chefEl.querySelector('img') : null;
  var chefTimer = 0;

  function chefSet(st, ms) {
    if (!chefEl) return;
    chefEl.setAttribute('data-st', st);
    if (chefTimer) { clearTimeout(chefTimer); chefTimer = 0; }
    /* 兜底：onend 在部分浏览器上不派发（尤其被 cancel 打断时），
       光等事件会出现「说完了还在点头」。 */
    if (ms) chefTimer = setTimeout(function () { chefSet('idle'); }, ms);
  }

  /* 只在「还在想」的时候降级：
     请求一返回就无脑打回 idle，会把紧跟着的说话动作一起打掉。 */
  function chefIdle() {
    if (chefEl && chefEl.getAttribute('data-st') === 'think') chefSet('idle');
  }

  function chefJump() {
    if (!chefEl) return;
    chefEl.classList.add('jump');
    setTimeout(function () { chefEl.classList.remove('jump'); }, 1050);
  }

  /* ---- 说话气泡：话挂在人身上，不往左上角那行状态里塞 ---- */
  var bubEl = document.getElementById('cbub');
  var bubTimer = 0;

  /* 气泡默认从形象头顶往右长。人站到右半边就翻到左边，
     站得太靠上就翻到脚下 —— 不然在最常见的位置（右下角）直接出屏。 */
  function placeBubble() {
    if (!chefEl || !bubEl) return;
    var r = chefEl.getBoundingClientRect();
    var vw = window.innerWidth || 360;
    /* 按气泡自己的实际尺寸判断，不用估的常数：一句话和两句话宽度差很多，
       用固定值会出现「短句不翻、长句出屏」或者反过来。 */
    var bw = bubEl.offsetWidth || 172;
    var bh = bubEl.offsetHeight || 40;
    chefEl.classList.toggle('bub-left', (vw - r.left) < bw + 12 && r.left > bw + 12);
    chefEl.classList.toggle('bub-down', r.top < bh + 14);
  }

  function bubble(text, level, ms) {
    if (!bubEl || !text) return;
    bubEl.textContent = text;
    /* tip = 教人怎么用它，走另一套视觉（暖金实底深字，见 CSS）；
       danger、notice 是它要说的话，深底浅字。 */
    bubEl.className = 'chef-bub on' +
      (level === 'danger' ? ' danger' : '') +
      (level === 'tip' ? ' tip' : '');
    placeBubble();
    if (bubTimer) clearTimeout(bubTimer);
    bubTimer = setTimeout(function () {
      bubEl.classList.remove('on');
    }, Math.max(2200, (ms || 3000) + 600));
  }

  /* ---- 拖动 = 台球 ----
     用户原话：「我想把他模拟成台球那样」。
     台球的语言就三条：甩出去以后自己滑、撞库弹回来、能量耗尽停下。
     上一版是「松手就地死住 + 离边 30px 自动吸过去 + 贴着边歪身子」，
     三条全反着来，所以既不像球，边缘的动作还怪（见 CSS 撞边那段）。

     借的是二维平面的位移物理，不借「滚动」：它是人形不是球，
     整图打转只会像贴纸被风吹跑。撞库那一下用挤压代替旋转 ——
     台球撞边让人一眼认出是台球的，也正是那一下变形。 */
  var CHEF_POS = 'fq.chef.pos';
  var drag = { on: false, id: 0, sx: 0, sy: 0, ox: 0, oy: 0, moved: false, at: 0, samples: [] };

  /* 四周留多少：左右 4px，底部 12px。
     底部多留是因为脚正好在画布下沿，贴到 0 会被看成切掉一截；
     而且脚下那团影子画在盒子外面，贴死了影子就没了。 */
  var WALL = { side: 4, bottom: 12 };

  /* 用 offsetWidth/offsetHeight 而不是 rect：待机呼吸是 scale(1.014)，
     rect 的宽高每 4.6 秒抖 1%，撞右墙的时机就会飘几个像素。 */
  function chefSize() {
    return { w: chefEl.offsetWidth || 96, h: chefEl.offsetHeight || 138 };
  }

  function clampPos(x, y) {
    var b = chefSize();
    var vw = window.innerWidth || 360;
    var vh = window.innerHeight || 640;
    var maxX = Math.max(WALL.side, vw - b.w - WALL.side);
    var maxY = Math.max(WALL.side, vh - b.h - WALL.bottom);
    return {
      x: Math.min(Math.max(WALL.side, x), maxX),
      y: Math.min(Math.max(WALL.side, y), maxY)
    };
  }

  /* ---- 台球参数 ----
     FRICTION：每 1/60 秒留下的比例。.935 一秒后只剩 2%，滑行约一屏出头；
     REST：撞库后留下的速度，真台球撞库大概 0.6~0.7；
     MINV：低于每秒 2px 就不动了，再滑也看不出来；
     MAXV：限速。实测手速能到 5px/ms，不限的话一甩就穿屏。 */
  var BALL = { vx: 0, vy: 0, raf: 0, last: 0, FRICTION: .935, REST: .62, MINV: .035, MAXV: 2.6 };
  var cur = { x: 0, y: 0, w: 96, h: 138 };
  var bumpTimer = 0;
  /* 系统里关掉动效的人，甩出去就直接落地，别让它在屏幕上乱弹 */
  var noMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function savePos() {
    try {
      var x = parseFloat(chefEl.style.left), y = parseFloat(chefEl.style.top);
      if (isNaN(x) || isNaN(y)) {
        var r = chefEl.getBoundingClientRect();
        x = r.left; y = r.top;
      }
      var p = clampPos(x, y);
      localStorage.setItem(CHEF_POS, JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }));
    } catch (e) {}
  }

  function ballStop() {
    if (BALL.raf) { cancelAnimationFrame(BALL.raf); BALL.raf = 0; }
    BALL.vx = 0; BALL.vy = 0;
    if (!chefEl) return;
    chefEl.classList.remove('rolling');
    if (bumpTimer) { clearTimeout(bumpTimer); bumpTimer = 0; }
    chefEl.style.transform = '';
    chefEl.style.transformOrigin = '';   // 撞击时改过支点，留着会带进下一次
  }

  /* 撞库的那一下：沿撞击轴压、另一轴顶出来。
     支点必须在被撞的那条边上 —— 留在中心就是「整个人像缩小」，
     看着像被抽掉一截，不像撞匾。 */
  function bump(axis, sign, power) {
    if (!chefEl) return;
    var k = Math.max(.25, Math.min(1, power / 1.6));
    var a = 1 - .1 * k, b = 1 + .06 * k;
    chefEl.style.transformOrigin = axis === 'x'
      ? (sign > 0 ? '100% 50%' : '0% 50%')
      : (sign > 0 ? '50% 100%' : '50% 0%');
    chefEl.style.transform = axis === 'x'
      ? 'scale(' + a.toFixed(3) + ',' + b.toFixed(3) + ')'
      : 'scale(' + b.toFixed(3) + ',' + a.toFixed(3) + ')';
    if (bumpTimer) clearTimeout(bumpTimer);
    bumpTimer = setTimeout(function () {
      bumpTimer = 0;
      if (chefEl) chefEl.style.transform = '';
    }, 110);
  }

  /* 撞库的「嗒」。台球没有这一声就不像台球，但它只是操作反馈 ——
     音量压到刚刚能听见，绝不盖过它说的话。 */
  function knock(power) {
    if (!actx) return;
    try {
      var t = actx.currentTime;
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(210, t);
      o.frequency.exponentialRampToValueAtTime(98, t + .09);
      g.gain.setValueAtTime(.0001, t);
      g.gain.exponentialRampToValueAtTime(.05 + .05 * Math.min(1, power / 1.6), t + .006);
      g.gain.exponentialRampToValueAtTime(.0001, t + .13);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + .16);
    } catch (e) {}
  }

  function ballStep(now) {
    if (!chefEl) { ballStop(); return; }
    BALL.raf = requestAnimationFrame(ballStep);
    var dt = Math.min(34, Math.max(1, now - (BALL.last || now)));
    BALL.last = now;
    var f = Math.pow(BALL.FRICTION, dt / 16.7);
    BALL.vx *= f; BALL.vy *= f;

    var vw = window.innerWidth || 360;
    var vh = window.innerHeight || 640;
    var minX = WALL.side, maxX = Math.max(minX, vw - cur.w - WALL.side);
    var minY = WALL.side, maxY = Math.max(minY, vh - cur.h - WALL.bottom);
    var x = cur.x + BALL.vx * dt;
    var y = cur.y + BALL.vy * dt;
    var sp = Math.sqrt(BALL.vx * BALL.vx + BALL.vy * BALL.vy);

    if (x < minX)      { x = minX; BALL.vx = -BALL.vx * BALL.REST; bump('x', -1, sp); knock(sp); }
    else if (x > maxX) { x = maxX; BALL.vx = -BALL.vx * BALL.REST; bump('x', 1, sp); knock(sp); }
    if (y < minY)      { y = minY; BALL.vy = -BALL.vy * BALL.REST; bump('y', -1, sp); knock(sp); }
    else if (y > maxY) { y = maxY; BALL.vy = -BALL.vy * BALL.REST; bump('y', 1, sp); knock(sp); }

    cur.x = x; cur.y = y;
    chefEl.style.left = x + 'px';
    chefEl.style.top = y + 'px';
    chefEl.style.right = 'auto';
    chefEl.style.bottom = 'auto';
    /* 每帧只写不读：宽高在抛出时量一次存进 cur，滑行途中不会变。
       每帧再 getBoundingClientRect 就是一次强制同步布局。 */
    if (bubEl && bubEl.classList.contains('on')) placeBubble();

    if (Math.sqrt(BALL.vx * BALL.vx + BALL.vy * BALL.vy) < BALL.MINV) {
      ballStop();
      savePos();
      placeBubble();
    }
  }

  /* 松手时的速度：只取最后 90ms 的位移。
     用「按下到松手」的总位移会把「慢慢挪一段再松手」当成猛甩；
     松手前 130ms 内已经不动了，就当作放下，不抛。 */
  function flingVelocity() {
    var s = drag.samples, out = { x: 0, y: 0 };
    if (!s || s.length < 2) return out;
    var last = s[s.length - 1];
    if (performance.now() - last.t > 130) return out;
    var first = s[0];
    for (var i = 0; i < s.length; i++) {
      if (last.t - s[i].t <= 90) { first = s[i]; break; }
    }
    var dt = last.t - first.t;
    if (dt < 10) return out;      // 两个点叠在一起，除出来是天文数字
    out.x = (last.x - first.x) / dt;
    out.y = (last.y - first.y) / dt;
    return out;
  }

  function fling(vx, vy) {
    if (!chefEl) return;
    var sp = Math.sqrt(vx * vx + vy * vy);
    if (sp > BALL.MAXV) { vx = vx / sp * BALL.MAXV; vy = vy / sp * BALL.MAXV; }
    var sz = chefSize();
    var lx = parseFloat(chefEl.style.left), ly = parseFloat(chefEl.style.top);
    if (isNaN(lx) || isNaN(ly)) {
      var r = chefEl.getBoundingClientRect();
      lx = r.left; ly = r.top;
    }
    cur = { x: lx, y: ly, w: sz.w, h: sz.h };
    if (noMotion || Math.sqrt(vx * vx + vy * vy) < BALL.MINV) { savePos(); return; }
    BALL.vx = vx; BALL.vy = vy;
    BALL.last = 0;
    chefEl.classList.add('rolling');
    if (!BALL.raf) BALL.raf = requestAnimationFrame(ballStep);
  }

  /* 尺寸变了（开始页 96 → 盯锅页 116）或者转屏：把位置收回桌内、气泡重摆。
     原来这个函数叫 paintEdge，专职切贴边姿态 —— 那套已经删了。 */
  function relayout() {
    if (!chefEl) return;
    if (chefEl.style.left) {
      var p = clampPos(parseFloat(chefEl.style.left), parseFloat(chefEl.style.top));
      chefEl.style.left = p.x + 'px';
      chefEl.style.top = p.y + 'px';
    }
    placeBubble();
  }

  function moveTo(x, y) {
    var p = clampPos(x, y);
    /* 一旦手动摆过，就把 right/bottom 让开 —— 否则 left/top 和它们打架，
       on-stage 那套默认位置也会把人拽回原处。 */
    chefEl.style.left = p.x + 'px';
    chefEl.style.top = p.y + 'px';
    chefEl.style.right = 'auto';
    chefEl.style.bottom = 'auto';
    /* 拖的时候只更新位置。气泡没露出来就别量了 —— 每帧一次
       getBoundingClientRect 换不来任何东西。 */
    if (bubEl && bubEl.classList.contains('on')) placeBubble();
  }

  function restorePos() {
    try {
      var raw = localStorage.getItem(CHEF_POS);
      if (!raw) return;
      var p = JSON.parse(raw);
      if (typeof p.x === 'number' && typeof p.y === 'number') moveTo(p.x, p.y);
    } catch (e) {}
  }

  /* 点一下它答应一声，长按才是静音。
     原来「点 = 静音」是个隐藏开关，现在能拖了，误触概率翻倍 ——
     而且既然要「有聊天框」，触点出去最好是它回一句话，不是突然变淡。
     说话仍然只在真有事的时候发生，点出来的这句不出声，怕盖掉正经提醒。 */
  var TAP_LINES = [
    '我在呢，锅那边我替你看着。',
    '不用一直看我，有变化我先说。',
    '手上忙你的，我盯着。'
  ];
  var tapAt = 0;
  var pressTimer = 0;
  var pressLong = false;

  function tapSay() {
    if (!chefEl || chefEl.classList.contains('mute')) return;
    /* 点一下 = 把刚才那句再给我看一遍。
       灶台边的真实场景是「没听清」：油烟机一响，那句「把火关小」就漏过去了，
       而手上是油、腾不出手看屏幕。这时候弹一句俏皮话没有半点用处。 */
    if (S.lastSay.text) {
      bubble(S.lastSay.text, '', 3200);
      chefSet('talk', 1800);
      return;
    }
    var line = TAP_LINES[tapAt % TAP_LINES.length];
    tapAt++;
    /* 只弹气泡不出声：手动点它的时候，正在念的那句提醒不该被掐掉 */
    bubble(line, '', 2400);
    chefSet('talk', 1600);
  }

  function setMute(on) {
    chefEl.classList.toggle('mute', on);
    if (on) {
      if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (err) {} }
      if (voice.timer) { clearTimeout(voice.timer); voice.timer = 0; }
      voice.busy = false; voice.q = null; voice.seq++;
      if (bubEl) bubEl.classList.remove('on');
      chefSet('idle');
      setState('', '看着');       // 走静音分支，顶上立刻变成「静音·还在看」
    } else {
      bubble('我回来了。', '', 1800);
      setState('', '看着');
    }
  }

  if (chefEl) {
    chefEl.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      /* 挡住浏览器默认动作（图片原生拖拽、选中文字）。
         只靠 CSS 的 -webkit-user-drag 在部分浏览器不生效，
         而一旦触发原生拖拽，pointermove 就断了 —— 电脑端拖不动的根因。 */
      try { e.preventDefault(); } catch (err) {}
      var r = chefEl.getBoundingClientRect();
      /* 手指一按就刹车：让惯性和你的手抢方向盘，手指会被拖着走 */
      ballStop();
      drag.on = true; drag.moved = false; drag.id = e.pointerId;
      drag.sx = e.clientX; drag.sy = e.clientY;
      drag.ox = r.left; drag.oy = r.top; drag.at = Date.now();
      /* 速度采样从按下的这一刻开始，不然第一下甩永远算成 0 */
      drag.samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      pressLong = false;
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        pressTimer = 0;
        if (!drag.on || drag.moved) return;   // 已经拖走了，不算长按
        pressLong = true;
        setMute(!chefEl.classList.contains('mute'));
      }, 700);
      try { chefEl.setPointerCapture(e.pointerId); } catch (err) {}
    });

    chefEl.addEventListener('pointermove', function (e) {
      if (!drag.on || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      /* 手指抖一两像素是常态，别当成拖动，否则「点一下」永远点不到 */
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 8) return;
      drag.moved = true;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
      chefEl.classList.add('dragging');
      moveTo(drag.ox + dx, drag.oy + dy);
      /* 只留最后 6 个点：算 90ms 内的速度够用了，攒多了反而把「松手前突然加速」平均掉 */
      drag.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (drag.samples.length > 6) drag.samples.shift();
    });

    function endDrag(e) {
      if (!drag.on || (e && e.pointerId !== drag.id)) return;
      drag.on = false;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
      chefEl.classList.remove('dragging');
      try { chefEl.releasePointerCapture(drag.id); } catch (err) {}
      if (drag.moved) {
        /* 松手不再吸附贴边：以前要贴到 30px 内自动吸过去，是因为那套姿态
           「贴上」才触发；现在撞库靠物理，吸过去反而把最后一点手感抹掉。
           手停在离边十几像素处就是十几像素，跟台球停在那儿一样自然。 */
        var v = flingVelocity();
        fling(v.x, v.y);
        if (!BALL.raf) savePos();
      } else if (!pressLong && Date.now() - drag.at < 500) {
        tapSay();
      }
    }

    chefEl.addEventListener('pointerup', endDrag);
    chefEl.addEventListener('pointercancel', function (e) {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
      endDrag(e);
    });

    window.addEventListener('resize', function () {
      /* 转屏以后「桌」换了尺寸，正在滑的直接落地 ——
         不然它会照着旧边界继续飞，人已经贴在屏幕外面了 */
      ballStop();
      relayout();
    });

    restorePos();
    relayout();
  }

  /* ---------------- 说话 ----------------
     灶台边只有一个标准：这句话能不能听完。
     旧写法是「新的来了就 cancel」，实测很糟 —— 话说到一半被切掉，
     人只听到半句「把火…」，比压根不说更抓狂。现在：
       · 危险可以打断（糊锅不等人）
       · 普通提醒排队，等这一句说完；后来的覆盖前面的（更近的现场更新）
       · 静音只压「唠叨」，不压「糊了」—— 用户是嫌吵，不是想烧厨房 */
  var voice = { busy: false, q: null, timer: 0, seq: 0 };

  function voiceDone(seq) {
    if (seq !== voice.seq) return;      // 被 cancel 掉的旧句，onend 照样会来一次
    voice.busy = false;
    if (voice.timer) { clearTimeout(voice.timer); voice.timer = 0; }
    var q = voice.q;
    voice.q = null;
    if (q) setTimeout(function () { if (!voice.busy) playLine(q.text, q.level); }, 280);
    else chefSet('idle');
  }

  function playLine(text, level) {
    var my = ++voice.seq;
    voice.busy = true;
    var dur = Math.min(6000, 700 + text.length * 200);
    S.lastTalkAt = Date.now();
    chefSet('talk', dur);
    bubble(text, level, dur);
    if (!('speechSynthesis' in window)) {
      voice.timer = setTimeout(function () { voiceDone(my); }, dur);
      return;
    }
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.02;
      u.pitch = 1;
      u.onstart = function () { S.spoke = true; };
      u.onend = function () { voiceDone(my); };
      u.onerror = function () { voiceDone(my); };
      speechSynthesis.speak(u);
      /* 有的机型 onend 不派发（音频焦点被系统抢走时尤其明显），按字数兜个底 */
      voice.timer = setTimeout(function () { voiceDone(my); }, dur + 700);
    } catch (e) {
      voice.timer = setTimeout(function () { voiceDone(my); }, dur);
    }
  }

  function speak(text, level) {
    if (!text) return;
    if (chefEl && chefEl.classList.contains('mute')) {
      /* 静音时仍然要救急：红气泡 + 两声短促的「嘟嘟」+ 震动。
         不念字，但把眼睛和耳朵都戳一下 —— 关掉唠叨不等于关掉救火。 */
      if (level === 'danger') {
        bubble(text, 'danger', 7000);
        beep(920, .12); setTimeout(function () { beep(920, .12); }, 190);
        vibrate([60, 110, 60]);
      }
      return;
    }
    if (voice.busy) {
      if (level === 'danger') {
        try { speechSynthesis.cancel(); } catch (e) {}
        voice.q = null;
        playLine(text, level);       // playLine 会 ++seq，旧句的 onend 自然被忽略
      } else {
        voice.q = { text: text, level: level };
      }
      return;
    }
    playLine(text, level);
  }

  /* 并行两条请求时，两次几乎同时返回同一句话，会重复念一遍。
     同一句 9 秒内只念一次。 */
  function say(text, level) {
    if (!text) return;
    var now = Date.now();
    if (text === S.lastSay.text && now - S.lastSay.at < 9000) return;
    S.lastSay = { text: text, at: now };
    speak(text, level);
  }

  /* 「同一件事别一直喊」。
     实测：锅在冒烟那几十秒里，模型每帧都会报 danger，措辞每次略有不同
     （「把焦的挑出来」/「把发黑的挑出来」），所以按文字去重根本拦不住 ——
     四秒钟一句，人会直接把这个功能关掉。
     改成按「档位」冷却：同一档 18 秒内只开口一次，屏幕上的状态照常实时更新。
     真升级了（notice → danger）档位不同，会立刻念。 */
  function mayVoice(level) {
    var now = Date.now();
    var cool = level === 'danger' ? 18000 : 12000;
    if (S.voiced.level === level && now - S.voiced.at < cool) return false;
    S.voiced = { level: level, at: now };
    return true;
  }

  /* ---------------- 沉默的分寸 ----------------
     炖菜那二十分钟画面几乎不变，探针就不发帧，它也就一声不吭。
     用户看不见后台在做什么，只会得出一个结论：这玩意儿停了 ——
     然后去点一下屏幕，或者干脆关掉。
     所以「太久没说话」本身就该是一次开口。不调模型，用时间说话：
     四分钟一次，一顿饭四五句，够证明有人在，又不至于烦。 */
  var ALIVE_GAP = 180000;
  var aliveIdx = 0;

  function aliveTick() {
    if (!S.running) return;
    var now = Date.now();
    if (now - S.startedAt < 90000) return;      // 开头一分半本来就该安静，别抢戏
    if (now - S.lastAlive < ALIVE_GAP) return;
    if (now - S.lastTalkAt < 60000) return;     // 刚说过话，别紧接着又来一句
    S.lastAlive = now;
    var min = Math.max(1, Math.round((now - S.startedAt) / 60000));
    /* 三句都不涉及「熟没熟」—— 它并没有再看画面，只知道自己还在这儿。 */
    var lines = [
      '第 ' + min + ' 分钟，还看着。',
      '没什么变化，我继续盯。',
      '第 ' + min + ' 分钟，有动静我喊你。'
    ];
    say(lines[aliveIdx++ % lines.length], 'notice');
  }

  function vibrate(p) {
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {}
  }

  function beep(freq, dur) {
    if (!actx) return;
    try {
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      var t = actx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.06);
    } catch (e) {}
  }

  /* ---------------- 状态显示 ---------------- */
  function setState(cls, text) {
    /* 静音之后它不再出声，屏幕就成了唯一的线索。
       这时候必须明说「还在看」—— 否则人以为长按把它关掉了，
       然后整个功能就白开了。报错除外，错误永远优先显示。 */
    if (cls !== 'err' && chefEl && chefEl.classList.contains('mute')) {
      pill.className = 'pill muted';
      stEl.textContent = '静音·还在看';
      return;
    }
    pill.className = 'pill' + (cls ? ' ' + cls : '');
    stEl.textContent = text;
  }

  /* 第二层字：它这一眼看到了什么。跟「它说的话」分开 ——
     看见了不等于要说，没事的时候它就安静看着，灰字里留一句现在的情况。 */
  function setSee(text, cls) {
    if (!seeEl) return;
    seeEl.className = 'see' + (cls ? ' ' + cls : '');
    seeEl.textContent = text || '';
  }

  function paintStat(extra) {
    // 不到一分钟别写「盯了 0 分」—— 那看着像没在跑
    var secs = S.startedAt ? Math.floor((Date.now() - S.startedAt) / 1000) : 0;
    var mins = secs >= 60 ? (Math.floor(secs / 60) + ' 分') : (secs + ' 秒');
    statEl.textContent = '盯了 ' + mins + ' · 发 ' + S.sent + ' 次 · 省 ' + S.skipped + ' 次' +
      (extra ? ' · ' + extra : '');
    paintTrend();
  }

  /* ---------------- 发一帧去问 ---------------- */
  function fire(why) {
    if (!S.running || S.inflight >= MAX_FLY) return;

    S.inflight++;
    peekBtn.disabled = true;
    setState('thinking', '看一眼…');
    /* 这里故意不清空灰字：清空会让那行字每 3 秒闪一次白，
       而它本来就只是「上一眼看到的情况」，新的回来再换。 */
    chefSet('think');

    var t0 = Date.now();
    var body;
    try {
      body = JSON.stringify({
        image: snap(),
        dish: S.dish,
        prev: S.lastSee,          // 上一次自己看到的 —— 有了它才说得出「比刚才深了」
        trend: trendText(),        // 像素算出来的变化量，给模型当参照
        deepen: deepening(),
        step: S.step || null,      // 停在第几步 —— 有它才说得出「糖还没化开」
        why: why                  // 哪个通道触发的（open/color/burst/hard/dim/drift/beat），排错用
      });
    } catch (e) {
      S.inflight--;
      if (!S.inflight) peekBtn.disabled = false;
      setState('err', '取画面失败');
      return;
    }

    fetch('/api/watch/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        return { ok: res.ok, status: res.status, d: d };
      });
    }).then(function (r) {
      if (!r.ok) {
        setState('err', r.d.error || ('出错了 ' + r.status));
        paintStat();
        return;
      }
      S.sent++;
      var level = r.d.level || 'quiet';
      var tip = String(r.d.tip || '').trim();
      var see = String(r.d.see || '').trim();
      S.lastSee = see;
      /* 镜头没对准锅，是这套东西最常见的失败方式：手机放歪了、锅不在框里、
         被自己的手挡住。模型每帧都会说「看不清」，可用户在灶台边看不到这行字，
         只会觉得它一直不说话、好像坏了。连续三眼都看不清就直接开口教他摆一下。 */
      if (/看不清|模糊|没对准|挡住|看不到锅|不像在做饭/.test(see)) {
        S.blind++;
        /* 三眼都看不清就说一次；说了还不改就别急着念 —— 两分钟内只提一次。
           反复念同一句，人只会觉得它坏了。 */
        if (S.blind >= 3 && Date.now() - S.blindAt > 120000) {
          S.blindAt = Date.now();
          S.blind = 3;
          say('镜头好像没对着锅，挪一下手机，让它能看见锅里。', 'notice');
        }
      } else {
        S.blind = 0;
      }

      /* 说了话就把「安静计数」清零 —— 下一拍立刻恢复 3.5 秒的灵敏。
         说没事就累加，连续两次之后追问频率自动降下来。 */
      S.quietStreak = level === 'quiet' ? S.quietStreak + 1 : 0;

      /* 屏幕上的状态每次都更新（用户抬头一眼要看到最新判断），
         但出声、震动、往列表里记，同一档位冷却期内只做一次。
         实测过：锅冒烟那几十秒里模型每帧都报 danger，四秒一句重复话，
         不这么压一下，人会直接关掉这个功能。 */
      if (level === 'danger') {
        setState('danger', '⚠ 注意');
        /* 静音时它不出声，就把该做什么放在灰字里 —— 别让人什么都看不到 */
        setSee(chefEl && chefEl.classList.contains('mute') ? (tip || '先关火') : see, 'danger');
        chefJump();
        if (mayVoice('danger')) {
          vibrate([90, 60, 90, 60, 180]);
          beep(880, 0.18);
          setTimeout(function () { beep(660, 0.22); }, 200);
          say(tip || '先关火看一眼', 'danger');
        }
      } else if (level === 'notice') {
        setState('notice', '提醒');
        setSee(chefEl && chefEl.classList.contains('mute') ? tip : see);
        if (mayVoice('notice')) {
          vibrate([45]);
          say(tip, 'notice');
        }
      } else {
        // 有观察就如实显示观察，别硬加一句「看着正常」——看不清的时候那两句会打架
        setState('', '盯着');
        setSee(see);
      }
      paintStat('本次 ' + (Date.now() - t0) + 'ms');
    }).catch(function () {
      setState('err', '网络断了，等下再试');
      paintStat();
    }).then(function () {
      S.inflight--;
      if (!S.inflight) peekBtn.disabled = false;
      chefIdle();
    });
  }

  /* 发帧之前先过一道闸：太密就等，发太多就降频。
     限额 900 帧/小时，但一顿饭不该花掉几百帧 —— 油在滚、水在翻的时候
     画面每秒都在变，像素只知道「在动」，不知道「在动但没事」。
     所以让模型的回答来回调频率：连续说没事就自己慢下来，一旦说了话立刻恢复灵敏。

     两档有豁免：
       color  真的在变色 —— 煎炸类最该主动开口的就是这件事，只受最短间隔约束；
       hard   0.8 秒内整块剧变（翻面、泼出来、火苗窜起），不管前面安静了多久。
     「看不见了」(dim) 反而要压着：镜头被挡、灯关了，这时候没有动作可给，
     急着开口只会变成噪音。 */
  function gateOpen(kind) {
    var now = Date.now();
    var since = now - S.lastSentAt;
    var streak = S.quietStreak;
    var gap;

    if (kind === 'color' || kind === 'hard') gap = MIN_GAP;
    else if (kind === 'burst' || kind === 'dim') gap = streak >= 2 ? 6000 : MIN_GAP;
    else gap = streak >= 2 ? 10000 : (streak >= 1 ? 6000 : MIN_GAP);

    if (since < gap) return false;
    S.sentLog = S.sentLog.filter(function (t) { return now - t < 60000; });
    if (S.sentLog.length >= BUDGET_N) return since >= BUDGET_MS;
    return true;
  }
  function markSent() {
    S.lastSentAt = Date.now();
    S.sentLog.push(S.lastSentAt);
    if (S.sentLog.length > 60) S.sentLog.shift();
  }

  /* ---------------- 趋势：它现在是在「变深」还是「没动」 ----------------
     这是从「报状态」变成「报变化」的关键。模型每帧独立看，只能说「现在挺深的」；
     知道 90 秒前什么样，才说得出「比刚才深了一档」——那才是旁边站着个人的样子。

     记的是「食材区」（饱和度最高的 4 块）的色相/亮度/饱和，每 0.8 秒一条。
     为什么不记全画面：背景占了大半，它不动，会把变化稀释成看不出来。 */
  var TREND_SEC = 90;

  function track(fs) {
    S.hist.push({ t: Date.now(), hue: fs.hue, lum: fs.lum, sat: fs.sat });
    // 420 条 × 0.8 秒 ≈ 5.6 分钟，一顿饭够了；再多只是占内存
    while (S.hist.length > 420) S.hist.shift();
  }

  function trendNow() {
    if (S.hist.length < 8) return null;
    var now = S.hist[S.hist.length - 1];
    var want = now.t - TREND_SEC * 1000;
    var old = null;
    for (var i = S.hist.length - 2; i >= 0; i--) {
      if (S.hist[i].t <= want) { old = S.hist[i]; break; }
    }
    /* 刚开火那两分钟没有 90 秒前的记录，就用最早的那条。
       但跨度至少 20 秒 —— 太近的两次相比只是在看噪声。 */
    if (!old) {
      old = S.hist[0];
      if (now.t - old.t < 20000) return null;
    }

    var dh = now.hue - old.hue;
    if (dh > 180) dh -= 360;               // 色相是环形的，359° → 1° 只走了 2°
    if (dh < -180) dh += 360;
    var dl = (now.lum - old.lum) / Math.max(old.lum, 1) * 100;
    var ds = (now.sat - old.sat) / Math.max(old.sat, 0.01) * 100;
    return { dh: dh, dl: dl, ds: ds, sec: Math.round((now.t - old.t) / 1000) };
  }

  function trendText() {
    var t = trendNow();
    if (!t) return '';
    var parts = [];
    if (Math.abs(t.dh) >= 2) parts.push('色相 ' + (t.dh > 0 ? '+' : '') + t.dh.toFixed(1) + '°');
    if (Math.abs(t.dl) >= 4) parts.push('亮度 ' + (t.dl > 0 ? '+' : '') + Math.round(t.dl) + '%');
    if (Math.abs(t.ds) >= 6) parts.push('饱和 ' + (t.ds > 0 ? '+' : '') + Math.round(t.ds) + '%');
    if (!parts.length) return '';
    return '比 ' + t.sec + ' 秒前 ' + parts.join('、');
  }

  /* 颜色在持续单向变化（不是抖一下）。
     90 秒里色相走出去 5° 以上，只有真在上色、真在变黄才会这样 ——
     手机白平衡是慢慢来回摆的，走不了这么远。 */
  function deepening() {
    var t = trendNow();
    return !!(t && Math.abs(t.dh) >= 5);
  }

  function paintTrend() {
    if (!trendEl) return;
    var s = trendText();
    trendEl.textContent = s;
    trendEl.hidden = !s;
  }

  /* ---------------- 探针：0.8 秒一拍 ----------------
     只回答一个问题：「现在该不该问一句」。不该问就什么都不做。 */
  function probe() {
    if (!S.running) return;
    if (video.readyState < 2 || !video.videoWidth) return;

    S.frames++;
    var f = sampleFrame();

    var fs = foodStats(f);
    if (fs.ok) track(fs);

    // 第一拍没有基准，直接问一次（开场得知道锅里现在什么样）
    if (!S.prevF) {
      S.prevF = f;
      S.refF = f;
      if (gateOpen('color')) { markSent(); fire('open'); }
      return;
    }

    var dPrev = blkDiff(f.gray, S.prevF.gray);     // 0.8 秒内：抓突变（冒烟、翻面、水扑出来）
    var dRef = blkDiff(f.gray, S.refF.gray);       // 距上次问：抓累计（慢慢收汁、慢慢上色）
    var hPrev = hueShift(f, S.prevF);              // 0.8 秒内的颜色变化
    var hRef = hueShift(f, S.refF);                // 距上次问的颜色变化

    /* 突变阈值跟着灵敏度滑块走。分块取 max 本来就比全画面平均大好几倍，
       所以乘 5 而不是 1 —— 不然调到 3 等于原来调到 0.6，一直在问。 */
    var burstThr = Math.max(8, S.sens * 5);

    /* 手机自动白平衡会让整幅画面的色相一起偏，那不是菜在变色。
       特征：几乎所有块同号，而且幅度不大。真的上色只发生在食材那几块。 */
    var tint = hRef.same >= 0.85 && hRef.top < 10;

    /* 「看不见了」：画面整体突然黑掉或突然过曝，而且颜色并没有跟着变。
       这里**不用**分块灰度，改看整体亮度比 —— 实测上色时 0.8 秒的灰度峰能到 13，
       用它当判据会把慢慢变褐的画面误判成「看不见了」（踩过，整段上色全被判成 dim）。
       整体亮度比只看「这一下是不是被挡了 / 灯是不是灭了」，跟慢变化天然分开。
       实测：手挡镜头 0.8 秒内亮度比 0.12；正常上色 0.97~0.99。 */
    var lumRatio = f.lum / Math.max(S.prevF.lum, 1);
    var dim = (lumRatio < 0.7 || lumRatio > 1.55) && hPrev.top < 2.5;

    /* 「变色」：色相真的动了。
       菜变黄 21°、肉变褐 4.4°，阈值 3.5° 落在中间；
       光暗 0.3° / 蒸汽 0.5° / 挡镜头 0.0° 全在阈值以下，不会误报。
       整体偏色（白平衡）时不直接否掉，只把门槛抬到 8° —— 镜头怼着锅的时候
       整幅画面都是菜，真上色也会「所有块一起变」，跟白平衡长得一样，只能用幅度区分。 */
    var colorNow = hRef.top >= (tint ? 8 : 3.5);
    var colorHot = hRef.top >= 9 && hPrev.same < 0.85;

    var kind = '';
    if (colorHot) kind = 'color';                  // 一秒内颜色明显跳变
    else if (dim) kind = 'dim';
    else if (colorNow) kind = 'color';             // 慢慢上色，累计到阈值
    else if (dPrev.max >= burstThr * 3) kind = 'hard';
    else if (dPrev.max >= burstThr) kind = 'burst';
    else if (dRef.avg >= S.sens) kind = 'drift';
    else if (Date.now() - S.lastSentAt >= S.every) kind = 'beat';

    var dbg = '色差 ' + hRef.top.toFixed(1) + '°';

    /* 调试口子：只在手动把 __FQ_DEBUG 置真时才写，用来量阈值。
       正常跑不会有这个对象，也不影响任何判断。 */
    if (window.__FQ_DEBUG) {
      (window.__dbg = window.__dbg || []).push({
        t: Date.now(),
        gp: +dPrev.max.toFixed(1), ga: +dRef.avg.toFixed(1), lr: +lumRatio.toFixed(2),
        hp: +hPrev.top.toFixed(1), hr: +hRef.top.toFixed(1),
        same: +hRef.same.toFixed(2), tint: tint, dim: dim,
        cn: colorNow, ch: colorHot, kind: kind
      });
      if (window.__dbg.length > 400) window.__dbg.shift();
    }

    if (!kind) {
      S.prevF = f;                                 // 平静：基线跟上，下一拍还是比 0.8 秒
      S.skipped++;
      paintStat(dbg);
      return;
    }

    if (!gateOpen(kind)) {
      /* 有情况但刚问过。这里故意 **不更新 prevF** —— 让这次变化一直挂着，
         闸一开就按原本的强度发出去。更新了的话下一拍就跟新画面比，差异归零，
         一次剧变就被悄悄降级成「缓慢变化」，然后被安静降频压到十秒。 */
      setState('', '刚看过一眼');
      paintStat(dbg);
      return;
    }

    S.prevF = f;
    S.refF = f;                                    // 「上次问的时候的画面」，渐进变化靠它累积
    markSent();
    fire(kind);
  }

  /* ---------------- 开关 ---------------- */
  function keepAwake() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (w) {
      S.wake = w;
    }).catch(function () {});
  }

  function releaseAwake() {
    try { if (S.wake) { S.wake.release(); S.wake = null; } } catch (e) {}
  }

  function stopTracks() {
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      S.stream = null;
    }
    if (video.srcObject) video.srcObject = null;
  }

  function stopAll() {
    S.running = false;
    if (S.probeTimer) { clearInterval(S.probeTimer); S.probeTimer = null; }
    if (S.clockTimer) { clearInterval(S.clockTimer); S.clockTimer = null; }
    stopTracks();
    releaseAwake();
    if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
    if (voice.timer) { clearTimeout(voice.timer); voice.timer = 0; }
    voice.busy = false; voice.q = null; voice.seq++;
  }

  function errText(e) {
    var n = e && e.name ? e.name : '';
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return '浏览器没给摄像头权限。检查地址栏左边那个锁，把摄像头打开再试。';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') {
      return '没找到可用的后置摄像头。';
    }
    if (n === 'NotReadableError') {
      return '摄像头被别的 App 占着（比如相机、微信视频）。先关掉它们再试。';
    }
    return '打不开摄像头：' + (e && e.message ? e.message : '原因不明');
  }

  function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('这个浏览器不给用摄像头。多半是页面不是 https 打开的 —— 手机上必须用 https 地址。');
      return;
    }

    S.dish = ($('#dish').value || '').trim();
    S.every = Number($('#every').value) * 1000 || 15000;
    S.sens = Number($('#sens').value) || 3;
    S.frames = 0; S.sent = 0; S.skipped = 0;
    S.prevF = null; S.refF = null; S.hist = []; S.lastSee = '';
    S.lastSentAt = 0; S.sentLog = [];
    S.quietStreak = 0;
    S.inflight = 0;
    S.lastSay = { text: '', at: 0 };
    S.voiced = { level: '', at: 0 };
    S.startedAt = Date.now();
    S.lastTalkAt = 0;
    S.lastAlive = S.startedAt;   // 报平安的计时从点火那一刻算起
    S.blind = 0;
    S.spoke = false;

    setState('', '开摄像头…');
    setSee('');

    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 640 },
        height: { ideal: 480 }
      }
    }).then(function (stream) {
      S.stream = stream;
      video.srcObject = stream;
      return video.play().catch(function () {});
    }).then(function () {
      setup.hidden = true;
      stage.hidden = false;
      document.body.classList.add('on-stage');
      /* 宽度从 96 过渡到 116，rect 在这 300ms 里一直在变，
         所以进画面时判一次、过渡完再判一次。 */
      relayout();
      setTimeout(relayout, 360);
      S.running = true;

      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC && !actx) actx = new AC();
        if (actx && actx.state === 'suspended') actx.resume();
      } catch (e) {}

      keepAwake();
      setState('', '盯着');
      paintStat();
      /* 第一句话兼三个作用：证明声音是通的、证明它在看、给一句「有事我喊你」的承诺。
         用户这会儿手已经湿了，不会研究界面 —— 听见人声，才知道这功能成了。
         也顺便验了 TTS：有些机型根本没装中文语音引擎，早发现比炒到一半才发现好。 */
      setTimeout(function () {
        if (!S.running) return;
        /* 带菜名说一句：人立刻知道「它记得我填的是啥」。
           这是最便宜的一次「它知道我在干嘛」—— 比任何解释都有效。 */
        say(S.dish ? (S.dish + '是吧，我盯着了，有事我喊你。')
                   : '我盯着了，你忙你的，有事我喊你。', 'notice');
      }, 600);
      /* 有的安卓机没装中文语音引擎：不报错，也不出声，只是安静。
         用户分不清「它没事」和「它哑了」，会一直等一个永远不会来的提醒。
         开火四秒后验一次，没出过声就当面说破。 */
      setTimeout(function () {
        if (S.running && !S.spoke && !voice.busy) {
          bubble('这台手机好像出不了声，可能没装中文语音。字还会弹，抬头看屏幕。', 'tip', 7000);
        }
      }, 4200);
      /* 「能拖」这件事在开始页提示没用 —— 那里没锅可挡，气泡还会压住说明文字。
         真正该教的地方是刚进盯锅画面这一刻：人像正站在画面上，脚下就是锅。 */
      /* 「能拖」「能甩」这件事不教就没人会试。
         判断依据换成「有没有存过位置」：没摆过 = 还不知道，每次进画面都该再说一遍；
         摆过 = 已经会了，不再啰嗦。
         （原来只提示一次，还写了 fq.chef.hint 标记 —— 刷新一次就再也看不到了。） */
      try {
        if (!localStorage.getItem('fq.chef.pos')) {
          /* 教「能拖能甩」这件事，但不能插队：它正在说锅里的事时，教学提示得让路 ——
             锅要糊的时候没人想听怎么拖图标。所以轮询等它把话说完再教。 */
          var tipTries = 0;
          setTimeout(function teach() {
            if (!S.running) return;
            if ((voice.busy || voice.q) && tipTries++ < 8) { setTimeout(teach, 1500); return; }
            if (chefEl.classList.contains('mute')) return;
            bubble('按住我，拖到不挡锅的地方；甩一下，我会滑过去。', 'tip', 6200);
            chefSet('talk', 2600);
          }, 8000);
        }
      } catch (err) {}
      S.probeTimer = setInterval(probe, PROBE_MS);
      setTimeout(probe, 300);       // 别让人干等第一眼
      // 分钟数自己往上走，不然只有发帧时才会刷新
      S.clockTimer = setInterval(function () {
        if (!S.running) return;
        paintStat();
        aliveTick();
      }, 5000);
    }).catch(function (e) {
      setState('err', '开不了摄像头');
      alert(errText(e));
    });
  }

  /* ---------------- 事件 ---------------- */
  $('#start').addEventListener('click', start);

  $('#tts').addEventListener('click', function () {
    var t = '锅里的汤汁收得差不多了，火可以关小一点。';
    if (!('speechSynthesis' in window)) {
      alert('这个浏览器不支持直接说话。屏幕上还是会有字，只有提醒音。');
      return;
    }
    speak(t, 'notice');
    // 中文语音引擎缺失时它不报错也不出声，只能提醒用户自己判断
    setTimeout(function () {
      if (!speechSynthesis.speaking && !speechSynthesis.pending) {
        alert('没听到声音？这台设备的浏览器可能没装中文语音引擎。文字提醒照常工作。');
      }
    }, 1200);
  });

  $('#sens').addEventListener('input', function () {
    $('#sens-v').textContent = Number(this.value).toFixed(1);
  });

  peekBtn.addEventListener('click', function () {
    /* 这里绝对不能把 refF 置空：下一拍探针就要拿它算差分，
       null 一进去就是 null.gray，interval 里抛异常，整个探针从此停摆。
       手动这一帧本来就不经过探针，置空没有任何好处。 */
    markSent();                     // 手动也算一次，否则探针会紧接着又发一帧
    fire('manual');
  });

  $('#stop').addEventListener('click', function () {
    stopAll();
    ballStop();              // 它可能正被甩在半空，停盯锅就别继续飞了
    chefSet('idle');
    document.body.classList.remove('on-stage');
    relayout();
    setTimeout(relayout, 360);
    stage.hidden = true;
    setup.hidden = false;
    setState('', '准备中');
    setSee('');
    paintStat();
  });

  /* 切到后台就停：相机一直开着最容易被当成「在偷拍」，
     而且后台拿不到帧、只会空转耗电。 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && S.running) {
      stopAll();
      ballStop();            // 后台 rAF 会暂停，回来时别让它从半空接着飞
      document.body.classList.remove('on-stage');
      relayout();
      setTimeout(relayout, 360);
      stage.hidden = true;
      setup.hidden = false;
      setState('err', '已暂停');
      setSee('切到后台就停了，回来重新点一次「开始盯着」。');
    }
  });

  window.addEventListener('pagehide', function () {
    stopTracks();
    releaseAwake();
  });

  /* 只在 ?debug=1 时把内部方法露出来，方便无头浏览器验气泡和拖动 ——
     线上演示页不带这个参数，什么都摸不到。 */
  if (/[?&]debug=1/.test(location.search)) {
    document.body.classList.add('debug');   // 统计数字和色差只在这时露出来
    window.__fq = { speak: speak, bubble: bubble, moveTo: moveTo, chefEl: chefEl, setSee: setSee, relayout: relayout, fling: fling };
  }
})();
