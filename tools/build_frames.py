# -*- coding: utf-8 -*-
"""框素材 -> public/frames/<key>.webp（可直接套头像的相框）

素材的三个特性决定了算法：
1) 底不是纯白，是「边缘纯白 → 中心暖白(约244)」的径向渐变，每张还不一样。
   固定阈值一定翻车（阈值高抠不动、阈值低把奶白云纹抠穿）。
   -> 先从四条边估背景色，再按色差判「像不像底」。
2) 框体自己也有大片近白部件（牌坊白墙、鱼肚白）。
   -> 只把「与图像边界连通」的底色区判为外部，内部不连通的一律保留。
3) 洞不一定和外部隔绝（松枝缝隙会让两者连通），所以「抠图」和「量洞」必须解耦：
   抠图 = 外部底色 ∪ 最大内部底色区（拿不到就算了，洞和外部连通时已被外部吃掉）；
   量洞 = 纯几何射线（洞都是正圆且居中），以内容 bbox 中心为起点，
          遇到连续 8 个非底色像素才算撞墙，抗噪点。

⚠️ 2026-11-12 修正（这是「头像框装饰被裁一半」的真正原因）
   旧版按「洞占画布 72%」反推方形窗口 = 洞径/0.72。
   但实测素材里洞只占原图 46%~70%，窗口比原图还小 —— 等于把整幅图放大 1.5~1.9 倍后
   只取中心一块，四周装饰（金冠顶饰、凤凰翅膀、牌坊屋檐）被整块切掉。
   现在改成：以洞心为中心，取一个**完整包住所有内容像素**的方形窗口（+3% 余量），
   洞占比是多少就记多少，配合 CSS 里每款自己的 --fit = 1/洞占比。
   这样任何一款框都不会被切，只是「框比头像大多少」各款不同（1.5~2.5 倍）。

输出：384×384 透明 webp；meta 里给出每款的 fit（= 画布边长/洞径）。
"""
import numpy as np, os, json, math
from PIL import Image
from scipy import ndimage

# 原始素材：优先 touxiangkuang/*.png，其次 .workbuddy/src/touxiangkuang/*.webp
SRC = "touxiangkuang"
if not os.path.isdir(SRC):
    SRC = ".workbuddy/src/touxiangkuang"
EXT = ".png" if os.path.exists(f"{SRC}/1.png") else ".webp"
DST, OUT, PAD_RATIO = "public/frames", 384, 0.03
TOL = 30
NAMES = {1:'halloween',2:'phoenix',3:'koi',4:'magpie',5:'lion',6:'lantern',
         7:'eaves',8:'wreath',9:'mooncake',10:'jade',11:'gate',12:'osmanthus',
         13:'lanterns',14:'clouds',15:'feast',16:'xmas',17:'crown'}
os.makedirs(DST, exist_ok=True)
os.makedirs(".workbuddy/tmp", exist_ok=True)
meta = []

for idx in sorted(NAMES):
    im = Image.open(f'{SRC}/{idx}{EXT}').convert('RGBA')
    a = np.asarray(im).astype(np.float32)
    H, W = a.shape[:2]

    band = np.concatenate([a[:6, :, :3].reshape(-1, 3), a[-6:, :, :3].reshape(-1, 3),
                           a[:, :6, :3].reshape(-1, 3), a[:, -6:, :3].reshape(-1, 3)])
    bg = np.median(band, axis=0)
    diff = np.abs(a[:, :, :3] - bg).max(axis=2)
    near_bg = diff < TOL

    # ---------- 抠图 ----------
    lab, n = ndimage.label(near_bg)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    transparent = np.isin(lab, list(border)) if border else np.zeros((H, W), bool)
    for i in range(1, n + 1):
        if i in border:
            continue
        if int((lab == i).sum()) > W * H * 0.05:
            transparent |= (lab == i)

    # ---------- 量洞（几何）----------
    ys, xs = np.nonzero(~transparent)
    bx0, bx1, by0, by1 = xs.min(), xs.max(), ys.min(), ys.max()
    cx, cy = (bx0 + bx1) // 2, (by0 + by1) // 2

    def ray(dx, dy):
        run = 0
        for t in range(0, int(max(W, H))):
            x, y = int(round(cx + dx * t)), int(round(cy + dy * t))
            if not (0 <= x < W and 0 <= y < H):
                return t
            if not near_bg[y, x]:
                run += 1
                if run >= 8:
                    return t - 7.5
            else:
                run = 0
        return 0

    ds = [ray(math.cos(t), math.sin(t)) for t in np.linspace(0, 2 * math.pi, 90, endpoint=False)]
    ds = np.array([d for d in ds if d > 20])
    r = float(np.median(ds)) if len(ds) else min(W, H) * 0.3
    L, R, U, D = ray(-1, 0), ray(1, 0), ray(0, -1), ray(0, 1)
    hcx = cx + (R - L) / 2.0
    hcy = cy + (D - U) / 2.0
    hd = 2 * r

    alpha = np.where(transparent, 0.0, 1.0).astype(np.float32) * (a[:, :, 3] / 255.0)
    out = a.copy()
    out[:, :, 3] = alpha * 255.0
    im2 = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGBA')

    # ---------- 输出窗口：完整包住所有内容 ----------
    dist = np.hypot(xs - hcx, ys - hcy)
    Rc = float(dist.max())                 # 最远一个内容像素也要包住，宁可多留白
    side = 2.0 * Rc * (1.0 + PAD_RATIO)

    # 先把图放大到「四周至少 side 的透明边」，再按 box 重采样，避免 box 越界丢内容
    pad = int(math.ceil(side)) + 2
    big = Image.new('RGBA', (W + 2 * pad, H + 2 * pad), (0, 0, 0, 0))
    big.alpha_composite(im2, (pad, pad))
    hcx2, hcy2 = hcx + pad, hcy + pad
    box = (hcx2 - side / 2, hcy2 - side / 2, hcx2 + side / 2, hcy2 + side / 2)
    canvas = Image.new('RGBA', (OUT, OUT), (0, 0, 0, 0))
    canvas.alpha_composite(big.resize((OUT, OUT), Image.LANCZOS, box=box))

    name = NAMES[idx]
    path = f'{DST}/{name}.webp'
    canvas.save(path, 'WEBP', quality=88, method=6)

    hole_ratio = hd / side                 # 洞占输出画布的比例
    fit = side / hd                        # CSS 里框层要放大的倍数
    kb = os.path.getsize(path) // 1024
    meta.append(dict(key=name, fit=round(fit, 2), hole_ratio=round(hole_ratio, 3), kb=kb))
    print(f'{idx:2d}.png -> {name:10s} 洞径{hd:6.1f}({hd/W*100:4.1f}%W) 画布{side:6.1f} '
          f'洞占比{hole_ratio*100:5.1f}% fit={fit:4.2f} {kb:4d}KB')

meta.sort(key=lambda m: m['fit'])
json.dump(meta, open('.workbuddy/tmp/frames_meta.json', 'w'), ensure_ascii=False, indent=1)
print('---  总计 %d KB  fit 范围 %.2f ~ %.2f' % (sum(m['kb'] for m in meta), meta[0]['fit'], meta[-1]['fit']))
