import { useCallback, useEffect, useState } from "react";
import {
  listScenarios, getScenario, saveScenario, deleteScenario, setFavorite, comfyStatus, outScenario, listOutputs,
  me, logout, fmtDate, subscribeLive, type Engine, type AuthUser, type RegenSpec,
} from "./api";
import type {
  AnyScenario, Scenario, DirectorScenario, ScenarioInfo, ScenarioKind, ComfyStatus, AssetKind,
  LiveState, LivePreview,
} from "./types";
import ScenarioEditor from "./components/ScenarioEditor";
import DirectorEditor from "./components/DirectorEditor";
import RunPanel from "./components/RunPanel";
import Img2Img from "./components/Img2Img";
import OutputGallery from "./components/OutputGallery";
import DirectorGallery from "./components/DirectorGallery";
import CraftPanel from "./components/CraftPanel";
import LiveMonitor, { jobProgress } from "./components/LiveMonitor";
import Login from "./components/Login";
import {
  IconChevronLeft, IconChevronRight, IconClapper, IconCpu, IconFolder, IconImage, IconLayers,
  IconLogOut, IconMoon, IconSparkles, IconStar, IconSun, IconTrash, Spinner,
} from "./components/Icons";

export type Theme = "dark" | "light";
type Mode = ScenarioKind | "img2img";

export default function App() {
  const [auth, setAuth] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("ss-theme") === "light" ? "light" : "dark"
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ss-theme", theme);
  }, [theme]);

  useEffect(() => {
    me()
      .then((r) => setAuth(r))
      .catch(() => setAuth(null))
      .finally(() => setChecking(false));
  }, []);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const handleLogout = () => {
    logout().catch(() => {});
    setAuth(null);
  };

  if (checking) {
    return (
      <div className="login-screen">
        <div className="login-bg" aria-hidden="true" />
        <div className="login-checking"><Spinner size={18} /></div>
      </div>
    );
  }

  if (!auth) return <Login onAuthed={setAuth} />;

  return <Studio user={auth.user} onLogout={handleLogout} theme={theme} onToggleTheme={toggleTheme} />;
}

const MODES: { id: Mode; label: string; icon: JSX.Element }[] = [
  { id: "sequence", label: "Sequence", icon: <IconLayers size={13} /> },
  { id: "director", label: "Director", icon: <IconClapper size={13} /> },
  { id: "img2img", label: "Img2Img", icon: <IconImage size={13} /> },
];

function Studio({ user, onLogout, theme, onToggleTheme }: {
  user: string;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [mode, setMode] = useState<Mode>(() => {
    const m = localStorage.getItem("ss-mode");
    return m === "director" || m === "img2img" ? m : "sequence";
  });
  useEffect(() => { localStorage.setItem("ss-mode", mode); }, [mode]);
  const kind: ScenarioKind = mode === "director" ? "director" : "sequence";

  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  // Selected scenario per mode (switching Sequence <-> Director keeps both).
  const [names, setNames] = useState<Record<ScenarioKind, string>>({ sequence: "", director: "" });
  const name = names[kind];
  const setName = (n: string) => setNames((prev) => ({ ...prev, [kind]: n }));
  const [cfg, setCfg] = useState<AnyScenario | null>(null);
  const [cfgName, setCfgName] = useState<string | null>(null);
  const [draftAny, setDraft] = useState<{ name: string; config: AnyScenario; kind: ScenarioKind } | null>(null);
  const draft = draftAny && draftAny.kind === kind ? draftAny : null;
  const [engine, setEngine] = useState<Engine>("ltx");
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [runActive, setRunActive] = useState(false);
  const [runScenario, setRunScenario] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [regenTarget, setRegenTarget] = useState<{ kind: AssetKind; index?: number } | null>(null);
  const [pendingRun, setPendingRun] = useState<{ nonce: number; stitch?: boolean; regen?: RegenSpec | null } | null>(null);
  const [inspector, setInspector] = useState<"script" | "craft">("script");
  const [live, setLive] = useState<LiveState | null>(null);
  // Director: whether a reference image exists on disk (drives the REF pipeline cell).
  const [hasRefImage, setHasRefImage] = useState(false);
  useEffect(() => {
    if (kind !== "director" || !name) { setHasRefImage(false); return; }
    let cancelled = false;
    listOutputs(name).then((r) => { if (!cancelled) setHasRefImage(r.versions.ref.length > 0); }).catch(() => {});
    return () => { cancelled = true; };
  }, [kind, name, refreshKey]);
  const [preview, setPreview] = useState<LivePreview | null>(null);
  const [binOpen, setBinOpen] = useState<boolean>(() => localStorage.getItem("ss-sidebar") !== "closed");
  const toggleBin = () =>
    setBinOpen((o) => {
      localStorage.setItem("ss-sidebar", o ? "closed" : "open");
      return !o;
    });

  // Bare "b" toggles the project bin (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "b" && e.key !== "B") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      toggleBin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live ComfyUI telemetry (job progress + preview frames).
  useEffect(() => subscribeLive((s) => setLive({ ...s, skew: Date.now() - s.now }), setPreview), []);

  // Tab title mirrors the render state, so a background tab shows progress.
  useEffect(() => {
    const j = live?.job;
    document.title = j
      ? `● ${Math.round(jobProgress(j) * 100)}% ${j.kind} · Sequence Studio`
      : "Sequence Studio";
  }, [live]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const refreshScenarios = useCallback(async () => {
    setScenarios(await listScenarios());
  }, []);
  useEffect(() => { refreshScenarios().catch(() => {}); }, [refreshScenarios]);

  const handleDelete = async (s: string) => {
    if (!window.confirm(`Delete "${s}"?\nIts generated outputs will be removed too.`)) return;
    try {
      await deleteScenario(s);
      if (draft && draft.name === s) setDraft(null);
      if (name === s) setName("");
      await refreshScenarios();
      refresh();
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleFavorite = async (s: ScenarioInfo) => {
    const on = !s.favorite;
    // Optimistic toggle; the server re-sorts (favorites pinned on top).
    setScenarios((prev) =>
      prev
        .map((x) => (x.name === s.name ? { ...x, favorite: on } : x))
        .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.mtimeMs - a.mtimeMs)
    );
    try {
      await setFavorite(s.name, on);
    } catch (e) {
      window.alert(`Favorite update failed: ${e instanceof Error ? e.message : String(e)}`);
      refreshScenarios();
    }
  };

  // Fetch the selected scenario's config. Guarded against stale responses:
  // switching A -> B quickly must not let A's late fetch overwrite B's config.
  useEffect(() => {
    if (!name) { setCfg(null); setCfgName(null); return; }
    let cancelled = false;
    setCfg(null);
    setCfgName(null);
    getScenario(name)
      .then((r) => { if (!cancelled) { setCfg(r.config); setCfgName(name); } })
      .catch(() => { if (!cancelled) setCfg(null); });
    return () => { cancelled = true; };
  }, [name]);

  useEffect(() => {
    const poll = () => comfyStatus().then(setComfy).catch(() => setComfy({ up: false, error: "server unreachable" }));
    poll();
    const t = setInterval(poll, 10000);
    return () => clearInterval(t);
  }, []);

  const handleSave = async (c: AnyScenario) => {
    const target = draft ? draft.name : name;
    await saveScenario(target, c);
    if (draft) {
      await refreshScenarios();
      setName(target);
      setDraft(null);
    }
  };

  // Only show the editor once the fetched config matches the selected name.
  const editor = draft
    ? { name: draft.name, config: draft.config }
    : cfg && cfgName === name ? { name, config: cfg } : null;

  const list = scenarios.filter((s) => s.kind === kind);
  const outDir = mode === "director" ? name : name ? outScenario(name, engine) : "";
  const comfyQueue = (comfy?.queue?.queue_running?.length ?? 0) + (comfy?.queue?.queue_pending?.length ?? 0);
  const job = live?.job;

  const onRunStatus = useCallback((s: string, sc: string) => {
    setRunActive(s === "running");
    setRunScenario(s === "running" ? sc : null);
  }, []);
  useEffect(() => {
    const r = pendingRun?.regen;
    const visual = r && (r.kind === "ref" || r.kind === "keyframe" || r.kind === "clip");
    setRegenTarget(runActive && visual ? { kind: r.kind as AssetKind, index: r.index } : null);
  }, [runActive, pendingRun]);
  const dcfg = kind === "director" && editor ? (editor.config as DirectorScenario) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><IconClapper size={16} /></span>
          <span className="brand-name">Sequence Studio</span>
        </div>
        <nav className="modes" aria-label="Workspace">
          {MODES.map((m) => (
            <button key={m.id} className={mode === m.id ? "on" : ""} onClick={() => setMode(m.id)}>
              {m.icon}
              {m.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {job && (
            <span className={`live-chip ${job.kind}`} title={job.label ?? ""}>
              <span className="rec-dot" />
              {job.kind === "video" ? "Video" : "Image"} · {Math.round(jobProgress(job) * 100)}%
            </span>
          )}
          <GpuMeter comfy={comfy} />
          <span className={`pill ${comfy?.up ? "ok" : "err"}`} title={comfy?.error ?? (comfy?.live ? "live telemetry connected" : "live telemetry offline")}>
            <span className={`dot ${comfy?.up ? "pulse" : ""}`} />
            {comfy?.up ? `ComfyUI${comfyQueue > 0 ? ` · ${comfyQueue} in queue` : ""}` : "ComfyUI offline"}
          </span>
          <button
            className="icon-btn theme-toggle"
            onClick={onToggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />}
          </button>
          <div className="user-chip" title={`Signed in as ${user}`}>
            <span className="user-avatar">{user.slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{user}</span>
            <button className="icon-btn" onClick={onLogout} title="Sign out" aria-label="Sign out">
              <IconLogOut size={14} />
            </button>
          </div>
        </div>
      </header>

      {mode === "img2img" ? (
        <div className="img2img-layout">
          <Img2Img />
          <div className="col">
            <LiveMonitor live={live} preview={preview} idleTitle="Img2Img" />
          </div>
        </div>
      ) : (
        <div className={`workspace ${binOpen ? "" : "no-bin"}`}>
          {!binOpen && (
            <button className="bin-reopen" onClick={toggleBin} title="Show project bin (b)" aria-label="Show project bin">
              <IconChevronRight size={14} />
            </button>
          )}
          <aside className={`bin ${binOpen ? "" : "is-collapsed"}`}>
            <div className="bin-head">
              <span>{kind === "director" ? "Trailers" : "Sequences"}</span>
              <span className="bin-count">{list.length}</span>
              <button className="icon-btn bin-collapse" onClick={toggleBin} title="Hide project bin (b)" aria-label="Hide project bin">
                <IconChevronLeft size={13} />
              </button>
            </div>
            <button className="bin-new" onClick={() => setInspector("craft")}>
              <IconSparkles size={13} />
              {kind === "director" ? "New trailer" : "New sequence"}
            </button>
            <div className="bin-list">
              {draft && (
                <div className="scenario-row">
                  <button className="scenario-item on" onClick={() => setInspector("script")}>
                    <span className="scenario-name">{draft.name}</span>
                    <span className="scenario-date draft">draft</span>
                  </button>
                </div>
              )}
              {list.length === 0 && !draft && (
                <div className="bin-empty">Nothing here yet — use “New” to have the LLM write one.</div>
              )}
              {list.map((s) => (
                <div className="scenario-row" key={s.name}>
                  <button
                    className={`scenario-item ${!draft && name === s.name ? "on" : ""}`}
                    onClick={() => { setDraft(null); setName(s.name); setInspector("script"); }}
                  >
                    <span className="scenario-name">
                      {runActive && runScenario && (runScenario === s.name || runScenario === `${s.name}_wan`) && <span className="rec-dot sm" />}
                      {s.name}
                    </span>
                    <span className="scenario-date">{fmtDate(s.mtimeMs)}</span>
                  </button>
                  <button
                    className={`icon-btn scenario-fav ${s.favorite ? "on" : ""}`}
                    title={s.favorite ? `Unfavorite ${s.name}` : `Favorite ${s.name}`}
                    aria-label={s.favorite ? `Unfavorite ${s.name}` : `Favorite ${s.name}`}
                    onClick={() => handleFavorite(s)}
                  >
                    <IconStar size={13} filled={!!s.favorite} />
                  </button>
                  <button
                    className="icon-btn scenario-del"
                    title={`Delete ${s.name}`}
                    aria-label={`Delete ${s.name}`}
                    onClick={() => handleDelete(s.name)}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              ))}
            </div>
          </aside>

          <main className="stage-col">
            <LiveMonitor live={live} preview={preview} idleTitle={editor?.name || (kind === "director" ? "Director" : "Sequence")} />
            <RunPanel
              scenario={draft ? "" : name}
              mode={kind}
              engine={engine}
              onEngine={setEngine}
              beats={editor?.config.sequence.length ?? 0}
              hasRef={!!dcfg && (!!dcfg.referencePrompt || hasRefImage)}
              hasMusic={!!dcfg?.musicPrompt?.trim()}
              onDone={refresh}
              onAsset={refresh}
              onStatus={onRunStatus}
              onStage={setActiveKey}
              pendingRun={pendingRun}
            />
            {kind === "director" ? (
              name && !draft && dcfg ? (
                <DirectorGallery
                  scenario={name}
                  shots={dcfg.sequence}
                  vertical={!(dcfg.ratio ?? "9:16").startsWith("16:9")}
                  hasRefPrompt={!!dcfg.referencePrompt?.trim()}
                  hasMusic={!!dcfg.musicPrompt?.trim()}
                  refreshKey={refreshKey}
                  generating={runActive && runScenario === name}
                  activeKey={activeKey}
                  onStitch={() => !runActive && setPendingRun({ nonce: Date.now(), stitch: true })}
                  onRegen={(k, index) => !runActive && setPendingRun({ nonce: Date.now(), regen: { kind: k, index: index ?? undefined } })}
                  onChanged={refresh}
                />
              ) : null
            ) : (
              <OutputGallery
                scenario={draft ? outScenario(draft.name, engine) : outDir}
                refreshKey={refreshKey}
                hasRefPrompt={!!(editor?.config as Scenario | undefined)?.referencePrompt}
                generatingScenario={runActive ? runScenario : null}
                regenTarget={runActive ? regenTarget : null}
                activeKey={runActive ? activeKey : null}
                onStitch={() => !runActive && setPendingRun({ nonce: Date.now(), stitch: true })}
                onRegen={(k: AssetKind, index: number | null) =>
                  !runActive && setPendingRun({ nonce: Date.now(), regen: { kind: k, index: index ?? undefined } })}
                onUploaded={refresh}
              />
            )}
          </main>

          <aside className="inspector">
            <div className="inspector-tabs" role="tablist">
              <button role="tab" className={inspector === "script" ? "on" : ""} onClick={() => setInspector("script")}>Script</button>
              <button role="tab" className={inspector === "craft" ? "on" : ""} onClick={() => setInspector("craft")}>
                <IconSparkles size={12} /> Write with AI
              </button>
            </div>
            {inspector === "craft" ? (
              <CraftPanel
                mode={kind}
                onCrafted={(n, c) => { setDraft({ name: n, config: c, kind }); setInspector("script"); }}
              />
            ) : editor ? (
              kind === "director" ? (
                <DirectorEditor
                  key={editor.name}
                  name={editor.name}
                  config={editor.config as DirectorScenario}
                  isDraft={!!draft}
                  onSave={handleSave}
                />
              ) : (
                <ScenarioEditor
                  key={editor.name}
                  name={editor.name}
                  config={editor.config as Scenario}
                  isDraft={!!draft}
                  onSave={handleSave}
                />
              )
            ) : (
              <section className="card">
                <div className="empty">
                  <span className="empty-icon"><IconFolder size={20} /></span>
                  <span className="empty-title">Nothing open</span>
                  <span className="empty-sub">
                    Pick a {kind === "director" ? "trailer" : "sequence"} from the bin, or let the AI write a new one.
                  </span>
                  <button className="primary" onClick={() => setInspector("craft")}>
                    <IconSparkles size={13} /> Write with AI
                  </button>
                </div>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

// GPU name + VRAM in use (ComfyUI /system_stats).
function GpuMeter({ comfy }: { comfy: ComfyStatus | null }) {
  const d = comfy?.stats?.devices?.[0];
  if (!d || !d.vram_total) return null;
  const used = d.vram_total - d.vram_free;
  const pct = (used / d.vram_total) * 100;
  const label = (d.name.match(/(RTX|GTX|Quadro|Tesla|Radeon|A\d{2,4}|H\d{2,3}|L\d{1,2})[^:]*/)?.[0] ?? d.name).trim();
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
  return (
    <span className="gpu" title={`${d.name}\nVRAM ${gb(used)} / ${gb(d.vram_total)} GB in use`}>
      <IconCpu size={13} />
      <span className="gpu-name">{label}</span>
      <span className={`gpu-bar ${pct > 90 ? "hot" : ""}`}><span style={{ width: `${pct}%` }} /></span>
      <span className="gpu-num">{gb(used)}/{gb(d.vram_total)} GB</span>
    </span>
  );
}
