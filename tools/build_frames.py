# -*- coding: utf-8 -*-
"""touxiangkuang/*.png -> public/frames/*.webp（可直接套头像的圆形相框）

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

洞在输出图上固定占 76%，CSS 里框层取 1/0.76≈1.316 倍头像尺寸，洞正好套住头像。
"""
import numpy as np, os, json, math
from PIL import Image
from scipy import ndimage

SRC, DST, OUT, HOLE_RATIO = "touxiangkuang", "public/frames", 384, 0.72
TOL = 30          # 与背景色的容差
NAMES = {1:'halloween',2:'phoenix',3:'koi',4:'magpie',5:'lion',6:'lantern',
         7:'eaves',8:'wreath',9:'mooncake',10:'jade',11:'gate',12:'osmanthus',
         13:'lanterns',14:'clouds',15:'feast',16:'xmas',17:'crown'}
os.makedirs(DST, exist_ok=True)
meta = []

for idx in sorted(NAMES):
    im = Image.open(f'{SRC}/{idx}.png').convert('RGBA')
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
    # 内部底色大区（= 洞），面积超过画布 5% 才算
    for i in range(1, n + 1):
        if i in border:
            continue
        area = int((lab == i).sum())
        if area > W * H * 0.05:
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
    L, R = ray(-1, 0), ray(1, 0)
    U, D = ray(0, -1), ray(0, 1)
    hcx = cx + (R - L) / 2.0
    hcy = cy + (D - U) / 2.0
    hd = 2 * r

    alpha = np.where(transparent, 0.0, 1.0).astype(np.float32) * (a[:, :, 3] / 255.0)
    out = a.copy()
    out[:, :, 3] = alpha * 255.0
    im2 = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGBA')

    win = hd / HOLE_RATIO
    box = (hcx - win / 2, hcy - win / 2, hcx + win / 2, hcy + win / 2)
    canvas = Image.new('RGBA', (OUT, OUT), (0, 0, 0, 0))
    canvas.alpha_composite(im2.resize((OUT, OUT), Image.LANCZOS, box=box))

    name = NAMES[idx]
    path = f'{DST}/{name}.webp'
    canvas.save(path, 'WEBP', quality=88, method=6)
    kb = os.path.getsize(path) // 1024
    meta.append(dict(key=name, kb=kb, hole_ratio=round(hd / W, 2)))
    print(f'{idx:2d}.png -> {name:10s} bg={bg.astype(int)} 洞心({hcx:6.1f},{hcy:6.1f}) 洞径{hd:6.1f}({hd/W:.2f}W) {kb:4d}KB')

json.dump(meta, open('.workbuddy/tmp/frames_meta.json', 'w'), ensure_ascii=False, indent=1)
print('总计', sum(m['kb'] for m in meta), 'KB')
