import { useEffect, useRef, useState } from "react";
import { startRun, killRun, tailRun, listRuns, type AssetEvent, type Engine, type RegenSpec } from "../api";
import type { StageEvent } from "../types";
import { clock } from "./LiveMonitor";
import { IconChevronDown, IconChevronRight, IconPlay, IconScissors, IconStop, IconTerminal, Spinner } from "./Icons";

export type RunStatus = "idle" | "running" | "done" | "error";
export type RunMode = "sequence" | "director";

/** Pipeline cell key for a stage/asset: ref | vo | kf:N | clip:N | final. */
export const stageKey = (s: { stage: string; index?: number }) =>
  s.stage === "reference" ? "ref"
    : s.stage === "narration" ? "vo"
      : s.stage === "music" ? "music"
        : s.stage === "final" ? "final"
          : `${s.stage === "keyframe" ? "kf" : "clip"}:${s.index}`;

interface Props {
  scenario: string;
  mode: RunMode;
  engine: Engine;
  onEngine: (e: Engine) => void;
  beats: number;                          // shots/beats in the scenario (pipeline cells)
  hasRef?: boolean;                       // director: a reference is set / generated
  hasMusic?: boolean;                     // director: a music cue is set
  onDone: () => void;
  onAsset?: (a: AssetEvent) => void;      // an asset landed — refresh galleries live
  onStatus?: (s: RunStatus, scenario: string) => void;
  onStage?: (key: string | null) => void; // pipeline cell currently rendering
  // External run trigger (Stitch final / Regenerate from the output gallery).
  pendingRun: { nonce: number; stitch?: boolean; regen?: RegenSpec | null } | null;
}

// Render transport: start / stitch / stop, pipeline tracker, console (SSE log tail).
export default function RunPanel({ scenario, mode, engine, onEngine, beats, hasRef, hasMusic, onDone, onAsset, onStatus, onStage, pendingRun }: Props) {
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  // Scenario this panel's run is generating (captured at start, so it stays
  // correct even if the user switches scenarios mid-run).
  const [runScenario, setRunScenario] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [assets, setAssets] = useState<AssetEvent[]>([]);
  const [stage, setStage] = useState<StageEvent | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [consoleOpen, setConsoleOpen] = useState(() => localStorage.getItem("ss-console") === "open");
  const closeTail = useRef<() => void>(() => {});
  const boxRef = useRef<HTMLPreElement>(null);
  const cbs = useRef({ onDone, onAsset });
  cbs.current = { onDone, onAsset };

  useEffect(() => { onStatus?.(status, runScenario ?? scenario); }, [status, onStatus, runScenario, scenario]);
  useEffect(() => { onStage?.(status === "running" && stage ? stageKey(stage) : null); }, [stage, status, onStage]);
  useEffect(() => () => closeTail.current(), []);
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [log, consoleOpen]);
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  const notify = (sc: string, s: string) => {
    if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
    new Notification(s === "done" ? `✓ ${sc} rendered` : `✕ ${sc} failed`, { body: "Sequence Studio" });
  };

  const attach = (id: string, sc: string, t0: number) => {
    setRunId(id);
    setRunScenario(sc);
    setStatus("running");
    setStartedAt(t0);
    setLog("");
    setAssets([]);
    setStage(null);
    closeTail.current();
    closeTail.current = tailRun(
      id,
      (line) => setLog((l) => l + line),
      (s) => {
        setStatus(s === "done" ? "done" : "error");
        setStage(null);
        cbs.current.onDone();
        notify(sc, s);
      },
      (a) => {
        setAssets((prev) => prev.some((x) => x.file === a.file && x.stage === a.stage) ? prev : [...prev, a]);
        cbs.current.onAsset?.(a);
      },
      (st) => setStage(st),
    );
  };

  // Re-attach to a run that is still going (page reload / second tab).
  useEffect(() => {
    listRuns().then((rs) => {
      const r = rs.find((x) => x.status === "running");
      if (r) attach(r.id, r.scenario, r.startedAt);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const begin = async (stitch: boolean, regen: RegenSpec | null = null) => {
    if (!scenario || status === "running") return;
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    try {
      const { id } = await startRun(scenario, { stitch, regen, engine: mode === "director" ? "director" : engine });
      attach(id, scenario, Date.now());
    } catch (e) {
      setStatus("error");
      setLog(`run failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
      setConsoleOpen(true);
    }
  };
  const beginRef = useRef(begin);
  beginRef.current = begin;

  // Runs triggered from the output gallery (stitch / regenerate).
  useEffect(() => {
    if (pendingRun) begin(!!pendingRun.stitch, pendingRun.regen || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun?.nonce]);

  // Ctrl/Cmd+Enter = Render (works from anywhere, including text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); beginRef.current(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleConsole = () =>
    setConsoleOpen((o) => { localStorage.setItem("ss-console", o ? "closed" : "open"); return !o; });

  const running = status === "running";
  const elsewhere = running && runScenario && runScenario !== scenario;
  const activeKey = running && stage ? stageKey(stage) : null;
  const done = new Set(assets.map(stageKey));
  const lines = log ? log.split("\n").length : 0;

  const statusPill = {
    idle: <span className="pill">ready</span>,
    running: (
      <span className="pill running">
        <Spinner size={11} />
        rendering{elsewhere ? ` · ${runScenario}` : ""} · {clock((now - startedAt) / 1000)}
      </span>
    ),
    done: <span className="pill done">done</span>,
    error: <span className="pill error">error</span>,
  }[status];

  const cell = (key: string, label: string, title: string) => (
    <span
      key={key}
      className={`pipe-cell ${done.has(key) ? "done" : activeKey === key ? "active" : ""}`}
      title={`${title} — ${done.has(key) ? "ready" : activeKey === key ? "rendering now" : "pending"}`}
    >
      {label}
    </span>
  );
  const nums = Array.from({ length: beats }, (_, i) => i + 1);

  return (
    <section className="card render">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconTerminal size={15} /></span>
          Render
        </h2>
        <span className="spacer" />
        {mode === "sequence" ? (
          <span className="seg" title="Video engine for the clips">
            <button className={engine === "ltx" ? "on" : ""} onClick={() => onEngine("ltx")} disabled={running}>LTX 2.5</button>
            <button className={engine === "wan" ? "on" : ""} onClick={() => onEngine("wan")} disabled={running}>Wan 2.1</button>
          </span>
        ) : (
          <span className="pill">Flux 2 → LTX 2.5 · VO</span>
        )}
        {statusPill}
      </div>

      <div className="transport">
        <button className="primary" onClick={() => begin(false)} disabled={running || !scenario} title="Render everything that is missing, then cut (Ctrl+Enter)">
          <IconPlay size={12} />
          Render
          <kbd>Ctrl ↵</kbd>
        </button>
        <button onClick={() => begin(true)} disabled={running || !scenario}>
          <IconScissors size={12} />
          Cut only
        </button>
        <button className="danger" disabled={!running || !runId} onClick={() => runId && killRun(runId)}>
          <IconStop size={12} />
          Stop
        </button>
        <span className="spacer" />
        {running && stage?.label && <span className="now-rendering">▸ {stage.label}</span>}
      </div>
      {!scenario && <p className="hint">Select or save a {mode === "director" ? "trailer" : "scenario"} first.</p>}

      {beats > 0 && (
        <div className="pipeline">
          <div className="pipe-group">
            <span className="pipe-label">{mode === "director" ? "Audio · ref" : "Ref"}</span>
            <div className="pipe-cells">
              {mode === "director" ? (
                <>
                  {cell("vo", "VO", "Voiceover")}
                  {hasMusic && cell("music", "♪", "Music bed")}
                  {hasRef && cell("ref", "REF", "Reference key visual")}
                </>
              ) : cell("ref", "REF", "Reference image")}
            </div>
          </div>
          <div className="pipe-group grow">
            <span className="pipe-label">Keyframes · image</span>
            <div className="pipe-cells">{nums.map((n) => cell(`kf:${n}`, String(n), `Keyframe ${n}`))}</div>
          </div>
          <div className="pipe-group grow">
            <span className="pipe-label">Clips · video</span>
            <div className="pipe-cells">{nums.map((n) => cell(`clip:${n}`, String(n), `Clip ${n}`))}</div>
          </div>
          <div className="pipe-group">
            <span className="pipe-label">Final</span>
            <div className="pipe-cells">{cell("final", "CUT", "Final cut")}</div>
          </div>
        </div>
      )}

      <button className="console-toggle" onClick={toggleConsole}>
        {consoleOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        Console
        <span className="muted">{lines ? `${lines} lines` : "empty"}</span>
      </button>
      {consoleOpen && (
        <pre ref={boxRef} className="log">
          {log || <span className="log-empty">— the runner log streams here once a render starts —</span>}
        </pre>
      )}
    </section>
  );
}
