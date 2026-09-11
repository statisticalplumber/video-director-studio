import { useEffect, useState } from "react";
import { listOutputs, outputUrl, selectMain } from "../api";
import type { MainsInfo, VersionsInfo, AssetKind, OutputsInfo } from "../types";
import ReferencePanel from "./ReferencePanel";
import { VersionRow } from "./VersionRow";
import { IconFilm, IconImage, IconScissors } from "./Icons";

interface Props {
  scenario: string;
  refreshKey: number; // bump to re-list files
  hasRefPrompt: boolean;
  generatingScenario?: string | null; // output dir of the scenario currently being generated
  regenTarget?: { kind: AssetKind; index?: number } | null; // exact asset a regen run is producing
  activeKey?: string | null; // live pipeline cell from the runner's [stage] events: ref | kf:N | clip:N | final
  onStitch?: () => void; // ask the run panel to re-stitch the final cut
  onRegen?: (kind: AssetKind, index: number | null) => void;
  onUploaded?: () => void; // a ref upload landed — ask the app to re-list outputs
}

const pretty = (f: string) =>
  f.replace(/_[a-z]+\d+_.*\.(mp4|png)$/, "").replace(/_/g, " ").trim();

// Gallery of outputs/<scenario>/: ref, keyframes, clips (with version
// pickers + regenerate), final cut.
export default function OutputGallery({ scenario, refreshKey, hasRefPrompt, generatingScenario, regenTarget, activeKey, onStitch, onRegen, onUploaded }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [versions, setVersions] = useState<VersionsInfo>({ ref: [], beats: {} });
  const [mains, setMains] = useState<MainsInfo>({ ref: null, beats: {} });
  const [error, setError] = useState("");
  const apply = (r: OutputsInfo) => { setFiles(r.files); setVersions(r.versions); setMains(r.mains); };

  // Guarded against stale responses: switching scenarios quickly must not let
  // the previous scenario's late listOutputs() overwrite the new one's data.
  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    setVersions({ ref: [], beats: {} });
    setMains({ ref: null, beats: {} });
    setError("");
    if (scenario) {
      listOutputs(scenario).then((r) => { if (!cancelled) apply(r); })
        .catch((e) => { if (!cancelled) setError(String(e.message || e)); });
    }
    return () => { cancelled = true; };
  }, [scenario, refreshKey]);

  const final = files.find((f) => f.endsWith("_final.mp4"));
  const beatNums = Object.keys(versions.beats).map(Number).sort((a, b) => a - b);
  // Fallback for legacy dirs where versioning can't resolve (e.g. beat titles renamed since).
  const fallbackShots = beatNums.length === 0
    ? files
        .filter((f) => /_seq\d+_.*\.png$/.test(f))
        .sort()
        .map((kf) => ({
          kf,
          clip: files.find((c) => /_clip\d+_.*\.mp4$/.test(c) && c.replace(/\.mp4$/, ".png") === kf) || null,
        }))
    : [];
  const hasClips = beatNums.some((n) => (versions.beats[String(n)].clip?.length ?? 0) > 0) || fallbackShots.some((s) => s.clip);

  // True when the active run is generating into THIS output dir. The version
  // rows then show a blinking "rendering vN" chip on the asset in progress.
  const generating = !!generatingScenario && generatingScenario === scenario;
  const genTarget = (() => {
    if (!generating) return null;
    if (activeKey) return activeKey === "final" ? null : activeKey;
    if (regenTarget) {
      if (regenTarget.kind === "ref") return "ref";
      if (regenTarget.kind === "keyframe") return `kf:${regenTarget.index}`;
      if (regenTarget.kind === "clip") return `clip:${regenTarget.index}`;
    }
    if (!versions.ref.length) return "ref";
    for (const n of beatNums) if (!versions.beats[String(n)].keyframe.length) return `kf:${n}`;
    for (const n of beatNums) if (!versions.beats[String(n)].clip.length) return `clip:${n}`;
    return null; // everything exists — the run is re-stitching the final cut
  })();

  const pickMain = async (kind: AssetKind, index: number | null, file: string) => {
    try { apply(await selectMain(scenario, kind, index, file)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const mediaCount = beatNums.length + (versions.ref.length ? 1 : 0) + (final ? 1 : 0);

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconFilm size={15} /></span>
          Outputs
        </h2>
        <span className="spacer" />
        {hasClips && (
          <button onClick={() => onStitch?.()} disabled={generating} title="Concatenate the selected main clip versions into the final cut">
            <IconScissors size={12} />
            Stitch final
          </button>
        )}
        {scenario && <span className="mono-name">outputs/{scenario}/</span>}
      </div>

      {error && <p className="hint err-text">{error}</p>}

      {final && (
        <>
          <div className="section-label">
            Final cut
            {generating && genTarget === null && (
              <span className="gen-flag" title="Re-stitching the final cut from the selected main versions">
                <span className="dot pulse" /> stitching
              </span>
            )}
          </div>
          <div className="video-frame">
            <video controls src={`${outputUrl(scenario, final)}?v=${refreshKey}`} />
          </div>
        </>
      )}
      {scenario && (
        <ReferencePanel
          scenario={scenario}
          versions={versions.ref}
          main={mains.ref}
          hasPrompt={hasRefPrompt}
          generating={genTarget === "ref"}
          locked={generating}
          onChanged={(o) => { apply(o); onUploaded?.(); }}
          onSelect={(f) => pickMain("ref", null, f)}
          onRegen={() => onRegen?.("ref", null)}
        />
      )}
      {(beatNums.length > 0 || fallbackShots.length > 0) && (
        <>
          <div className="section-label">Keyframes → clips</div>
          <div className="grid">
            {beatNums.map((n) => {
              const bv = versions.beats[String(n)];
              const kfMain = mains.beats[String(n)]?.keyframe || bv.keyframe[bv.keyframe.length - 1]?.file || null;
              const clipMain = mains.beats[String(n)]?.clip || bv.clip[bv.clip.length - 1]?.file || null;
              return (
                <div className="shot" key={n}>
                  <div className="img-frame">
                    {kfMain
                      ? <img src={outputUrl(scenario, kfMain)} alt={pretty(kfMain)} loading="lazy" />
                      : <div className="frame-missing">no keyframe</div>}
                  </div>
                  <VersionRow versions={bv.keyframe} main={mains.beats[String(n)]?.keyframe} kind="image"
                    onSelect={(f) => pickMain("keyframe", n, f)} onRegen={() => onRegen?.("keyframe", n)}
                    generating={genTarget === `kf:${n}`} disabled={generating} />
                  <div className="video-frame">
                    {clipMain
                      ? <video controls src={outputUrl(scenario, clipMain)} />
                      : <div className="frame-missing">no clip</div>}
                  </div>
                  <VersionRow versions={bv.clip} main={mains.beats[String(n)]?.clip} kind="video"
                    onSelect={(f) => pickMain("clip", n, f)} onRegen={() => onRegen?.("clip", n)}
                    generating={genTarget === `clip:${n}`} disabled={generating} />
                </div>
              );
            })}
            {fallbackShots.map(({ kf, clip }) => (
              <div className="shot" key={kf}>
                <div className="img-frame">
                  <img src={outputUrl(scenario, kf)} alt={pretty(kf)} loading="lazy" />
                </div>
                {clip && (
                  <div className="video-frame">
                    <video controls src={outputUrl(scenario, clip)} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="hint">
            Pick a version to make it <b>main</b> — the final cut stitches the main version of every beat.
            Regenerate keeps old versions.
          </p>
        </>
      )}
      {mediaCount === 0 && !generating && (
        <div className="empty">
          <span className="empty-icon"><IconImage size={20} /></span>
          <span className="empty-title">No outputs yet</span>
          <span className="empty-sub">
            {scenario
              ? "Render to see the reference, keyframes, and final cut land here."
              : "Select a scenario to view its outputs."}
          </span>
        </div>
      )}
    </section>
  );
}
