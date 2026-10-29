#!/usr/bin/env python3
"""限流阈值探针 —— 长连接压测，验证 /api 的 240 次/分钟是否真的生效。

为什么不能直接用 curl：curl 每次重新握手（走代理更慢），实测只有 2 req/s，
250 次散在两分钟里，永远挤不进一分钟窗口，会得出「限流失效」的错误结论。

用法：
    python tools/rate_limit_probe.py [路径] [线程数] [每线程请求数]
    python tools/rate_limit_probe.py /api/stats 15 22
    python tools/rate_limit_probe.py /api/stats 15 22 "10.9.{i}.{k}"   # 测 XFF 伪造

环境变量：
    FQ_HOST   目标域名（默认见下）
    FQ_PROXY  本地代理 host:port，直连环境留空
"""
import http.client
import os
import sys
import threading
import time
import collections

HOST = os.environ.get('FQ_HOST', '8810a05ca2994d829f9c56a36bea7c58.app.workbuddy.host')
_proxy = os.environ.get('FQ_PROXY', '127.0.0.1:49891').strip()
PROXY = None
if _proxy:
    h, _, p = _proxy.partition(':')
    PROXY = (h, int(p or 80))

PATH = sys.argv[1] if len(sys.argv) > 1 else '/api/stats'
N = int(sys.argv[2]) if len(sys.argv) > 2 else 15        # 并发（站内单 IP 在途闸门 28）
PER = int(sys.argv[3]) if len(sys.argv) > 3 else 22      # 每个线程的请求数
XFF = sys.argv[4] if len(sys.argv) > 4 else None

codes = collections.Counter()
lock = threading.Lock()


def new_conn():
    if PROXY:
        c = http.client.HTTPSConnection(PROXY[0], PROXY[1], timeout=20)
        c.set_tunnel(HOST, 443)
    else:
        c = http.client.HTTPSConnection(HOST, 443, timeout=20)
    c.connect()
    return c


def worker(i):
    try:
        conn = new_conn()
    except Exception:
        with lock:
            codes['conn_fail'] += 1
        return
    for k in range(PER):
        headers = {'Host': HOST, 'Connection': 'keep-alive',
                   'User-Agent': 'Mozilla/5.0 rl-probe'}
        if XFF:
            headers['X-Forwarded-For'] = XFF.format(i=i, k=k)
        try:
            conn.request('GET', PATH, headers=headers)
            r = conn.getresponse()
            r.read()
            with lock:
                codes[r.status] += 1
        except Exception:
            with lock:
                codes['reset'] += 1
            try:
                conn.close()
                conn = new_conn()
            except Exception:
                return
    try:
        conn.close()
    except Exception:
        pass


t0 = time.time()
threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
for t in threads:
    t.start()
for t in threads:
    t.join()
elapsed = time.time() - t0
total = sum(codes.values())

print(f"目标 {PATH}" + (f"   XFF={XFF}" if XFF else "   (不带头)"))
print(f"{total} 请求 / {elapsed:.1f}s = {total / max(elapsed, 0.01):.0f} req/s")
for k, v in codes.most_common():
    print(f"   {k}: {v}")

ok = codes.get(200, 0)
limited = codes.get(429, 0)
print()
if limited and ok <= 300:
    print(f"✅ 限流生效：{ok} 次放行后开始 429")
elif not limited:
    print("⚠️ 全程无 429 —— 要么阈值被调高了，要么限流被绕过了（检查 clientIp / TRUST_PROXY）")
else:
    print(f"⚠️ 放行了 {ok} 次才限流，与预期的 240 偏差较大")
