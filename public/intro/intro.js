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

  /* ---------- AI 区（官网展示） ----------
     文本写死在这里，点按钮只是逐字打出来，不发请求、不碰 /api/ai。 */
  var AI_EX = {
    polish: [
      { q: '今天炒了个蛋炒饭 挺好吃的 就是有点咸 下次少放点盐',
        a: '今天炒了个蛋炒饭，挺好吃的，就是有点咸。下次少放点盐，味道就正好了。' },
      { q: '红烧肉火太大 糖色炒糊了 肉有点苦',
        a: '红烧肉这次火大了，糖色炒糊，肉也带了点苦味。\n记下来：糖色一变成枣红就得立刻下肉，晚一秒就苦。' },
      { q: '第一次做戚风 没塌 开心',
        a: '第一次做戚风，居然没塌，开心。\n关键是蛋白打到硬性发泡，翻拌时从底部兜起来、别画圈。' }
    ],
    cook: [
      { q: '冰箱里只有鸡蛋 两个番茄 半碗米饭',
        a: '就这些也能做一顿：\n\n1. 番茄切块，鸡蛋打散，加一小撮盐。\n2. 热锅凉油，鸡蛋滑到半凝固先盛出来。\n3. 补一点油，番茄下锅炒到出沙，加半碗水煮开。\n4. 倒回鸡蛋，连汁浇在热米饭上。\n\n前后约 10 分钟，不用再买菜。' },
      { q: '一块鸡胸肉 一个土豆 半根胡萝卜',
        a: '一锅炖最省事：\n\n1. 鸡胸切块，用盐和一点生抽抓匀。\n2. 土豆、胡萝卜切滚刀块。\n3. 先煎鸡肉到上色，下蔬菜翻炒两下。\n4. 加水没过一半，小火 15 分钟，开盖收汁。' },
      { q: '剩的两片吐司 一个鸡蛋 一点芝士',
        a: '做个热三明治：\n\n1. 鸡蛋煎到边缘微焦，蛋黄别全熟。\n2. 吐司一面抹薄薄一层黄油。\n3. 铺芝士和蛋，盖上另一片。\n4. 小火两面各烙 1 分钟，芝士化开就好。' }
    ]
  };
  var aiMode = 'polish', aiIdx = 0, aiTimer = null;
  var aiIn = $('#ai-in'), aiOut = $('#ai-out'), aiNote = $('#ai-note'), aiLabel = $('#ai-label');
  function aiPaint(){
    if(!aiIn || !aiOut) return;
    var set = AI_EX[aiMode], it = set[aiIdx % set.length];
    if(aiTimer){ clearInterval(aiTimer); aiTimer = null; }
    aiIn.value = it.q;
    aiOut.innerHTML = '<span class="ph">点「让 AI 改一遍」试试。</span>';
    if(aiLabel) aiLabel.textContent = aiMode === 'cook' ? '手里有什么食材' : '你写的原话';
    if(aiNote) aiNote.textContent = '示例 ' + ((aiIdx % set.length) + 1) + ' / ' + set.length;
  }
  function aiType(text){
    if(aiTimer) clearInterval(aiTimer);
    aiOut.textContent = '';
    var caret = document.createElement('span');
    caret.className = 'caret';
    aiOut.appendChild(caret);
    var i = 0;
    aiTimer = setInterval(function(){
      i++;
      aiOut.textContent = text.slice(0, i);
      aiOut.appendChild(caret);
      if(i >= text.length){
        clearInterval(aiTimer); aiTimer = null;
        setTimeout(function(){ if(caret.parentNode) caret.parentNode.removeChild(caret); }, 1000);
      }
    }, 16);
  }
  if(aiIn && aiOut && $('#ai-run')){
    aiPaint();
    $$('#ai-tabs .ai-tab').forEach(function(b){
      b.addEventListener('click', function(){
        $$('#ai-tabs .ai-tab').forEach(function(x){ x.classList.remove('on'); });
        b.classList.add('on');
        aiMode = b.dataset.ai || 'polish';
        aiIdx = 0;
        aiPaint();
      });
    });
    $('#ai-run').addEventListener('click', function(){
      var set = AI_EX[aiMode];
      aiType(set[aiIdx % set.length].a);
    });
    var rs = $('#ai-reset');
    if(rs) rs.addEventListener('click', function(){ aiIdx++; aiPaint(); });
  }

})();
