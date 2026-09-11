export interface Beat {
  title: string;
  image: string;
  motion: string;
}

export interface Scenario {
  description?: string;
  character?: string;
  referencePrompt: string;
  duration: number;
  sequence: Beat[];
}

// Movie-director trailer (scripts/movie_director.mjs, prompts/movie_director.json shape).
export interface DirectorShot {
  title: string;
  duration?: number;
  image: string;
  motion: string;
  useRef?: boolean; // default true: keyframe is conditioned on the reference image (when one exists)
}

export interface DirectorScenario {
  description?: string;
  character?: string;        // recurring subject, reused verbatim in prompts
  referencePrompt?: string;  // Flux key visual of the character (generated ref)
  refLead?: string;          // prefix added to ref-conditioned prompts
  narrationScript?: string;
  voice?: string;
  narrationPrompt: string;
  musicPrompt?: string;      // LTX-generated score under the VO (empty = none)
  musicVolume?: number;
  musicDuration?: number;
  narrationDuration?: number;
  finalDuration?: number;
  narrationFps?: number;
  narrationSize?: [number, number];
  ratio?: string;
  megapixels?: number;
  keyframeWidth?: number;
  keyframeHeight?: number;
  clipAudioVolume?: number;
  sequence: DirectorShot[];
}

export type AnyScenario = Scenario | DirectorScenario;
export type ScenarioKind = "sequence" | "director";

export interface ScenarioInfo {
  name: string;
  kind: ScenarioKind | null;
  isSequence: boolean;
  mtimeMs: number;
  favorite?: boolean;
}

// `[stage] {...}` marker from a runner: the job it just queued.
export interface StageEvent {
  stage: "reference" | "narration" | "music" | "keyframe" | "clip" | "final";
  index?: number;
  total?: number;
  label?: string;
}

export interface Run {
  id: string;
  scenario: string;
  engine?: string;
  status: "running" | "done" | "error";
  stage?: StageEvent | null;
  startedAt: number;
  endedAt?: number;
}

export interface AuthUser {
  user: string;
}

export interface ComfyDevice {
  name: string;
  type?: string;
  vram_total: number;
  vram_free: number;
}

export interface ComfyStatus {
  up: boolean;
  live?: boolean;
  error?: string;
  queue?: { queue_running?: unknown[]; queue_pending?: unknown[] };
  stats?: { system?: Record<string, unknown>; devices?: ComfyDevice[] };
}

// Live ComfyUI telemetry relayed by the server (/api/live).
export interface LiveJob {
  promptId: string;
  kind: "image" | "video";
  model: string;
  label: string | null;
  node: string | null;
  nodeClass: string | null;
  value: number;
  max: number;
  pass: number;
  passes: number;
  startedAt: number;
  passStartedAt: number;
  secPerStep: number | null;
}

export interface LiveState {
  connected: boolean;
  queueRemaining: number;
  job: LiveJob | null;
  last: (LiveJob & { status: string; error: string | null; endedAt: number }) | null;
  now: number;
  skew?: number; // client clock - server clock (ms), set on receipt
}

export interface LivePreview {
  src: string;
  promptId: string | null;
}

// One version of a versioned asset (v1 = original file, vN = _vN suffix).
export interface AssetVersion {
  file: string;
  v: number;
}

export interface BeatVersions {
  keyframe: AssetVersion[];
  clip: AssetVersion[];
}

export interface VersionsInfo {
  ref: AssetVersion[];
  beats: Record<string, BeatVersions>;
}

export interface MainsInfo {
  ref: string | null;
  beats: Record<string, { keyframe: string | null; clip: string | null }>;
}

export interface OutputsInfo {
  files: string[];
  versions: VersionsInfo;
  mains: MainsInfo;
}

export type AssetKind = "ref" | "keyframe" | "clip";
