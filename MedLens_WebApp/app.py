# app.py — Flask backend for MediLens Verify
# -----------------------------------------
# Install (one time):
#   pip install flask flask-cors openai pillow pytesseract pymupdf python-docx edge-tts
# Optional (for RTF):
#   pip install striprtf
# Also install Tesseract OCR binary (macOS: brew install tesseract).
#
# Run:
#   export OPENAI_API_KEY=sk-...   # put your key here
#   python app.py

import os
import io
import base64
import json
from datetime import datetime

from flask import Flask, request, jsonify, send_file, render_template_string
from flask_cors import CORS

# OpenAI
from openai import OpenAI

# OCR / Images
from PIL import Image
import pytesseract

# PDF
import fitz  # PyMuPDF

# DOCX
from docx import Document

# Optional RTF (graceful if missing)
try:
    from striprtf.striprtf import rtf_to_text
    HAS_RTF = True
except Exception:
    HAS_RTF = False

# Optional TTS
import asyncio
import edge_tts

# ------------ Config ------------
MODEL = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo-0125")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("Set OPENAI_API_KEY in your environment before running.")

client = OpenAI(api_key=OPENAI_API_KEY)

# Prefer reputable sources in responses
PREFERRED_DOMAINS = [
    "who.int", "cdc.gov", "ncbi.nlm.nih.gov", "cochranelibrary.com",
    "nice.org.uk", "nhs.uk", "ema.europa.eu"
]

# ------------ App ------------
# Serve static files (verify.html, verify.js, styles) from current folder
app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)
# Allow up to 32 MB uploads
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024


# ------------ Helpers ------------
def normalize_sources(raw_sources):
    """Coerce LLM output into a list of {title, url}, trimmed & safe."""
    out = []
    if not isinstance(raw_sources, list):
        return out
    for s in raw_sources:
        if not isinstance(s, dict):
            continue
        title = (s.get("title") or s.get("url") or "").strip()
        url = (s.get("url") or "").strip()
        if not url:
            continue
        out.append({"title": title[:180], "url": url})
    return out[:6]


def call_openai_check(text):
    """Single-string verifier. Returns dict: {verdict, reason, sources}."""
    text = (text or "").strip()
    if not text:
        return {"verdict": "uncertain", "reason": "No text provided.", "sources": []}

    system = (
        "You are MediLens, a careful medical content verifier. "
        "Decide one of: TRUE, FALSE, MISLEADING, UNCERTAIN. "
        "Give a concise, evidence-based explanation. "
        "Return strict JSON: {verdict, reason, sources:[{title,url}]}. "
        "Prefer reputable domains like "
        + ", ".join(PREFERRED_DOMAINS) + "."
    )
    user = f"Verify this medical content:\n\n{text}\n\nReturn JSON only."

    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
        response_format={"type": "json_object"},
    )

    content = resp.choices[0].message.content
    try:
        data = json.loads(content)
    except Exception:
        data = {"verdict": "uncertain", "reason": content[:400], "sources": []}

    verdict = str(data.get("verdict", "uncertain")).lower()
    if verdict.startswith("true"):
        verdict = "true"
    elif verdict.startswith("false"):
        verdict = "false"
    elif verdict.startswith("mis"):
        verdict = "misleading"
    elif verdict.startswith("unc"):
        verdict = "uncertain"
    else:
        verdict = "uncertain"

    reason = str(data.get("reason", "")).strip()
    sources = normalize_sources(data.get("sources", []))
    return {"verdict": verdict, "reason": reason, "sources": sources}


def call_openai_check_many(texts):
    """
    Batch helper: verify many short texts efficiently.
    Returns list of result dicts aligned with input order.
    """
    out = []
    for t in texts:
        try:
            out.append(call_openai_check(t))
        except Exception:
            out.append({"verdict": "uncertain", "reason": "Check failed.", "sources": []})
    return out


def ocr_image_from_bytes(img_bytes) -> str:
    """OCR an image into text with Tesseract."""
    try:
        img = Image.open(io.BytesIO(img_bytes))
        if img.mode not in ("RGB", "RGBA", "L"):
            img = img.convert("RGB")
        text = pytesseract.image_to_string(img)
        return text.strip()
    except Exception:
        return ""


def extract_text_from_pdf(file_bytes) -> str:
    """Extract selectable text from a PDF (no OCR here)."""
    text_parts = []
    try:
        with fitz.open(stream=file_bytes, filetype="pdf") as doc:
            for page in doc:
                text_parts.append(page.get_text("text"))
    except Exception:
        pass
    return "\n".join(text_parts).strip()


def extract_text_from_docx(file_bytes) -> str:
    """Extract text from a .docx."""
    try:
        bio = io.BytesIO(file_bytes)
        doc = Document(bio)
        parts = [p.text for p in doc.paragraphs]
        return "\n".join(parts).strip()
    except Exception:
        return ""


def extract_text_from_rtf(file_bytes) -> str:
    """Extract text from .rtf (if striprtf installed)."""
    if not HAS_RTF:
        return ""
    try:
        return rtf_to_text(file_bytes.decode("utf-8", errors="ignore")).strip()
    except Exception:
        return ""


def safe_guess_ext(filename):
    if not filename:
        return ""
    fn = filename.lower()
    for ext in [
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".bmp",
        ".tif",
        ".tiff",
        ".gif",
        ".doc",
        ".docx",
        ".rtf",
        ".txt",
    ]:
        if fn.endswith(ext):
            return ext
    return ""


# ------------ Routes ------------
@app.get("/health")
def health():
    return jsonify(ok=True, status="healthy", ts=datetime.utcnow().isoformat() + "Z")


@app.post("/check")
def check_text():
    """Verify a single text string."""
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    result = call_openai_check(text)
    return jsonify(ok=True, data=result)


@app.post("/check_batch")
def check_batch():
    """
    Verify many text chunks at once.
    JSON: { "texts": ["...", "...", ...] }
    Returns: { ok: true, results: [ {verdict, reason, sources}, ... ] }
    """
    data = request.get_json(silent=True) or {}
    texts = data.get("texts")
    if not isinstance(texts, list) or not texts:
        return jsonify(ok=False, error="Provide a non-empty 'texts' array"), 400

    # Truncate extremes to avoid runaway costs
    MAX_ITEMS = 2000
    MAX_LEN = 1200  # characters per item
    cleaned = [(t or "")[:MAX_LEN] for t in texts[:MAX_ITEMS]]

    results = call_openai_check_many(cleaned)
    return jsonify(ok=True, results=results)


@app.post("/check_image")
def check_image():
    """
    Accepts:
      - multipart/form-data: file field "file"
      - JSON: { "image": "data:image/jpeg;base64,..." }
    """
    img_bytes = None

    if request.files:
        f = request.files.get("file")
        if f:
            img_bytes = f.read()

    if img_bytes is None:
        data = request.get_json(silent=True) or {}
        data_url = (data.get("image") or "").strip()
        if data_url.startswith("data:"):
            try:
                b64 = data_url.split(",", 1)[1]
                img_bytes = base64.b64decode(b64)
            except Exception:
                img_bytes = None

    if not img_bytes:
        return jsonify(ok=False, error="No image provided"), 400

    ocr_text = ocr_image_from_bytes(img_bytes)
    result = call_openai_check(ocr_text or "No text detected in the image.")
    result["ocr_text"] = ocr_text
    return jsonify(ok=True, data=result)


@app.post("/check_file")
def check_file():
    """
    Multi-file upload. Extracts text (OCR for images) and verifies each file as one blob.
    Front-end PDF highlighting is handled client-side; this route remains for non-PDFs or summary checks.
    """
    if not request.files:
        return jsonify(ok=False, error="No files uploaded"), 400

    out = []
    for key in request.files:
        f = request.files.get(key)
        if not f:
            continue
        name = f.filename or "file"
        ext = safe_guess_ext(name)
        blob = f.read()

        extracted, kind = "", "unknown"
        try:
            if ext in [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"]:
                kind = "image"
                extracted = ocr_image_from_bytes(blob)
            elif ext == ".pdf":
                kind = "pdf"
                extracted = extract_text_from_pdf(blob)  # selectable text only
            elif ext == ".docx":
                kind = "docx"
                extracted = extract_text_from_docx(blob)
            elif ext == ".doc":
                kind = "doc"
                extracted = ""  # basic .doc not parsed; recommend converting to .docx
            elif ext == ".rtf":
                kind = "rtf"
                extracted = extract_text_from_rtf(blob)
            elif ext == ".txt":
                kind = "txt"
                extracted = blob.decode("utf-8", errors="ignore")
            else:
                kind = "binary"
                extracted = ocr_image_from_bytes(blob) or ""
        except Exception:
            extracted = ""

        extracted = (extracted or "").strip()
        result = call_openai_check(extracted or f"No readable text extracted from {name}.")
        out.append({
            "filename": name,
            "kind": kind,
            "characters": len(extracted),
            "data": {
                "verdict": result["verdict"],
                "reason": result["reason"],
                "sources": result["sources"],
            }
        })

    return jsonify(ok=True, results=out)


@app.post("/tts")
def tts():
    """
    JSON: { "text": "...", "voice": "hi-IN-SwaraNeural" }
    Returns: audio/mpeg stream
    """
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    voice = (data.get("voice") or "hi-IN-SwaraNeural").strip()
    if not text:
        return jsonify(ok=False, error="No text"), 400

    async def synth():
        mp3_path = f"/tmp/medilens_tts_{abs(hash(text))}.mp3"
        communicate = edge_tts.Communicate(text, voice=voice)
        await communicate.save(mp3_path)
        return mp3_path

    mp3_path = asyncio.run(synth())
    return send_file(mp3_path, mimetype="audio/mpeg", as_attachment=False, download_name="speech.mp3")


# Serve your verify page if opening Flask root
@app.get("/")
def index():
    return render_template_string(
        '<meta http-equiv="refresh" content="0; url=verify.html"><p>Go to <a href="verify.html">verify.html</a></p>'
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=True)
