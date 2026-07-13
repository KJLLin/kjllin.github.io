#!/usr/bin/env python3
"""KJLLin Supabase 全自动迁移脚本 - Step 1&2: 导出旧数据 + 导入新项目"""
import json, urllib.request, urllib.error, os, re, time

OLD_URL = "https://ayavdkodhdmcxfufnnxo.supabase.co"
NEW_URL = "https://vzqspcuxnwpakofwumat.supabase.co"

with open("/tmp/old_sr.txt") as f: OLD_SR = f.read().strip()
with open("/tmp/new_sr.txt") as f: NEW_SR = f.read().strip()

def api_call(url, sr_key, method="GET", path="", data=None):
    full_url = f"{url}{path}"
    req = urllib.request.Request(full_url, method=method)
    req.add_header("apikey", sr_key)
    req.add_header("Authorization", f"Bearer {sr_key}")
    req.add_header("Prefer", "return=representation")
    if data:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(data).encode()
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:500]
        return {"error": e.code, "body": body}

def fetch_all(url, sr_key, table, select="*", limit=1000):
    """分页导出表的全部数据"""
    all_rows = []
    offset = 0
    while True:
        result = api_call(url, sr_key,
            path=f"/rest/v1/{table}?select={select}&limit={limit}&offset={offset}&order=created_at.asc.nullslast")
        if isinstance(result, dict) and "error" in result:
            if offset == 0:
                return None, str(result.get("body", result.get("error")))
            break
        if not result:
            break
        all_rows.extend(result)
        if len(result) < limit:
            break
        offset += limit
    return all_rows, None

def insert_batch(url, sr_key, table, rows, batch_size=50):
    """批量插入数据"""
    total = len(rows)
    success = 0
    for i in range(0, total, batch_size):
        batch = rows[i:i+batch_size]
        result = api_call(url, sr_key, method="POST", path=f"/rest/v1/{table}", data=batch)
        if isinstance(result, dict) and "error" in result:
            print(f"  ⚠ batch {i//batch_size}: {result.get('body','?')[:100]}")
        else:
            success += len(batch)
        time.sleep(0.3)  # 避免限流
    return success

# ==================== Step 1: 导出旧数据 ====================
print("=" * 60)
print("Step 1: 从旧项目（悉尼）导出数据")
print("=" * 60)

tables = {
    "users": "id,nick,email,is_admin,status,last_login_time,created_at",
    "posts": "id,user_id,nick,title,content,created_at",
    "private_messages": "id,sender_id,recipient_id,text,read,created_at",
    "game_scores": "id,user_id,game,score,created_at",
    "user_blocks": "blocker_id,blocked_id",
}

backup = {}
for table, select in tables.items():
    print(f"\n导出 {table}...")
    rows, err = fetch_all(OLD_URL, OLD_SR, table, select)
    if err:
        print(f"  ⚠ {err[:200]}")
        backup[table] = []
    else:
        print(f"  ✓ {len(rows)} 条")
        backup[table] = rows

# 保存备份
os.makedirs("/workspace/migration/backup", exist_ok=True)
with open("/workspace/migration/backup/data.json", "w") as f:
    json.dump(backup, f, default=str, ensure_ascii=False)
print("\n✓ 数据已保存到 migration/backup/data.json")

# ==================== Step 2: 检查 storage ====================
print("\n" + "=" * 60)
print("Step 2: 检查旧项目 Storage")
print("=" * 60)

# 列出 buckets
buckets = api_call(OLD_URL, OLD_SR, path="/storage/v1/bucket")
if isinstance(buckets, list):
    for b in buckets:
        name = b.get("name", "?")
        print(f"  Bucket: {name}")
        # 列出文件
        files = api_call(OLD_URL, OLD_SR, path=f"/storage/v1/object/list/{name}")
        if isinstance(files, list):
            print(f"    文件数: {len(files)}")
elif isinstance(buckets, dict):
    print(f"  ⚠ {buckets.get('body','?')[:200]}")

# ==================== Summary ====================
print("\n" + "=" * 60)
print("数据导出完成！")
print("=" * 60)
total_records = sum(len(v) for v in backup.values())
print(f"总计: {total_records} 条记录")
for t, d in backup.items():
    print(f"  {t}: {len(d)} 条")
print(f"\n下一步: 在新项目SQL Editor运行 migration/01-schema.sql 建表")
print(f"然后我执行: python3 migration/migrate_step2.py 导入数据")
