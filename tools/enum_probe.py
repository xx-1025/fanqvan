#!/usr/bin/env python3
"""匿名用户枚举探针 —— 复现「14 个请求拖走全站账号」，同时验证枚举检测是否生效。

正常情况（未加固）：
    40 个 id 全部 200/404，没有任何 429，security.log 一片空白
加固之后（P0 enumWatch 生效）：
    后段出现 429，且 data/security.log 里出现 "enum_suspect"

用法：
    python tools/enum_probe.py               # 默认扫 1..40
    python tools/enum_probe.py 60            # 扫 1..60
    python tools/enum_probe.py 60 0          # 第二参数 = 每次间隔秒数，默认 0.15

环境变量同 rate_limit_probe.py：FQ_HOST / FQ_PROXY
"""
import http.client
import json
import os
import sys
import time

HOST = os.environ.get('FQ_HOST', '8810a05ca2994d829f9c56a36bea7c58.app.workbuddy.host')
_proxy = os.environ.get('FQ_PROXY', '127.0.0.1:49891').strip()
PROXY = None
if _proxy:
    h, _, p = _proxy.partition(':')
    PROXY = (h, int(p or 80))

END = int(sys.argv[1]) if len(sys.argv) > 1 else 40
DELAY = float(sys.argv[2]) if len(sys.argv) > 2 else 0.15


def new_conn():
    if PROXY:
        c = http.client.HTTPSConnection(PROXY[0], PROXY[1], timeout=20)
        c.set_tunnel(HOST, 443)
    else:
        c = http.client.HTTPSConnection(HOST, 443, timeout=20)
    c.connect()
    return c


def get(conn, path):
    conn.request('GET', path, headers={'Host': HOST, 'Connection': 'keep-alive'})
    r = conn.getresponse()
    body = r.read()
    return r.status, body


conn = new_conn()

# 先摸总人数
try:
    st, body = get(conn, '/api/stats')
    total = json.loads(body).get('users')
    print(f"[/api/stats] 用户总数 = {total}")
except Exception as e:
    print(f"[/api/stats] 失败：{e}")

print(f"\n开始遍历 /api/users/1 .. /api/users/{END}\n")
print(f"{'id':>4}  {'状态':<6} 账号")
print('-' * 62)
found, limited, first429 = [], 0, None
for i in range(1, END + 1):
    try:
        st, body = get(conn, f'/api/users/{i}')
    except Exception:
        conn = new_conn()
        st, body = 0, b''
    if st == 200:
        u = json.loads(body)['user']
        found.append(u)
        print(f"{i:>4}  200    {u.get('username','')} / {u.get('nickname','')} [{u.get('role','')}]")
    elif st == 429:
        limited += 1
        if first429 is None:
            first429 = i
        print(f"{i:>4}  429    ← 被拦")
        if limited >= 5:
            print(f"\n(连续命中 5 次限流，停在 id={i})")
            break
    elif st == 404:
        print(f"{i:>4}  404    -")
    else:
        print(f"{i:>4}  {st:<6} ?")
    time.sleep(DELAY)

try:
    conn.close()
except Exception:
    pass

print('-' * 62)
print(f"拿到账号：{len(found)} 个")
if found:
    users = ', '.join(u.get('username', '') for u in found[:15])
    print(f"  {users}{' …' if len(found) > 15 else ''}")
print(f"请求总数：{END}，间隔 {DELAY}s")
print()
if first429:
    print(f"✅ 枚举被拦住了（首个 429 在 id={first429}）。去 data/security.log 里确认有没有 enum_suspect。")
elif found and total and len(found) >= total:
    print(f"❌ 全量枚举成功：{len(found)}/{total} 个账号被匿名拉走，全程无限流。P0 没生效。")
else:
    print("⚠️ 没被拦，但也没拿全 —— 看看是不是间隔太大/总量太小，不足以触发阈值。")
