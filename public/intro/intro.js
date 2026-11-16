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
     文本写死在这里，点按钮只是逐字打出来，不发请求、不碰 /api/ai。
     三种演示对应站内三个真实入口：
       润色     —— 发帖页「润色」（只改自己写的话）
       拆成步骤 —— 帖子详情页底部「照着做一遍」，输入是**那条帖子的正文**，
                   AI 只把作者自己写的做法拆成一步一屏 + 每步计时（/api/ai/steps 收 postId）
       拍给我看 —— 详情页「厨房急诊」，照片 + 一句问题（/api/ai/look） */
  var AI_EX = {
    polish: {
      label: '你写的原话', run: '让 AI 改一遍', photo: false,
      rules: ['只用你自己的话，不凭空加菜谱', '配比、火候没写就不替你编', '改完还是你的口吻'],
      items: [
        { q: '今天炒了个蛋炒饭 挺好吃的 就是有点咸 下次少放点盐',
          a: '今天炒了个蛋炒饭，挺好吃的，就是有点咸。下次少放点盐，味道就正好了。' },
        { q: '红烧肉火太大 糖色炒糊了 肉有点苦',
          a: '红烧肉这次火大了，糖色炒糊，肉也带了点苦味。\n记下来：糖色一变成枣红就得立刻下肉，晚一秒就苦。' },
        { q: '第一次做戚风 没塌 开心',
          a: '第一次做戚风，居然没塌，开心。\n关键是蛋白打到硬性发泡，翻拌时从底部兜起来、别画圈。' }
      ]
    },
    cook: {
      label: '帖子里写的做法', run: '拆成步骤', photo: false,
      rules: ['只拆帖子里写过的做法，不另编菜谱', '一步一屏、带进度，点「下一步」往下走', '帖子里说了时长的步骤，配一颗计时器'],
      items: [
        { q: '周六炖了锅红烧肉。五花肉两斤切麻将块，冷水下锅焯，撇掉浮沫捞出来。锅里放冰糖炒糖色，变枣红就下肉翻炒，加生抽老抽、姜片八角，倒热水没过肉，小火一个半小时，最后大火收汁。',
          steps: [
            { t: '切块', d: '五花肉切成麻将块，两斤差不多一大盘。', w: '切匀一点，厚薄一样才好一起熟。', timer: 0 },
            { t: '焯水', d: '冷水下锅，浮沫撇干净再捞出来。', w: '水一开就转小火，浮沫撇透汤才清。', timer: 300 },
            { t: '炒糖色', d: '冰糖化开变枣红，立刻下肉翻匀。', w: '枣红就下肉，晚一秒就发苦。', timer: 0 },
            { t: '焖', d: '加生抽老抽、姜片八角，倒热水没过肉。', w: '一定加热水，冷水一激肉就紧。', timer: 5400 },
            { t: '收汁', d: '转大火，汁能挂住勺子就关火。', w: '汁挂勺就关，再烧就咸了。', timer: 480 }
          ] },
        { q: '今天的番茄炒蛋：番茄两个切块，鸡蛋三个打散加一小撮盐。热锅凉油先炒蛋，滑到半凝固就盛出来。补一点油下番茄，炒到出沙加半碗水煮两分钟，倒回蛋翻两下出锅。',
          steps: [
            { t: '备料', d: '番茄两个切块，鸡蛋三个打散，加一小撮盐。', w: '番茄去皮口感更顺，懒得去皮也能做。', timer: 0 },
            { t: '炒蛋', d: '热锅凉油，蛋液滑到半凝固就盛出来。', w: '还带一点湿就关火，余温会继续把它烘熟。', timer: 90 },
            { t: '炒番茄', d: '补一点油，番茄炒到出沙，加半碗水煮开。', w: '出沙就是番茄软塌出汁、锅底有明显汤汁。', timer: 180 },
            { t: '合炒', d: '倒回鸡蛋，翻两下就出锅，别久炒。', w: '鸡蛋久炒就老，翻匀就盛出来。', timer: 0 }
          ] },
        { q: '第一次做戚风居然没塌。蛋黄糊：蛋黄 4 个加牛奶 40g、玉米油 40g、低粉 70g 拌匀。蛋白分三次加糖打到硬性发泡，分三次翻拌进去。倒进模子震两下，150 度烤 50 分钟，出炉立刻倒扣放凉。',
          steps: [
            { t: '蛋黄糊', d: '蛋黄 4 个，加牛奶 40g、油 40g、低粉 70g 拌匀。', w: '拌到没有干粉就停，别过度搅打起筋。', timer: 0 },
            { t: '打蛋白', d: '糖分三次加，打到提起有直立小尖。', w: '盆倒过来蛋白不流动，就是够硬了。', timer: 240 },
            { t: '翻拌', d: '蛋白分三次拌进蛋黄糊，从底部兜起来。', w: '画圈会消泡，塌腰多半坏在这一步。', timer: 0 },
            { t: '烤', d: '倒进模子震两下，150 度烤 50 分钟。', w: '中间别开炉门，温度一掉就塌。', timer: 3000 },
            { t: '倒扣', d: '出炉立刻倒扣，彻底放凉再脱模。', w: '不倒扣必塌腰，这一步别省。', timer: 1800 }
          ] }
      ]
    },
    look: {
      label: '你想问的', run: '让它看看', photo: true,
      rules: ['先说看见什么，再说怎么办', '看不清就说看不清，不瞎猜', '只给火候判断，不替你决定吃什么'],
      items: [
        { q: '蛋皮是不是有点老了？咖喱还要不要再收一下',
          a: '它看见的：蛋皮旋得挺匀，表面还润，边缘没焦；咖喱汁偏稀，浮着一层水光，胡萝卜块偏大。\n\n下一步：蛋包饭别再动火，先盛出来。咖喱开中火再收两分钟，勺子背面能挂住一层就关火。',
          tm: [{ n: '收咖喱', s: 120 }] },
        { q: '这个颜色算不算上色到位了',
          a: '它看见的：蛋皮是嫩黄，没有焦边；旁边的西兰花还发亮，胡萝卜边角有点硬。\n\n下一步：蛋皮已经到位，别回锅。蔬菜再煮三分钟到能咬断，咖喱最后调味就行。',
          tm: [{ n: '蔬菜再煮', s: 180 }] }
      ]
    }
  };
  var aiMode = 'polish', aiIdx = 0, aiTimer = null, aiTicks = [];
  var aiIn = $('#ai-in'), aiOut = $('#ai-out'), aiNote = $('#ai-note'),
      aiLabel = $('#ai-label'), aiRun = $('#ai-run'), aiShot = $('#ai-shot'),
      aiRules = $('#ai-rules');

  function mmss(sec){
    var m = Math.floor(sec / 60), r = sec % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  // 切例子/切 tab 时把所有倒计时一起停掉，别留在后台空转
  function stopTicks(){
    aiTicks.forEach(function(id){ clearInterval(id); });
    aiTicks = [];
  }
  function dropTick(id){
    var k = aiTicks.indexOf(id);
    if(k >= 0) aiTicks.splice(k, 1);
  }

  /* 步骤计时：跟站内 `cook-timer` 一样的规矩——点一下开始/暂停，到点变「时间到」，
     再点一下回到原时长（站内是连点两下重置，这里简化成到点后点一下重来）。
     时钟图标自己画，跟页面其它线稿一个笔触，不用 emoji。 */
  var CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 1.9"/></svg>';

  function paintTimers(item, host, before){
    if(!item || !item.tm || !item.tm.length) return;
    var box = document.createElement('div');
    box.className = 'ai-timers';
    item.tm.forEach(function(t){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ai-timer';
      var lab = document.createElement('span');
      lab.className = 'ai-timer-lab';
      lab.innerHTML = CLOCK_SVG;
      lab.appendChild(document.createTextNode(t.n));
      var num = document.createElement('i');
      num.textContent = mmss(t.s);
      b.appendChild(lab);
      b.appendChild(num);

      var id = null, left = t.s;
      b.addEventListener('click', function(){
        if(b.classList.contains('done')){          // 到点后再点 = 重来一轮
          b.classList.remove('done');
          num.textContent = mmss(t.s);
          left = t.s;
          return;
        }
        if(id){                                    // 正在走 → 暂停
          clearInterval(id); dropTick(id); id = null;
          b.classList.remove('on');
          return;
        }
        if(left <= 0) left = t.s;
        b.classList.add('on');
        id = setInterval(function(){
          left--;
          if(left <= 0){
            clearInterval(id); dropTick(id); id = null;
            b.classList.remove('on');
            b.classList.add('done');
            num.textContent = '时间到';
            return;
          }
          num.textContent = mmss(left);
        }, 1000);
        aiTicks.push(id);
      });
      box.appendChild(b);
    });
    var at = host || aiOut;
    if(before && before.parentNode === at) at.insertBefore(box, before);
    else at.appendChild(box);
  }

  /* ---------- 拆步骤：一步一屏 ----------
     站内是 `cookHtml()` 那套：顶部「第 x / n 步」+ 进度条，中间一屏一步，
     底部「下一步」按钮，走完进完成态。官网不能把五步一次性梭出来。 */
  var aiStep = 0;
  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 12.6l5 5 9.8-10"/></svg>';

  function escTxt(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function paintStepDone(item){
    stopTicks();
    aiOut.innerHTML =
      '<div class="ai-steps stp-done">' +
        '<div class="stp-done-ico">' + CHECK_SVG + '</div>' +
        '<b>这道菜做完了</b>' +
        '<p>' + item.steps.length + ' 步走完。站内走到这里会提示「发一条成品」，让下一个人也能照着做。</p>' +
        '<button type="button" class="btn stp-again">再看一遍</button>' +
      '</div>';
    var again = aiOut.querySelector('.stp-again');
    if(again) again.addEventListener('click', function(){ aiStep = 0; renderStep(item); });
  }

  function renderStep(item){
    var steps = item.steps || [], n = steps.length;
    if(aiStep >= n){ paintStepDone(item); return; }
    stopTicks();
    var s = steps[aiStep], last = aiStep + 1 >= n;

    aiOut.innerHTML =
      '<div class="ai-steps">' +
        '<div class="stp-bar"><i style="width:' + Math.round(((aiStep + 1) / n) * 100) + '%"></i></div>' +
        '<div class="stp-meta">第 ' + (aiStep + 1) + ' / ' + n + ' 步</div>' +
        '<b class="stp-t">' + escTxt(s.t) + '</b>' +
        '<p class="stp-d">' + escTxt(s.d) + '</p>' +
        (s.w ? '<p class="stp-w"><b>看着点</b>' + escTxt(s.w) + '</p>' : '') +
        '<div class="stp-foot"><button type="button" class="btn btn-primary stp-next">' +
          (last ? '做完了' : '下一步') + '</button></div>' +
      '</div>';

    var box = aiOut.querySelector('.ai-steps');
    var foot = aiOut.querySelector('.stp-foot');
    // 这一步帖子里写了时长，才给计时器（跟站内一致：没写时长就没有那颗按钮）
    if(s.timer) paintTimers({ tm: [{ n: s.t, s: s.timer }] }, box, foot);

    aiOut.querySelector('.stp-next').addEventListener('click', function(){
      aiStep++;
      renderStep(item);
    });
  }

  function aiPaint(){
    if(!aiIn || !aiOut) return;
    var mode = AI_EX[aiMode], set = mode.items, it = set[aiIdx % set.length];
    if(aiTimer){ clearInterval(aiTimer); aiTimer = null; }
    stopTicks();
    aiStep = 0;
    aiIn.value = it.q;
    aiOut.innerHTML = '<span class="ph">点左边的「' + mode.run + '」试试。</span>';
    if(aiLabel) aiLabel.textContent = mode.label;
    if(aiRun) aiRun.textContent = mode.run;
    if(aiShot) aiShot.classList.toggle('on', !!mode.photo);
    if(aiRules && mode.rules) aiRules.innerHTML = mode.rules.map(function(r){ return '<li>' + r + '</li>'; }).join('');
    if(aiNote) aiNote.textContent = '示例 ' + ((aiIdx % set.length) + 1) + ' / ' + set.length;
  }
  function aiType(text, item){
    if(aiTimer) clearInterval(aiTimer);
    stopTicks();
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
        caret.parentNode && caret.parentNode.removeChild(caret);
        paintTimers(item);
      }
    }, 16);
  }
  if(aiIn && aiOut && aiRun){
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
    aiRun.addEventListener('click', function(){
      var set = AI_EX[aiMode].items;
      var it = set[aiIdx % set.length];
      // 拆步骤是一步一屏，不是一段文字；润色/拍给我看才走打字机
      if(it.steps){ aiStep = 0; renderStep(it); return; }
      aiType(it.a, it);
    });
    var rs = $('#ai-reset');
    if(rs) rs.addEventListener('click', function(){ aiIdx++; aiPaint(); });
  }

})();
