#!/usr/bin/env python3
"""Tiny driver over idb: dump, tap by label, type text, screenshot."""
import json, subprocess, sys, time, os
UDID = "EB291B00-3F4A-4377-8C67-0DE2890EEE33"
IDB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "bin", "idb")

def idb(*args, capture=True):
    r = subprocess.run([IDB, *args, "--udid", UDID], capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
    return r.stdout

def dump():
    out = idb("ui", "describe-all")
    try:
        return json.loads(out)
    except Exception:
        sys.stderr.write(out[:500]); return []

def find(label, contains=False, index=0, role=None):
    els = [e for e in dump() if e.get("AXLabel") and (role is None or e.get("type") == role)]
    hits = [e for e in els if (label.lower() in e["AXLabel"].lower() if contains else e["AXLabel"] == label)]
    return hits[index] if len(hits) > index else None

def tap(label, contains=False, index=0, wait=0.8, timeout=15, role=None):
    t0 = time.time()
    while time.time() - t0 < timeout:
        e = find(label, contains, index, role)
        if e:
            f = e["frame"]; x = f["x"] + f["width"] / 2; y = f["y"] + f["height"] / 2
            idb("ui", "tap", str(int(x)), str(int(y)))
            time.sleep(wait); return True
        time.sleep(0.5)
    sys.stderr.write(f"not found: {label}\n"); return False

def tapxy(x, y, wait=0.8):
    idb("ui", "tap", str(int(x)), str(int(y))); time.sleep(wait)

def text(s, wait=0.5):
    idb("ui", "text", s); time.sleep(wait)

def labels():
    for e in dump():
        if e.get("AXLabel"):
            f = e["frame"]; print(f'{e.get("type"):12} {int(f["x"]):4},{int(f["y"]):4} {int(f["width"]):4}x{int(f["height"]):4}  {e["AXLabel"][:90]!r}')

def shot(path):
    subprocess.run(["xcrun", "simctl", "io", UDID, "screenshot", path], capture_output=True)

if __name__ == "__main__":
    cmd, *rest = sys.argv[1:]
    if cmd == "labels": labels()
    elif cmd == "tap": tap(rest[0], contains="--contains" in rest, index=int(rest[rest.index("--index")+1]) if "--index" in rest else 0)
    elif cmd == "tapxy": tapxy(float(rest[0]), float(rest[1]))
    elif cmd == "text": text(rest[0])
    elif cmd == "shot": shot(rest[0])
