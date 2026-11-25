/* 小饭 · 陪着做（可选功能层）
   ---------------------------------------------------------------
   和「照着做一遍」并列，不是替代它：用户进做饭模式后自己决定要不要开。

   为什么单独一个文件、单独一层（body 直属 fixed）：
     paintCook() 是整屏 innerHTML 重绘（翻一步就重绘一次），
     video 只要进了那棵树，每翻一步就会被销毁重建 —— 画面黑一下再回来，
     安卓上还会把摄像头重新协商一遍。所以视频必须活在重绘够不着的地方。

   这一层只做三件事：看（摄像头发帧）、说（语音队列）、站在那儿（形象 + 气泡）。
   步骤、计时、食谱仍然归 app.js 的 cook 层管，这里不碰。
*/
(function () {
  'use strict';

  var FRAME_API = '/api/watch/frame';
  var POS_KEY = 'fq.chef.win';
  var MUTE_KEY = 'fq.chef.mute';
  var MIN_GAP = 2400;      // 两次发帧最短间隔（有变化时）
  var QUIET_GAP = 5000;    // 连续几次都没事，可以放慢一点（但别放太慢）
  var BEAT_GAP = 9000;     // 画面一直没变，也要隔一会儿看一眼
  var PEEK_MS = 800;       // 多久抓一次缩略图比对
  /* 单拍变化 vs 累积变化，两个都要看：
     单拍 = 和上一张缩略图比，抓「一下子」的变化（冒烟、翻面、加水）。
     累积 = 和**上一次真正发出去的帧**比，抓「慢慢来的」变化（肉一块块变黑、
            汤汁一点点收干）。只比单拍的话，煎肉从棕到黑每 800ms 只差 1~2，
            永远达不到阈值，人就只能等那条 20 秒的兜底 —— 肉早糊了。 */
  var STEP_DIFF = 3.4;
  var ACC_DIFF = 7;
  var TAP_GAP = 1200;      // 「立刻看」连点的最小间隔，防止一秒钟打十个请求

  var S = {
    open: false,
    dish: '',
    step: null,
    lastSee: '',
    sent: 0,
    inflight: 0,
    lastSentAt: 0,
    lastFireAt: 0,
    quietStreak: 0,
    blind: 0,
    blindAt: 0,
    mute: false,
    tickTimer: 0,
    lastTip: '',
    lastTipAt: 0,
    dragged: false,
    /* 时间感 + 记忆：模型只看单帧时，分不清「刚下锅」和「已经烧了四分钟」，
       也想不起自己两分钟前说过什么。这两个字段是「陪着你」和「每帧重新看一次」的分界线。 */
    startedAt: 0,      // 这次开着的起点
    stepAt: 0,         // 当前这一步的起点
    spokeAt: 0,        // 上次真正开口（notice/danger）的时间
    hist: [],          // 最近三次观察，最多留三条
    tap: false         // 这一帧是不是用户亲手点的「立刻看」
  };

  var el = null, win = null, video = null, chefEl = null, bubEl = null, stEl = null, seeEl = null;
  var latEl = null;
  var stream = null, snapCv = null, miniCv = null;
  var cam = { w: 0, h: 0, facing: '', track: null };
  var voice = { busy: false, waiting: null, seq: 0 };
  var bubT = 0, chefT = 0;

  /* ---------------- 小工具 ---------------- */

  function beep(freq, dur, gain) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!beep.ac) beep.ac = new AC();
      var ac = beep.ac;
      if (ac.state === 'suspended') ac.resume();
      var o = ac.createOscillator();
      var g = ac.createGain();
      var t = ac.currentTime;
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.2));
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + (dur || 0.2) + 0.02);
    } catch (e) { /* 播不了就算了，还有字 */ }
  }

  function vibrate(p) {
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* 忽略 */ }
  }

  /* ---------------- DOM ---------------- */

  function ensureDom() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'fq-chef';
    el.innerHTML =
      '<div class="fqc-win" role="group" aria-label="小饭正在看着锅">' +
        '<div class="fqc-shot">' +
          '<video class="fqc-v" playsinline muted autoplay></video>' +
          /* 常驻的「它看到什么」。原来只有底部栏那一行 10.5px 的半透明白字，
             灶台边一米外等于没有 —— 用户开完只觉得「就是能看摄像头了」。
             这行是它一直在干活的证据，压在画面上方，不参与拖动判定。 */
          '<div class="fqc-see"></div>' +
          '<div class="fqc-bar">' +
            '<span class="fqc-st">盯着</span>' +
            /* 自动看是「它自己觉得有事才开口」；这一颗是「你让它现在看」。
               两件事都要有：前者省电省帧，后者是「我说了算」的那个按钮。 */
            '<button class="fqc-ic look" data-fqc="look" title="立刻看一眼">' + iconEye() + '</button>' +
            '<button class="fqc-ic" data-fqc="mute" title="静音">' + iconMute() + '</button>' +
            '<button class="fqc-ic" data-fqc="off" title="不让它看">' + iconOff() + '</button>' +
          '</div>' +
        '</div>' +
        '<img class="fqc-chef" src="/assets/chef/stand.webp?v=3" alt="">' +
        '<div class="fqc-bub" id="fqc-bub"></div>' +
        /* 延迟挂在窗口下沿：灶台边判断「是网慢还是镜头看不清」全靠这个数，
           但它不是给用户读的诗，所以只占一行 11px，不给它抢画面。 */
        '<div class="fqc-lat"></div>' +
      '</div>';
    document.body.appendChild(el);

    win = el.querySelector('.fqc-win');
    video = el.querySelector('.fqc-v');
    chefEl = el.querySelector('.fqc-chef');
    bubEl = el.querySelector('.fqc-bub');
    stEl = el.querySelector('.fqc-st');
    seeEl = el.querySelector('.fqc-see');
    latEl = el.querySelector('.fqc-lat');

    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-fqc]') : null;
      if (!b) return;
      var act = b.getAttribute('data-fqc');
      if (act === 'off') close();
      else if (act === 'mute') toggleMute();
      else if (act === 'look') lookNow();
    });

    /* 拖动：手上有油、手机架得远，写死一个角必然挡到一部分人的锅。
       这里只挪位置，不做甩动 —— 小窗是「窗户」，不是玩具。 */
    dragWin();
    /* 横竖屏切换、地址栏收起都会改视口高度；气泡是按视口算的，得跟着重算，
       否则一句正挂着的话会被挪到屏幕外 */
    window.addEventListener('resize', function () {
      if (bubEl && bubEl.classList.contains('on')) layoutBub();
    });

    snapCv = document.createElement('canvas');
    miniCv = document.createElement('canvas');
    miniCv.width = 48; miniCv.height = 48;
    restorePos();
  }

  function iconEye() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.7" fill="currentColor"/></svg>';
  }
  function iconMute() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8l5 8M21 8l-5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';
  }
  function iconOff() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
  }

  function restorePos() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { p = null; }
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
    place(p.x, p.y);
  }

  function place(x, y) {
    if (!win) return;
    var vw = window.innerWidth || 360;
    var vh = window.innerHeight || 640;
    var w = win.offsetWidth || 156;
    var h = win.offsetHeight || 206;
    /* 形象站在窗口上沿（bottom:100%），也是这一层的一部分。
       clamp 只按窗口算的话，窗口拖到屏幕顶上时人就整个在屏幕外了，
       用户会以为它消失了。气泡比人顶还高一点（长句子能到 30px），
       一起算进去，否则拖到最顶上第一行字就被屏幕切掉。 */
    var head = ((chefEl && chefEl.offsetHeight) || 88) + 30;
    x = Math.min(Math.max(2, x), Math.max(2, vw - w - 2));
    y = Math.min(Math.max(head + 2, y), Math.max(head + 2, vh - h - 2));
    win.style.left = x + 'px';
    win.style.top = y + 'px';
    win.style.right = 'auto';
    win.style.bottom = 'auto';
    /* 气泡的位置不在这里算：它是按视口固定的（layoutBub），窗口挪动不影响它。
       拖完如果正好还有话挂着，松手后重算一次就够。 */
  }

  function dragWin() {
    var d = { on: false, id: 0, sx: 0, sy: 0, ox: 0, oy: 0, moved: false };
    win.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      if (e.target.closest && e.target.closest('.fqc-ic')) return;   // 按钮不参与拖
      /* 电脑端要挡原生拖拽/选字，否则 pointermove 会被浏览器接管 */
      try { e.preventDefault(); } catch (err) {}
      /* 拖的时候先把话收起来：气泡位置是贴着人算的，跟着一路挪要不停重排，
         而且一扇窗子上挂着半句话也很吵。松手后下一句会重新贴回去。 */
      if (bubEl) bubEl.classList.remove('on');
      var r = win.getBoundingClientRect();
      d.on = true; d.moved = false; d.id = e.pointerId;
      d.sx = e.clientX; d.sy = e.clientY; d.ox = r.left; d.oy = r.top;
      try { win.setPointerCapture(e.pointerId); } catch (err) {}
    });
    win.addEventListener('pointermove', function (e) {
      if (!d.on || e.pointerId !== d.id) return;
      var dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 8) return;
      d.moved = true;
      win.classList.add('drag');
      place(d.ox + dx, d.oy + dy);
    });
    function end(e) {
      if (!d.on || (e && e.pointerId !== d.id)) return;
      d.on = false;
      win.classList.remove('drag');
      try { win.releasePointerCapture(d.id); } catch (err) {}
      if (d.moved) {
        S.dragged = true;
        var r = win.getBoundingClientRect();
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
        } catch (err) {}
      }
    }
    win.addEventListener('pointerup', end);
    win.addEventListener('pointercancel', end);
  }

  /* ---------------- 形象 / 气泡 ---------------- */

  function setSt(text, cls) {
    if (!stEl) return;
    stEl.textContent = text;
    stEl.className = 'fqc-st' + (cls ? ' ' + cls : '');
  }

  /* 没有新观察时该显示什么 —— 必须有字，空白就是「它是不是死了」 */
  function idleSee() {
    if (!S.open) return '';
    if (S.mute) return '静音中，画面还在看';
    /* 第一眼之前把镜头参数亮出来：换设备之后「看不清、慢」到底是分辨率还是网络，
       这一行就能分开。之后就不再占位，让给真正的观察。 */
    if (S.sent === 0) {
      return (cam.w ? (cam.w + '×' + cam.h + (cam.facing === 'user' ? ' 前置' : cam.facing ? ' 后置' : '') + ' · ') : '') +
        '刚开机，第一眼还没回来';
    }
    if (!S.lastSee) return S.step ? ('正在看第 ' + (S.step.i + 1) + ' 步') : '正在看锅里';
    return '没什么变化，我盯着';
  }

  function setSee(text) {
    if (!seeEl) return;
    var t = String(text || '').trim() || idleSee();
    seeEl.textContent = t;
    seeEl.classList.toggle('on', !!t);
  }

  function chefSet(s, ms) {
    if (!chefEl) return;
    chefEl.setAttribute('data-st', s);
    setFrame(s);
    if (chefT) { clearTimeout(chefT); chefT = 0; }
    if (ms) chefT = setTimeout(function () { chefSet('idle'); }, ms);
  }

  /* 姿态也是「状态」的一部分，不是随机播动画。
     stand  呼吸/说话/思考 —— 站着不动、在听你说话
     wave   招手 —— 第一次开、教你用
     point  指锅 —— 有件事要你动手（翻面、调火）
     alarm  双手举起来 —— 危险，先关火
     四张图同一个角色、同一个画布（460×577），换帧不会有任何位移。 */
  var FRAME_OF = { idle: 'stand', think: 'stand', talk: 'stand', notice: 'point', danger: 'alarm', greet: 'wave' };

  function setFrame(s) {
    if (!chefEl) return;
    var f = FRAME_OF[s] || 'stand';
    var url = '/assets/chef/' + f + '.webp?v=3';
    if (chefEl.getAttribute('src') !== url) chefEl.setAttribute('src', url);
  }

  /* 换姿势前先解码，否则第一次切过去会闪一下白 */
  function warmFrames() {
    ['stand', 'wave', 'point', 'alarm'].forEach(function (f) {
      var im = new Image();
      im.src = '/assets/chef/' + f + '.webp?v=3';
    });
  }

  /* 气泡按**视口**定位，不跟窗口绑死。
     窗口为了不挡步骤，常被拖到屏幕上方；气泡要是还挂在窗口上沿，
     长句子往上长，第一行直接长到屏幕外（实测 top = -75）。
     用户的原话就是「字多时会看不到字」。
     顺序：贴头顶往上长 → 上方放不下转到脸的一侧 → 侧边也不够就缩字号 → 最后才夹进屏幕。
     无论哪种，「字一个都不能少」优先于「字号好看」。 */
  var BUB_PAD = 8;
  function layoutBub() {
    if (!bubEl || !chefEl || !win) return;
    var vw = window.innerWidth || 360;
    var vh = window.innerHeight || 640;
    var cr = chefEl.getBoundingClientRect();
    /* 脸的位置：横向偏右一点（尾巴落点），纵向在头的中部偏下 */
    var faceX = cr.left + cr.width * 0.58;
    var faceY = cr.top + cr.height * 0.5;

    bubEl.style.width = 'auto';
    bubEl.style.minHeight = '0';
    bubEl.style.maxHeight = 'none';
    bubEl.classList.remove('below', 'bub-right');

    var maxW = Math.min(300, Math.max(160, Math.round(vw * 0.72)));
    var sizes = [15, 14.5, 14, 13.5, 13];
    var room = vh - BUB_PAD * 2;
    /* 超过半屏的框会把人埋了：宁可字号小一档，也不能让一屏有半屏是气泡 */
    var soft = Math.round(vh * 0.52);
    var bw = 0, bh = 0, x = 0, y = 0, right = false, below = false, side = false;

    function measure() {
      bw = bubEl.offsetWidth || 120;
      bh = bubEl.offsetHeight || 36;
    }

    for (var si = 0; si < sizes.length; si++) {
      bubEl.style.fontSize = sizes[si] + 'px';
      bubEl.style.maxWidth = maxW + 'px';
      measure();
      below = false; right = false; side = false;

      var upTop = cr.top - 8 - bh;                 // 头顶往上
      if (upTop >= BUB_PAD) {
        x = faceX + 8 - bw;                        // 气泡右缘越过脸一点，尾巴落在脸侧
        if (x < BUB_PAD) { x = faceX - 8; right = true; }
        y = upTop;
      } else {
        var roomL = cr.left - BUB_PAD - 6;
        var roomR = vw - cr.right - BUB_PAD - 6;
        if (roomL >= 110 || roomR >= 110) {
          /* 站到脸的一侧，和嘴同高。宽度必须收到那一侧真正剩下的空间里 ——
             否则一夹回屏幕内，气泡就压在脸上（62 个字时实测压住半个头）。 */
          right = roomR > roomL;
          bubEl.style.maxWidth = Math.min(maxW, Math.max(110, right ? roomR : roomL)) + 'px';
          measure();
          x = right ? (cr.right + 6) : (cr.left - 6 - bw);
          y = Math.round(faceY - bh / 2);
          side = true;
        } else {
          /* 两侧都塞不下：放到人下方，尾巴朝上 */
          x = faceX + 8 - bw;
          if (x < BUB_PAD) { x = faceX - 8; right = true; }
          y = cr.bottom + 4;
          below = true;
        }
      }
      /* 夹进视口。尾巴跟着挪，别让它离开脸那一列，否则指向就假了 */
      var cx = Math.min(Math.max(BUB_PAD, x), Math.max(BUB_PAD, vw - bw - BUB_PAD));
      var cy = Math.min(Math.max(BUB_PAD, y), Math.max(BUB_PAD, vh - bh - BUB_PAD));
      if (bh <= Math.min(room, soft)) { x = cx; y = cy; break; }
    }

    bubEl.classList.toggle('bub-right', right);
    bubEl.classList.toggle('below', below);
    bubEl.classList.toggle('side', side);
    if (side) {
      /* 尾巴横向没有意义（气泡在脸的一侧），按脸的高度定竖向位置 */
      var ty = Math.round(faceY - y);
      bubEl.style.setProperty('--tail-y', Math.min(Math.max(14, ty), Math.max(14, bh - 14)) + 'px');
    } else {
      /* 尾巴水平位置：让它尽量指着脸，但别落到圆角外 */
      var tail = right ? (faceX - x) : (x + bw - faceX);
      tail = Math.min(Math.max(12, tail), Math.max(12, bw - 12));
      bubEl.style.setProperty('--tail-x', Math.round(tail) + 'px');
    }
    bubEl.style.left = Math.round(x) + 'px';
    bubEl.style.top = Math.round(y) + 'px';
    /* 量完就按这个宽度定死。后面逐字填字时盒子不再变 —— 既不会抖，
       也不会有「量的时候 280、真显示 272，靠右那句被挤到屏幕边上」的偏差。 */
    bubEl.style.width = bw + 'px';
    bubEl.style.minHeight = bh + 'px';
  }

  /* 一句一句往外蹦，像说出来，而不是整段刷在屏幕上。
     字号、宽度先按整句量好并冻住，再逐字填 —— 否则每加一个字都要重排，
     气泡会一边抖一边长。危险的句子不做打字机：救命的话必须一眼看完。 */
  var typeT = 0;
  function typewrite(text, speed) {
    if (typeT) { clearInterval(typeT); typeT = 0; }
    var i = 0;
    bubEl.textContent = '';
    typeT = setInterval(function () {
      i += 1;
      bubEl.textContent = text.slice(0, i);
      if (i >= text.length) { clearInterval(typeT); typeT = 0; }
    }, speed);
  }

  function bubble(text, level, ms) {
    if (!bubEl || !text) return;
    if (typeT) { clearInterval(typeT); typeT = 0; }
    var lv = (level === 'danger' || level === 'notice' || level === 'tip') ? level : '';
    /* 先按整句量：宽度定死、最小高度定死，逐字填的时候盒子不动 */
    bubEl.className = 'fqc-bub' + (lv ? ' ' + lv : '');
    bubEl.textContent = text;
    bubEl.classList.add('on');
    /* layoutBub 会把宽度和高度按整句量好并定死，所以这里可以放心逐字填 */
    layoutBub();
    if (!lv) {
      typewrite(text, Math.max(24, Math.min(58, Math.round(1800 / Math.max(4, text.length)))));
    }
    if (bubT) clearTimeout(bubT);
    var dur = Math.max(2400, (ms || Math.min(9000, 900 + text.length * 180)));
    bubT = setTimeout(function () {
      bubEl.classList.remove('on');
      if (typeT) { clearInterval(typeT); typeT = 0; }
      bubEl.style.width = 'auto';
      bubEl.style.minHeight = '0';
    }, dur + 500);
  }

  /* ---------------- 说话 ----------------
     队列而不是「新的一句直接盖掉旧的」：盖掉的结果是人只听到半句
     「把火……」，比不说更上火。只有危险能打断。
     onend 在部分机型上被 cancel 打断时不派发，所以按字数兜底计时。 */
  function speak(text, level) {
    if (!text) return;
    if (S.mute && level !== 'danger') return;
    var app = window.FQNative;
    if (app && typeof app.speak === 'function') {
      try { app.speak(text); return; } catch (e) { /* 落到网页 */ }
    }
    if (!('speechSynthesis' in window)) return;
    if (level === 'danger') {
      try { speechSynthesis.cancel(); } catch (e) {}
      voice.busy = false;
      voice.waiting = null;
    }
    if (voice.busy) { voice.waiting = { text: text, level: level }; return; }
    voice.busy = true;
    var my = ++voice.seq;
    var start = function () {
      try {
        var u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = 1.02;
        var guard = setTimeout(function () { done(my); }, 1200 + text.length * 320);
        function done(tok) {
          if (tok !== my) return;
          clearTimeout(guard);
          if (voice.seq !== my) return;
          voice.busy = false;
          var w = voice.waiting;
          voice.waiting = null;
          if (w) speak(w.text, w.level);
        }
        u.onend = function () { done(my); };
        u.onerror = function () { done(my); };
        speechSynthesis.speak(u);
      } catch (e) {
        voice.busy = false;
      }
    };
    start();
  }

  /* app.js 点「读一遍」时要先把这边的嘴闭上，否则两个 TTS 抢焦点 */
  function hush() {
    voice.busy = false;
    voice.waiting = null;
    voice.seq++;
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) {}
  }

  function say(text, level, ms) {
    var t = String(text || '').trim();
    if (!t) return;
    bubble(t, level, ms);
    /* 说什么话配什么姿势：危险举手、提醒指锅、平时站着说 */
    chefSet(level === 'danger' ? 'danger' : level === 'notice' ? 'notice' : 'talk',
      Math.min(9000, 1200 + t.length * 260));
    speak(t, level);
  }

  /* ---------------- 摄像头 ---------------- */

  function startCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('NO_API'));
    }
    var want = {
      audio: false,     // 这一版只说不听 —— 绝不悄悄开麦克风
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };
    return navigator.mediaDevices.getUserMedia(want).then(function (s) {
      stream = s;
      video.srcObject = s;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});

      /* 把镜头实际给的参数记下来。
         「换了个摄像头之后不准」这种事，靠猜没有意义 —— 有的 WebView 会
         无视 facingMode 直接开前置，有的只肯给 640×480。
         记下来之后，界面上能直接看到「多少像素、前后哪个」。 */
      try {
        var t = s.getVideoTracks()[0];
        var st = (t && t.getSettings) ? t.getSettings() : {};
        cam.track = t || null;
        cam.w = st.width || video.videoWidth || 0;
        cam.h = st.height || video.videoHeight || 0;
        cam.facing = st.facingMode || '';
      } catch (e) { cam.track = null; }

      /* 近拍对焦：手机架在锅边十几厘米，固定焦距必然糊。
         浏览器一般会自己连续对焦，WebView 里不一定 —— 要一次，失败就算了。 */
      try {
        if (cam.track && cam.track.applyConstraints) {
          cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
        }
      } catch (e) {}

      return s;
    });
  }

  function stopCam() {
    if (stream) {
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      stream = null;
    }
    try { if (video) video.srcObject = null; } catch (e) {}
  }

  /* ---------------- 抓帧 / 比对 ---------------- */

  function snap() {
    var vw = video.videoWidth || 0, vh = video.videoHeight || 0;
    if (!vw || !vh || video.readyState < 2) return '';
    /* 上限 1024、质量 0.78：原来的 896/0.72 在「手机架得远、锅只占一小块」时，
       模型看到的糖色和气泡已经是一条糊边了。这是「看得不准」里唯一能自己动手改的一半。 */
    var w = vw, h = vh, MAX = 1024;
    if (Math.max(w, h) > MAX) {
      var k = MAX / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    snapCv.width = w; snapCv.height = h;
    try {
      snapCv.getContext('2d').drawImage(video, 0, 0, w, h);
      return snapCv.toDataURL('image/jpeg', 0.78);
    } catch (e) { return ''; }
  }

  /* 缩略图比对：只看「有没有明显变化」，不看细节。
     纯像素没法区分「在动但没事」和「该提醒了」，所以它只负责少发帧，
     判断交给模型 —— 和演示页同一个思路。 */
  var prevMini = null;      // 上一拍
  var lastSentMini = null;  // 上一次真正发出去的那一帧（累积对比的基准）

  function mini() {
    var vw = video.videoWidth || 0, vh = video.videoHeight || 0;
    if (!vw || !vh || video.readyState < 2) return null;
    var g = miniCv.getContext('2d');
    try { g.drawImage(video, 0, 0, 48, 48); } catch (e) { return null; }
    var d;
    try { d = g.getImageData(0, 0, 48, 48).data; } catch (e) { return null; }
    var sum = 0, n = 48 * 48;
    var lum = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var l = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114);
      lum[i] = l;
      sum += l;
    }
    return { lum: lum, avg: sum / n };
  }

  function diffScore(a, b) {
    if (!a || !b) return 99;
    var s = 0;
    for (var i = 0; i < a.lum.length; i++) s += Math.abs(a.lum[i] - b.lum[i]);
    return s / a.lum.length;
  }

  function tick() {
    if (!S.open || document.hidden) return;
    var m = mini();
    if (!m) return;
    var step = prevMini ? diffScore(m, prevMini) : 99;      // 一下子变了（冒烟、翻面、加水）
    var acc = lastSentMini ? diffScore(m, lastSentMini) : 0; // 慢慢变了（肉一块块发黑、汤汁收干）
    prevMini = m;
    var now = Date.now();
    var gap = now - S.lastSentAt;
    var quiet = S.quietStreak >= 3;
    if (gap < (quiet ? QUIET_GAP : MIN_GAP)) return;
    if (step > STEP_DIFF || acc > ACC_DIFF) fire('change');
    else if (gap > BEAT_GAP) fire('beat');
  }

  /* ---------------- 发帧 ---------------- */

  function fire(why) {
    if (!S.open) return;
    /* 自动看要节流（内存、流量、钱）；用户亲手点的那一下不能被他自己的
       上一条请求挡掉 —— 他要的是「现在」，不是「等它忙完」。 */
    if (S.inflight >= 2 && why !== 'tap') return;
    var t0 = Date.now();
    var img = snap();
    if (!img) {
      if (why === 'tap') setSt('镜头还没好', 'err');
      return;
    }
    /* 基准跟着「真发出去的那一帧」走，不是跟着时间走。
       放在 snap 之后、发请求之前：只有确实发了才前移，
       否则被 inflight 挡掉的那些变化会被基准吃掉。 */
    lastSentMini = prevMini;
    S.inflight++;
    S.lastSentAt = Date.now();
    S.lastFireAt = S.lastSentAt;
    setSt('看一眼…', 'think');
    chefSet('think');

    var now = Date.now();
    var body = JSON.stringify({
      image: img,
      dish: S.dish,
      prev: S.lastSee,
      trend: '',
      deepen: false,
      step: S.step || null,
      why: why,
      /* 时间三件套：整锅看了多久、这一步多久、距上次开口多久。
         没有它们，模型分不清「刚下锅」和「已经烧了四分钟」。 */
      elapsed: S.startedAt ? Math.round((now - S.startedAt) / 1000) : 0,
      stepElapsed: S.stepAt ? Math.round((now - S.stepAt) / 1000) : 0,
      since: S.spokeAt ? Math.round((now - S.spokeAt) / 1000) : 0,
      /* 最近三次观察。只带它自己说过的话，量小、也不会把用户输入塞进别的角色位。 */
      hist: S.hist.slice(-3).map(function (h) {
        return {
          ago: Math.round((now - h.at) / 1000),
          see: h.see,
          tip: h.tip,
          level: h.level
        };
      })
    });

    fetch(FRAME_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        return { ok: res.ok, status: res.status, d: d };
      });
    }).then(function (r) {
      if (!S.open) return;
      var rtt = Date.now() - t0;
      /* 这个数挂在窗口下沿。它同时回答两个问题：
         是网慢（这个数大、服务端 ms 小），还是模型慢（两个都大）。 */
      if (latEl) {
        latEl.textContent = (rtt / 1000).toFixed(1) + 's';
        latEl.classList.toggle('slow', rtt > 4000);
      }
      if (!r.ok) {
        setSt(r.status === 429 ? '先歇会儿' : '没连上', 'err');
        /* 光在小窗里写「没连上」，灶台边看不见。开口说一句，
           否则用户会以为摄像头开着就等于它在工作。 */
        bubble(r.status === 429 ? '今天看得有点多，歇一会儿再盯着。'
          : r.status === 401 ? '登录过期了，退出去重新登一下。'
          : '我连不上服务器，画面还在，但说不出话。', 'notice', 5200);
        setSee('连不上，只有画面');
        S.tap = false;
        return;
      }
      S.sent++;
      onFrame(r.d || {}, rtt);
    }).catch(function () {
      if (!S.open) return;
      if (latEl) { latEl.textContent = '断'; latEl.classList.add('slow'); }
      setSt('网络断了', 'err');
      bubble('网断了，等它回来我接着看。', 'notice', 5200);
      setSee('网断了');
      S.tap = false;
    }).then(function () {
      S.inflight--;
      if (S.open && chefEl && chefEl.getAttribute('data-st') === 'think') chefSet('idle');
    });
  }

  function onFrame(d, rtt) {
    var level = d.level || 'quiet';
    var tip = String(d.tip || '').trim();
    var see = String(d.see || '').trim();
    var tapped = !!S.tap;
    S.tap = false;
    S.lastSee = see;
    /* 常驻那行永远有字：有观察就写观察，没有就回落到「在看第几步」。
       它是「它真的在干活」的唯一持续证据，不能空。 */
    setSee(see);
    S.quietStreak = level === 'quiet' ? S.quietStreak + 1 : 0;

    /* 镜头没对准锅是这套东西最常见的失败：手机放歪、锅不在框里、被手挡住。
       连续三眼看不清楚就开口教他摆 —— 灶台边的人不会盯着那行小字。 */
    if (/看不清|模糊|没对准|挡住|看不到锅|不像在做饭/.test(see)) {
      S.blind++;
      if (S.blind >= 3 && Date.now() - S.blindAt > 120000) {
        S.blindAt = Date.now();
        say('镜头好像没对着锅，挪一下手机，让它能看见锅里。', 'notice');
      }
    } else {
      S.blind = 0;
    }

    if (level === 'danger') {
      setSt('⚠ 注意', 'danger');
      bubble(tip || '先关火看一眼', 'danger');
      chefSet('danger', 2200);
      /* 静音时也响：长按静音是嫌吵，不是想烧厨房 */
      beep(880, 0.16, 0.24);
      setTimeout(function () { beep(660, 0.2, 0.22); }, 200);
      vibrate([90, 60, 90, 60, 180]);
      if (S.mute) return;
      say(tip || '先关火看一眼', 'danger');
    } else if (level === 'notice') {
      setSt('提醒', 'notice');
      /* 指着锅提醒 —— 手上有油的人先看见动作，才听得进话。
         同一句 25 秒内不重复念的时候也要换姿势，不然它像没反应。 */
      chefSet('notice', 2800);
      if (tip) {
        /* 同一句话 25 秒内不重复念 —— 锅冒烟那半分钟模型每帧都会报同一件事 */
        if (tip !== S.lastTip || Date.now() - S.lastTipAt > 25000) {
          S.lastTip = tip;
          S.lastTipAt = Date.now();
          vibrate([45]);
          say(tip, 'notice');
        } else {
          bubble(tip, 'notice');
        }
      }
    } else {
      setSt(S.step ? ('第 ' + (S.step.i + 1) + ' 步') : '盯着', '');
      /* 他亲手点了「立刻看」，就要拿到一句回答。
         只更新上面那行小字，等于问了他不说话。 */
      if (tapped) say(see || '没看出变化，接着盯。');
    }

    /* 记一条「这顿饭它说过什么」。下次发帧时带上去，
       它才知道自己两分钟前已经喊过「翻面」，现在是「翻了吗」而不是第一次发现。 */
    if (see) {
      S.hist.push({ at: Date.now(), see: see.slice(0, 40), tip: tip.slice(0, 26), level: level });
      if (S.hist.length > 4) S.hist.shift();
    }
    if (level === 'notice' || level === 'danger') S.spokeAt = Date.now();
  }

  /* ---------------- 对外 ---------------- */

  function open(opts) {
    opts = opts || {};
    if (S.open) {
      if (opts.dish) S.dish = String(opts.dish).slice(0, 40);
      if (opts.step) setStep(opts.step);
      return Promise.resolve(true);
    }
    ensureDom();
    S.open = true;
    S.dish = String(opts.dish || '').slice(0, 40);
    S.step = opts.step || null;
    S.lastSee = '';
    S.quietStreak = 0;
    S.blind = 0;
    S.startedAt = Date.now();
    S.stepAt = Date.now();
    S.spokeAt = 0;
    S.hist = [];
    prevMini = null;
    lastSentMini = null;
    S.mute = false;
    try { S.mute = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
    el.classList.add('on');
    el.classList.toggle('mute', S.mute);
    setSt('开机中…', 'think');
    if (latEl) { latEl.textContent = ''; latEl.classList.remove('slow'); }
    warmFrames();

    return startCam().then(function () {
      S.lastSentAt = 0;
      setSt(S.step ? ('第 ' + (S.step.i + 1) + ' 步') : '盯着', '');
      setSee('');
      setTimeout(function () {
        if (!S.open) return;
        fire('open');
        /* 开场不用 notice（会震一下）—— 第一次见面就震，像被吓了一跳。
           但要多停一会儿：这是唯一一次证明「它真的会说话」的机会，
           3 秒就收，用户会以为它根本没出声。 */
        say(S.dish ? (S.dish + '是吧，我看着火。有事我出声。')
                   : '我看着火，有事我出声。', '', 6400);
        /* 一边说一边抬手打招呼 —— 第一次见面，先让它「露个脸」。
           放在 say 之后：say 会把姿势设成站着说，这里再盖成招手。 */
        chefSet('greet', 2800);
        /* 小窗默认在右下角，一定压住一部分步骤文字。
           不教的话没人知道能拖 —— 和演示页同一个坑。 */
        setTimeout(function () {
          var placed = false;
          try { placed = !!localStorage.getItem(POS_KEY); } catch (e) {}
          if (!S.open || S.dragged || placed) return;
          bubble('按住这个小窗能挪开，别挡着步骤。', 'tip', 4200);
          chefSet('greet', 3200);   // 招手叫你注意这句提示
        }, 3000);

        /* 「换了个摄像头之后就不准了」这类事，得有个当场能看见的证据。
           只报一次，而且排在拖窗提示之后 —— 别一开机就三句话轰炸。 */
        setTimeout(function () {
          if (!S.open) return;
          var cw = cam.w || (video && video.videoWidth) || 0;
          var ch = cam.h || (video && video.videoHeight) || 0;
          if (cam.facing === 'user') {
            bubble('开的是前置镜头，画面是反的，我可能看不准。', 'tip', 5600);
          } else if (cw && cw < 640) {
            bubble('这个镜头只给到 ' + cw + '×' + ch + '，画面太小；手机往锅边挪近一点。', 'tip', 5600);
          }
        }, 7600);
      }, 700);
      S.tickTimer = setInterval(tick, PEEK_MS);
      return true;
    }).catch(function (e) {
      var msg = '摄像头打不开';
      var name = (e && e.name) || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') msg = '没给摄像头权限，开不了';
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') msg = '没找到摄像头';
      else if (name === 'NotReadableError') msg = '摄像头被别的应用占着';
      else if (name === 'NO_API') msg = '这个浏览器不支持摄像头';
      close();
      throw new Error(msg);
    });
  }

  function setStep(step) {
    S.step = step || null;
    S.stepAt = Date.now();   // 每一步单独计时，模型才知道「这步已经做了三分半」
    if (!S.open) return;
    setSt(step ? ('第 ' + (step.i + 1) + ' 步') : '盯着', '');
    /* 翻步一定伴随画面变化，而且这是「最该说一句」的时刻，不等比对结果 */
    if (step) fire('step');
  }

  /* ---------------- 立刻看 ----------------
     自动看是「它觉得有事才开口」，这一颗是「你说看就看」。
     两条路共用同一套抓帧和提示词，只是这里不吃节流、而且要回一句话。 */
  function lookNow() {
    if (!S.open) return;
    if (Date.now() - S.lastSentAt < TAP_GAP) {
      setSt('马上就好', 'think');
      chefSet('think', 900);
      return;
    }
    S.tap = true;
    setSt('看一眼…', 'think');
    chefSet('think');
    fire('tap');
  }

  function toggleMute() {
    S.mute = !S.mute;
    try { localStorage.setItem(MUTE_KEY, S.mute ? '1' : '0'); } catch (e) {}
    if (el) el.classList.toggle('mute', S.mute);
    if (S.mute) {
      hush();
      setSt('静音·还在看', 'muted');
      bubble('不出声了，有事还弹字。', '', 2200);
      setSee('');
    } else {
      setSt('盯着', '');
      bubble('我回来了。', '', 1800);
      setSee('');
    }
  }

  function close() {
    if (!S.open) {
      /* 极端情况：open 失败但 DOM 已建（摄像头拒绝），也要收干净 */
      if (el) { stopCam(); el.classList.remove('on'); }
      return;
    }
    S.open = false;
    hush();
    stopCam();
    if (S.tickTimer) { clearInterval(S.tickTimer); S.tickTimer = 0; }
    if (bubT) { clearTimeout(bubT); bubT = 0; }
    if (chefT) { clearTimeout(chefT); chefT = 0; }
    if (el) {
      el.classList.remove('on');
      if (bubEl) bubEl.classList.remove('on');
      if (seeEl) seeEl.classList.remove('on');
    }
    try {
      if (window.FQChef && window.FQChef.onClose) window.FQChef.onClose();
    } catch (e) {}
  }

  window.FQChef = {
    open: open,
    close: close,
    setStep: setStep,
    isOpen: function () { return S.open; },
    hush: hush,
    say: say,
    onClose: null
  };
})();
