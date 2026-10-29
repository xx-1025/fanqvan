/* =========================================================
   饭圈 · 前端 SPA
   首页/关注/热门 · 发帖 · 互动 · 关注 · 通知 · 举报 · 审核中心 · 用户管理
   ========================================================= */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const AV_COLORS = ['#ff8140', '#ff5c39', '#f0a020', '#34c759', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

const REPORT_REASONS = ['广告营销', '不实内容', '人身攻击', '抄袭搬运', '与美食无关', '其他'];

const state = {
  me: null,
  token: '',
  mustChangePw: false,   // 服务端判定「还在用初始口令」时为 true，只会被送到改密页
  route: { name: 'feed', id: '' },
  postFrom: '',          // 进详情页之前在哪，用来让「返回」回到原页面
  data: {},
  draft: '',
  draftImages: [],
  upload: null,          // 正在上传时：{ done, total }，用来显示「上传中 x/y」
  uploadFailed: 0,       // 本批选图里没传成功的张数（坏图 / 格式不支持），用来明确告知
  // AI 小饭（发帖助手）：一次只在当前发布框里展开，不跨页保留
  ai: { open: false, loading: false, text: '', tags: [], err: '', n: 0, provider: '', slow: false, src: '', cmp: false },
  aiUsed: false,         // 本次草稿用过 AI，发布时带给后端打「AI 辅助」标
  // 做饭模式：全屏覆盖层，挂在 body 下的 #cook-root，不参与 #app 重绘
  cook: {
    open: false, loading: false, err: '', postId: 0, dish: '', provider: '', approx: false,
    steps: [], i: 0, done: false,
    timerEnd: 0, timerSec: 0, timerDone: false, timerLeft: 0, timerPaused: false, timerLeft: 0, timerPaused: false,
    askOpen: false, asking: false, draftQ: '', answer: '', answerProvider: '', askErr: ''
  },
  keyword: '',            // 当前搜索结果对应的关键词（来自路由，或搜索页里边打边搜时同步过来）
  searchBox: '',          // 顶栏搜索框里正在输入的文字；和 keyword 分开，免得别处重绘时把打了一半的字清掉
  homeTab: 'feed',
  reviewTab: 'pending',
  reviewMode: 'posts',
  authTab: 'login',
  openComments: {},
  loading: false,
  list: { scope: 'feed', userId: 0, offset: 0, hasMore: false, total: 0, loadingMore: false },
  notes: [],
  noteOpen: false,
  modal: null,
  suggest: [],
  editAvatar: '',
  msgDraft: '',
  msgQuote: null,        // 正在引用的消息 {id, content, nickname, mine} —— 发送时带 quoteId
  msgMenu: 0,            // 当前打开操作菜单的消息 id（长按/点「⋯」弹出：撤回/删除/引用）
  groupPick: [],         // 建群弹窗里已勾选的成员 id
  groupName: ''          // 建群弹窗里的群名称草稿
};

/* ---------------------- 基础工具 ---------------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function timeAgo(ts) {
  const d = Date.now() - Number(ts || 0);
  if (d < 0) return '刚刚';
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' 天前';
  const dt = new Date(Number(ts));
  return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
}

function richText(s) {
  let out = esc(s);
  out = out.replace(/#([^#\s]{1,20})#/g, '<span class="tag">#$1#</span>');
  out = out.replace(/(^|[\s(])@([a-zA-Z0-9_]{3,20})/g, '$1<span class="mention">@$2</span>');
  out = out.replace(/\n/g, '<br>');
  return out;
}

/* 私信用：HH:MM 与「今天 / 昨天 / M月D日」 */
function hhmm(ts) {
  const d = new Date(Number(ts) || 0);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function dayLabel(ts) {
  const d = new Date(Number(ts) || 0);
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return '今天';
  const y = new Date(now.getTime() - 86400000);
  if (sameDay(d, y)) return '昨天';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function avatarHtml(u, size) {
  // size 传 0 → 不输出内联宽高，交给 CSS 定（个人主页头像要按断点变 76/64，内联会压死媒体查询）
  if (size == null) size = 44;
  if (!u) u = { id: 0, nickname: '?' };
  const box = size ? 'width:' + size + 'px;height:' + size + 'px' : '';
  if (u.avatar) {
    return '<span class="avatar" style="' + box + '">' +
      '<img src="' + esc(u.avatar) + '" alt="" loading="lazy"></span>';
  }
  const c = AV_COLORS[Math.abs(Number(u.id) || 0) % AV_COLORS.length];
  const ch = String(u.nickname || '?').slice(0, 1);
  return '<span class="avatar txt" style="--av:' + c + ';' + box +
    (size ? ';font-size:' + Math.round(size * 0.42) + 'px' : '') + '">' + esc(ch) + '</span>';
}

/* =========================================================
   图标系统 · 全部手绘
   ---------------------------------------------------------
   一律 24×24 viewBox、粗描边（2.3）、圆头圆角 —— 跟 Q 版「粗描边 + 大圆角」
   是同一套线条语言，所以放在卡片/按钮里不会打架。
   描边用 currentColor：父级改颜色（比如导航选中变白、点赞变红）图标自动跟。
   尺寸用 em，所以原有的 font-size 规则（.nav-icon 17px / .act .ico 14px…）
   不用改就能继续控制大小。
   ========================================================= */
const ICON_PATHS = {
  /* 导航 */
  home: '<path d="M3.6 10.4 12 3.6l8.4 6.8"/><path d="M5.7 9.2v9.4a1.7 1.7 0 0 0 1.7 1.7h9.2a1.7 1.7 0 0 0 1.7-1.7V9.2"/><path d="M9.9 20.3v-5.3h4.2v5.3"/>',
  fire: '<path d="M12 21.4c3.7 0 6.2-2.5 6.2-5.8 0-4.3-4.7-6.4-6.2-12.6-1.5 6.2-6.2 8.3-6.2 12.6 0 3.3 2.5 5.8 6.2 5.8Z"/><path d="M12 21.4c1.9 0 3.3-1.4 3.3-3.2 0-2.1-2.1-3.1-3.3-5.6-1.2 2.5-3.3 3.5-3.3 5.6 0 1.8 1.4 3.2 3.3 3.2Z"/>',
  users: '<circle cx="9.3" cy="8.6" r="3.3"/><path d="M3.4 19.9c0-3.1 2.6-5.2 5.9-5.2s5.9 2.1 5.9 5.2"/><circle cx="17.3" cy="9.8" r="2.5"/><path d="M17.2 14.9c2.1.3 3.5 1.9 3.6 5"/>',
  user: '<circle cx="12" cy="8.4" r="3.7"/><path d="M4.9 20.3c0-3.6 3.2-6.2 7.1-6.2s7.1 2.6 7.1 6.2"/>',
  chat: '<path d="M20.4 11.6c0 3.9-3.7 7.1-8.3 7.1-1 0-1.9-.1-2.8-.4l-4.9 1.8 1.4-3.4a6.7 6.7 0 0 1-2-5.1c0-3.9 3.7-7.1 8.3-7.1s8.3 3.2 8.3 7.1Z"/><circle cx="8.6" cy="11.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="11.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.4" cy="11.6" r="1.15" fill="currentColor" stroke="none"/>',
  bell: '<path d="M12 3.4c-3.3 0-5.5 2.5-5.5 5.7 0 4.1-1.7 5.3-1.7 5.3h14.4s-1.7-1.2-1.7-5.3c0-3.2-2.2-5.7-5.5-5.7Z"/><path d="M9.9 17.6a2.1 2.1 0 0 0 4.2 0"/>',
  shield: '<path d="M12 3.2 5 6.1v5.7c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6.1L12 3.2Z"/><path d="M9.1 11.9l2.1 2.1 3.8-4.1"/>',
  back: '<path d="M14.8 4.8 7.6 12l7.2 7.2"/>',
  search: '<circle cx="10.7" cy="10.7" r="6"/><path d="M15.1 15.1 20 20"/>',

  /* AI 小饭 */
  spark: '<path d="M11 3.6 12.7 8.9 18 10.6 12.7 12.3 11 17.6 9.3 12.3 4 10.6 9.3 8.9Z"/><path d="M17.8 14.6l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8Z"/>',
  volume: '<path d="M4.6 9.5h3.1l4.5-3.7v12.4l-4.5-3.7H4.6z"/><path d="M15.3 9.3a3.8 3.8 0 0 1 0 5.4"/><path d="M17.7 6.8a7.3 7.3 0 0 1 0 10.4"/>',

  /* 侧栏卡片 */
  chart: '<path d="M4 20.3h16"/><rect x="5.8" y="11.6" width="3.6" height="6.8" rx="1.3"/><rect x="10.2" y="7.4" width="3.6" height="11" rx="1.3"/><rect x="14.6" y="10" width="3.6" height="8.4" rx="1.3"/>',
  chef: '<path d="M8.4 5.3a3.7 3.7 0 0 1 7.2 0 3.4 3.4 0 0 1 2.7 3.3 3.3 3.3 0 0 1-2.3 3.1v1.6H8v-1.6a3.3 3.3 0 0 1-2.3-3.1 3.4 3.4 0 0 1 2.7-3.3Z"/><path d="M8 13.3h8v4H8z"/><path d="M6.6 20.9h10.8"/>',

  /* 发帖 / 编辑 */
  pen: '<path d="M4.2 20.3h15.6"/><path d="M15.7 4.4l4 4-9.9 9.9-3.5.9-.9-3.5 10.3-10.3Z"/><path d="M13.6 6.5l4 4"/>',
  pencil: '<path d="M16.5 4.5 19.5 7.5 8.7 18.3l-4 .8.8-4L16.5 4.5Z"/><path d="M14.3 6.7 17.3 9.7"/><path d="M4.7 15.1 8.9 19.3"/>',
  image: '<rect x="3.6" y="5.6" width="16.8" height="12.8" rx="2.6"/><circle cx="8.9" cy="10.4" r="1.7"/><path d="M4.2 16.6 9.2 12.4l3.2 2.7 2.9-2.3 4.5 3.8"/>',
  pan: '<circle cx="10.4" cy="13.6" r="6.6"/><path d="M15.3 8.7 20.6 3.4"/>',
  calendar: '<rect x="3.8" y="5.4" width="16.4" height="14.8" rx="2.4"/><path d="M3.8 10h16.4M8.2 3.4v3.6M15.8 3.4v3.6"/>',
  lock: '<rect x="4.9" y="10.2" width="14.2" height="10.2" rx="2.4"/><path d="M8.3 10.2V7.9a3.7 3.7 0 0 1 7.4 0v2.3"/><path d="M12 14.2v2.6"/>',
  clipboard: '<path d="M9 6.9h6a1.9 1.9 0 0 1 1.9 1.9v9.8a1.9 1.9 0 0 1-1.9 1.9H9a1.9 1.9 0 0 1-1.9-1.9V8.8A1.9 1.9 0 0 1 9 6.9Z"/><rect x="9.5" y="3.3" width="5" height="3.6" rx="1.3"/><path d="M9.8 13.4l1.9 1.9 3.4-3.7"/>',
  medal: '<circle cx="12" cy="15.2" r="4.9"/><path d="M8.4 10.9 6.2 3.4l3.3 1.4L12 2.2l2.5 2.6 3.3-1.4-2.2 7.5"/>',
  'medal-fill': '<circle cx="12" cy="15.2" r="4.9" fill="currentColor"/><path d="M8.4 10.9 6.2 3.4l3.3 1.4L12 2.2l2.5 2.6 3.3-1.4-2.2 7.5"/>',

  /* 互动 */
  repost: '<path d="M8.6 3.4 5.6 6.4 8.6 9.4"/><path d="M5.6 6.4h9.2a1.8 1.8 0 0 1 1.8 1.8v4.2"/><path d="M15.4 14.4 18.4 17.4 15.4 20.4"/><path d="M18.4 17.4H9.2a1.8 1.8 0 0 1-1.8-1.8V7.6"/>',
  comment: '<path d="M20.2 11.4c0 3.8-3.7 6.9-8.2 6.9-1 0-2-.2-2.9-.5l-4.8 1.8 1.4-3.4a6.5 6.5 0 0 1-2-4.8c0-3.8 3.7-6.9 8.3-6.9s8.2 3.1 8.2 6.9Z"/>',
  heart: '<path d="M12 20.4S3.5 15.2 3.5 9.5a4.7 4.7 0 0 1 4.7-4.7c1.6 0 3 .8 3.8 2.2a4.6 4.6 0 0 1 3.8-2.2 4.7 4.7 0 0 1 4.7 4.7c0 5.7-8.5 10.9-8.5 10.9Z"/>',
  'heart-fill': '<path d="M12 20.4S3.5 15.2 3.5 9.5a4.7 4.7 0 0 1 4.7-4.7c1.6 0 3 .8 3.8 2.2a4.6 4.6 0 0 1 3.8-2.2 4.7 4.7 0 0 1 4.7 4.7c0 5.7-8.5 10.9-8.5 10.9Z" fill="currentColor"/>',
  trash: '<path d="M4.8 6.9h14.4"/><path d="M9.5 6.9V5.3A1.5 1.5 0 0 1 11 3.8h2a1.5 1.5 0 0 1 1.5 1.5v1.6"/><path d="M6.7 6.9l.9 12.1a1.7 1.7 0 0 0 1.7 1.6h5.4a1.7 1.7 0 0 0 1.7-1.6l.9-12.1"/><path d="M10.4 11v5.6M13.6 11v5.6"/>',
  flag: '<path d="M6.1 20.7V4"/><path d="M6.1 5h10.7l-2 3.3 2 3.3H6.1"/>',
  sofa: '<path d="M4 12.4V9.2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3.2"/><path d="M2.9 12.4h18.2v4.4a2 2 0 0 1-2 2H4.9a2 2 0 0 1-2-2v-4.4Z"/><path d="M7.6 12.4v6.4M16.4 12.4v6.4"/>',
  wave: '<path d="M8.4 11.6V6.9a1.5 1.5 0 0 1 3 0"/><path d="M11.4 10.4V4.8a1.5 1.5 0 0 1 3 0v5.6"/><path d="M14.4 10.9V6.4a1.5 1.5 0 0 1 3 0v7.3c0 3.7-2.8 6.8-6.6 6.8-3.5 0-6.3-2.5-6.3-6.2V9.9a1.5 1.5 0 0 1 3 0v1.7"/>',

  /* 状态 */
  clock: '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.4V12l3.2 2"/>',
  check: '<path d="M5 12.6 9.6 17.2 19 7.6"/>',
  cross: '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>',
  ban: '<circle cx="12" cy="12" r="8.2"/><path d="M6.3 6.3 17.7 17.7"/>',
  inbox: '<path d="M3.8 12.8 6.9 5.6h10.2l3.1 7.2v5.6a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8v-5.6Z"/><path d="M3.8 12.8h4.9l1.2 2.5h4.2l1.2-2.5h4.9"/>',
  warn: '<path d="M12 4.4 20.9 19.7H3.1L12 4.4Z"/><path d="M12 10.2v4.2"/><circle cx="12" cy="17.4" r="1" fill="currentColor" stroke="none"/>',
  at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.7a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.5 7"/>'
};

function icon(name, cls) {
  const p = ICON_PATHS[name];
  if (!p) return '';
  return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true"' +
    ' fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">' +
    p + '</svg>';
}

/* Q 版食材插画素材（有填充、非图标笔触）。
   以前首页会飘三张（番茄 / 胡萝卜 / 煎蛋锅）当浮动装饰，现已去掉——
   这些食材现在只出现在整页背景墙纸里。素材留在这里备用。 */
const FOOD_ART = {
  tomato: '<circle cx="32" cy="37" r="20" fill="#ff6b6b" stroke="#40291b" stroke-width="3.2"/><path d="M32 18c-2.2-4.6-5.6-6.4-10.4-6.4 1 4.2 2.6 6.6 5.4 8.2" fill="#6fcf7f" stroke="#40291b" stroke-width="3" stroke-linejoin="round"/><path d="M32 18c2.2-4.6 5.6-6.4 10.4-6.4-1 4.2-2.6 6.6-5.4 8.2" fill="#6fcf7f" stroke="#40291b" stroke-width="3" stroke-linejoin="round"/><path d="M32 17.2v-5" stroke="#40291b" stroke-width="3.2" stroke-linecap="round"/>',
  carrot: '<path d="M31 22c1.6 0 3.4 1.4 3.4 3.4 0 3.4-4.4 9.4-8.6 15.4-2 2.8-3.4 4.6-4.8 4.6-2 0-3.6-1.6-3.6-3.4 0-1.4 1.2-3 3.6-5.6C26 32 27.6 26.8 28.4 24c.5-1.5 1.2-2 2.6-2Z" fill="#ff8a3d" stroke="#40291b" stroke-width="3.2" stroke-linejoin="round"/><path d="M31.6 21.6c-.6-3.2-.2-5.8 1.6-8.2M30.4 22.6c-2.6-2-4.2-4-4.8-6.8M34 24.6c2.6-1.4 4.4-3 5.4-5.6" fill="none" stroke="#6fcf7f" stroke-width="3" stroke-linecap="round"/><path d="M22.6 36.4l2.2 2.2M25.8 32.2l2.2 2.2" stroke="#40291b" stroke-width="2.6" stroke-linecap="round"/>',
  pan: '<circle cx="27" cy="35" r="17" fill="#7a5c48" stroke="#40291b" stroke-width="3.2"/><circle cx="27" cy="35" r="11.5" fill="#fff8ee" stroke="#40291b" stroke-width="3"/><circle cx="27" cy="35" r="5" fill="#ffd166" stroke="#40291b" stroke-width="3"/><path d="M42 20l7.6-7.6" stroke="#40291b" stroke-width="6" stroke-linecap="round"/><path d="M42 20l7.6-7.6" stroke="#a8896f" stroke-width="3" stroke-linecap="round"/>'
};

function foodArt(name, size) {
  const p = FOOD_ART[name];
  if (!p) return '';
  const s = size || 62;
  return '<svg class="food-art" viewBox="0 0 64 64" width="' + s + '" height="' + s + '" aria-hidden="true">' + p + '</svg>';
}

function roleBadge(u) {
  if (!u) return '';
  if (u.role === 'admin') return '<span class="badge badge-admin">管理员</span>';
  if (u.role === 'reviewer') return '<span class="badge badge-reviewer">审核员</span>';
  return '';
}

function statusBadge(st) {
  if (st === 'pending') return '<span class="badge badge-pending">' + icon('clock') + '待审核</span>';
  if (st === 'approved') return '<span class="badge badge-approved">' + icon('check') + '已通过</span>';
  if (st === 'rejected') return '<span class="badge badge-rejected">' + icon('cross') + '未通过</span>';
  return '';
}

// 带图标时用 innerHTML（文字仍然 esc 过），不带图标就走 textContent，行为不变
function toast(msg, type, ico) {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  if (ico && ICON_PATHS[ico]) el.innerHTML = icon(ico) + '<span>' + esc(msg) + '</span>';
  else el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = '.25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 250);
  }, 2200);
}

async function api(path, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      credentials: 'same-origin',   // 会话走 Cookie，浏览器自动带上
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    // 网络层失败（断网 / 服务暂时起不来 / 被代理拦了）：跟「接口返回错误码」要分开，
    // 否则调用方会把「没连上」误当成「业务失败」，甚至误判成未登录。
    const ne = new Error('网络连接失败，请检查网络后重试');
    ne.network = true;
    throw ne;
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    const err = new Error(data.error || ('请求失败 ' + res.status));
    err.status = res.status;
    err.code = data.code || '';
    // 后端判定「还在用初始口令」时只放行改密，这里把用户直接送到改密页，
    // 否则他只会看到一个看不懂的 403。
    if (err.code === 'MUST_CHANGE_PASSWORD') {
      state.mustChangePw = true;
      if (state.route.name !== 'edit') {
        toast('请先把初始密码换成你自己的', 'err', 'lock');
        setTimeout(() => { try { go('#/edit'); } catch (e2) {} }, 0);
      }
    }
    throw err;
  }
  return data;
}

/** 带重试的启动请求：只在「网络层失败」时重试（服务冷启动/抖动），
 *  401 这类明确的业务结果立刻返回，不浪费次数。 */
async function apiRetry(path, opts, tries, delayMs) {
  tries = tries || 4;
  delayMs = delayMs || 600;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await api(path, opts); }
    catch (e) {
      lastErr = e;
      if (!e.network) throw e;            // 业务错误（如 401）直接抛，不重试
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

function isMod() { return !!state.me && (state.me.role === 'reviewer' || state.me.role === 'admin'); }
function isAdmin() { return !!state.me && state.me.role === 'admin'; }

/* ---------------------- 路由 ---------------------- */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
  const search = qi >= 0 ? raw.slice(qi + 1) : '';
  const parts = pathPart.split('/').filter(Boolean);
  const q = new URLSearchParams(search);
  return { name: parts[0] || 'feed', id: parts[1] || '', q };
}

function go(hash) {
  if (location.hash === hash) router();
  else location.hash = hash;
}

function listRequest() {
  const r = state.route;
  if (r.name === 'mine') return { scope: 'mine' };
  if (r.name === 'user') return { scope: 'user', userId: Number(r.id) || 0 };
  if (r.name === 'search') return { scope: 'feed', q: state.keyword };
  if (r.name === 'hot') return { scope: 'hot' };
  return { scope: state.homeTab === 'following' ? 'following' : 'feed' };
}

async function loadList(append) {
  const req = listRequest();
  state.list.scope = req.scope;
  state.list.userId = req.userId || 0;
  const offset = append ? (state.data.posts || []).length : 0;
  let url = '/api/posts?scope=' + req.scope + '&offset=' + offset + '&limit=20';
  if (req.userId) url += '&userId=' + req.userId;
  if (req.q) url += '&q=' + encodeURIComponent(req.q);
  const d = await api(url);
  state.data.posts = append ? (state.data.posts || []).concat(d.posts) : d.posts;
  state.list.offset = offset + d.posts.length;
  state.list.hasMore = d.hasMore;
  state.list.total = d.total;
}

async function loadNotes() {
  if (!state.me) { state.notes = []; state.data.unread = 0; return; }
  try {
    const d = await api('/api/notifications');
    state.notes = d.notifications;
    state.data.unread = d.unread;
  } catch (e) { /* ignore */ }
}

/* ---------------------- 私信 ---------------------- */

async function loadConversations() {
  if (!state.me) { state.data.conversations = []; return; }
  const d = await api('/api/conversations');
  state.data.conversations = d.conversations || [];
  state.data.unreadMsgs = d.unread || 0;
  updateMsgBadge();
}

// 只拉未读数（顶栏 / 侧栏小红点用；不必把整个会话列表拖下来）
async function loadUnreadMsgs() {
  if (!state.me) { state.data.unreadMsgs = 0; updateMsgBadge(); return; }
  try {
    const d = await api('/api/messages/unread');
    state.data.unreadMsgs = d.unread || 0;
  } catch (e) { /* ignore */ }
  updateMsgBadge();
}

async function openThreadLoad(threadId) {
  if (!threadId || !state.me) return;
  if (isGroupId(threadId)) {
    const gid = Number(String(threadId).slice(1)) || 0;
    const d = await api('/api/groups/' + gid + '/messages');
    state.data.thread = {
      kind: 'group',
      group: d.group,
      messages: d.messages || []
    };
  } else {
    const d = await api('/api/messages/' + threadId);
    state.data.thread = {
      kind: 'dm',
      peer: d.peer,
      relation: d.relation || '',
      messages: d.messages || []
    };
  }
  state.msgDraft = '';
  state.msgQuote = null;
  state.msgMenu = 0;
}

/* 会话 id 约定：群的会话 id 是字符串「g<群id>」，一对一就是纯数字（对方 userId）。
   用这个前缀把两种会话在同一套路由/列表里区分开。 */
function isGroupId(v) { return /^g\d+$/.test(String(v == null ? '' : v)); }
/* 当前登录用户是否在这个群里：优先用 memberIds，缺了就退回扫 members（后端两个字段都给了）。 */
function isInGroup(g) {
  if (!state.me || !g) return false;
  if (Array.isArray(g.memberIds)) return g.memberIds.includes(state.me.id);
  return Array.isArray(g.members) && g.members.some((u) => u.id === state.me.id);
}
function threadRouteId() {
  const raw = String(state.route.id || '');
  if (!raw) return '';
  if (isGroupId(raw)) return raw;
  const n = Number(raw) || 0;
  return n ? String(n) : '';
}

/* 右侧栏数据（热门话题 / 优秀饭帖）统一刷新。
   拉完只**局部替换那两张卡片**，不整页 render() —— 整页重绘会重建 DOM、
   打断正在输入的搜索框或发帖框，所以定时轮询必须走这条路。 */
async function refreshSidebar() {
  const [hot, stats] = await Promise.allSettled([api('/api/hot'), api('/api/stats')]);
  if (hot.status === 'fulfilled') state.data.hot = hot.value;
  if (stats.status === 'fulfilled') state.data.stats = stats.value;
  paintSidebar();
}

function paintSidebar() {
  const hb = $('#hot-box'); if (hb) hb.innerHTML = hotCardInner();
  const fb = $('#feat-box'); if (fb) fb.innerHTML = featuredCardInner();
}

let lastHash = '';
async function router() {
  const prevHash = lastHash;
  const hashNow = location.hash || '#/';
  lastHash = hashNow;
  state.route = parseHash();
  const r = state.route;
  // 记住从哪进详情页，返回时回原页面（首页 / 热门 / 搜索 / 私信都各回各的）
  if (r.name === 'post' && prevHash && !/^#\/post\//.test(prevHash)) state.postFrom = prevHash;
  // 换页时收掉所有浮层（弹窗 / 通知面板 / @补全），避免盖在新页面上
  state.modal = null;
  state.noteOpen = false;
  // 做饭模式是全屏独立层，不跟着 #app 重绘走，换页必须显式关掉
  if (state.cook.open) closeCook();
  // AI 面板也跟着收：草稿留在 state.draft，换页不该挂着一个上一页生成的面板
  state.ai.open = false;
  hideSuggest();
  stopMsgPoll();
  // #/notifications 不是独立页面（通知是浮层），统一回到首页
  if (r.name === 'notifications') { state.loading = false; go('#/'); return; }
  state.loading = true;
  // 搜索页的关键词来自 URL（顶部搜索框、热搜话题、分享链接都走这里）
  state.keyword = r.name === 'search' ? (r.q.get('q') || '') : '';
  // 顶栏输入框只在这两个场景回填：进搜索页带关键词、离开搜索页清空
  state.searchBox = r.name === 'search' ? state.keyword : '';
  // 首页/关注共用 feed 路由：没有 tab 参数就必须回到「推荐」，
  // 否则从 #/?tab=following 点「首页」会继续显示关注流
  if (r.name === 'feed') state.homeTab = r.q.get('tab') === 'following' ? 'following' : 'feed';
  render();

  try {
    if (r.name === 'feed' || r.name === 'hot' || r.name === 'mine' || r.name === 'user' || r.name === 'search') {
      if (r.name === 'mine' && !state.me) { state.loading = false; go('#/login'); return; }
      if (r.name === 'user' && r.id === 'me') { state.loading = false; go('#/mine'); return; }
      const jobs = [
        loadList(false),
        refreshSidebar()
      ];
      if (r.name === 'user') {
        jobs.push(api('/api/users/' + encodeURIComponent(r.id)).then((d) => { state.data.profile = d; }));
      }
      await Promise.all(jobs);
    } else if (r.name === 'review') {
      if (!isMod()) { state.loading = false; go('#/'); return; }
      await refreshSidebar();
      await loadReview();
    } else if (r.name === 'messages') {
      if (!state.me) { state.loading = false; go('#/login'); return; }
      // 打开会话会顺带把对方发来的消息标记为已读，
      // 所以先拉聊天记录，再拉会话列表（列表里的未读数才是准的）
      const tid = r.id ? (isGroupId(r.id) ? r.id : String(Number(r.id) || 0)) : '';
      if (tid) await openThreadLoad(tid);
      await loadConversations();
      if (tid) startMsgPoll();
    } else if (r.name === 'post') {
      const d = await api('/api/posts/' + encodeURIComponent(r.id));
      state.data.post = d.post;
      state.openComments[d.post.id] = true;
      prefetchCook(d.post);
    } else if (r.name === 'edit') {
      if (!state.me) { state.loading = false; go('#/login'); return; }
      state.editAvatar = state.me.avatar || '';
      // 拉取最近一次审核员申请，决定显示「提交申请 / 等待审批 / 重新申请」
      state.data.myApp = null;
      if (state.me.role === 'user') {
        try {
          const d = await api('/api/me/apply-reviewer');
          state.data.myApp = d.application || null;
        } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    toast(e.message, 'err');
  }

  state.loading = false;
  render();
  // 进聊天页滚到底部，直接看到最新消息
  if (r.name === 'messages' && r.id) setTimeout(scrollThread, 30);
}

async function loadReview() {
  if (state.reviewMode === 'posts') {
    const d = await api('/api/posts?scope=all&limit=50');
    let list = d.posts;
    if (state.reviewTab !== 'all') list = list.filter((p) => p.status === state.reviewTab);
    state.data.reviewPosts = list;
  } else if (state.reviewMode === 'reports') {
    const d = await api('/api/reports?status=open');
    state.data.reports = d.reports;
  } else if (state.reviewMode === 'apps') {
    const d = await api('/api/applications');
    state.data.apps = d.applications;
  } else if (state.reviewMode === 'users') {
    const d = await api('/api/admin/users' + (state.keyword ? '?q=' + encodeURIComponent(state.keyword) : ''));
    state.data.users = d.users;
  }
}

/* ---------------------- 顶栏 / 侧栏 / 右栏 ---------------------- */

function noteItemHtml(n) {
  const actor = n.actor ? esc(n.actor.nickname) : '系统';
  const label = {
    like: '赞了你的内容', comment: '评论了你的内容', follow: '关注了你',
    mention: '在内容里提到了你', approve: '你的内容已通过审核',
    reject: '你的内容未通过审核', report: '你的举报已被处理',
    apply: '提交了审核员申请', applyResult: '你的审核员申请有结果了',
    moderation: '有需要你处理的内容',
    feature: '把你的作品选进了「优秀饭帖」'
  }[n.type] || '有新消息';
  const ico = icon({
    like: 'heart-fill', comment: 'chat', follow: 'users', mention: 'at',
    approve: 'check', reject: 'ban', report: 'inbox', apply: 'clipboard',
    applyResult: 'medal', moderation: 'shield', feature: 'medal-fill'
  }[n.type] || 'bell');
  const href = n.postId ? '#/post/' + n.postId : (n.actor ? '#/user/' + n.actor.id : '#/');
  return '<a class="note-item' + (n.read ? '' : ' unread') + '" href="' + href + '" data-action="note-open" data-id="' + n.id + '">' +
    '<span class="note-ico">' + ico + '</span>' +
    '<div class="note-body"><div class="note-txt"><b>' + actor + '</b> ' + label +
      (n.text ? '<span class="note-quote">' + esc(n.text) + '</span>' : '') + '</div>' +
      '<div class="note-time">' + timeAgo(n.createdAt) + '</div></div>' +
    (n.read ? '' : '<span class="note-dot"></span>') +
  '</a>';
}

function notePanel() {
  const unread = state.data.unread || 0;
  const items = state.notes.length
    ? state.notes.map(noteItemHtml).join('')
    : '<div class="note-empty">还没有收到消息</div>';
  return '<div class="note-panel' + (state.noteOpen ? ' open' : '') + '" id="note-panel">' +
    '<div class="note-head"><b>消息通知</b>' +
      (unread ? '<button class="link-btn" data-action="note-read-all">全部已读</button>' : '') +
    '</div>' +
    '<div class="note-list">' + items + '</div>' +
  '</div>';
}

function shell() {
  const me = state.me;
  const unread = state.data.unread || 0;
  const msgUnread = state.data.unreadMsgs || 0;
  return '' +
  '<header class="topbar"><div class="topbar-inner">' +
    '<a class="logo" href="#/">' +
      '<span class="logo-mark"><img src="/assets/mascot.webp" alt="饭圈"></span>' +
      '<span class="logo-text"><b>饭圈</b><em>好好做饭的人都在这里</em></span>' +
    '</a>' +
    '<div class="search"><button type="button" class="search-ico" data-action="search-submit" title="搜索" aria-label="搜索">' + icon('search') + '</button>' +
      '<input id="search-input" placeholder="搜菜谱、搜厨友…" autocomplete="off" enterkeyhint="search" value="' + esc(state.searchBox) + '"></div>' +
    '<div class="topbar-right">' +
      (me
        ? '<button class="bell msg-ico' + (msgUnread ? ' has' : '') + '" data-action="msg-open" title="私信">' + icon('chat') +
            (msgUnread ? '<span class="bell-dot">' + (msgUnread > 99 ? '99+' : msgUnread) + '</span>' : '') +
          '</button>' +
          '<button class="bell' + (unread ? ' has' : '') + '" data-action="note-toggle" title="消息">' + icon('bell') +
            (unread ? '<span class="bell-dot">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
          '</button>' +
          '<a class="user-chip" href="#/mine">' + avatarHtml(me, 0) + '<span>' + esc(me.nickname) + '</span></a>' +
          '<button class="btn-ghost" data-action="logout">退出</button>'
        : '<a class="btn-primary" href="#/login" style="height:36px">登录 / 注册</a>') +
    '</div>' +
    notePanel() +
  '</div></header>';
}

function sidebar() {
  const me = state.me;
  const cur = state.route.name;
  const pending = (state.data.stats && state.data.stats.pending) || 0;
  const openReports = (state.data.stats && state.data.stats.openReports) || 0;
  const modBadge = pending + openReports;
  const msgUnread = state.data.unreadMsgs || 0;

  // 「首页」和「关注」共用 feed 路由，靠 homeTab 区分选中态；
  // 不这样拆的话点「关注」内容变了、高亮却还停在「首页」
  const onFollowing = cur === 'feed' && state.homeTab === 'following';
  const item = (name, href, icon, label, badge, on) =>
    '<a class="nav-item' + ((on === undefined ? cur === name : on) ? ' active' : '') + '" href="' + href + '">' +
      '<span class="nav-icon">' + icon + '</span>' +
      '<span class="nav-label">' + label + '</span>' +
      (badge ? '<span class="nav-badge">' + badge + '</span>' : '') +
    '</a>';

  return '<aside class="col-left">' +
    '<nav class="side-nav">' +
      item('feed', '#/', icon('home'), '首页', '', cur === 'feed' && !onFollowing) +
      item('hot', '#/hot', icon('fire'), '热门') +
      (me ? item('following', '#/?tab=following', icon('users'), '关注', '', onFollowing) : '') +
      item('mine', '#/mine', icon('user'), '我的主页') +
      (me
        ? '<a class="nav-item' + (cur === 'messages' ? ' active' : '') + '" href="#/messages">' +
            '<span class="nav-icon">' + icon('chat') + '</span><span class="nav-label">私信</span>' +
            '<span class="nav-badge" id="nav-msg-badge"' + (msgUnread ? '' : ' style="display:none"') + '>' +
              (msgUnread > 99 ? '99+' : msgUnread) + '</span>' +
          '</a>'
        : '') +
      (isMod() ? item('review', '#/review', icon('shield'), '审核中心', modBadge || '') : '') +
    '</nav>' +
    (me
      ? '<button class="btn-primary btn-block" data-action="new-post">发布新菜</button>'
      : '<a class="btn-primary btn-block" href="#/login">登录开始做饭</a>') +
    '<div class="side-note">' +
      (me
        ? '<p>' + icon('clipboard') + ' 你的内容会先进入<b>待审核</b>，通过后公开。</p>' +
          (isMod() ? '<p style="margin-top:6px">' + icon('shield') + ' 你是' + (isAdmin() ? '管理员' : '审核员') + '，发布内容免审核。</p>'
                   : '<p style="margin-top:6px">' + icon('clipboard') + ' 想帮忙把关？到<a href="#/edit" style="color:var(--brand-2);font-weight:800">我的资料</a>申请审核员。</p>')
        : '<p>' + icon('pan') + ' 登录后就能发帖、点赞、关注厨友。</p>') +
    '</div>' +
  '</aside>';
}

const HOT_RANGE_LABEL = { today: '今日热门话题', week: '近 7 天热门话题', all: '热门话题' };

// 热门话题卡片的内部 HTML。单独抽出来是为了定时刷新时**只换这张卡片**，
// 不整页重绘（整页重绘会打断正在输入的搜索框/发帖框，还会闪）。
// 标题严格按后端返回的真实统计窗口渲染，后端说几天就是几天，不写死"今日"。
function hotCardInner() {
  const hot = state.data.hot || { tags: [], chefs: [] };
  const tagsHtml = hot.tags.length
    ? hot.tags.map((t, i) =>
        '<a class="hot-item" href="#/search?q=' + encodeURIComponent(t.tag) + '"' +
          ' title="' + t.count + ' 篇作品参与 · 共 ' + t.likes + ' 个赞 ｜ 热度 ' + t.heat + ' = 篇数×10 + 赞数">' +
        '<span class="hot-rank">' + (i + 1) + '</span>' +
        '<span class="hot-name">#' + esc(t.tag) + '#</span>' +
        '<span class="hot-heat">' + t.heat + '</span></a>').join('')
    : '<div style="padding:8px;color:var(--ink-3);font-size:13px">还没有话题</div>';
  const upd = hot.updatedAt ? new Date(hot.updatedAt) : null;
  const updTxt = upd
    ? ('更新于 ' + String(upd.getHours()).padStart(2, '0') + ':' + String(upd.getMinutes()).padStart(2, '0') +
       ':' + String(upd.getSeconds()).padStart(2, '0'))
    : '尚未更新';
  return '<h3>' + icon('fire') + esc(HOT_RANGE_LABEL[hot.range] || '热门话题') +
    '<span title="' + esc(updTxt) + '">实时</span></h3>' +
    '<div class="side-list">' + tagsHtml + '</div>';
}

/* 优秀饭帖：审核员/管理员人工评优的作品（右栏第二张卡，占原「活跃厨友」的位置）。
   审核员看别人作品时点「评优」，这里就会出现 —— 是人工挑选，不是算法榜单。 */
function featuredCardInner() {
  const hot = state.data.hot || {};
  const list = hot.featured || [];
  if (!list.length) {
    return '<h3>' + icon('medal') + '优秀饭帖</h3>' +
      '<div class="side-list"><div class="feat-empty">' + icon('medal') +
        ' 还没有评优的作品<br>审核员可以把大家的佳作挂到这里</div></div>';
  }
  const items = list.map((f) =>
    '<a class="feat-item" href="#/post/' + f.id + '" title="' + esc(f.excerpt || '无正文') + '">' +
      (f.image
        ? '<img class="feat-thumb" src="' + esc(f.image) + '" loading="lazy" alt="">'
        : '<span class="feat-thumb feat-thumb-none">' + icon('medal') + '</span>') +
      '<span class="feat-main">' +
        '<span class="feat-text">' + esc(f.excerpt || '（只有图片，没写文字）') + '</span>' +
        '<span class="feat-meta">' + esc(f.author.nickname) + ' · ' + (f.likes || 0) + ' 赞</span>' +
      '</span>' +
    '</a>').join('');
  return '<h3>' + icon('medal') + '优秀饭帖' +
    '<span>' + (hot.featuredTotal || list.length) + ' 篇</span></h3>' +
    '<div class="side-list">' + items + '</div>';
}

function rightbar() {
  return '<aside class="col-right">' +
    '<div class="side-card" id="hot-box">' + hotCardInner() + '</div>' +
    '<div class="side-card" id="feat-box">' + featuredCardInner() + '</div>' +
  '</aside>';
}

/* ---------------------- 发帖框 ---------------------- */

// 发布栏里的「图片」计数 / 上传进度 / 失败提示。
// 目的：让用户随时知道「我实际挂了 N 张 / 9」——以前这里什么都不显示，
// 选了 9 张里有几张传失败时，只有一条 2 秒就消失的 toast，用户会以为全挂上了。
function imgChipHtml() {
  const n = state.draftImages.length;
  if (state.upload) {
    return '<span class="img-chip busy">' + icon('image') + '上传中 ' +
      state.upload.done + '/' + state.upload.total + '…</span>';
  }
  if (state.uploadFailed) {
    return '<span class="img-chip bad" title="部分图片格式不支持或已损坏，没能上传">' + icon('warn') +
      state.uploadFailed + ' 张没能上传</span>';
  }
  return '<span class="img-chip' + (n >= 9 ? ' full' : '') + '">' + icon('image') + '图片 ' + n + '/9</span>';
}

/* ---------------------- AI 小饭（发帖助手） ---------------------- */

// 发布栏里的入口。桌面上写全「AI 润色」，手机上只留「AI」，否则一行挤不下。
function aiBarBtn() {
  return '<button class="ai-btn" data-action="ai-open" title="把你写的话理顺，不改内容和食材">' +
    icon('spark') +
    '<span class="ai-full">AI 润色</span><span class="ai-short">AI</span>' +
    '</button>';
}

// 用了哪个模型（云端 / 本机 / 本地整理）属于内部实现，不给用户看。
function aiPanelHtml() {
  const a = state.ai;
  if (!a.open) return '';
  let body;
  if (a.loading) {
    body = '<div class="ai-loading"><span class="ai-dot"></span><span class="ai-dot"></span>' +
      '<span class="ai-dot"></span>' + (a.slow ? '第一次会慢一点，再等等…' : '小饭正在顺你的稿…') + '</div>';
  } else if (a.err) {
    body = '<div class="ai-err">' + esc(a.err) + '</div>' +
      '<div class="ai-act">' +
        '<button class="btn-ghost btn-sm" data-action="ai-generate">再试一次</button>' +
        '<button class="btn-ghost btn-sm" data-action="ai-close">收起</button>' +
      '</div>';
  } else if (a.text) {
    body = (a.cmp && a.src ? '<div class="ai-src"><span class="ai-src-tag">你写的</span>' + esc(a.src) + '</div>' : '') +
      '<div class="ai-preview">' + richText(a.text) + '</div>' +
      '<div class="ai-act">' +
        '<button class="btn-ghost btn-sm" data-action="ai-again">换一版</button>' +
        '<button class="btn-primary btn-sm" data-action="ai-use">用这版</button>' +
        '<button class="btn-ghost btn-sm" data-action="ai-close">收起</button>' +
      '</div>';
  } else {
    body = '<div class="ai-tip">先写几句你想说的——做了什么、什么味道、哪一步翻车了。' +
      '小饭只在你的话上做优化，食材、用量、做法一个字都不改。</div>' +
      '<div class="ai-act">' +
        '<button class="btn-primary btn-sm" data-action="ai-generate">帮我润色</button>' +
        '<button class="btn-ghost btn-sm" data-action="ai-close">收起</button>' +
      '</div>';
  }
  return '<div class="ai-box">' +
    '<div class="ai-head">' +
      '<span class="ai-name">' + icon('spark') + '小饭<span class="ai-ai"> AI</span></span>' +
      (a.text && a.src ? '<button class="ai-cmp-t" data-action="ai-cmp">' + (a.cmp ? '收起' : '原文') + '</button>' : '') +
      '<button class="ai-x" data-action="ai-close" title="收起">×</button>' +
    '</div>' + body + '</div>';
}

// 只重画这一块：整页 render 会把打字的光标位置弄丢
function paintAi() {
  const el = $('#ai-panel');
  if (el) el.innerHTML = aiPanelHtml();
}

function aiOpen() {
  if (!state.me) { go('#/login'); return; }
  state.ai.open = true;
  paintAi();
  const ta = $('#compose-text') || $('#composer-text');
  const text = (ta ? ta.value : state.draft || '').trim();
  // 已经写了东西就直接改，省一次点击；太短就留在提示上，别硬改
  if (text.length >= 6) doAiGenerate();
}

async function doAiGenerate(more) {
  if (state.ai.loading) return;
  const ta = $('#compose-text') || $('#composer-text');
  const text = (ta ? ta.value : state.draft || '').trim();
  if (text.length < 6) {
    state.ai.err = '';
    state.ai.text = '';
    state.ai.src = '';
    paintAi();
    toast('再多写两句——做了什么、什么味道，我才好在你写的话上改', 'err');
    return;
  }
  state.ai.open = true;
  state.ai.loading = true;
  state.ai.err = '';
  state.ai.slow = false;
  state.ai.src = text;
  state.ai.n = more ? (state.ai.n || 0) + 1 : 0;
  paintAi();
  // 本机模型冷启动要几十秒，5 秒还没回来就换一句提示，别让人以为卡死
  const slowTimer = setTimeout(() => {
    if (!state.ai.loading) return;
    state.ai.slow = true;
    paintAi();
  }, 5000);
  try {
    const d = await api('/api/ai/compose', { method: 'POST', body: { text, seed: state.ai.n } });
    state.ai.text = d.text || '';
    state.ai.tags = d.tags || [];
    state.ai.provider = d.provider || '';
    if (!state.ai.text) state.ai.err = '小饭卡住了，再试一次吧';
  } catch (e) {
    state.ai.err = e.message || 'AI 暂时想不出来，先手写吧';
    state.ai.text = '';
    state.ai.provider = '';
  }
  clearTimeout(slowTimer);
  state.ai.loading = false;
  state.ai.slow = false;
  paintAi();
}

function aiUse() {
  const t = state.ai.text;
  if (!t) return;
  const ta = $('#compose-text') || $('#composer-text');
  if (ta) ta.value = t;
  state.draft = t;
  state.aiUsed = true;
  state.ai.open = false;
  paintAi();
  const c = $('#composer-count');
  if (c) c.textContent = t.length + '/2000';
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  toast('已填入，你的原意都在，顺手就能发', 'ok', 'check');
}

function viewComposer() {
  // 发布弹窗打开时不再渲染这个内嵌输入框，避免两套输入框 / id 冲突
  if (state.modal && state.modal.type === 'compose') return '';
  if (!state.me) {
    return '<div class="card" style="padding:16px 20px;display:flex;align-items:center;gap:12px">' +
      '<span style="font-size:24px;color:var(--brand-2)">' + icon('pan') + '</span>' +
      '<div style="flex:1;color:var(--ink-2);font-size:14px">登录后就能发布你的菜谱和作品</div>' +
      '<a class="btn-primary" href="#/login" style="height:36px">立即登录</a></div>';
  }
  const thumbs = state.draftImages.map((u, i) =>
    '<div class="thumb"><img src="' + esc(u) + '" data-zoom="' + esc(u) + '">' +
    '<button data-action="rm-image" data-idx="' + i + '">×</button></div>').join('');

  return '<div class="card composer">' + avatarHtml(state.me, 44) +
    '<div class="composer-body">' +
      '<textarea id="composer-text" placeholder="今天做了什么好吃的？分享一下做法吧… 用 @ 可以提到厨友">' + esc(state.draft) + '</textarea>' +
      (thumbs ? '<div class="composer-images">' + thumbs + '</div>' : '') +
      '<div class="composer-bar">' +
        '<label class="file-label">' + icon('image') + '图片<input type="file" id="file-input" accept="image/*" multiple hidden></label>' +
        imgChipHtml() +
        aiBarBtn() +
        '<span class="hint">' + (isMod() ? '你是审核员，发布即公开' : '发布后进入审核队列，通过后公开') + '</span>' +
        '<span class="hint count" id="composer-count">' + (state.draft ? state.draft.length : 0) + '/2000</span>' +
        '<button class="btn-primary" data-action="publish" style="height:36px">发布</button>' +
      '</div>' +
      '<div id="ai-panel">' + aiPanelHtml() + '</div>' +
    '</div></div>';
}

/* ---------------------- 帖子卡片 ---------------------- */

function imgsHtml(images) {
  const n = Math.min(images.length, 9);
  return '<div class="post-imgs n' + n + '">' +
    images.slice(0, 9).map((u) => '<img src="' + esc(u) + '" data-zoom="' + esc(u) + '" loading="lazy">').join('') +
    '</div>';
}

function postCard(p, opts) {
  opts = opts || {};
  const open = opts.openComments || state.openComments[p.id];
  // 评优入口只给审核员/管理员，且只能评别人的、已通过的作品（后端也会再拦一次）
  const canFeature = isMod() && !!state.me && p.status === 'approved' &&
    p.author && p.author.id !== state.me.id;
  return '<article class="post' + (opts.inDetail ? ' post-detail' : '') + '" data-post="' + p.id + '">' +
    avatarHtml(p.author, 44) +
    '<div class="post-body">' +
      '<div class="post-head">' +
        '<a class="post-name" href="#/user/' + p.author.id + '">' + esc(p.author.nickname) + '</a>' +
        roleBadge(p.author) +
        (p.aiAssisted ? '<span class="badge badge-ai">' + icon('spark') + 'AI 辅助</span>' : '') +
        (p.featured ? '<span class="badge badge-feat">' + icon('medal-fill') + '优秀</span>' : '') +
        '<span class="post-meta">' + timeAgo(p.createdAt) + '</span>' +
        ((opts.showStatus || p.status !== 'approved') ? statusBadge(p.status) : '') +
        (p.reportCount ? '<span class="badge badge-pending">' + icon('flag') + p.reportCount + '</span>' : '') +
        (state.me && (!p.author || p.author.id !== state.me.id)
          ? '<button class="act-more" data-action="report" data-id="' + p.id + '" title="举报">' + icon('flag') + '</button>' : '') +
      '</div>' +
      (p.content ? '<div class="post-text">' + richText(p.content) + '</div>' : '') +
      (p.images && p.images.length ? imgsHtml(p.images) : '') +
      (p.status === 'rejected' && p.rejectReason
        ? '<div class="reject-note">未通过原因：' + esc(p.rejectReason) + '</div>' : '') +
      '<div class="post-bar">' +
        '<button class="act" data-action="share" data-id="' + p.id + '" title="转发给厨友">' +
          '<span class="ico">' + icon('repost') + '</span>转发</button>' +
        '<button class="act" data-action="comment-toggle" data-id="' + p.id + '">' +
          '<span class="ico">' + icon('comment') + '</span>' + (p.commentCount || '评论') + '</button>' +
        '<button class="act ' + (p.liked ? 'on on-like' : '') + '" data-action="like" data-id="' + p.id + '">' +
          '<span class="ico">' + icon(p.liked ? 'heart-fill' : 'heart') + '</span>' + (p.likeCount || '点赞') + '</button>' +
        (canFeature
          ? '<button class="act ' + (p.featured ? 'on' : '') + '" data-action="feature" data-id="' + p.id + '"' +
            ' title="' + (p.featured ? '从「优秀饭帖」里撤下来' : '把这条作品挂进「优秀饭帖」') + '">' +
            '<span class="ico">' + icon(p.featured ? 'medal-fill' : 'medal') + '</span>' +
            (p.featured ? '已评优' : '评优') + '</button>'
          : '') +
        (p.canDelete
          ? '<button class="act danger" data-action="delete" data-id="' + p.id + '" style="margin-left:auto">' +
            '<span class="ico">' + icon('trash') + '</span>删除</button>' : '') +
      '</div>' +
      (open ? commentsHtml(p) : '') +
    '</div></article>';
}

function commentsHtml(p) {
  const inner = p.comments.length
    ? p.comments.map((c) =>
        '<div class="comment"><b>' + esc(c.user.nickname) + '</b>：' + richText(c.content) +
        '<span class="t">' + timeAgo(c.createdAt) + '</span>' +
        (c.canDelete ? '<button class="cmt-del" data-action="cmt-del" data-pid="' + p.id +
          '" data-cid="' + c.id + '" title="删除评论">×</button>' : '') +
        '</div>').join('')
    : '<div style="font-size:13px;color:var(--ink-3);padding:4px 0">' + icon('sofa') + ' 还没有评论，来抢沙发</div>';
  const form = state.me
    ? '<div class="comment-form">' +
        '<input data-comment-input="' + p.id + '" placeholder="说点什么… 用 @ 提到厨友" maxlength="500">' +
        '<button class="btn-primary btn-sm" data-action="comment-submit" data-id="' + p.id +
        '" style="height:34px;border-radius:17px">发送</button>' +
      '</div>'
    : '<div class="comment-form"><input disabled placeholder="登录后参与评论"></div>';
  return '<div class="comments">' + inner + form + '</div>';
}

function postList(posts, opts) {
  opts = opts || {};
  if (!posts || !posts.length) {
    return '<div class="card empty">' +
      '<img src="/assets/empty.webp" alt="">' +
      '<div>' + (opts.emptyText || '这里还什么都没有') + '</div></div>';
  }
  const more = (state.list.hasMore && !opts.noMore)
    ? '<button class="btn-ghost load-more" data-action="load-more"' + (state.list.loadingMore ? ' disabled' : '') + '>' +
      (state.list.loadingMore ? '加载中…' : '加载更多（' + Math.max(0, state.list.total - posts.length) + '）') + '</button>'
    : '';
  return '<div class="post-list">' + posts.map((p) => postCard(p, opts)).join('') + more + '</div>';
}

function filterPosts() {
  let list = state.data.posts || [];
  const kw = state.keyword.toLowerCase();
  if (kw && state.route.name !== 'search') {
    list = list.filter((p) =>
      (p.content || '').toLowerCase().includes(kw) ||
      (p.author && p.author.nickname.toLowerCase().includes(kw)));
  }
  return list;
}

/* ---------------------- 各视图 ---------------------- */

function viewFeed() {
  const minePending = (state.me && state.homeTab === 'feed')
    ? (state.data.posts || []).filter((p) => p.author && p.author.id === state.me.id && p.status === 'pending').length
    : 0;
  const following = state.homeTab === 'following';
  // 顶部「首页 / 看看大家今天都做了什么好吃的」标题卡已删除：
  // 左侧（手机是横向）导航已经标明当前在哪一页，这块只占地方。
  // 「推荐 / 关注」切换同理，导航的「首页」「关注」就是入口。
  return (minePending
      ? '<div class="card notice-pending">' + icon('clock') + ' 你有 <b>' + minePending + '</b> 条内容正在审核中 — 只有你自己能看到（带「待审核」标记），审核通过后所有人可见。</div>'
      : '') +
    // 「关注」流不显示发布框：那一屏是"看别人"的，放发布框反而让人以为没切过来
    (following ? '' : viewComposer()) +
    (following ? followingEmptyOrList() : postList(filterPosts(), {
      emptyText: '还没有通过的菜谱，快去发布第一条吧'
    }));
}

// 「关注」标签下的内容：有内容就正常列；空的时候给一个明确、能点走下一步的空状态
function followingEmptyOrList() {
  const posts = filterPosts();
  if (posts.length) return postList(posts);
  const emptyText = state.me
    ? '你关注的厨友还没发过新菜。去「热门」逛逛，找到合胃口的厨友关注一下，TA 的新菜就会出现在这里。'
    : '登录后就能在这里看到你关注的厨友动态。';
  return '<div class="card empty">' +
      '<img src="/assets/empty.webp" alt="">' +
      '<div>' + emptyText + '</div>' +
      (state.me
        ? '<a class="btn-primary" href="#/hot" style="display:inline-flex;align-items:center;height:40px;margin-top:14px">' + icon('fire') + '去热门找人关注</a>'
        : '<a class="btn-primary" href="#/login" style="display:inline-flex;align-items:center;height:40px;margin-top:14px">去登录</a>') +
    '</div>';
}

function viewHot() {
  return '<div class="card page-head"><div>' +
      '<h2>' + icon('fire') + '热门</h2><div class="sub">按互动热度排序，看看大家都在做什么</div></div></div>' +
    viewComposer() + postList(state.data.posts || []);
}

// 搜索结果页的标题区：关键词和「共找到 n 条」都在这儿，边打边搜时只换这块的 innerHTML
function searchHeadInner(kw) {
  return '<div>' +
      '<h2>' + icon('search') + (kw ? '搜索「' + esc(kw) + '」' : '搜索') + '</h2>' +
      '<div class="sub">' + (kw
        ? '共找到 ' + (state.list.total || 0) + ' 条相关内容'
        : '试试搜「红烧肉」「面条」，或者厨友的名字') + '</div>' +
    '</div>';
}

function searchBackBtn() {
  return '<a class="btn-ghost btn-sm" href="#/" style="display:inline-flex;align-items:center">返回首页</a>';
}

function searchEmptyText(kw) {
  return kw ? '没有找到「' + esc(kw) + '」相关的内容' : '输入关键词，菜谱和厨友都能搜';
}

function viewSearch() {
  const kw = state.keyword.trim();
  return '<div class="card page-head" id="search-head">' + searchHeadInner(kw) + searchBackBtn() + '</div>' +
    '<div id="search-results">' + postList(state.data.posts || [], { emptyText: searchEmptyText(kw) }) + '</div>';
}

/* 搜索页「边打边搜」：只重画结果区和标题，不碰路由、不重建输入框。
   以前是每 420ms 就 go('#/search?q=…')，路由换页会把整个 #app 重建一遍 ——
   打字比这个间隔快时，后打的字会被上一轮的旧快照覆盖，手机上键盘还会跟着收起来。 */
let searchSeq = 0;
async function runSearch(raw) {
  const kw = String(raw == null ? '' : raw).trim();
  const box = document.getElementById('search-results');
  if (!box) return;                       // 已经离开搜索页
  const seq = ++searchSeq;
  state.keyword = kw;                     // 「加载更多」用 keyword 拼参数
  state.list.loadingMore = false;

  // 清空了输入框：不跳走（跳走会把键盘收掉），只把结果区换成提示
  if (!kw) {
    state.data.posts = [];
    state.list.total = 0;
    state.list.hasMore = false;
    state.list.offset = 0;
    const h0 = document.getElementById('search-head');
    if (h0) h0.innerHTML = searchHeadInner('') + searchBackBtn();
    const b0 = document.getElementById('search-results');
    if (b0) {
      b0.classList.remove('searching');
      b0.innerHTML = postList([], { emptyText: searchEmptyText('') });
    }
    history.replaceState(null, '', '#/search');
    return;
  }

  box.classList.add('searching');
  try {
    const d = await api('/api/posts?scope=feed&offset=0&limit=20' +
      (kw ? '&q=' + encodeURIComponent(kw) : ''));
    if (seq !== searchSeq) return;        // 后发的请求先回来，丢弃旧结果
    state.data.posts = d.posts || [];
    state.list.total = d.total || 0;
    state.list.hasMore = d.hasMore;
    state.list.offset = (d.posts || []).length;
    state.list.scope = 'feed';
    state.list.userId = 0;
    const head = document.getElementById('search-head');
    if (head) head.innerHTML = searchHeadInner(kw) + searchBackBtn();
    const now = document.getElementById('search-results');
    if (now) {
      now.innerHTML = postList(state.data.posts, { emptyText: searchEmptyText(kw) });
      now.classList.remove('searching');
    }
    // 地址栏跟着走（刷新 / 分享能回到这次搜索），但用 replaceState 不走 router，避免整页重建
    history.replaceState(null, '', '#/search' + (kw ? '?q=' + encodeURIComponent(kw) : ''));
  } catch (e) {
    if (box) box.classList.remove('searching');
    toast(e.message, 'err');
  }
}

// 主页统计里的「粉丝 / 关注」：做成可点按钮，点开弹窗看具体是哪些人
function relStat(count, label, tab, ownerId) {
  return '<button type="button" class="stat-btn" data-action="relations" data-tab="' + tab +
    '" data-id="' + ownerId + '" title="看看' + label + '都有谁">' +
    '<b>' + count + '</b>' + label + '</button>';
}

// 粉丝名单是私密的：别人只能看到数字，看不到是谁 —— 所以这里是普通统计项，不是按钮。
// 不做成"点不动"的按钮（那看着像坏了），直接就没有可点的样子。
function plainStat(count, label, why) {
  return '<div title="' + esc(why) + '"><b>' + count + '</b>' + label + '</div>';
}

// 主页统计里的「待审核」：同样做成可点按钮，点开看具体是哪几条
function pendingStat(count) {
  return '<button type="button" class="stat-btn" data-action="pending-posts"' +
    ' title="看看哪些内容还在等审核">' +
    '<b>' + count + '</b>待审核</button>';
}

// 待审核弹窗里的一条：正文 + 图片缩略 + 提交时间
function pendingRowHtml(p) {
  const total = (p.images || []).length;
  const imgs = total
    ? '<div class="pend-imgs">' +
        p.images.slice(0, 4).map((u) =>
          '<img src="' + esc(u) + '" data-zoom="' + esc(u) + '" alt="">').join('') +
        (total > 4 ? '<span class="pend-more">+' + (total - 4) + '</span>' : '') +
      '</div>'
    : '';
  return '<div class="pend-row">' +
    (p.content ? '<div class="pend-text">' + richText(p.content) + '</div>' : '') +
    imgs +
    '<div class="pend-meta">' + icon('clock') + ' 提交于 ' + timeAgo(p.createdAt) + '</div>' +
  '</div>';
}

// 关注/粉丝弹窗里的一行：头像 + 昵称 + 简介 + 关注按钮
function relRowHtml(u) {
  const meta = u.bio
    ? '<div class="rel-bio">' + esc(u.bio) + '</div>'
    : '<div class="rel-bio muted">' + (u.postCount || 0) + ' 篇作品 · ' + (u.followerCount || 0) + ' 粉丝</div>';
  const act = u.isMe
    ? '<span class="rel-self">我</span>'
    : (state.me
      ? '<button type="button" class="btn-follow sm' + (u.isFollowing ? ' on' : '') +
        '" data-action="follow" data-id="' + u.id + '">' + (u.isFollowing ? '已关注' : '+ 关注') + '</button>'
      : '');
  return '<div class="rel-row">' +
    '<a class="rel-link" href="' + (u.isMe ? '#/mine' : '#/user/' + u.id) + '">' + avatarHtml(u, 46) +
      '<div class="rel-info">' +
        '<div class="rel-name">' + esc(u.nickname) + roleBadge(u) + '</div>' +
        '<div class="rel-sub">@' + esc(u.username) + '</div>' + meta +
      '</div></a>' + act +
  '</div>';
}

function viewMine() {
  const me = state.me;
  if (!me) return '';
  const posts = state.data.posts || [];
  const approved = posts.filter((p) => p.status === 'approved');
  const likes = approved.reduce((s, p) => s + (p.likeCount || 0), 0);

  return '<div class="card profile-head">' +
      '<div class="profile-cover"></div>' +
      '<div class="profile-info">' + avatarHtml(me, 0) +
        '<div class="profile-name"><h2>' + esc(me.nickname) + '</h2>' +
          '<p>@' + esc(me.username) + '</p></div>' +
        '<div class="profile-act">' +
          '<a class="btn-ghost btn-sm" href="#/edit" style="display:inline-flex;align-items:center">' + icon('pencil') + '编辑资料</a>' +
          (isMod() ? '<a class="btn-ghost btn-sm" href="#/review" style="display:inline-flex;align-items:center">' + icon('shield') + '审核中心</a>' : '') +
        '</div>' +
      '</div>' +
      (me.bio ? '<div class="profile-bio">' + esc(me.bio) + '</div>' : '') +
      '<div class="profile-stats">' +
        '<div><b>' + approved.length + '</b>已发布</div>' +
        '<div><b>' + likes + '</b>获赞</div>' +
        relStat(me.followerCount || 0, '粉丝', 'followers', me.id) +
        relStat(me.followingCount || 0, '关注', 'following', me.id) +
        pendingStat(posts.filter((p) => p.status === 'pending').length) +
      '</div>' +
    '</div>' +
    '<div class="card page-head" style="padding:14px 20px 10px">' +
      '<div class="sub">我的全部内容（含审核状态）</div>' +
    '</div>' +
    postList(posts, { showStatus: true, noMore: true, emptyText: '你还没有发布任何内容' });
}

function viewUser() {
  const d = state.data.profile;
  if (!d) return '<div class="card empty">加载中…</div>';
  const u = d.user;
  const stats = d.stats || {};
  return '<div class="card profile-head">' +
      '<div class="profile-cover"></div>' +
      '<div class="profile-info">' + avatarHtml(u, 0) +
        '<div class="profile-name"><h2>' + esc(u.nickname) + '</h2>' +
          '<p>@' + esc(u.username) + '</p></div>' +
        (d.isSelf
          ? '<div class="profile-act"><a class="btn-ghost btn-sm" href="#/edit" style="display:inline-flex;align-items:center">' + icon('pencil') + '编辑资料</a></div>'
          : (state.me
            ? '<div class="profile-act">' +
                '<button class="btn-follow' + (d.isFollowing ? ' on' : '') +
                  '" data-action="follow" data-id="' + u.id + '">' + (d.isFollowing ? '已关注' : '+ 关注') + '</button>' +
                '<button class="btn-ghost btn-sm" data-action="msg-open" data-id="' + u.id +
                  '" style="display:inline-flex;align-items:center">' + icon('chat') + '私信</button>' +
              '</div>'
            : '')) +
      '</div>' +
      (u.bio ? '<div class="profile-bio">' + esc(u.bio) + '</div>' : '') +
      '<div class="profile-stats">' +
        '<div><b>' + (stats.posts || 0) + '</b>作品</div>' +
        '<div><b>' + (stats.likes || 0) + '</b>获赞</div>' +
        // 粉丝 / 关注名单都只有本人能看，所以非本人这两项都是普通统计项（不是"点不动的按钮"）
        (d.isSelf
          ? relStat(u.followerCount || 0, '粉丝', 'followers', u.id)
          : plainStat(u.followerCount || 0, '粉丝', 'TA 的粉丝名单不公开')) +
        (d.isSelf
          ? relStat(u.followingCount || 0, '关注', 'following', u.id)
          : plainStat(u.followingCount || 0, '关注', 'TA 的关注名单不公开')) +
      '</div>' +
      // 「加入于」没有数字，留在统计行里会跟数字挤在同一基线；挪到下面单独一行
      '<div class="profile-joined">' + icon('calendar') + ' 加入于 ' + timeAgo(u.createdAt) + '</div>' +
      roleBadge(u) +
    '</div>' +
    postList(d.posts, { noMore: true, emptyText: 'TA 还没有公开的作品' });
}

function viewPost() {
  const p = state.data.post;
  if (!p) return '<div class="card empty">加载中…</div>';
  return '<div class="card page-head" style="padding:14px 20px">' +
      '<a class="btn-ghost" href="' + esc(state.postFrom || '#/') + '">' + icon('back') + '返回</a>' +
      '<div class="sub">帖子详情</div>' +
    '</div>' +
    // 入口放在帖子前面：详情页默认展开评论，放下面会被一长串评论推到看不见的地方
    cookCtaHtml(p) + postCard(p, { showStatus: true, inDetail: true });
}

/* -------- 做饭模式 / 厨房急诊 -------- */

/* 详情页底部的入口：正文太短（只有一句话）就不出现，免得拆出来全是空话 */
function cookCtaHtml(p) {
  if (!p || p.status !== 'approved') return '';
  if ((p.content || '').replace(/\s+/g, '').length < 20) return '';
  return '<div class="card cook-cta">' +
      '<div class="cook-cta-ico">' + icon('chef') + '</div>' +
      '<div class="cook-cta-main">' +
        '<b>照着做一遍</b>' +
        '<span>小饭把这条帖子拆成几步，一步一屏，灶台边不用划来划去</span>' +
      '</div>' +
      '<button class="btn-primary cook-cta-btn" data-action="cook-open" data-id="' + p.id + '">开始做</button>' +
    '</div>';
}

function cookRoot() {
  let el = document.getElementById('cook-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cook-root';
    document.body.appendChild(el);
  }
  return el;
}

function cookStep() {
  const c = state.cook;
  return c.steps[Math.min(c.i, c.steps.length - 1)] || null;
}

function cookHtml() {
  const c = state.cook;
  const total = c.steps.length;
  const s = cookStep();
  const head = '<div class="cook-top">' +
      '<button class="cook-x" data-action="cook-close" title="退出">' + icon('cross') + '</button>' +
      '<div class="cook-title">' +
        '<b>' + esc(c.dish || '这道菜') + '</b>' +
        '<span>' + (c.done ? '做完了' : (total ? '第 ' + (c.i + 1) + ' / ' + total + ' 步' : '准备中')) + '</span>' +
      '</div>' +
      '<button class="cook-read" data-action="cook-speak" title="朗读这一步"' +
        (c.loading || c.err || c.done || !total ? ' disabled' : '') + '>' + icon('volume') + '<span>读一遍</span></button>' +
    '</div>' +
    '<div class="cook-prog"><i style="width:' +
      (c.done ? 100 : (total ? Math.round(((c.i + 1) / total) * 100) : 0)) + '%"></i></div>';

  let stage;
  if (c.loading) {
    stage = '<div class="cook-stage"><div class="cook-inner cook-center">' +
        '<div class="cook-ld">' + icon('spark') + '</div>' +
        '<h2>小饭在拆步骤…</h2>' +
        '<p>第一次要十几秒，拆完就存在这条帖子上，以后谁打开都是秒开。</p>' +
      '</div></div>';
  } else if (c.err) {
    stage = '<div class="cook-stage"><div class="cook-inner cook-center">' +
        '<h2>没拆出来</h2>' +
        '<p>' + esc(c.err) + '</p>' +
        '<button class="cook-btn main" data-action="cook-open" data-id="' + c.postId + '">再试一次</button>' +
      '</div></div>';
  } else if (c.done) {
    stage = '<div class="cook-stage"><div class="cook-inner cook-center cook-done">' +
        '<div class="cook-done-ico">' + icon('check') + '</div>' +
        '<h2>做好了</h2>' +
        '<p>' + esc(c.dish || '这道菜') + '，' + total + ' 步走完。拍张照，发出来让大家看看。</p>' +
        '<button class="cook-btn main" data-action="cook-newpost">' + icon('pen') + '发一条成品</button>' +
        '<button class="cook-btn ghost wide" data-action="cook-close">回到帖子</button>' +
      '</div></div>';
  } else if (s) {
    const timerOn = c.timerEnd || c.timerPaused || c.timerDone;
    // 手机上没有 hover，title 看不到，所以把用法写在按钮下面一行
    const timerWord = c.timerDone ? '再来一轮' : c.timerPaused ? '继续' : c.timerEnd ? '暂停' : '开始';
    const timer = s.timer
      ? '<div class="cook-timer-wrap">' +
          '<button class="cook-timer' + (c.timerPaused ? ' paused' : '') + (c.timerDone ? ' ring' : '') +
            '" data-action="cook-timer" data-sec="' + s.timer + '">' +
            icon('clock') + '<span id="cook-timer-txt">' + (timerOn ? cookTimerText() : '计时 ' + cookClock(s.timer)) + '</span>' +
          '</button>' +
          '<span class="cook-timer-hint" id="cook-timer-hint">点一下' + timerWord + ' · 连点两下重置</span>' +
        '</div>'
      : '';
    const ans = c.answer
      ? '<div class="cook-ans">' +
          '<div class="cook-ans-head">' + icon('spark') + '<b>小饭说</b></div>' +
          '<p>' + esc(c.answer) + '</p>' +
          '<div class="cook-ans-note">是厨友经验，不是标准教程；按你家锅的火力微调</div>' +
        '</div>'
      : '';
    const ask = c.askOpen
      ? '<div class="cook-ask">' +
          '<div class="cook-ask-row">' +
            '<input id="ck-q" maxlength="120" placeholder="比如：汁收不干 / 肉有点柴" value="' + esc(c.draftQ) + '">' +
            '<button class="cook-send" data-action="cook-ask"' + (c.asking ? ' disabled' : '') + '>' +
              (c.asking ? '…' : '问') + '</button>' +
          '</div>' +
          '<div class="cook-chips">' +
            ['太咸', '糊锅', '肉柴', '汁多', '没熟'].map((t) =>
              '<button class="cook-chip" data-action="cook-quick" data-q="' + t + '">' + t + '</button>').join('') +
          '</div>' +
          (c.askErr ? '<div class="cook-err">' + esc(c.askErr) + '</div>' : '') +
        '</div>'
      : '<button class="cook-help-btn" data-action="cook-ask-open">' + icon('comment') + '这一步卡住了？问一句</button>';

    stage = '<div class="cook-stage"><div class="cook-inner">' +
        '<div class="cook-num">第 ' + (c.i + 1) + ' 步</div>' +
        '<h1 class="cook-h">' + esc(s.t) + '</h1>' +
        (s.d && s.d !== s.t ? '<p class="cook-d">' + esc(s.d) + '</p>' : '') +
        (s.w ? '<div class="cook-why">' + icon('spark') + '<span>' + esc(s.w) + '</span></div>' : '') +
        timer + ask + ans +
        (c.approx
          ? '<div class="cook-approx">' + icon('warn') + '原帖写得比较简略，这几步是按家常做法补的，细节以原帖为准</div>'
          : '') +
      '</div></div>';
  } else {
    stage = '<div class="cook-stage"><div class="cook-inner cook-center"><p>没有步骤</p></div></div>';
  }

  const foot = (c.loading || c.err || c.done || !total) ? '' :
    '<div class="cook-foot">' +
      '<button class="cook-btn ghost" data-action="cook-prev"' + (c.i === 0 ? ' disabled' : '') + '>上一步</button>' +
      '<button class="cook-btn main" data-action="cook-next">' +
        (c.i >= total - 1 ? '做好了' : '下一步') + '</button>' +
    '</div>';

  return '<div class="cook-ov" role="dialog" aria-modal="true">' +
      '<div class="cook-shell">' + head + stage + foot + '</div>' +
    '</div>';
}

function cookClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function cookTimerText() {
  const c = state.cook;
  if (c.timerPaused) return '已暂停 ' + cookClock(Math.max(0, c.timerLeft) / 1000);
  if (c.timerDone) return '时间到';
  const left = Math.max(0, Math.round((c.timerEnd - Date.now()) / 1000));
  return left > 0 ? '剩 ' + cookClock(left) : '时间到';
}

function paintCook() {
  const root = cookRoot();
  root.innerHTML = state.cook.open ? cookHtml() : '';
  document.documentElement.classList.toggle('cook-on', !!state.cook.open);
}

/* 到点提示音：不引音频文件，用 Web Audio 现搓三声「叮」。
   浏览器要求先有一次用户手势才能播，所以点「计时」时顺手解锁（cookAudioUnlock）。 */
let cookAC = null;
function cookAudioUnlock() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!cookAC) cookAC = new AC();
    if (cookAC.state === 'suspended') cookAC.resume();
  } catch (e) { cookAC = null; }
}
function cookBeep() {
  if (!cookAC) cookAudioUnlock();
  if (!cookAC) return;
  try {
    const t0 = cookAC.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = cookAC.createOscillator();
      const g = cookAC.createGain();
      const t = t0 + i * 0.42;
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g); g.connect(cookAC.destination);
      o.start(t); o.stop(t + 0.32);
    }
  } catch (e) { /* 播不了就算了，还有震动和文字 */ }
}

/* 只更新计时那一行，不重绘整屏（重绘会让输入框失焦）。
   剩余时间一律用 timerEnd - Date.now() 算，不靠累加：
   切后台时浏览器会把 setInterval 冻到几十秒一次，回到前台这一下就能校正；
   但「冻住的那段时间」到点也不会响，所以 visibilitychange 里要再拉一次。 */
let cookTick = 0;
function startCookTick() {
  stopCookTick();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const el = document.getElementById('cook-timer-txt');
    if (!el || !state.cook.timerEnd) return;
    const left = state.cook.timerEnd - Date.now();
    el.textContent = left > 0 ? '剩 ' + cookClock(left / 1000) : '时间到';
    if (left <= 0) {
      stopped = true;          // 先立标志：立刻到点时不建 interval，否则会再响一遍
      stopCookTick();
      state.cook.timerDone = true;
      state.cook.timerEnd = 0;  // 到点就清掉时间戳，否则单击会被当成「正在计时」去暂停
      const btn = document.querySelector('.cook-timer');
      if (btn) btn.classList.add('ring');
      // 到点只改了按钮，提示行要跟着换，否则还停在「点一下暂停」
      const hint = document.getElementById('cook-timer-hint');
      if (hint) hint.textContent = '点一下再来一轮 · 连点两下重置';
      cookBeep();
      toast('时间到，看看锅里', 'ok', 'clock');
      try { if (navigator.vibrate) navigator.vibrate([260, 140, 260]); } catch (e) { /* 忽略 */ }
    }
  };
  tick();
  if (!stopped) cookTick = setInterval(tick, 500);
}
function stopCookTick() {
  if (cookTick) { clearInterval(cookTick); cookTick = 0; }
}

/* 同一条帖子只请求一次：预拆和「开始做」共用同一个 Promise，不会重复扣次数 */
const cookJobs = new Map();

function cookStepsRequest(postId) {
  const id = Number(postId) || 0;
  if (!id) return Promise.reject(new Error('没有这条帖子'));
  if (cookJobs.has(id)) return cookJobs.get(id);
  const job = api('/api/ai/steps', { method: 'POST', body: { postId: id } });
  cookJobs.set(id, job);
  // 失败就清掉，允许用户点「再试一次」
  job.catch(() => { if (cookJobs.get(id) === job) cookJobs.delete(id); });
  return job;
}

/* 详情页读完帖子的 1 秒后，后台偷偷把步骤拆好：
   用户点「开始做」时（本机模型要十几秒）大概率已经拆完了。
   只在登录时预拆 —— 匿名有每日次数限制，别提前耗掉。 */
function prefetchCook(p) {
  if (!state.me || !p || p.status !== 'approved') return;
  if ((p.content || '').replace(/\s+/g, '').length < 20) return;
  if (cookJobs.has(p.id)) return;
  setTimeout(() => { cookStepsRequest(p.id).catch(() => {}); }, 1000);
}

async function openCook(postId) {
  const p = state.data.post && state.data.post.id === Number(postId) ? state.data.post : null;
  state.cook = {
    open: true, loading: true, err: '', postId: Number(postId) || 0,
    dish: (p && p.content ? String(p.content).split('\n')[0].slice(0, 24) : ''),
    provider: '', approx: false, steps: [], i: 0, done: false,
    timerEnd: 0, timerSec: 0, timerDone: false,
    askOpen: false, asking: false, draftQ: '', answer: '', answerProvider: '', askErr: ''
  };
  paintCook();
  setModalLock(true);
  cookWakeOn();

  try {
    const d = await cookStepsRequest(Number(postId) || 0);
    state.cook.steps = d.steps || [];
    state.cook.dish = d.dish || state.cook.dish;
    state.cook.provider = d.provider || '';
    state.cook.approx = !!d.approx;
    if (!state.cook.steps.length) state.cook.err = '这条帖子写得比较简略，拆不出步骤';
  } catch (e) {
    state.cook.err = e.message || '小饭这会儿不在，等会儿再试';
  }
  state.cook.loading = false;
  paintCook();
}

function closeCook() {
  if (!state.cook.open) return;
  stopCookTick();
  if (cookTapT) { clearTimeout(cookTapT); cookTapT = 0; }
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
  try { if (nativeApp()) nativeApp().stopSpeak(); } catch (e) { /* 忽略 */ }
  cookWakeOff();
  state.cook.open = false;
  state.cook.answer = '';
  state.cook.askOpen = false;
  paintCook();
  // 做饭模式关掉后，弹窗可能还开着，别把它的滚动锁一起解了
  setModalLock(!!state.modal);
}

/* Android 壳（APK）注入了 window.FQNative：WebView 里没有 speechSynthesis，
   Wake Lock 也不一定给，能借原生就借原生，纯浏览器照旧走 Web API。 */
function nativeApp() {
  return (window.FQNative && window.FQNative.platform) ? window.FQNative : null;
}

let cookWake = null;
async function cookWakeOn() {
  try {
    const app = nativeApp();
    if (app) { app.keepAwake(true); return; }
    if (!navigator.wakeLock || cookWake) return;
    cookWake = await navigator.wakeLock.request('screen');
    cookWake.addEventListener('release', () => { cookWake = null; });
  } catch (e) { cookWake = null; }
}
function cookWakeOff() {
  try { const app = nativeApp(); if (app) app.keepAwake(false); } catch (e) { /* 忽略 */ }
  try { if (cookWake) { cookWake.release(); cookWake = null; } } catch (e) { cookWake = null; }
}

function cookSpeak() {
  const s = cookStep();
  if (!s) return;
  try {
    const app = nativeApp();
    if (app) { app.speak(s.t + '。' + (s.d || '')); return; }
  } catch (e) { /* 落到下面的网页朗读 */ }
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    toast('这个浏览器不支持朗读', 'err');
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(s.t + '。' + (s.d || ''));
    u.lang = 'zh-CN';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch (e) { toast('朗读没启动起来', 'err'); }
}

function cookGo(i) {
  const c = state.cook;
  if (!c.steps.length) return;
  const n = Math.max(0, Math.min(c.steps.length - 1, i));
  c.i = n;
  c.answer = '';
  c.answerProvider = '';
  c.askErr = '';
  c.askOpen = false;
  c.draftQ = '';
  c.timerEnd = 0;
  c.timerSec = 0;
  c.timerDone = false;
  c.timerLeft = 0;
  c.timerPaused = false;
  if (cookTapT) { clearTimeout(cookTapT); cookTapT = 0; }
  stopCookTick();
  paintCook();
  const stage = document.querySelector('.cook-stage');
  if (stage) stage.scrollTop = 0;
}

function cookNext() {
  const c = state.cook;
  if (c.i >= c.steps.length - 1) { c.done = true; paintCook(); return; }
  cookGo(c.i + 1);
}

function cookStartTimer(sec) {
  if (!sec) return;
  cookAudioUnlock();          // 点按钮是用户手势，顺手把提示音解锁
  const c = state.cook;
  c.timerSec = sec;
  c.timerEnd = Date.now() + sec * 1000;
  c.timerLeft = 0;
  c.timerPaused = false;
  c.timerDone = false;
  paintCook();
  startCookTick();
}

/* 计时按钮：点一下暂停/继续，连点两下重置。
   单击必须等 260ms 才能确认不是双击 —— 这点延迟换来「不用长按、也不会误触」。 */
function cookTimerPause() {
  const c = state.cook;
  const left = Math.max(0, c.timerEnd - Date.now());
  stopCookTick();
  c.timerLeft = left;
  c.timerEnd = 0;
  c.timerPaused = left > 0;
  paintCook();
}

function cookTimerResume() {
  const c = state.cook;
  c.timerEnd = Date.now() + Math.max(1000, c.timerLeft);
  c.timerLeft = 0;
  c.timerPaused = false;
  c.timerDone = false;
  paintCook();
  startCookTick();
}

function cookTimerToggle(sec) {
  const c = state.cook;
  if (!sec) return;
  if (c.timerPaused) { cookTimerResume(); toast('接着计时', 'ok', 'clock'); return; }
  if (c.timerEnd) { cookTimerPause(); toast('已暂停，再点一下继续', 'ok', 'clock'); return; }
  // 没开始、或者已经响过了：都算开新一轮
  const again = c.timerDone;
  cookStartTimer(sec);
  toast(again ? '新的一轮' : '开始计时 ' + cookClock(sec), 'ok', 'clock');
}

function cookTimerReset() {
  const c = state.cook;
  stopCookTick();
  c.timerEnd = 0;
  c.timerLeft = 0;
  c.timerPaused = false;
  c.timerDone = false;
  paintCook();
  toast('计时已重置', 'ok', 'clock');
}

let cookTapT = 0;
function cookTimerTap(sec) {
  if (!sec) return;
  if (cookTapT) { clearTimeout(cookTapT); cookTapT = 0; cookTimerReset(); return; }
  cookTapT = setTimeout(() => { cookTapT = 0; cookTimerToggle(sec); }, 260);
}

async function cookAsk(question) {
  const c = state.cook;
  const q = String(question || '').trim() || (($('#ck-q') || {}).value || '').trim();
  if (q.length < 2) { toast('说说现在什么情况', 'err'); return; }
  const s = cookStep();
  c.askOpen = true;
  c.asking = true;
  c.draftQ = q;
  c.answer = '';
  c.askErr = '';
  paintCook();
  try {
    const d = await api('/api/ai/help', {
      method: 'POST',
      body: {
        postId: c.postId,
        stepNo: c.i + 1,
        step: s ? s.t : '',
        stepText: s ? s.d : '',
        question: q
      }
    });
    c.answer = d.answer || '';
    c.answerProvider = d.provider || '';
    c.draftQ = '';
    if (!c.answer) c.askErr = '小饭没接上话，再问一次试试';
  } catch (e) {
    c.askErr = e.message || '这会儿问不上，先按现在的火候来';
  }
  c.asking = false;
  paintCook();
}

/* -------- 私信 -------- */

// 会话列表里的每一行（一对一 + 群聊共用一套外壳）
function conversationsHtml() {
  const convs = state.data.conversations || [];
  if (!convs.length) {
    return '<div class="msg-empty">还没有聊天记录<br>去厨友的主页点「私信」开始聊天吧</div>';
  }
  const cur = threadRouteId();
  return convs.map((c) => {
    const isGroup = c.kind === 'group';
    const obj = isGroup ? c.group : c.peer;
    const routeId = isGroup ? ('g' + c.group.id) : String(c.peer.id);
    const on = cur && routeId === cur;
    const last = c.last;
    let preview = '';
    if (!last) {
      preview = isGroup ? '<em>群聊已创建</em>' : '<em>还没有聊过</em>';
    } else if (last.recalled) {
      preview = '<em>' + (last.mine ? '你' : (isGroup ? (last.sender || 'TA') : '对方')) + '撤回了一条消息</em>';
    } else {
      const who = last.mine ? '我：' : (isGroup && last.sender ? last.sender + '：' : '');
      preview = who + (last.shared ? '［转发］一条内容' : esc(last.content || ''));
    }
    return '<a class="msg-conv' + (on ? ' on' : '') + '" href="#/messages/' + routeId + '">' +
      (isGroup ? groupAvatarHtml(c.group, 48) : avatarHtml(c.peer, 48)) +
      '<div class="msg-conv-main">' +
        '<div class="msg-conv-top"><span class="nm">' + esc(obj.nickname || obj.name) + '</span>' +
          (isGroup ? '<span class="msg-conv-tag">' + icon('users') + c.group.memberCount + '</span>' : '') +
          (last ? '<span class="tm">' + timeAgo(last.createdAt) + '</span>' : '') + '</div>' +
        '<div class="msg-conv-sub">' +
          '<span class="last">' + preview + '</span>' +
          (c.unread ? '<span class="msg-unread">' + (c.unread > 99 ? '99+' : c.unread) + '</span>' : '') +
        '</div>' +
      '</div></a>';
  }).join('');
}

// 群头像：有图用图，没有就画一个「多人」圆片（用品牌色底 + users 图标）
function groupAvatarHtml(g, size) {
  if (g.avatar) {
    return '<span class="avatar" style="width:' + size + 'px;height:' + size + 'px">' +
      '<img src="' + esc(g.avatar) + '" alt="" loading="lazy"></span>';
  }
  return '<span class="avatar avatar-group" style="width:' + size + 'px;height:' + size +
    'px;font-size:' + Math.round(size * 0.46) + 'px">' + icon('users') + '</span>';
}

// 私信气泡里的帖子卡片（转发过来的内容）；原帖被删时优雅降级
function shareCardHtml(m) {
  const s = m.post;
  if (!s) return '<div class="msg-share msg-share-gone">' + icon('trash') + ' 这条内容已不存在</div>';
  const img = s.image ? '<img class="msg-share-img" src="' + esc(s.image) + '" loading="lazy" alt="">' : '';
  const text = s.excerpt || (s.image ? '［图片］' : '（无正文）');
  return '<a class="msg-share" href="#/post/' + s.id + '">' +
    '<div class="msg-share-top">' + icon('repost') + ' 转发的内容</div>' +
    '<div class="msg-share-mid">' + img +
      '<div class="msg-share-text">' + esc(text) + '</div></div>' +
    '<div class="msg-share-author">' + avatarHtml(s.author, 20) + '<span>' + esc(s.author.nickname) + '</span></div>' +
  '</a>';
}

// 消息里带的「引用」块（点它滚到原消息）
function quoteBlockHtml(m) {
  const q = m.quote;
  if (!q) return '';
  const gone = q.gone ? ' quote-gone' : '';
  const who = q.mine ? '你' : (q.nickname || '');
  const text = q.content || '';
  return '<span class="quote' + gone + '" data-action="msg-quote-jump" data-id="' + q.id + '">' +
      '<b>' + esc(who ? who + '：' : '') + '</b>' + esc(text.slice(0, 70)) + '</span>';
}

// 撤回占位
function recalledHtml(m, t) {
  const who = m.mine ? '你' : (t && t.kind === 'group' ? ((m.from && m.from.nickname) || '群友') : (t && t.peer ? t.peer.nickname : 'TA'));
  return '<span class="msg-recalled">' + esc(who) + '撤回了一条消息</span>';
}

// 聊天窗口里的消息气泡（带日期分隔 / 引用 / 撤回 / 群成员头像与昵称）
function threadBodyHtml() {
  const t = state.data.thread;
  if (!t || (!t.peer && !t.group)) return '';
  const msgs = t.messages || [];
  if (!msgs.length) {
    const who = t.kind === 'group' ? t.group.name : t.peer.nickname;
    return '<div class="msg-thread-empty">' + (t.kind === 'group' ? '群聊已建好' : '和 ' + esc(who) + ' 还没有聊过') +
      '<br>' + icon('wave') + ' 打个招呼吧</div>';
  }
  let out = '';
  let lastDay = '';
  for (const m of msgs) {
    const day = dayLabel(m.createdAt);
    if (day !== lastDay) { out += '<div class="msg-day">' + day + '</div>'; lastDay = day; }
    const card = (!m.recalled && m.postId) ? shareCardHtml(m) : '';
    const showMenu = state.msgMenu === m.id;
    const menu = showMenu ? msgMenuHtml(m) : '';
    // 撤回的：居中灰条占位，不画气泡
    if (m.recalled) {
      out += '<div class="msg-row recalled-row">' + recalledHtml(m, t) + '</div>';
      continue;
    }
    const quote = m.quote ? quoteBlockHtml(m) : '';
    out += '<div class="msg-row ' + (m.mine ? 'mine' : 'their') + '" data-mid="' + m.id + '">' +
      avatarHtml(m.mine ? state.me : (t.kind === 'group' ? (m.from || { id: 0, nickname: '群友' }) : t.peer), 34) +
      '<div class="bubble-wrap">' +
        (t.kind === 'group' && !m.mine && m.from ? '<div class="bubble-name">' + esc(m.from.nickname) + '</div>' : '') +
        '<div class="bubble' + (card ? ' bubble-share' : '') + (quote ? ' has-quote' : '') + '" data-action="msg-menu" data-id="' + m.id + '">' +
          quote +
          (m.content ? richText(m.content) : '') +
          card +
          '<span class="msg-t">' + hhmm(m.createdAt) + '</span>' +
        '</div>' +
        menu +
      '</div>' +
    '</div>';
  }
  return out;
}

// 点气泡弹出的操作菜单（撤回 / 引用 / 删除）
function msgMenuHtml(m) {
  const msgs = (state.data.thread && state.data.thread.messages) || [];
  const mine = msgs.find((x) => x.id === m.id && x.mine);
  const canRecall = m.mine && (Date.now() - m.createdAt < 2 * 60 * 1000);
  return '<div class="msg-menu">' +
      (canRecall ? '<button data-action="msg-recall" data-id="' + m.id + '">' + icon('repost') + '撤回</button>' : '') +
      '<button data-action="msg-quote" data-id="' + m.id + '">' + icon('comment') + '引用</button>' +
      '<button class="danger" data-action="msg-delete" data-id="' + m.id + '">' + icon('trash') + '删除</button>' +
    '</div>';
}

// 正在引用某条消息时，输入框上方的小条
function quoteBarHtml() {
  const q = state.msgQuote;
  if (!q) return '';
  return '<div class="quote-bar">' + icon('comment') +
      '<span class="qb-text"><b>' + esc(q.mine ? '引用自己' : (q.nickname || 'TA')) + '：</b>' +
        esc((q.content || '').slice(0, 60)) + '</span>' +
      '<button class="qb-x" data-action="msg-quote-cancel" title="取消引用">' + icon('cross') + '</button>' +
    '</div>';
}

function threadHtml() {
  const tid = threadRouteId();
  if (!tid) {
    return '<div class="msg-blank"><div class="msg-blank-ico">' + icon('chat') + '</div>' +
      '<p>选一个聊天，或者去厨友主页点「私信」开始</p></div>';
  }
  const t = state.data.thread;
  if (!t || (!t.peer && !t.group)) return '<div class="msg-blank"><p>加载中…</p></div>';

  let head;
  if (t.kind === 'group') {
    head = '<div class="msg-head">' +
        '<a class="msg-back" href="#/messages" title="返回">' + icon('back') + '</a>' +
        groupAvatarHtml(t.group, 38) +
        '<span class="msg-head-name">' + esc(t.group.name) +
          '<span class="msg-gcount">' + icon('users') + t.group.memberCount + ' 人</span></span>' +
        '<button class="msg-head-user" data-action="group-info">成员 ›</button>' +
      '</div>';
  } else {
    head = '<div class="msg-head">' +
        '<a class="msg-back" href="#/messages" title="返回">' + icon('back') + '</a>' +
        avatarHtml(t.peer, 38) +
        '<a class="msg-head-name" href="#/user/' + t.peer.id + '">' + esc(t.peer.nickname) + roleBadge(t.peer) + '</a>' +
        (t.relation ? '<span class="msg-rel">' + esc(t.relation) + '</span>' : '') +
        '<a class="msg-head-user" href="#/user/' + t.peer.id + '">主页 ›</a>' +
      '</div>';
  }
  const form = '<div class="msg-form">' + quoteBarHtml() +
      '<div class="msg-form-row">' +
        '<textarea id="msg-input" rows="1" maxlength="1000" placeholder="发条消息…" title="Enter 发送，Shift+Enter 换行">' + esc(state.msgDraft) + '</textarea>' +
        '<button class="btn-primary msg-send" data-action="msg-send" data-id="' + tid + '">发送</button>' +
      '</div>' +
    '</div>';
  return head + '<div class="msg-body" id="msg-body">' + threadBodyHtml() + '</div>' + form;
}

function viewMessages() {
  if (!state.me) return '';
  const tid = threadRouteId();
  const unread = state.data.unreadMsgs || 0;
  return '<div class="msg-page">' +
      '<div class="msg-side' + (tid ? ' hide-sm' : '') + '">' +
        '<div class="msg-side-head"><b>' + icon('chat') + ' 私信</b>' +
          '<button class="msg-newgroup" data-action="group-new" title="发起群聊">' + icon('users') + '发起群聊</button></div>' +
        '<div class="msg-convs">' + conversationsHtml() + '</div>' +
      '</div>' +
      '<div class="msg-main' + (tid ? '' : ' hide-sm') + '">' + threadHtml() + '</div>' +
    '</div>';
}

// 只重绘消息区并滚到底部（发送 / 收到新消息时用，避免整页重渲染打断输入）
function paintThread() {
  const body = $('#msg-body');
  if (body) { body.innerHTML = threadBodyHtml(); body.scrollTop = body.scrollHeight; }
}
function paintConversations() {
  const box = $('.msg-convs');
  if (box) box.innerHTML = conversationsHtml();
}
function scrollThread() {
  const body = $('#msg-body');
  if (body) body.scrollTop = body.scrollHeight;
}

let msgTimer = null;
function stopMsgPoll() { if (msgTimer) { clearInterval(msgTimer); msgTimer = null; } }
function msgApiBase(tid) {
  return isGroupId(tid) ? ('/api/groups/' + String(tid).slice(1) + '/messages') : ('/api/messages/' + tid);
}
function startMsgPoll() {
  stopMsgPoll();
  msgTimer = setInterval(async () => {
    if (document.hidden) return;
    if (state.route.name !== 'messages') { stopMsgPoll(); return; }
    const tid = threadRouteId();
    if (!tid || !state.data.thread) return;
    try {
      const msgs = state.data.thread.messages || [];
      const after = msgs.length ? msgs[msgs.length - 1].id : 0;
      const d = await api(msgApiBase(tid) + '?after=' + after);
      if (d.messages && d.messages.length) {
        state.data.thread.messages = msgs.concat(d.messages);
        paintThread();
      }
      loadConversations().then(paintConversations).catch(() => {});
    } catch (e) { /* ignore */ }
  }, 4000);
}

async function sendMessage(tid) {
  const el = $('#msg-input');
  const content = (el ? el.value : state.msgDraft || '').trim();
  if (!content) return;
  const quoteId = state.msgQuote ? state.msgQuote.id : 0;
  state.msgDraft = '';
  if (el) el.value = '';
  try {
    const body = { content };
    if (quoteId) body.quoteId = quoteId;
    const d = await api(msgApiBase(tid), { method: 'POST', body });
    if (state.data.thread && threadRouteId() === String(tid)) {
      state.data.thread.messages = (state.data.thread.messages || []).concat([d.message]);
      state.msgQuote = null;
      render();  // 清掉引用条 + 重绘消息区
      scrollThread();
    }
    await loadConversations();
    paintConversations();
  } catch (e) {
    toast(e.message, 'err');
    state.msgDraft = content;
    if (el) el.value = content;
  }
}

/* 长按 / 点气泡弹出的操作：撤回、删除、引用 */
async function recallMessage(id) {
  try {
    await api('/api/messages/' + id + '/recall', { method: 'POST' });
    state.msgMenu = 0;
    const msgs = (state.data.thread && state.data.thread.messages) || [];
    const m = msgs.find((x) => x.id === id);
    if (m) { m.recalled = true; m.content = ''; m.postId = 0; }
    paintThread();
    toast('已撤回', 'ok', 'check');
    loadConversations().then(paintConversations).catch(() => {});
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteMessage(id) {
  try {
    await api('/api/messages/' + id + '/delete', { method: 'POST' });
    state.msgMenu = 0;
    const t = state.data.thread;
    if (t) t.messages = (t.messages || []).filter((x) => x.id !== id);
    paintThread();
    toast('已删除', 'ok', 'trash');
    loadConversations().then(paintConversations).catch(() => {});
  } catch (e) { toast(e.message, 'err'); }
}
function startQuote(id) {
  const msgs = (state.data.thread && state.data.thread.messages) || [];
  const m = msgs.find((x) => x.id === id);
  if (!m) return;
  state.msgQuote = {
    id: m.id,
    content: m.postId ? '［转发］一条内容' : (m.content || ''),
    nickname: m.mine ? '' : ((m.from && m.from.nickname) || (state.data.thread.peer && state.data.thread.peer.nickname) || ''),
    mine: !!m.mine
  };
  state.msgMenu = 0;
  render();
  const el = $('#msg-input'); if (el) el.focus();
}
function quoteJump(id) {
  const row = document.querySelector('.msg-row[data-mid="' + id + '"]');
  if (!row) { toast('原消息不在这段记录里', 'err'); return; }
  row.classList.add('flash');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => row.classList.remove('flash'), 1200);
}

/* -------- 建群 -------- */
function openGroupModal() {
  state.modal = { type: 'group' };
  state.groupPick = [];
  state.groupName = '';
  state.data.groupCands = null;
  render();
  const el = $('#group-name'); if (el) el.focus();
  // 候选名单异步补上（拉完只重绘弹窗里的列表，避免打断输入）
  loadGroupCandidates().then((list) => {
    state.data.groupCands = list;
    if (state.modal && state.modal.type === 'group') {
      const nm = $('#group-name'); if (nm) state.groupName = nm.value;
      render();
      const back = $('#group-name'); if (back) { back.focus(); back.setSelectionRange(back.value.length, back.value.length); }
    }
  }).catch(() => { state.data.groupCands = []; if (state.modal && state.modal.type === 'group') render(); });
}
async function leaveGroup(id) {
  const gid = String(id).replace(/^g/, '');
  const g = (state.data.thread && state.data.thread.group) || state.modal.group || {};
  const isOwner = state.me && g.ownerId === state.me.id;
  if (!confirm(isOwner ? '解散这个群？群聊记录会一起清掉。' : '退出这个群？')) return;
  try {
    await api('/api/groups/' + gid, { method: 'DELETE' });
    state.modal = null;
    toast(isOwner ? '群已解散' : '已退出群聊', 'ok', 'check');
    await loadConversations();
    go('#/messages');
  } catch (e) { toast(e.message, 'err'); }
}
async function loadGroupCandidates() {
  // 拉「最近聊过的人 + 我关注的人」当候选，去重
  const out = [];
  const seen = new Set();
  const push = (u) => { if (u && u.id && !seen.has(u.id) && (!state.me || u.id !== state.me.id)) { seen.add(u.id); out.push(u); } };
  try {
    const d = await api('/api/conversations');
    (d.conversations || []).forEach((c) => { if (c.kind === 'dm') push(c.peer); });
  } catch (e) { /* ignore */ }
  try {
    const me = state.me;
    const ids = (me && me.following) || [];
    for (const id of ids.slice(0, 30)) {
      try { const u = await api('/api/users/' + id); push(u.user || u); } catch (e) { }
    }
  } catch (e) { /* ignore */ }
  return out;
}
async function createGroup() {
  const name = (($('#group-name') || {}).value || state.groupName || '').trim();
  if (!name) { toast('给群起个名字吧', 'err'); return; }
  if (!state.groupPick.length) { toast('至少拉一位厨友进群', 'err'); return; }
  try {
    const d = await api('/api/groups', { method: 'POST', body: { name, memberIds: state.groupPick } });
    state.modal = null;
    await loadConversations();
    toast('群聊已创建', 'ok', 'users');
    go('#/messages/g' + d.group.id);
  } catch (e) { toast(e.message, 'err'); }
}

/* -------- 审核中心 -------- */

function viewReview() {
  const mode = state.reviewMode;
  const stats = state.data.stats || {};

  const modes = [['posts', '内容审核'], ['reports', '举报处理']];
  if (isAdmin()) { modes.push(['apps', '审核员申请'], ['users', '用户管理']); }
  const modeTabs = '<div class="review-modes">' + modes.map(([k, l]) =>
    '<button class="rm-tab' + (mode === k ? ' on' : '') + '" data-action="review-mode" data-tab="' + k + '">' + l +
    (k === 'reports' && stats.openReports ? '<span class="rm-badge">' + stats.openReports + '</span>' : '') +
    '</button>').join('') + '</div>';

  const head = '<div class="card" style="overflow:hidden">' +
      '<div class="page-head" style="padding:16px 20px 12px">' +
        '<div><h2>' + icon('shield') + '审核中心</h2>' +
        '<div class="sub">待处理 ' + (stats.pending || 0) + ' 条 · 已通过 ' + (stats.approved || 0) +
        ' 条 · 已驳回 ' + (stats.rejected || 0) + ' 条</div></div>' +
      '</div>' + modeTabs +
    '</div>';

  if (mode === 'posts') return head + reviewPosts();
  if (mode === 'reports') return head + reviewReports();
  if (mode === 'apps') return head + reviewApps();
  return head + reviewUsers();
}

function reviewPosts() {
  const tab = state.reviewTab;
  const list = state.data.reviewPosts || [];
  const tabBtn = (key, label) =>
    '<button class="' + (tab === key ? 'on' : '') + '" data-action="review-tab" data-tab="' + key + '">' + label + '</button>';

  const items = list.length
    ? list.map((p) => {
        const showActions = p.status === 'pending' || p.status === 'approved';
        return '<div class="rv-box">' +
          '<div class="post-head">' + avatarHtml(p.author, 34) +
            '<a class="post-name" href="#/user/' + p.author.id + '">' + esc(p.author.nickname) + '</a>' +
            '<span class="post-meta">' + timeAgo(p.createdAt) + '</span>' +
            statusBadge(p.status) +
          '</div>' +
          (p.content ? '<div class="post-text">' + richText(p.content) + '</div>' : '') +
          (p.images && p.images.length ? imgsHtml(p.images) : '') +
          (p.status === 'rejected' && p.rejectReason
            ? '<div class="reject-note">驳回理由：' + esc(p.rejectReason) + '</div>' : '') +
          (showActions
            ? '<div class="rv-actions">' +
                '<input class="rv-reason" data-reason-for="' + p.id + '" placeholder="驳回理由（可选）" maxlength="60">' +
                '<span class="spacer"></span>' +
                (p.status === 'pending'
                  ? '<button class="btn-sm btn-approve" data-action="approve" data-id="' + p.id + '">' + icon('check') + '通过</button>'
                  : '') +
                '<button class="btn-sm btn-reject" data-action="reject" data-id="' + p.id + '">' + icon('cross') + ' ' +
                  (p.status === 'pending' ? '驳回' : '下架') + '</button>' +
              '</div>'
            : '') +
        '</div>';
      }).join('')
    : '<div class="card empty"><img src="/assets/empty.webp" alt=""><div>' +
      (tab === 'pending' ? '审核队列是空的，辛苦了！' : '这里还没有内容') + '</div></div>';

  return '<div class="card" style="overflow:hidden">' +
      '<div class="review-tabs">' +
        tabBtn('pending', '待审核') + tabBtn('approved', '已通过') + tabBtn('rejected', '已驳回') +
      '</div>' +
    '</div>' + items;
}

function reviewReports() {
  const list = state.data.reports || [];
  if (!list.length) {
    return '<div class="card empty"><img src="/assets/empty.webp" alt=""><div>没有待处理的举报，辛苦了！</div></div>';
  }
  return list.map((r) => '<div class="rv-box">' +
    '<div class="rv-rep-head">' + icon('flag') + '<b>' + esc(r.reason) + '</b>' +
      (r.detail ? '<span class="rep-detail">' + esc(r.detail) + '</span>' : '') +
      '<span class="post-meta">由 ' + esc(r.reporter.nickname) + ' 举报 · ' + timeAgo(r.createdAt) + '</span></div>' +
    (r.post
      ? '<div class="rep-post">' + avatarHtml(r.post.author, 30) +
          '<div><b>' + esc(r.post.author.nickname) + '</b>' +
          (r.post.content ? '<div class="post-text" style="margin-top:4px">' + richText(r.post.content) + '</div>' : '') +
          (r.post.images && r.post.images.length ? imgsHtml(r.post.images) : '') + '</div></div>'
      : '<div class="reject-note">原内容已被删除</div>') +
    '<div class="rv-actions"><span class="spacer"></span>' +
      '<button class="btn-sm btn-ghost2" data-action="rep-dismiss" data-id="' + r.id + '">忽略举报</button>' +
      '<button class="btn-sm btn-reject" data-action="rep-remove" data-id="' + r.id + '">仅下架内容</button>' +
      '<button class="btn-sm btn-reject" data-action="rep-ban" data-id="' + r.id + '">下架并封禁作者</button>' +
    '</div></div>').join('');
}

function reviewApps() {
  const list = state.data.apps || [];
  if (!list.length) {
    return '<div class="card empty"><img src="/assets/empty.webp" alt=""><div>还没有审核员申请</div></div>';
  }
  return list.map((a) => '<div class="rv-box">' +
    '<div class="post-head">' + avatarHtml(a.user, 34) +
      '<a class="post-name" href="#/user/' + a.user.id + '">' + esc(a.user.nickname) + '</a>' +
      '<span class="post-meta">@' + esc(a.user.username) + ' · ' + timeAgo(a.createdAt) + '</span>' +
      (a.status === 'pending' ? '<span class="badge badge-pending">待审批</span>'
        : a.status === 'approved' ? '<span class="badge badge-approved">已通过</span>'
        : '<span class="badge badge-rejected">已拒绝</span>') +
    '</div>' +
    (a.reason ? '<div class="post-text">申请理由：' + richText(a.reason) + '</div>' : '') +
    (a.status === 'pending'
      ? '<div class="rv-actions"><span class="spacer"></span>' +
          '<button class="btn-sm btn-approve" data-action="app-approve" data-id="' + a.id + '">' + icon('check') + '通过</button>' +
          '<button class="btn-sm btn-reject" data-action="app-reject" data-id="' + a.id + '">' + icon('cross') + '拒绝</button>' +
        '</div>' : '') +
  '</div>').join('');
}

function reviewUsers() {
  const list = state.data.users || [];
  const rows = list.map((u) => '<div class="u-row">' +
    avatarHtml(u, 38) +
    '<div class="u-info"><div class="u-name">' + esc(u.nickname) + roleBadge(u) +
      (u.banned ? '<span class="badge badge-rejected">已封禁</span>' : '') + '</div>' +
      '<div class="u-sub">@' + esc(u.username) + ' · ' + (u.postCount || 0) + ' 篇 · 加入于 ' + timeAgo(u.createdAt) + '</div></div>' +
    '<div class="u-act">' +
      (u.id === state.me.id ? '<span class="u-self">你自己</span>' :
        (u.banned
          ? '<button class="btn-sm btn-ghost2" data-action="user-unban" data-id="' + u.id + '">解封</button>'
          : '<button class="btn-sm btn-reject" data-action="user-ban" data-id="' + u.id + '">封禁</button>') +
        // 角色按钮：只有管理员能改角色。普通人→「设为管理员」，审核员→「设为管理员」，
        // 管理员→「取消管理员」。比上一级低的人不显示降级，避免误操作。
        (isAdmin() && u.id !== state.me.id
          ? (u.role === 'admin'
            ? '<button class="btn-sm btn-ghost2" data-action="user-unadmin" data-id="' + u.id + '">取消管理员</button>'
            : '<button class="btn-sm btn-admin-role" data-action="user-admin" data-id="' + u.id + '">设为管理员</button>')
          : '') +
        (u.role === 'admin' ? '' :
          u.role === 'reviewer'
            ? '<button class="btn-sm btn-ghost2" data-action="user-demote" data-id="' + u.id + '">取消审核员</button>'
            : '<button class="btn-sm btn-approve" data-action="user-promote" data-id="' + u.id + '">设为审核员</button>') +
        (u.role === 'admin' ? '' :
          '<button class="btn-sm btn-ghost2 u-del" data-action="user-delete" data-id="' + u.id + '">删除</button>')) +
    '</div></div>').join('');
  return '<div class="card" style="overflow:hidden">' +
      '<div class="u-search"><input id="user-search" placeholder="搜索用户名 / 昵称" value="' + esc(state.keyword) + '"></div>' +
    '</div>' +
    (rows || '<div class="card empty"><img src="/assets/empty.webp" alt=""><div>没有找到用户</div></div>');
}

/* -------- 资料编辑 -------- */

function viewEdit() {
  const me = state.me;
  if (!me) return '';
  const app = state.data.myApp;
  let appBlock = '';
  if (me.role === 'user') {
    if (!app) {
      appBlock = '<div class="card edit-card"><h3>' + icon('medal') + '成为审核员</h3>' +
        '<p class="edit-hint">审核员负责把关社区内容。提交后由管理员审批，审批结果会通过消息通知你。</p>' +
        '<textarea id="apply-reason" placeholder="简单说说你为什么想当审核员（可选）" maxlength="200"></textarea>' +
        '<button class="btn-primary" data-action="apply-reviewer" style="height:38px;margin-top:12px">提交申请</button></div>';
    } else if (app.status === 'pending') {
      appBlock = '<div class="card edit-card"><h3>' + icon('medal') + '成为审核员</h3>' +
        '<p class="edit-hint">你的申请正在等待管理员审批。</p>' +
        (app.reason ? '<div class="app-reason">申请理由：' + esc(app.reason) + '</div>' : '') +
        '<div style="margin-top:10px">' + statusBadge('pending') + '</div></div>';
    } else {
      appBlock = '<div class="card edit-card"><h3>' + icon('medal') + '成为审核员</h3>' +
        '<p class="edit-hint">上次申请未通过，可以再次提交。</p>' +
        '<textarea id="apply-reason" placeholder="简单说说你为什么想当审核员（可选）" maxlength="200"></textarea>' +
        '<button class="btn-primary" data-action="apply-reviewer" style="height:38px;margin-top:12px">重新提交申请</button></div>';
    }
  }

  const avChoices = ['/assets/av-onigiri.webp', '/assets/av-tomato.webp', '/assets/av-egg.webp', '/assets/av-ramen.webp'];
  const avRow = avChoices.map((a) =>
    '<button class="av-opt' + (state.editAvatar === a ? ' on' : '') + '" data-action="pick-avatar" data-av="' + a + '">' +
    '<img src="' + a + '" alt=""></button>').join('');

  return '<div class="card page-head" style="padding:14px 20px">' +
      '<a class="btn-ghost" href="#/mine">' + icon('back') + '返回</a><div class="sub">编辑资料</div></div>' +
    (state.mustChangePw
      ? '<div class="card sec-warn"><b>' + icon('lock') + ' 先把密码换掉</b>' +
        '<p>这个账号还在用系统给的初始口令，别人也可能知道。改完密码之前，发帖、私信、审核都会先被拦下。</p></div>'
      : '') +
    '<div class="card edit-card">' +
      '<h3>' + icon('user') + '基本信息</h3>' +
      '<div class="edit-avatar-row">' +
        '<div class="edit-avatar">' + avatarHtml({ id: me.id, nickname: me.nickname, avatar: state.editAvatar }, 72) + '</div>' +
        '<div class="av-picks">' + avRow +
          '<label class="av-opt upload"><input type="file" id="avatar-input" accept="image/*" hidden>＋<span>上传</span></label>' +
        '</div>' +
      '</div>' +
      '<div class="field"><label>昵称</label><input id="edit-nickname" value="' + esc(me.nickname) + '" maxlength="24"></div>' +
      '<div class="field"><label>简介</label><textarea id="edit-bio" maxlength="160" placeholder="介绍一下你的拿手菜…">' + esc(me.bio || '') + '</textarea></div>' +
      '<button class="btn-primary" data-action="save-profile" style="height:40px;margin-top:6px">保存资料</button>' +
    '</div>' +
    '<div class="card edit-card">' +
      '<h3>' + icon('lock') + '修改密码</h3>' +
      '<div class="field"><label>原密码</label><input id="pw-old" type="password" autocomplete="current-password" placeholder="当前密码"></div>' +
      '<div class="field"><label>新密码</label><input id="pw-new" type="password" autocomplete="new-password" placeholder="至少 8 位，字母 + 数字"></div>' +
      '<button class="btn-primary" data-action="change-password" style="height:40px;margin-top:6px">更新密码</button>' +
    '</div>' +
    appBlock;
}

/* -------- 登录注册 -------- */

function viewLogin() {
  const isLogin = state.authTab === 'login';
  return '<div class="auth-page"><div class="auth-box">' +
      '<div class="brand"><div class="logo-mark"><img src="/assets/mascot.webp" alt="饭圈"></div><h1>饭圈</h1><p>好好做饭的人都在这里</p></div>' +
      '<div class="tabs">' +
        '<button class="' + (isLogin ? 'on' : '') + '" data-action="auth-tab" data-tab="login">登录</button>' +
        '<button class="' + (!isLogin ? 'on' : '') + '" data-action="auth-tab" data-tab="register">注册</button>' +
      '</div>' +
      '<div id="auth-err"></div>' +
      '<form id="auth-form" autocomplete="on">' +
        '<div class="field"><label>用户ID</label>' +
          '<input name="username" placeholder="字母 / 数字 / 下划线，3-20 位" autocomplete="username"></div>' +
        (!isLogin
          ? '<div class="field"><label>昵称</label><input name="nickname" placeholder="大家怎么称呼你"></div>' : '') +
        '<div class="field"><label>密码</label>' +
          '<input name="password" type="password" placeholder="至少 8 位，字母 + 数字" autocomplete="' + (isLogin ? 'current-password' : 'new-password') + '"></div>' +
        (!isLogin
          ? '<div class="field"><label>确认密码</label>' +
            '<input name="confirm" type="password" placeholder="再输入一次密码" autocomplete="new-password">' +
            '<div class="field-hint" id="pw-match" aria-live="polite"></div></div>'
          : '') +
        '<button class="btn-primary btn-block" type="submit" style="margin-top:18px;height:44px">' +
          (isLogin ? '登录' : '注册并进入饭圈') + '</button>' +
      '</form>' +
      (isLogin
        ? '<div class="auth-tip">登录后即可发帖、点赞、关注厨友。</div>'
        : '<div class="auth-tip">注册后为普通厨友，可发帖、点赞、关注。<br>想当审核员？在「我的资料」里提交申请，由管理员审批。</div>') +
      '<div style="text-align:center;margin-top:18px">' +
        '<a href="#/" style="font-size:13px;color:var(--ink-3);font-weight:700">' + icon('back') + ' 先随便看看</a></div>' +
    '</div>' +
    '<img class="auth-deco" src="/assets/cooking.webp" alt="">' +
  '</div>';
}

function viewMain() {
  if (state.loading && state.route.name !== 'login') {
    return '<div class="card"><div class="skeleton">' +
      '<div class="sk-avatar"></div>' +
      '<div style="flex:1"><div class="sk-line" style="width:26%"></div>' +
      '<div class="sk-line" style="width:88%;margin-top:12px"></div>' +
      '<div class="sk-line" style="width:64%;margin-top:8px"></div></div></div>' +
      '<div class="skeleton">' +
      '<div class="sk-avatar"></div>' +
      '<div style="flex:1"><div class="sk-line" style="width:32%"></div>' +
      '<div class="sk-line" style="width:76%;margin-top:12px"></div></div></div></div>';
  }
  switch (state.route.name) {
    case 'hot': return viewHot();
    case 'mine': return viewMine();
    case 'user': return viewUser();
    case 'review': return viewReview();
    case 'post': return viewPost();
    case 'messages': return viewMessages();
    case 'edit': return viewEdit();
    case 'search': return viewSearch();
    default: return viewFeed();
  }
}

/* -------- 弹窗 -------- */

function modalHtml() {
  const m = state.modal;
  if (!m) return '';
  if (m.type === 'compose') {
    const thumbs = state.draftImages.map((u, i) =>
      '<div class="thumb"><img src="' + esc(u) + '" data-zoom="' + esc(u) + '">' +
      '<button data-action="rm-image" data-idx="' + i + '">×</button></div>').join('');
    return '<div class="modal-mask">' +
      '<div class="modal modal-compose">' +
        '<h3>' + icon('pen') + '发布新菜</h3>' +
        '<p class="modal-sub">' + (isMod()
          ? '你是审核员，发布后立即公开。'
          : '发布后会进入审核队列，通过后所有人可见。<b>你自己现在就能在首页看到它</b>（带「待审核」标记）。') + '</p>' +
        '<textarea id="compose-text" maxlength="2000" placeholder="今天做了什么好吃的？说说食材和做法吧… 用 @ 可以提到厨友">' + esc(state.draft) + '</textarea>' +
        (thumbs ? '<div class="composer-images">' + thumbs + '</div>' : '') +
        '<div class="modal-act compose-act">' +
          '<label class="file-label">' + icon('image') + '图片<input type="file" id="file-input" accept="image/*" multiple hidden></label>' +
          imgChipHtml() +
          aiBarBtn() +
          '<span class="hint count" id="composer-count">' + (state.draft ? state.draft.length : 0) + '/2000</span>' +
          '<span class="grow"></span>' +
          '<button class="btn-ghost" data-action="modal-close">取消</button>' +
          '<button class="btn-primary" data-action="publish">发布</button>' +
        '</div>' +
        '<div id="ai-panel">' + aiPanelHtml() + '</div>' +
      '</div></div>';
  }
  if (m.type === 'share') {
    return '<div class="modal-mask">' +
      '<div class="modal modal-share">' +
        '<h3>' + icon('repost') + '转发给谁</h3>' +
        '<p class="modal-sub">选一位厨友，这条内容会以卡片形式发到你们的私信里。</p>' +
        '<div class="share-search">' +
          '<span class="share-search-ico">' + icon('search') + '</span>' +
          '<input id="share-search" placeholder="搜索昵称 / @用户名" autocomplete="off">' +
        '</div>' +
        '<div class="share-body" id="share-body">' + sharePanelBodyHtml() + '</div>' +
        '<div class="modal-act"><button class="btn-ghost" data-action="modal-close">取消</button></div>' +
      '</div></div>';
  }
  if (m.type === 'group') {
    const cands = state.data.groupCands;
    let body;
    if (cands === undefined || cands === null) {
      body = '<div class="rel-empty">加载候选厨友…</div>';
    } else if (!cands.length) {
      body = '<div class="rel-empty">' + icon('users') + ' 还没有可拉的人。<br>先去和厨友聊几句，或关注几个人吧</div>';
    } else {
      body = cands.map((u) => {
        const on = state.groupPick.includes(u.id);
        return '<button class="gp-row' + (on ? ' on' : '') + '" data-action="group-toggle" data-id="' + u.id + '">' +
            avatarHtml(u, 38) +
            '<span class="gp-name">' + esc(u.nickname) + '</span>' +
            '<span class="gp-check">' + (on ? icon('check') : '') + '</span>' +
          '</button>';
      }).join('');
    }
    return '<div class="modal-mask">' +
      '<div class="modal modal-group">' +
        '<h3>' + icon('users') + '发起群聊</h3>' +
        '<p class="modal-sub">起个群名，勾选要拉进来的厨友（至少一位）。</p>' +
        '<input class="group-name-input" id="group-name" maxlength="24" placeholder="给群起个名字，比如「深夜食堂」" value="' + esc(state.groupName) + '">' +
        '<div class="gp-head">选择成员' + (state.groupPick.length ? ' · 已选 ' + state.groupPick.length : '') + '</div>' +
        '<div class="gp-list">' + body + '</div>' +
        '<div class="modal-act">' +
          '<button class="btn-ghost" data-action="modal-close">取消</button>' +
          '<button class="btn-primary" data-action="group-create">创建群聊</button>' +
        '</div>' +
      '</div></div>';
  }
  if (m.type === 'group-info') {
    const g = m.group || (state.data.thread && state.data.thread.group) || {};
    const members = g.members || [];
    const isOwner = state.me && g.ownerId === state.me.id;
    return '<div class="modal-mask">' +
      '<div class="modal modal-group">' +
        '<h3>' + icon('users') + esc(g.name || '群聊') +
          '<span class="rel-count">' + (g.memberCount || members.length) + ' 人</span></h3>' +
        '<p class="modal-sub">' + (isOwner ? '你是群主。' : '群聊成员如下。') + '</p>' +
        '<div class="gp-list">' + members.map((u) =>
          '<div class="gp-row static">' + avatarHtml(u, 38) +
            '<span class="gp-name">' + esc(u.nickname) +
              (state.me && u.id === state.me.id ? '<span class="gp-me">我</span>' : '') +
              (g.ownerId === u.id ? '<span class="gp-owner">群主</span>' : '') + '</span>' +
          '</div>').join('') + '</div>' +
        '<div class="modal-act">' +
          '<button class="btn-ghost" data-action="modal-close">关闭</button>' +
          (isInGroup(g) ?
            '<button class="btn-ghost2" data-action="group-leave" data-id="' + g.id + '">' +
              (isOwner ? '解散群聊' : '退出群聊') + '</button>' : '') +
        '</div>' +
      '</div></div>';
  }
  if (m.type === 'report') {
    const opts = REPORT_REASONS.map((r, i) =>
      '<label class="rep-opt"><input type="radio" name="rep-reason" value="' + esc(r) + '"' + (i === 0 ? ' checked' : '') + '><span>' + esc(r) + '</span></label>').join('');
    return '<div class="modal-mask">' +
      '<div class="modal">' +
        '<h3>' + icon('flag') + '举报这条内容</h3>' +
        '<p class="modal-sub">请选择举报原因，我们会尽快处理。</p>' +
        '<div class="rep-opts">' + opts + '</div>' +
        '<textarea id="rep-detail" placeholder="补充说明（可选）" maxlength="200"></textarea>' +
        '<div class="modal-act">' +
          '<button class="btn-ghost" data-action="modal-close">取消</button>' +
          '<button class="btn-primary" data-action="report-submit" data-id="' + m.postId + '">提交举报</button>' +
        '</div>' +
      '</div></div>';
  }
  if (m.type === 'relations') {
    const rel = state.data.relations || {};
    const list = m.tab === 'followers' ? (rel.followers || []) : (rel.following || []);
    let body;
    if (m.loading) {
      body = '<div class="rel-empty">加载中…</div>';
    } else if (!list.length) {
      body = '<div class="rel-empty">' + (m.tab === 'followers'
        ? icon('pan') + ' 还没有粉丝。多发几道好菜，自然会有人关注你'
        : icon('search') + ' 还没有关注任何人。去「热门」逛逛，找到合胃口的厨友') + '</div>';
    } else {
      body = list.map(relRowHtml).join('');
    }
    // 名单对非本人是不可见的：那一格渲染成一句说明文字，而不是点不动的按钮
    const tabBtn = (key, label, n) => rel.isSelf
      ? '<button class="feed-tab' + (m.tab === key ? ' on' : '') + '" data-action="rel-tab" data-tab="' + key + '">' + label + ' ' + n + '</button>'
      : '<span class="rel-locked" title="' + label + '名单只有本人能看到">' + label + ' ' + n + ' · 仅本人可见</span>';
    return '<div class="modal-mask">' +
      '<div class="modal modal-relations">' +
        '<h3>' + icon(m.tab === 'followers' ? 'users' : 'heart-fill') + (m.tab === 'followers' ? '粉丝' : '关注') +
          (rel.nickname ? '<span class="rel-count">' + esc(rel.nickname) + '</span>' : '') + '</h3>' +
        '<div class="feed-tabs rel-tabs">' +
          tabBtn('followers', '粉丝', rel.followerCount || 0) +
          tabBtn('following', '关注', rel.followingCount || 0) +
        '</div>' +
        '<div class="rel-list">' + body + '</div>' +
        '<div class="modal-act"><button class="btn-ghost" data-action="modal-close">关闭</button></div>' +
      '</div></div>';
  }
  if (m.type === 'pending') {
    const list = state.data.pending || [];
    let body;
    if (m.loading) {
      body = '<div class="rel-empty">加载中…</div>';
    } else if (!list.length) {
      body = '<div class="rel-empty">' + icon('check') + ' 太好了，目前没有待审核的内容<br>发布新菜后如果进入审核队列，会出现在这里。</div>';
    } else {
      body = list.map(pendingRowHtml).join('');
    }
    return '<div class="modal-mask">' +
      '<div class="modal modal-relations modal-pending">' +
        '<h3>' + icon('clock') + '待审核<span class="rel-count">' + list.length + ' 条</span></h3>' +
        '<p class="modal-sub">这些内容正在等审核员过目，通过后所有人可见。<br>' +
          '现在只有你能看到它们，别人看不到。</p>' +
        '<div class="rel-list">' + body + '</div>' +
        '<div class="modal-act"><button class="btn-ghost" data-action="modal-close">关闭</button></div>' +
      '</div></div>';
  }
  return '';
}

// 弹窗打开时锁住页面滚动：滚轮只作用于弹窗内部，不再带动背后的首页。
// 顺带补上滚动条消失的那点宽度，避免页面内容左右抖一下。
function setModalLock(on) {
  const root = document.documentElement;
  const body = document.body;
  if (on) {
    if (!root.classList.contains('modal-open')) {
      const sbw = window.innerWidth - root.clientWidth;
      if (sbw > 0) body.style.paddingRight = sbw + 'px';
    }
    root.classList.add('modal-open');
    body.classList.add('modal-open');
  } else {
    root.classList.remove('modal-open');
    body.classList.remove('modal-open');
    body.style.paddingRight = '';
  }
}

function render() {
  const app = $('#app');
  // 重渲染会重建 DOM，先记住当前输入框的焦点与光标位置，渲染后恢复
  // 否则在搜索框/发布框里打字到一半，焦点会突然跳走
  const act = document.activeElement;
  const keepId = (act && act.id && (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA')) ? act.id : '';
  const keepSel = (keepId && typeof act.selectionStart === 'number') ? [act.selectionStart, act.selectionEnd] : null;

  if (state.route.name === 'login') {
    app.innerHTML = viewLogin();
  } else {
    // 私信页用更宽的布局变体：三栏时聊天区只剩 ~230px，气泡一长就折成好几行。
    // 聊天时右栏（热门话题/优秀饭帖）也用不上，一并收起来换横向空间。
    const wide = state.route.name === 'messages';
    app.innerHTML =
      shell() + '<div class="layout' + (wide ? ' layout-msg' : '') + '">' + sidebar() +
      '<div class="col-main">' + viewMain() + '</div>' + (wide ? '' : rightbar()) + '</div>' +
      modalHtml();
  }

  // 有弹窗时锁住背后的页面滚动（登录页不渲染弹窗，排除掉）
  setModalLock((!!state.modal || !!state.cook.open) && state.route.name !== 'login');

  if (keepId) {
    const el = document.getElementById(keepId);
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      el.focus();
      if (keepSel && el.type !== 'file' && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(keepSel[0], keepSel[1]); } catch (e) { /* ignore */ }
      }
    }
  }
}

/* ---------------------- 交互 ---------------------- */

// 打开"发布新菜"弹窗（顶栏、侧栏、任何页面的发帖入口都走这里）
function openComposer() {
  if (!state.me) { go('#/login'); return; }
  if (state.modal && state.modal.type === 'compose') {
    const ta = $('#compose-text');
    if (ta) ta.focus();
    return;
  }
  state.modal = { type: 'compose' };
  render();
  setTimeout(() => {
    const ta = $('#compose-text');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }, 80);
}

async function doPublish() {
  const ta = $('#compose-text') || $('#composer-text');
  const content = (ta ? ta.value : (state.draft || '')).trim();
  // 图片还在上传就别发：否则只会把「已经传完的那几张」发出去，
  // 用户以为 9 张都挂了，实际只存下 6 张 —— 正是这条 bug 的来源。
  if (state.upload) {
    toast('图片还在上传（' + state.upload.done + '/' + state.upload.total + '），传完再发', 'err');
    return;
  }
  if (!content && !state.draftImages.length) { toast('写点什么再发吧', 'err'); return; }
  // 关掉 @ 补全，避免挡住
  hideSuggest();
  const btn = $('[data-action="publish"]');
  if (btn) { btn.disabled = true; btn.textContent = '发布中…'; }
  try {
    const d = await api('/api/posts', { method: 'POST', body: { content, images: state.draftImages, aiAssisted: state.aiUsed } });
    const pending = d.post.status !== 'approved';
    state.draft = '';
    state.draftImages = [];
    state.uploadFailed = 0;
    state.aiUsed = false;
    state.ai = { open: false, loading: false, text: '', tags: [], err: '', n: 0 };
    state.modal = null;
    toast(pending
      ? '发布成功，正在审核中，你自己可见，通过后所有人可见'
      : '发布成功，已公开', 'ok', 'check');
    // 跳到"我的主页"，让作者立刻看到刚发布的这条
    if (state.route.name === 'mine') { state.loading = true; render(); await router(); }
    else go('#/mine');
  } catch (e) {
    toast(e.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = '发布'; }
  }
}

function compressImage(file, maxSide) {
  maxSide = maxSide || 1280;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 长边一起限制：以前只限宽，一张超长的截图缩放后仍可能撑到 5MB 以上，
        // 会被后端以「单张不能超过 5MB」拒掉，用户看到的就是"少了几张"。
        const scale = Math.min(1, maxSide / img.width, maxSide / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsDataURL(file);
  });
}

async function uploadImage(file) {
  const dataUrl = await compressImage(file);
  const r = await api('/api/upload', { method: 'POST', body: { dataUrl } });
  return r.url;
}

async function onFiles(files) {
  const room = 9 - state.draftImages.length;
  if (room <= 0) { toast('最多 9 张图片，先删掉几张再选', 'err'); return; }
  const all = Array.from(files);
  const isImg = all.filter((f) => /^image\//.test(f.type));
  let failed = all.length - isImg.length;      // 混进来的非图片文件，也算失败，别让它悄悄消失
  const picked = isImg.slice(0, room);
  const overflow = isImg.length - picked.length;  // 超出 9 张的部分
  if (!picked.length) { toast('这些不是图片文件，换几张试试', 'err'); return; }

  state.uploadFailed = 0;
  state.upload = { done: 0, total: picked.length };
  render();
  let heic = 0;
  for (const f of picked) {
    try { state.draftImages.push(await uploadImage(f)); }
    catch (e) {
      failed += 1;                             // 坏图 / HEIC / 超过 5MB，逐张记下来
      if (/^image\/hei[cf]$/i.test(f.type || '')) heic += 1;
    }
    state.upload.done += 1;
    render();                                  // 缩略图和「上传中 x/9」实时往上走
  }
  state.upload = null;
  state.uploadFailed = failed;
  render();

  // 给明确原因，而不是只闪一条 2 秒就消失的提示
  if (failed) {
    toast(heic
      ? '有 ' + heic + ' 张是 iPhone 的 HEIC 格式，浏览器解不开 —— 先在相册里导出成 JPG 再传'
      : failed + ' 张图片没能上传（格式不支持或已损坏），已跳过', 'err');
  }
  if (overflow > 0) toast('每个作品最多 9 张，多出来的 ' + overflow + ' 张没加上', 'err');

  const ta = $('#compose-text') || $('#composer-text');
  if (ta) { ta.focus(); }
}

async function toggleLike(id, btn) {
  try {
    const d = await api('/api/posts/' + id + '/like', { method: 'POST' });
    btn.classList.toggle('on', d.post.liked);
    btn.classList.toggle('on-like', d.post.liked);
    btn.innerHTML = '<span class="ico">' + icon(d.post.liked ? 'heart-fill' : 'heart') + '</span>' +
      (d.post.likeCount || '点赞');
    const local = (state.data.posts || []).find((p) => p.id === Number(id));
    if (local) { local.liked = d.post.liked; local.likeCount = d.post.likeCount; }
    if (state.data.post && state.data.post.id === Number(id)) {
      state.data.post.liked = d.post.liked;
      state.data.post.likeCount = d.post.likeCount;
    }
  } catch (e) { toast(e.message, 'err'); }
}

/* -------- 优秀饭帖（审核员/管理员给别人的作品评优） -------- */

// 评优后帖子头部那个「优秀」徽标要跟着变，但整页 render() 会打断输入框，
// 所以只动这一张卡片的 DOM。
function paintFeaturedBadge(id, on) {
  const head = document.querySelector('.post[data-post="' + id + '"] .post-head');
  if (!head) return;
  const old = head.querySelector('.badge-feat');
  if (on && !old) {
    const span = document.createElement('span');
    span.className = 'badge badge-feat';
    span.innerHTML = icon('medal-fill') + '优秀';
    head.insertBefore(span, head.querySelector('.post-meta'));
  } else if (!on && old) {
    old.remove();
  }
}

async function toggleFeature(id, btn) {
  if (btn.dataset.busy) return;      // 用 data 标记而不是 disabled，避免出现"灰色像坏了"的按钮
  btn.dataset.busy = '1';
  try {
    const d = await api('/api/posts/' + id + '/feature', { method: 'POST' });
    const on = !!d.post.featured;
    btn.classList.toggle('on', on);
    btn.innerHTML = '<span class="ico">' + icon(on ? 'medal-fill' : 'medal') + '</span>' + (on ? '已评优' : '评优');
    btn.title = on ? '从「优秀饭帖」里撤下来' : '把这条作品挂进「优秀饭帖」';
    paintFeaturedBadge(id, on);
    const local = (state.data.posts || []).find((p) => p.id === Number(id));
    if (local) local.featured = on;
    if (state.data.post && state.data.post.id === Number(id)) state.data.post.featured = on;
    toast(on ? '已挂进「优秀饭帖」' : '已从「优秀饭帖」撤下', 'ok', 'medal');
    refreshSidebar();                // 右栏那张卡立刻更新，不用手动刷新
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    delete btn.dataset.busy;
  }
}

/* -------- 转发给私信 -------- */

// 转发面板里的一行「选谁」：整行可点，右侧给个「发送」小标，避免看着像不能点
function shareRowHtml(u, postId) {
  return '<button class="share-item" data-action="share-to" data-id="' + u.id + '" data-pid="' + postId + '">' +
    avatarHtml(u, 40) +
    '<span class="share-item-main">' +
      '<span class="share-item-nm">' + esc(u.nickname) + roleBadge(u) + '</span>' +
      '<span class="share-item-sub">@' + esc(u.username) + '</span>' +
    '</span>' +
    '<span class="share-item-go">发送</span>' +
  '</button>';
}

// 转发面板主体：没输入时列「最近聊过」，有输入时列搜索结果
function sharePanelBodyHtml() {
  const m = state.modal || {};
  const q = (m.q || '').trim();
  if (q && !m.users) return '<div class="rel-empty">搜索中…</div>';
  const list = q ? (m.users || []) : (state.data.conversations || []).map((c) => c.peer);
  if (!list.length) {
    return '<div class="rel-empty">' + (q
      ? icon('search') + ' 没找到这位厨友，换个昵称或 @用户名试试'
      : icon('chat') + ' 还没和谁聊过<br>直接搜索昵称或 @用户名找人吧') + '</div>';
  }
  const sec = q ? '' : '<div class="share-sec">' + icon('chat') + ' 最近聊过</div>';
  return sec + '<div class="share-list">' + list.map((u) => shareRowHtml(u, m.postId)).join('') + '</div>';
}
function paintShareBody() {
  const box = $('#share-body');
  if (box) box.innerHTML = sharePanelBodyHtml();
}

// 打开「转发给谁」面板
async function openShare(postId) {
  if (!state.me) { go('#/login'); return; }
  state.modal = { type: 'share', postId: Number(postId), q: '', users: null };
  render();
  // 「最近聊过」要靠会话列表：没加载过就拉一次，回来只重画面板主体（不动输入框焦点）
  if (!state.data.conversations) {
    try { await loadConversations(); } catch (e) { /* ignore */ }
    if (state.modal && state.modal.type === 'share') paintShareBody();
  }
}

// 把帖子转发给某个厨友（本质是发一条带 postId 的私信）
async function shareTo(postId, peerId) {
  if (!state.me) { go('#/login'); return; }
  const m = state.modal || {};
  const pool = (m.users && m.users.length ? m.users : (state.data.conversations || []).map((c) => c.peer));
  const u = pool.find((x) => x.id === Number(peerId));
  const name = u ? u.nickname : '对方';
  try {
    const d = await api('/api/messages/' + peerId, { method: 'POST', body: { postId: Number(postId) } });
    state.modal = null;
    // 恰好正在和这个人聊天的话，直接把卡片接进当前会话，不用等轮询
    if (state.data.thread && state.data.thread.peer && state.data.thread.peer.id === Number(peerId)) {
      state.data.thread.messages = (state.data.thread.messages || []).concat([d.message]);
      paintThread();
    }
    loadConversations().then(paintConversations).catch(() => {});
    render();
    toast('已转发给 ' + name, 'ok', 'check');
  } catch (e) { toast(e.message, 'err'); }
}

async function submitComment(id) {
  const input = $('[data-comment-input="' + id + '"]');
  const content = input ? input.value.trim() : '';
  if (!content) { toast('评论不能为空', 'err'); return; }
  try {
    const d = await api('/api/posts/' + id + '/comments', { method: 'POST', body: { content } });
    const local = (state.data.posts || []).find((p) => p.id === Number(id));
    if (local) { local.comments = d.post.comments; local.commentCount = d.post.commentCount; }
    if (state.data.post && state.data.post.id === Number(id)) state.data.post = d.post;
    state.openComments[id] = true;
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteComment(pid, cid) {
  if (!confirm('删除这条评论？')) return;
  try {
    const d = await api('/api/posts/' + pid + '/comments/' + cid, { method: 'DELETE' });
    const local = (state.data.posts || []).find((p) => p.id === Number(pid));
    if (local) { local.comments = d.post.comments; local.commentCount = d.post.commentCount; }
    if (state.data.post && state.data.post.id === Number(pid)) state.data.post = d.post;
    state.openComments[pid] = true;
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function doDelete(id) {
  if (!confirm('确定删除这条内容吗？删除后不可恢复。')) return;
  try {
    await api('/api/posts/' + id, { method: 'DELETE' });
    state.data.posts = (state.data.posts || []).filter((p) => p.id !== Number(id));
    toast('已删除', 'ok');
    router();
  } catch (e) { toast(e.message, 'err'); }
}

async function submitReport(postId) {
  const sel = $('input[name="rep-reason"]:checked');
  const reason = sel ? sel.value : '其他';
  const detailEl = $('#rep-detail');
  const detail = detailEl ? detailEl.value.trim() : '';
  try {
    await api('/api/posts/' + postId + '/report', { method: 'POST', body: { reason, detail } });
    state.modal = null;
    render();
    toast('举报已提交，感谢你的反馈', 'ok', 'check');
  } catch (e) { toast(e.message, 'err'); }
}

async function doReview(id, action) {
  const reasonEl = $('[data-reason-for="' + id + '"]');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (action === 'reject' && !reason && state.reviewTab === 'pending') {
    if (!confirm('不填理由直接驳回？')) return;
  }
  try {
    await api('/api/review', { method: 'POST', body: { postId: Number(id), action, reason } });
    toast(action === 'approve' ? '已通过，内容已公开' : '已处理', 'ok', 'check');
    await loadReview();
    await refreshSidebar();
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function handleReport(id, action) {
  const label = { dismiss: '忽略这条举报？', remove: '仅下架内容？', ban: '下架内容并封禁作者？' }[action] || '确认？';
  if (!confirm(label)) return;
  try {
    await api('/api/reports/' + id, { method: 'POST', body: { action } });
    toast('已处理', 'ok');
    await loadReview();
    await refreshSidebar();
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function handleApp(id, action) {
  try {
    await api('/api/applications/' + id, { method: 'POST', body: { action } });
    toast(action === 'approve' ? '已通过，TA 现在是审核员了' : '已拒绝', 'ok');
    await loadReview();
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function adminUser(id, op) {
  const label = {
    ban: '封禁这个用户？',
    unban: '解封这个用户？',
    promote: '设为审核员？',
    demote: '取消审核员身份？',
    admin: '设为管理员？\n\n管理员拥有全部权限：审核内容、管理用户、给别人设权限。请谨慎授予。',
    unadmin: '取消管理员身份？\n\nTA 将降为审核员。',
    delete: '永久删除这个用户？\n\nTA 发过的所有内容、评论、点赞记录都会被一并清除，无法恢复。'
  }[op];
  if (!confirm(label)) return;
  // 成功后的提示文案：每个操作都要有明确反馈（此前封禁点了没提示，像没生效）
  const doneText = {
    ban: '已封禁该用户', unban: '已解封',
    promote: '已设为审核员', demote: '已取消审核员',
    admin: '已设为管理员', unadmin: '已取消管理员身份'
  }[op];
  try {
    // 后端只认 /role（带 body.role），promote/demote/admin/unadmin 是前端语义，这里做映射
    let path = '/api/admin/users/' + id + '/' + op;
    let body;
    if (op === 'promote') { path = '/api/admin/users/' + id + '/role'; body = { role: 'reviewer' }; }
    else if (op === 'demote') { path = '/api/admin/users/' + id + '/role'; body = { role: 'user' }; }
    else if (op === 'admin') { path = '/api/admin/users/' + id + '/role'; body = { role: 'admin' }; }
    else if (op === 'unadmin') { path = '/api/admin/users/' + id + '/role'; body = { role: 'reviewer' }; }
    const d = await api(path, { method: 'POST', body });
    toast(op === 'delete' ? ('已删除该用户' + (d.removedPosts ? '及其 ' + d.removedPosts + ' 篇内容' : ''))
      : (doneText || '已更新'), 'ok', 'check');
    await loadReview();
    render();
  } catch (e) { toast(e.message, 'err'); }
}

// 打开「粉丝 / 关注」弹窗。每次打开都重新拉一次，保证名单是最新的
async function openRelations(tab, ownerId) {
  tab = tab === 'following' ? 'following' : 'followers';
  ownerId = Number(ownerId) || (state.me ? state.me.id : 0);
  if (!ownerId) return;
  // 粉丝 / 关注名单都只有本人能看：非本人直接拦掉。（后端也不会返回数组，这里只是别让人白等一下）
  if (!state.me || state.me.id !== ownerId) {
    toast((tab === 'following' ? '关注' : '粉丝') + '名单只有本人能看');
    return;
  }
  state.modal = { type: 'relations', tab: tab, ownerId: ownerId, loading: true };
  render();
  try {
    const d = await api('/api/users/' + ownerId);
    state.data.relations = {
      ownerId: d.user.id,
      nickname: d.user.nickname,
      isSelf: !!d.isSelf,
      followers: d.followers || [],
      following: d.following || [],
      followerCount: d.user.followerCount || 0,
      followingCount: d.user.followingCount || 0
    };
    state.modal = { type: 'relations', tab: tab, ownerId: d.user.id };
  } catch (e) {
    state.modal = null;
    toast(e.message, 'err');
  }
  render();
}

// 点开「待审核」：每次重新拉一遍自己的内容，过滤出还在队列里的
async function openPending() {
  if (!state.me) return;
  state.modal = { type: 'pending', loading: true };
  render();
  try {
    const d = await api('/api/posts?scope=mine&limit=50');
    state.data.pending = (d.posts || []).filter((p) => p.status === 'pending');
    state.modal = { type: 'pending' };
  } catch (e) {
    state.modal = null;
    toast(e.message, 'err');
  }
  render();
}

async function toggleFollow(id, btn) {
  try {
    const d = await api('/api/users/' + id + '/follow', { method: 'POST' });
    if (btn) {
      btn.classList.toggle('on', d.following);
      btn.textContent = d.following ? '已关注' : '+ 关注';
    }
    if (state.data.profile && state.data.profile.user.id === Number(id)) {
      state.data.profile.isFollowing = d.following;
      state.data.profile.user.followerCount = d.followerCount;
    }
    // 同步自己的「关注」计数，避免回到我的主页时数字是旧的
    if (state.me) {
      state.me.followingCount = Math.max(0, (state.me.followingCount || 0) + (d.following ? 1 : -1));
    }
    toast(d.following ? '已关注' : '已取消关注', '', d.following ? 'check' : '');
    // 名单弹窗开着：重新拉一次，让列表成员和按钮状态都跟上
    // （在「关注」页签里取关某人，TA 应当从名单里消失）
    if (state.modal && state.modal.type === 'relations') {
      await openRelations(state.modal.tab, state.modal.ownerId);
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function saveProfile() {
  const nickname = ($('#edit-nickname') || {}).value || '';
  const bio = ($('#edit-bio') || {}).value || '';
  try {
    const d = await api('/api/me', { method: 'PATCH', body: { nickname: nickname.trim(), bio: bio.trim(), avatar: state.editAvatar } });
    state.me = d.user;
    toast('资料已保存', 'ok', 'check');
    go('#/mine');
  } catch (e) { toast(e.message, 'err'); }
}

async function changePassword() {
  const oldPassword = ($('#pw-old') || {}).value || '';
  const newPassword = ($('#pw-new') || {}).value || '';
  // 与服务端同一套规则，先在本地拦一次，省一个来回
  if (newPassword.length < 8) { toast('新密码至少 8 位', 'err'); return; }
  if (!/[a-zA-Z]/.test(newPassword) && !/[^\x00-\x7F]/.test(newPassword)) {
    toast('密码不能是纯数字，掺几个字母', 'err'); return;
  }
  if (newPassword === oldPassword) { toast('新密码和原密码一样，换一个吧', 'err'); return; }
  try {
    await api('/api/me/password', { method: 'POST', body: { oldPassword, newPassword } });
    const o = $('#pw-old'), n = $('#pw-new');
    if (o) o.value = '';
    if (n) n.value = '';
    state.mustChangePw = false;
    toast('密码已更新，其他设备需要重新登录', 'ok', 'check');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function applyReviewer() {
  const el = $('#apply-reason');
  const reason = el ? el.value.trim() : '';
  try {
    await api('/api/me/apply-reviewer', { method: 'POST', body: { reason } });
    toast('申请已提交，等待管理员审批', 'ok', 'medal');
    await router();
  } catch (e) { toast(e.message, 'err'); }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  state.token = '';
  state.me = null;
  state.mustChangePw = false;
  state.notes = [];
  state.data.unread = 0;
  state.data.unreadMsgs = 0;
  state.data.conversations = [];
  state.data.thread = null;
  state.msgDraft = '';
  stopMsgPoll();
  localStorage.removeItem('fq_token');
  toast('已退出登录');
  go('#/');
}

/* 注册时实时比对两次密码，边输边给反馈（不用等到点提交才知道不一致） */
function checkPwMatch(form) {
  const hint = $('#pw-match');
  if (!hint || !form) return;
  const pwEl = form.querySelector('input[name=password]');
  const cfEl = form.querySelector('input[name=confirm]');
  if (!pwEl || !cfEl) return;
  const b = cfEl.value;
  if (!b) {                                   // 还没开始输确认密码，不打扰
    hint.textContent = '';
    hint.className = 'field-hint';
    cfEl.classList.remove('ok', 'bad');
    return;
  }
  const ok = pwEl.value === b;
  hint.innerHTML = ok ? icon('check') + ' 两次输入一致' : icon('cross') + ' 两次输入的密码不一样';
  hint.className = 'field-hint ' + (ok ? 'ok' : 'bad');
  cfEl.classList.toggle('ok', ok);
  cfEl.classList.toggle('bad', !ok);
}

async function onAuthSubmit(form) {
  const isLogin = state.authTab === 'login';
  const fd = new FormData(form);
  const username = String(fd.get('username') || '').trim();
  const password = String(fd.get('password') || '');
  const nickname = String(fd.get('nickname') || '').trim();
  const confirmPw = String(fd.get('confirm') || '');
  const errBox = $('#auth-err');
  errBox.innerHTML = '';

  // 注册必须两次输入一致：先本地拦一道，给出明确原因，别让用户白提交一次
  if (!isLogin) {
    const fail = !username ? '请填写用户ID'
      : !password ? '请填写密码'
      : password.length < 8 ? '密码至少 8 位'
      : (!/[a-zA-Z]/.test(password) && !/[^\x00-\x7F]/.test(password)) ? '密码不能是纯数字，掺几个字母'
      : !confirmPw ? '请再输入一次密码进行确认'
      : confirmPw !== password ? '两次输入的密码不一致，请重新输入'
      : '';
    if (fail) {
      errBox.innerHTML = '<div class="form-err">' + esc(fail) + '</div>';
      checkPwMatch(form);
      const focusEl = form.querySelector('input[name=confirm]');
      if (confirmPw !== password && focusEl) focusEl.focus();
      return;
    }
  }

  try {
    const d = isLogin
      ? await api('/api/auth/login', { method: 'POST', body: { username, password } })
      : await api('/api/auth/register', { method: 'POST', body: { username, nickname, password } });
    state.me = d.user;
    localStorage.removeItem('fq_token');
    toast((isLogin ? '欢迎回来，' : '欢迎加入饭圈，') + d.user.nickname, 'ok', 'check');
    state.loading = true;
    render();
    await loadNotes();
    await loadUnreadMsgs();
    if (d.mustChangePw) {
      state.mustChangePw = true;
      toast('这个账号还在用初始密码，先换一个自己的', 'err', 'lock');
      go('#/edit');
    } else {
      go('#/');
    }
  } catch (e) {
    errBox.innerHTML = '<div class="form-err">' + esc(e.message) + '</div>';
  }
}

function openLightbox(src, postId) {
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = '<img src="' + esc(src) + '">';
  el.addEventListener('click', () => el.remove());
  // 手机上图片几乎占满卡片，点图片很自然会被当成「看这条帖子」。
  // 大图页给个出口，别让人只能关掉再看一遍列表。
  if (postId && state.route.name !== 'post') {
    const b = document.createElement('button');
    b.className = 'lb-open';
    b.type = 'button';
    b.innerHTML = '看这条帖子的做法' + icon('back');
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      el.remove();
      go('#/post/' + postId);
    });
    el.appendChild(b);
  }
  document.body.appendChild(el);
}

/* -------- @提及自动补全 -------- */

let suggestEl = null;
function hideSuggest() { if (suggestEl) { suggestEl.remove(); suggestEl = null; } }

async function maybeSuggest(ta) {
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const m = /@([a-zA-Z0-9_]{0,20})$/.exec(before);
  if (!m) { hideSuggest(); return; }
  let list = [];
  try {
    const d = await api('/api/users/suggest?q=' + encodeURIComponent(m[1]));
    list = d.users || [];
  } catch (e) { list = []; }
  if (ta.selectionStart !== pos || !/@([a-zA-Z0-9_]{0,20})$/.test(ta.value.slice(0, ta.selectionStart))) return;
  if (!list.length) { hideSuggest(); return; }
  const rect = ta.getBoundingClientRect();
  if (!suggestEl) { suggestEl = document.createElement('div'); suggestEl.className = 'suggest-box'; document.body.appendChild(suggestEl); }
  suggestEl.style.left = (rect.left + 12) + 'px';
  suggestEl.style.top = (rect.bottom + 6) + 'px';
  suggestEl.innerHTML = list.map((u) =>
    '<div class="sg-item" data-name="' + esc(u.username) + '">' + avatarHtml(u, 26) +
    '<span>' + esc(u.nickname) + '</span><em>@' + esc(u.username) + '</em></div>').join('');
  suggestEl.querySelectorAll('.sg-item').forEach((el) => {
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const name = el.getAttribute('data-name');
      const p = ta.selectionStart;
      const b = ta.value.slice(0, p).replace(/@([a-zA-Z0-9_]{0,20})$/, '@' + name + ' ');
      ta.value = b + ta.value.slice(p);
      state.draft = ta.value;
      hideSuggest();
      ta.focus();
    });
  });
}

/* ---------------------- 事件绑定 ---------------------- */

/* 帖子卡片的「点开看详情」抽成一个函数：
   除了拿 e.target 的祖先，还允许用坐标再兜一次底。
   真机上偶尔会出现 click 的 target 落在卡片外（滚动惯性、悬停位移、
   WebView 的点击补偿），有坐标兜底就不会白点一下。 */
let lastPostOpen = { id: '', at: 0 };

function postIdAt(target, x, y) {
  let card = target && target.closest ? target.closest('.post') : null;
  if (!card && typeof x === 'number' && typeof y === 'number') {
    const el = document.elementFromPoint(x, y);
    card = el && el.closest ? el.closest('.post') : null;
  }
  return card ? card.getAttribute('data-post') : '';
}

// 这些位置上的点击归各自的功能（按钮 / 链接 / 输入 / 评论 / 举报），不该跳详情
const POST_SKIP = 'a, button, input, textarea, select, label, [data-action], [data-zoom], .comment, .comments, .msg-share';

function tryOpenPost(target, x, y) {
  if (!target || !target.closest) return false;
  if (state.route.name === 'post') return false;
  if (target.closest(POST_SKIP)) return false;
  const pid = postIdAt(target, x, y);
  if (!pid) return false;
  lastPostOpen = { id: pid, at: Date.now() };
  go('#/post/' + pid);
  return true;
}

/* 触摸兜底：手机上有几种情况 click 压根不派发 ——
   滚动惯性刚停就点、手指抬起的瞬间页面还在回弹、
   或者点击目标在 touchend 时被浏览器判成了「滚动」。
   这里对「几乎没动、按得不久」的轻点补一次开详情，
   但会等 320ms 看 click 是否已经处理过，避免点按钮时被卡片抢走。 */
let tapStart = null;

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') { tapStart = null; return; }
  tapStart = { x: e.clientX, y: e.clientY, t: Date.now(), sy: window.scrollY, target: e.target };
}, true);

document.addEventListener('pointerup', (e) => {
  const st = tapStart;
  tapStart = null;
  if (!st || e.pointerType === 'mouse') return;
  if (state.modal || state.cook.open) return;
  if (state.route.name === 'post') return;
  if (Math.abs(e.clientX - st.x) > 10 || Math.abs(e.clientY - st.y) > 10) return;  // 划了一下
  if (Date.now() - st.t > 700) return;                                            // 长按
  if (Math.abs(window.scrollY - st.sy) > 2) return;                               // 页面滚了
  if (!st.target || !st.target.closest || st.target.closest(POST_SKIP)) return;
  const pid = postIdAt(st.target, st.x, st.y);
  if (!pid) return;
  setTimeout(() => {
    // click 正常派发的话这里已经进详情了（或者是页面自己换了路由）
    if (location.hash === '#/post/' + pid) return;
    if (lastPostOpen.id === pid && Date.now() - lastPostOpen.at < 1200) return;
    if (state.route.name === 'post' || state.modal) return;
    lastPostOpen = { id: pid, at: Date.now() };
    go('#/post/' + pid);
  }, 320);
}, true);

document.addEventListener('click', (e) => {
  const zoomEl = e.target.closest('[data-zoom]');
  if (zoomEl) {
    const zc = zoomEl.closest('.post');
    openLightbox(zoomEl.getAttribute('data-zoom'), zc ? zc.getAttribute('data-post') : '');
    return;
  }

  // 点击空白关闭通知面板
  if (!e.target.closest('#note-panel') && !e.target.closest('[data-action="note-toggle"]')) {
    if (state.noteOpen) { state.noteOpen = false; render(); }
  }
  if (!e.target.closest('.suggest-box')) hideSuggest();

  // 点弹窗「遮罩空白处」才关闭；点弹窗内部（输入框、选项、正文）一律不关
  if (state.modal && e.target.classList && e.target.classList.contains('modal-mask')) {
    state.modal = null; render(); return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) {
    // 点帖子（正文、图片外的空白、头像都算）进详情页；按钮/链接/评论区不跳
    tryOpenPost(e.target, e.clientX, e.clientY);
    return;
  }
  const action = el.getAttribute('data-action');
  const id = el.getAttribute('data-id');

  switch (action) {
    case 'logout': doLogout(); break;
    case 'publish': doPublish(); break;
    case 'ai-open': aiOpen(); break;
    case 'ai-generate': doAiGenerate(false); break;
    case 'ai-again': doAiGenerate(true); break;
    case 'ai-use': aiUse(); break;
    case 'ai-cmp': state.ai.cmp = !state.ai.cmp; paintAi(); break;
    case 'ai-close': {
      state.ai.open = false;
      state.ai.err = '';
      paintAi();
      break;
    }
    case 'cook-open': openCook(id); break;
    case 'cook-close': closeCook(); break;
    case 'cook-next': cookNext(); break;
    case 'cook-prev': cookGo(state.cook.i - 1); break;
    case 'cook-timer': cookTimerTap(Number(el.getAttribute('data-sec')) || 0); break;
    case 'cook-speak': cookSpeak(); break;
    case 'cook-ask-open': {
      state.cook.askOpen = true;
      state.cook.askErr = '';
      paintCook();
      const q = $('#ck-q');
      if (q) q.focus();
      break;
    }
    case 'cook-ask': cookAsk(''); break;
    case 'cook-quick': cookAsk(el.getAttribute('data-q')); break;
    case 'cook-newpost': {
      closeCook();
      if (!state.me) { go('#/login'); return; }
      openComposer();
      break;
    }
    case 'new-post': {
      if (!state.me) { go('#/login'); return; }
      openComposer();
      break;
    }
    case 'like': toggleLike(id, el); break;
    case 'feature': toggleFeature(id, el); break;
    case 'share': openShare(id); break;
    case 'share-to': shareTo(el.getAttribute('data-pid'), id); break;
    case 'comment-toggle': {
      state.openComments[id] = !state.openComments[id];
      render();
      if (state.openComments[id]) {
        const inp = $('[data-comment-input="' + id + '"]');
        if (inp) inp.focus();
      }
      break;
    }
    case 'comment-submit': submitComment(id); break;
    case 'cmt-del': deleteComment(el.getAttribute('data-pid'), el.getAttribute('data-cid')); break;
    case 'delete': doDelete(id); break;
    case 'report': state.modal = { type: 'report', postId: Number(id) }; render(); break;
    case 'report-submit': submitReport(id); break;
    case 'modal-close': state.modal = null; state.ai.open = false; render(); break;
    case 'approve': doReview(id, 'approve'); break;
    case 'reject': doReview(id, 'reject'); break;
    case 'rep-dismiss': handleReport(id, 'dismiss'); break;
    case 'rep-remove': handleReport(id, 'remove'); break;
    case 'rep-ban': handleReport(id, 'ban'); break;
    case 'app-approve': handleApp(id, 'approve'); break;
    case 'app-reject': handleApp(id, 'reject'); break;
    case 'user-ban': adminUser(id, 'ban'); break;
    case 'user-unban': adminUser(id, 'unban'); break;
    case 'user-promote': adminUser(id, 'promote'); break;
    case 'user-demote': adminUser(id, 'demote'); break;
    case 'user-admin': adminUser(id, 'admin'); break;
    case 'user-unadmin': adminUser(id, 'unadmin'); break;
    case 'user-delete': adminUser(id, 'delete'); break;
    case 'follow': toggleFollow(id, el); break;
    case 'relations': openRelations(el.getAttribute('data-tab'), id); break;
    case 'pending-posts': openPending(); break;
    case 'msg-open': {
      if (!state.me) { go('#/login'); return; }
      go(id ? '#/messages/' + id : '#/messages');
      break;
    }
    case 'msg-send': sendMessage(id); break;
    case 'msg-menu': {
      const mid = Number(id);
      state.msgMenu = state.msgMenu === mid ? 0 : mid;
      paintThread();
      break;
    }
    case 'msg-recall': recallMessage(Number(id)); break;
    case 'msg-delete': deleteMessage(Number(id)); break;
    case 'msg-quote': startQuote(Number(id)); break;
    case 'msg-quote-cancel': state.msgQuote = null; render(); break;
    case 'msg-quote-jump': quoteJump(Number(id)); break;
    case 'group-new': openGroupModal(); break;
    case 'group-toggle': {
      const uid = Number(id);
      const i = state.groupPick.indexOf(uid);
      if (i >= 0) state.groupPick.splice(i, 1); else state.groupPick.push(uid);
      // 记录输入框里的群名，重绘不丢
      const el = $('#group-name'); if (el) state.groupName = el.value;
      render();
      const back = $('#group-name'); if (back) back.focus();
      break;
    }
    case 'group-create': createGroup(); break;
    case 'group-info': {
      const g = (state.data.thread && state.data.thread.group) || null;
      if (g) { state.modal = { type: 'group-info', group: g }; render(); }
      break;
    }
    case 'group-leave': leaveGroup(id); break;
    case 'rel-tab': {
      if (state.modal && state.modal.type === 'relations') {
        state.modal.tab = el.getAttribute('data-tab');
        render();
      }
      break;
    }
    case 'save-profile': saveProfile(); break;
    case 'change-password': changePassword(); break;
    case 'apply-reviewer': applyReviewer(); break;
    case 'pick-avatar': {
      state.editAvatar = el.getAttribute('data-av');
      render();
      break;
    }
    case 'review-mode': {
      state.reviewMode = el.getAttribute('data-tab');
      state.loading = true; render();
      loadReview().then(() => { state.loading = false; render(); })
        .catch((err) => { state.loading = false; render(); toast(err.message, 'err'); });
      break;
    }
    case 'review-tab': {
      state.reviewTab = el.getAttribute('data-tab');
      state.loading = true; render();
      loadReview().then(() => { state.loading = false; render(); })
        .catch((err) => { state.loading = false; render(); toast(err.message, 'err'); });
      break;
    }
    case 'home-tab': {
      const tab = el.getAttribute('data-tab');
      state.homeTab = tab;
      // 让 URL 与当前 Tab 保持一致：分享链接、刷新后回到同一个流
      const feedLike = !['hot', 'mine', 'user', 'post', 'search', 'review', 'edit', 'login'].includes(state.route.name);
      if (feedLike) {
        history.replaceState(null, '', tab === 'following' ? '#/?tab=following' : '#/');
        state.route = parseHash();
      }
      state.loading = true; render();
      loadList(false).then(() => { state.loading = false; render(); })
        .catch((err) => { state.loading = false; render(); toast(err.message, 'err'); });
      break;
    }
    case 'search-submit': {
      // 点放大镜 = 提交搜索。在搜索页当场刷结果，在别的页面才跳过去
      const box = $('#search-input');
      const val = (box ? box.value : '').trim();
      if (!val) { if (box) box.focus(); break; }
      clearTimeout(window.__st);
      if (state.route.name === 'search') {
        runSearch(val);
        if (box) box.focus();
      } else {
        go('#/search?q=' + encodeURIComponent(val));
      }
      break;
    }
    case 'load-more': {
      if (state.list.loadingMore) return;
      state.list.loadingMore = true;
      render();
      loadList(true).then(() => { state.list.loadingMore = false; render(); })
        .catch((err) => { state.list.loadingMore = false; render(); toast(err.message, 'err'); });
      break;
    }
    case 'note-toggle': {
      state.noteOpen = !state.noteOpen;
      if (state.noteOpen) loadNotes().then(render);
      render();
      break;
    }
    case 'note-read-all': {
      api('/api/notifications/read', { method: 'POST', body: {} })
        .then(() => loadNotes()).then(render).catch(() => {});
      break;
    }
    case 'note-open': {
      // 直接收起面板即可（不要整页重渲染，否则会打断这条 <a> 的跳转）
      state.noteOpen = false;
      const panel = $('#note-panel');
      if (panel) panel.classList.remove('open');
      api('/api/notifications/read', { method: 'POST', body: { id: Number(id) } })
        .then(() => loadNotes()).then(() => { updateBell(); })
        .catch(() => {});
      break;
    }
    case 'auth-tab': {
      state.authTab = el.getAttribute('data-tab');
      render();
      break;
    }
    case 'rm-image': {
      state.draftImages.splice(Number(el.getAttribute('data-idx')), 1);
      state.uploadFailed = 0;   // 手动删图后，那条「N 张没能上传」的提示就过时了
      render();
      break;
    }
    default: break;
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'file-input') { onFiles(e.target.files); e.target.value = ''; }
  if (e.target.id === 'avatar-input') {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const row = e.target.closest('.av-picks');
    if (row) row.classList.add('busy');
    uploadImage(f).then((url) => { state.editAvatar = url; render(); toast('头像已更新，记得保存', 'ok'); })
      .catch((err) => { if (row) row.classList.remove('busy'); toast(err.message, 'err'); });
    e.target.value = '';
  }
  if (e.target.id === 'user-search') {
    state.keyword = e.target.value.trim();
    clearTimeout(window.__ust);
    window.__ust = setTimeout(() => { loadReview().then(render).catch(() => {}); }, 260);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'composer-text' || e.target.id === 'compose-text') {
    state.draft = e.target.value;
    // 清空了就说明这段不要了，「AI 辅助」的标记也跟着撤掉
    if (!e.target.value.trim()) state.aiUsed = false;
    const c = $('#composer-count');
    if (c) c.textContent = e.target.value.length + '/2000';
    maybeSuggest(e.target);
    return;
  }
  if (e.target.id === 'search-input') {
    const val = e.target.value;
    state.searchBox = val;          // 别处重绘时按这个回填，正在打的字不会丢
    clearTimeout(window.__st);
    // 拼音还挂在候选框里（输入框里是 hongshao 这种字母）时先不搜，
    // 等 compositionend 拿到真正的汉字再搜，免得按一串拼音去查
    if (e.isComposing || imeComposing) return;
    // 只在搜索页里「边打边搜」，而且只重画结果区：
    // 在别的页面打字不跳转，按回车（或点放大镜）才进搜索页。
    if (state.route.name === 'search') {
      window.__st = setTimeout(() => runSearch(val), 320);
    }
    return;
  }
  // 私信输入框：记住草稿，整页重渲染时不丢字
  if (e.target.id === 'msg-input') {
    state.msgDraft = e.target.value;
    return;
  }
  // 建群弹窗的群名：记住草稿，勾选成员重绘时别把名字清掉
  if (e.target.id === 'group-name') {
    state.groupName = e.target.value;
    return;
  }
  // 转发面板的搜索框：去 /api/users/suggest 找人，只重画面板主体（不整页重绘，输入焦点不丢）
  if (e.target.id === 'share-search') {
    const val = e.target.value.trim();
    if (state.modal && state.modal.type === 'share') {
      state.modal.q = val;
      state.modal.users = null;
      clearTimeout(window.__sht);
      if (!val) { paintShareBody(); return; }
      window.__sht = setTimeout(async () => {
        try {
          const d = await api('/api/users/suggest?q=' + encodeURIComponent(val));
          if (state.modal && state.modal.type === 'share' && (state.modal.q || '') === val) {
            state.modal.users = d.users || [];
            paintShareBody();
          }
        } catch (err) { /* ignore */ }
      }, 260);
    }
    return;
  }
  // 登录/注册表单：实时比对「密码 / 确认密码」
  if (e.target.closest('#auth-form')) checkPwMatch(e.target.form);
});

/* 输入法正在拼字时，回车/空格是「选字」，不是「提交」。
   Chrome 选字那一下也会派发 keydown（isComposing=true），原来的回车直接搜
   就会在拼音还没变成汉字时跳走。有些输入法的 Enter 在 compositionend 之后
   才补发，所以结束后再留 100ms 缓冲。 */
let imeComposing = false;
let imeEndAt = 0;
document.addEventListener('compositionstart', () => { imeComposing = true; }, true);
document.addEventListener('compositionend', (e) => {
  imeComposing = false;
  imeEndAt = Date.now();
  if (e.target.id === 'search-input') {
    state.searchBox = e.target.value;
    if (state.route.name === 'search') {
      clearTimeout(window.__st);
      runSearch(e.target.value);      // 汉字落定，这才真正开始搜
    }
  }
}, true);
function imeBusy(e) {
  if (e.isComposing || e.keyCode === 229 || imeComposing) return true;
  return Date.now() - imeEndAt < 100;
}

document.addEventListener('keydown', (e) => {
  if (imeBusy(e)) return;             // 正在选字：按键交给输入法
  if (e.key === 'Escape') {
    // 做饭模式在最上层：先关它，别顺手把背后的页面弹窗也关了
    if (state.cook.open) { closeCook(); return; }
    hideSuggest();
    if (state.modal) { state.modal = null; render(); }
    if (state.noteOpen) { state.noteOpen = false; render(); }
    return;
  }
  // 做饭模式：左右方向键翻步；急诊输入框里 Enter 直接问
  if (state.cook.open && !state.cook.loading && !state.cook.done) {
    if (e.key === 'ArrowRight') { cookNext(); return; }
    if (e.key === 'ArrowLeft') { cookGo(state.cook.i - 1); return; }
    if (e.key === 'Enter' && e.target.id === 'ck-q') {
      e.preventDefault();
      cookAsk('');
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && e.target.closest('[data-comment-input]')) {
    e.preventDefault();
    submitComment(e.target.getAttribute('data-comment-input'));
    return;
  }
  // 私信 / 群聊：Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'msg-input') {
    e.preventDefault();
    sendMessage(threadRouteId());
    return;
  }
  // 建群弹窗：群名输入框里 Enter 直接建群
  if (e.key === 'Enter' && e.target.id === 'group-name') {
    e.preventDefault();
    state.groupName = e.target.value;
    createGroup();
    return;
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.target.id === 'composer-text' || e.target.id === 'compose-text')) {
    e.preventDefault();
    doPublish();
  }
  if (e.key === 'Enter' && e.target.id === 'search-input') {
    e.preventDefault();
    const val = e.target.value.trim();
    clearTimeout(window.__st);
    if (!val) return;
    // 已经在搜索页就当场刷结果（不重建输入框）；在别的页面才跳过去
    if (state.route.name === 'search') runSearch(val);
    else go('#/search?q=' + encodeURIComponent(val));
    return;
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'auth-form') { e.preventDefault(); onAuthSubmit(e.target); }
});

// 滚轮落在转发面板的空白处（标题 / 搜索框 / 底部按钮）时，也把滚动转给名单，
// 免得「看着在面板上滚，却什么都没动」。名单区域内则交给浏览器原生滚动。
document.addEventListener('wheel', (e) => {
  if (!state.modal || state.modal.type !== 'share') return;
  const panel = document.querySelector('.modal-share');
  const box = document.querySelector('#share-body');
  if (!panel || !box) return;
  if (!panel.contains(e.target)) return;   // 面板外：页面已锁，什么都不用做
  if (box.contains(e.target)) return;      // 名单自己会滚，不抢
  if (box.scrollHeight <= box.clientHeight) return; // 没有可滚内容就算了
  const before = box.scrollTop;
  box.scrollTop = before + e.deltaY;
  if (box.scrollTop !== before) e.preventDefault();
}, { passive: false });

window.addEventListener('hashchange', router);
window.addEventListener('resize', hideSuggest);
window.addEventListener('scroll', hideSuggest, true);

/* ---------------------- 启动 ---------------------- */

(async function boot() {
  localStorage.removeItem('fq_token');   // 旧版本遗留，会话已改为 Cookie
  // 先判断登录态，再决定后续。这里的重试很重要：
  //   线上服务会冷启动 / 偶发抖动，只发一次请求时，第一次失败就把用户
  //   当成「未登录」（看不到自己的数据），而且没有任何提示 —— 这正是
  //   「网页打不开 / 显示未登录」的根因。所以：网络错重试，401 才算真未登录。
  try {
    const d = await apiRetry('/api/me', null, 4, 700);
    state.me = d.user;
    state.mustChangePw = !!d.mustChangePw;
    state.data.bootErr = '';
  } catch (e) {
    if (e.network) {
      // 连不上后端：不要把用户显示成「未登录」，而是明确告诉他"没连上，点重试"
      state.me = null;
      state.data.bootErr = e.message;
    } else {
      // 401 等明确的业务结果 = 真的没登录，属正常情况，静默处理
      state.me = null;
      state.data.bootErr = '';
    }
  }
  if (state.data.bootErr) {
    // 显示一个明确的错误态，而不是一个"看起来正常但空空如也"的首页
    renderBootError();
    return;
  }
  await loadNotes();
  await loadUnreadMsgs();
  await router();
  setInterval(() => {
    if (!state.me) return;
    loadNotes().then(() => { if (state.data.unread) updateBell(); });
    loadUnreadMsgs();
  }, 30000);

  // 右侧栏标着「实时」，就必须真的在刷新 —— 否则那两个字是骗人的。
  // 每 30 秒拉一次；后台标签页不拉（省流量），页面重新可见时立刻补一次。
  setInterval(() => {
    if (document.hidden || state.route.name === 'login') return;
    refreshSidebar();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.route.name !== 'login') refreshSidebar();
    // 回到前台：计时按时间戳重算一次（后台 interval 被冻住了），
    // 屏幕常亮在切后台时会被系统释放，也要重新申请
    if (state.cook.open) {
      if (state.cook.timerEnd && !state.cook.timerDone) startCookTick();
      cookWakeOn();
    }
  });
})();

/** 启动时连不上后端 → 显示错误页 + 「重试」按钮（重试即重新跑一遍 boot 逻辑） */
function renderBootError() {
  const app = $('#app');
  if (!app) return;
  app.innerHTML = '<div class="boot-error card">' +
      '<div class="boot-error-ico">' + icon('warn') + '</div>' +
      '<h2>暂时连不上服务器</h2>' +
      '<p>' + esc(state.data.bootErr || '网络开小差了') + '</p>' +
      '<p class="boot-error-tip">已经帮你重试了好几次。稍等一下再点下面的按钮试试。</p>' +
      '<button class="btn-primary" id="boot-retry" style="height:42px">重新加载</button>' +
    '</div>';
  const btn = $('#boot-retry');
  if (btn) btn.onclick = () => { state.data.bootErr = ''; app.innerHTML = ''; location.reload(); };
}

function updateBell() {
  const bell = $('[data-action="note-toggle"]');
  if (!bell) return;
  const unread = state.data.unread || 0;
  bell.classList.toggle('has', !!unread);
  let dot = bell.querySelector('.bell-dot');
  if (unread) {
    if (!dot) { dot = document.createElement('span'); dot.className = 'bell-dot'; bell.appendChild(dot); }
    dot.textContent = unread > 99 ? '99+' : unread;
  } else if (dot) dot.remove();
}

// 顶栏私信图标 + 侧栏「私信」小红点
function updateMsgBadge() {
  const n = state.data.unreadMsgs || 0;
  const btn = $('[data-action="msg-open"]');
  if (btn) {
    btn.classList.toggle('has', !!n);
    let dot = btn.querySelector('.bell-dot');
    if (n) {
      if (!dot) { dot = document.createElement('span'); dot.className = 'bell-dot'; btn.appendChild(dot); }
      dot.textContent = n > 99 ? '99+' : n;
    } else if (dot) dot.remove();
  }
  const nb = document.getElementById('nav-msg-badge');
  if (nb) {
    nb.textContent = n > 99 ? '99+' : n;
    nb.style.display = n ? '' : 'none';
  }
}
