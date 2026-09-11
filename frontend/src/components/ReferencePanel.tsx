// Reference image for a scenario: upload / paste / drag-drop your own, or
// generate a key visual with Flux from the reference prompt. Versioned; the
// main version anchors every keyframe (Flux reference conditioning).
// Shared by the sequence gallery and the director dailies.
import { useEffect, useRef, useState } from "react";
import { generateRef, outputUrl, uploadRef } from "../api";
import type { AssetVersion, OutputsInfo } from "../types";
import { VersionRow } from "./VersionRow";
import { IconClipboard, IconUpload, IconUserCheck } from "./Icons";

type RefMode = "generate" | "upload";

interface Props {
  scenario: string;
  versions: AssetVersion[];
  main: string | null;
  hasPrompt: boolean;      // scenario has a reference prompt (Generate possible)
  generating: boolean;     // a run is rendering this reference right now
  locked: boolean;         // a run is active — no standalone generation / regen
  portrait?: boolean;
  onChanged: (o: OutputsInfo) => void; // outputs payload after upload / generate / select
  onSelect: (file: string) => void;
  onRegen?: () => void;
}

export default function ReferencePanel({ scenario, versions, main, hasPrompt, generating, locked, portrait, onChanged, onSelect, onRegen }: Props) {
  const [refMode, setRefMode] = useState<RefMode>(() => (localStorage.getItem("ss-refmode") === "generate" ? "generate" : "upload"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refFile = main || versions[versions.length - 1]?.file || null;
  const setMode = (m: RefMode) => { setRefMode(m); localStorage.setItem("ss-refmode", m); };

  const doGenerate = async () => {
    if (!scenario || busy) return;
    setBusy(true);
    setError("");
    try { onChanged(await generateRef(scenario)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const doUpload = async (f: File) => {
    if (!scenario || busy) return;
    if (!f.type.startsWith("image/")) { setError("not an image file"); return; }
    setBusy(true);
    setError("");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("could not read file"));
        r.readAsDataURL(f);
      });
      onChanged(await uploadRef(scenario, data));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Ctrl+V anywhere uploads a clipboard image while in upload mode.
  useEffect(() => {
    if (refMode !== "upload") return;
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (f) { e.preventDefault(); doUpload(f); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [refMode, scenario, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const rendering = generating || busy;

  return (
    <div className="ref-panel">
      <div className="section-label">
        <IconUserCheck size={11} /> Reference
        {versions.length > 1 && <span className="muted ll"> · {versions.length} takes</span>}
        {refFile && <span className="ref-live" title="Every keyframe is conditioned on this image">anchors all shots</span>}
        <span className="spacer" />
        <span className="seg mini">
          <button className={refMode === "upload" ? "on" : ""} onClick={() => setMode("upload")}><IconUpload size={10} /> Upload</button>
          <button className={refMode === "generate" ? "on" : ""} onClick={() => setMode("generate")} disabled={!hasPrompt} title={hasPrompt ? "Generate with Flux from the reference prompt" : "Add a reference prompt in the script first"}>Generate</button>
        </span>
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); }} />
      <div
        className={`upload-zone ${portrait ? "portrait" : ""} ${dragOver ? "over" : ""} ${busy ? "busy" : ""} ${refFile ? "filled" : ""}`}
        onClick={() => refMode === "upload" && fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) doUpload(f); }}
      >
        {refFile ? (
          <>
            <img src={outputUrl(scenario, refFile)} alt="reference" loading="lazy" />
            {refMode === "upload" && <span className="upload-replace">Click to replace</span>}
            {rendering && <span className="frame-tag live">{busy ? "UPLOADING" : "RENDERING"}</span>}
          </>
        ) : (
          <div className="upload-empty">
            {rendering ? (
              <span className="gen-flag"><span className="dot pulse" /> {busy ? "working…" : "rendering…"}</span>
            ) : refMode === "upload" ? (
              <>
                <span className="upload-empty-icon"><IconUpload size={20} /></span>
                <span className="upload-empty-title">Drop the subject’s image here</span>
                <span className="upload-empty-sub">or click to browse · Ctrl+V pastes</span>
              </>
            ) : (
              <>
                <span className="upload-empty-title">No key visual yet</span>
                <span className="upload-empty-sub">Generate one with Flux from the reference prompt</span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="ref-actions">
        {refMode === "generate" ? (
          <button onClick={doGenerate} disabled={rendering || locked || !hasPrompt} title="Generate a new take with Flux (previous takes kept). With a reference already set, the subject is kept.">
            {refFile ? "Re-roll key visual" : "Generate key visual"}
          </button>
        ) : (
          <>
            <button onClick={() => fileInputRef.current?.click()} disabled={busy}><IconUpload size={11} /> Browse</button>
            <button disabled={busy} title="Paste the clipboard image (or press Ctrl+V anywhere)"
              onClick={async () => {
                try {
                  const items = await navigator.clipboard.read();
                  const img = items.find((i) => i.types.some((t) => t.startsWith("image/")));
                  if (!img) { setError("no image on the clipboard"); return; }
                  const t = img.types.find((x) => x.startsWith("image/"))!;
                  doUpload(new File([await img.getType(t)], "clipboard.png", { type: t }));
                } catch { setError("clipboard unavailable — copy an image or use Ctrl+V"); }
              }}>
              <IconClipboard size={11} /> Paste
            </button>
          </>
        )}
        <VersionRow versions={versions} main={main} kind="image" onSelect={onSelect} onRegen={hasPrompt ? onRegen : undefined} generating={generating} disabled={locked} regenLabel="re-roll" />
      </div>
      {error && <p className="hint err-text">{error}</p>}
      <p className="hint">
        {refMode === "upload"
          ? "Upload the subject, then optionally Generate to restyle it with the reference prompt — the main take anchors every keyframe."
          : "Flux renders the key visual; if a reference is already set it keeps that subject. Pick a take to make it main."}
      </p>
    </div>
  );
}
