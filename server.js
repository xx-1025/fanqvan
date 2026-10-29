'use strict';

/**
 * 饭圈 · 好好做饭的人都在这里
 * 零依赖 Node.js 后端
 *
 * 功能：认证 / 角色权限 / 发帖 / 点赞 / 评论 / 转发 / 关注 / 通知 / 举报 /
 *       审核队列 / 审核员申请审批 / 用户封禁 / 资料编辑 / 图片上传 / 分页搜索
 *
 * 启动：node server.js     默认 http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { monitorEventLoopDelay } = require('perf_hooks');

const fsp = fs.promises;

/* 极简 .env：同目录下有 .env 就读，一行一个 KEY=VALUE。
   不装 dotenv；已经存在的环境变量优先（部署平台配的不会被文件盖掉）。
   模型 key 放这里，别写进代码，也别提交到仓库。 */
(function loadEnvFile() {
  try {
    const f = path.join(__dirname, '.env');
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s[0] === '#') continue;
      const i = s.indexOf('=');
      if (i < 1) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v.slice(-1) === v[0]) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) { /* 读不到就当没配 */ }
})();

/* 有些部署环境不上传点文件（.env 会被跳过），所以再认一份同目录的 ai.config.json。
   优先级：真实环境变量 > .env > ai.config.json。文件在项目根目录，不在 public/，
   静态服务够不到；里面别放除模型配置以外的东西。 */
(function loadAiConfig() {
  try {
    const f = path.join(__dirname, 'ai.config.json');
    if (!fs.existsSync(f)) return;
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    const map = {
      key: 'FQ_AI_KEY', base: 'FQ_AI_BASE', model: 'FQ_AI_MODEL',
      thinking: 'FQ_AI_THINKING', timeout: 'FQ_AI_TIMEOUT',
      allowLocal: 'FQ_AI_ALLOW_LOCAL'
    };
    for (const k of Object.keys(map)) {
      const v = cfg[k];
      if (v !== undefined && v !== null && String(v) !== '' && !(map[k] in process.env)) {
        process.env[map[k]] = String(v);
      }
    }
  } catch (e) { /* 读不到或格式不对就当没配 */ }
})();

/* 同一份 ai.config.json 里还放两类「运维」配置（都在 .gitignore 里，不进公开仓库）：
     siteHosts:   ["xxx.app.workbuddy.host"]   → CSRF 严格比对用的对外域名
     ipWhitelist: ["1.2.3.4", "10.1.*"]        → 永不自动封禁的地址
   为什么要单独读一次：loadAiConfig 只映射模型相关的环境变量，这两项跟模型无关，
   而且要在 CSRF 判定（很早就执行）之前就准备好。 */
const EXTRA_CFG = (function () {
  try {
    const f = path.join(__dirname, 'ai.config.json');
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (e) { return {}; }
})();

const SITE_HOSTS_CFG = (Array.isArray(EXTRA_CFG.siteHosts) ? EXTRA_CFG.siteHosts : [])
  .map((s) => String(s || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''))
  .filter(Boolean);

const IP_ALLOW_CFG = (Array.isArray(EXTRA_CFG.ipWhitelist) ? EXTRA_CFG.ipWhitelist : [])
  .map((s) => String(s || '').trim()).filter(Boolean);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const DB_FILE = process.env.FQ_DB || path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
/* 请求体上限。最大的合法请求是「5MB 图片转 base64」（约 6.7MB）+ JSON 外壳，
   所以 9MB 足够；以前给到 20MB，等于允许任何人拿一个请求吃掉 20MB 内存。 */
const MAX_BODY = 9 * 1024 * 1024;

for (const d of [DATA_DIR, UPLOAD_DIR, path.dirname(DB_FILE)]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function makePw(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + hashPw(pw, salt);
}
function verifyPw(pw, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const parts = stored.split(':');
  const a = Buffer.from(hashPw(pw, parts[0]), 'hex');
  const b = Buffer.from(parts[1], 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---- 异步版哈希：抗「并发登录」型拒绝服务 ----
   scryptSync 每次都把事件循环独占约 60ms。攻击者不用破解密码，只要并发
   发几百个登录请求，进程就彻底卡死（连静态页面都出不去）。
   异步 scrypt 跑在 libuv 线程池里，事件循环照常转；线程池默认 4 条，
   CPU 消耗天然被限流，不会出现「一千个并发把机器烧穿」。
   再加一道在途闸门 PW_JOB_MAX：排队太多直接回 429，别让线程池被塞爆。 */
const PW_JOB_MAX = 6;
let pwJobs = 0;

function hashPwAsync(pw, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), salt, 32, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
}
async function makePwAsync(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + (await hashPwAsync(pw, salt));
}
async function verifyPwAsync(pw, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const i = stored.indexOf(':');
  const want = Buffer.from(stored.slice(i + 1), 'hex');
  const got = Buffer.from(await hashPwAsync(pw, stored.slice(0, i)), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
/** 密码运算名额；满了说明正被刷，返回 false */
function takePwSlot() {
  if (pwJobs >= PW_JOB_MAX) return false;
  pwJobs += 1;
  return true;
}
function freePwSlot() { pwJobs = Math.max(0, pwJobs - 1); }
function nowMs() { return Date.now(); }
function rid(n) { return crypto.randomBytes(n || 12).toString('hex'); }

/* ------------------------------------------------------------------ */
/* 密码强度                                                             */
/*                                                                     */
/* 以前只卡「至少 6 位」，于是 123456 / password 这种全站一遍就撞开了。     */
/* 现在三条硬规则 + 一张常见弱口令表：撞库成本从「几乎为零」抬到需要真跑字典。 */
/* ------------------------------------------------------------------ */

const MIN_PW = 8;
const MAX_PW = 72;            // scrypt 吃得住，再长没意义还费 CPU

/* 常见弱口令（含本项目的初始口令）。比对时忽略大小写。 */
const WEAK_PW = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910',
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'passwd',
  'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'abcd1234', 'a123456',
  '111111', '000000', '888888', '666666', '123123', '112233', '121212',
  'iloveyou', 'admin', 'admin123', 'administrator', 'root', 'root123',
  'letmein', 'welcome', 'monkey', 'dragon', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'batman', 'trustno1', 'master',
  'woaini', 'woaini1314', '5201314', '1314520', '520520', '7758521',
  'qazwsx', 'qazwsxedc', '1qaz2wsx', 'zaq12wsx', 'asdfgh', 'asdfghjkl',
  'zxcvbnm', '1q2w3e4r', '1q2w3e4r5t', 'qwe123', 'qq123456', 'aa123456',
  'test123', 'test1234', 'guest', 'changeme', 'default', 'secret',
  'fanqvan', 'fanqvan123', 'rice', 'cook123', 'food123', 'chifan'
].map((s) => s.toLowerCase()));

/** 返回 '' 表示合格，否则返回给用户看的原因 */
function passwordProblem(pw, username) {
  const s = String(pw == null ? '' : pw);
  const un = String(username || '').toLowerCase();
  if (s.length < MIN_PW) return '密码至少 ' + MIN_PW + ' 位';
  if (s.length > MAX_PW) return '密码最长 ' + MAX_PW + ' 位';
  if (!/[a-zA-Z]/.test(s) && !/[^\x00-\x7F]/.test(s)) return '密码不能是纯数字，掺几个字母';
  if (/^(.)\1+$/.test(s)) return '密码不能是同一个字符重复';
  if (WEAK_PW.has(s.toLowerCase())) return '这个密码太常见了，换一个吧';
  if (un && s.toLowerCase() === un) return '密码不能和用户ID一样';
  if (un && un.length >= 4 && s.toLowerCase().includes(un)) return '密码里别带自己的用户ID';
  return '';
}

/* 初始口令生成：16 位，四类字符都有，crypto 随机。
   故意排掉 0/O/1/l/I 这些看着一样的字，避免用户抄错。 */
const PW_LOWER = 'abcdefghijkmnpqrstuvwxyz';
const PW_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PW_DIGIT = '23456789';
const PW_SIGN = '!@#%^&*-_=+';
const PW_ALPHA = PW_LOWER + PW_UPPER + PW_DIGIT;

function randPassword(n) {
  const len = Math.max(12, Number(n) || 16);
  const out = [];
  for (let i = 0; i < len; i++) out.push(PW_ALPHA[crypto.randomInt(PW_ALPHA.length)]);
  out[0] = PW_LOWER[crypto.randomInt(PW_LOWER.length)];
  out[1] = PW_UPPER[crypto.randomInt(PW_UPPER.length)];
  out[2] = PW_DIGIT[crypto.randomInt(PW_DIGIT.length)];
  out[3] = PW_SIGN[crypto.randomInt(PW_SIGN.length)];
  return out.join('');
}

/** 初始口令取环境变量（FQ_ADMIN_PASSWORD / FQ_REVIEWER_PASSWORD），没有就随机生成 */
function bootPassword(username) {
  const env = String(process.env['FQ_' + String(username).toUpperCase() + '_PASSWORD'] || '').trim();
  if (env.length >= MIN_PW && !WEAK_PW.has(env.toLowerCase())) return env;
  return randPassword(16);
}

/* 一个永远不可能被撞上的假哈希：登录时用户不存在也拿它跑一遍，
   让「查无此人」和「密码错」耗时一致，堵住靠响应时间枚举用户ID的路子。 */
const DUMMY_PW_HASH = makePw(randPassword(32));

/* ------------------------------------------------------------------ */
/* 安全事件日志                                                          */
/*                                                                     */
/* 只记「谁在什么时候触发了什么」，不记密码、不记 token、不记正文。         */
/* 写到 data/security.log（静态目录拿不到，见 STATIC_DENY）。              */
/* ------------------------------------------------------------------ */

const SEC_LOG = path.join(DATA_DIR, 'security.log');
const SEC_LOG_MAX = 4 * 1024 * 1024;
let secLogBytes = -1;
let secLogBusy = false;

function secLog(kind, req, extra) {
  try {
    const line = JSON.stringify(Object.assign({
      t: new Date().toISOString(),
      kind,
      ip: req ? clientIp(req) : '',
      ua: req ? String(req.headers['user-agent'] || '').slice(0, 90) : ''
    }, extra || {})) + '\n';

    if (secLogBytes < 0) {
      try { secLogBytes = fs.statSync(SEC_LOG).size; } catch { secLogBytes = 0; }
    }
    // 超过 4MB 轮转：老文件留一份 .1，够查一周的量
    if (secLogBytes + line.length > SEC_LOG_MAX && !secLogBusy) {
      secLogBusy = true;
      try { fs.renameSync(SEC_LOG, SEC_LOG + '.1'); } catch {}
      secLogBytes = 0;
      secLogBusy = false;
    }
    secLogBytes += Buffer.byteLength(line);
    fs.appendFile(SEC_LOG, line, () => {});
  } catch (e) { /* 日志失败绝不影响业务 */ }
}

const ROLE_RANK = { user: 0, reviewer: 1, admin: 2 };
function rankOf(u) { return u ? (ROLE_RANK[u.role] || 0) : -1; }

/* ------------------------------------------------------------------ */
/* 数据                                                                 */
/* ------------------------------------------------------------------ */

const H = 3600 * 1000;

const AVATARS = [
  '/assets/av-onigiri.webp',
  '/assets/av-tomato.webp',
  '/assets/av-egg.webp',
  '/assets/av-ramen.webp'
];

/* 首次建库时生成的高权限口令，交给 ensureBootstrap 打印一次。
   为什么要在这里生成：以前 seed 把 admin/reviewer 也设成 123456，靠「启动时把弱口令
   换成随机的」兜底 —— 那个兜底会捎带上真实用户的账号（他们再也登不进去）。
   现在反过来了：**建库那一刻就随机**，之后任何账号的口令都不再被服务器偷偷改掉。 */
const SEED_CREDS = [];

function seed() {
  const d = {
    users: [], posts: [], notifications: [], reports: [], applications: [],
    messages: [], groups: [], sessions: {}, seq: 1, createdAt: nowMs()
  };
  const nid = () => d.seq++;
  const t = nowMs();

  const mkUser = (username, nickname, role, bio, daysAgo, avatar, pw) => {
    const u = {
      id: nid(), username, nickname,
      password: makePw(pw || '123456'),
      role, bio, avatar: avatar || AVATARS[0],
      follows: [], banned: false,
      createdAt: t - daysAgo * 24 * H
    };
    d.users.push(u);
    return u;
  };

  // 演示账号保持 123456，方便本地试；两个高权限账号用随机口令，只打印这一次
  const adminPw = bootPassword('admin');
  const guardPw = bootPassword('reviewer');
  SEED_CREDS.push(['admin', adminPw], ['reviewer', guardPw]);

  const admin = mkUser('admin', '饭圈小管家', 'admin', '官方管理员 · 维护饭圈秩序 🍳', 60, '/assets/av-egg.webp', adminPw);
  const guard = mkUser('reviewer', '值班审核员', 'reviewer', '每天巡一遍审核队列，看到好菜谱就走不动路', 45, '/assets/av-tomato.webp', guardPw);
  // 系统生成的口令：只做标记（登录日志里能看到），不拦任何操作
  admin.mustChangePw = true;
  guard.mustChangePw = true;
  const zhang = mkUser('laozhang', '老张头', 'user', '家常菜三十年，红烧肉是招牌', 35, '/assets/av-ramen.webp');
  const mei = mkUser('xiaomei', '小美厨房', 'user', '烘焙 / 甜点 / 记录每一次翻车与成功', 30, '/assets/av-onigiri.webp');
  const hunter = mkUser('hunter', '美食猎人', 'user', '走遍全国的街边小吃', 20, '/assets/av-onigiri.webp');
  const lin = mkUser('linlin', '林小厨', 'user', '一人食也要认真做', 12, '/assets/av-tomato.webp');

  // 关注关系
  zhang.follows = [mei.id, hunter.id];
  mei.follows = [zhang.id, admin.id];
  hunter.follows = [zhang.id];
  lin.follows = [zhang.id, mei.id, hunter.id];
  admin.follows = [];

  const mkPost = (author, content, hoursAgo, status, likesIdx, comments) => {
    const p = {
      id: nid(),
      authorId: author.id,
      content: content,
      images: [],
      status: status || 'approved',
      rejectReason: '',
      createdAt: t - hoursAgo * H,
      likes: (likesIdx || []).map((i) => d.users[i].id),
      comments: (comments || []).map((c) => ({
        id: 0,
        userId: d.users[c[0]].id,
        content: c[1],
        createdAt: t - Math.max(0.05, hoursAgo - 0.2) * H
      })),
      reposts: []
    };
    p.comments.forEach((c) => { c.id = nid(); });
    d.posts.push(p);
    return p;
  };

  mkPost(
    zhang,
    '今天这锅红烧肉，火候终于对了。\n\n记住三个数字：五花肉 500g、冰糖 20g、小火 40 分钟。糖色炒到枣红立刻下肉，晚一秒就发苦。\n\n#家常菜# #红烧肉#',
    3, 'approved', [2, 3, 0],
    [[2, '看着就香！明天就试'], [3, '原来糖色一红就要下肉，我说怎么老发苦']]
  );
  mkPost(
    mei,
    '第 7 次做戚风终于没塌！关键就是蛋白打到硬性发泡，翻拌要像切菜一样从底部兜起来，千万别画圈。\n\n@laozhang 老张你上次说的那个温度我试了，160 度真的稳。\n\n#烘焙# #戚风蛋糕#',
    8, 'approved', [1, 3],
    [[1, '戚风是真的玄学，佩服']]
  );
  mkPost(
    hunter,
    '深夜路边摊的炒饭，灵魂其实是那一勺猪油 + 最后沿锅边淋的一圈生抽。\n\n#街边小吃# #蛋炒饭#',
    30, 'pending', [], []
  );
  mkPost(
    zhang,
    '番茄炒蛋到底放不放糖？我们家是放的，而且番茄一定要炒到出沙。\n\n#家常菜# #番茄炒蛋#',
    26, 'approved', [2],
    [[2, '放糖派 +1，酸甜才下饭']]
  );
  mkPost(
    mei,
    '周末做了提拉米苏，手指饼干是自己烤的，咖啡液里加了一点点朗姆酒，香到我妈都夸。\n\n#甜品# #提拉米苏#',
    50, 'approved', [1, 0, 3],
    [[0, '看着就有食欲，求个配方'], [3, '自制手指饼干太卷了']]
  );
  mkPost(
    lin,
    '一个人也要好好吃饭。今天做了十五分钟就能上桌的蒜香虾仁意面，虾头煎出虾油是灵魂。\n\n#一人食# #意面#',
    5, 'approved', [2],
    [[2, '十五分钟！收了']]
  );

  // 私信示例：都发给管理员 admin，这样用演示账号 admin 登录就能立刻看到聊天列表。
  // read=false 表示对方还没读过，用于演示未读小红点。
  const mkMsg = (from, to, content, hoursAgo, read) => {
    d.messages.push({
      id: nid(), fromId: from.id, toId: to.id, content: content,
      createdAt: t - hoursAgo * H, read: !!read
    });
  };
  mkMsg(mei, admin, '管家你好～我想申请当审核员，可以吗？', 6, true);
  mkMsg(admin, mei, '当然可以，去「我的资料」里提交申请就行 🍳', 5.7, true);
  mkMsg(mei, admin, '提交好啦，麻烦你看看～', 5.6, true);
  mkMsg(hunter, admin, '街边炒饭那篇还在审核吗？想早点发出来', 3, true);
  mkMsg(admin, hunter, '在队列里了，今天就处理 👍', 2.8, true);
  mkMsg(zhang, admin, '红烧肉那个菜谱又被驳回了，能说下原因吗？', 1.1, false);
  mkMsg(mei, admin, '今天按你说的火候做成功了，谢谢你！', 0.6, false);
  mkMsg(lin, admin, '你好，一个人做饭有什么推荐的菜吗？', 0.3, false);

  return d;
}

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.users)) return migrate(parsed);
    } catch (e) {
      console.error('[db] 读取失败，将重新初始化：', e.message);
    }
  }
  return null;
}

/** 补齐旧数据缺失的字段，保证升级不丢数据 */
function migrate(d) {
  d.posts = d.posts || [];
  d.notifications = d.notifications || [];
  d.reports = d.reports || [];
  d.applications = d.applications || [];
  d.messages = d.messages || [];
  d.groups = d.groups || [];
  d.sessions = d.sessions || {};
  d.seq = d.seq || 1;
  for (const g of d.groups) {
    if (!Array.isArray(g.memberIds)) g.memberIds = [];
    if (typeof g.createdAt !== 'number') g.createdAt = nowMs();
    if (typeof g.ownerId !== 'number') g.ownerId = g.memberIds[0] || 0;
  }
  // 私信消息：补齐「撤回 / 仅自己删除 / 引用」三个新字段（老数据平滑升级）
  for (const m of d.messages) {
    if (typeof m.recalled !== 'boolean') m.recalled = false;
    if (typeof m.recalledAt !== 'number') m.recalledAt = 0;
    if (!Array.isArray(m.deletedFor)) m.deletedFor = [];
    if (typeof m.quoteId !== 'number') m.quoteId = 0;
    if (typeof m.toGroupId !== 'number') m.toGroupId = 0;
  }
  for (const u of d.users) {
    if (!Array.isArray(u.follows)) u.follows = [];
    if (typeof u.banned !== 'boolean') u.banned = false;
    if (!u.role) u.role = 'user';
  }
  for (const p of d.posts) {
    if (!Array.isArray(p.likes)) p.likes = [];
    if (!Array.isArray(p.comments)) p.comments = [];
    if (!Array.isArray(p.reposts)) p.reposts = [];
    if (!Array.isArray(p.images)) p.images = [];
    // 「评优」：审核员/管理员把别人的佳作挂进右栏「优秀饭帖」
    if (typeof p.featured !== 'boolean') p.featured = false;
    if (typeof p.featuredAt !== 'number') p.featuredAt = 0;
    if (typeof p.featuredBy !== 'number') p.featuredBy = 0;
  }
  return d;
}

let db = loadDB() || seed();

/**
 * 自愈：保证系统里始终存在一个管理员账号。
 * 老版本数据里 admin 只是 reviewer，升级后会自动提权；
 * 若账号不存在则按默认凭据重建，避免出现"没人能管"的死局。
 */
function ensureBootstrap() {
  let admin = db.users.find((u) => u.username === 'admin');
  let changed = false;
  const fresh = [];
  if (!admin) {
    const pw = bootPassword('admin');
    admin = {
      id: db.seq++, username: 'admin', nickname: '饭圈小管家',
      password: makePw(pw), role: 'admin',
      bio: '官方管理员 · 维护饭圈秩序 🍳',
      avatar: '/assets/av-egg.webp',
      follows: [], banned: false, createdAt: nowMs(),
      pwStrong: true, mustChangePw: true
    };
    db.users.push(admin);
    changed = true;
    fresh.push(['admin', pw]);
  } else if (admin.role !== 'admin') {
    admin.role = 'admin';
    admin.banned = false;
    changed = true;
  }
  let reviewer = db.users.find((u) => u.username === 'reviewer');
  if (!reviewer) {
    const pw = bootPassword('reviewer');
    reviewer = {
      id: db.seq++, username: 'reviewer', nickname: '值班审核员',
      password: makePw(pw), role: 'reviewer',
      bio: '每天巡一遍审核队列，看到好菜谱就走不动路',
      avatar: '/assets/av-tomato.webp',
      follows: [], banned: false, createdAt: nowMs(),
      pwStrong: true, mustChangePw: true
    };
    db.users.push(reviewer);
    changed = true;
    fresh.push(['reviewer', pw]);
  }
  if (changed) saveNow();
  if (fresh.length) printInitialCredentials(fresh, '新建');
  if (SEED_CREDS.length) printInitialCredentials(SEED_CREDS.splice(0), '首次建库');
  rotateWeakCredentials();
}

/* ------------------------------------------------------------------ */
/* 初始口令下发                                                          */
/*                                                                     */
/* 只在「账号刚建出来」或「它还在用 123456 这类弱口令」时触发一次。          */
/* 目的很明确：让 admin/123456 这种全网都在扫的组合彻底失效。              */
/* 口令不写进代码、不进 db 的明文，只有这一次输出 + data/password-reset.txt */
/* （0600 权限，静态目录访问不到）。登录后请立刻改密并删除该文件。           */
/* ------------------------------------------------------------------ */

function printInitialCredentials(list, why) {
  const when = new Date().toISOString();
  console.log('');
  console.log('  [SECURITY] ' + why + '账号的初始口令（只打印这一次，请立刻保存并修改）：');
  for (const [name, pw] of list) console.log('    ' + name + '  ' + pw);
  console.log('    同时已写入 data/password-reset.txt（权限 0600）');
  console.log('');

  try {
    const file = path.join(DATA_DIR, 'password-reset.txt');
    const head = '# 饭圈 · ' + why + '口令（' + when + '）\n' +
      '# 登录后请立刻在「我的 → 修改密码」里换掉，然后删掉这个文件。\n';
    const body = list.map(([n, p]) => n + '\t' + p).join('\n') + '\n';
    fs.appendFileSync(file, head + body, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (e) {
    console.warn('[security] 口令文件写入失败：' + e.message);
  }
}

/* 老库里可能还留着 123456 / password 这种。启动时扫一遍（每个账号只扫一次，
   用 pwChecked 记账，避免每次启动都跑一堆 scrypt）。
   **只做标记，绝不改口令。**
   以前这里会把 admin / 审核员的口令直接换成随机 16 位，后果是本人再也登不进去 ——
   新口令只打印在那一次的启动日志里，本地没留存就彻底找不回（真实踩过）。
   产品要求「密码不严格」：登录永远认用户原来设的那个口令，
   强度规则只在**注册**和**主动改密**时检查。 */
const KNOWN_WEAK = ['123456', '12345678', '123456789', 'password', 'passw0rd', 'admin123', 'fanqvan123', 'abc123', 'qwerty'];

function rotateWeakCredentials() {
  let changed = false;
  let weak = 0;
  const highRisk = [];
  for (const u of db.users) {
    if (!u.password || u.password.indexOf(':') < 0) continue;
    if (u.pwChecked) continue;
    u.pwChecked = true;
    changed = true;
    if (!KNOWN_WEAK.some((p) => verifyPw(p, u.password))) continue;
    u.mustChangePw = true;      // 只留个标记，登录日志里能看到，不拦任何操作
    weak++;
    if (rankOf(u) >= 1) highRisk.push(u.username);
  }
  if (changed) saveDB();
  if (weak) console.log('[security] 有 ' + weak + ' 个账号还在用常见弱口令（不强制改，建议自己换掉）');
  if (highRisk.length) {
    console.warn('[security] 高权限账号仍在用常见弱口令：' + highRisk.join(', ') +
      ' —— 服务器不会自动改（改了本人就登不进来）。请自己到「编辑资料」改掉，' +
      '或在 ai.config.json 里用 userPasswords 一次性重置。');
  }
}

let saveTimer = null;
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[db] 写入失败：', e.message);
    }
  }, 60);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[db] 写入失败：', e.message);
  }
}
saveNow();
ensureBootstrap();
applyPasswordResetFromConfig();

/* 忘了管理员口令时的应急通道。
   在 ai.config.json 里加一行 "adminPassword": "想用的新口令"，重启 / 重新部署后
   就会把 admin 的口令换成它，并**立刻把这一行从文件里删掉** —— 明文只在磁盘上
   活到这一次启动。（reviewerPassword 同理；任意账号用 userPasswords 映射。）
   为什么要这个：admin 的口令是首次建号时随机生成的，只打印在那一次的启动日志里，
   连库里都只有哈希；忘了就再也拿不回来，只能靠这条通道重置。
   ai.config.json 在 .gitignore 里，不会进公开仓库。 */
function applyPasswordResetFromConfig() {
  const cfgFile = path.join(__dirname, 'ai.config.json');
  let cfg = null;
  try {
    if (!fs.existsSync(cfgFile)) return;
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch (e) { return; }
  const pairs = [['adminPassword', 'admin'], ['reviewerPassword', 'reviewer']];
  const done = [];
  /* 任意账号：{"userPasswords": {"laozhang": "123456"}}。
     显式指定就不套强度规则 —— 这是管理员手动干预，不是用户自己设密码，
     而且「老账号回不去」正是这条通道要解决的问题。只挡空口令和超长。 */
  const map = (cfg.userPasswords && typeof cfg.userPasswords === 'object') ? cfg.userPasswords : null;
  const wanted = [];
  for (const [key, username] of pairs) {
    const pw = String(cfg[key] || '').trim();
    if (pw) wanted.push([username, pw, true]);
  }
  if (map) {
    for (const [username, raw] of Object.entries(map)) {
      const pw = String(raw || '');
      if (!pw || pw.length < 4 || pw.length > 64 || /\s/.test(pw)) {
        console.warn('[security] userPasswords 里的 ' + username + ' 口令不合规（4-64 位、不含空格），跳过');
        continue;
      }
      wanted.push([username, pw, false]);
    }
  }
  for (const [username, pw, strict] of wanted) {
    const user = db.users.find((u) => u.username === username);
    if (!user) continue;
    if (strict) {
      const problem = passwordProblem(pw, username);
      if (problem) { console.warn('[security] ai.config.json 里 ' + username + ' 的口令不合规：' + problem); continue; }
    }
    user.password = makePw(pw);
    user.pwStrong = true;
    user.pwChecked = true;
    user.pwResetAt = nowMs();
    delete user.mustChangePw;
    dropUserSessions(user.id);          // 换完口令，其他设备一律下线
    done.push(username);
  }
  if (!done.length) return;
  saveNow();
  for (const [key] of pairs) delete cfg[key];
  delete cfg.userPasswords;
  try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); } catch (e) { /* 只读目录就算了 */ }
  console.log('[security] 已按 ai.config.json 重置口令：' + done.join(', ') + '（文件里的明文已清除）');
  secLog('pw_reset_by_config', null, { users: done.join(',') });
}

/* ------------------------------------------------------------------ */
/* 上传：真实类型校验 + 空间配额                                         */
/*                                                                     */
/* 以前只校验 dataURL 前缀，而那句 "data:image/png" 是客户端随手写的，      */
/* 塞个 HTML、压缩包、10MB 垃圾进来都照存不误。现在只认文件头魔数。        */
/* ------------------------------------------------------------------ */

const UPLOAD_MAX_ONE = 5 * 1024 * 1024;              // 单张 5MB
const UPLOAD_MAX_USER = 300 * 1024 * 1024;           // 单人 300MB
const UPLOAD_MAX_ALL = 2 * 1024 * 1024 * 1024;       // 全站 2GB

/** 只认二进制头，返回 'png' | 'jpg' | 'gif' | 'webp' | '' */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const h6 = buf.slice(0, 6).toString('latin1');
  if (h6 === 'GIF87a' || h6 === 'GIF89a') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' &&
    buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return '';
}

/* 空间账本：启动后第一次上传时扫一遍目录，之后靠增量维护，不每次 readdir */
const upUserBytes = new Map();
let upTotalBytes = 0;
let upScanned = false;
function scanUploads() {
  if (upScanned) return;
  upScanned = true;
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      let sz = 0;
      try { sz = fs.statSync(path.join(UPLOAD_DIR, f)).size; } catch { continue; }
      upTotalBytes += sz;
      const m = /^u(\d+)-/.exec(f);
      if (m) upUserBytes.set(Number(m[1]), (upUserBytes.get(Number(m[1])) || 0) + sz);
    }
  } catch (e) { /* 目录还不存在就当 0 */ }
}

/* ------------------------------------------------------------------ */
/* 权限 / 序列化                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 会话：Cookie 优先（反向代理可能丢弃 Authorization 头）                  */
/* ------------------------------------------------------------------ */

const COOKIE_NAME = 'fq_token';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86400000;

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers['cookie'] || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 依次尝试：Cookie → Authorization 头 → X-Auth-Token 头。
    注意：**不支持**把 token 放 URL 查询参数 —— URL 会进浏览器历史/Referer/服务器日志，
    等于把登录凭证到处泄露。前端也从不这么传。 */
function tokenFromReq(req) {
  const c = parseCookies(req)[COOKIE_NAME];
  if (c) return { token: c, via: 'cookie' };
  const h = String(req.headers['authorization'] || '');
  if (h.startsWith('Bearer ')) return { token: h.slice(7).trim(), via: 'authorization' };
  const x = String(req.headers['x-auth-token'] || '');
  if (x) return { token: x, via: 'x-auth-token' };
  return { token: '', via: 'none' };
}

function isHttps(req) {
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
  return proto === 'https' || !!(req.socket && req.socket.encrypted);
}
function sessionCookie(token, maxAgeSec, secure) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec +
    (secure ? '; Secure' : '');
}

/* 会话表只存 token 的 SHA-256 摘要，**不存原文**。
   起因：以前 db.sessions[token] = userId，token 明文躺在 db.json 里，
   库文件一旦被读走（备份泄露、目录配错、误提交），所有人都能拿着 cookie 直接登录。
   现在 Cookie 里放的仍是原文，服务端每次算摘要去查 —— 拖库换不回登录态。
   记录结构也从「数字」升级成 { uid, at, exp }，补上服务端过期，
   避免浏览器丢了 Cookie、服务端却永远认这个 token。 */
function tokHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function sessionUid(v) {
  if (v == null) return 0;
  return typeof v === 'object' ? Number(v.uid || 0) : Number(v);
}
function sessionExpired(v) {
  return !!(v && typeof v === 'object' && v.exp && nowMs() > v.exp);
}

const MAX_SESSIONS = 3000;
function addSession(token, userId) {
  const now = nowMs();
  db.sessions[tokHash(token)] = { uid: userId, at: now, exp: now + SESSION_MS };
  const keys = Object.keys(db.sessions);
  if (keys.length > MAX_SESSIONS) {
    // 对象键序即写入顺序，先删最早的一批
    for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete db.sessions[k];
  }
  saveNow();
}
/** 清掉某用户的会话；keepToken 传原文时保留这一个（改密码后不把自己踢下线） */
function dropUserSessions(userId, keepToken) {
  const keep = keepToken ? tokHash(keepToken) : '';
  let n = 0;
  for (const k of Object.keys(db.sessions)) {
    const v = db.sessions[k];
    if (sessionUid(v) !== userId) continue;
    if (k === keep || k === keepToken) continue;
    delete db.sessions[k];
    n++;
  }
  return n;
}
function dropSession(token) {
  if (!token) return;
  const h = tokHash(token);
  let hit = false;
  if (db.sessions[h] !== undefined) { delete db.sessions[h]; hit = true; }
  // 兼容旧库里的明文键
  if (db.sessions[token] !== undefined) { delete db.sessions[token]; hit = true; }
  if (hit) saveNow();
}

function currentUser(req) {
  const { token } = tokenFromReq(req);
  if (!token) return null;
  const h = tokHash(token);
  let rec = db.sessions[h];

  // 旧库迁移：命中明文键就地换成摘要键，老用户不会因为这次升级被踢下线
  if (rec === undefined) {
    const legacy = db.sessions[token];
    if (legacy === undefined) return null;
    delete db.sessions[token];
    const now = nowMs();
    rec = { uid: sessionUid(legacy), at: now, exp: now + SESSION_MS };
    db.sessions[h] = rec;
    saveDB();
  }

  if (sessionExpired(rec)) {
    delete db.sessions[h];
    saveDB();
    return null;
  }
  const userId = sessionUid(rec);
  if (!userId) return null;
  const u = db.users.find((x) => x.id === userId);
  if (!u || u.banned) return null;
  return u;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, nickname: u.nickname,
    role: u.role, bio: u.bio, avatar: u.avatar, createdAt: u.createdAt,
    followerCount: db.users.filter((x) => (x.follows || []).includes(u.id)).length,
    followingCount: (u.follows || []).length
  };
}

function briefUser(u) {
  if (!u) return { id: 0, username: '', nickname: '已注销', role: 'user', avatar: '' };
  return { id: u.id, username: u.username, nickname: u.nickname, role: u.role, avatar: u.avatar };
}

/** 两人之间的关系标签：互相关注 / 已关注 / 关注了你 / '' —— 聊天窗口顶部展示用 */
function relationTag(me, peer) {
  if (!me || !peer) return '';
  const iFollow = (me.follows || []).includes(peer.id);
  const followsMe = (peer.follows || []).includes(me.id);
  if (iFollow && followsMe) return '互相关注';
  if (iFollow) return '已关注';
  if (followsMe) return '关注了你';
  return '';
}

function serializePost(p, me, opts) {
  opts = opts || {};
  const author = db.users.find((u) => u.id === p.authorId);
  return {
    id: p.id,
    content: p.content,
    images: p.images || [],
    aiAssisted: !!p.aiAssisted,
    status: p.status,
    rejectReason: p.rejectReason || '',
    createdAt: p.createdAt,
    author: briefUser(author),
    likeCount: (p.likes || []).length,
    liked: me ? (p.likes || []).includes(me.id) : false,
    commentCount: (p.comments || []).length,
    repostCount: (p.reposts || []).length,
    reposted: me ? (p.reposts || []).includes(me.id) : false,
    // 优秀饭帖：所有人可见的「优秀」徽标靠它
    featured: !!p.featured,
    featuredAt: p.featuredAt || 0,
    reportCount: opts.withReports ? db.reports.filter((r) => r.targetType === 'post' && r.targetId === p.id && r.status === 'open').length : 0,
    comments: (p.comments || []).map((c) => ({
      id: c.id,
      content: c.content,
      createdAt: c.createdAt,
      canDelete: me ? (me.id === c.userId || me.id === p.authorId || rankOf(me) >= 1) : false,
      user: briefUser(db.users.find((u) => u.id === c.userId))
    })),
    canDelete: me ? (me.id === p.authorId || rankOf(me) >= 1) : false
  };
}

/** 私信里「转发帖子」的卡片摘要：原帖被删了返回 null，前端据此显示「内容已不存在」 */
function shareBrief(postId) {
  const p = db.posts.find((x) => x.id === postId);
  if (!p) return null;
  return {
    id: p.id,
    excerpt: (p.content || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    image: (p.images || [])[0] || '',
    author: briefUser(db.users.find((u) => u.id === p.authorId))
  };
}

/** 私信序列化：带 postId 的消息附上帖子卡片摘要；
 *  支持撤回（留占位）、仅自己删除（对本人不返回）、引用（附被引消息摘要）。 */
function msgOut(m, me) {
  const meId = me ? me.id : 0;
  // 「仅自己删除」：对删过的本人不返回这条（对方仍看得到）
  if (meId && Array.isArray(m.deletedFor) && m.deletedFor.includes(meId)) return null;
  const o = { id: m.id, content: m.content, createdAt: m.createdAt, mine: meId ? m.fromId === meId : false };
  if (m.recalled) {
    // 撤回后不再暴露原文；前端按「你/TA 撤回了一条消息」渲染
    o.recalled = true;
    o.content = '';
    o.postId = 0;
    return o;
  }
  if (m.postId) { o.postId = m.postId; o.post = shareBrief(m.postId); }
  if (m.quoteId) {
    const q = db.messages.find((x) => x.id === m.quoteId);
    if (q && !q.recalled && !(Array.isArray(q.deletedFor) && q.deletedFor.includes(meId))) {
      const qFrom = db.users.find((u) => u.id === q.fromId);
      o.quote = {
        id: q.id,
        content: q.postId ? '［转发］一条内容' : (q.content || '').slice(0, 60),
        nickname: qFrom ? qFrom.nickname : '已注销',
        mine: q.fromId === meId
      };
    } else {
      o.quote = { id: m.quoteId, gone: true, content: '原消息已不存在', nickname: '', mine: false };
    }
  }
  if (m.toGroupId) { o.groupId = m.toGroupId; o.from = briefUser(db.users.find((u) => u.id === m.fromId)); }
  return o;
}

/** 群序列化：成员数 + 该群的未读数（传给查看者） */
function groupOut(g, me) {
  const members = g.memberIds.map((id) => db.users.find((u) => u.id === id)).filter(Boolean);
  return {
    id: g.id,
    name: g.name,
    avatar: g.avatar || '',
    ownerId: g.ownerId,
    memberCount: members.length,
    memberIds: g.memberIds.slice(),
    members: members.slice(0, 60).map(briefUser),
    createdAt: g.createdAt
  };
}

/* ------------------------------------------------------------------ */
/* 通知                                                                 */
/* ------------------------------------------------------------------ */

const NOTE_TEXT = {
  like: '赞了你的内容',
  comment: '评论了你的内容',
  follow: '关注了你',
  mention: '在内容里提到了你',
  approve: '你的内容已通过审核',
  reject: '你的内容未通过审核',
  report: '你举报的内容已被处理',
  apply: '提交了审核员申请',
  applyResult: '你的审核员申请有结果了',
  moderation: '有需要审核员处理的内容'
};

function pushNote(userId, type, actorId, extra) {
  extra = extra || {};
  if (!userId || userId === actorId) return;
  const target = db.users.find((u) => u.id === userId);
  if (!target) return;
  db.notifications.unshift({
    id: db.seq++,
    userId: userId,
    type: type,
    actorId: actorId || 0,
    postId: extra.postId || 0,
    text: extra.text || '',
    read: false,
    createdAt: nowMs()
  });
  const mine = db.notifications.filter((n) => n.userId === userId);
  if (mine.length > 200) {
    const cutoff = mine[200].id;
    db.notifications = db.notifications.filter((n) => n.userId !== userId || n.id >= cutoff);
  }
}

const MENTION_RE = /@([a-zA-Z0-9_]{3,20})/g;
function notifyMentions(content, actor, postId, prefix) {
  const seen = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(String(content || '')))) {
    const uname = m[1].toLowerCase();
    if (seen.has(uname)) continue;
    seen.add(uname);
    const u = db.users.find((x) => x.username.toLowerCase() === uname);
    if (u && u.id !== actor.id) {
      pushNote(u.id, 'mention', actor.id, { postId: postId, text: prefix || '' });
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------ */
/* 安全响应头                                                            */
/* ------------------------------------------------------------------ */

/* 前端零外部依赖（无外链脚本/字体/图片），所以 CSP 可以收得很紧：
   - default-src 'self'：默认只允许同源
   - script-src 'self'：脚本只跑自己的（app.js 无 eval / 无内联事件属性）
   - style-src 'self' 'unsafe-inline'：前端有较多内联 style="" 属性，放行内联样式
   - img-src 'self' data: blob:：头像/配图走同源，另有 data-URI 背景与 blob 预览
   - connect-src 'self'：只允许请求自己的接口（防被脚本外传数据）
   - frame-ancestors 'none'：禁止被任何站点用 iframe 嵌套（防点击劫持） */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

/* 一套通用安全头。x-forwarded-proto 用来判断是否在 HTTPS 后面，决定要不要发 HSTS。 */
function securityHeaders(req, extra) {
  const h = Object.assign({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Flash/PDF 之类插件不许跨域加载本站资源
    'X-Permitted-Cross-Domain-Policies': 'none',
    // 别让浏览器替我们预解析/预连接（减少信息外泄与无谓请求）
    'X-DNS-Prefetch-Control': 'off',
    // 把本站放进独立的 agent cluster，隔绝跟其他站点共享进程侧信道
    'Origin-Agent-Cluster': '?1',
    // 不让搜索引擎收录 / 不让爬虫把页面索引进索引
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet'
  }, extra || {});
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto === 'https' || req.socket.encrypted) {
    h['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  }
  return h;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, securityHeaders(res._req, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }));
  res.end(body);
}

/* 请求体「空闲」超时：只要连续 15s 没有新字节就断开。
   server.requestTimeout 只限制总时长（120s），攻击者每 10 秒挤一个字节，
   就能把连接占满 2 分钟 —— 几百条这样的连接足以让新用户连不上。
   注意是「空闲」而不是「总时长」：正常上传 5MB 图片可能慢，但只要在传就不打断。 */
const BODY_IDLE_MS = 15 * 1000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let len = 0;
    let over = false;
    let settled = false;
    let idle = null;
    const chunks = [];

    const stop = (fn, v) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      fn(v);
    };
    const arm = () => {
      if (settled) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        const err = new Error('请求传得太慢，已断开，请重试');
        err.status = 408;
        stop(reject, err);
        // 先把 408 回出去，再收连接：立刻 destroy 的话客户端只能看到「连接被重置」
        setTimeout(() => { if (!req.destroyed) req.destroy(); }, 500).unref();
      }, BODY_IDLE_MS);
      if (idle.unref) idle.unref();
    };
    arm();

    req.on('data', (c) => {
      if (settled || over) return;          // 已超限：后面的字节直接丢弃，别继续吃内存
      len += c.length;
      if (len > MAX_BODY) {
        over = true;
        // 以前是 req.destroy()，客户端只会看到「连接被重置 / 网络失败」；
        // 现在抛一个带状态码的错误，由外层回 413，用户能看懂发生了什么。
        const err = new Error('请求体太大了');
        err.status = 413;
        stop(reject, err);
        return;
      }
      chunks.push(c);
      arm();
    });
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return stop(resolve, {});
      try { stop(resolve, JSON.parse(raw)); }
      catch (e) {
        const err = new Error('JSON 格式错误');
        err.status = 400;
        stop(reject, err);
      }
    });
    req.on('error', (e) => stop(reject, e));
    req.on('close', () => {
      // 客户端中途拔线：别让 Promise 永远挂着（每个挂住的请求都是一份泄漏）
      if (!settled) stop(reject, Object.assign(new Error('连接已断开'), { status: 499 }));
    });
  });
}

/** 简单滑动窗口限流 */
const buckets = new Map();
/* 限流表本身也是内存。key 里带 IP，被大量不同来源刷时会一直长 ——
   主表封顶 3 万条（约几 MB），满了先清过期，再丢最早的一批。
   丢掉的后果只是「某个 key 的计数归零」，比 OOM 打挂进程划算得多。 */
const BUCKET_MAX = 30000;
const LOGIN_FAILS_MAX = 5000;

function sweepBuckets(now) {
  for (const [k, b] of buckets) if (now - b.start > 10 * 60000) buckets.delete(k);
}

function rateLimit(key, max, windowMs) {
  const now = nowMs();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    if (!buckets.has(key) && buckets.size >= BUCKET_MAX) {
      sweepBuckets(now);
      if (buckets.size >= BUCKET_MAX) {
        let drop = Math.ceil(BUCKET_MAX / 4);
        for (const k of buckets.keys()) {
          if (drop-- <= 0) break;
          buckets.delete(k);
        }
      }
    }
    b = { start: now, n: 0 };
    buckets.set(key, b);
  }
  b.n += 1;
  return b.n <= max;
}
setInterval(() => {
  const now = nowMs();
  sweepBuckets(now);
  // 登录失败表也要收：攻击者能造出无数「IP+用户ID」组合把它撑大。
  // 但必须留够一个计数窗口（1 小时）—— 清得太快等于帮攻击者把失败次数归零。
  for (const [k, r] of loginFails) {
    const expired = r.until && now > r.until;
    const stale = !r.until && now - (r.first || 0) > 60 * 60000;
    if (expired || stale) loginFails.delete(k);
  }
  if (loginFails.size > LOGIN_FAILS_MAX) {
    let drop = loginFails.size - LOGIN_FAILS_MAX;
    for (const k of loginFails.keys()) {
      if (drop-- <= 0) break;
      loginFails.delete(k);
    }
  }
}, 5 * 60000).unref();

/* 账号级失败锁定：防止有人换 IP / 批量撞库去猜某个账号的密码。
   连续失败累计到上限就锁一段时间，成功登录清零。 */
const LOGIN_FAIL_MAX = 8;
const LOGIN_LOCK_MS = 10 * 60000;
const loginFails = new Map(); // username(lower) -> { n, until }
function loginLocked(username) {
  const rec = loginFails.get(username);
  if (!rec) return false;
  if (rec.until && nowMs() < rec.until) return true;
  if (rec.until && nowMs() >= rec.until) { loginFails.delete(username); return false; }
  return false;
}
function loginFail(key) {
  const rec = loginFails.get(key) || { n: 0, until: 0, first: nowMs() };
  rec.n += 1;
  if (rec.n >= LOGIN_FAIL_MAX) rec.until = nowMs() + LOGIN_LOCK_MS;
  loginFails.set(key, rec);
}
function loginOk(key) { loginFails.delete(key); }

/* 取客户端 IP。
   注意：XFF 最左边那一段是**客户端可伪造**的（攻击者随便填就能绕限流），
   只有最右边、由我们前方那层反向代理追加的那段才可信。所以这里取 XFF 的**最后一段**。
   没有 XFF 时退回到 socket 地址。
   另：直连部署（前面没有反代）时 XFF 完全不可信，用 FQ_TRUST_PROXY=0 关掉。 */
const TRUST_PROXY = String(process.env.FQ_TRUST_PROXY || '1') !== '0';

/** 把 ::ffff:1.2.3.4 归一成 1.2.3.4 —— 否则同一个地址会算出两个限流 key */
function normalizeIp(s) {
  const v = String(s || '').trim();
  return v.replace(/^::ffff:/i, '').toLowerCase() || 'unknown';
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '');
    if (xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return normalizeIp(parts[parts.length - 1]);
    }
  }
  return normalizeIp((req.socket && req.socket.remoteAddress) || 'unknown');
}

/* 会话令牌要不要在响应体里再回一份：
   浏览器（同源 XHR/fetch 的 POST 一定带 Origin）→ 不给，只走 HttpOnly Cookie。
   这样即便将来前端误存 localStorage，一次 XSS 也偷不到「可长期使用的明文令牌」——
   红队报告 P5 说的就是这个折扣。
   脚本 / 原生客户端（不带 Origin）→ 给，它们本来也没有 Cookie 罐。 */
function bodyToken(req, token) {
  const origin = String((req && req.headers && req.headers.origin) || '');
  return origin ? undefined : token;
}

function clean(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max || 4000);
}/* 短哈希：只用来做缓存 key（同一段正文 = 同一个 key），不做安全用途 */
function hashStr(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);
}

function findUserByName(name) {
  const n = String(name || '').toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === n) || null;
}

/* ------------------------------------------------------------------ */
/* AI 小饭：发帖助手                                                     */
/*                                                                     */
/* 这里只有一件事：把作者写好的草稿润色，绝不替他创作。                    */
/* 1) 配了 FQ_AI_KEY（OpenAI 兼容）或本机 Ollama → 模型润色 + aiPolishCheck */
/*    逐项验货，多一个数字/食材就退回重写；                              */
/* 2) 没模型或模型不老实 → aiPolishLocal：只改标点断句分段，不可能编内容。 */
/* ------------------------------------------------------------------ */

const AI_DAILY_LIMIT = 30;          // 每人每天 30 次，够玩，也防刷
const AI_CACHE_MAX = 300;
const aiCache = new Map();          // 文本|seed -> 结果，重复点不再算钱

/* 食材同义词：只收不会误伤的写法（别加裸「蛋」，否则蛋糕也会命中鸡蛋） */
const AI_SYN = {
  '鸡蛋': ['鸡蛋', '蛋液', '蛋花', '土鸡蛋', '鸡蛋液'],
  '番茄': ['番茄', '西红柿'],
  '面条': ['面条', '挂面', '拉面', '手擀面', '拌面', '汤面', '炒面', '意面'],
  '米饭': ['米饭', '剩饭', '剩米饭', '隔夜饭'],
  '猪肉': ['猪肉', '里脊', '肉丝', '肉末', '肉片', '前腿肉'],
  '五花肉': ['五花肉', '带皮肉'],
  '牛肉': ['牛肉', '牛腩', '肥牛'],
  '牛腩': ['牛腩', '牛肋条'],
  '鸡翅': ['鸡翅', '翅中', '翅根'],
  '鸡肉': ['鸡肉', '鸡腿', '鸡胸', '鸡丁', '整鸡'],
  '排骨': ['排骨', '肋排', '小排'],
  '豆腐': ['豆腐', '嫩豆腐', '老豆腐', '内酯豆腐'],
  '土豆': ['土豆', '马铃薯', '洋芋'],
  '青椒': ['青椒', '尖椒', '螺丝椒'],
  '西兰花': ['西兰花', '西蓝花'],
  '包菜': ['包菜', '卷心菜', '圆白菜'],
  '虾': ['虾', '基围虾', '虾仁', '对虾'],
  '粉丝': ['粉丝', '龙口粉丝'],
  '香菇': ['香菇', '干香菇'],
  '青菜': ['青菜', '小白菜', '油菜', '菠菜', '生菜'],
  '茄子': ['茄子'],
  '黄瓜': ['黄瓜'],
  '冬瓜': ['冬瓜'],
  '紫菜': ['紫菜'],
  '燕麦': ['燕麦', '麦片'],
  '牛奶': ['牛奶', '酸奶'],
  '面包': ['面包', '吐司'],
  '年糕': ['年糕'],
  '韭菜': ['韭菜'],
  '面粉': ['面粉', '面团'],
  '花生': ['花生', '花生米'],
  '咖喱': ['咖喱'],
  '银耳': ['银耳'],
  '梨': ['梨', '雪梨'],
  '皮蛋': ['皮蛋', '松花蛋'],
  '蒜苔': ['蒜苔', '蒜薹']
};

/* ------------------------------------------------------------------ */
/* 润色的三条闸门                                                       */
/*                                                                     */
/* 这一版不再「替用户生成内容」，只做润色。原因：以前是菜谱库 + 关键词打分，*/
/* 用户写「番茄 鸡蛋」，吐出来的却是一份通用教程——食材、火候、用量全是编  */
/* 的，和作者想发的东西没关系，读着就假。现在作者的每个信息点都必须留着，  */
/* 只允许动语序、标点、分段和明显啰嗦的词。                              */
/*                                                                     */
/* 1) 提示词写死「不增不删不改」；                                       */
/* 2) 模型交稿后过 aiPolishCheck：多一个数字、多一样食材、多一句否定就退回；*/
/* 3) 两遍都不合格 → aiPolishLocal，它物理上只做排版，不可能编内容。      */
/* ------------------------------------------------------------------ */

const AI_POLISH_SYSTEM = [
  '你是「饭圈」美食社区的文字编辑。作者已经写好了草稿，你只负责润色，不负责创作。',
  '',
  '【铁律：内容一个字都不能改】',
  '1. 草稿里出现的食材、用量、时间、火候、步骤、味道、价格、地点、人物、评价、情绪，统统保留原样：不许加、不许删、不许改。',
  '2. 草稿没写的细节一律不补。不要替作者加配料、加口感、加比喻、加心理活动、加背景故事。',
  '3. 不许换菜。作者写什么菜就是什么菜，别换成你更熟的同类菜；也别把「有点咸」改成「咸淡刚好」。',
  '4. 不许把作者的判断反过来说。他说「不太成功」，你不能写成「意外好吃」。',
  '',
  '【你只做这些】',
  '- 理顺语序：把绕的、倒装的句子说顺。',
  '- 断句和分段：长句拆短，补足标点，让读起来有节奏。',
  '- 删赘词：口头禅（嗯、然后、就是、反正、真的、感觉）连用时去掉多余的。',
  '- 换更准的词：把含糊的说法说清楚，但意思和程度不能变。',
  '- 标题：从正文已有的信息里提炼一句，不超过 20 字，不加「标题：」。',
  '- 话题标签：只从正文出现过的词里挑 2-3 个，每个 2-5 个字。',
  '',
  '【体裁】',
  '- body 是润色后的正文，长度不超过原稿的 1.3 倍，可以分 1-3 段，段之间用 \\n\\n。',
  '- 保留作者的语气：他写得随意就还是随意，别写成广告文案、美食博主腔或散文。',
  '- 不要 emoji，不要列表符号，不要「总之」「希望对你有帮助」这类收尾，不提 AI。',
  '',
  '【润色的力度】',
  '允许换句式、调语序、合并啰嗦的表达——事实层不动，表达层要有明显提升。只改标点不算润色。',
  '如果原稿本来就利落，保持原样是对的，不要为了改而改。',
  '',
  '示例一',
  '草稿：今天做了可乐鸡翅，还不错，就是有点甜，下次少放点可乐',
  '输出：{"title":"可乐鸡翅，甜了一点","body":"今天的可乐鸡翅还算成功，就是甜了些，下次少倒点可乐。","tags":["可乐鸡翅","家常菜"]}',
  '',
  '示例二',
  '草稿：戚风烤了40分钟中间还是塌了可能是蛋白没打好而且我忘了预热烤箱',
  '输出：{"title":"戚风又塌了，问题在蛋白","body":"戚风烤了 40 分钟，中间还是塌了。大概是蛋白没打好，再加上忘了预热烤箱。","tags":["戚风","烘焙"]}',
  '',
  '示例三',
  '草稿：嗯然后就是那个番茄炒蛋真的超级好吃，我放了两勺糖',
  '输出：{"title":"两勺糖的番茄炒蛋","body":"番茄炒蛋真的好吃，我放了两勺糖。","tags":["番茄炒蛋","家常菜"]}',
  '',
  '只输出 JSON：{"title":"...","body":"...","tags":["..."]}'
].join('\n');

function aiHasIng(text, name) {
  const list = AI_SYN[name] || [name];
  return list.some((w) => text.includes(w));
}

/* 数字归一：3、三、十、十五、1.5 都换成可比较的字面量。
   润色最容易翻车的就是这里——原文「烤 40 分钟」被写成「烤 30 分钟」。 */
const AI_CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function aiCnToNum(s) {
  if (!s) return null;
  if (s === '十') return 10;
  if (s.length === 1) return AI_CN_DIGIT[s] == null ? null : AI_CN_DIGIT[s];
  if (s.length === 2 && s[0] === '十') {
    const b = AI_CN_DIGIT[s[1]];
    return b == null ? null : 10 + b;
  }
  if (s.length <= 3 && s[1] === '十') {
    const a = AI_CN_DIGIT[s[0]];
    const b = s.length === 3 ? AI_CN_DIGIT[s[2]] : 0;
    return a == null || b == null ? null : a * 10 + b;
  }
  return null;
}

/* 中文数字只有后面跟着量词才算「数字」，否则「一点」「一下」「一起」「两下」
   全是误伤——第一版就是这么把好稿退回的。 */
const AI_NUM_WORD = '分钟|小时|秒钟|秒|分钟|天|克|毫升|升|度|成|个|勺|碗|斤|两|片|块|条|根|颗|张|层|寸|人|次|分|档|周|月|年|岁|杯|把|滴';

/* 数字校验用的「信息量数字」集合。
   1 一律不算：「一碗面」「一点盐」「一起」里的「一」是冠词不是用量，
   算进去会把「下了碗面」→「深夜一碗面」这种纯修辞判成偷加数字。
   跳过 1 不会漏检：改大 → 输出多出那个数被抓；改小 → 原文的数在输出里找不到被抓。 */
function aiNums(s) {
  const set = new Set();
  const t = String(s || '');
  t.replace(/\d+(?:\.\d+)?/g, (m) => {
    const v = Number(m);
    if (v !== 1) set.add(String(v));
    return m;
  });
  // 中文数字要带量词
  t.replace(new RegExp('([零一二两三四五六七八九十]+)\\s*(?=' + AI_NUM_WORD + ')', 'g'), (m, g) => {
    const v = aiCnToNum(g);
    if (v != null && v !== 1) set.add(String(v));
    return m;
  });
  return set;
}

const AI_NEG_RE = /[不没别勿未甭]/;

/* 调味料也得守：作者没写「蒜末」，就不能替他加。只收常见、不会误伤的写法。 */
const AI_SEASONINGS = {
  '盐': ['盐'], '糖': ['糖'], '生抽': ['生抽'], '老抽': ['老抽'], '酱油': ['酱油'],
  '蚝油': ['蚝油'], '料酒': ['料酒'], '醋': ['醋'], '蒜': ['蒜'], '姜': ['姜'], '葱': ['葱花', '小葱', '大葱'],
  '辣椒': ['辣椒', '小米辣'], '胡椒': ['胡椒'], '淀粉': ['淀粉', '生粉'],
  '花椒': ['花椒'], '八角': ['八角'], '香油': ['香油', '芝麻油'], '芝麻': ['芝麻'],
  '孜然': ['孜然'], '蜂蜜': ['蜂蜜'], '黄油': ['黄油'], '芝士': ['芝士', '奶酪'],
  '奶油': ['淡奶油', '奶油'], '味精': ['鸡精', '味精'], '豆瓣酱': ['豆瓣酱'],
  '番茄酱': ['番茄酱', '番茄膏'], '酵母': ['酵母'], '泡打粉': ['泡打粉']
};

/* 交稿检查：把模型偷偷加/删的东西揪出来。返回空数组才算合格。 */
function aiPolishCheck(src, out) {
  const a = String(src || '');
  const b = String((out && out.title) || '') + ' ' + String((out && out.body) || '');
  const bad = [];
  const na = aiNums(a);
  const nb = aiNums(b);
  nb.forEach((n) => { if (!na.has(n)) bad.push('多出数字「' + n + '」'); });
  na.forEach((n) => { if (!nb.has(n)) bad.push('漏掉数字「' + n + '」'); });
  const groups = [AI_SYN, AI_SEASONINGS];
  groups.forEach((dict) => {
    Object.keys(dict).forEach((name) => {
      const has = (t) => (dict[name] || [name]).some((w) => t.includes(w));
      const inA = has(a);
      const inB = has(b);
      if (inA && !inB) bad.push('漏掉「' + name + '」');
      if (!inA && inB) bad.push('多出「' + name + '」');
    });
  });
  if (!AI_NEG_RE.test(a) && AI_NEG_RE.test(b)) bad.push('多出否定说法');
  return bad;
}

/* ---------------- 本地润色：只排版，不写字 ---------------- */

const AI_LINE_MAX = 30;            // 一句超过这么多字就在逗号处断开
const AI_VERB_RE = '炒|蒸|煮|焖|烤|烧|炖|煎|拌|炸|卤|爆|炝|烩|熬|汆|涮|凉拌';
/* 只剥「我 / 做了」这种废话开头。时间词（今天、昨晚）是信息，留着。 */
const AI_LEAD_RE = /^(?:我|我们|自己|在家|一个人)\s*(?:做了个|做了一份|做了一锅|做了|弄了|炒了|煮了|烤了|炖了|煎了|拌了|试了|挑战了|安排了|搞了|吃了|吃到了|做|弄|炒|煮|烤|试)?\s*/;

const AI_SCENES = [
  ['减脂餐', /减脂|低卡|低脂|轻食|健身|控糖/],
  ['早餐', /早餐|早饭|早上吃|早点/],
  ['夜宵', /夜宵|宵夜|深夜|半夜吃/],
  ['下饭菜', /下饭|拌饭|配饭|盖饭/],
  ['快手菜', /十分钟|半小时|快手|简单|随便做|懒人/],
  ['汤羹', /汤|羹/],
  ['烘焙', /烤|烘焙|戚风|蛋糕|面包|吐司|饼干/],
  ['甜品', /甜点|甜品|糖水|布丁|冰淇淋|冰激凌|慕斯|蛋挞/],
  ['凉菜', /凉拌|冰镇|冷盘/],
  ['面食', /面条|面食|挂面|拉面|饺子|包子|馒头/]
];

/* 句首口头禅：「嗯然后就是那个番茄炒蛋」→「番茄炒蛋」。
   「然后」「就是」单独出现时可能是真的先后顺序（然后加盐），只在它后面紧跟
   另一个口头语时才删，别把顺序词当垃圾扔掉。 */
function aiStripFillers(t) {
  let prev;
  let n = 0;
  do {
    prev = t;
    t = t.replace(/(^|[。！？\n])\s*(?:嗯+|呃+|额+|em+|那个|内个|就是说|怎么说呢|说实话|讲真|有一说一|反正|嘛)[，,、\s]*/gi, '$1');
    t = t.replace(/(^|[。！？\n])\s*(?:然后|就是|其实)\s*(?=嗯|呃|那个|内个|就是|然后|其实|反正|说|怎么|嘛)/gi, '$1');
    n++;
  } while (t !== prev && n < 6);
  return t;
}

/* 标点归一 + 去复读 + 去句首口头禅。这里一个字都不增删内容。 */
function aiTidy(raw) {
  let t = String(raw || '').replace(/\r/g, '');
  t = t.replace(/[ \t\u3000]+/g, ' ').trim();
  t = t.replace(/([，。！？；：、])\1+/g, '$1');
  t = t.replace(/!{2,}/g, '！').replace(/\?{2,}/g, '？');
  // 中文语境里的半角标点（前后是汉字才换，英文/数字里不动）
  t = t.replace(/([\u4e00-\u9fa5])\s*,\s*/g, '$1，')
    .replace(/([\u4e00-\u9fa5])\s*;\s*/g, '$1；')
    .replace(/([\u4e00-\u9fa5])\s*:\s*/g, '$1：')
    .replace(/([\u4e00-\u9fa5])\s*!\s*/g, '$1！')
    .replace(/([\u4e00-\u9fa5])\s*\?\s*/g, '$1？')
    .replace(/([\u4e00-\u9fa5])\s*\.\s*(?=[\u4e00-\u9fa5]|$)/g, '$1。');
  // 「然后然后」「就是就是」这类复读压成一个；程度上叠词（超级超级）同理
  t = t.replace(/(然后|就是|而且|但是|所以|因为|真的|感觉|其实|基本)\1+/g, '$1');
  t = t.replace(/(超级|非常|特别|十分|实在|极其|贼|巨)\1+/g, '$1');
  // 中文和数字之间留一个空格，读起来不挤；标点只动排版，不动字
  t = t.replace(/([\u4e00-\u9fa5])(\d)/g, '$1 $2').replace(/(\d)([\u4e00-\u9fa5])/g, '$1 $2');
  t = aiStripFillers(t);
  // 连续换行压成一个空行
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

const aiBare = (x) => x.replace(/[，。！？；：、\s]/g, '').length;

/* 按句号切成句子，过长的句子在逗号处断开（逗号换句号，不改字） */
function aiLines(t) {
  const out = [];
  const sents = t.split(/(?<=[。！？；\n])/).map((x) => x.trim()).filter(Boolean);
  for (const sent of sents) {
    if (aiBare(sent) <= AI_LINE_MAX) { out.push(sent); continue; }
    const parts = sent.split(/(?<=[，；：])/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) { out.push(sent); continue; }
    let cur = '';
    for (const p of parts) {
      if (cur && aiBare(cur + p) > AI_LINE_MAX) {
        out.push(cur.replace(/[，；：]$/, '。'));
        cur = p;
      } else {
        cur += p;
      }
    }
    if (cur) out.push(cur);
  }
  return out.map((x) => (/[。！？]$/.test(x) ? x : x + '。')).filter((x) => aiBare(x) > 0);
}

/* 两三句一段，读起来不闷 */
function aiParagraphs(lines) {
  const paras = [];
  let cur = [];
  let n = 0;
  for (const ln of lines) {
    cur.push(ln);
    n += aiBare(ln);
    if (cur.length >= 2 && n >= 28) { paras.push(cur.join('')); cur = []; n = 0; }
  }
  if (cur.length) paras.push(cur.join(''));
  return paras;
}

/* 从原文里找「食材 + 做法」当菜名；找不到就退回首句 */
function aiDishName(t) {
  for (const name of Object.keys(AI_SYN)) {
    for (const w of AI_SYN[name]) {
      const m = new RegExp(w + '\\s*(' + AI_VERB_RE + ')\\s*([\\u4e00-\\u9fa5]{0,3})').exec(t);
      if (m) return (w + m[1] + (m[2] || '')).replace(/的$/, '').slice(0, 14);
    }
  }
  return '';
}

function aiTitleOf(t) {
  const dish = aiDishName(t);
  if (dish.length >= 3) return dish;
  const first = (t.split(/[。！？；\n]/)[0] || t).replace(/[，。！？；：、\s]+$/, '');
  const cut = (first.replace(AI_LEAD_RE, '').trim() || first).replace(/[，。！？；：、\s]+$/, '');
  // 短句直接当标题，别拼成一长串没有标点的东西
  if (cut.length <= 16) return cut;
  const clauses = cut.split(/[，、]/).filter(Boolean).slice(0, 2);
  const joined = clauses.join('，');
  if (joined.length <= 20) return joined;
  return (clauses[0] || cut).slice(0, 20).replace(/[，。！？；：、\s]+$/, '');
}

/* 标签只从原文里取词：食材 + 原文说到的场景，不硬凑 */
function aiTagsOf(t) {
  const tags = [];
  const dish = aiDishName(t);
  if (dish && dish.length <= 6) tags.push(dish);
  Object.keys(AI_SYN).forEach((name) => {
    if (tags.length < 2 && aiHasIng(t, name) && !tags.includes(name)) tags.push(name);
  });
  for (const pair of AI_SCENES) {
    if (tags.length >= 3) break;
    if (pair[1].test(t) && !tags.includes(pair[0])) tags.push(pair[0]);
  }
  if (tags.length < 2 && !tags.includes('家常菜')) tags.push('家常菜');
  return tags.slice(0, 3);
}

/* 没有模型时的兜底：把作者的话理顺、断句、分段。
   这里只调用标点和字符串操作，物理上不可能编出原文没有的内容。 */
function aiPolishLocal(raw) {
  const tidy = aiTidy(raw);
  if (!tidy) return null;
  const title = aiTitleOf(tidy);
  const body = aiParagraphs(aiLines(tidy)).join('\n\n').slice(0, 2200);
  const tags = aiTagsOf(tidy);
  if (!body) return null;
  const content = title + '\n\n' + body + '\n\n' + tags.map((x) => '#' + x + '#').join(' ');
  return { title, dish: title, body, tags, text: content, provider: 'local' };
}

/* 模型吐出来的东西不一定干净：可能带 ```json 包裹、可能前后多一句话。
   这里统一抽成 { title, body, tags }，抽不出来就返回 null，让上层换引擎。 */
function aiShape(raw, provider) {
  let obj = null;
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  try { obj = JSON.parse(s); } catch (e) {
    const m = /{[\s\S]*}/.exec(s);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } }
  }
  if (!obj) return null;
  const title = clean(obj.title, 40);
  const body = clean(obj.body, 2200);
  if (!title || !body) return null;
  let tags = Array.isArray(obj.tags) ? obj.tags : [];
  tags = tags.map((t) => clean(t, 12).replace(/^#+|#+$/g, '')).filter(Boolean).slice(0, 3);
  if (!tags.length) tags = ['家常菜'];
  const content = title + '\n\n' + body + '\n\n' + tags.map((t) => '#' + t + '#').join(' ');
  return { title, dish: title, body, tags, text: content, provider };
}

/* 通义千问（qwen3 系列）默认会先「想一遍」再回答，思考 token 会把额度吃光。
   实测同一句：开思考 8.3 秒 / 462 token，关掉 0.5 秒 / 54 token。
   百炼兼容模式认 enable_thinking:false；别家不认这个字段，所以只对通义系默认关，
   想强行开/关就用 FQ_AI_THINKING=on|off。 */
function aiNoThink(base) {
  const v = String(process.env.FQ_AI_THINKING || '').toLowerCase();
  if (['off', 'false', '0', 'no'].includes(v)) return true;
  if (['on', 'true', '1', 'yes'].includes(v)) return false;
  return /aliyuncs\.com|dashscope/.test(String(base || ''));
}

function aiCloudBody(base, body) {
  return aiNoThink(base) ? Object.assign({ enable_thinking: false }, body) : body;
}

/* 先让模型润色，再由代码验货。
   云端 key 和本机 Ollama 的先后顺序在 aiRaw() 里已经排好了（云 → 本机），
   这里只负责提示词、交稿检查和「不合格退回重写」。 */
async function aiComposeByModel(text, seed) {
  const ask = '作者的草稿（只润色，内容一个字都不能改）：\n"""\n' + text + '\n"""\n\n' +
    (seed ? '换一种说法再润一遍，信息点必须和草稿完全一致。' : '请按规则润色。');
  // 输出上限跟着草稿长度走：长帖子给得太少会被截成半截 JSON，白花一次钱
  const maxTokens = Math.min(2400, 400 + Math.round(text.length * 1.2));
  const first = await aiRaw(AI_POLISH_SYSTEM, ask, { maxTokens, temperature: seed ? 0.72 : 0.5 });
  if (!first) return null;
  let out = aiShape(first.raw, first.provider);
  if (!out) return null;

  let bad = aiPolishCheck(text, out);
  if (!bad.length) return out;

  // 超范围就点名退回，让它自己把多出来的删掉；第二遍还不老实就交给本地，宁可朴素也不编
  console.log('  ✎  润色超范围，退回重写：' + bad.slice(0, 4).join('、'));
  const fix = ask + '\n\n上一版违反了铁律：' + bad.slice(0, 5).join('；') +
    '。重写一版，只能出现草稿里已有的信息和数字，一个字都不许多。';
  const second = await aiRaw(AI_POLISH_SYSTEM, fix, { maxTokens, temperature: 0.25 });
  out = second ? aiShape(second.raw, second.provider) : null;
  if (!out) return null;
  bad = aiPolishCheck(text, out);
  if (bad.length) {
    console.log('  ✎  两遍都不合格，交给调用方回话：' + bad.slice(0, 3).join('、'));
    aiLastReason = 'shape';
    return null;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 本机模型（Ollama）                                                   */
/*                                                                     */
/* **仅开发测试用**：本地跑一个小模型，断网也能调通提示词和形状解析。     */
/* 线上不启用（`aiLocalAllowed()` 默认 false），接口直接回「维护中」。     */
/* ------------------------------------------------------------------ */

const AI_OLLAMA_URL = String(process.env.FQ_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const AI_OLLAMA_MODEL = process.env.FQ_OLLAMA_MODEL || '';
const AI_OLLAMA_TIMEOUT = Number(process.env.FQ_AI_TIMEOUT) || 90000;   // 冷启动要加载权重，放宽

let aiOllama = { at: 0, model: '' };   // 缓存探测结果，60 秒内不重复问

/* 问一次 /api/tags 看本机有没有装模型；没装或不通就返回空串 */
async function aiOllamaModel() {
  const t = Date.now();
  if (t - aiOllama.at < 60000) return aiOllama.model;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1200);
  try {
    const r = await fetch(AI_OLLAMA_URL + '/api/tags', { signal: ctl.signal });
    if (!r.ok) throw new Error('bad');
    const j = await r.json();
    const list = (j && j.models) || [];
    let name = AI_OLLAMA_MODEL;
    if (!name) name = list.length ? list[0].name : '';
    aiOllama = { at: Date.now(), model: name };
    return name;
  } catch (e) {
    aiOllama = { at: Date.now(), model: '' };
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/* 启动后偷偷跑一句话，把权重加载进内存：
   否则用户第一次点「AI 润色」要等 50~60 秒（冷启动），热了才 3~8 秒。 */
function aiWarmup() {
  // 线上不跑本机模型（只认云端），预热只在开发测试时做
  if (!aiLocalAllowed()) return;
  // 配了云端 key 就直接走云端，不用再拉本机模型占内存
  if (process.env.FQ_AI_KEY || process.env.AI_API_KEY) return;
  aiOllamaModel().then((model) => {
    if (!model) return;
    console.log('  🤖  本机模型 ' + model + '，正在预热…');
    aiComposeByModel('今天做了番茄炒蛋，鸡蛋有点老，下次火小一点。', 0)
      .then((r) => console.log(r ? '  🤖  本机模型已就绪（' + r.title + '）' : '  🤖  本机模型预热失败，将用本地润色'));
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* AI 做饭模式 / 厨房急诊                                                */
/*                                                                     */
/* 和发帖助手共用同一套引擎（云端 key → 本机 Ollama → 本地兜底），       */
/* 只是提示词和输出形状不同。都走 aiRaw()，拿不到干净 JSON 就换下一级。  */
/* ------------------------------------------------------------------ */

const COOK_STEPS_LIMIT = 60;        // 拆步骤：登录用户 60 次/天（缓存命中不计数）
const COOK_HELP_LIMIT = 40;         // 急诊：40 次/天
const COOK_CACHE_MAX = 200;
const cookCache = new Map();        // 'p<帖子id>' / 'h<文本哈希>' -> 拆好的步骤

const COOK_SYSTEM = [
  '你是「饭圈」美食社区里的小饭，正在陪一个厨友站在灶台前做菜。',
  '根据下面这条帖子，把它拆成 4-6 个可以照着做的步骤。',
  '要求：',
  '1. 每步只做一件事，按真实操作顺序：先备料、再开火、最后出锅。',
  '2. t 是这一步的动作短句，6-12 个字，动词开头，例如「鸡翅两面划刀」。',
  '   t 只概括动作，不要在 t 里写火候、水温、时间这些容易和 d 矛盾的细节。',
  '3. d 是具体做法，30-60 字，写清火候、时间和判断标准，例如「中火煎到边缘金黄」。',
  '   d 必须和 t 说的是同一件事：不能标题说冷水下锅、正文写沸水下锅。',
  '4. w 是一句「为什么」或最容易翻车的地方，20-35 字；确实没有就给空字符串。',
  '5. timer 只在需要计时等待的步骤填，单位是秒：焖 8 分钟 = 480，否则填 0。',
  '6. 帖子里没写的用量按家常做法补全，但不要编出帖子里没有的主料。',
  '只说人话，不提 AI，不用 emoji。',
  '只输出 JSON：{"dish":"菜名","steps":[{"t":"","d":"","w":"","timer":0}]}'
].join('\n');

const COOK_HELP_SYSTEM = [
  '你是「饭圈」美食社区里的小饭，一个正在厨房里帮厨友救场的老师傅。',
  '用户做某道菜时卡住了，会问你一句。下面给你这道菜的做法和 TA 正做到的那一步。',
  '要求：',
  '1. 先用一句话判断最可能的原因（不确定就说「多半是」），不要一上来堆一堆方案。',
  '2. 再给 1-2 句马上能做的补救，量要具体：几勺、几分钟、大火还是小火。',
  '3. 真救不回来就直接说还能怎么吃、下次怎么避免，不要硬说能救。',
  '4. 口语，像站在旁边说话，80 字以内，不用 emoji，不用列表。',
  '只输出 JSON：{"answer":"..."}'
].join('\n');

/* 通用调用：先云端；返回 { raw, provider } 或 null。
   本机 Ollama 只有 FQ_AI_ALLOW_LOCAL=1（开发测试）时才会被当成第二级。
   steps / help 需要不同的提示词，所以不复用写死提示词的 aiComposeModel。 */
/* ------------------------------------------------------------------ */
/* 线上只用云端：模型拿不到就直说「维护中」                              */
/*                                                                     */
/* 本项目**不做线上本地兜底**。本机 Ollama 与规则模板保留下来只用于开发   */
/* 期离线测试，用 FQ_AI_ALLOW_LOCAL=1 打开；线上默认关闭。               */
/* 理由很简单：与其偷偷拿模板糊一段「看起来像 AI 写的」文字，不如明说现在  */
/* 用不了 —— 做菜的人需要的是可信建议，不是占位内容。                     */
/* ------------------------------------------------------------------ */

let aiLastReason = '';   // budget | cloud | nokey | shape

function aiLocalAllowed() {
  const v = String(process.env.FQ_AI_ALLOW_LOCAL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function aiCloudKey() {
  return process.env.FQ_AI_KEY || process.env.AI_API_KEY || '';
}

/* 云端熔断：连续失败 3 次就关闸 60 秒。
   没有这道闸，云端真挂的时候每个用户都得等满 25 秒超时才知道用不了。 */
let aiBreak = { fails: 0, until: 0 };
const AI_BREAK_AFTER = 3;
const AI_BREAK_MS = 60 * 1000;

function aiBreakerOpen() { return aiBreak.until > Date.now(); }
function aiCloudOk() { aiBreak.fails = 0; aiBreak.until = 0; }
function aiCloudFail() {
  aiBreak.fails += 1;
  if (aiBreak.fails >= AI_BREAK_AFTER) {
    aiBreak.until = Date.now() + AI_BREAK_MS;
    aiBreak.fails = 0;
    console.log('[ai] 云端连续失败，暂停 ' + (AI_BREAK_MS / 1000) + ' 秒后重试');
  }
}

/* 只读判断「今天总额度是不是已经烧完」，不计数 */
function aiBudgetSpent() {
  return aiDay === new Date().toISOString().slice(0, 10) && aiDayCount >= AI_GLOBAL_DAILY;
}

/* 现在立刻就能断定用不了吗？能的话接口直接回话，不消耗用户每日次数，也不用等超时 */
function aiUnavailableNow() {
  if (aiLocalAllowed()) return false;
  if (!aiCloudKey()) return true;
  return aiBreakerOpen() || aiBudgetSpent();
}

/* 统一应答：503 + code，前端把 error 原样显示给用户 */
function aiDown(res) {
  const table = {
    budget: ['今天的 AI 额度用完了，明天再来', 'AI_BUDGET'],
    shape: ['AI 这次没给出合格的稿子，直接发原文也完全没问题', 'AI_UNUSABLE']
  };
  const hit = table[aiLastReason] || ['AI 正在维护，稍后再试', 'AI_MAINTENANCE'];
  return json(res, 503, { error: hit[0], code: hit[1] });
}

/* 接口入口用：命中维护状态就先回话，别让它白白消耗限流次数 */
function aiGuard(res) {
  if (!aiUnavailableNow()) return false;
  aiLastReason = aiBudgetSpent() ? 'budget' : 'cloud';
  aiDown(res);
  return true;
}

/* ------------------------------------------------------------------ */
/* AI 额度保险丝                                                        */
/*                                                                     */
/* 三层限流：单用户/天（上面那套）→ 单 IP/天 → **全站/天总量**。          */
/* 前两层都靠 IP，而 IP 可以伪造 XFF 换 key 绕过（自测里已经绕过成功）。   */
/* 所以最里面再加一道跟 IP 无关的总闸：超了就静默降级成本地模板，          */
/* 用户照样拿到步骤，只是标注「按家常做法补的」，云额度不会被一夜烧光。      */
/* 纯本地 Ollama 不花钱，不受此限。                                      */
/* ------------------------------------------------------------------ */

const AI_GLOBAL_DAILY = Math.max(50, Number(process.env.FQ_AI_DAILY_CAP || 1200));
let aiDay = '';
let aiDayCount = 0;

function aiBudgetOk() {
  // 没配云 key = 走本机 Ollama，不产生费用，不占额度
  if (!(process.env.FQ_AI_KEY || process.env.AI_API_KEY)) return true;
  const d = new Date().toISOString().slice(0, 10);
  if (d !== aiDay) { aiDay = d; aiDayCount = 0; }
  if (aiDayCount >= AI_GLOBAL_DAILY) { aiLastReason = 'budget'; return false; }
  aiDayCount++;
  return true;
}

async function aiRaw(system, user, opts) {
  const o = opts || {};
  const maxTokens = o.maxTokens || 500;
  const temperature = typeof o.temperature === 'number' ? o.temperature : 0.4;

  aiLastReason = '';

  // 额度保险丝：今天烧满了就直接返回 null
  if (!aiBudgetOk()) return null;

  // 1) 云端 / 自建网关（OpenAI 兼容）
  const key = aiCloudKey();
  if (!key) {
    aiLastReason = 'nokey';
  } else if (aiBreakerOpen()) {
    aiLastReason = 'cloud';                 // 已判定云端不可用，别再让用户等 25 秒
  } else {
    const base = String(process.env.FQ_AI_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const model = process.env.FQ_AI_MODEL || 'deepseek-chat';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(aiCloudBody(base, {
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        })),
        signal: ctl.signal
      });
      if (r.ok) {
        const j = await r.json();
        const msg = j && j.choices && j.choices[0] && j.choices[0].message;
        if (msg && msg.content) { aiCloudOk(); return { raw: msg.content, provider: 'model' }; }
        aiCloudFail();
        aiLastReason = 'shape';             // 通是通了，但没给内容
      } else {
        aiCloudFail();
        aiLastReason = 'cloud';
        console.log('[ai] 云端返回 ' + r.status + '，' + (r.status === 403 ? '多半是额度用完' : '稍后重试'));
      }
    } catch (e) {
      aiCloudFail();
      aiLastReason = 'cloud';
    } finally { clearTimeout(timer); }
  }

  /* 线上到此为止：拿不到云端结果就交给调用方回「维护中」。
     本机模型只在 FQ_AI_ALLOW_LOCAL=1（开发测试）时才会走到下面。 */
  if (!aiLocalAllowed()) return null;

  // 2) 本机 Ollama（原生接口，关思考 + 强制 JSON）
  const model = await aiOllamaModel();
  if (!model) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_OLLAMA_TIMEOUT);
  try {
    const r = await fetch(AI_OLLAMA_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: 'json',
        options: { temperature, num_predict: maxTokens },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const content = j && j.message ? j.message.content : '';
    return content ? { raw: content, provider: 'ollama' } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function aiJson(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(s); } catch (e) {
    const m = /{[\s\S]*}/.exec(s);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { return null; } }
  }
  return null;
}

/* 从一句话里读计时：「焖 8 分钟」→ 480 秒 */
function aiTimerOf(s) {
  const m = /(\d+(?:\.\d+)?)\s*(分钟|分|min|minutes?)/i.exec(String(s || ''));
  if (m) return Math.min(3600, Math.round(Number(m[1]) * 60));
  const s2 = /(\d+)\s*(秒|seconds?)/i.exec(String(s || ''));
  if (s2) return Math.min(3600, Number(s2[1]));
  return 0;
}

function aiStepsShape(obj) {
  if (!obj || !Array.isArray(obj.steps)) return null;
  const steps = [];
  for (const s of obj.steps.slice(0, 8)) {
    if (!s) continue;
    const d = clean(s.d || s.text || '', 220);
    const t = clean(s.t || s.title || '', 24);
    if (!d && !t) continue;
    steps.push({
      t: t || '第 ' + (steps.length + 1) + ' 步',
      d: d || t,
      w: clean(s.w || s.why || '', 120),
      timer: Math.max(0, Math.min(3600, Number(s.timer) || 0)) || aiTimerOf(d || t)
    });
  }
  if (steps.length < 2) return null;
  return {
    dish: clean(obj.dish || obj.title || '', 30) || '这道菜',
    steps: steps
  };
}

/* 本地兜底：按句子拆。模型不在线时（比如线上服务器）也要能用，
   宁可粗一点，也不能让「开始做」点下去是空的。
   注意：只挑「真的在做事」的句子 —— 帖子常见的开场感慨（今天终于做成功了）
   和 @某人 的回复都不是步骤，混进去会让人照着做时一头雾水。 */
const AI_ACTIONS = ['切', '洗', '放', '下', '炒', '煎', '煮', '焖', '烤', '蒸', '拌', '倒', '加',
  '撒', '淋', '捞', '腌', '打', '揉', '静置', '预热', '关火', '出锅', '盛', '翻', '炸', '烧',
  '炖', '泡', '剪', '剥', '刮', '剁', '焯', '调', '搅', '盖', '收汁', '装盘', '起锅', '码', '铺',
  '抹', '刷', '捏', '擀', '压', '戳', '包', '卷', '冻', '晾', '过水', '起锅'];
const AI_NOISE = /^(今天|昨天|最近|这次|第一次|第\s*\d|终于|真的|我觉得|你们|大家|有没有|到底|一个人)/;
/* 讨论句（到底放不放糖 / 你们家怎么做）不是步骤 */
const AI_CHAT = /(到底|放不放|要不要|是不是|你们家|我们家|有人知道|求问)/;

function aiActionSentences(body) {
  return String(body || '')
    .split(/[。！？!?；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 5 && s.length <= 120)
    .filter((s) => !/@[a-zA-Z0-9_]{2,}/.test(s))       // @某人 的回复
    .filter((s) => !AI_NOISE.test(s))                   // 开场感慨
    .filter((s) => !AI_CHAT.test(s))                    // 讨论 / 提问
    .filter((s) => AI_ACTIONS.some((v) => s.includes(v)));
}

/* 标签里这些是「分类」不是「菜名」，不能拿来当标题 */
const AI_GENERIC_TAGS = ['家常菜', '快手菜', '下饭菜', '一人食', '减脂餐', '减脂', '烘焙', '甜品',
  '早餐', '夜宵', '午饭', '晚饭', '凉菜', '面食', '宴客菜', '川菜', '粤菜', '湘菜', '汤',
  '下厨日常', '美食', '做饭', '素食'];

function aiDishName(text, first) {
  const f = String(first || '').trim();
  // 第一行本来就是短菜名（不含标点）就直接用
  if (f.length >= 2 && f.length <= 12 && !/[，,。！？!?、：:]/.test(f)) return f;
  // 否则看标签：#红烧肉# 这种通常就是菜名
  const tags = (String(text || '').match(/#([^#\n]{1,20})#/g) || [])
    .map((s) => s.replace(/#/g, '').trim())
    .filter((s) => s && !AI_GENERIC_TAGS.includes(s));
  if (tags.length) return tags[0].slice(0, 12);
  return '';
}

function aiStepsLocal(raw, title) {
  const all = String(raw || '').replace(/#[^#\n]{1,20}#/g, ' ');
  const lines = all.split('\n').map((s) => s.trim()).filter(Boolean);
  const first = lines[0] || '';
  const dish = clean(title || aiDishName(raw, first) || '这道菜', 30);

  let body = all.replace(/\s+/g, ' ').trim();
  if (dish && body.indexOf(dish) === 0) body = body.slice(dish.length).trim();

  let sents = aiActionSentences(body);
  // 一句话里塞了整道菜（用逗号断句）：按逗号拆，两小段并一步
  if (sents.length < 2) {
    const bits = body.split(/[，,、]/).map((s) => s.trim())
      .filter((s) => s.length >= 6 && AI_ACTIONS.some((v) => s.includes(v)));
    sents = [];
    for (let i = 0; i < bits.length; i += 2) sents.push(bits.slice(i, i + 2).join('，'));
  }
  while (sents.length > 6) {
    const merged = [];
    for (let i = 0; i < sents.length; i += 2) merged.push([sents[i], sents[i + 1]].filter(Boolean).join('，'));
    sents = merged;
  }
  // 少于 3 句就不硬拆了：1~2 句多半是「今天终于做成功了」这类感想，
  // 硬拆出来会出现「第 1 步：到底放不放糖」这种不像步骤的东西
  if (sents.length >= 3) {
    return {
      dish: dish,
      steps: sents.map((s, i) => ({
        t: '第 ' + (i + 1) + ' 步',
        d: s.length > 120 ? s.slice(0, 118) + '…' : s,
        w: '',
        timer: aiTimerOf(s)
      })),
      approx: false,
      provider: 'local'
    };
  }

  // 帖子只写了感受、没写做法：给一个通用但真能照着走的骨架，
  // 并标记 approx —— 前端会明说「这几步是按家常做法补的」，不装成原帖写的。
  // 烘焙和炒菜不是一回事，给戚风套「热锅下油」会闹笑话，所以按菜型分两套。
  const isBake = /(蛋糕|戚风|面包|吐司|饼干|曲奇|慕斯|布丁|蛋挞|挞|派|舒芙蕾|司康|玛芬|贝果|泡芙|烤箱)/.test(dish + ' ' + body);
  const steps = isBake
    ? [
        { t: '备料称量', d: '粉类先过筛，鸡蛋回温，糖和油按配方称好再动手。', w: '烘焙靠配比，随手倒最容易翻车。', timer: 0 },
        { t: '混合打发', d: '蛋白分三次加糖打到硬性发泡；蛋黄糊用翻拌，别画圈搅。', w: '画圈会把气泡搅没，烤完长不高。', timer: 0 },
        { t: '入模烘烤', d: '面糊倒进模具，端起来震两下消大气泡，放进提前预热好的烤箱中下层。', w: '没预热就进炉，表面先结皮、中间还是生的。', timer: 0 },
        { t: '冷却脱模', d: '出炉立刻倒扣，完全凉透再脱模。', w: '热的时候蛋糕还软，这会儿脱模十有八九会塌。', timer: 0 }
      ]
    : [
        { t: '把料备齐', d: '食材洗净切好，调料先摆到手边。下锅再找调料最容易糊锅。', w: '切得大小一致，熟得才均匀。', timer: 0 },
        { t: '热锅下油', d: '锅烧到微微冒烟再倒油，油热后下葱姜蒜这一类先爆香。', w: '锅不够热就下菜，容易粘锅出水。', timer: 0 },
        { t: '下主料翻炒', d: '主料下锅后先别急着翻，等一面定型再动，全程中大火。', w: '一直翻会让锅温掉下来，炒不出锅气。', timer: 0 },
        { t: '调味出锅', d: '沿着锅边淋生抽，加盐和一点糖，尝一口再决定要不要补。', w: '盐最后放，早放容易出水。', timer: 0 }
      ];

  return {
    dish: dish,
    steps: steps,
    approx: true,
    provider: 'local'
  };
}

/* 本机/线上都没有模型时的急诊回答：按最常见的翻车点给建议。
   不是模型，但都是真的能用的厨房经验。 */
const AI_FIXES = [
  { k: ['太咸', '咸了', '齁'], a: '别加水，加水就成汤了。先加半勺糖压一下咸味，再扔几块土豆或豆腐进去吸一吸；实在咸，就多加主食配着吃。下次盐分两次放，出锅前尝一口再补。' },
  { k: ['太淡', '没味', '不够味'], a: '多半是盐放晚了或者量不够。沿锅边淋半勺生抽（比直接撒盐香），再补一小撮盐，翻两下就关火。别一次倒多，淡了能加，咸了难救。' },
  { k: ['柴', '老', '嚼不动', '硬'], a: '多半是火太大或者时间长了，肉里的水跑掉了。先转小火，加两勺水盖盖焖 2 分钟；下次切好先用一点淀粉和油抓匀，热锅快炒，变色就出。' },
  { k: ['糊', '焦', '黑', '糊锅'], a: '马上关火，把没糊的部分换到另一个锅里，别在原来那口锅上继续刮。糊味轻的话加一点点糖和醋能压住；已经发苦就别救了，苦味去不掉。' },
  { k: ['粘锅', '巴锅', '粘住'], a: '先别硬铲，关小火，沿着锅边淋一勺水，盖盖焖 30 秒，让蒸汽把底部松开。下次记得锅烧热再下油，油热再下菜。' },
  { k: ['稀', '汁多', '汁太多', '汤太多', '收不干'], a: '把火开大，别盖盖，让水汽跑掉；想快一点就勾一点薄芡（一勺淀粉加三勺水）。注意咸度会随着收汁变高，尝一下再决定加不加盐。' },
  { k: ['不熟', '夹生', '生的', '没熟'], a: '加两勺水，盖盖转中小火焖 2-3 分钟。块大的先用筷子戳一下最厚的地方，能轻松戳透就是熟了。别用大火猛烧，外面糊了里面还是生的。' },
  { k: ['腥', '膻', '味道重'], a: '加两片姜、一勺料酒，沿锅边淋下去让酒气挥发；腥味重的话再加一段葱白。下次肉类先冷水下锅焯一下，撇掉浮沫再烧。' },
  { k: ['酸', '太酸'], a: '加半勺糖中和一下，再补一小撮盐——盐能把甜和酸拉回平衡。番茄太酸就多烧两分钟，酸味会柔下来。' },
  { k: ['苦', '发苦'], a: '苦味多半来自炒糊的香料、没焯水的苦瓜，或者烧焦的糖色。已经发苦很难去掉，加点糖和椰奶/牛奶能盖一部分；下次香料小火煸，别等冒黑烟。' },
  { k: ['干', '太干', '发干'], a: '加两三勺水或者高汤，盖盖小火焖 1 分钟，让食材回一下水。下次炒的时候油可以多一点点，出锅前再淋半勺。' },
  { k: ['颜色', '不好看', '发黑'], a: '多半是酱油放早了或者火太大。出锅前再淋生抽，颜色更亮；已经深了就少放老抽，撒点葱花和白芝麻提一下。' },
  { k: ['塌', '回缩', '缩了'], a: '如果是蛋糕：多半是打发不够或者出炉没倒扣，这次救不回来，下次蛋白打到硬性发泡、出炉立刻倒扣放凉。如果是炒菜缩水，是火太小出水了，大火快炒就好。' },
  { k: ['不够脆', '软了', '不酥'], a: '是水汽把它闷软了。把火开大再复炸/复煎 30 秒，出锅别盖盖、别堆在一起。下次出锅放在网架上，别放盘子里捂着。' },
  { k: ['太油', '腻'], a: '把菜先盛出来，锅里的油倒掉一部分，再把菜回锅翻两下；加一勺醋或一点柠檬汁能解腻。下次油按「润锅就行」的量放。' }
];

function aiHelpLocal(question, ctx) {
  const q = String(question || '');
  for (const f of AI_FIXES) {
    if (f.k.some((k) => q.includes(k))) {
      return { answer: f.a, provider: 'local' };
    }
  }
  const step = ctx && ctx.step ? '这一步（' + ctx.step + '）' : '这一步';
  return {
    answer: '先别急着加东西：看一眼火是不是太大了、锅里还有没有水。' + step +
      '出问题大多是火候和时间，转小火、加两勺水、盖盖焖一分钟，八成能救回来。实在不行就关火尝一口，再决定补盐还是补糖。',
    provider: 'local'
  };
}

/* ------------------------------------------------------------------ */
/* API 路由                                                             */
/* ------------------------------------------------------------------ */

/* ---------- 本站来源判定（CSRF 第二层用） ----------
   线上前面有网关（CloudStudio / EdgeOne），转发进来的 Host 会被改写成内部地址，
   拿它跟浏览器 Origin 里的 host 一比，连同源请求都会被判成跨站 —— 结果就是
   线上所有写操作（登录、发帖、改密）一律 403。所以判定顺序改成：
   1) Sec-Fetch-Site：现代浏览器（含 Android WebView）必带，且不受代理改写影响。
      cross-site 直接拒，same-origin / none 放行，same-site 放行但记日志。
   2) 没有这个头（老内核、curl、原生客户端）→ 比对 host 允许集合：
      Host、X-Forwarded-Host、X-Real-Host、X-Original-Host、FQ_SITE_HOSTS。
   3) 集合里只有内网/回环地址（说明确实在代理后面、又拿不到转发头）→ 判不了就
      放行，交给 Cookie 的 SameSite 与 JSON 格式这两层兜底，别把自家人拦在门外。
   4) 连 Origin 和 Referer 都没有 → 放行，交给鉴权兜底。 */

function hostSetOf(req) {
  const set = new Set();
  const add = (raw) => {
    String(raw || '').split(',').forEach((part) => {
      let h = part.trim().toLowerCase();
      if (!h) return;
      if (h.includes('://')) { try { h = new URL(h).host; } catch (e) { return; } }
      h = h.replace(/\.$/, '');
      set.add(h);
      set.add(h.replace(/:\d+$/, ''));
    });
  };
  add(req.headers.host);
  add(req.headers['x-forwarded-host']);
  add(req.headers['x-real-host']);
  add(req.headers['x-original-host']);
  add(process.env.FQ_SITE_HOSTS);
  for (const h of SITE_HOSTS_CFG) add(h);
  return set;
}

/* ============ 图形验证码（零依赖：手写 PNG + 5×7 点阵字体）============
   为什么自己画：项目不装任何三方包，也不想为一个验证码引 canvas。
   PNG 只要 zlib.deflate 加三个 chunk，几十行就够。
   为什么画成位图而不是 SVG：SVG 里如果用 <text> 写字符，谁看源码谁就拿到答案，
   等于没做验证码；画成像素点阵，源码里只剩一堆矩形坐标。 */

/* off   = 完全跳过校验（只给自动化测试用，见 tmp/*.mjs）
   debug = 正常校验，但接口额外回传答案（给无头浏览器测试用）
   两个都靠环境变量开，默认全关；.env 里刻意不写，免得部署时被一起传上去。 */
const CAPTCHA_MODE = String(process.env.FQ_CAPTCHA || '').trim().toLowerCase();
const CAPTCHA_ON = CAPTCHA_MODE !== 'off';

const CAPTCHA_FONT = {
  A: '01110/10001/10001/11111/10001/10001/10001',
  B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01111/10000/10000/10000/10000/10000/01111',
  D: '11110/10001/10001/10001/10001/10001/11110',
  E: '11111/10000/10000/11110/10000/10000/11111',
  F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01111/10000/10000/10111/10001/10001/01111',
  H: '10001/10001/10001/11111/10001/10001/10001',
  J: '00111/00010/00010/00010/00010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001',
  L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001',
  N: '10001/11001/10101/10011/10001/10001/10001',
  P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101',
  R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110',
  T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110',
  V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/11011/10001',
  X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100',
  Z: '11111/00001/00010/00100/01000/10000/11111',
  2: '01110/10001/00001/00110/01000/10000/11111',
  3: '11110/00001/00001/01110/00001/00001/11110',
  4: '00010/00110/01010/10010/11111/00010/00010',
  5: '11111/10000/11110/00001/00001/10001/01110',
  6: '00110/01000/10000/11110/10001/10001/01110',
  7: '11111/00001/00010/00100/01000/01000/01000',
  8: '01110/10001/10001/01110/10001/10001/01110',
  9: '01110/10001/10001/01111/00001/00010/01100'
};
/* 去掉了 I / O / 0 / 1：5×7 点阵里 I 和 1、O 和 0 几乎分不出来。
   用户认错一次就要重来，为这点理论安全性换来真实挫败感不值。 */
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // 每行的 filter 字节
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const CAPTCHA_W = 148, CAPTCHA_H = 54, CAPTCHA_LEN = 4;

function captchaPng(code) {
  const w = CAPTCHA_W, h = CAPTCHA_H;
  const px = Buffer.alloc(w * h * 3);
  const put = (x, y, r, g, b) => {
    x = x | 0; y = y | 0;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  const rnd = (a, b) => a + crypto.randomInt(Math.max(1, b - a + 1));

  // 米黄底 + 逐像素噪点：纯色底一阈值就二值化干净了，加点噪声反而更抗机器
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = rnd(-5, 5);
      put(x, y, 250 + n, 245 + n, 233 + n);
    }
  }

  // 干扰折线 ×2：颜色压淡，别糊住字
  for (let l = 0; l < 2; l++) {
    let x = rnd(0, 8), y = rnd(6, h - 6);
    const cr = rnd(130, 200), cg = rnd(130, 195), cb = rnd(130, 195);
    while (x < w) {
      put(x, y, cr, cg, cb);
      put(x, y + 1, cr, cg, cb);
      x++;
      y += rnd(-1, 1);
      if (y < 4) y = 4;
      if (y > h - 5) y = h - 5;
    }
  }

  // 四个字符：各自随机上下漂移 + 斜切。斜切让「按列切分」这类简易识别失效
  const DOT = 5, GAP = 8, PAD = 8;
  const cw = 5 * DOT, ch = 7 * DOT;
  const left = Math.max(0, Math.floor((w - (PAD * 2 + cw * CAPTCHA_LEN + GAP * (CAPTCHA_LEN - 1))) / 2));
  for (let i = 0; i < code.length; i++) {
    const rows = (CAPTCHA_FONT[code[i]] || '').split('/');
    if (rows.length !== 7) continue;
    const ox = left + PAD + i * (cw + GAP);
    const oy = Math.floor((h - ch) / 2) + rnd(-2, 2);
    const skew = (crypto.randomInt(45) - 22) / 100;    // -0.22 ~ +0.22，再大就认不出了
    const cr = rnd(40, 90), cg = rnd(45, 95), cb = rnd(60, 115);
    for (let r = 0; r < 7; r++) {
      const shift = Math.round((r - 3) * skew * DOT);
      for (let c = 0; c < 5; c++) {
        if (rows[r][c] !== '1') continue;
        const bx = ox + c * DOT + shift, by = oy + r * DOT;
        for (let dy = 0; dy < DOT; dy++) {
          for (let dx = 0; dx < DOT; dx++) {
            const edge = (dx === 0 || dy === 0 || dx === DOT - 1 || dy === DOT - 1);
            const k = edge ? 0.8 : 1;                  // 边缘压暗一点，笔画不至于糊成一片
            put(bx + dx, by + dy, (cr * k) | 0, (cg * k) | 0, (cb * k) | 0);
          }
        }
      }
    }
  }

  // 噪点：一半深一半浅，干扰「找连通块」再切割的思路
  for (let i = 0; i < 130; i++) {
    const x = rnd(0, w - 1), y = rnd(0, h - 1);
    if (crypto.randomInt(2)) put(x, y, rnd(60, 130), rnd(60, 130), rnd(60, 130));
    else put(x, y, rnd(150, 215), rnd(150, 215), rnd(150, 215));
  }
  return encodePng(w, h, px);
}

const captchaStore = new Map();          // id -> { code, exp }
const CAPTCHA_TTL = 5 * 60 * 1000;       // 5 分钟，够慢吞吞地输
const CAPTCHA_MAX = 3000;                // 表本身也不能被撑爆

function issueCaptcha() {
  const now = Date.now();
  if (captchaStore.size >= CAPTCHA_MAX) {
    for (const [k, v] of captchaStore) {
      if (v.exp < now || captchaStore.size >= CAPTCHA_MAX) captchaStore.delete(k);
    }
  }
  let code = '';
  for (let i = 0; i < CAPTCHA_LEN; i++) code += CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)];
  const id = crypto.randomBytes(9).toString('base64url');
  captchaStore.set(id, { code, exp: now + CAPTCHA_TTL });
  return { id, code };
}

/* 一次性：不管对错都作废。错一次就得换一张，
   暴力猜测的收益是 0，而且每猜一次都得多拉一次图。 */
function consumeCaptcha(id, input) {
  const key = String(id || '');
  if (!key) return false;
  const rec = captchaStore.get(key);
  if (!rec) return false;
  captchaStore.delete(key);
  if (rec.exp < Date.now()) return false;
  return rec.code === String(input || '').trim().toUpperCase();
}

/* 返回 true = 确认是「别的网站借用户的浏览器发来的」；info 用来记日志 */
function csrfCrossSite(req, info) {
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs) {
    if (sfs === 'cross-site') return true;
    if (sfs === 'same-site' && info) info.sameSite = true;
    return false;
  }
  const src = String(req.headers.origin || req.headers.referer || '');
  if (!src) return false;
  let host = '';
  try { host = new URL(src).host.toLowerCase().replace(/\.$/, ''); } catch (e) { return true; }
  const hosts = hostSetOf(req);
  if (hosts.has(host) || hosts.has(host.replace(/:\d+$/, ''))) return false;
  // 走到这里 = Origin 跟本机能看到的 Host 都对不上。两种可能：
  //   a) 真的跨站；
  //   b) 部署在网关后面，Host 被改写成内部地址，浏览器的 Origin 才是对外的。
  // 判据是「有没有配过对外域名」：
  //   - 配了（ai.config.json 的 siteHosts / FQ_SITE_HOSTS）→ 严格。对不上就是跨站，
  //     因为 b) 那种情况下的 Origin 一定会命中白名单。**这里以前拿「带 X-Forwarded-For」
  //     当放行理由，但线上每个请求都带 XFF，等于把整段校验废掉了**（红队报告 P1）。
  //   - 没配 → 保持旧的宽松行为，免得一份新部署在配好之前所有写请求全 403。
  const configured = SITE_HOSTS_CFG.length > 0 || String(process.env.FQ_SITE_HOSTS || '').trim().length > 0;
  if (configured) return true;
  const viaProxy = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim().length > 0;
  if (viaProxy) { if (info) info.unverified = host; return false; }
  return true;
}

async function handleApi(req, res, pathname, query) {
  const method = req.method;
  const ip = clientIp(req);

  /* ============ 跨站请求防护（CSRF）============
     三层：Cookie 的 SameSite=Lax（第一层）、来源判定（第二层）、
     有 body 的写请求必须是 application/json（第三层）。
     为什么还要第二三层：SameSite 依赖浏览器实现，老内核 / 代理改写 / 客户端
     手动构造都可能退化；而浏览器跨站「简单请求」只能发 text/plain、表单这类
     格式，卡死 Content-Type 就把 sendBeacon 和隐藏表单全堵住了。 */
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const info = {};
    if (csrfCrossSite(req, info)) {
      secLog('csrf_block', req, {
        from: String(req.headers.origin || req.headers.referer || '').slice(0, 120),
        sfs: String(req.headers['sec-fetch-site'] || ''),
        path: pathname
      });
      return json(res, 403, { error: '跨站请求已被拒绝' });
    }
    if (info.sameSite) secLog('csrf_samesite', req, { path: pathname });
    if (info.unverified) secLog('csrf_unverified', req, { from: info.unverified, path: pathname });
    const hasBody = Number(req.headers['content-length'] || 0) > 0 ||
      String(req.headers['transfer-encoding'] || '').length > 0;
    if (hasBody) {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('application/json')) {
        secLog('ctype_block', req, { ct: ct.slice(0, 40), path: pathname });
        return json(res, 415, { error: '请求格式必须是 JSON' });
      }
    }
  }

  /* ============ 全局防爬取限流 ============
     目标：正常用户（含公司/NAT 共用出口 IP、多标签页、30s 轮询）绝不被误伤，
     但脚本「上千次/分钟」的批量遍历会被直接掐断。
     1) 已登录：600 次/分钟 —— 活跃用户峰值也就几十次，留足余量。
     2) 未登录：240 次/分钟 —— 匿名浏览一页约 5~8 次调用，正常刷页远低于此。
     命中回 429 并给 Retry-After，方便客户端/爬虫退避。 */
  /* 会话只解一次：以前限流和应用逻辑各调一次 currentUser（每次都做 sha256 + 查表），
     被刷时这一步是纯浪费的 CPU。 */
  const me = currentUser(req);
  const loggedIn = !!me;
  const perIpMax = loggedIn ? 600 : 240;
  if (!rateLimit('api:' + ip, perIpMax, 60 * 1000)) {
    res.setHeader('Retry-After', '30');
    return json(res, 429, { error: '请求太频繁了，请稍后再试' });
  }

  /* ============ 安全控制台接口 ============
     放在业务路由之前：一是这些接口要被「会话已解出来」后的 me 判断，
     二是即便主站某个业务出错，控制台也应该还能打开。 */
  if (pathname.startsWith('/api/ops/')) return handleOps(req, res, pathname, query, me);

  /* ============ 图形验证码 ============ */
  if (pathname === '/api/captcha' && method === 'GET') {
    if (!rateLimit('cap:' + ip, 60, 60 * 1000)) {
      res.setHeader('Retry-After', '10');
      return json(res, 429, { error: '刷新太快了，歇一下再试' });
    }
    const c = issueCaptcha();
    const out = { id: c.id, img: 'data:image/png;base64,' + captchaPng(c.code).toString('base64') };
    if (CAPTCHA_MODE === 'debug') out.code = c.code;   // 只给自动化测试用
    return json(res, 200, out);
  }

  /* ============ 认证 ============ */

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (!rateLimit('reg:' + ip, 20, 60 * 60000)) {
      return json(res, 429, { error: '注册太频繁了，请稍后再试' });
    }
    const b = await readBody(req);
    const username = clean(b.username, 20);
    const nickname = clean(b.nickname, 24) || username;
    const password = String(b.password || '');

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return json(res, 400, { error: '用户ID需为 3-20 位字母、数字或下划线' });
    }
    const pwProblem = passwordProblem(password, username);
    if (pwProblem) return json(res, 400, { error: pwProblem });
    if (nickname.length < 1) return json(res, 400, { error: '昵称不能为空' });
    if (findUserByName(username)) {
      return json(res, 409, { error: '这个用户ID已经有人用了' });
    }

    if (!takePwSlot()) return json(res, 429, { error: '注册的人有点多，请稍等几秒再试' });
    let pwHash;
    try { pwHash = await makePwAsync(password); }
    finally { freePwSlot(); }

    const user = {
      id: db.seq++,
      username, nickname,
      password: pwHash,
      role: 'user',                       // 注册一律为普通用户，审核员需申请
      bio: '',
      avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      follows: [], banned: false,
      pwStrong: true, pwChecked: true,
      createdAt: nowMs()
    };
    db.users.push(user);

    const token = rid(24);
    addSession(token, user.id);
    secLog('register', req, { uid: user.id, username });
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400, isHttps(req)));
    return json(res, 200, { token: bodyToken(req, token), user: publicUser(user) });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    if (!rateLimit('login:' + ip, 30, 10 * 60000)) {
      return json(res, 429, { error: '尝试太频繁，请 10 分钟后再试' });
    }
    const b = await readBody(req);
    const username = clean(b.username, 20);
    const password = String(b.password || '');
    // 超长口令在 scrypt 里很贵，先掐掉（不影响正常登录，最长 72 位）
    if (password.length > MAX_PW + 16) return json(res, 401, { error: '用户ID或密码不对' });

    /* 图形验证码：先验码、再算密码。放在哈希之前，被刷的时候省掉最贵的那一步。
       验证码错**不**记进「密码错 8 次锁定」—— 否则别人拿错验证码故意打 8 次，
       就能把某个账号锁 10 分钟，等于白送一个拒绝服务。 */
    if (CAPTCHA_ON && !consumeCaptcha(b.captchaId, b.captchaCode)) {
      secLog('captcha_fail', req, { username });
      return json(res, 400, { error: '验证码不对，换一张重新输', code: 'CAPTCHA_FAIL' });
    }

    const ukey = username.toLowerCase();
    /* 锁定粒度 = IP + 账号。以前只按账号锁，攻击者随便打 8 次错密码
       就能把别人的账号锁 10 分钟（白送的拒绝服务）。 */
    const lockKey = ip + '|' + ukey;
    if (loginLocked(lockKey)) {
      secLog('login_locked', req, { username });
      return json(res, 429, { error: '密码错误次数过多，请 10 分钟后再试' });
    }
    const user = findUserByName(username);
    /* 密码运算名额：满了说明正在被并发刷（每个 scrypt 都要 ~60ms CPU）。
       回 429 而不是排队 —— 排队等于替攻击者把线程池占满，正常用户更登不进来。 */
    if (!takePwSlot()) {
      secLog('login_busy', req, { username });
      return json(res, 429, { error: '登录的人有点多，请稍等几秒再试' });
    }
    let ok = false;
    try {
      if (user) {
        ok = await verifyPwAsync(password, user.password);
      } else {
        // 用户不存在也跑一次同样代价的哈希，避免靠响应时间差枚举用户ID
        await verifyPwAsync(password, DUMMY_PW_HASH);
      }
    } finally {
      freePwSlot();
    }
    if (!ok) {
      loginFail(lockKey);
      secLog('login_fail', req, { username });
      return json(res, 401, { error: '用户ID或密码不对' });
    }
    if (user.banned) {
      secLog('login_banned', req, { uid: user.id });
      return json(res, 403, { error: '这个账号已被封禁，如有疑问请联系管理员' });
    }
    loginOk(lockKey);
    // 管理员登录过的 IP 记一笔：自动封禁会跳过它，免得把自己锁在门外
    if (rankOf(user) >= 2) adminIps.set(ip, nowMs());

    // 还在用初始/弱口令 → 只做个标记（写进登录日志），不拦任何操作
    if (!user.pwStrong) {
      const prob = passwordProblem(password, user.username);
      if (prob) user.mustChangePw = true;
    }
    if (user.mustChangePw) secLog('login_weakpw', req, { uid: user.id, username });

    const token = rid(24);
    addSession(token, user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400, isHttps(req)));
    return json(res, 200, {
      token: bodyToken(req, token), user: publicUser(user),
      mustChangePw: !!user.mustChangePw
    });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    dropSession(tokenFromReq(req).token);
    res.setHeader('Set-Cookie', sessionCookie('', 0, isHttps(req)));
    return json(res, 200, { ok: true });
  }

  /* 以前这里有一道闸：还在用初始口令的账号只放行「看自己 / 改密 / 登出」，
     其余一律 403 MUST_CHANGE_PASSWORD。按产品要求已取消 —— 不强制换密码，
     登录后能正常用。密码强度仍然由注册/改密时的 passwordProblem() 把关；
     初始口令本身是随机 16 位，弱口令账号启动时会被 rotateWeakCredentials() 重置。
     user.mustChangePw 这个标记保留下来只作状态用（登录日志里能看到），不再拦请求。 */

  if (pathname === '/api/me' && method === 'GET') {
    if (!me) return json(res, 401, { error: '未登录' });
    return json(res, 200, { user: publicUser(me), mustChangePw: !!me.mustChangePw });
  }

  /* ============ 我的资料 ============ */

  if (pathname === '/api/me' && method === 'PATCH') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const b = await readBody(req);
    if (b.nickname !== undefined) {
      const nickname = clean(b.nickname, 24);
      if (!nickname) return json(res, 400, { error: '昵称不能为空' });
      me.nickname = nickname;
    }
    if (b.bio !== undefined) me.bio = clean(b.bio, 160);
    if (b.avatar !== undefined) {
      const av = String(b.avatar || '');
      if (av && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(av) && !/^\/assets\/[a-zA-Z0-9._-]+$/.test(av)) {
        return json(res, 400, { error: '头像地址不合法' });
      }
      me.avatar = av;
    }
    saveDB();
    return json(res, 200, { user: publicUser(me) });
  }

  if (pathname === '/api/me/password' && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const b = await readBody(req);
    const oldPw = String(b.oldPassword || '');
    const newPw = String(b.newPassword || '');
    if (oldPw.length > MAX_PW + 16 || newPw.length > MAX_PW + 16) {
      return json(res, 400, { error: '密码太长了' });
    }
    if (!takePwSlot()) return json(res, 429, { error: '稍等几秒再试' });
    let okOld = false;
    try { okOld = await verifyPwAsync(oldPw, me.password); }
    finally { freePwSlot(); }
    if (!okOld) {
      secLog('password_fail', req, { uid: me.id });
      return json(res, 400, { error: '原密码不对' });
    }
    if (oldPw === newPw) return json(res, 400, { error: '新密码和原密码一样，换一个吧' });
    const prob = passwordProblem(newPw, me.username);
    if (prob) return json(res, 400, { error: prob });
    if (!takePwSlot()) return json(res, 429, { error: '稍等几秒再试' });
    try { me.password = await makePwAsync(newPw); }
    finally { freePwSlot(); }
    me.pwStrong = true;
    delete me.mustChangePw;
    // 其他会话失效，仅保留当前这一个
    dropUserSessions(me.id, tokenFromReq(req).token);
    saveNow();
    secLog('password_change', req, { uid: me.id });
    return json(res, 200, { ok: true });
  }

  /* ============ 审核员申请 ============ */

  if (pathname === '/api/me/apply-reviewer' && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (rankOf(me) >= 1) return json(res, 400, { error: '你已经是审核员了' });
    if (db.applications.some((a) => a.userId === me.id && a.status === 'pending')) {
      return json(res, 409, { error: '你已经提交过申请，请耐心等待' });
    }
    const b = await readBody(req);
    const app = {
      id: db.seq++,
      userId: me.id,
      reason: clean(b.reason, 200),
      status: 'pending',
      createdAt: nowMs(),
      handledBy: 0, handledAt: 0
    };
    db.applications.push(app);
    // 通知所有管理员
    for (const u of db.users) {
      if (u.role === 'admin') pushNote(u.id, 'apply', me.id, { text: me.nickname + ' 申请成为审核员' });
    }
    saveDB();
    return json(res, 200, { ok: true, application: app });
  }

  if (pathname === '/api/me/apply-reviewer' && method === 'GET') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const app = db.applications.filter((a) => a.userId === me.id).sort((a, b) => b.id - a.id)[0] || null;
    return json(res, 200, { application: app });
  }

  /* ============ 统计 ============ */

  if (pathname === '/api/stats' && method === 'GET') {
    const approved = db.posts.filter((p) => p.status === 'approved').length;
    await Promise.resolve();
    return json(res, 200, {
      // 用户总数只给登录用户：匿名看到它等于白拿「循环上限」，是枚举的第一步（红队 P3）
      users: me ? db.users.length : undefined,
      posts: approved,
      approved: approved,
      pending: db.posts.filter((p) => p.status === 'pending').length,
      rejected: db.posts.filter((p) => p.status === 'rejected').length,
      openReports: me && rankOf(me) >= 1
        ? db.reports.filter((r) => r.status === 'open').length : 0,
      unreadNotes: me ? db.notifications.filter((n) => n.userId === me.id && !n.read).length : 0,
      unreadMessages: me ? unreadDmTotal(me) : 0
    });
  }

  /* ============ 图片上传 ============ */

  if (pathname === '/api/upload' && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.banned) return json(res, 403, { error: '账号已被封禁' });
    if (!rateLimit('upload:' + me.id, 120, 60 * 60000)) {
      return json(res, 429, { error: '上传太频繁，请稍后再试' });
    }
    const b = await readBody(req);
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
    if (!m) return json(res, 400, { error: '图片格式不支持' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return json(res, 400, { error: '这张图是空的' });
    if (buf.length > UPLOAD_MAX_ONE) return json(res, 400, { error: '单张图片不能超过 5MB' });
    // 声明的扩展名必须和真实文件头一致，否则一律不收
    if (sniffImage(buf) !== ext) {
      secLog('upload_fake', req, { uid: me.id, declared: ext, size: buf.length });
      return json(res, 400, { error: '这个文件不是有效的图片' });
    }
    scanUploads();
    const mine = upUserBytes.get(me.id) || 0;
    if (mine + buf.length > UPLOAD_MAX_USER) {
      return json(res, 507, { error: '你的图片空间满了（300MB），删掉一些旧内容再来' });
    }
    if (upTotalBytes + buf.length > UPLOAD_MAX_ALL) {
      secLog('upload_full', req, { uid: me.id, total: upTotalBytes });
      return json(res, 507, { error: '站点的图片空间暂时满了，请联系管理员' });
    }
    // 文件名带 uid 前缀：以后要按人统计/清理都有据可查
    const name = 'u' + me.id + '-' + rid(10) + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf, { mode: 0o644 });
    upTotalBytes += buf.length;
    upUserBytes.set(me.id, mine + buf.length);
    return json(res, 200, { url: '/uploads/' + name });
  }

  /* ============ 帖子列表 ============ */

  if (pathname === '/api/posts' && method === 'GET') {
    const scope = query.searchParams.get('scope') || 'feed';
    const userId = Number(query.searchParams.get('userId') || 0);
    const kw = clean(query.searchParams.get('q'), 40).toLowerCase();
    const offset = Math.max(0, Number(query.searchParams.get('offset') || 0));
    const limit = Math.min(Math.max(1, Number(query.searchParams.get('limit') || 20)), 50);

    let list = db.posts.slice();

    if (scope === 'feed') {
      // 公开信息流：所有人看到的内容一致（仅已通过）
      // 额外把"自己还在审核中"的内容一并返回，带 pending 标记，
      // 这样作者发完帖能立刻看到，不会以为没发出去。
      list = list.filter((p) => p.status === 'approved' ||
        (me && p.authorId === me.id && p.status === 'pending'));
    } else if (scope === 'following') {
      if (!me) return json(res, 401, { error: '请先登录' });
      const set = new Set(me.follows || []);
      list = list.filter((p) => p.status === 'approved' && set.has(p.authorId));
    } else if (scope === 'mine') {
      if (!me) return json(res, 401, { error: '请先登录' });
      list = list.filter((p) => p.authorId === me.id);
    } else if (scope === 'pending') {
      if (!me) return json(res, 401, { error: '请先登录' });
      if (rankOf(me) < 1) return json(res, 403, { error: '只有审核员可以查看待审核内容' });
      list = list.filter((p) => p.status === 'pending');
    } else if (scope === 'all') {
      if (!me) return json(res, 401, { error: '请先登录' });
      if (rankOf(me) < 1) return json(res, 403, { error: '只有审核员可以查看全部内容' });
    } else if (scope === 'hot') {
      list = list.filter((p) => p.status === 'approved');
    } else if (scope === 'user') {
      list = list.filter((p) => p.authorId === userId);
      if (!me || (me.id !== userId && rankOf(me) < 1)) {
        list = list.filter((p) => p.status === 'approved');
      }
    }

    if (kw) {
      list = list.filter((p) => {
        const author = db.users.find((u) => u.id === p.authorId);
        return p.content.toLowerCase().includes(kw) ||
          (author && (author.nickname.toLowerCase().includes(kw) ||
            author.username.toLowerCase().includes(kw)));
      });
    }

    if (scope === 'pending') {
      list.sort((a, b) => a.createdAt - b.createdAt);
    } else if (scope === 'hot') {
      list.sort((a, b) => {
        const ha = (a.likes || []).length * 2 + (a.comments || []).length * 3;
        const hb = (b.likes || []).length * 2 + (b.comments || []).length * 3;
        return hb - ha;
      });
    } else {
      list.sort((a, b) => b.createdAt - a.createdAt);
    }

    const total = list.length;
    const page = list.slice(offset, offset + limit);
    return json(res, 200, {
      posts: page.map((p) => serializePost(p, me, { withReports: rankOf(me) >= 1 })),
      total: total,
      offset: offset,
      hasMore: offset + page.length < total
    });
  }

  /* ============ 单条帖子 ============ */

  const postMatch = /^\/api\/posts\/(\d+)$/.exec(pathname);
  if (postMatch && method === 'GET') {
    const p = db.posts.find((x) => x.id === Number(postMatch[1]));
    if (!p) return json(res, 404, { error: '帖子不存在' });
    const visible = p.status === 'approved' ||
      (me && (me.id === p.authorId || rankOf(me) >= 1));
    if (!visible) return json(res, 403, { error: '这条内容还没有通过审核' });
    return json(res, 200, { post: serializePost(p, me, { withReports: rankOf(me) >= 1 }) });
  }

  if (postMatch && method === 'DELETE') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const idx = db.posts.findIndex((x) => x.id === Number(postMatch[1]));
    if (idx < 0) return json(res, 404, { error: '帖子不存在' });
    const p = db.posts[idx];
    if (p.authorId !== me.id && rankOf(me) < 1) {
      return json(res, 403, { error: '只能删除自己的内容' });
    }
    db.posts.splice(idx, 1);
    db.notifications = db.notifications.filter((n) => n.postId !== p.id);
    db.reports = db.reports.filter((r) => !(r.targetType === 'post' && r.targetId === p.id));
    saveDB();
    return json(res, 200, { ok: true });
  }

  /* ============ 发布 ============ */

  /* ============ AI 小饭：发帖助手 ============ */

  if (pathname === '/api/ai/compose' && method === 'POST') {
    if (!me) return json(res, 401, { error: '登录后才能用 AI 润色' });
    if (me.banned) return json(res, 403, { error: '账号已被封禁' });
    // 维护中就直说，不扣今天的次数
    if (aiGuard(res)) return;
    if (!rateLimit('ai:' + me.id, AI_DAILY_LIMIT, 24 * 60 * 60 * 1000)) {
      return json(res, 429, { error: '今天的 AI 次数用完啦，明天再来' });
    }
    const b = await readBody(req);
    // 草稿上限给足：润色要看着原文改，截断了就等于丢内容
    const text = clean(b.text, 2000);
    if (text.replace(/\s+/g, '').length < 6) {
      return json(res, 400, { error: '再多写两句吧——做了什么、什么味道。小饭只在你写的话上润色，不替你编内容' });
    }
    const seed = Math.max(0, Math.min(99, Number(b.seed) || 0));
    const ck = 'v2|' + text.toLowerCase() + '|' + seed;
    if (aiCache.has(ck)) return json(res, 200, aiCache.get(ck));

    // 先模型润色（含验货）。线上没有本地兜底：拿不到就明说，不拿模板糊弄
    let out = await aiComposeByModel(text, seed);
    if (!out && !aiLocalAllowed()) return aiDown(res);
    if (!out) out = aiPolishLocal(text);      // 仅开发测试（FQ_AI_ALLOW_LOCAL=1）
    if (!out) return json(res, 400, { error: '这段没太读懂，换个说法再试试' });
    if (aiCache.size >= AI_CACHE_MAX) aiCache.clear();
    aiCache.set(ck, out);
    return json(res, 200, out);
  }

  /* ============ AI 做饭模式：把一条帖子拆成可以照着做的步骤 ============ */

  if (pathname === '/api/ai/steps' && method === 'POST') {
    if (me && me.banned) return json(res, 403, { error: '账号已被封禁' });
    const b = await readBody(req);
    const postId = Number(b.postId) || 0;
    const post = postId ? db.posts.find((x) => x.id === postId) : null;
    if (postId && !post) return json(res, 404, { error: '帖子不存在' });
    if (post && post.status !== 'approved' && !(me && (me.id === post.authorId || rankOf(me) >= 1))) {
      return json(res, 403, { error: '这条内容还没有通过审核' });
    }
    const title = clean(b.title, 80);
    const text = post ? post.content : clean(b.text, 2000);
    if (!text || text.replace(/\s+/g, '').length < 8) {
      return json(res, 400, { error: '这条帖子没写做法，拆不出步骤' });
    }

    // 同一条帖子只拆一次：所有人都命中缓存，既不重复花钱，也不用等
    const ck = post ? 'p' + post.id : 'h' + hashStr(text);
    if (cookCache.has(ck)) return json(res, 200, Object.assign({ cached: true }, cookCache.get(ck)));

    // 维护中就先回话（已拆好的缓存上面已经返回过，能用的照用），不扣次数
    if (aiGuard(res)) return;

    const who = me ? 'u' + me.id : 'ip' + ip;
    if (!rateLimit('aisteps:' + who, me ? COOK_STEPS_LIMIT : 5, 24 * 60 * 60 * 1000)) {
      return json(res, 429, { error: '今天拆得够多啦，明天再来' });
    }

    const firstLine = (text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '').slice(0, 40);
    const user = '这条帖子的第一行（多半是菜名）：' + firstLine + '\n\n帖子正文：\n' + text.slice(0, 1400);
    const r = await aiRaw(COOK_SYSTEM, user, { maxTokens: 700, temperature: 0.5 });
    let out = null;
    if (r) {
      out = aiStepsShape(aiJson(r.raw));
      if (out) out.provider = r.provider;
    }
    if (!out && !aiLocalAllowed()) return aiDown(res);
    if (!out) out = aiStepsLocal(text, title);   // 仅开发测试（FQ_AI_ALLOW_LOCAL=1）

    if (cookCache.size >= COOK_CACHE_MAX) cookCache.clear();
    cookCache.set(ck, out);
    return json(res, 200, out);
  }

  /* ============ 厨房急诊：做到某一步卡住了，问一句 ============ */

  if (pathname === '/api/ai/help' && method === 'POST') {
    if (me && me.banned) return json(res, 403, { error: '账号已被封禁' });
    const b = await readBody(req);
    const q = clean(b.question, 200);
    if (q.replace(/\s+/g, '').length < 2) return json(res, 400, { error: '说说现在是什么情况' });

    if (aiGuard(res)) return;         // 维护中不扣次数

    const who = me ? 'u' + me.id : 'ip' + ip;
    if (!rateLimit('aihelp:' + who, me ? COOK_HELP_LIMIT : 5, 24 * 60 * 60 * 1000)) {
      return json(res, 429, { error: '问得有点急啦，先按现在的火候试一下' });
    }

    const postId = Number(b.postId) || 0;
    const post = postId ? db.posts.find((x) => x.id === postId) : null;
    if (post && post.status !== 'approved' && !(me && (me.id === post.authorId || rankOf(me) >= 1))) {
      return json(res, 403, { error: '这条内容还没有通过审核' });
    }
    const stepT = clean(b.step, 40);
    const stepD = clean(b.stepText, 200);
    const stepNo = Math.max(0, Math.min(20, Number(b.stepNo) || 0));

    const user = (post ? '正在做的菜（原帖）：\n' + post.content.slice(0, 800) + '\n\n' : '') +
      'TA 正做到第 ' + (stepNo || 1) + ' 步：' + stepT + (stepD ? '（' + stepD + '）' : '') +
      '\n\n厨友问：' + q;

    const r = await aiRaw(COOK_HELP_SYSTEM, user, { maxTokens: 420, temperature: 0.6 });
    let out = null;
    const obj = r ? aiJson(r.raw) : null;
    let ans = obj && typeof obj.answer === 'string' ? clean(obj.answer, 300) : '';
    // 模型有时不套 JSON，直接把答案说出来了；不是 JSON 残片就当答案收下
    if (!ans && r) {
      const plain = clean(String(r.raw || '').replace(/```json|```/g, '').replace(/^["“]|["”]$/g, ''), 300);
      if (plain && !/^\s*[{[]/.test(plain)) ans = plain;
    }
    if (ans) out = { answer: ans, provider: r.provider };
    if (!out && !aiLocalAllowed()) return aiDown(res);
    if (!out) out = aiHelpLocal(q, { step: stepT || stepD });   // 仅开发测试
    return json(res, 200, out);
  }

  if (pathname === '/api/posts' && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录再发布' });
    if (me.banned) return json(res, 403, { error: '账号已被封禁，无法发布' });
    if (!rateLimit('post:' + me.id, 30, 60 * 60000)) {
      return json(res, 429, { error: '发得太快了，休息一下再来' });
    }
    const b = await readBody(req);
    const content = clean(b.content, 2000);
    const images = Array.isArray(b.images)
      ? b.images.slice(0, 9).filter((s) => typeof s === 'string' && /^\/uploads\/[a-zA-Z0-9._-]+$/.test(s))
      : [];

    if (!content && !images.length) return json(res, 400, { error: '写点什么再发吧' });
    if (content.length > 2000) return json(res, 400, { error: '正文最多 2000 字' });

    const post = {
      id: db.seq++,
      authorId: me.id,
      content,
      images,
      // 用过「AI 帮我写」就带一个标记，卡片上显示「AI 辅助」，不藏着
      aiAssisted: b.aiAssisted === true,
      status: rankOf(me) >= 1 ? 'approved' : 'pending',  // 审核员发布免审
      rejectReason: '',
      createdAt: nowMs(),
      likes: [], comments: [], reposts: [],
      featured: false, featuredAt: 0, featuredBy: 0
    };
    db.posts.push(post);

    if (post.status === 'pending') {
      for (const u of db.users) {
        if (rankOf(u) >= 1 && u.id !== me.id) pushNote(u.id, 'moderation', me.id, { text: '有新的待审核内容', postId: post.id });
      }
    }
    notifyMentions(content, me, post.id, '在一条内容里');
    saveDB();
    return json(res, 200, { post: serializePost(post, me) });
  }

  /* ============ 点赞 / 评论 / 转发 / 举报 ============ */

  const actionMatch = /^\/api\/posts\/(\d+)\/(like|comments|repost|report|feature)$/.exec(pathname);
  if (actionMatch) {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.banned) return json(res, 403, { error: '账号已被封禁' });
    const post = db.posts.find((x) => x.id === Number(actionMatch[1]));
    if (!post) return json(res, 404, { error: '帖子不存在' });
    if (post.status !== 'approved' && post.authorId !== me.id && rankOf(me) < 1) {
      return json(res, 403, { error: '这条内容还没有通过审核' });
    }
    const action = actionMatch[2];

    if (action === 'like' && method === 'POST') {
      post.likes = post.likes || [];
      const i = post.likes.indexOf(me.id);
      if (i >= 0) post.likes.splice(i, 1);
      else {
        post.likes.push(me.id);
        pushNote(post.authorId, 'like', me.id, { postId: post.id });
      }
      saveDB();
      return json(res, 200, { post: serializePost(post, me) });
    }

    if (action === 'repost' && method === 'POST') {
      post.reposts = post.reposts || [];
      const i = post.reposts.indexOf(me.id);
      if (i >= 0) post.reposts.splice(i, 1);
      else post.reposts.push(me.id);
      saveDB();
      return json(res, 200, { post: serializePost(post, me) });
    }

    // 「评优」：审核员/管理员把**别人的**佳作挂进右栏「优秀饭帖」
    if (action === 'feature' && method === 'POST') {
      if (rankOf(me) < 1) return json(res, 403, { error: '只有审核员和管理员能评优' });
      if (post.authorId === me.id) return json(res, 403, { error: '不能给自己的作品评优，去挑别人的好菜吧' });
      if (post.status !== 'approved') return json(res, 400, { error: '这条作品还没通过审核，先通过再评优' });
      post.featured = !post.featured;
      post.featuredAt = post.featured ? nowMs() : 0;
      post.featuredBy = post.featured ? me.id : 0;
      if (post.featured) pushNote(post.authorId, 'feature', me.id, { postId: post.id });
      saveDB();
      return json(res, 200, { post: serializePost(post, me) });
    }

    if (action === 'comments' && method === 'POST') {
      const b = await readBody(req);
      const content = clean(b.content, 500);
      if (!content) return json(res, 400, { error: '评论不能为空' });
      const c = { id: db.seq++, userId: me.id, content, createdAt: nowMs() };
      post.comments = post.comments || [];
      post.comments.push(c);
      pushNote(post.authorId, 'comment', me.id, { postId: post.id, text: content.slice(0, 40) });
      notifyMentions(content, me, post.id, '在一条评论里');
      saveDB();
      return json(res, 200, { post: serializePost(post, me) });
    }

    if (action === 'report' && method === 'POST') {
      if (!rateLimit('report:' + me.id, 30, 60 * 60000)) {
        return json(res, 429, { error: '举报太频繁，请稍后再试' });
      }
      const b = await readBody(req);
      const reason = clean(b.reason, 40) || '其他';
      const detail = clean(b.detail, 200);
      if (db.reports.some((r) => r.reporterId === me.id && r.targetType === 'post' &&
        r.targetId === post.id && r.status === 'open')) {
        return json(res, 409, { error: '你已经举报过这条内容了' });
      }
      db.reports.push({
        id: db.seq++,
        targetType: 'post',
        targetId: post.id,
        postId: post.id,
        reporterId: me.id,
        reason, detail,
        status: 'open',
        createdAt: nowMs(),
        handledBy: 0, handledAt: 0
      });
      for (const u of db.users) {
        if (rankOf(u) >= 1 && u.id !== me.id) pushNote(u.id, 'moderation', me.id, { text: '有一条新的举报待处理', postId: post.id });
      }
      saveDB();
      return json(res, 200, { ok: true });
    }
  }

  /* ============ 删除评论 ============ */

  const cmtMatch = /^\/api\/posts\/(\d+)\/comments\/(\d+)$/.exec(pathname);
  if (cmtMatch && method === 'DELETE') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const post = db.posts.find((x) => x.id === Number(cmtMatch[1]));
    if (!post) return json(res, 404, { error: '帖子不存在' });
    const idx = (post.comments || []).findIndex((c) => c.id === Number(cmtMatch[2]));
    if (idx < 0) return json(res, 404, { error: '评论不存在' });
    const c = post.comments[idx];
    if (c.userId !== me.id && post.authorId !== me.id && rankOf(me) < 1) {
      return json(res, 403, { error: '只能删除自己的评论' });
    }
    post.comments.splice(idx, 1);
    saveDB();
    return json(res, 200, { post: serializePost(post, me) });
  }

  /* ============ 审核 ============ */

  if (pathname === '/api/review' && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (rankOf(me) < 1) return json(res, 403, { error: '只有审核员可以执行审核' });
    const b = await readBody(req);
    const post = db.posts.find((x) => x.id === Number(b.postId));
    if (!post) return json(res, 404, { error: '帖子不存在' });
    const action = b.action;

    if (action === 'approve') {
      post.status = 'approved';
      post.rejectReason = '';
      pushNote(post.authorId, 'approve', me.id, { postId: post.id });
    } else if (action === 'reject') {
      post.status = 'rejected';
      post.rejectReason = clean(b.reason, 80) || '内容不符合社区规范';
      // 被下架就不该还挂在「优秀饭帖」里
      post.featured = false;
      post.featuredAt = 0;
      post.featuredBy = 0;
      pushNote(post.authorId, 'reject', me.id, { postId: post.id, text: post.rejectReason });
    } else {
      return json(res, 400, { error: '未知的审核操作' });
    }
    post.reviewedBy = me.id;
    post.reviewedAt = nowMs();
    saveDB();
    secLog('review', req, { by: me.id, postId: post.id, action, status: post.status });
    return json(res, 200, { post: serializePost(post, me) });
  }

  /* ============ 举报管理（审核员） ============ */

  if (pathname === '/api/reports' && method === 'GET') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (rankOf(me) < 1) return json(res, 403, { error: '只有审核员可以查看举报' });
    const status = query.searchParams.get('status') || 'open';
    const list = db.reports
      .filter((r) => status === 'all' || r.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
      .map((r) => {
        const post = db.posts.find((p) => p.id === r.postId);
        return {
          id: r.id,
          reason: r.reason,
          detail: r.detail,
          status: r.status,
          createdAt: r.createdAt,
          reporter: briefUser(db.users.find((u) => u.id === r.reporterId)),
          post: post ? serializePost(post, me, { withReports: true }) : null
        };
      });
    return json(res, 200, { reports: list });
  }

  const reportMatch = /^\/api\/reports\/(\d+)$/.exec(pathname);
  if (reportMatch && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (rankOf(me) < 1) return json(res, 403, { error: '只有审核员可以处理举报' });
    const r = db.reports.find((x) => x.id === Number(reportMatch[1]));
    if (!r) return json(res, 404, { error: '举报不存在' });
    const b = await readBody(req);
    const action = b.action;

    if (action === 'dismiss') {
      r.status = 'dismissed';
    } else if (action === 'remove') {
      const idx = db.posts.findIndex((p) => p.id === r.postId);
      if (idx >= 0) db.posts.splice(idx, 1);
      r.status = 'resolved';
      for (const other of db.reports) {
        if (other.id !== r.id && other.postId === r.postId && other.status === 'open') other.status = 'resolved';
      }
      pushNote(r.reporterId, 'report', me.id, { text: '感谢举报，相关内容已下架' });
    } else if (action === 'ban') {
      const post = db.posts.find((p) => p.id === r.postId);
      if (post) {
        const u = db.users.find((x) => x.id === post.authorId);
        if (u && rankOf(u) < rankOf(me)) u.banned = true;
        const idx = db.posts.findIndex((p) => p.id === r.postId);
        if (idx >= 0) db.posts.splice(idx, 1);
      }
      r.status = 'resolved';
      for (const other of db.reports) {
        if (other.id !== r.id && other.postId === r.postId && other.status === 'open') other.status = 'resolved';
      }
      pushNote(r.reporterId, 'report', me.id, { text: '感谢举报，违规内容已下架、账号已处理' });
    } else {
      return json(res, 400, { error: '未知的举报处理操作' });
    }
    r.handledBy = me.id;
    r.handledAt = nowMs();
    saveDB();
    return json(res, 200, { ok: true });
  }

  /* ============ 审核员申请管理（管理员） ============ */

  if (pathname === '/api/applications' && method === 'GET') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.role !== 'admin') return json(res, 403, { error: '只有管理员可以查看申请' });
    const list = db.applications
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
      .map((a) => ({
        id: a.id,
        reason: a.reason,
        status: a.status,
        createdAt: a.createdAt,
        user: briefUser(db.users.find((u) => u.id === a.userId))
      }));
    return json(res, 200, { applications: list });
  }

  const appMatch = /^\/api\/applications\/(\d+)$/.exec(pathname);
  if (appMatch && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.role !== 'admin') return json(res, 403, { error: '只有管理员可以审批申请' });
    const a = db.applications.find((x) => x.id === Number(appMatch[1]));
    if (!a) return json(res, 404, { error: '申请不存在' });
    const b = await readBody(req);
    const u = db.users.find((x) => x.id === a.userId);
    if (b.action === 'approve') {
      a.status = 'approved';
      if (u) u.role = 'reviewer';
      pushNote(a.userId, 'applyResult', me.id, { text: '恭喜，你已成为审核员，可以进入审核中心了' });
    } else if (b.action === 'reject') {
      a.status = 'rejected';
      pushNote(a.userId, 'applyResult', me.id, { text: '很遗憾，这次审核员申请没有通过' });
    } else {
      return json(res, 400, { error: '未知的审批操作' });
    }
    a.handledBy = me.id;
    a.handledAt = nowMs();
    saveDB();
    return json(res, 200, { ok: true });
  }

  /* ============ 用户管理（管理员） ============ */

  if (pathname === '/api/admin/users' && method === 'GET') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.role !== 'admin') return json(res, 403, { error: '只有管理员可以查看用户列表' });
    const kw = clean(query.searchParams.get('q'), 40).toLowerCase();
    let list = db.users.slice();
    if (kw) {
      list = list.filter((u) => u.username.toLowerCase().includes(kw) || u.nickname.toLowerCase().includes(kw));
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    return json(res, 200, {
      users: list.slice(0, 200).map((u) => ({
        ...publicUser(u),
        banned: !!u.banned,
        postCount: db.posts.filter((p) => p.authorId === u.id).length
      }))
    });
  }

  const banMatch = /^\/api\/admin\/users\/(\d+)\/(ban|unban|role|delete)$/.exec(pathname);
  if (banMatch && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.role !== 'admin') return json(res, 403, { error: '只有管理员可以管理用户' });
    const u = db.users.find((x) => x.id === Number(banMatch[1]));
    if (!u) return json(res, 404, { error: '用户不存在' });
    const op = banMatch[2];
    if (op === 'ban') {
      if (u.id === me.id) return json(res, 400, { error: '不能封禁自己' });
      if (rankOf(u) >= rankOf(me)) return json(res, 403, { error: '不能封禁同级或更高权限的用户' });
      u.banned = true;
    } else if (op === 'unban') {
      u.banned = false;
    } else if (op === 'delete') {
      // 删除用户（连同其内容一起清理，不可恢复）
      if (u.id === me.id) return json(res, 400, { error: '不能删除自己的账号' });
      if (rankOf(u) >= rankOf(me)) return json(res, 403, { error: '不能删除同级或更高权限的用户' });
      const uid = u.id;
      const postIds = db.posts.filter((p) => p.authorId === uid).map((p) => p.id);
      db.posts = db.posts.filter((p) => p.authorId !== uid);
      // 其余帖子里的评论 / 点赞 / 转发 也一并摘掉
      for (const p of db.posts) {
        if (Array.isArray(p.comments)) p.comments = p.comments.filter((c) => c.userId !== uid);
        if (Array.isArray(p.likes)) p.likes = p.likes.filter((x) => x !== uid);
        if (Array.isArray(p.reposts)) p.reposts = p.reposts.filter((x) => x !== uid);
      }
      db.reports = db.reports.filter((r) => r.reporterId !== uid && !postIds.includes(r.targetId));
      db.notifications = db.notifications.filter((n) =>
        n.userId !== uid && n.actorId !== uid && !postIds.includes(n.postId));
      db.applications = db.applications.filter((a) => a.userId !== uid);
      for (const x of db.users) {
        if (Array.isArray(x.follows)) x.follows = x.follows.filter((f) => f !== uid);
      }
      // 群聊：把 TA 从成员里摘掉；群主没了、或群里只剩 1 人 → 解散并清消息
      const goneGroups = [];
      db.groups = db.groups.filter((g) => {
        const wasOwner = g.ownerId === uid;
        g.memberIds = (g.memberIds || []).filter((id) => id !== uid);
        if (wasOwner || g.memberIds.length < 2) { goneGroups.push(g.id); return false; }
        return true;
      });
      db.messages = db.messages.filter((m) =>
        !(m.toGroupId && goneGroups.includes(m.toGroupId)) && m.fromId !== uid);
      for (const tk of Object.keys(db.sessions)) {
        if (db.sessions[tk] === uid) delete db.sessions[tk];
      }
      const di = db.users.findIndex((x) => x.id === uid);
      if (di >= 0) db.users.splice(di, 1);
      saveNow();
      return json(res, 200, { ok: true, removedPosts: postIds.length });
    } else if (op === 'role') {
      const b = await readBody(req);
      const role = String(b.role || '');
      if (!['user', 'reviewer', 'admin'].includes(role)) {
        return json(res, 400, { error: '角色只能是 user / reviewer / admin' });
      }
      if (u.id === me.id) return json(res, 400, { error: '不能修改自己的角色' });
      // 只能管权限不高于自己的账号（动不了比自己高的）
      if (rankOf(u) > rankOf(me)) return json(res, 403, { error: '不能修改权限比你高的用户' });
      // 提人上限：管理员可以把人提成管理员；审核员最多只能提到审核员
      if (ROLE_RANK[role] > rankOf(me)) {
        return json(res, 403, { error: '不能把人提升到比你更高的权限' });
      }
      // 安全网：不能把最后一个管理员降级（否则没人能再管用户了）
      const adminCount = db.users.filter((x) => x.role === 'admin').length;
      if (u.role === 'admin' && role !== 'admin' && adminCount <= 1) {
        return json(res, 400, { error: '至少要保留一名管理员' });
      }
      u.role = role;
    }
    saveDB();
    secLog('admin_user_' + op, req, { by: me.id, target: u.id, username: u.username });
    return json(res, 200, { user: publicUser(u) });
  }

  /* ============ 通知 ============ */

  if (pathname === '/api/notifications' && method === 'GET') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const list = db.notifications
      .filter((n) => n.userId === me.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((n) => ({
        id: n.id,
        type: n.type,
        text: n.text,
        postId: n.postId,
        read: n.read,
        createdAt: n.createdAt,
        actor: n.actorId ? briefUser(db.users.find((u) => u.id === n.actorId)) : null
      }));
    return json(res, 200, {
      notifications: list,
      unread: db.notifications.filter((n) => n.userId === me.id && !n.read).length
    });
  }

  if (pathname === '/api/notifications/read' && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const b = await readBody(req);
    if (b.id) {
      const n = db.notifications.find((x) => x.id === Number(b.id) && x.userId === me.id);
      if (n) n.read = true;
    } else {
      for (const n of db.notifications) if (n.userId === me.id) n.read = true;
    }
    saveDB();
    return json(res, 200, { ok: true });
  }

  /* ============ 热搜 / 标签 ============ */

  if (pathname === '/api/hot' && method === 'GET') {
    const approved = db.posts.filter((p) => p.status === 'approved');
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    // 「今日热门」必须真的是今日。但新站常常一天没几条，空列表比不真实更糟，
    // 所以今日话题不足 3 个时自动放宽到近 7 天 / 全部，并把**真实窗口**返回给前端，
    // 让标题跟着变（今日 / 近 7 天 / 热门），杜绝"标题写今日、实际统计全部"。
    const distinctTags = (list) => {
      const set = new Set();
      for (const p of list) {
        for (const t of (String(p.content || '').match(/#([^#\s]{1,20})#/g) || [])) set.add(t.replace(/#/g, ''));
      }
      return set.size;
    };
    const ranges = [
      { key: 'today', since: midnight.getTime() },
      { key: 'week', since: nowMs() - 7 * 86400000 },
      { key: 'all', since: 0 },
    ];
    let range = ranges[ranges.length - 1];
    let pool = approved;
    for (const r of ranges) {
      const list = approved.filter((p) => (p.createdAt || 0) >= r.since);
      if (r.key === 'all' || distinctTags(list) >= 3) { range = r; pool = list; break; }
    }

    const tagMap = new Map();
    for (const p of pool) {
      const tags = p.content.match(/#([^#\s]{1,20})#/g) || [];
      for (const t of tags) {
        const key = t.replace(/#/g, '');
        if (!tagMap.has(key)) tagMap.set(key, { tag: key, count: 0, likes: 0 });
        const item = tagMap.get(key);
        item.count += 1;
        item.likes += (p.likes || []).length;
      }
    }
    // 排序必须有确定的次级规则：热度相同再比「赞数 → 篇数 → 标签名」。
    // 否则同分名次取决于 Map 的插入顺序（= 帖子在库里的先后），谁被 slice(0,10) 截掉全凭运气，
    // 用户会觉得"榜单莫名其妙、像随机生成的"。加了次级规则后，同样的数据永远得到同样的榜单。
    const tags = [...tagMap.values()]
      .map((x) => ({ ...x, heat: x.count * 10 + x.likes }))
      .sort((a, b) => (b.heat - a.heat)
        || (b.likes - a.likes)
        || (b.count - a.count)
        || a.tag.localeCompare(b.tag, 'zh'))
      .slice(0, 10);

    const chefMap = new Map();
    for (const p of pool) {
      if (!chefMap.has(p.authorId)) chefMap.set(p.authorId, { posts: 0, likes: 0 });
      const c = chefMap.get(p.authorId);
      c.posts += 1;
      c.likes += (p.likes || []).length;
    }
    const chefs = [...chefMap.entries()]
      .map(([id, v]) => ({ user: briefUser(db.users.find((u) => u.id === id)), ...v }))
      .sort((a, b) => b.likes - a.likes)
      .slice(0, 5);

    // 「优秀饭帖」：审核员/管理员人工评优的作品。不受热门时间窗口影响，
    // 最新评优的排前面，前端右栏直接拿来渲染。
    const featuredAll = db.posts
      .filter((p) => p.featured && p.status === 'approved')
      .sort((a, b) => (b.featuredAt || 0) - (a.featuredAt || 0));
    const featured = featuredAll.slice(0, 8).map((p) => ({
      id: p.id,
      excerpt: (p.content || '').replace(/\s+/g, ' ').trim().slice(0, 56),
      image: (p.images || [])[0] || '',
      author: briefUser(db.users.find((u) => u.id === p.authorId)),
      likes: (p.likes || []).length,
      featuredAt: p.featuredAt || 0
    }));

    return json(res, 200, {
      tags, chefs,
      featured,
      featuredTotal: featuredAll.length,
      range: range.key,
      updatedAt: nowMs()
    });
  }

  /* ============ 用户主页 / 关注 ============ */

  if (pathname === '/api/users/suggest' && method === 'GET') {
    const kw = clean(query.searchParams.get('q'), 30).toLowerCase();
    /* 空查询不再吐人。以前 q 为空时按角色排序返回前 8 个 —— 管理员排第一，
       等于免费送出一份「id 种子 + 谁是站长」，是红队报告里最好用的枚举入口。 */
    if (!kw) return json(res, 200, { users: [] });
    /* 匿名加一道独立限流：全局 240 次/分钟挡不住「一分钟换 38 个字母」的慢扫。
       这个接口本来就是给「@ 找人」和「转发给别人」用的，匿名几乎用不到。 */
    if (!rateLimit('sug:' + ip + (me ? ':u' : ':a'), me ? 120 : 20, 60 * 1000)) {
      res.setHeader('Retry-After', '20');
      return json(res, 429, { error: '搜索太频繁了，歇一下再来' });
    }
    // 匿名至少两个字：把「一个字符一次请求」的扫词成本抬上去
    if (!me && kw.length < 2) return json(res, 200, { users: [] });
    let list = db.users.filter((u) => !u.banned &&
      (u.username.toLowerCase().includes(kw) || u.nickname.toLowerCase().includes(kw)));
    list.sort((a, b) => rankOf(b) - rankOf(a));
    return json(res, 200, { users: list.slice(0, me ? 8 : 5).map(briefUser) });
  }

  const userMatch = /^\/api\/users\/(\d+)$/.exec(pathname);
  if (userMatch && method === 'GET') {
    const u = db.users.find((x) => x.id === Number(userMatch[1]));
    if (!u) return json(res, 404, { error: '用户不存在' });
    const isSelf = me && me.id === u.id;
    const list = db.posts.filter((p) => p.authorId === u.id &&
      (p.status === 'approved' || isSelf || (me && rankOf(me) >= 1)));
    list.sort((a, b) => b.createdAt - a.createdAt);
    const likes = db.posts
      .filter((p) => p.authorId === u.id && p.status === 'approved')
      .reduce((s, p) => s + (p.likes || []).length, 0);
    // 关注/粉丝列表项：比 briefUser 多带简介、作品数、以及「当前登录者是否已关注 TA」
    // 前端点开列表后要直接渲染头像+简介+关注按钮，靠这些字段就够了，不必再逐个请求
    const relUser = (x) => ({
      ...briefUser(x),
      bio: x.bio || '',
      postCount: db.posts.filter((p) => p.authorId === x.id && p.status === 'approved').length,
      followerCount: db.users.filter((y) => (y.follows || []).includes(x.id)).length,
      isFollowing: me ? (me.follows || []).includes(x.id) : false,
      isMe: me ? me.id === x.id : false
    });
    // 粉丝 / 关注名单都是私密的：只有本人能看到「谁关注了我」「我关注了谁」，
    // 别人只拿到数字（数字在 publicUser 里）。必须在这里就真的不返回数组 ——
    // 只靠前端藏按钮的话，接口照样能拉到，隐私就是假的。
    const followers = isSelf
      ? db.users.filter((x) => (x.follows || []).includes(u.id)).map(relUser).slice(0, 100)
      : null;
    const following = isSelf
      ? (u.follows || []).map((id) => db.users.find((x) => x.id === id))
          .filter(Boolean).map(relUser).slice(0, 100)
      : null;
    return json(res, 200, {
      user: publicUser(u),
      posts: list.slice(0, 30).map((p) => serializePost(p, me)),
      stats: {
        posts: db.posts.filter((p) => p.authorId === u.id && p.status === 'approved').length,
        likes
      },
      followers,
      following,
      isFollowing: me ? (me.follows || []).includes(u.id) : false,
      isSelf: !!isSelf
    });
  }

  const followMatch = /^\/api\/users\/(\d+)\/follow$/.exec(pathname);
  if (followMatch && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.banned) return json(res, 403, { error: '账号已被封禁' });
    const u = db.users.find((x) => x.id === Number(followMatch[1]));
    if (!u) return json(res, 404, { error: '用户不存在' });
    if (u.id === me.id) return json(res, 400, { error: '不能关注自己' });
    me.follows = me.follows || [];
    const i = me.follows.indexOf(u.id);
    if (i >= 0) me.follows.splice(i, 1);
    else {
      me.follows.push(u.id);
      pushNote(u.id, 'follow', me.id);
    }
    saveDB();
    return json(res, 200, {
      following: me.follows.includes(u.id),
      followerCount: db.users.filter((x) => (x.follows || []).includes(u.id)).length
    });
  }

  /* ============ 私信 ============ */

  // 未读私信总数（顶栏 / 侧栏小红点用，放在 :userId 之前避免冲突）
  if (pathname === '/api/messages/unread' && method === 'GET') {
    if (!me) return json(res, 200, { unread: 0 });
    return json(res, 200, { unread: unreadDmTotal(me) });
  }

  // 会话列表：一对一私信 + 群聊，各取最后一条 + 未读条数，按时间倒序合并
  if (pathname === '/api/conversations' && method === 'GET') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const list = [];
    // —— 一对一 ——
    const map = new Map();
    for (const m of db.messages) {
      if (!m || m.toGroupId) continue;
      if (m.fromId !== me.id && m.toId !== me.id) continue;
      if (Array.isArray(m.deletedFor) && m.deletedFor.includes(me.id)) continue;
      const peerId = m.fromId === me.id ? m.toId : m.fromId;
      let c = map.get(peerId);
      if (!c) { c = { peerId: peerId, last: null, unread: 0 }; map.set(peerId, c); }
      if (!c.last || m.createdAt >= c.last.createdAt) c.last = m;
      if (m.toId === me.id && !m.read) c.unread += 1;
    }
    for (const c of map.values()) {
      const peer = db.users.find((u) => u.id === c.peerId);
      if (!peer) continue;
      list.push({
        kind: 'dm',
        peer: briefUser(peer),
        last: {
          content: c.last.recalled ? '' : c.last.content,
          recalled: !!c.last.recalled,
          createdAt: c.last.createdAt,
          mine: c.last.fromId === me.id,
          shared: !c.last.recalled && !!c.last.postId
        },
        unread: c.unread
      });
    }
    // —— 群聊 ——
    for (const g of db.groups) {
      if (!g.memberIds.includes(me.id)) continue;
      const msgs = db.messages
        .filter((m) => m.toGroupId === g.id && !(Array.isArray(m.deletedFor) && m.deletedFor.includes(me.id)))
        .sort((a, b) => a.createdAt - b.createdAt);
      const last = msgs[msgs.length - 1] || null;
      const unread = msgs.filter((m) => m.fromId !== me.id && !(m.readByIds || []).includes(me.id)).length;
      list.push({
        kind: 'group',
        group: groupOut(g, me),
        last: last ? {
          content: last.recalled ? '' : last.content,
          recalled: !!last.recalled,
          createdAt: last.createdAt,
          mine: last.fromId === me.id,
          shared: !last.recalled && !!last.postId,
          sender: last.fromId === me.id ? '' : ((db.users.find((u) => u.id === last.fromId) || {}).nickname || '')
        } : null,
        unread: unread
      });
    }
    list.sort((a, b) => ((b.last && b.last.createdAt) || 0) - ((a.last && a.last.createdAt) || 0));
    return json(res, 200, {
      conversations: list.slice(0, 120),
      unread: unreadDmTotal(me),
      canMessage: true
    });
  }

  // ---- 建群 ----
  if (pathname === '/api/groups' && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.banned) return json(res, 403, { error: '账号已被封禁，无法建群' });
    if (!rateLimit('mkgroup:' + me.id, 20, 60 * 60000)) {
      return json(res, 429, { error: '建群太频繁了，歇一会儿再来' });
    }
    const b = await readBody(req);
    const name = clean(b.name, 24);
    if (!name) return json(res, 400, { error: '群名称不能为空' });
    // 成员：去重、剔除自己（自己必然在群里）、必须真实存在
    const ids = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : []).map(Number))]
      .filter((id) => id && id !== me.id && db.users.some((u) => u.id === id));
    if (!ids.length) return json(res, 400, { error: '至少拉一位厨友进群' });
    if (ids.length > 50) return json(res, 400, { error: '一个群最多 50 人' });
    const g = {
      id: db.seq++,
      name: name,
      avatar: clean(b.avatar, 200),
      ownerId: me.id,
      memberIds: [me.id, ...ids],
      createdAt: nowMs()
    };
    db.groups.push(g);
    saveDB();
    return json(res, 200, { group: groupOut(g, me) });
  }

  // ---- 群信息 / 加人退群 ----
  const gInfo = /^\/api\/groups\/(\d+)$/.exec(pathname);
  if (gInfo) {
    const g = db.groups.find((x) => x.id === Number(gInfo[1]));
    if (!g) return json(res, 404, { error: '群不存在' });
    if (!me || !g.memberIds.includes(me.id)) return json(res, 403, { error: '你不在这个群里' });
    if (method === 'GET') return json(res, 200, { group: groupOut(g, me) });
    if (method === 'POST') { // 拉人
      const b = await readBody(req);
      const ids = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : []).map(Number))]
        .filter((id) => id && !g.memberIds.includes(id) && db.users.some((u) => u.id === id));
      if (!ids.length) return json(res, 400, { error: '没有可添加的新成员' });
      if (g.memberIds.length + ids.length > 51) return json(res, 400, { error: '一个群最多 50 人' });
      g.memberIds.push(...ids);
      saveDB();
      return json(res, 200, { group: groupOut(g, me) });
    }
    if (method === 'DELETE') { // 退群（群主退=解散）
      if (g.ownerId === me.id) {
        db.groups = db.groups.filter((x) => x.id !== g.id);
        // 群解散后清掉该群消息，避免残骸
        db.messages = db.messages.filter((m) => m.toGroupId !== g.id);
      } else {
        g.memberIds = g.memberIds.filter((id) => id !== me.id);
      }
      saveDB();
      return json(res, 200, { ok: true });
    }
  }

  // ---- 群消息：拉取 / 发送 ----
  const gMsg = /^\/api\/groups\/(\d+)\/messages$/.exec(pathname);
  if (gMsg) {
    if (!me) return json(res, 401, { error: '请先登录' });
    const g = db.groups.find((x) => x.id === Number(gMsg[1]));
    if (!g) return json(res, 404, { error: '群不存在' });
    if (!g.memberIds.includes(me.id)) return json(res, 403, { error: '你不在这个群里' });

    if (method === 'GET') {
      const after = Math.max(0, Number(query.searchParams.get('after') || 0));
      const all = db.messages
        .filter((m) => m.toGroupId === g.id)
        .sort((a, b) => a.createdAt - b.createdAt);
      // 进群即把「我未读」的群消息标记已读
      let changed = false;
      for (const m of all) {
        m.readByIds = m.readByIds || [];
        if (m.fromId !== me.id && !m.readByIds.includes(me.id)) { m.readByIds.push(me.id); changed = true; }
      }
      if (changed) saveDB();
      const list = after ? all.filter((m) => m.id > after) : all.slice(-200);
      return json(res, 200, {
        group: groupOut(g, me),
        messages: list.map((x) => msgOut(x, me)).filter(Boolean)
      });
    }

    if (method === 'POST') {
      if (me.banned) return json(res, 403, { error: '账号已被封禁，无法发送消息' });
      if (!rateLimit('gm:' + me.id, 300, 60 * 60000)) {
        return json(res, 429, { error: '发得太快了，慢一点再来 😅' });
      }
      const b = await readBody(req);
      const content = clean(b.content, 1000);
      let postId = 0;
      if (b.postId) {
        const p = db.posts.find((x) => x.id === Number(b.postId));
        if (!p || (p.status !== 'approved' && p.authorId !== me.id)) {
          return json(res, 404, { error: '要转发的内容不存在或已不可见' });
        }
        postId = p.id;
      }
      if (!content && !postId) return json(res, 400, { error: '消息不能为空' });
      const quoteId = Number(b.quoteId) || 0;
      const m = {
        id: db.seq++, fromId: me.id, toId: 0, toGroupId: g.id,
        content, createdAt: nowMs(), read: false, readByIds: [me.id]
      };
      if (postId) m.postId = postId;
      if (quoteId) m.quoteId = quoteId;
      db.messages.push(m);
      if (db.messages.length > 20000) db.messages = db.messages.slice(-20000);
      saveDB();
      return json(res, 200, { message: msgOut(m, me) });
    }
  }

  const msgMatch = /^\/api\/messages\/(\d+)$/.exec(pathname);
  if (msgMatch) {
    if (!me) return json(res, 401, { error: '请先登录' });
    const peer = db.users.find((u) => u.id === Number(msgMatch[1]));
    if (!peer) return json(res, 404, { error: '用户不存在' });
    if (peer.id === me.id) return json(res, 400, { error: '不能给自己发私信' });

    // 聊天记录：默认返回最近 200 条；带 after= 时只回增量（轮询用）
    if (method === 'GET') {
      const after = Math.max(0, Number(query.searchParams.get('after') || 0));
      const all = db.messages
        .filter((m) => !m.toGroupId &&
          ((m.fromId === me.id && m.toId === peer.id) || (m.fromId === peer.id && m.toId === me.id)))
        .sort((a, b) => a.createdAt - b.createdAt);
      // 打开会话即视为已读（轮询时同样会把新到消息标为已读——用户正看着呢）
      let changed = false;
      for (const m of all) {
        if (m.toId === me.id && !m.read) { m.read = true; changed = true; }
      }
      if (changed) saveDB();
      const list = after ? all.filter((m) => m.id > after) : all.slice(-200);
      return json(res, 200, {
        peer: briefUser(peer),
        relation: relationTag(me, peer),
        messages: list.map((m) => msgOut(m, me)).filter(Boolean)
      });
    }

    if (method === 'POST') {
      if (me.banned) return json(res, 403, { error: '账号已被封禁，无法发送私信' });
      if (!rateLimit('dm:' + me.id, 200, 60 * 60000)) {
        return json(res, 429, { error: '发得太快了，慢一点再来 😅' });
      }
      const b = await readBody(req);
      const content = clean(b.content, 1000);
      // 转发：把一条帖子作为卡片发过来。只允许转发「已通过」的、或自己发的帖子，
      // 否则未过审/被下架的内容会借私信绕开审核被看到。
      let postId = 0;
      if (b.postId) {
        const p = db.posts.find((x) => x.id === Number(b.postId));
        if (!p || (p.status !== 'approved' && p.authorId !== me.id)) {
          return json(res, 404, { error: '要转发的内容不存在或已不可见' });
        }
        postId = p.id;
      }
      if (!content && !postId) return json(res, 400, { error: '消息不能为空' });
      const quoteId = Number(b.quoteId) || 0;
      const m = { id: db.seq++, fromId: me.id, toId: peer.id, content, createdAt: nowMs(), read: false };
      if (postId) m.postId = postId;
      if (quoteId) m.quoteId = quoteId;
      db.messages.push(m);
      // 只保留最近两万条，避免单聊跑太久把库撑爆
      if (db.messages.length > 20000) db.messages = db.messages.slice(-20000);
      saveDB();
      return json(res, 200, { message: msgOut(m, me) });
    }
  }

  // ---- 撤回（2 分钟内、仅本人） / 仅自己删除 ----
  const mAct = /^\/api\/messages\/(\d+)\/(recall|delete)$/.exec(pathname);
  if (mAct && method === 'POST') {
    if (!me) return json(res, 401, { error: '请先登录' });
    const m = db.messages.find((x) => x.id === Number(mAct[1]));
    if (!m) return json(res, 404, { error: '消息不存在' });
    // 群消息：必须还在群里；一对一：必须是自己发的 / 发给自己的
    const inGroup = m.toGroupId && (db.groups.find((g) => g.id === m.toGroupId) || {}).memberIds;
    if (m.toGroupId ? !(inGroup && inGroup.includes(me.id)) : (m.fromId !== me.id && m.toId !== me.id)) {
      return json(res, 403, { error: '你无权操作这条消息' });
    }
    if (mAct[2] === 'recall') {
      if (m.fromId !== me.id) return json(res, 403, { error: '只能撤回自己发的消息' });
      if (m.recalled) return json(res, 400, { error: '这条消息已经撤回了' });
      if (nowMs() - m.createdAt > 2 * 60 * 1000) {
        return json(res, 400, { error: '超过 2 分钟的消息不能撤回了' });
      }
      m.recalled = true;
      m.recalledAt = nowMs();
      saveDB();
      return json(res, 200, { ok: true, id: m.id });
    }
    // delete：只对自己隐藏
    m.deletedFor = m.deletedFor || [];
    if (!m.deletedFor.includes(me.id)) m.deletedFor.push(me.id);
    saveDB();
    return json(res, 200, { ok: true, id: m.id });
  }

  return json(res, 404, { error: '接口不存在' });
}

/** 一对一未读私信总数（不含群） */
function unreadDmTotal(me) {
  return db.messages.filter((m) => !m.toGroupId && m.toId === me.id && !m.read &&
    !(Array.isArray(m.deletedFor) && m.deletedFor.includes(me.id))).length;
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                             */
/* ------------------------------------------------------------------ */

const IMMUTABLE = /\.(webp|png|jpe?g|gif|svg|ico|woff2?)$/i;

/* ------------------------------------------------------------------ */
/* 过载保护（应用层「抗 DDoS」）                                         */
/*                                                                     */
/* 这里要分清两件事，否则会给出虚假的安全感：                              */
/*   L3/L4 —— SYN 洪水、几十 Gbps 纯流量。任何应用代码都挡不住，           */
/*            只能靠平台/云厂商的清洗与带宽冗余。代码层面能做的是别被打崩。 */
/*   L7    —— 几千并发、慢速连接、扫描器、刷接口。这一层归这里管。          */
/*                                                                     */
/* 三道闸：                                                              */
/*   1) 在途并发上限（全站 + 单 IP）：超了立刻 503，不排队、不攒内存。       */
/*      限流管的是「一分钟多少次」，管不住「同时挂 5000 个请求」。          */
/*   2) 事件循环延迟监控：进程已经被 CPU 打满时，只保静态页和 /api/me，     */
/*      其余回 503。宁可少服务几个，也别让所有人一起卡死（雪崩）。          */
/*   3) 静态资源进内存 + ETag/304：被反复刷也不产生磁盘 I/O。              */
/* ------------------------------------------------------------------ */

const MAX_INFLIGHT_TOTAL = 200;   // 全站在途请求
const MAX_INFLIGHT_PER_IP = 28;   // 单 IP 在途请求（一个页面并发加载也就 10 来个）

let inflightTotal = 0;
const inflightIp = new Map();

/** 进门：占一个并发名额。返回「出门」函数；满了返回 null。 */
function enterDoor(req) {
  if (inflightTotal >= MAX_INFLIGHT_TOTAL) return null;
  const ip = clientIp(req);
  const n = inflightIp.get(ip) || 0;
  if (n >= MAX_INFLIGHT_PER_IP) return null;
  inflightTotal += 1;
  inflightIp.set(ip, n + 1);
  let open = true;
  return function leave() {
    if (!open) return;
    open = false;
    inflightTotal -= 1;
    const k = inflightIp.get(ip);
    if (k === undefined) return;
    if (k <= 1) inflightIp.delete(ip);   // 归零就删 key，Map 不会随 IP 数无限涨
    else inflightIp.set(ip, k - 1);
  };
}

/* 事件循环延迟 = 进程「喘不喘得过来」的唯一可信指标。
   正常 20~40ms（受 resolution 影响）；被打满时几百毫秒起。
   用 p95 而不是最大值：一次 GC 抖动不该触发全站降级。 */
const loopLag = monitorEventLoopDelay({ resolution: 20 });
loopLag.enable();

let lagP95 = 0;
let overloaded = false;

setInterval(() => {
  lagP95 = Math.round(loopLag.percentile(95) / 1e6);
  if (lagP95 > 400 || inflightTotal >= MAX_INFLIGHT_TOTAL) overloaded = true;
  else if (lagP95 < 150 && inflightTotal < MAX_INFLIGHT_TOTAL / 2) overloaded = false;
  loopLag.reset();
}, 2000).unref();

/** 503：带上 Retry-After 让正常客户端退避，而不是立刻重试雪上加霜 */
function tooBusy(res, waitSec) {
  res.setHeader('Retry-After', String(waitSec || 3));
  return json(res, 503, { error: '现在访问的人有点多，请稍等几秒再试' });
}

/** 静态资源里绝不该被访问到的东西：备份/源码/点文件/库文件。
   即便 public/ 下误放了这些文件，也直接 404，避免源码/数据泄露。 */
const STATIC_DENY = /(^|\/)(\.|_)|\.(json|js\.map|md|db|sqlite|bak|log|env|yml|yaml|ts|tsx|sh|py)$/i;

/* 扫站器/漏洞扫描器的典型路径。命中连 fs 都不碰，直接 404 ——
   否则一波「/wp-admin、/.git/config、/phpmyadmin...」探测就是成千上万次磁盘查询。 */
const SCAN_DENY = /(^|\/)(wp-admin|wp-includes|wp-content|wp-login|xmlrpc|phpmyadmin|pma|admin|setup|install|config|cgi-bin|vendor|node_modules|\.git|\.svn|\.aws|\.idea)(\/|\.|$)/i;
const SCAN_EXT = /\.(php\d?|phtml|asp|aspx|jsp|jspx|cgi|pl|rb|sql|ini|conf|cfg|htaccess|htpasswd|zip|tar|tgz|gz|rar|7z|swp|swo|old|orig|save|bak|tmp|xml|properties)$/i;

/* 小文件内存缓存：index.html / app.js / style.css / 几十张配图 —— 全站静态资源
   一共几百 KB，放内存换掉每次的 stat + open + read 三次系统调用。
   被刷时这些请求只剩一次 writeHead + write，磁盘完全不动。
   用户上传的 /uploads/ 不进缓存（数量无上限，会吃光内存）。 */
const SCACHE_TTL = 2500;
const SCACHE_PER_FILE = 320 * 1024;
const SCACHE_MAX = 80;
const scache = new Map();

function staticNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end('404 Not Found');
}

function ifNoneMatchHit(req, etag) {
  const inm = String(req.headers['if-none-match'] || '');
  if (!inm) return false;
  return inm.split(',').some((t) => t.trim() === etag || t.trim() === '*');
}

function sendStaticCached(req, res, ent) {
  if (ifNoneMatchHit(req, ent.etag)) {
    res.writeHead(304, securityHeaders(req, { ETag: ent.etag, 'Cache-Control': ent.cc }));
    return res.end();
  }
  res.writeHead(200, securityHeaders(req, {
    'Content-Type': ent.type,
    'Cache-Control': ent.cc,
    'Content-Length': ent.buf.length,
    ETag: ent.etag
  }));
  return res.end(ent.buf);
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); }
  catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 目录路径（如 /intro/）自动补 index.html，这样介绍页可以用干净的 /intro/ 访问
  else if (rel.endsWith('/')) rel += 'index.html';
  // 含空字节直接拒（老版本 path 截断漏洞）
  if (rel.indexOf('\0') >= 0) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  // 路径穿越拦截：规范化后必须仍在 public/ 内
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  // 敏感文件（源码/备份/地图/点文件）与扫描路径都不给，连存在性都不暴露
  if (STATIC_DENY.test('/' + safe) || SCAN_DENY.test(safe) || SCAN_EXT.test(safe)) {
    return staticNotFound(res);
  }

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const cc = IMMUTABLE.test(file) ? 'public, max-age=86400' : 'no-cache';
  const now = Date.now();

  const ent = scache.get(file);
  if (ent && now - ent.at < SCACHE_TTL) return sendStaticCached(req, res, ent);

  let st;
  try { st = await fsp.stat(file); }
  catch (e) { scache.delete(file); return staticNotFound(res); }
  if (!st.isFile()) { scache.delete(file); return staticNotFound(res); }

  // 缓存过期但文件没变（重新部署前最常见）→ 只刷新时间戳，不重读内容
  if (ent && st.size === ent.size && Math.floor(st.mtimeMs) === ent.mtime) {
    ent.at = now;
    return sendStaticCached(req, res, ent);
  }

  const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const cacheable = st.size <= SCACHE_PER_FILE && !safe.startsWith('uploads' + path.sep) &&
    !safe.startsWith('uploads/');

  if (!cacheable) {
    if (ifNoneMatchHit(req, etag)) {
      res.writeHead(304, securityHeaders(req, { ETag: etag, 'Cache-Control': cc }));
      return res.end();
    }
    res.writeHead(200, securityHeaders(req, {
      'Content-Type': type,
      'Cache-Control': cc,
      'Content-Length': st.size,
      ETag: etag
    }));
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }

  let buf;
  try { buf = await fsp.readFile(file); }
  catch (e) { return staticNotFound(res); }

  const fresh = { buf, etag, type, cc, at: now, size: st.size, mtime: Math.floor(st.mtimeMs) };
  if (scache.size >= SCACHE_MAX) scache.delete(scache.keys().next().value);
  scache.set(file, fresh);
  return sendStaticCached(req, res, fresh);
}

/* ------------------------------------------------------------------ */
/* 安全监控台（SOC）                                                     */
/*                                                                     */
/* 解决一个具体问题：**「安静地被抄一遍」是看不见的**。                    */
/* 搬砖式限流挡得住爆破（一分钟几百次），挡不住爬虫（一分钟几十次，          */
/* 跟正常人刷页面一模一样）。所以除了「次数」，还得看「形状」：            */
/*   - 一分钟里翻了多少个**不同**的用户主页 → 遍历用户表                  */
/*   - 换了多少个**不同**的搜索词 → 扫字符集                             */
/*   - 404 有多少 → 扫站器                                               */
/*   - 401/403 有多少 → 在探权限                                         */
/*   - UA 是不是脚本（curl / python / scrapy / headless…）                */
/*   - 请求速率                                                          */
/* 合成分数，过线自动封 IP，同时把每一条证据留在控制台上，能一眼看懂。       */
/*                                                                     */
/* 为什么全部放内存里：被刷时磁盘日志每秒几百行，写爆是迟早的事；而且         */
/* 「事后翻日志」等于没有告警。这里内存滚动(3000 条)、只把**事件**落盘。      */
/* ------------------------------------------------------------------ */

const OPS_WIN = 60 * 1000;          // 画像窗口
const OPS_ID_WIN = 5 * 60 * 1000;   // 「翻过多少个人」按 5 分钟算，否则慢爬永远不触发
const OPS_ACCESS_MAX = 3000;        // 访问环形缓冲条数
const OPS_IP_MAX = 4000;            // 同时跟踪的 IP 上限
const OPS_BLOCK_SCORE = 60;         // 到这个分数自动封
const OPS_FLAG_SCORE = 30;          // 到这个分数先记一笔「可疑」
const OPS_PATH_MAX = 96;
const OPS_BOT_RE = /(curl|wget|python|requests|urllib|aiohttp|httpx|scrapy|go-http-client|java\/|okhttp|libwww|httpclient|phantomjs|headless|puppeteer|playwright|selenium|node-fetch|axios|postmanruntime|insomnia|masscan|nmap|zgrab|nuclei|nikto|sqlmap|dirbuster|gobuster|ffuf)/i;

/* ---- 封禁名单（落库，重启/重新部署都还在）---- */
if (!Array.isArray(db.blocked)) db.blocked = [];
const blockIndex = new Map();       // ip -> { ip, until, reason, by, at, auto, hits }
for (const b of db.blocked) if (b && b.ip) blockIndex.set(b.ip, b);

/** 管理员登录过的 IP：永不自动封禁（自己把自己锁在门外是最蠢的运维事故） */
const adminIps = new Map();

function opsTrusted(ip) {
  if (!ip || ip === 'unknown' || ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return true;
  for (const p of IP_ALLOW_CFG) {
    if (p.endsWith('*') ? ip.startsWith(p.slice(0, -1)) : ip === p) return true;
  }
  const t = adminIps.get(ip);
  return !!(t && nowMs() - t < 7 * 24 * H);
}

function blockedEntry(ip) {
  const e = blockIndex.get(ip);
  if (!e) return null;
  if (e.until && nowMs() > e.until) { blockIndex.delete(ip); return null; }
  return e;
}

function setBlock(ip, minutes, reason, by, auto) {
  const clean = normalizeIp(ip);
  if (!clean || clean === 'unknown') return null;
  const now = nowMs();
  const prev = blockIndex.get(clean);
  const e = {
    ip: clean,
    at: now,
    until: now + Math.max(1, minutes) * 60000,
    reason: String(reason || '').slice(0, 120),
    by: String(by || (auto ? 'auto' : 'manual')).slice(0, 40),
    auto: !!auto,
    hits: prev ? prev.hits || 0 : 0
  };
  blockIndex.set(clean, e);
  const i = db.blocked.findIndex((b) => b && b.ip === clean);
  if (i >= 0) db.blocked[i] = e; else db.blocked.push(e);
  saveDB();
  secLog('ip_block', null, { ip: clean, min: minutes, reason: e.reason, by: e.by, auto: !!auto });
  return e;
}

function clearBlock(ip) {
  const clean = normalizeIp(ip);
  const had = blockIndex.delete(clean);
  const before = db.blocked.length;
  db.blocked = db.blocked.filter((b) => !b || b.ip !== clean);
  // 连画像一起清零：否则「解封」之后分数还挂在那儿，下一个请求立刻又被自动封回去，
  // 管理员会以为按钮坏了。
  const w = ipWatch.get(clean);
  if (w) {
    w.score = 0; w.peak = 0; w.flagged = 0; w.blockedAt = 0;
    w.ids.clear(); w.qs.clear(); w.pids.clear();
    w.s1 = 0; w.s2 = 0; w.s3 = 0; w.s4 = 0; w.s5 = 0; w.scan = 0;
  }
  if (had || db.blocked.length !== before) {
    saveDB();
    secLog('ip_unblock', null, { ip: clean });
  }
  return had;
}

/* 过期条目每天清一次；保留 7 天是为了让控制台能显示「这个 IP 被封过几次」 */
setInterval(() => {
  const now = nowMs();
  db.blocked = db.blocked.filter((b) => b && b.until && b.until > now - 7 * 24 * H);
  for (const [ip, e] of blockIndex) if (e.until && now > e.until) blockIndex.delete(ip);
  for (const [ip, t] of adminIps) if (now - t > 7 * 24 * H) adminIps.delete(ip);
}, 10 * 60000).unref();

/* ---- 访问环形缓冲 ---- */
const accessRing = new Array(OPS_ACCESS_MAX);
let accessHead = 0;
let accessCount = 0;
let accessSeq = 0;

function pushAccess(ev) {
  accessRing[accessHead] = ev;
  accessHead = (accessHead + 1) % OPS_ACCESS_MAX;
  if (accessCount < OPS_ACCESS_MAX) accessCount += 1;
}

/** 取 seq 之后的访问事件（控制台增量拉取用），最多 limit 条 */
function accessSince(sinceSeq, limit) {
  const max = Math.min(Number(limit) || 80, 200);
  const out = [];
  for (let i = 1; i <= accessCount && out.length < max; i++) {
    const idx = (accessHead - i + OPS_ACCESS_MAX * 2) % OPS_ACCESS_MAX;
    const ev = accessRing[idx];
    if (!ev || ev.seq <= sinceSeq) break;
    out.push(ev);
  }
  out.reverse();
  return out;
}

/* ---- 每 IP 的行为画像 ---- */
const ipWatch = new Map();

function sweepWatch(now) {
  for (const [ip, w] of ipWatch) if (now - w.last > 15 * 60000) ipWatch.delete(ip);
  if (ipWatch.size <= OPS_IP_MAX) return;
  // 还超就按「最久没动」砍掉四分之一
  const arr = [...ipWatch.entries()].sort((a, b) => a[1].last - b[1].last);
  for (let i = 0; i < Math.ceil(arr.length / 4); i++) ipWatch.delete(arr[i][0]);
}

function watchOf(ip, now) {
  let w = ipWatch.get(ip);
  if (!w) {
    if (ipWatch.size >= OPS_IP_MAX) sweepWatch(now);
    const win = Math.floor(now / OPS_WIN);
    w = {
      ip, win, idsWin: win, n: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0,
      ids: new Set(), qs: new Set(), pids: new Set(),
      scan: 0, bot: 0, ua: '', last: now, first: now,
      score: 0, flagged: 0, peak: 0, blockedAt: 0,
      lastPath: '', paths: []
    };
    ipWatch.set(ip, w);
    return w;
  }
  const win = Math.floor(now / OPS_WIN);
  if (w.win !== win) {
    // 跨窗口：计数清零，分数保留 40%（连续两窗都超线 → 更快命中）
    w.score = Math.round(w.score * 0.4);
    w.win = win; w.n = 0; w.s1 = 0; w.s2 = 0; w.s3 = 0; w.s4 = 0; w.s5 = 0; w.scan = 0;
    if (win - w.idsWin >= OPS_ID_WIN / OPS_WIN) { w.ids.clear(); w.qs.clear(); w.pids.clear(); w.idsWin = win; }
  }
  w.last = now;
  return w;
}

/**
 * 记一次访问 + 更新画像。返回该 IP 是否应被封（已封的返回 false，不重复处理）。
 * 必须是「只做加法」的：任何异常都不能影响响应，所以整段包了 try。
 */
function noteAccess(req, pathname, code, ms) {
  try {
    /* 控制台自己的轮询不进流水：2 秒一次、每次两条，全是管理员自己点出来的，
       混在实时表里只会让人误以为「有人在扫」。 */
    if (pathname.startsWith('/api/ops/')) return;
    const now = nowMs();
    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '').slice(0, 90);
    const method = String(req.method || 'GET');

    pushAccess({
      seq: ++accessSeq, t: now, ip, m: method,
      p: pathname.length > OPS_PATH_MAX ? pathname.slice(0, OPS_PATH_MAX) + '…' : pathname,
      c: code, ms: ms | 0, ua, sfs: String(req.headers['sec-fetch-site'] || '').slice(0, 12)
    });

    const w = watchOf(ip, now);
    w.n += 1;
    w.ua = ua || w.ua;
    w.lastPath = pathname;
    if (code === 401) w.s1 += 1;
    else if (code === 403) w.s3 += 1;
    else if (code === 404) w.s4 += 1;
    else if (code === 429) w.s2 += 1;
    else if (code >= 500) w.s5 += 1;
    if (w.paths.length < 40 && w.paths[w.paths.length - 1] !== pathname) w.paths.push(pathname);

    if (!w.bot && ua && OPS_BOT_RE.test(ua)) w.bot = 12;

    // 用户主页遍历：这是红队报告里最便宜的拖库路径
    const um = /^\/api\/users\/(\d+)$/.exec(pathname);
    if (um) w.ids.add(Number(um[1]));
    const pm = /^\/api\/posts\/(\d+)$/.exec(pathname);
    if (pm) w.pids.add(Number(pm[1]));
    // 搜索联想：换关键词扫字符集（一次请求换 8 个账号，比扫 id 划算得多）
    if (pathname === '/api/users/suggest' || pathname === '/api/search') {
      const raw = String(req.url || '');
      const qi = raw.indexOf('?');
      if (qi >= 0) {
        try {
          const q = new URLSearchParams(raw.slice(qi + 1)).get('q');
          if (q) w.qs.add(String(q).toLowerCase().slice(0, 20));
        } catch (e2) { /* 无所谓 */ }
      }
    }
    // 扫站器/漏洞扫描路径
    if (pathname !== '/' && (SCAN_DENY.test(pathname) || SCAN_EXT.test(pathname))) w.scan += 1;

    /* ---- 合成分数 ----
       原则：**单一弱信号不许直接封人**。每项都有上限，任何一项单独都到不了 60，
       必须有第二类证据（脚本 UA、404、扫路径、高频）叠加才封。
       理由：一个刚来的人可能一分钟点开十几个作者主页，那不是攻击；
       但「翻十几个主页 + python-requests」基本就不是人了。 */
    let s = 0;
    if (w.ids.size > 8) s += Math.min(40, (w.ids.size - 8) * 6);    // 遍历用户主页
    if (w.qs.size > 8) s += Math.min(40, (w.qs.size - 8) * 6);      // 换搜索词扫人
    if (w.pids.size > 40) s += Math.min(30, (w.pids.size - 40) * 2);
    if (w.n > 200) s += Math.min(50, (w.n - 200) / 4);
    if (w.s4 > 15) s += Math.min(50, (w.s4 - 15) * 4);              // 404 = 在猜路径
    if (w.s3 > 15) s += Math.min(50, (w.s3 - 15) * 4);              // 403 = 在探权限
    if (w.scan > 0) s += Math.min(60, w.scan * 30);                 // 一扫 /wp-admin 就基本实锤
    s += w.bot;
    w.score = Math.round(s);
    if (w.score > w.peak) w.peak = w.score;

    /* ---- 事件：先记一笔，再决定要不要封 ---- */
    if (w.ids.size === 10 || w.qs.size === 10) {
      secLog('enum_suspect', req, { ids: w.ids.size, q: w.qs.size, hits: w.n, path: pathname });
    }
    if (w.score >= OPS_FLAG_SCORE && (!w.flagged || now - w.flagged > 5 * 60000)) {
      w.flagged = now;
      secLog('probe_suspect', req, {
        score: w.score, ids: w.ids.size, q: w.qs.size, s404: w.s4, s403: w.s3,
        scan: w.scan, bot: !!w.bot, path: pathname
      });
    }

    /* ---- 自动封禁 ---- */
    if (w.score >= OPS_BLOCK_SCORE && !opsTrusted(ip) && !blockedEntry(ip)) {
      // 安全阀：如果到现在只见过一个 IP，多半是代理没透传真实地址，
      // 这时封了等于封所有人 —— 宁可不封。
      // 另一个安全阀：同一 IP 一分钟内不重复判一次，避免「被封后还在打」被算成
      // 二次、三次违规，直接把 15 分钟升到 24 小时。
      if (ipWatch.size > 1 && (!w.blockedAt || now - w.blockedAt > 60000)) {
        const times = db.blocked.filter((b) => b && b.ip === ip).length;
        const mins = times === 0 ? 15 : times === 1 ? 60 : 1440;
        setBlock(ip, mins, '行为分 ' + w.score + '（翻 ' + w.ids.size + ' 个主页 / ' +
          w.qs.size + ' 个搜索词 / ' + w.s4 + ' 次 404）', 'auto', true);
        w.blockedAt = now;
      }
    }
  } catch (e) { /* 监控永不影响业务 */ }
}

/** 被封 IP 的回应：API 回 JSON，页面回一张小卡片 */
function opsBlockedReply(res, pathname, e) {
  res.setHeader('Retry-After', String(Math.max(60, Math.ceil((e.until - nowMs()) / 1000))));
  if (pathname.startsWith('/api/')) {
    return json(res, 403, {
      error: '你的访问已被限制。如果认为这是误判，请联系管理员。',
      code: 'IP_BLOCKED'
    });
  }
  res.writeHead(403, securityHeaders(res._req, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'
  }));
  res.end('<!doctype html><meta charset="utf-8"><title>访问受限</title>' +
    '<div style="font:600 15px/1.9 system-ui,-apple-system,sans-serif;color:#40291b;' +
    'background:#fff8ee;border:2.5px solid #40291b;border-radius:18px;box-shadow:4px 4px 0 #40291b;' +
    'max-width:420px;margin:14vh auto;padding:26px 28px">' +
    '<b style="font-size:18px">访问已被限制</b><p style="margin:10px 0 0;color:#7a5c48">' +
    '系统检测到这个地址的访问行为异常（高频遍历 / 扫描），已临时限制访问。<br>' +
    '如果这是一次误判，请联系站点管理员解除。</p></div>');
}

/** 服务端自己也可以主动「看一眼」某个 IP —— 控制台详情页用 */
function watchSummary(w) {
  return {
    ip: w.ip, score: w.score, peak: w.peak, n: w.n, ids: w.ids.size, qs: w.qs.size,
    pids: w.pids.size, s401: w.s1, s429: w.s2, s403: w.s3, s404: w.s4, s5: w.s5,
    scan: w.scan, bot: w.bot > 0, ua: w.ua, last: w.last, first: w.first,
    lastPath: w.lastPath, paths: w.paths.slice(-12)
  };
}

/* ---- security.log 尾部（控制台「安全事件」面板）---- */
let opsEvCache = { at: 0, list: [] };
function opsEventTail(limit) {
  const now = Date.now();
  if (now - opsEvCache.at > 2000) {
    const list = [];
    try {
      const st = fs.statSync(SEC_LOG);
      const bytes = Math.min(96 * 1024, st.size);
      const fd = fs.openSync(SEC_LOG, 'r');
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, st.size - bytes);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && list.length < 200; i--) {
        const s = lines[i].trim();
        if (!s) continue;
        try { list.push(JSON.parse(s)); } catch (e2) { /* 半行跳过 */ }
      }
    } catch (e) { /* 没有日志文件 */ }
    opsEvCache = { at: now, list };
  }
  return opsEvCache.list.slice(0, Math.min(Number(limit) || 60, 200)).reverse();
}

/* ---- 控制台接口 ---- */

function opsDenied(res) {
  res.writeHead(403, securityHeaders(res._req, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'
  }));
  res.end('<!doctype html><meta charset="utf-8"><title>没有权限</title>' +
    '<div style="font:600 15px/1.9 system-ui,-apple-system,sans-serif;color:#40291b;' +
    'background:#fff8ee;border:2.5px solid #40291b;border-radius:18px;box-shadow:4px 4px 0 #40291b;' +
    'max-width:420px;margin:14vh auto;padding:26px 28px">' +
    '<b style="font-size:18px">这不是给你的页面</b><p style="margin:10px 0 0;color:#7a5c48">' +
    '安全控制台只对管理员开放。如果你确定自己有权限，先到 <a href="/" style="color:#f2682a">首页</a> 登录。</p></div>');
}

/** IPv4 / IPv6 / 1.2.3.* 这类简单通配。不追求严谨，只挡明显乱填的东西。 */
function validIpPattern(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split('.').every((n) => Number(n) <= 255);
  if (/^\d{1,3}(\.\d{1,3}){2}\.\*$/.test(v)) return true;
  return /^[0-9a-f:.]{3,45}$/i.test(v) && v.includes(':');
}

async function handleOps(req, res, pathname, query, me) {
  me = me || currentUser(req);
  if (!me || rankOf(me) < 2) {
    secLog('ops_denied', req, { path: pathname });
    return json(res, 403, { error: '只有管理员能进安全控制台', code: 'OPS_FORBIDDEN' });
  }
  const method = req.method;
  if (!rateLimit('ops:' + me.id, 1200, 60 * 1000)) {
    return json(res, 429, { error: '刷得太快了' });
  }

  if (pathname === '/api/ops/overview' && method === 'GET') {
    const now = nowMs();
    // 最近 60 秒的请求数（环形缓冲本身就是按时间顺序写的；head 指向下一个待写槽位，从 i=1 开始）
    let rate = 0;
    for (let i = 1; i <= accessCount; i++) {
      const ev = accessRing[(accessHead - i + OPS_ACCESS_MAX * 2) % OPS_ACCESS_MAX];
      if (!ev) break;
      if (now - ev.t > OPS_WIN) break;
      rate += 1;
    }
    const active = [...blockIndex.values()].filter((b) => b.until > now);
    const threats = [...ipWatch.values()]
      .filter((w) => now - w.last < 10 * 60000)
      .map(watchSummary)
      .sort((a, b) => b.score - a.score || b.n - a.n)
      .slice(0, 14);
    return json(res, 200, {
      now,
      up: Math.round(process.uptime()),
      inflight: inflightTotal,
      lag: lagP95,
      overloaded,
      rate,
      ips: ipWatch.size,
      blocked: active.length,
      seq: accessSeq,
      stats: {
        users: db.users.length,
        posts: db.posts.length,
        pending: db.posts.filter((p) => p.status === 'pending').length
      },
      threats,
      events: opsEventTail(40),
      blocks: active.map((b) => ({
        ip: b.ip, until: b.until, reason: b.reason, by: b.by, auto: !!b.auto,
        hits: b.hits || 0, at: b.at
      })).sort((a, b) => b.hits - a.hits || b.until - a.until).slice(0, 60)
    });
  }

  if (pathname === '/api/ops/feed' && method === 'GET') {
    const after = Number(query.searchParams.get('after') || 0) || 0;
    return json(res, 200, { seq: accessSeq, events: accessSince(after, 140) });
  }

  if (pathname === '/api/ops/ip' && method === 'GET') {
    const ip = normalizeIp(query.searchParams.get('ip') || '');
    const w = ipWatch.get(ip);
    const evs = [];
    for (let i = 0; i < accessCount && evs.length < 60; i++) {
      const ev = accessRing[(accessHead - i + OPS_ACCESS_MAX * 2) % OPS_ACCESS_MAX];
      if (!ev) break;
      if (ev.ip === ip) evs.push(ev);
    }
    const e = blockIndex.get(ip);
    return json(res, 200, {
      ip,
      watch: w ? watchSummary(w) : null,
      events: evs,
      block: e && e.until > nowMs() ? { until: e.until, reason: e.reason, by: e.by, auto: !!e.auto } : null,
      trusted: opsTrusted(ip)
    });
  }

  if (pathname === '/api/ops/block' && method === 'POST') {
    const b = await readBody(req);
    const ip = String(b.ip || '').trim();
    if (!validIpPattern(ip)) return json(res, 400, { error: 'IP 格式不对' });
    const mins = Math.max(1, Math.min(43200, Number(b.minutes) || 60));
    const e = setBlock(ip, mins, clean(b.reason, 100) || '管理员手动封禁', me.username, false);
    return json(res, 200, { ok: true, block: e });
  }

  if (pathname === '/api/ops/unblock' && method === 'POST') {
    const b = await readBody(req);
    const ip = String(b.ip || '').trim();
    if (!ip) return json(res, 400, { error: '缺 IP' });
    return json(res, 200, { ok: clearBlock(ip) });
  }

  if (pathname === '/api/ops/events' && method === 'GET') {
    const lim = Number(query.searchParams.get('limit') || 60) || 60;
    return json(res, 200, { events: opsEventTail(lim) });
  }

  return json(res, 404, { error: '接口不存在' });
}

/* ------------------------------------------------------------------ */
/* 服务器                                                               */
/* ------------------------------------------------------------------ */

/* 最后一道保险：漏网的异常 / 未处理的 Promise 只记日志，不让进程直接退出。
   对小站来说「被一个畸形请求打挂」比「带病运行」更糟；数据都同步落盘成 JSON，不会因不退出而丢。
   注意：正常业务错误必须在 handler 里 try/catch 处理掉，这里只是兜底，不该被依赖。 */
process.on('uncaughtException', (e) => console.error('[uncaught]', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));

const server = http.createServer(async (req, res) => {
  // json()/安全头需要拿到 req（判断 HTTPS、来源），挂到 res 上
  res._req = req;

  /* 第一道闸：在途并发。放在最前面，连 URL 解析都不做 ——
     被灌的时候最贵的东西是「让每个请求都跑完整条处理链路」。 */
  const leave = enterDoor(req);
  if (!leave) return tooBusy(res, 3);
  res.once('close', leave);   // 正常结束/客户端断开都会触发，名额一定还回去

  /* req.url 以 // 开头时（如 `GET //`），new URL 会把它当成「协议相对地址」直接抛
     ERR_INVALID_URL。以前这段写在 try 外面 → 一个 GET // 就能把整个进程打挂（DoS）。
     现在：先把开头的连续斜杠压成一个，解析仍失败就回 400，绝不让异常逃出去。 */
  let u;
  let pathname = '/';
  try {
    u = new URL(String(req.url || '/').replace(/^\/+/, '/'), 'http://localhost');
    pathname = u.pathname;
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }
  /* 已封禁的 IP 在解析完路径后立刻打回：不查库、不走业务、不进静态服务。
     仍然记一条访问事件 —— 控制台要能看到「他还在打，只是打不进来」。 */
  const _t0 = Date.now();
  const _ip = clientIp(req);
  const _blk = blockedEntry(_ip);
  if (_blk) {
    _blk.hits = (_blk.hits || 0) + 1;
    /* 例外：管理员即便自己也被封了，也一定要能进控制台解封。
       否则「手滑封了自己」= 永久失去运维通道，只能去改库文件。
       代价极小：要走这条路必须先有一个有效的管理员会话。 */
    let _pass = false;
    if (pathname.startsWith('/api/ops/') || pathname === '/ops' || pathname === '/ops/'
      || pathname.startsWith('/ops.')) {
      const opu = currentUser(req);
      _pass = !!(opu && rankOf(opu) >= 2);
    }
    if (!_pass) {
      noteAccess(req, pathname, 403, 0);
      return opsBlockedReply(res, pathname, _blk);
    }
  }
  try {
    if (pathname.startsWith('/api/')) {
      /* 第二道闸：进程已经喘不过气（CPU 被打满）时，只放行「我是谁」这一个
         最轻的接口，其余回 503。这叫「有损降级」——牺牲部分请求的体验，
         换整个服务不雪崩。不加这道，所有人一起卡到超时。
         安全控制台（/api/ops/）必须放行：正被攻击时恰恰是运维唯一要用的东西。 */
      if (overloaded && pathname !== '/api/me' && !pathname.startsWith('/api/ops/')) {
        return tooBusy(res, 5);
      }
      await handleApi(req, res, pathname, u);
    } else {
      /* 安全控制台只给管理员：html / js / css 一起挡，未登录连页面源码都拿不到 */
      if (pathname === '/ops' || pathname === '/ops/' || pathname.startsWith('/ops.')) {
        const opu = currentUser(req);
        if (!opu || rankOf(opu) < 2) return opsDenied(res);
        if (pathname === '/ops' || pathname === '/ops/') pathname = '/ops.html';
      }
      /* 静态资源限流：阈值给得很宽（一次打开首页约 10~14 个资源请求），
         只为拦住「单个 IP 死循环刷同一个文件」，不会误伤正常浏览与 NAT 共用出口。 */
      if (!rateLimit('static:' + clientIp(req), 1800, 60 * 1000)) {
        res.setHeader('Retry-After', '20');
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('429 Too Many Requests');
      }
      await serveStatic(req, res, pathname);
    }
  } catch (e) {
    if (!res.headersSent) {
      // 业务上可预期的错误（请求体过大、JSON 格式错）按状态码回，
      // 剩下的才当 500 —— 而且不把内部异常信息回给客户端（防泄露路径/实现细节）
      const code = Number(e && e.status) || 0;
      if (code >= 400 && code < 500) {
        json(res, code, { error: (e && e.message) || '请求不合法' });
      } else {
        console.error('[500]', pathname, e && e.message);
        json(res, 500, { error: '服务器开小差了，请稍后再试' });
      }
    }
    else res.end();
  } finally {
    // 行为画像 / 访问流水：放在 finally 里，异常路径也照样计数
    noteAccess(req, pathname, res.statusCode, Date.now() - _t0);
  }
});

/* ---- 抗慢速攻击（Slowloris）----
   默认 headersTimeout 是 60s：攻击者开几千个连接、每秒只发一个字节，
   就能把连接数占满。收紧到 20s 收不完请求头直接断。
   requestTimeout 给到 120s：本机 Ollama 冷启动要 58s，别把正常请求切了。 */
server.headersTimeout = 20 * 1000;
server.requestTimeout = 120 * 1000;
server.keepAliveTimeout = 65 * 1000;
server.maxHeadersCount = 80;
server.maxRequestsPerSocket = 0;

/* 连接总数上限。前面有平台反向代理时，真正连进来的是代理的连接池，
   正常也就几条到几十条；600 是给「代理回源暴增」留的余量。
   到了上限 Node 会直接丢弃新连接 —— 比收进来再慢慢排队更安全（不攒内存）。 */
server.maxConnections = 600;

/* 畸形请求（非法 HTTP、超长头）由 Node 自己回 400 并断开。
   这里只补一句日志，别把原始字节打出来（可能被用来注入日志）。 */
server.on('clientError', (err, socket) => {
  if (socket.writable && !socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } else if (!socket.destroyed) {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🍳  饭圈 · 好好做饭的人都在这里');
  console.log('  ──────────────────────────────────');
  console.log('  监听       ' + HOST + ':' + PORT);
  console.log('  用户 ' + db.users.length + ' · 帖子 ' + db.posts.length +
    ' · 待审核 ' + db.posts.filter((p) => p.status === 'pending').length);
  // 不再打印任何账号口令（日志可能被平台留存/被他人看到）
  console.log('');
  aiWarmup();
});

process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
