"""One-off: build app/public/fxdefs.json from `pdftotext -layout` output of the X32 OSC protocol doc."""
import json, re, sys
src, out = sys.argv[1:3]
lines = open(src, encoding="latin-1").read().splitlines()
start = next(i for i, l in enumerate(lines) if l.strip() == "Effects Parameters")
end = next(i for i, l in enumerate(lines) if i > start and l.startswith("ASSIGN"))
T = ("HALL AMBI RPLT ROOM CHAM PLAT VREV VRM GATE RVRS DLY 3TAP 4TAP CRS FLNG PHAS DIMC FILT ROTA PAN SUB D/RV CR/R FL/R D/CR D/FL "
     "MODD GEQ2 GEQ TEQ2 TEQ DES2 DES P1A P1A2 PQ5 PQ5S WAVD LIM CMB CMB2 FAC FAC1M FAC2 LEC LEC2 ULC ULC2 ENH2 ENH EXC2 EXC IMG EDI SON AMP2 AMP DRV2 DRV PIT2 PIT").split()
num = lambda s: float(s.replace("+", "").replace("k", "")) * (1000 if "k" in s else 1)
defs, cur, pending = {}, None, None
PAR = re.compile(r"^(.*?)\s*(linf|logf|enum|int)\s*\[(.*?)(\]|$)")
for l in lines[start:end]:
    s = l.strip()
    if not s or s.startswith(("Unofficial", "Effect Name", "Parameter")): 
        if not s.startswith("Effect Name"): continue
    for w in s.split()[:1] + (s.split()[1:2] if s.startswith("Effect") else []):
        for c in re.split(r"\s+", w):
            if c in T: cur = c; defs.setdefault(cur, [])
    m = PAR.match(s)
    if not m or not cur:
        if cur and pending is not None and s and not re.search(r"\[|\]", s) and len(s) < 26:
            defs[cur][pending]["n"] = s; pending = None
        continue
    name = re.sub(r"\(.*?\)", " ", m[1])
    name = " ".join(w for w in name.split() if w not in T and not re.fullmatch(r"[fi]{3,}", w) and w not in ("Effect", "Name", "Parameter", "Parameters"))
    d = {"n": name}
    body = m[3]
    if m[2] in ("enum",):
        d["e"] = [x.strip() for x in body.split(",") if x.strip()]
    else:
        r = re.split(r"\.\.\.", body)
        try: d["a"], d["b"] = num(r[0]), num(r[1]); d["t"] = m[2][:3]
        except Exception: d["t"] = "lin"; d["a"], d["b"] = 0, 1
    defs[cur].append(d)
    pending = len(defs[cur]) - 1 if not name else None
for k, ps in defs.items():
    for i, p in enumerate(ps):
        if not p["n"]: p["n"] = f"Par {i+1}"
json.dump(defs, open(out, "w"), separators=(",", ":"))
print({k: len(v) for k, v in defs.items()}); print("missing", [t for t in T if t not in defs])
print(defs["HALL"][-2:], defs.get("P1A", [])[:4])
