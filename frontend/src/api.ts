import type {
  AnyScenario, ScenarioInfo, Run, ComfyStatus, AuthUser, OutputsInfo, AssetKind,
  StageEvent, LiveState, LivePreview, ScenarioKind,
} from "./types";

const get = async <T,>(url: string) => (await fetch(url)).json() as Promise<T>;
const postJson = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const okJson = <T,>(fallback: string) => (r: Response) =>
  r.ok ? r.json() as Promise<T> : r.json().then((d) => Promise.reject(new Error(d.error || fallback)));

// ---------------------------------------------------------------- auth
export type { AuthUser } from "./types";

export const me = async (): Promise<AuthUser> => {
  const r = await fetch("/api/me");
  if (!r.ok) throw new Error("unauthorized");
  return r.json() as Promise<AuthUser>;
};
export const login = (username: string, password: string) =>
  postJson("/api/login", { username, password }).then(okJson<AuthUser>("login failed"));
export const logout = () => fetch("/api/logout", { method: "POST" }).then((r) => r.json());

export const listScenarios = () => get<ScenarioInfo[]>("/api/scenarios");

// 06-Sep-2025
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
};
export const getScenario = (name: string) => get<{ name: string; config: AnyScenario }>(`/api/scenario/${name}`);
export const saveScenario = (name: string, config: AnyScenario) =>
  fetch(`/api/scenario/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  }).then((r) => r.json());
export const deleteScenario = (name: string) =>
  fetch(`/api/scenario/${name}`, { method: "DELETE" }).then(okJson<{ ok: boolean }>("delete failed"));

export const setFavorite = (name: string, on: boolean) =>
  postJson("/api/favorites", { name, on }).then((r) => r.json() as Promise<{ ok: boolean; names: string[] }>);

// i2v engine for character sequences; "director" runs scripts/movie_director.mjs.
export type Engine = "ltx" | "wan";
export type RunEngine = Engine | "director";

export interface RegenSpec {
  kind: "ref" | "keyframe" | "clip" | "narration" | "music";
  index?: number;
}

export const startRun = (scenario: string, opts: { stitch?: boolean; engine?: RunEngine; regen?: RegenSpec | null } = {}) =>
  postJson("/api/runs", {
    scenario,
    stitch: !!opts.stitch,
    engine: opts.engine || "ltx",
    regen: opts.regen || null,
  }).then(okJson<{ id: string }>("run failed to start"));

// Output dir for a scenario+engine (Wan runs write to outputs/<scenario>_wan/).
export const outScenario = (scenario: string, engine: Engine) =>
  engine === "wan" ? `${scenario}_wan` : scenario;

export const listRuns = () => get<Run[]>("/api/runs");
export const killRun = (id: string) => fetch(`/api/runs/${id}`, { method: "DELETE" }).then((r) => r.json());
export const comfyStatus = () => get<ComfyStatus>("/api/comfy");
export const listOutputs = (scenario: string) =>
  get<OutputsInfo>(`/api/outputs?scenario=${scenario}`);

// Pick which version of an asset is "main" (used for stitching / clip generation).
export const selectMain = (scenario: string, kind: AssetKind, index: number | null, file: string) =>
  postJson("/api/outputs/select", { scenario, kind, index, file }).then(okJson<OutputsInfo>("select failed"));

// Generate a reference image with Flux (no full run) — appends the next ref
// version; the latest version becomes main by default, click a chip to pick.
export const generateRef = (scenario: string, prompt?: string) =>
  postJson("/api/generate/ref", { scenario, prompt: prompt || null }).then(okJson<OutputsInfo>("generate ref failed"));

// Upload an image (data URL) as the scenario's reference — stored as the next
// ref version and selected as main (the pipeline then skips Flux ref generation).
export const uploadRef = (scenario: string, data: string) =>
  postJson("/api/upload/ref", { scenario, data }).then(okJson<OutputsInfo>("upload failed"));

// LLM craft: a character sequence (mode "sequence") or a director trailer.
export const craft = (topic: string, requirements: string, mode: ScenarioKind) =>
  postJson("/api/craft", { topic, requirements, mode }).then(okJson<{ name: string; config: AnyScenario }>("craft failed"));

// Ask the local LLM to extend a scenario with the next `count` beats in the story.
export const craftBeat = (config: AnyScenario, count = 1) =>
  postJson("/api/craft-beat", { config, count }).then(
    okJson<{ beats?: { title: string; image: string; motion: string }[]; beat?: { title: string; image: string; motion: string } }>("craft beat failed")
  );

export interface AssetEvent {
  kind: "image" | "video" | "audio";
  file: string;
  stage: "reference" | "narration" | "music" | "keyframe" | "clip" | "final";
  index?: number;
}

// SSE tail of a run's log. Returns a close function.
export function tailRun(
  id: string,
  onChunk: (line: string) => void,
  onDone: (status: string) => void,
  onAsset?: (a: AssetEvent) => void,
  onStage?: (s: StageEvent) => void
) {
  const es = new EventSource(`/api/runs/${id}/logs`);
  es.onmessage = (e) => onChunk(JSON.parse(e.data).line);
  if (onAsset) es.addEventListener("asset", (e) => onAsset(JSON.parse((e as MessageEvent).data) as AssetEvent));
  if (onStage) es.addEventListener("stage", (e) => onStage(JSON.parse((e as MessageEvent).data) as StageEvent));
  es.addEventListener("close", (e) => { onDone(JSON.parse((e as MessageEvent).data).status); es.close(); });
  return () => es.close();
}

// Live ComfyUI telemetry (job, sampler steps, latent previews). EventSource
// reconnects on its own if the server restarts. Returns a close function.
export function subscribeLive(onState: (s: LiveState) => void, onPreview: (p: LivePreview) => void) {
  const es = new EventSource("/api/live");
  es.addEventListener("state", (e) => onState(JSON.parse((e as MessageEvent).data) as LiveState));
  es.addEventListener("preview", (e) => onPreview(JSON.parse((e as MessageEvent).data) as LivePreview));
  return () => es.close();
}

export const outputUrl = (scenario: string, file: string) => `/outputs/${scenario}/${file}`;
