# server.py
from flask import Flask, request, jsonify, make_response
from flask_cors import CORS
import os, requests, json, re, base64, io, time

from openai import OpenAI

# NEW: resilient async TTS infra
import threading
import asyncio
import edge_tts
from aiohttp import ClientError

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
    "ncbi.nlm.nih.gov",
    "nice.org.uk"
]

app = Flask(__name__)
CORS(app)  # keep global CORS
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # up to ~16 MB bodies

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

def check_text_internal(text: str):
  web_sources = bing_search(text)
  try:
      resp = client.chat.completions.create(
          model=MODEL,
          temperature=0,
          messages=[
              {"role": "system", "content": SYSTEM},
              {"role": "user", "content": f"Claim: {text}\nSOURCES:\n" +
                                           "\n".join(f"- {w['title']} {w['url']}" for w in web_sources) +
                                           "\nReturn JSON only."}
          ]
      )
      raw = (resp.choices[0].message.content or "").strip()
  except Exception as e:
      return {
          "verdict": "uncertain",
          "reason": f"Model call failed: {e.__class__.__name__}",
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
          ss.append({"title": s.get("title", ""), "url": u})
  if not ss:
      ss = web_sources

  return {"verdict": v, "reason": j.get("reason", "") or "", "sources": ss}

@app.get("/")
def root():
  return jsonify({
      "name": "Health Claims Checker API",
      "endpoints": {
          "GET /verify": "health check",
          "POST /check": "body: { text: string }",
          "POST /check_image": "body: { image: dataURL or base64 }",
          "POST /tts": "body: { text: string, voice?: string } -> audio/mpeg",
          "GET /voices": "list available TTS voices (ShortName, Gender, Locale)"
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
      return jsonify({"verdict": "uncertain", "reason": "No text provided", "sources": []}), 400
  return jsonify(check_text_internal(text))

def _image_from_payload(b64_or_dataurl: str):
  s = (b64_or_dataurl or "").strip()
  if s.startswith("data:image/"):
      s = s.split(",", 1)[-1]
  raw = base64.b64decode(s)
  from PIL import Image  # defer import
  return Image.open(io.BytesIO(raw)).convert("RGB")

@app.post("/check_image")
def check_image():
  if not OCR_AVAILABLE:
      return jsonify({"error": "OCR not available on server (install Tesseract + pytesseract)"}), 500

  data = request.get_json(silent=True) or {}
  img_payload = data.get("image")
  if not img_payload:
      return jsonify({"error": "No image"}), 400

  try:
      img = _image_from_payload(img_payload)
  except Exception as e:
      return jsonify({"error": f"Invalid image data: {e.__class__.__name__}"}), 400

  try:
      # More reliable on paragraph text:
      text = (pytesseract.image_to_string(img, config="--psm 6") or "").strip()
  except Exception as e:
      return jsonify({"error": f"OCR failed: {e.__class__.__name__}"}), 502

  if not text:
      return jsonify({
          "verdict": "uncertain",
          "reason": "OCR found no text in the captured region",
          "sources": [],
          "ocr_text": ""
      }), 200

  out = check_text_internal(text)
  out["ocr_text"] = text
  return jsonify(out)

# -------------------------------
# NEW: Swara TTS (edge-tts) endpoint (/tts) with dedicated loop
# -------------------------------

_TTS_LOOP = asyncio.new_event_loop()
def _run_loop(loop):
  asyncio.set_event_loop(loop)
  loop.run_forever()
_thread = threading.Thread(target=_run_loop, args=(_TTS_LOOP,), daemon=True)
_thread.start()

_VOICES_CACHE = {"ts": 0, "list": []}
_VOICES_TTL = 60  # seconds

async def _list_voices_async():
  from edge_tts import list_voices
  return await list_voices()

def _get_voices():
  now = time.time()
  if (now - _VOICES_CACHE["ts"]) > _VOICES_TTL or not _VOICES_CACHE["list"]:
      fut = asyncio.run_coroutine_threadsafe(_list_voices_async(), _TTS_LOOP)
      _VOICES_CACHE["list"] = fut.result(timeout=20)
      _VOICES_CACHE["ts"] = now
  return _VOICES_CACHE["list"]

def _pick_voice(requested: str) -> str:
  """Return a usable ShortName. Prefer requested; else a Hindi female."""
  try:
      voices = _get_voices()
      if any(v.get("ShortName") == requested for v in voices):
          return requested
      for v in voices:
          if (v.get("Locale") == "hi-IN") and (v.get("Gender", "").lower() == "female"):
              return v.get("ShortName")
      for v in voices:
          if v.get("Locale") == "hi-IN":
              return v.get("ShortName")
  except Exception:
      pass
  return requested

async def _synth_bytes_async(text: str, voice: str = "hi-IN-SwaraNeural") -> bytes:
  audio = b""
  comm = edge_tts.Communicate(text, voice=voice)
  async for chunk in comm.stream():
      if chunk["type"] == "audio":
          audio += chunk["data"]
  if not audio:
      raise RuntimeError("NoAudioReceived")
  return audio

def _synth_bytes(text: str, voice: str) -> bytes:
  fut = asyncio.run_coroutine_threadsafe(_synth_bytes_async(text, voice), _TTS_LOOP)
  return fut.result(timeout=30)

@app.get("/voices")
def voices():
  try:
      vs = _get_voices()
      out = [{"ShortName": v.get("ShortName"),
              "Gender": v.get("Gender"),
              "Locale": v.get("Locale")} for v in vs]
      return jsonify(out)
  except Exception as e:
      return jsonify({"error": str(e)}), 500

@app.after_request
def _cors_pna_headers(resp):
  resp.headers.setdefault("Access-Control-Allow-Origin", "*")
  resp.headers.setdefault("Access-Control-Allow-Headers", "Content-Type")
  resp.headers.setdefault("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  resp.headers.setdefault("Access-Control-Allow-Private-Network", "true")
  return resp

@app.route("/tts", methods=["OPTIONS"])
def tts_preflight():
  resp = make_response("", 204)
  resp.headers["Access-Control-Allow-Origin"] = "*"
  resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
  resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
  resp.headers["Access-Control-Allow-Private-Network"] = "true"
  return resp

@app.post("/tts")
def tts():
  data = request.get_json(silent=True) or {}
  text = (data.get("text") or "").strip()
  req_voice = (data.get("voice") or "hi-IN-SwaraNeural").strip()

  if not text:
      return jsonify({"error": "Missing 'text'"}), 400

  try:
      voice = _pick_voice(req_voice)
      t = text[:4000]
      audio = _synth_bytes(t, voice)

      resp = make_response(audio)
      resp.headers["Content-Type"] = "audio/mpeg"
      resp.headers["Access-Control-Allow-Origin"] = "*"
      resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
      resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
      resp.headers["Access-Control-Allow-Private-Network"] = "true"
      resp.headers["X-Voice-ShortName"] = voice
      return resp

  except ClientError as e:
      return jsonify({"error": f"TTS network failure: {type(e).__name__}: {e}"}), 502
  except asyncio.TimeoutError:
      return jsonify({"error": "TTS timed out"}), 504
  except Exception as e:
      return jsonify({"error": f"TTS failed: {type(e).__name__}: {e}"}), 500

if __name__ == "__main__":
  app.run(host="0.0.0.0", port=8000, debug=True)
