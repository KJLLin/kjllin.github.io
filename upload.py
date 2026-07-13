import json, base64, urllib.request, urllib.error, subprocess

TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()

files = [
    "account/index.html",
    "cloud/index.html",
    "discuss/index.html",
    "discuss/view/index.html",
    "game/dino/index.html",
    "game/snake/index.html",
    "game/tfe/index.html",
]

def api_call(method, url, data=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("User-Agent", "CodeBuddy")
    if data:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(data).encode()
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:500]
        print(f"HTTP ERROR {e.code}: {body}")
        return None

for fpath in files:
    with open(fpath, "rb") as f:
        content = base64.b64encode(f.read()).decode()
    
    api_url = f"https://api.github.com/repos/KJLLin/kjllin.github.io/contents/{fpath}"
    current = api_call("GET", api_url)
    if not current or "sha" not in current:
        print(f"ERROR: Could not get SHA for {fpath}")
        continue
    
    sha = current["sha"]
    
    result = api_call("PUT", api_url, {
        "message": f"fix: update {fpath} - remove defer, add safeStorage, fix syntax",
        "content": content,
        "sha": sha
    })
    
    if result and "content" in result:
        print(f"✓ Updated: {fpath}")
    else:
        print(f"✗ Failed: {fpath}")

print("All done!")
