// Program monitor: what ComfyUI is rendering right now — latent preview
// frames, sampler pass/step progress, speed and ETA — for both image (Flux)
// and video (LTX / Wan) jobs. Fed by the server's /api/live relay.
import { useEffect, useState } from "react";
import type { LivePreview, LiveState } from "../types";
import { IconFilm, IconImage, IconMonitor } from "./Icons";

export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Overall job progress 0..1 across sampler passes (LTX runs 2 passes: gen + upscale). */
export const jobProgress = (job: LiveState["job"]) => {
  if (!job) return 0;
  const step = job.max ? job.value / job.max : 0;
  return Math.min(1, (Math.max(job.pass, 1) - 1 + step) / Math.max(job.passes, 1));
};

interface Props {
  live: LiveState | null;
  preview: LivePreview | null;
  idleTitle: string;
  compact?: boolean;
}

export default function LiveMonitor({ live, preview, idleTitle, compact }: Props) {
  const [now, setNow] = useState(Date.now());
  const job = live?.job ?? null;
  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [job]);

  const skew = live?.skew ?? 0;
  const last = live?.last ?? null;
  const elapsed = job ? (now - skew - job.startedAt) / 1000 : 0;
  const stepPct = job && job.max ? job.value / job.max : 0;
  const eta = job?.secPerStep != null && job.max ? (job.max - job.value) * job.secPerStep : null;
  // Only show a frame from the job that is running; when idle keep the last one.
  const frame = preview && (!job || preview.promptId === job.promptId) ? preview.src : null;
  const passes = Math.max(job?.passes ?? 1, 1);

  return (
    <section className={`monitor ${job ? "is-live" : ""} ${compact ? "compact" : ""}`}>
      <div className="monitor-head">
        <span className="monitor-title"><IconMonitor size={13} /> Program</span>
        {job
          ? <span className="rec"><span className="rec-dot" />LIVE</span>
          : <span className="standby">{live?.connected === false ? "NO SIGNAL" : "STANDBY"}</span>}
        {job && (
          <span className={`kind-tag ${job.kind}`}>
            {job.kind === "video" ? <IconFilm size={11} /> : <IconImage size={11} />}
            {job.kind} · {job.model}
          </span>
        )}
        <span className="spacer" />
        <span className="tc" title="Elapsed">{clock(elapsed)}</span>
      </div>

      <div className="monitor-screen">
        {frame
          ? <img className={`monitor-img ${job ? "" : "stale"}`} src={frame} alt="live preview" />
          : (
            <div className="monitor-slate">
              <span className="slate-title">{job ? "Rendering…" : idleTitle}</span>
              <span className="slate-sub">
                {job
                  ? "Waiting for the first preview frame (enable ComfyUI --preview-method auto for latent previews)"
                  : live?.connected === false
                    ? "Live telemetry offline — can’t reach the ComfyUI websocket"
                    : "Queue a render and the frames stream here live"}
              </span>
            </div>
          )}
        <span className="mark tl" /><span className="mark tr" /><span className="mark bl" /><span className="mark br" />
        {frame && !job && <span className="frame-tag">LAST FRAME</span>}
        {job && (
          <div className="lower-third">
            <span className="lt-label">{job.label || "External job"}</span>
            {job.nodeClass && <span className="lt-node">{job.nodeClass}</span>}
          </div>
        )}
      </div>

      <div className="monitor-meter">
        <div className="pass-bar" aria-label="Sampler progress">
          {Array.from({ length: passes }, (_, i) => {
            const fill = !job ? 0 : i < job.pass - 1 ? 1 : i === job.pass - 1 ? stepPct : 0;
            return (
              <span className="pass-seg" key={i}>
                <span className={`pass-fill ${job?.kind ?? ""}`} style={{ width: `${fill * 100}%` }} />
              </span>
            );
          })}
        </div>
        <div className="meter-stats">
          {job ? (
            <>
              <Stat k="Pass" v={`${Math.max(job.pass, 1)}/${passes}`} />
              <Stat k="Step" v={job.max ? `${job.value}/${job.max}` : "—"} />
              <Stat k="Speed" v={job.secPerStep != null ? `${job.secPerStep.toFixed(1)} s/it` : "—"} />
              <Stat k="Pass ETA" v={eta != null ? clock(eta) : "—"} />
              <Stat k="Total" v={`${Math.round(jobProgress(job) * 100)}%`} strong />
            </>
          ) : last ? (
            <span className={`last-job ${last.status}`}>
              Last: {last.label || last.model} · {last.status} in {clock((last.endedAt - last.startedAt) / 1000)}
              {last.error ? ` — ${last.error}` : ""}
            </span>
          ) : (
            <span className="last-job">No jobs yet this session</span>
          )}
          <span className="spacer" />
          <Stat k="Queue" v={String(live?.queueRemaining ?? 0)} />
        </div>
      </div>
    </section>
  );
}

function Stat({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <span className={`stat ${strong ? "strong" : ""}`}>
      <span className="stat-k">{k}</span>
      <span className="stat-v">{v}</span>
    </span>
  );
}
