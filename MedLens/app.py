# app.py
import os, io, re, json, tempfile
from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
import docx2txt

# Optional OpenAI (falls back if key missing)
try:
    from openai import OpenAI
except Exception:
    OpenAI = None

# File parsing
import fitz  # PyMuPDF
from PIL import Image
import pytesseract
import docx2txt

ALLOWED_SOURCES = [
    "who.int",
    "cdc.gov",
    "ncbi.nlm.nih.gov",
    "cochranelibrary.com",
    "nice.org.uk",
    "nhs.uk",
]

VERDICT_COLORS = {
    "true":       {"bg":"#D1FAE5","fg":"#065F46","chip":"#10B981","label":"TRUE"},
    "false":      {"bg":"#FEE2E2","fg":"#7F1D1D","chip":"#EF4444","label":"FALSE"},
    "misleading": {"bg":"#FEF3C7","fg":"#7C2D12","chip":"#F59E0B","label":"MISLEADING"},
    "uncertain":  {"bg":"#DBEAFE","fg":"#1E3A8A","chip":"#3B82F6","label":"UNCERTAIN"},
}

MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

client = None
if OpenAI and OPENAI_API_KEY:
    try:
        client = OpenAI(api_key=OPENAI_API_KEY)
    except Exception:
        client = None

app = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB

# --------------------- Utilities ---------------------

def normalize_sources(sources):
    out = []
    if not isinstance(sources, list):
        return out
    for s in sources:
        if not isinstance(s, dict):
            continue
        url = str(s.get("url", "")).strip()
        title = str(s.get("title", "")).strip() or url
        if not url:
            continue
        try:
            dom = re.sub(r"^https?://", "", url).split("/")[0].lower()
        except Exception:
            dom = ""
        if any(dom.endswith(allow) for allow in ALLOWED_SOURCES):
            out.append({"title": title[:140], "url": url})
    # de-dup by url
    uniq, seen = [], set()
    for s in out:
        if s["url"] in seen:
            continue
        seen.add(s["url"])
        uniq.append(s)
    return uniq[:6]

def openai_check(text):
    """Ask OpenAI to classify a medical claim and cite reputable sources."""
    prompt = f"""
You are MediLens, a medical claim verifier.
Decide if the main claim in the user's text is TRUE, FALSE, MISLEADING, or UNCERTAIN.
Explain your reasoning briefly (1-3 sentences).
Cite 1-6 authoritative sources limited to domains: {', '.join(ALLOWED_SOURCES)}.

Return STRICT JSON:
{{
  "verdict": "true|false|misleading|uncertain",
  "reason": "short explanation",
  "sources": [ {{ "title": "string", "url": "https://..." }} ]
}}

User text:
{text[:6000]}
"""
    resp = client.chat.completions.create(
        model=MODEL,
        temperature=0.2,
        messages=[
            {"role": "system", "content": "You are a precise medical fact-checker."},
            {"role": "user", "content": prompt},
        ],
    )
    raw = resp.choices[0].message.content.strip()
    m = re.search(r"\{.*\}", raw, flags=re.S)
    snippet = m.group(0) if m else raw
    data = json.loads(snippet)
    v = str(data.get("verdict", "uncertain")).lower().strip()
    if v not in VERDICT_COLORS:
        v = "uncertain"
    return {
        "verdict": v,
        "reason": str(data.get("reason", "")).strip(),
        "sources": normalize_sources(data.get("sources", [])),
    }

def heuristic_check(text):
    """Fallback when OpenAI key is missing."""
    t = (text or "").lower()
    patterns_true = [r"wash(ing)? hands reduces infection", r"vaccin(e|ation) prevents"]
    patterns_false = [r"bleach.*(cure|treat)", r"miracle mineral solution", r"homeopathy cures cancer"]
    patterns_misleading = [r"detox", r"alkaline water", r"superfood", r"boost immunity instantly"]

    def any_match(pats): return any(re.search(p, t) for p in pats)

    if any_match(patterns_false):
        verdict, reason = "false", "Contains claims widely refuted by medical authorities."
    elif any_match(patterns_true):
        verdict, reason = "true", "Matches accepted medical guidance."
    elif any_match(patterns_misleading):
        verdict, reason = "misleading", "Includes buzzwords or overstatements that can be context-dependent."
    else:
        verdict, reason = "uncertain", "Not enough specific context to verify confidently."

    sources = [
        {"title": "World Health Organization", "url": "https://www.who.int/"},
        {"title": "Centers for Disease Control and Prevention", "url": "https://www.cdc.gov/"},
        {"title": "NHS — Health A to Z", "url": "https://www.nhs.uk/conditions/"},
    ]
    return {"verdict": verdict, "reason": reason, "sources": normalize_sources(sources)}

def analyze_text(text):
    if client is not None:
        try:
            return openai_check(text)
        except Exception:
            return heuristic_check(text)
    return heuristic_check(text)

def extract_text_from_pdf(file_bytes: bytes) -> str:
    text_parts = []
    with fitz.open(stream=file_bytes, filetype="pdf") as doc:
        for page in doc:
            t = page.get_text("text").strip()
            if t:
                text_parts.append(t)
            else:
                pix = page.get_pixmap(dpi=150)
                img_bytes = pix.tobytes("png")
                img = Image.open(io.BytesIO(img_bytes))
                try:
                    ocr = pytesseract.image_to_string(img, lang="eng")
                    if ocr.strip():
                        text_parts.append(ocr)
                except Exception:
                    pass
    return "\n\n".join(text_parts).strip()

def extract_text_from_image(file_bytes: bytes) -> str:
    img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
    try:
        return pytesseract.image_to_string(img, lang="eng").strip()
    except Exception:
        return ""

def extract_text_from_docx(file_bytes: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".docx", delete=True) as tmp:
        tmp.write(file_bytes)
        tmp.flush()
        text = docx2txt.process(tmp.name) or ""
    return text.strip()

def clamp_text(s, limit=20000):
    s = s or ""
    return s if len(s) <= limit else s[:limit]

# --------------------- Routes ---------------------

@app.route("/")
def home():
    # Renders templates/index.html
    return render_template("index.html")

@app.route("/favicon.ico")
def favicon():
    # optional: serve a favicon from /static if you add one
    return send_from_directory(app.static_folder, "favicon.ico", mimetype="image/x-icon")

@app.route("/api/ping")
def ping():
    return jsonify({"ok": True, "message": "pong"})

@app.route("/api/check", methods=["POST"])
def api_check():
    data = request.get_json(silent=True) or {}
    text = clamp_text(data.get("text", ""))
    if not text:
        return jsonify({"ok": False, "error": "Missing text"}), 400

    res = analyze_text(text)
    v = res.get("verdict", "uncertain")
    return jsonify({
        "ok": True,
        "verdict": v,
        "reason": res.get("reason", ""),
        "sources": res.get("sources", []),
        "colors": VERDICT_COLORS[v],
        "extracted_text": None,
    })

@app.route("/api/check_file", methods=["POST"])
def api_check_file():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "No file uploaded"}), 400
    f = request.files["file"]
    raw = f.read()
    ctype = (f.mimetype or "").lower()

    text = ""
    try:
        if ctype.startswith("application/pdf") or f.filename.lower().endswith(".pdf"):
            text = extract_text_from_pdf(raw)
        elif ctype.startswith("image/"):
            text = extract_text_from_image(raw)
        elif f.filename.lower().endswith((".doc", ".docx")) or "word" in ctype:
            text = extract_text_from_docx(raw)
        else:
            try:
                text = raw.decode("utf-8", errors="ignore")
            except Exception:
                text = ""
    except Exception as e:
        return jsonify({"ok": False, "error": f"Failed to read file: {e}"}), 400

    if not text.strip():
        return jsonify({"ok": False, "error": "No readable text extracted"}), 422

    analysis_text = text if len(text) < 8000 else text[:8000]
    res = analyze_text(analysis_text)
    v = res.get("verdict", "uncertain")
    return jsonify({
        "ok": True,
        "verdict": v,
        "reason": res.get("reason", ""),
        "sources": res.get("sources", []),
        "colors": VERDICT_COLORS[v],
        "extracted_text": clamp_text(text, 25000),
    })

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5008"))
    app.run(host="0.0.0.0", port=port, debug=True)
