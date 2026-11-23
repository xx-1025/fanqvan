# 生成素材 -> 透明 webp（小饭的动作帧）
#
# 用法：把 ImageGen 出的白底图路径填进 SRC，跑 `python tools/cut-chef.py`。
# 输出 public/assets/chef/<name>.webp，统一 460×577 画布、脚底对齐、水平居中。
# 所有帧同画布，前端换帧才不会有位移。
#
# 为什么不用「按亮度抠白」：厨师帽、眼白、围裙白边都是白的，
# 全局抠会在人物身上挖出洞。这里从四个角 flood fill，只吃掉**和画布边缘连通**的白。
from PIL import Image, ImageDraw, ImageFilter

SRC = {
    'wave':  '.workbuddy/tmp/chefgen/同一个卡通小厨师角色_保持参考图完全一致的画风_粗黑描边_扁_2026-11-23T03-30-23.png',
    'point': '.workbuddy/tmp/chefgen/同一个卡通小厨师角色_保持参考图完全一致的画风_粗黑描边_扁_2026-11-23T03-30-53.png',
    'alarm': '.workbuddy/tmp/chefgen/同一个卡通小厨师角色_保持参考图完全一致的画风_粗黑描边_扁_2026-11-23T03-31-11.png',
}
H = 577   # 与 stand.webp 同高（400x577）

for name, p in SRC.items():
    im = Image.open(p).convert('RGBA')
    g = im.convert('L')
    # 二值：>=238 视为背景候选（白）
    bw = g.point(lambda v: 255 if v >= 238 else 0)
    # 从四个角分别 flood fill，只吃掉与边缘连通的白色
    for xy in [(0, 0), (bw.width - 1, 0), (0, bw.height - 1), (bw.width - 1, bw.height - 1)]:
        if bw.getpixel(xy) == 255:
            ImageDraw.floodfill(bw, xy, 128, thresh=0)
    # 外部=128 → alpha 0；其余 alpha 255
    alpha = bw.point(lambda v: 0 if v == 128 else 255)
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.7))   # 只羽化轮廓一两个像素
    im.putalpha(alpha)

    # 裁到人物 bbox，按高度归一，脚底对齐，水平居中
    bbox = im.split()[3].getbbox()
    body = im.crop(bbox)
    k = H / body.height
    nw = max(1, round(body.width * k))
    body = body.resize((nw, H), Image.LANCZOS)
    canvas = Image.new('RGBA', (460, H), (0, 0, 0, 0))
    canvas.paste(body, ((460 - nw) // 2, 0), body)
    dst = 'public/assets/chef/%s.webp' % name
    canvas.save(dst, 'WEBP', quality=88, method=6)
    print(name, 'bbox', bbox, '->', canvas.size, dst)
