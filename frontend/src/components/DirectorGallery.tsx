// Director dailies: final cut, voiceover + music, the reference key visual,
// and every shot's keyframe + clip with versioned takes (pick main, re-roll).
import { useEffect, useState } from "react";
import { listOutputs, outputUrl, selectMain } from "../api";
import type { AssetKind, DirectorShot, MainsInfo, OutputsInfo, VersionsInfo } from "../types";
import ReferencePanel from "./ReferencePanel";
import { VersionRow } from "./VersionRow";
import { IconFilm, IconImage, IconMic, IconMusic, IconRefresh, IconScissors } from "./Icons";

interface Props {
  scenario: string;
  shots: DirectorShot[];
  vertical: boolean;
  hasRefPrompt: boolean;
  hasMusic: boolean;
  refreshKey: number;
  generating: boolean;         // a run is producing into this scenario
  activeKey: string | null;    // ref | vo | music | kf:N | clip:N | final
  onRegen: (kind: "ref" | "narration" | "music" | "keyframe" | "clip", index: number | null) => void;
  onStitch: () => void;
  onChanged: () => void;
}

export default function DirectorGallery({ scenario, shots, vertical, hasRefPrompt, hasMusic, refreshKey, generating, activeKey, onRegen, onStitch, onChanged }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [versions, setVersions] = useState<VersionsInfo>({ ref: [], beats: {} });
  const [mains, setMains] = useState<MainsInfo>({ ref: null, beats: {} });
  const [error, setError] = useState("");
  const apply = (r: OutputsInfo) => { setFiles(r.files); setVersions(r.versions); setMains(r.mains); };

  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    setVersions({ ref: [], beats: {} });
    setMains({ ref: null, beats: {} });
    if (scenario) listOutputs(scenario).then((r) => { if (!cancelled) apply(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [scenario, refreshKey]);

  // Cache-bust single-file assets (narration / music / final keep their names).
  const url = (f: string) => `${outputUrl(scenario, f)}?v=${refreshKey}`;
  const has = (f: string) => files.includes(f);
  const final = `${scenario}_final.mp4`;
  const busy = (key: string) => generating && activeKey === key;
  const pickMain = async (kind: AssetKind, index: number | null, file: string) => {
    try { apply(await selectMain(scenario, kind, index, file)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const clipMain = (n: number) => {
    const bv = versions.beats[String(n)];
    return mains.beats[String(n)]?.clip || bv?.clip[bv.clip.length - 1]?.file || null;
  };
  const kfMain = (n: number) => {
    const bv = versions.beats[String(n)];
    return mains.beats[String(n)]?.keyframe || bv?.keyframe[bv.keyframe.length - 1]?.file || null;
  };
  const allClips = shots.length > 0 && shots.every((_, i) => !!clipMain(i + 1));
  const done = shots.filter((_, i) => !!clipMain(i + 1)).length;

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconFilm size={15} /></span>
          Dailies
        </h2>
        {shots.length > 0 && <span className="pill">{done}/{shots.length} shots</span>}
        <span className="spacer" />
        {allClips && has("narration.wav") && (
          <button onClick={onStitch} disabled={generating} title="Re-mix the voiceover / music and re-cut the final from the main takes">
            <IconScissors size={12} /> Re-cut final
          </button>
        )}
        <span className="mono-name">outputs/{scenario}/</span>
      </div>
      {error && <p className="hint err-text">{error}</p>}

      <div className="section-label">
        Final cut
        {busy("final") && <span className="gen-flag"><span className="dot pulse" /> mixing</span>}
      </div>
      <div className={`video-frame ${vertical ? "tall solo" : ""}`}>
        {has(final)
          ? <video controls src={url(final)} />
          : <div className="frame-missing">no final cut yet</div>}
      </div>

      <div className="audio-grid">
        <div>
          <div className="section-label">
            <IconMic size={11} /> Voiceover
            {busy("vo") && <span className="gen-flag"><span className="dot pulse" /> recording</span>}
          </div>
          <div className="vo-row">
            {has("narration.wav")
              ? <audio controls src={url("narration.wav")} />
              : <span className="frame-missing inline">no voiceover yet</span>}
            {has("narration.wav") && (
              <button className="vchip regen" disabled={generating} onClick={() => onRegen("narration", null)} title="Re-record the voiceover (previous take kept as prev_)">
                <IconRefresh size={10} /> re-take
              </button>
            )}
          </div>
        </div>
        {hasMusic && (
          <div>
            <div className="section-label">
              <IconMusic size={11} /> Score
              {busy("music") && <span className="gen-flag"><span className="dot pulse" /> composing</span>}
            </div>
            <div className="vo-row">
              {has("music.wav")
                ? <audio controls src={url("music.wav")} />
                : <span className="frame-missing inline">no music yet</span>}
              {has("music.wav") && (
                <button className="vchip regen" disabled={generating} onClick={() => onRegen("music", null)} title="Re-compose the score (previous take kept as prev_)">
                  <IconRefresh size={10} /> re-take
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <ReferencePanel
        scenario={scenario}
        versions={versions.ref}
        main={mains.ref}
        hasPrompt={hasRefPrompt}
        generating={busy("ref")}
        locked={generating}
        portrait={vertical}
        onChanged={(o) => { apply(o); onChanged(); }}
        onSelect={(f) => pickMain("ref", null, f)}
        onRegen={() => onRegen("ref", null)}
      />

      <div className="section-label">Shots</div>
      <div className={`dir-grid ${vertical ? "vertical" : ""}`}>
        {shots.map((s, i) => {
          const n = i + 1;
          const bv = versions.beats[String(n)] ?? { keyframe: [], clip: [] };
          const kf = kfMain(n);
          const clip = clipMain(n);
          const active = busy(`kf:${n}`) || busy(`clip:${n}`);
          return (
            <div className={`dshot ${active ? "active" : ""}`} key={`${n}-${s.title}`}>
              <div className="dshot-head">
                <span className="shot-no">{String(n).padStart(2, "0")}</span>
                <span className="dshot-title" title={s.title}>{s.title}</span>
                {s.useRef === false && <span className="tag" title="Not conditioned on the reference">no ref</span>}
                <span className="muted">{s.duration ?? 4}s</span>
              </div>
              <div className={`img-frame ${vertical ? "tall" : "wide"}`}>
                {clip
                  ? <video controls muted loop playsInline poster={kf ? outputUrl(scenario, kf) : undefined} src={outputUrl(scenario, clip)} />
                  : kf
                    ? <img src={outputUrl(scenario, kf)} alt={s.title} loading="lazy" />
                    : <div className="frame-missing">
                        {busy(`kf:${n}`) ? <span className="gen-flag"><span className="dot pulse" /> keyframe…</span> : <IconImage size={16} />}
                      </div>}
                {busy(`clip:${n}`) && <span className="frame-tag live">ANIMATING</span>}
                {busy(`kf:${n}`) && kf && <span className="frame-tag live">RE-ROLLING</span>}
              </div>
              <div className="take-rows">
                <span className="take-k">frame</span>
                <VersionRow versions={bv.keyframe} main={mains.beats[String(n)]?.keyframe} kind="image"
                  onSelect={(f) => pickMain("keyframe", n, f)} onRegen={() => onRegen("keyframe", n)}
                  generating={busy(`kf:${n}`)} disabled={generating} regenLabel="re-roll" />
                <span className="take-k">motion</span>
                <VersionRow versions={bv.clip} main={mains.beats[String(n)]?.clip} kind="video"
                  onSelect={(f) => pickMain("clip", n, f)} onRegen={() => onRegen("clip", n)}
                  generating={busy(`clip:${n}`)} disabled={generating} regenLabel="re-animate" />
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint">
        Pick a take to make it <b>main</b>; re-roll a frame, then re-animate its motion from the new frame.
        The final is re-mixed from the main takes automatically. Nothing is deleted.
      </p>
    </section>
  );
}
