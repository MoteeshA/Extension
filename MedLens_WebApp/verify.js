// verify.js (FULL, UPDATED)
// - Text mode: takes MULTI-LINE input, verifies line-by-line, shows inline HIGHLIGHTS on the text itself,
//   then offers a "Download Highlighted PDF" for those lines.
// - PDF upload: extracts text items -> verifies line-by-line (shows inline highlights in output box),
//   ALSO builds a highlighted version of the ORIGINAL PDF for download.
// - Other files (images/docs): sent to your existing backend routes (unchanged).
// - Keeps your original endpoints, IDs, and basic UI structure.
// - Fixes Safari “Buffer is already detached” by cloning ArrayBuffers for pdf.js and pdf-lib.
// - FIXES: removes 20-line cap; robust Lines PDF generation with wrapping; avoids corrupt/empty PDFs.

(() => {
  // ======= DOM =======
  const txtEl     = document.getElementById("verification-text");
  const upInput   = document.getElementById("file-upload");
  const upLabel   = document.getElementById("upload-label");
  const fileList  = document.getElementById("file-list");
  const runBtn    = document.getElementById("run-btn");
  const outBox    = document.querySelector(".output-box");
  const clearBtn  = document.getElementById("clear-btn");
  const dlBtn     = document.getElementById("download-btn"); // ORIGINAL-PDF download (for uploaded PDF flow)

  // ======= API endpoints (same-origin Flask) =======
  const API_BASE        = ""; // same-origin
  const END_CHECK       = "/check";
  const END_CHECK_BATCH = "/check_batch";
  const END_CHECK_IMG   = "/check_image";
  const END_CHECK_FILE  = "/check_file";
  const END_TTS         = "/tts"; // retained (unused here)

  // ======= State =======
  let files = [];
  let highlightedPdfBlobUrl = null;  // highlighted ORIGINAL PDF (when you upload a PDF)
  let linesPdfBlobUrl = null;        // a generated PDF of the verified LINES (text-mode or extracted from PDF)
  let lastTextLines = [];
  let lastTextVerdicts = [];

  // ======= Verdict colors/styles =======
  function verdictStyles(v) {
    const m = {
      "true":       { chip: "#10B981", label: "TRUE",       rgba: "rgba(16,185,129,0.22)" },
      "false":      { chip: "#EF4444", label: "FALSE",      rgba: "rgba(239,68,68,0.22)" },
      "misleading": { chip: "#F59E0B", label: "MISLEADING", rgba: "rgba(245,158,11,0.22)" },
      "uncertain":  { chip: "#3B82F6", label: "UNCERTAIN",  rgba: "rgba(59,130,246,0.22)" }
    };
    return m[v] || m.uncertain;
  }
  function rgbForPdf(v) {
    const map = {
      "true":       [0.062, 0.722, 0.506],   // #10B981
      "false":      [0.937, 0.267, 0.267],   // #EF4444
      "misleading": [0.961, 0.620, 0.043],   // #F59E0B
      "uncertain":  [0.231, 0.510, 0.965]    // #3B82F6
    };
    return map[v] || map.uncertain;
  }

  // ======= UI helpers =======
  function escapeHTML(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function setOutput(html) { outBox.innerHTML = html; }
  function appendOutput(html) { outBox.insertAdjacentHTML("beforeend", html); }
  function enableRunIfReady() {
    const hasText  = !!(txtEl.value.trim());
    const hasFiles = files.length > 0;
    runBtn.disabled = !(hasText || hasFiles);
  }
  function resetDownloads() {
    if (highlightedPdfBlobUrl) URL.revokeObjectURL(highlightedPdfBlobUrl);
    if (linesPdfBlobUrl) URL.revokeObjectURL(linesPdfBlobUrl);
    highlightedPdfBlobUrl = null;
    linesPdfBlobUrl = null;
    dlBtn.disabled = true; // original-PDF button kept disabled until ready
  }

  // ======= File selection + DnD =======
  upLabel.addEventListener("click", () => upInput.click());
  upInput.addEventListener("change", () => {
    files = Array.from(upInput.files || []);
    renderFileList();
    enableRunIfReady();
    resetDownloads();
  });
  ["dragenter","dragover"].forEach(ev =>
    upLabel.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      upLabel.classList.add("dragging");
    })
  );
  ["dragleave","drop"].forEach(ev =>
    upLabel.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      if (ev === "drop") {
        const dropped = Array.from(e.dataTransfer.files || []);
        files = files.concat(dropped);
        renderFileList();
        enableRunIfReady();
        resetDownloads();
      }
      upLabel.classList.remove("dragging");
    })
  );
  function renderFileList() {
    fileList.innerHTML = files.map((f, i) => `
      <li class="file-row">
        <span>${escapeHTML(f.name)} <small>(${Math.ceil((f.size||0)/1024)} KB)</small></span>
        <button class="remove" data-i="${i}" title="Remove">✕</button>
      </li>
    `).join("");
    fileList.querySelectorAll("button.remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = +btn.dataset.i;
        files.splice(i, 1);
        renderFileList();
        enableRunIfReady();
        resetDownloads();
      });
    });
  }
  txtEl.addEventListener("input", () => { enableRunIfReady(); resetDownloads(); });

  // ======= Main actions =======
  runBtn.addEventListener("click", onRun);
  clearBtn.addEventListener("click", () => {
    txtEl.value = "";
    files = [];
    lastTextLines = [];
    lastTextVerdicts = [];
    renderFileList();
    enableRunIfReady();
    setOutput(`<p>Cleared.</p>`);
    resetDownloads();
  });
  // ORIGINAL-PDF download button (highlighted original when uploaded PDF flow)
  dlBtn.addEventListener("click", () => {
    if (!highlightedPdfBlobUrl) return;
    const a = document.createElement("a");
    a.href = highlightedPdfBlobUrl;
    a.download = "MediLens_Highlighted.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  async function onRun() {
    resetDownloads();

    const rawText = txtEl.value;
    const text = rawText.trim();
    const onlyPdf = files.length === 1 && files[0].type === "application/pdf";

    // ===== TEXT MODE =====
    if (text && !files.length) {
      const lines = splitIntoMeaningfulLines(rawText);
      if (!lines.length) {
        setOutput(`<p>Nothing to verify. Please type some lines.</p>`);
        return;
      }
      setOutput(`<p>Checking ${lines.length} line(s)…</p>`);
      const verdicts = await verifyChunks(lines);

      lastTextLines = lines.slice(0);
      lastTextVerdicts = verdicts.slice(0);

      setOutput(renderHighlightedLines(lines, verdicts));

      try {
        linesPdfBlobUrl = await makeLinesPdf(lines, verdicts);
        if (!ensureValidBlob(linesPdfBlobUrl)) throw new Error("Invalid PDF blob");
      } catch (e) {
        console.error(e);
        linesPdfBlobUrl = null;
      }
      appendOutput(renderLinesDownloadBlock(linesPdfBlobUrl));
      wireLinesDownloadButtons();
      return;
    }

    // ===== SINGLE PDF MODE (NO 20-LINE CAP): extract all items, verify all, highlight all =====
    if (onlyPdf) {
      try {
        const file = files[0];
        setOutput(`<p>Reading PDF…</p>`);
        const arrayBuf = await file.arrayBuffer();

        // Clone buffers for each library (Safari fix)
        const bufForPdfJs  = arrayBuf.slice(0);
        const bufForPdfLib = arrayBuf.slice(0);

        // Extract items
        const { pages, items } = await extractPdfTextItems(bufForPdfJs);
        if (!items.length) {
          setOutput(`<p>No readable text found in the PDF.</p>`);
          return;
        }

        setOutput(`<p>Verifying ${items.length} text line(s)…</p>`);
        const verdicts = await verifyChunks(items.map(i => i.text));
        for (let i = 0; i < items.length; i++) items[i].verdict = (verdicts[i] || "uncertain").toLowerCase();

        const linesByPage = groupItemsByPage(items);
        setOutput(renderHighlightedPdfExtractedLines(linesByPage));

        // Keep caches so we can also export a Lines Summary PDF
        lastTextLines = items.map(i => i.text);
        lastTextVerdicts = verdicts.slice(0);

        appendOutput(`<p style="margin-top:12px;">Generating highlighted original PDF…</p>`);
        const originalBlob = await makeHighlightedPdf(bufForPdfLib, pages, items);
        if (!ensureValidBlob(originalBlob)) {
          throw new Error("Failed to create highlighted original PDF");
        }
        highlightedPdfBlobUrl = URL.createObjectURL(originalBlob);
        dlBtn.disabled = false;

        // Lines Summary PDF
        try {
          linesPdfBlobUrl = await makeLinesPdf(lastTextLines, lastTextVerdicts);
          if (!ensureValidBlob(linesPdfBlobUrl)) throw new Error("Invalid Lines PDF blob");
        } catch (e) {
          console.error(e);
          linesPdfBlobUrl = null;
        }
        appendOutput(renderBothDownloadsBlock(linesPdfBlobUrl));
        wireLinesDownloadButtons();
        return;
      } catch (e) {
        console.error(e);
        setOutput(`<p style="color:#b91c1c;">${escapeHTML(e?.message || "PDF processing failed")}</p>`);
        return;
      }
    }

    // ===== OTHER FILES =====
    if (files.length) {
      setOutput(`<p>Uploading ${files.length} file(s)…</p>`);
      const fd = new FormData();
      files.forEach((f, idx) => fd.append(`file${idx}`, f, f.name));
      const res = await postForm(END_CHECK_FILE, fd);
      if (!res?.ok) return setOutput(`<p style="color:#b91c1c;">${escapeHTML(res?.error || "Failed to check files")}</p>`);
      const rows = (res.results || []).map(r => {
        const d = r.data || {};
        const v = (d.verdict || "uncertain").toLowerCase();
        const st = verdictStyles(v);
        return `
          <div class="result file">
            <div class="file-name">${escapeHTML(r.filename || "")} <small>(${escapeHTML(r.kind || "")}, ${r.characters||0} chars)</small></div>
            <div class="ml-chip ${st.label.toLowerCase()}" style="background:${st.chip}">${st.label}</div>
            <div class="section"><div class="h">Reason</div><div>${escapeHTML(d.reason || "")}</div></div>
            <div class="section"><div class="h">Sources</div>${renderSources(d.sources)}</div>
          </div>
        `;
      }).join("");
      setOutput(rows || `<p>No results.</p>`);
      return;
    }

    setOutput(`<p>Please enter text or upload files first.</p>`);
  }

  // ====== RENDERERS ======
  function renderSources(sources) {
    if (!Array.isArray(sources) || !sources.length) return "<p style='opacity:.8'>No sources provided.</p>";
    return sources.map(s => {
      const t = escapeHTML(s.title || s.url);
      const u = escapeHTML(s.url || "#");
      return `<div><a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a></div>`;
    }).join("");
  }

  // Render for TEXT MODE lines with highlight ON THE TEXT
  function renderHighlightedLines(lines, verdicts) {
    const rows = lines.map((line, i) => {
      const v  = (verdicts[i] || "uncertain").toLowerCase();
      const st = verdictStyles(v);
      const text = escapeHTML(line || "");
      return `
        <div class="vline" style="display:flex; gap:8px; align-items:flex-start; margin:6px 0;">
          <div class="ml-chip" style="background:${st.chip}; color:#fff; font-size:12px; padding:2px 8px; border-radius:999px; flex:0 0 auto;">${st.label}</div>
          <div class="line-text" style="flex:1 1 auto;">
            <span style="background:${st.rgba}; padding:2px 4px; border-radius:4px; display:inline;">${text}</span>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div>
        ${rows}
        <div id="lines-pdf-slot" style="margin-top:14px;"></div>
      </div>
    `;
  }

  // Render when a PDF was uploaded: group by page, each item highlighted as "line"
  function renderHighlightedPdfExtractedLines(linesByPage) {
    const sections = linesByPage.map(({pageIndex, items}) => {
      const inner = items.map((it) => {
        const v  = (it.verdict || "uncertain").toLowerCase();
        const st = verdictStyles(v);
        const text = escapeHTML(it.text || "");
        return `
          <div class="vline" style="display:flex; gap:8px; align-items:flex-start; margin:6px 0;">
            <div class="ml-chip" style="background:${st.chip}; color:#fff; font-size:12px; padding:2px 8px; border-radius:999px;">${st.label}</div>
            <div class="line-text" style="flex:1 1 auto;">
              <span style="background:${st.rgba}; padding:2px 4px; border-radius:4px; display:inline;">${text}</span>
            </div>
          </div>
        `;
      }).join("");
      return `
        <div class="page-block" style="margin:10px 0 16px;">
          <div style="font-weight:600; opacity:.8; margin-bottom:4px;">Page ${pageIndex + 1}</div>
          ${inner || `<div style="opacity:.6;">(No lines)</div>`}
        </div>
      `;
    }).join("");
    return `
      <div>
        ${sections}
        <div id="lines-pdf-slot" style="margin-top:14px;"></div>
      </div>
    `;
  }

  function renderLinesDownloadBlock(linesBlobUrl) {
    const disabled = !linesBlobUrl ? "disabled" : "";
    return `
      <div class="download-block" style="margin-top:16px; display:flex; gap:10px; align-items:center;">
        <button id="download-lines-pdf" ${disabled} style="padding:8px 12px; border-radius:8px; background:#111827; color:#fff; border:none; cursor:${disabled?"not-allowed":"pointer"}">
          Download Highlighted PDF (Lines)
        </button>
      </div>
    `;
  }

  function renderBothDownloadsBlock(linesBlobUrl) {
    const disabled = !linesBlobUrl ? "disabled" : "";
    return `
      <div class="download-block" style="margin-top:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="download-lines-pdf" ${disabled} style="padding:8px 12px; border-radius:8px; background:#111827; color:#fff; border:none; cursor:${disabled?"not-allowed":"pointer"}">
          Download Highlighted PDF (Lines)
        </button>
        <span style="opacity:.8; font-size:12px;">(Use the top “Download Highlighted PDF” button to get the original PDF with in-place highlights.)</span>
      </div>
    `;
  }

  function wireLinesDownloadButtons() {
    const btn = document.getElementById("download-lines-pdf");
    if (btn && linesPdfBlobUrl) {
      btn.disabled = false;
      btn.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = linesPdfBlobUrl;
        a.download = "MediLens_Lines_Highlighted.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, { once: true });
    }
  }

  // ======= TEXT / LINES HELPERS =======
  function splitIntoMeaningfulLines(raw) {
    return String(raw)
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*\d+\.\s+/, "").trim())
      .filter(Boolean);
  }

  function groupItemsByPage(items) {
    const map = new Map();
    for (const it of items) {
      const arr = map.get(it.pageIndex) || [];
      arr.push(it);
      map.set(it.pageIndex, arr);
    }
    const out = [];
    for (const [pageIndex, arr] of map.entries()) {
      out.push({ pageIndex, items: arr });
    }
    out.sort((a,b)=>a.pageIndex-b.pageIndex);
    return out;
  }

  // ======= PDF EXTRACT (pdf.js) =======
  async function extractPdfTextItems(arrayBufLike) {
    const pdfjsLib = window["pdfjs-dist/build/pdf"];
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBufLike) });
    const pdf = await loadingTask.promise;

    const pages = [];
    const items = [];
    const MAX_ITEMS = 10000; // high cap; effectively "no 20-line limit"

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ width: viewport.width, height: viewport.height });

      const textContent = await page.getTextContent();
      for (const item of textContent.items) {
        const str = (item.str || "").replace(/\s+/g, " ").trim();
        if (!str || str.length < 2) continue;

        // transform: [a,b,c,d,e,f]
        const [a,b,c,d,e,f] = item.transform;
        const w = item.width || Math.hypot(a, b);
        const h = Math.max(Math.hypot(a, b), Math.hypot(c, d)) * 0.9;

        // pdf.js coords origin = top-left
        const x = e;
        const yTop = f;
        const y = yTop - h;

        items.push({
          pageIndex: p - 1,
          text: str,
          bbox: { x, y, w, h }
        });

        if (items.length >= MAX_ITEMS) break;
      }
      if (items.length >= MAX_ITEMS) break;
    }
    return { pages, items };
  }

  // ======= VERIFY in BATCH (fallback to /check) =======
  async function verifyChunks(texts) {
    const clean = texts.map(t => (t || "").toString().trim());

    // Try /check_batch
    try {
      const r = await fetch(API_BASE + END_CHECK_BATCH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: clean })
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.ok && Array.isArray(j.results)) {
          // Normalize length: if backend trimmed, fill rest as "uncertain"
          const out = new Array(clean.length).fill("uncertain");
          for (let i = 0; i < Math.min(out.length, j.results.length); i++) {
            out[i] = (j.results[i]?.verdict || "uncertain").toLowerCase();
          }
          return out;
        }
      }
    } catch (_) {}

    // Fallback: chunked /check
    const out = new Array(clean.length).fill("uncertain");
    const BATCH = 12;
    for (let i = 0; i < clean.length; i += BATCH) {
      const slice = clean.slice(i, i + BATCH);
      const results = await Promise.all(
        slice.map(t => postJSON(END_CHECK, { text: t }).catch(()=>null))
      );
      results.forEach((r, k) => {
        const idx = i + k;
        if (r?.ok) out[idx] = (r.data?.verdict || "uncertain").toLowerCase();
      });
    }
    return out;
  }

  // ======= BUILD HIGHLIGHTED ORIGINAL PDF (pdf-lib rectangles) =======
  async function makeHighlightedPdf(srcArrayBuf, pagesMeta, items) {
    const { PDFDocument, rgb } = PDFLib;
    const src = await PDFDocument.load(srcArrayBuf);
    const dst = await PDFDocument.create();
    const copied = await dst.copyPages(src, src.getPageIndices());
    copied.forEach(p => dst.addPage(p));

    const colorMap = {
      "true":       rgb(...rgbForPdf("true")),
      "false":      rgb(...rgbForPdf("false")),
      "misleading": rgb(...rgbForPdf("misleading")),
      "uncertain":  rgb(...rgbForPdf("uncertain"))
    };

    for (const it of items) {
      const v = (it.verdict || "uncertain").toLowerCase();
      const page = dst.getPage(it.pageIndex);
      if (!page) continue;

      const srcMeta = pagesMeta[it.pageIndex];
      const scaleX = page.getWidth()  / srcMeta.width;
      const scaleY = page.getHeight() / srcMeta.height;

      const x = it.bbox.x * scaleX;
      const h = it.bbox.h * scaleY;
      const yFromTop = it.bbox.y * scaleY;
      const y = page.getHeight() - (yFromTop + h); // convert to bottom-left origin
      const w = it.bbox.w * scaleX;

      const col = colorMap[v] || colorMap["uncertain"];
      try {
        page.drawRectangle({
          x, y, width: Math.max(1, w), height: Math.max(1, h),
          color: col, opacity: 0.22, borderOpacity: 0, borderWidth: 0
        });
      } catch {}
    }

    // Better compatibility with some viewers (incl. macOS Preview oddities)
    const bytes = await dst.save({ useObjectStreams: false });
    const blob = new Blob([bytes], { type: "application/pdf" });
    if (!ensureValidBlob(blob)) throw new Error("Generated original PDF is invalid");
    return blob;
  }

  // ======= BUILD LINES SUMMARY PDF (pdf-lib) with wrapping & chip =======
  async function makeLinesPdf(lines, verdicts) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error("No lines to render");
    }
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const pdf = await PDFDocument.create();

    // Add at least one page to ensure non-empty PDF
    const margin = 50;
    const pageWidth  = 612; // Letter width
    const pageHeight = 792; // Letter height
    let page = pdf.addPage([pageWidth, pageHeight]);

    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontSize = 12;
    const lineGap = 8;

    let y = pageHeight - margin;

    function ensureRoom(heightNeeded) {
      if (y - heightNeeded < margin) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
    }

    // Word-wrapping helper
    function wrapLines(text, maxWidth) {
      const words = String(text || "").split(/\s+/);
      const linesOut = [];
      let current = "";
      for (const w of words) {
        const test = current ? (current + " " + w) : w;
        const width = font.widthOfTextAtSize(test, fontSize);
        if (width <= maxWidth) {
          current = test;
        } else {
          if (current) linesOut.push(current);
          // If a single word is longer than the width, hard-break it
          if (font.widthOfTextAtSize(w, fontSize) > maxWidth) {
            let chunk = "";
            for (const ch of w) {
              const tryChunk = chunk + ch;
              if (font.widthOfTextAtSize(tryChunk, fontSize) <= maxWidth) {
                chunk = tryChunk;
              } else {
                if (chunk) linesOut.push(chunk);
                chunk = ch;
              }
            }
            current = chunk;
          } else {
            current = w;
          }
        }
      }
      if (current) linesOut.push(current);
      return linesOut;
    }

    const textAreaWidth = pageWidth - margin*2;

    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] || "").toString();
      const v   = (verdicts[i] || "uncertain").toLowerCase();
      const color = rgb(...rgbForPdf(v));

      // Chip label
      const label = (v === "true") ? "TRUE" :
                    (v === "false") ? "FALSE" :
                    (v === "misleading") ? "MISLEADING" : "UNCERTAIN";
      const chipText = `[${label}] `;

      // Wrap the text (excluding chip)
      const wrapped = wrapLines(raw, textAreaWidth - font.widthOfTextAtSize(chipText, fontSize));
      const numLines = Math.max(1, wrapped.length);
      const textHeight = fontSize * 1.2 * numLines;

      ensureRoom(textHeight + lineGap);

      // Colored background behind the block
      page.drawRectangle({
        x: margin - 2,
        y: y - textHeight + 2,
        width: textAreaWidth + 4,
        height: textHeight,
        color,
        opacity: 0.22
      });

      // Chip background (solid) for first line height only
      const chipW = font.widthOfTextAtSize(chipText, fontSize);
      page.drawRectangle({
        x: margin - 2,
        y: y - fontSize * 1.2 + 2,
        width: chipW + 6,
        height: fontSize * 1.2,
        color,
        opacity: 1
      });

      // Chip text (white)
      page.drawText(chipText, {
        x: margin + 2,
        y: y - fontSize,
        size: fontSize,
        font,
        color: rgb(1,1,1)
      });

      // Draw wrapped lines after chip
      let lineY = y - fontSize;
      for (let li = 0; li < wrapped.length; li++) {
        const lineText = wrapped[li];
        const x = margin + chipW + 8;
        page.drawText(lineText, {
          x,
          y: lineY,
          size: fontSize,
          font,
          color: rgb(0,0,0)
        });
        lineY -= fontSize * 1.2;
      }

      y -= (textHeight + lineGap);
    }

    const bytes = await pdf.save({ useObjectStreams: false }); // improves compatibility
    const blob = new Blob([bytes], { type: "application/pdf" });
    if (!ensureValidBlob(blob)) throw new Error("Generated Lines PDF is invalid");
    return blob;
  }

  // ======= IMAGE PASTE quick-check (unchanged) =======
  document.addEventListener("paste", async (e) => {
    if (!e.clipboardData) return;
    const items = Array.from(e.clipboardData.items || []);
    const imgItem = items.find(x => x.kind === "file" && x.type.startsWith("image/"));
    if (!imgItem) return;
    const file = imgItem.getAsFile();
    if (!file) return;
    setOutput(`<p>Checking pasted image…</p>`);
    const fd = new FormData();
    fd.append("file", file, file.name || "pasted.png");
    const res = await postForm(END_CHECK_IMG, fd);
    if (!res?.ok) return setOutput(`<p style="color:#b91c1c;">${escapeHTML(res?.error || "Failed to check image")}</p>`);
    const d = res.data || {};
    const v = (d.verdict || "uncertain").toLowerCase();
    const st = verdictStyles(v);
    setOutput(`
      <div class="result">
        <div class="ml-chip ${st.label.toLowerCase()}" style="background:${st.chip}">${st.label}</div>
        <div class="section"><div class="h">Reason</div><div>${escapeHTML(d.reason || "")}</div></div>
        <div class="section"><div class="h">Sources</div>${renderSources(d.sources)}</div>
        <div class="section"><div class="h">OCR Text</div><pre class="ocr">${escapeHTML(d.ocr_text || "")}</pre></div>
      </div>
    `);
  });

  // ======= HTTP helpers =======
  async function postJSON(path, data) {
    try {
      const r = await fetch(API_BASE + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data || {})
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: e?.message || "Network error" };
    }
  }
  async function postForm(path, formData) {
    try {
      const r = await fetch(API_BASE + path, { method: "POST", body: formData });
      return await r.json();
    } catch (e) {
      return { ok: false, error: e?.message || "Network error" };
    }
  }

  // ======= Safety: ensure Blob is a real PDF (non-empty) before enabling download =======
  function ensureValidBlob(blob) {
    try {
      if (!blob) return false;
      if (!(blob instanceof Blob)) return false;
      if (blob.type !== "application/pdf") return false;
      // Size heuristic: > 1KB to avoid zero-length/corrupt files
      if (blob.size < 1024) return false;
      return true;
    } catch { return false; }
  }
})();
