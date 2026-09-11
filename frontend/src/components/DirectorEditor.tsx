// Director's script: character & reference, voiceover (script + voice
// direction), score, format, and the shot list with a storyboard timeline.
// Feeds scripts/movie_director.mjs. Autosaves like ScenarioEditor.
import { useEffect, useRef, useState } from "react";
import type { DirectorScenario, DirectorShot } from "../types";
import { IconCheck, IconClapper, IconMic, IconMusic, IconPlus, IconUserCheck, IconX } from "./Icons";

interface Props {
  name: string;
  config: DirectorScenario;
  isDraft: boolean;
  onSave: (cfg: DirectorScenario) => Promise<void>;
}

const AUTOSAVE_DELAY_MS = 800;
const WORDS_PER_SEC = 2.4; // calm documentary delivery

// Same composition as the server's composeNarration (frontend/server.mjs).
const composeNarration = (voice: string, script: string) =>
  `${voice.trim()} The narrator says, slowly and clearly: "${script.trim()}"`;

// Older configs only carry narrationPrompt — recover voice + script from it.
const voiceOf = (c: DirectorScenario) =>
  c.voice ?? c.narrationPrompt.split(/\s+(?:He|She|The narrator) says\b/)[0].trim();
const scriptOf = (c: DirectorScenario) =>
  c.narrationScript ?? (c.narrationPrompt.match(/"([^"]+)"\s*$/)?.[1] || "");

const RATIOS = [
  { id: "9:16 (Portrait Widescreen)", label: "Vertical 9:16", w: 768, h: 1280 },
  { id: "16:9 (Widescreen)", label: "Wide 16:9", w: 1280, h: 768 },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export default function DirectorEditor({ name, config, isDraft, onSave }: Props) {
  const init = (c: DirectorScenario) => ({ ...c, voice: voiceOf(c), narrationScript: scriptOf(c) });
  const [cfg, setCfg] = useState<DirectorScenario>(() => init(config));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setCfg(init(config)); setSaved(false); }, [config]);

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const isDraftRef = useRef(isDraft);
  isDraftRef.current = isDraft;
  useEffect(() => () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); }, []);

  const doSave = async (next: DirectorScenario = cfg, auto = false) => {
    setSaving(true);
    setError("");
    try {
      await onSave(next);
      setSaved(true);
    } catch (e) {
      if (!auto) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const set = (patch: Partial<DirectorScenario>) => {
    const next = { ...cfg, ...patch };
    if ("voice" in patch || "narrationScript" in patch)
      next.narrationPrompt = composeNarration(next.voice ?? "", next.narrationScript ?? "");
    setCfg(next);
    setSaved(false);
    if (isDraftRef.current) return; // drafts only persist on explicit save
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => void doSave(cfgRef.current, true), AUTOSAVE_DELAY_MS);
  };
  const setShot = (i: number, patch: Partial<DirectorShot>) =>
    set({ sequence: cfg.sequence.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const addShot = () =>
    set({ sequence: [...cfg.sequence, { title: `shot${cfg.sequence.length + 1}`, duration: 4, image: "", motion: "", useRef: true }] });
  const removeShot = (i: number) => set({ sequence: cfg.sequence.filter((_, j) => j !== i) });
  const moveShot = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= cfg.sequence.length) return;
    const seq = [...cfg.sequence];
    [seq[i], seq[j]] = [seq[j], seq[i]];
    set({ sequence: seq });
  };

  const vo = cfg.narrationDuration ?? 20;
  const words = (cfg.narrationScript || "").trim().split(/\s+/).filter(Boolean).length;
  const spoken = words / WORDS_PER_SEC;
  const fit = spoken / vo;
  const fitClass = fit > 1.1 ? "over" : fit < 0.7 ? "under" : "ok";
  const runtime = cfg.sequence.reduce((t, s) => t + (s.duration ?? 4), 0);
  const cut = cfg.finalDuration ?? vo;
  const ratio = RATIOS.find((r) => r.id === cfg.ratio) ?? RATIOS[0];
  const span = Math.max(runtime, cut, 1);
  const hasMusic = !!(cfg.musicPrompt || "").trim();

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconClapper size={15} /></span>
          Director’s script
          {isDraft && <span className="pill warn">draft · unsaved</span>}
        </h2>
        <span className="spacer" />
        <span className="mono-name">{name}</span>
        <button className="primary" onClick={() => doSave()} disabled={saving || (saved && !isDraft)}>
          <IconCheck size={13} />
          {saving ? "Saving…" : saved && !isDraft ? "Saved" : isDraft ? "Save trailer" : "Save"}
        </button>
      </div>
      {cfg.description && <p className="card-desc">{cfg.description}</p>}
      {error && <p className="hint err-text">{error}</p>}

      <div className="section-label"><IconUserCheck size={11} /> Character &amp; reference</div>
      <label>Character — the recurring subject (reused verbatim in shots)</label>
      <textarea rows={2} value={cfg.character ?? ""} placeholder="e.g. a small red fox with a white-tipped tail and a torn left ear"
        onChange={(e) => set({ character: e.target.value })} />
      <label>Reference prompt — Flux key visual (used when you Generate the reference)</label>
      <textarea rows={2} value={cfg.referencePrompt ?? ""} placeholder="the character block + neutral pose, setting, lighting, lens"
        onChange={(e) => set({ referencePrompt: e.target.value })} />
      <p className="hint">Upload or generate the reference in Dailies. Shots marked <b>ref</b> are conditioned on it so the subject stays the same.</p>

      <div className="section-label"><IconMic size={11} /> Voiceover</div>
      <label>Narration script — spoken words</label>
      <textarea rows={5} value={cfg.narrationScript} onChange={(e) => set({ narrationScript: e.target.value })} />
      <div className={`vo-meter ${fitClass}`} title={`${words} words ≈ ${spoken.toFixed(1)}s at ${WORDS_PER_SEC} words/s`}>
        <span className="vo-bar"><span style={{ width: `${Math.min(100, fit * 100)}%` }} /></span>
        <span>{words} words · ≈{spoken.toFixed(0)}s of {vo}s</span>
        <span className="vo-verdict">
          {fitClass === "over" ? "too long — will be cut off" : fitClass === "under" ? "room for more" : "fits"}
        </span>
      </div>
      <label>Voice &amp; sound direction</label>
      <textarea rows={3} value={cfg.voice} onChange={(e) => set({ voice: e.target.value })} />

      <div className="section-label"><IconMusic size={11} /> Score</div>
      <label>Music cue — leave empty for no music</label>
      <textarea rows={2} value={cfg.musicPrompt ?? ""} placeholder="e.g. slow cinematic strings and low brass swell, distant taiko, builds to a hopeful major chord, no vocals"
        onChange={(e) => set({ musicPrompt: e.target.value })} />
      {hasMusic && (
        <div className="field-grid">
          <div>
            <label>Music under VO · {Math.round((cfg.musicVolume ?? 0.35) * 100)}%</label>
            <input type="range" min={0} max={1} step={0.05} value={cfg.musicVolume ?? 0.35}
              onChange={(e) => set({ musicVolume: Number(e.target.value) })} />
          </div>
        </div>
      )}

      <div className="section-label">Timing &amp; format</div>
      <div className="field-grid">
        <div>
          <label>VO length (s)</label>
          <input type="number" min={5} max={40} value={vo} onChange={(e) => set({ narrationDuration: Number(e.target.value) || 20 })} />
        </div>
        <div>
          <label>Final cut (s)</label>
          <input type="number" min={1} max={60} value={cut} onChange={(e) => set({ finalDuration: Number(e.target.value) || undefined })} />
        </div>
        <div>
          <label>Shot audio under VO · {Math.round((cfg.clipAudioVolume ?? 0.2) * 100)}%</label>
          <input type="range" min={0} max={1} step={0.05} value={cfg.clipAudioVolume ?? 0.2}
            onChange={(e) => set({ clipAudioVolume: Number(e.target.value) })} />
        </div>
      </div>
      <span className="seg" style={{ marginTop: 10 }}>
        {RATIOS.map((r) => (
          <button key={r.id} className={ratio.id === r.id ? "on" : ""}
            onClick={() => set({ ratio: r.id, keyframeWidth: r.w, keyframeHeight: r.h })}>
            {r.label}
          </button>
        ))}
      </span>

      <div className="section-label">
        Storyboard
        <span className={`runtime ${Math.abs(runtime - cut) > 2 ? "warn" : ""}`}>
          shots {runtime}s · cut {cut}s · VO {vo}s
        </span>
      </div>
      <div className="timeline" aria-label="Storyboard timeline">
        <div className="tl-track shots">
          {cfg.sequence.map((s, i) => (
            <span key={i} className={`tl-shot ${s.useRef === false ? "noref" : ""}`}
              style={{ width: `${((s.duration ?? 4) / span) * 100}%` }} title={`${i + 1}. ${s.title} · ${s.duration ?? 4}s`}>
              <b>{i + 1}</b> {s.title}
            </span>
          ))}
        </div>
        <div className="tl-track vo"><span style={{ width: `${(vo / span) * 100}%` }}>VO</span></div>
        {hasMusic && <div className="tl-track music"><span style={{ width: `${(cut / span) * 100}%` }}>score</span></div>}
        <span className="tl-cut" style={{ left: `${(cut / span) * 100}%` }} title={`final cut ends at ${cut}s`} />
      </div>

      {cfg.sequence.map((s, i) => (
        <div className="shot-card" key={i}>
          <div className="shot-head">
            <span className="shot-no">SHOT {String(i + 1).padStart(2, "0")}</span>
            <input className="shot-title" value={s.title} placeholder="title (file-safe)"
              onChange={(e) => setShot(i, { title: slug(e.target.value) || e.target.value })} />
            <label className="shot-dur" title="Clip duration (s)">
              <input type="number" min={2} max={8} value={s.duration ?? 4}
                onChange={(e) => setShot(i, { duration: Number(e.target.value) || 4 })} />
              s
            </label>
            <button className={`toggle ${s.useRef !== false ? "on" : ""}`} onClick={() => setShot(i, { useRef: s.useRef === false })}
              title={s.useRef !== false ? "Keyframe is conditioned on the reference image" : "Keyframe ignores the reference (establishing shot)"}>
              <IconUserCheck size={11} /> ref
            </button>
            <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => moveShot(i, -1)}>↑</button>
            <button className="icon-btn" title="Move down" disabled={i === cfg.sequence.length - 1} onClick={() => moveShot(i, 1)}>↓</button>
            <button className="icon-btn danger" title="Remove shot" onClick={() => removeShot(i)}>
              <IconX size={13} />
            </button>
          </div>
          <label>Keyframe — Flux image</label>
          <textarea rows={2} value={s.image} onChange={(e) => setShot(i, { image: e.target.value })} />
          <label>Motion &amp; camera — LTX video</label>
          <textarea rows={2} value={s.motion} onChange={(e) => setShot(i, { motion: e.target.value })} />
        </div>
      ))}
      <div className="row" style={{ marginTop: 4 }}>
        <button className="ghost" onClick={addShot}>
          <IconPlus size={13} />
          Add shot
        </button>
      </div>
      <p className="hint">
        LTX generates the voiceover and score from their prompts; Flux renders keyframes anchored to the reference; LTX animates them.
        Renaming or reordering a shot starts it fresh. Edits autosave.
      </p>
    </section>
  );
}
