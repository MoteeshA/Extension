# server.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import os, requests, json, re, base64, io
from openai import OpenAI

# Optional OCR imports (for /check_image)
try:
    from PIL import Image
    import pytesseract
    OCR_AVAILABLE = True
except Exception:
    OCR_AVAILABLE = False

# --- config (safe) ---
MODEL = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo-0125")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("Set OPENAI_API_KEY in your environment before running.")

client = OpenAI(api_key=OPENAI_API_KEY)

ALLOWED = [
    "who.int",
    "cdc.gov",
    "cochranelibrary.com",
    "ncbi.nlm.nih.gov",   # PubMed/NCBI
    "nice.org.uk"
]

app = Flask(__name__)
CORS(app)  # allow browser callers by default

def bing_search(q, count=5):
    key = os.getenv("BING_SUBSCRIPTION_KEY")
    if not key:
        return []
    try:
        r = requests.get(
            "https://api.bing.microsoft.com/v7.0/search",
            params={"q": q, "count": count, "mkt": "en-US", "responseFilter": "Webpages"},
            headers={"Ocp-Apim-Subscription-Key": key},
            timeout=15
        )
        r.raise_for_status()
        items = (r.json().get("webPages", {}) or {}).get("value", []) or []
        outs = []
        for it in items:
            url = it.get("url", "")
            if any(d in url for d in ALLOWED):
                outs.append({"title": it.get("name", ""), "url": url})
        return outs[:5]
    except Exception:
        return []

SYSTEM = (
    "You are a careful health-claims checker. Use ONLY WHO, CDC, NICE, Cochrane, PubMed. "
    "If strong evidence supports the claim, verdict='true'. If mixed/insufficient, 'uncertain'. "
    "If contradicted, 'false'. If exaggerated/misleading, 'misleading'. "
    "Return STRICT JSON: {verdict, reason, sources:[{title,url}]}. Keep it concise."
)

def extract_json(text: str):
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    fenced = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE | re.MULTILINE).strip()
    try:
        return json.loads(fenced)
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    return None

# ---- shared checker (reuses your exact logic) ----
def check_text_internal(text: str):
    web_sources = bing_search(text)
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            temperature=0,
            messages=[
                {"role":"system","content":SYSTEM},
                {"role":"user","content":f"Claim: {text}\nSOURCES:\n" + "\n".join(f"- {w['title']} {w['url']}" for w in web_sources) + "\nReturn JSON only."}
            ]
        )
        raw = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        return {
            "verdict":"uncertain",
            "reason":f"Model call failed: {e.__class__.__name__}",
            "sources": web_sources
        }

    j = extract_json(raw) or {}
    v = str(j.get("verdict", "uncertain")).lower()
    if v not in ["true", "uncertain", "misleading", "false"]:
        v = "uncertain"

    ss = []
    for s in (j.get("sources") or []):
        u = s.get("url", "")
        if any(d in u for d in ALLOWED):
            ss.append({"title": s.get("title",""), "url": u})
    if not ss:
        ss = web_sources

    return {"verdict": v, "reason": j.get("reason","") or "", "sources": ss}

# ---- routes (your originals retained) ----
@app.get("/")
def root():
    return jsonify({
        "name": "Health Claims Checker API",
        "endpoints": {
            "GET /verify": "health check",
            "POST /check": "body: { text: string }",
            "POST /check_image": "body: { image: dataURL or base64 }"
        }
    })

@app.get("/verify")
def verify():
    return jsonify({"ok": True, "model": MODEL})

@app.post("/check")
def check():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"verdict":"uncertain","reason":"No text provided","sources":[]}), 400
    return jsonify(check_text_internal(text))

# ---- NEW: /check_image (OCR -> reuse same checker) ----
def _image_from_payload(b64_or_dataurl: str):
    s = (b64_or_dataurl or "").strip()
    if s.startswith("data:image/"):
        s = s.split(",", 1)[-1]
    raw = base64.b64decode(s)
    from PIL import Image  # defer import if PIL not present earlier
    return Image.open(io.BytesIO(raw)).convert("RGB")

@app.post("/check_image")
def check_image():
    if not OCR_AVAILABLE:
        return jsonify({"error":"OCR not available on server"}), 500

    data = request.get_json(silent=True) or {}
    img_payload = data.get("image")
    if not img_payload:
        return jsonify({"error":"No image"}), 400

    try:
        img = _image_from_payload(img_payload)
    except Exception:
        return jsonify({"error":"Invalid image data"}), 400

    try:
        text = (pytesseract.image_to_string(img) or "").strip()
    except Exception as e:
        return jsonify({"error": f"OCR failed: {e.__class__.__name__}"}), 502

    if not text:
        return jsonify({"verdict":"uncertain","reason":"OCR found no text","sources":[], "ocr_text": ""})

    out = check_text_internal(text)
    out["ocr_text"] = text
    return jsonify(out)

if __name__ == "__main__":
    # Access from LAN; use your IP 192.168.1.6 in the extension
    app.run(host="0.0.0.0", port=8000, debug=True)
