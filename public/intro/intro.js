/* =========================================================
   介绍页交互脚本（零依赖）
   ========================================================= */
(function(){
  'use strict';
  var $ = function(s, r){ return (r||document).querySelector(s); };
  var $$ = function(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };

  /* ---------- 滚动进场 ---------- */
  var io = null;
  try{
    io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold:.14, rootMargin:'0px 0px -40px 0px' });
  }catch(err){
    document.documentElement.classList.add('no-io');   // 兜底：直接全部可见
  }
  // 首屏元素本来就该是「进来」状态：进入下一帧再观察，让浏览器先测量一次
  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    $$('.reveal').forEach(function(el){
      var r = el.getBoundingClientRect();
      if(!io || r.top < window.innerHeight * 0.92) el.classList.add('in');   // 已在首屏 / 无观察器 → 直接显示
      else io.observe(el);
    });
  }); });
  // 兜底：无论观察器行为如何，1.2s 后仍未显示的（且已进入视口）强制显示
  setTimeout(function(){
    $$('.reveal').forEach(function(el){
      if(!el.classList.contains('in') && el.getBoundingClientRect().top < window.innerHeight) el.classList.add('in');
    });
    // 数字也别停在占位的 0 上：1.2s 后仍在首屏、还没动过的，直接补跑一次滚动
    $$('[data-count]').forEach(function(el){
      if(!el.dataset.done && el.getBoundingClientRect().top < window.innerHeight){
        el.dataset.done = '1'; countUp(el);
      }
    });
  }, 1200);

  /* ---------- 数字滚动 ---------- */
  function countUp(el){
    var to = +el.dataset.count, sfx = el.dataset.suffix || '', t0 = null, dur = 1100;
    var plus = el.dataset.plus === '1' ? '+' : '';   // 「99+」这类：滚到 99 结尾再补个加号
    function tick(t){
      if(!t0) t0 = t;
      var k = Math.min(1, (t - t0) / dur);
      var v = Math.round(to * (1 - Math.pow(1 - k, 3)));
      el.textContent = v + plus + sfx;
      if(k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  var io2 = new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting && !e.target.dataset.done){ e.target.dataset.done = '1'; countUp(e.target); io2.unobserve(e.target); } });
  }, { threshold:.6 });
  $$('[data-count]').forEach(function(el){ io2.observe(el); });

  /* ---------- 小工具：吐司 ---------- */
  function toast(slot, msg, ok){
    var s = $(slot);
    if(!s) return;
    s.innerHTML = '<div class="toast' + (ok ? ' ok' : '') + '">' + msg + '</div>';
    clearTimeout(s._t);
    s._t = setTimeout(function(){ s.innerHTML = ''; }, 2200);
  }

  /* ============ ① 点赞 / 评论 ============ */
  var likeBtn = $('#like-btn'), likeN = $('#like-n'), liked = false;
  if(likeBtn){
    likeBtn.addEventListener('click', function(ev){
      liked = !liked;
      likeBtn.classList.toggle('on', liked);
      likeBtn.firstChild.nodeValue = liked ? '❤️ 点赞 ' : '🤍 点赞 ';
      likeN.textContent = liked ? 4 : 3;
      if(liked){
        for(var i = 0; i < 6; i++) heartBurst(ev.clientX, ev.clientY, i);
        toast('#toast-1', '已点赞，谢谢认可这锅肉 🍖', true);
      }
    });
  }
  function heartBurst(x, y, i){
    var h = document.createElement('span');
    h.className = 'heart-pop';
    h.textContent = ['❤️','🧡','💛','❤️','🥰','✨'][i % 6];
    h.style.left = (x - 11 + (Math.random()*40 - 20)) + 'px';
    h.style.top = (y - 10) + 'px';
    h.style.animationDelay = (i * 45) + 'ms';
    document.body.appendChild(h);
    setTimeout(function(){ h.remove(); }, 900 + i * 45);
  }

  var cmtN = $('#cmt-n'), cmtBox = $('#cmt-box'), cmtInput = $('#cmt-input');
  function addComment(){
    var v = (cmtInput.value || '').trim();
    if(!v){ cmtInput.focus(); toast('#toast-1', '先写点什么再发呀', false); return; }
    var d = document.createElement('div');
    d.className = 'cmt new';
    var b = document.createElement('b'); b.textContent = '我';
    d.appendChild(b);
    d.appendChild(document.createTextNode(' ' + v));
    cmtBox.insertBefore(d, $('.cmt-input', cmtBox));
    cmtInput.value = '';
    cmtN.textContent = +cmtN.textContent + 1;
    toast('#toast-1', '评论已发出', true);
  }
  if($('#cmt-send')) $('#cmt-send').addEventListener('click', addComment);
  if(cmtInput) cmtInput.addEventListener('keydown', function(e){ if(e.key === 'Enter') addComment(); });

  // 转发按钮 → 打开面板演示
  var shareBtn = $('[data-d="share"]');
  if(shareBtn) shareBtn.addEventListener('click', function(){ openShare(); });

  // 评优按钮 → 直接上墙
  var featBtn = $('[data-d="feature"]');
  if(featBtn) featBtn.addEventListener('click', function(){
    if(featBtn.dataset.done){ toast('#toast-1', '这篇已经在优秀饭帖里了 🏅', true); return; }
    featBtn.dataset.done = '1';
    featBtn.innerHTML = '🏅 已评优';
    featBtn.style.color = '#e0a020';
    toast('#toast-1', '已加入「优秀饭帖」，作者收到通知 🎉', true);
  });

  // 评论按钮 → 聚焦输入框
  var cBtn = $('[data-d="comment"]');
  if(cBtn) cBtn.addEventListener('click', function(){
    cmtInput && cmtInput.focus();
    cmtInput && cmtInput.scrollIntoView({ block:'center', behavior:'smooth' });
  });

  /* ============ ② 发帖 + 九宫格 ============ */
  var PALETTE = [
    ['🍜','#ffb27a,#ff8a3d'], ['🍰','#ffe6a8,#ffd166'], ['🍤','#ffc9a0,#f2682a'],
    ['🥗','#c8e6a0,#6fcf7f'], ['🍳','#fff3d6,#ffb020'], ['🍣','#ffd0da,#ff9ebb'],
    ['🥘','#ffd9b0,#e8543f'], ['🍲','#cfe6ff,#6bb8f0'], ['🍧','#e6d6ff,#b39ddb']
  ];
  var grid = $('#grid9'), pubText = $('#pub-text'), pubChip = $('#pub-chip');
  var tiles = [];
  function renderGrid(){
    grid.innerHTML = '';
    tiles.forEach(function(t, i){
      var c = document.createElement('div');
      c.className = 'tile-cell';
      c.style.background = 'linear-gradient(135deg,' + t[1] + ')';
      c.textContent = t[0];
      var del = document.createElement('button');
      del.className = 'del'; del.textContent = '×'; del.title = '删掉这张';
      del.addEventListener('click', function(){ tiles.splice(i,1); renderGrid(); });
      c.appendChild(del);
      grid.appendChild(c);
    });
    updateChip();
  }
  function updateChip(){
    pubChip.textContent = '图片 ' + tiles.length + '/9';
    pubChip.classList.toggle('warn', tiles.length >= 9);
  }
  if($('#add-img')) $('#add-img').addEventListener('click', function(){
    if(tiles.length >= 9){ toast('#toast-2', '最多 9 张，再加就放不下了', false); return; }
    tiles.push(PALETTE[Math.floor(Math.random()*PALETTE.length)]);
    renderGrid();
  });
  if($('#pub-btn')) $('#pub-btn').addEventListener('click', function(){
    var has = (pubText.value || '').trim() || tiles.length;
    if(!has){ toast('#toast-2', '写点字或加几张图再发', false); pubText.focus(); return; }
    toast('#toast-2', '已提交，进入「待审核」队列 ⏳', true);
    pubText.value = ''; tiles = []; renderGrid();
  });
  renderGrid();

  /* ============ ③ 审核流转 ============ */
  var rvBadge = $('#rv-badge'), rvResult = $('#rv-result');
  $$('[data-rv]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var ok = btn.dataset.rv === 'approve';
      rvBadge.textContent = ok ? '已处理' : '已驳回';
      rvBadge.classList.add('done');
      rvResult.className = 'rv-result ' + (ok ? 'ok' : 'no');
      rvResult.textContent = ok
        ? '✓ 已通过，帖子现已公开，厨友们能看到它了。'
        : '该帖已驳回并通知作者，不会出现在首页。';
      $$('[data-rv]').forEach(function(b){ b.disabled = true; b.style.opacity = .45; b.style.boxShadow = 'none'; });
    });
  });

  /* ============ 转发面板 ============ */
  var mask = null;
  function openShare(){
    if(mask) return;
    mask = document.createElement('div');
    mask.className = 'share-mask';
    mask.innerHTML =
      '<div class="share-panel" role="dialog" aria-modal="true">' +
        '<div class="share-title">转发给…</div>' +
        '<div class="share-sub">选一位厨友，把这道菜发进私信</div>' +
        '<div class="share-list">' +
          ['小美|@meimei|🍰|关注了你','阿猎|@hunter|🍳|互相关注','林小厨|@lin|🍜|3 天前聊过','老张头|@laozhang|🍖|昨天聊过']
            .map(function(s, i){
              var p = s.split('|');
              return '<button class="share-row" data-i="' + i + '">' +
                '<span class="s-av">' + p[2] + '</span>' +
                '<span class="s-txt"><b>' + p[0] + '</b><em>' + p[1] + ' · ' + p[3] + '</em></span>' +
                '<span class="s-go">发送</span></button>';
            }).join('') +
        '</div>' +
        '<button class="btn share-close">取消</button>' +
      '</div>';
    document.body.appendChild(mask);
    document.body.style.overflow = 'hidden';
    mask.addEventListener('click', function(e){ if(e.target === mask) closeShare(); });
    $('.share-close', mask).addEventListener('click', closeShare);
    $$('.share-row', mask).forEach(function(r){
      r.addEventListener('click', function(){
        var name = $('b', r).textContent;
        closeShare();
        toast('#toast-1', '已转发给 ' + name + '，ta 会在私信里看到帖子卡片 📨', true);
      });
    });
  }
  function closeShare(){ if(mask){ mask.remove(); mask = null; document.body.style.overflow = ''; } }
  // Esc 关弹窗：转发面板与激活码弹窗共用一个监听（哪个开着关哪个）
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    if(window.__closeLock){ window.__closeLock(); return; }
    closeShare();
  });

  /* ============ CTA 链接：一律指向饭圈站 ============ */
  /* 官网和应用同域（fanqvan.com、app.fanqvan.com 都算）就回站点根，
     别把用户甩到平台长链接上；从平台域名访问时仍指向平台地址。 */
  var SITE = /(^|\.)fanqvan\.com$/i.test(location.hostname)
    ? location.origin + '/'
    : 'https://8810a05ca2994d829f9c56a36bea7c58.app.workbuddy.host';
  $$('a').forEach(function(a){
    var h = a.getAttribute('href') || '';
    // 站内锚点（#xxx）留着；其余「进入饭圈 / 进站逛逛」类按钮全部指向线上
    if(h === '#' || h === '' || /进入饭圈|进站|逛逛/.test(a.textContent)) a.href = SITE;
  });

  /* ============ 用户版 / 开发版 切换（开发版需激活码） ============ */
  var root = document.documentElement;
  // ⚠️ 前端激活码只是"别让普通访客误进开发版"的软门槛，不是安全边界：
  //    开发版内容本来就打包在这个 HTML 里，想要的人看源码一样能拿到。
  //    真正的保密要靠"别把敏感内容放进前端"或服务端鉴权（静态页做不到）。
  var DEV_CODE = 'admin';
  var LS_MODE = 'fq_intro_mode';
  var LS_UNLOCK = 'fq_dev_unlocked';
  var modeSwitch = $('#mode-switch');
  var unlockBtn  = $('#mode-lock');

  function isUnlocked(){
    return root.hasAttribute('data-dev-unlocked');
  }
  function setUnlocked(on){
    if(on){ root.setAttribute('data-dev-unlocked','1'); }
    else  { root.removeAttribute('data-dev-unlocked'); }
    if(modeSwitch){
      modeSwitch.classList.toggle('is-unlocked', on);
      modeSwitch.classList.toggle('is-locked', !on);
    }
    if(unlockBtn) unlockBtn.setAttribute('aria-hidden', on ? 'true' : 'false');
    try{ on ? localStorage.setItem(LS_UNLOCK,'1') : localStorage.removeItem(LS_UNLOCK); }catch(e){}
  }

  function setMode(m){
    // 没解锁时，任何方式都不允许进入开发版（含 URL 里的 #dev）
    if(m === 'dev' && !isUnlocked()) m = 'user';
    root.setAttribute('data-mode', m);
    $$('[data-mode-btn]').forEach(function(b){
      var on = b.dataset.modeBtn === m;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    try{ localStorage.setItem(LS_MODE, m); }catch(e){}
    // 切完把滚动拉回顶部，避免停在对方版本的半截位置。
    // 必须先临时关掉 html 的 scroll-behavior:smooth —— 否则 scrollTo 是"平滑动画"、
    // 异步进行，用户会看到一段明显的回滚动画（而且断言会读到中途的值）。
    var html = document.documentElement;
    var prev = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    // 同时清掉 hash：否则浏览器会按锚点又跳回原处（比如从 #play 切过去）
    if(location.hash){ history.replaceState(null, '', location.pathname + location.search); }
    window.scrollTo({ top: 0, behavior: 'auto' });
    html.style.scrollBehavior = prev;
    // 新显示出来的区块里，reveal 可能还没触发 —— 补一次
    requestAnimationFrame(function(){
      $$('.reveal').forEach(function(el){
        if(el.getBoundingClientRect().top < window.innerHeight * 0.95) el.classList.add('in');
      });
      $$('[data-count]').forEach(function(el){
        if(!el.dataset.done && el.getBoundingClientRect().top < window.innerHeight) { el.dataset.done = '1'; countUp(el); }
      });
    });
  }

  /* ---- 激活码弹窗 ---- */
  var lockMask = null, lockInput = null, lockErr = null;
  function openLock(){
    if(lockMask) return;
    lockMask = document.createElement('div');
    lockMask.className = 'lock-mask';
    lockMask.innerHTML =
      '<div class="lock-box" role="dialog" aria-modal="true" aria-labelledby="lock-title">' +
        '<div class="lock-ic">' +
          '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>' +
        '</div>' +
        '<h3 id="lock-title">开发版需要激活码</h3>' +
        '<p>这里给开发和运营的人看，讲的是实现、安全与审核流水线。输入激活码后即可进入。</p>' +
        '<div class="lock-field">' +
          '<input class="lock-input" id="lock-input" type="password" autocomplete="off" ' +
            'placeholder="请输入激活码" aria-label="激活码">' +
          '<button class="btn btn-primary" id="lock-go" type="button">进入</button>' +
        '</div>' +
        '<div class="lock-err" id="lock-err">' +
          '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>' +
          '<span>激活码不对，再试一次</span>' +
        '</div>' +
        '<div class="lock-foot">' +
          '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>' +
          '<span>只会记住这次浏览器的选择，换设备要重新输入。</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(lockMask);
    lockInput = $('#lock-input', lockMask);
    lockErr   = $('#lock-err', lockMask);
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(function(){ lockMask.classList.add('show'); });
    setTimeout(function(){ lockInput && lockInput.focus(); }, 120);

    function close(){
      if(!lockMask) return;
      var m = lockMask;
      m.classList.remove('show');
      document.body.style.overflow = '';
      setTimeout(function(){ m.remove(); }, 200);
      lockMask = null; lockInput = null; lockErr = null;
    }
    window.__closeLock = close;

    function submit(){
      var v = (lockInput.value || '').trim();
      if(v === DEV_CODE){
        setUnlocked(true);
        close();
        setMode('dev');
        unlockToast();
      } else {
        lockErr.classList.add('show');
        var box = lockMask.querySelector('.lock-box');
        box.classList.remove('shake');
        void box.offsetWidth;          // 强制重排，让动画能重复触发
        box.classList.add('shake');
        lockInput.select();
      }
    }
    $('#lock-go', lockMask).addEventListener('click', submit);
    lockInput.addEventListener('keydown', function(e){
      if(e.key === 'Enter'){ e.preventDefault(); submit(); }
      if(e.key !== 'Escape') lockErr.classList.remove('show');
    });
    // 点遮罩关闭（点面板内部不关）
    lockMask.addEventListener('click', function(e){ if(e.target === lockMask) close(); });
  }
  /* ---- 解锁成功的小提示（浮在页面底部，开发版里没有 demo 的 toast 槽位） ---- */
  function unlockToast(){
    var el = document.createElement('div');
    el.className = 'float-toast';
    el.innerHTML =
      '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>' +
      '开发版已解锁';
    document.body.appendChild(el);
    requestAnimationFrame(function(){ el.classList.add('show'); });
    setTimeout(function(){
      el.classList.remove('show');
      setTimeout(function(){ el.remove(); }, 260);
    }, 2000);
  }

  if(unlockBtn) unlockBtn.addEventListener('click', openLock);

  $$('[data-mode-btn]').forEach(function(b){
    b.addEventListener('click', function(){
      var m = b.dataset.modeBtn;
      if(m === 'dev' && !isUnlocked()){ openLock(); return; }   // 兜底：没解锁不给切
      setMode(m);
    });
  });

  // 恢复上次状态：解锁标记 + 版本选择；也支持 #dev / #user 直达
  try{ if(localStorage.getItem(LS_UNLOCK) === '1') setUnlocked(true); }catch(e){}
  var init = 'user';
  try{ init = localStorage.getItem(LS_MODE) || 'user'; }catch(e){}
  if(/dev/.test(location.hash)){
    if(isUnlocked()) init = 'dev';
    else { init = 'user'; setTimeout(openLock, 300); }   // 没解锁就想进开发版 → 弹激活码
  }
  if(/user/.test(location.hash)) init = 'user';
  setMode(init);
})();
