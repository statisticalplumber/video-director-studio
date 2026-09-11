// Img2Img tab: upload an image + write a prompt -> Flux img2img -> new image.
// Same Flux img2img wiring as reference generation (POST /api/img2img).
import { useEffect, useRef, useState } from "react";
import { outputUrl } from "../api";
import { IconImage, IconUpload, IconX, Spinner } from "./Icons";

export default function Img2Img() {
  const [src, setSrc] = useState<string | null>(null); // uploaded image (data URL)
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null); // generated file
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (f: File) => {
    if (!f.type.startsWith("image/")) { setError("not an image file"); return; }
    setError("");
    const r = new FileReader();
    r.onload = () => setSrc(String(r.result));
    r.onerror = () => setError("could not read file");
    r.readAsDataURL(f);
  };

  // Paste support (Ctrl+V an image anywhere on the page while this tab is open).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); readFile(f); return; }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    if (!src || !prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/img2img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: src, prompt }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResult(d.file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ width: "100%", maxWidth: 620, margin: "0 auto" }}>
      <section className="card">
        <div className="card-head">
          <h2>
            <span className="head-icon"><IconImage size={15} /></span>
            Img2Img
          </h2>
          {busy && <span className="pill running"><Spinner size={11} /> generating</span>}
        </div>

        <div
          className={`upload-zone ${drag ? "over" : ""} ${busy ? "busy" : ""} ${src ? "filled" : ""}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); }}
        >
          {src ? (
            <>
              <img src={src} alt="source" />
              <span className="upload-replace">Click to replace</span>
            </>
          ) : (
            <div className="upload-empty">
              {busy ? (
                <span className="gen-flag"><span className="dot pulse" /> generating…</span>
              ) : (
                <>
                  <span className="upload-empty-icon">
                    <IconUpload size={22} />
                  </span>
                  <span className="upload-empty-title">Drop an image here</span>
                  <span className="upload-empty-sub">or click to browse · paste (Ctrl+V) works too</span>
                </>
              )}
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ""; }}
          />
        </div>
        {src && (
          <div className="ref-actions">
            <button onClick={() => { setSrc(null); setResult(null); }} disabled={busy}>
              <IconX size={11} /> Clear image
            </button>
          </div>
        )}

        <label>Prompt</label>
        <textarea
          rows={3}
          value={prompt}
          placeholder="Describe the new image — Flux re-renders the uploaded image toward this prompt"
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={generate} disabled={busy || !src || !prompt.trim()}>
            {busy ? <Spinner size={13} /> : <IconImage size={13} />}
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
        {error && <p className="hint err-text">{error}</p>}

        {result && (
          <>
            <div className="section-label">Result</div>
            <div className="img-frame">
              <img src={outputUrl("img2img", result)} alt="generated" />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
