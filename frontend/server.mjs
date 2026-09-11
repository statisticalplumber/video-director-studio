// Backend for the character-sequence frontend. Zero deps, Node >= 18.
// Serves the built React app (dist/) + a small JSON API that drives
// scripts/character_sequence.mjs. Run: node server.mjs  (PORT env, default 8790)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { versionMap, setMain, nextVersion, loadState, resolveMain } from "../lib/sequence_state.mjs";
import { buildFluxGraph, run, download, firstImageUrl, uploadToInput } from "../lib/comfy.mjs";
import { REF_LEAD, withRefLead } from "../lib/sequence.mjs";
import { handleImg2Img } from "./img2img.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Same tiny .env loader as lib/comfy.mjs (real env vars always win).
{
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
  }
}
const PROMPTS = path.join(ROOT, "prompts");
const OUTPUTS = path.join(ROOT, "outputs");
const FAVS = path.join(ROOT, "favorites.json");
const readFavs = () => {
  try { return JSON.parse(fs.readFileSync(FAVS, "utf8")).names; }
  catch { return []; }
};
// ---------------------------------------------------------------- scenarios db
// Scenarios live in SQLite (data/scenarios.sqlite). On save we ALSO export the
// JSON to prompts/<name>.json so the CLI runners (director.mjs, ...), which
// read prompts/<scenario>.json, keep working unchanged.
const DATA_DIR = path.join(ROOT, "data");
const DB = path.join(DATA_DIR, "scenarios.sqlite");
{
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE IF NOT EXISTS scenarios (
    name TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // One-time migration: import any prompts/*.json not yet in the DB.
  const insert = db.prepare("INSERT OR IGNORE INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)");
  for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
    const name = f.replace(/\.json$/, "");
    if (!db.prepare("SELECT 1 FROM scenarios WHERE name = ?").get(name)) {
      insert.run(name, fs.readFileSync(path.join(PROMPTS, f), "utf8"), fs.statSync(path.join(PROMPTS, f)).mtimeMs);
    }
  }
  db.close();
}
const db = new DatabaseSync(DB);
const dbListScenarios = () =>
  db.prepare("SELECT name, config, updated_at FROM scenarios ORDER BY updated_at DESC").all();
const dbGetScenario = (name) => db.prepare("SELECT config FROM scenarios WHERE name = ?").get(name)?.config ?? null;
const dbSaveScenario = (name, cfg) =>
  db.prepare(`INSERT INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
    .run(name, JSON.stringify(cfg), Date.now());
const dbDeleteScenario = (name) => db.prepare("DELETE FROM scenarios WHERE name = ?").run(name);

const DIST = path.join(__dirname, "dist");
const PORT = Number(process.env.PORT || 8790);
// Local OpenAI-compatible LLM (llama-server etc.) for "Write with AI"; ComfyUI defaults to localhost.
const LLM_BASE = (process.env.LLM_BASE || "http://localhost:8080").replace(/\/+$/, "");
const COMFY_BASE = (process.env.COMFY_BASE || "http://localhost:8188").replace(/\/+$/, "");

// ---------------------------------------------------------------- live telemetry
// One websocket to ComfyUI (/ws) relayed to every browser over SSE (/api/live):
// which job is executing, sampler step progress, and latent preview frames.
// Every job this server queues (in-process or via spawned runners) carries
// CLIENT_ID as its client_id (lib/comfy.mjs queue()), so ComfyUI routes the
// progress + preview messages to this socket. Jobs queued without a client_id
// are broadcast by ComfyUI, so CLI runs show up too.
const CLIENT_ID = `sequence-studio-${crypto.randomBytes(4).toString("hex")}`;
process.env.COMFY_CLIENT_ID = CLIENT_ID;

const live = { connected: false, queueRemaining: 0, job: null, last: null };
const liveSubs = new Set();
let liveGraphTypes = {}; // node id -> class_type for the executing prompt
let lastPreview = null;  // data URL of the latest latent preview frame
let lastPreviewSent = 0;
let taskLabel = null;    // label for in-process jobs (reference gen, img2img)

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function currentLabel() {
  const r = [...runs.values()].find((x) => x.status === "running");
  if (r) return r.stage?.label ? `${r.scenario} · ${r.stage.label}` : r.scenario;
  return taskLabel;
}
function liveSnapshot() {
  const job = live.job && { ...live.job, label: currentLabel() };
  return { connected: live.connected, queueRemaining: live.queueRemaining, job, last: live.last, now: Date.now() };
}
function broadcastLive() {
  const snap = liveSnapshot();
  for (const s of liveSubs) sse(s, "state", snap);
}

// Job kind + model from the queued graph's node types.
function classifyGraph(graph) {
  const types = Object.values(graph || {}).map((n) => n?.class_type || "");
  const has = (re) => types.some((t) => re.test(t));
  const samplers = types.filter((t) => /KSampler|SamplerCustom/.test(t)).length || 1;
  if (has(/^WanImageToVideo/)) return { kind: "video", model: "Wan 2.1 i2v", passes: samplers };
  if (has(/^LTXV/)) {
    const t2v = Object.values(graph).some((n) => n?._meta?.title === "Switch to Text to Video?" && n.inputs?.value === true);
    return { kind: "video", model: has(/Flux2/) ? "Flux 2 → LTX 2.5" : t2v ? "LTX 2.5 t2v (audio)" : "LTX 2.5 i2v", passes: samplers };
  }
  if (has(/^SaveVideo$/)) return { kind: "video", model: "Video", passes: samplers };
  return { kind: "image", model: "Flux 2 Klein", passes: samplers };
}

async function startLiveJob(promptId) {
  live.job = {
    promptId, kind: "image", model: "…", node: null, nodeClass: null,
    value: 0, max: 0, pass: 0, passes: 1, samplers: [],
    startedAt: Date.now(), passStartedAt: Date.now(), secPerStep: null,
  };
  liveGraphTypes = {};
  lastPreview = null;
  try {
    const q = await fetch(`${COMFY_BASE}/queue`).then((r) => r.json());
    const entry = (q.queue_running || []).find((e) => e[1] === promptId);
    if (entry && live.job?.promptId === promptId) {
      const graph = entry[2] || {};
      for (const [id, n] of Object.entries(graph)) liveGraphTypes[id] = n?.class_type;
      Object.assign(live.job, classifyGraph(graph));
      if (live.job.node) live.job.nodeClass = liveGraphTypes[live.job.node] ?? null;
      broadcastLive();
    }
  } catch { /* graph unknown — keep defaults */ }
}
function endLiveJob(status, error) {
  if (!live.job) return;
  live.last = { ...live.job, label: currentLabel(), status, error: error || null, endedAt: Date.now() };
  live.job = null;
}
function ensureLiveJob(promptId) {
  if (promptId && live.job?.promptId !== promptId) startLiveJob(promptId);
}

function onLiveMessage(msg) {
  const { type, data = {} } = msg;
  switch (type) {
    case "status":
      live.queueRemaining = data.status?.exec_info?.queue_remaining ?? live.queueRemaining;
      break;
    case "execution_start":
      startLiveJob(data.prompt_id);
      break;
    case "executing":
      if (data.node == null) { if (live.job?.promptId === data.prompt_id) endLiveJob("done"); break; }
      ensureLiveJob(data.prompt_id);
      live.job.node = data.node;
      live.job.nodeClass = liveGraphTypes[data.node] ?? null;
      break;
    case "progress": {
      ensureLiveJob(data.prompt_id);
      const j = live.job;
      const now = Date.now();
      if (!j.samplers.includes(data.node)) {
        j.samplers.push(data.node);
        j.passStartedAt = now;
        j.secPerStep = null;
      }
      j.pass = j.samplers.indexOf(data.node) + 1;
      j.passes = Math.max(j.passes, j.pass);
      if (data.value > 1) j.secPerStep = (now - j.passStartedAt) / 1000 / (data.value - 1);
      if (data.value === 1) j.passStartedAt = now;
      j.value = data.value;
      j.max = data.max;
      break;
    }
    case "execution_success": endLiveJob("done"); break;
    case "execution_error": endLiveJob("error", data.exception_message); break;
    case "execution_interrupted": endLiveJob("interrupted"); break;
    default: return;
  }
  broadcastLive();
}

// Binary frames: [u32 type][...]. type 1 = PREVIEW_IMAGE ([u32 format][bytes],
// format 2 = png else jpeg); type 4 = PREVIEW_IMAGE_WITH_METADATA
// ([u32 metaLen][json meta][bytes]).
function onLivePreview(ab) {
  const buf = Buffer.from(ab);
  if (buf.length < 8) return;
  const type = buf.readUInt32BE(0);
  let mime = "image/jpeg", img;
  if (type === 1) {
    if (buf.readUInt32BE(4) === 2) mime = "image/png";
    img = buf.subarray(8);
  } else if (type === 4) {
    const len = buf.readUInt32BE(4);
    try { mime = JSON.parse(buf.subarray(8, 8 + len).toString()).image_type || mime; } catch { /* keep jpeg */ }
    img = buf.subarray(8 + len);
  } else return;
  lastPreview = `data:${mime};base64,${img.toString("base64")}`;
  const now = Date.now();
  if (now - lastPreviewSent < 250) return; // ~4 fps is plenty for a monitor
  lastPreviewSent = now;
  for (const s of liveSubs) sse(s, "preview", { src: lastPreview, promptId: live.job?.promptId ?? null });
}

function connectLive() {
  if (!COMFY_BASE || typeof WebSocket === "undefined") return;
  let ws;
  try {
    ws = new WebSocket(`${COMFY_BASE.replace(/^http/, "ws")}/ws?clientId=${CLIENT_ID}`);
  } catch {
    setTimeout(connectLive, 5000);
    return;
  }
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { live.connected = true; broadcastLive(); };
  ws.onclose = () => {
    live.connected = false;
    endLiveJob("disconnected");
    broadcastLive();
    setTimeout(connectLive, 5000);
  };
  ws.onerror = () => {}; // onclose follows and schedules the reconnect
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try { onLiveMessage(JSON.parse(ev.data)); } catch { /* ignore malformed */ }
    } else onLivePreview(ev.data);
  };
}

/** Run an in-process ComfyUI task with a monitor label. */
async function withTaskLabel(label, fn) {
  taskLabel = label;
  broadcastLive();
  try { return await fn(); }
  finally { taskLabel = null; broadcastLive(); }
}

// ---------------------------------------------------------------- auth
// Single-user login. Credentials come from env (.env or real env);
// defaults are admin / admin — override for anything non-local.
const AUTH_USER = process.env.LOGIN_USER || "admin";
const AUTH_PASS = process.env.LOGIN_PASS || "admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE_NAME = "ss_session";

const sessions = new Map(); // token -> { user, exp }
function pruneSessions() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp <= now) sessions.delete(t);
}
function cookieValue(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(v.join("="));
  }
  return null;
}
function authedUser(req) {
  const token = cookieValue(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.exp <= Date.now()) { sessions.delete(token); return null; }
  return s.user;
}
function sessionCookie(token, maxAgeSec) {
  const attrs = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/"];
  if (maxAgeSec != null) attrs.push(`Max-Age=${maxAgeSec}`);
  else attrs.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return attrs.join("; ");
}

// ---------------------------------------------------------------- helpers
const isSafe = (name) => !name.includes("..") && !name.includes("/") && !name.includes("\\");
const json = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
const readJson = (req) => new Promise((res, rej) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { try { res(JSON.parse(b)); } catch { rej(new Error("bad json")); } });
});

// ---------------------------------------------------------------- runs
// One run = one spawned runner script for <scenario>.
// engine: "ltx" (default) / "wan" -> scripts/character_sequence{,_wan}.mjs,
//         "director"             -> scripts/movie_director.mjs
// opts.stitch   -> --stitch (re-stitch final from selected mains only)
// opts.regen    -> --regen <ref|keyframe|clip|narration> [beat] (regenerate one asset, keeps old versions)
const runs = new Map(); // id -> { scenario, status, log, stage, startedAt, proc, subs:Set<res> }
const SCRIPTS = {
  ltx: "scripts/character_sequence.mjs",
  wan: "scripts/character_sequence_wan.mjs",
  director: "scripts/movie_director.mjs",
};

function startRun(scenario, opts = {}) {
  const { stitch = false, regen = null, engine = "ltx" } = opts;
  if (!isSafe(String(scenario || ""))) throw new Error("bad scenario");
  if ([...runs.values()].some((r) => r.status === "running"))
    throw new Error("another run is still active (ComfyUI queue is serial)");
  const script = SCRIPTS[engine] || SCRIPTS.ltx;
  const argv = [script, scenario];
  if (stitch) argv.push("--stitch");
  if (regen) {
    argv.push("--regen", regen.kind, ...(regen.index ? [String(regen.index)] : []));
  }
  const id = Date.now().toString(36);
  const proc = spawn("node", argv, {
    cwd: ROOT, env: process.env,
  });
  const run = { id, scenario, engine, stitch, regen, status: "running", log: "", assets: [], stage: null, startedAt: Date.now(), proc, subs: new Set() };
  runs.set(id, run);
  let lineBuf = "";
  const push = (chunk) => {
    run.log += chunk;
    for (const s of run.subs) s.write(`data: ${JSON.stringify({ line: chunk })}\n\n`);
    // Detect structured `[asset] {...}` lines (script emits one per finished file).
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const m = line.match(/^\[asset\] (\{.*\})\s*$/);
      if (m) {
        const asset = JSON.parse(m[1]);
        run.assets.push(asset);
        for (const s of run.subs) sse(s, "asset", asset);
      }
      // `[stage] {...}` = the runner just queued a job (pipeline tracker + monitor label).
      const st = line.match(/^\[stage\] (\{.*\})\s*$/);
      if (st) {
        run.stage = JSON.parse(st[1]);
        for (const s of run.subs) sse(s, "stage", run.stage);
        broadcastLive();
      }
    }
  };
  proc.stdout.on("data", (d) => push(d.toString()));
  proc.stderr.on("data", (d) => push(d.toString()));
  proc.on("close", (code) => {
    run.status = code === 0 ? "done" : "error";
    run.endedAt = Date.now();
    push(`\n[exit ${code}]\n`);
    for (const s of run.subs) { sse(s, "close", { status: run.status }); s.end(); }
    run.subs.clear();
    broadcastLive();
  });
  return run;
}

// ---------------------------------------------------------------- comfy status
async function comfyStatus() {
  try {
    const [stats, queue] = await Promise.all([
      fetch(`${COMFY_BASE}/system_stats`).then((r) => r.json()),
      fetch(`${COMFY_BASE}/queue`).then((r) => r.json()),
    ]);
    // Drop the full prompt graphs from the queue payload — the UI only counts them.
    return {
      up: true, stats, live: live.connected,
      queue: { queue_running: (queue.queue_running || []).map((e) => e[1]), queue_pending: (queue.queue_pending || []).map((e) => e[1]) },
    };
  } catch (e) {
    return { up: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- LLM craft
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "scenario";

// Shared in-prompt format reference for the craft step.
const craftReference = () => JSON.parse(fs.readFileSync(path.join(PROMPTS, "anime_sequence.json"), "utf8"));

/** One chat call to the local LLM (llama-server, OpenAI-compatible) -> parsed JSON object. */
async function llmJson(system, user, maxTokens) {
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.7,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  let text = d.choices?.[0]?.message?.content || "";
  text = text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM returned no JSON object");
  return JSON.parse(m[0]);
}

// Director scenarios: narrationPrompt = voice direction + the spoken script
// (LTX t2v generates the voiceover audio from it). Mirrored in the frontend
// DirectorEditor (composeNarration) so edits there rebuild it the same way.
const composeNarration = (voice, script) =>
  `${String(voice || "").trim()} The narrator says, slowly and clearly: "${String(script || "").trim()}"`;

/**
 * Ask the local LLM to direct a short cinematic trailer: voiceover script +
 * voice direction + N shots (Flux keyframe + LTX motion). Output shape matches
 * prompts/movie_director.json so scripts/movie_director.mjs runs it unchanged.
 */
async function craftDirector({ topic, requirements = "", name }) {
  const base = JSON.parse(fs.readFileSync(path.join(PROMPTS, "movie_director.json"), "utf8"));
  const system = [
    "You are a film director planning a short cinematic trailer that will be generated with ComfyUI. Output ONLY a JSON object, no prose, no markdown fences.",
    "Schema: { description: string, character: string, referencePrompt: string, narrationScript: string, voice: string, musicPrompt: string, narrationDuration: number,",
    "  sequence: [ { title: snake_case_file_safe, duration: number, image: string, motion: string, useRef: boolean } ] }",
    "Rules: character = ONE recurring main subject (person, creature or object) described in 1-2 sentences — appearance, wardrobe/markings, age — reused VERBATIM wherever that subject appears.",
    "referencePrompt = a static cinematic key-visual (portrait/full-body) of that character for Flux: the character block verbatim + neutral pose, setting, lighting, lens. This image will be used as the identity reference for every shot.",
    "narrationScript = the spoken voiceover only (no stage directions), about 2.3 words per second of narrationDuration.",
    "voice = who the narrator is + tone, pacing and recording quality (close-mic studio, no music, no sound effects, only the voice).",
    "musicPrompt = a 1-2 sentence description of the score under the voiceover (genre, instruments, tempo, mood, build, no vocals) — or an empty string for no music.",
    "narrationDuration = 15-30 seconds (default 20). sequence = 5 shots in story order; each duration 3-5 seconds; durations sum to about narrationDuration.",
    "image = static cinematic photorealistic keyframe prompt for Flux: subject, setting, lighting, lens, color grade. Where the character appears, include the character block verbatim and set useRef true; for establishing/landscape shots without the character set useRef false.",
    "motion = 1-2 sentences of subject motion + camera move for LTX image-to-video, ending with 'no cuts'. Titles unique, short, snake_case, prefixed a_, b_, c_ ... in order.",
  ].join(" ");
  const user = `Reference example (match its structure and level of detail, NOT its subject):
${JSON.stringify({ description: base.description, narrationScript: base.narrationScript, narrationDuration: base.narrationDuration, sequence: base.sequence.map((s) => ({ ...s, useRef: true })) }, null, 2)}

New trailer to direct:
Topic: ${topic}
Requirements: ${requirements || "(none)"}`;
  const out = await llmJson(system, user, 8000);
  if (!out.narrationScript || !Array.isArray(out.sequence) || !out.sequence.length)
    throw new Error("crafted trailer missing narrationScript/sequence");
  const voice = String(out.voice || "Natural documentary voiceover. A warm, deep narrator speaks calmly and intimately, with natural pauses. Warm close-mic studio recording, no music, no sound effects, only the voice.");
  const narrationDuration = Math.min(30, Math.max(8, Number(out.narrationDuration) || 20));
  const config = {
    description: String(out.description || topic),
    character: String(out.character || ""),
    referencePrompt: String(out.referencePrompt || ""),
    narrationScript: String(out.narrationScript),
    voice,
    narrationPrompt: composeNarration(voice, out.narrationScript),
    musicPrompt: String(out.musicPrompt || ""),
    musicVolume: 0.35,
    narrationDuration,
    narrationFps: base.narrationFps ?? 24,
    narrationSize: base.narrationSize ?? [64, 64],
    ratio: base.ratio ?? "9:16 (Portrait Widescreen)",
    megapixels: base.megapixels ?? 0.5,
    keyframeWidth: base.keyframeWidth ?? 768,
    keyframeHeight: base.keyframeHeight ?? 1280,
    clipAudioVolume: base.clipAudioVolume ?? 0.2,
    sequence: out.sequence.map((s, i) => ({
      title: slug(s.title) || `shot${i + 1}`,
      duration: Math.min(6, Math.max(2, Number(s.duration) || 4)),
      image: String(s.image || ""),
      motion: String(s.motion || ""),
      useRef: s.useRef !== false,
    })),
  };
  return { name: slug(name || topic || config.description) || "trailer", config };
}

// The reference prompt always leads with the reference-image line: the person
// is taken from the (uploaded) reference image, the rest of the prompt is the
// scene. Works whether or not an image is uploaded — Flux supports reference
// images, and /api/generate/ref feeds the main ref back in as the reference
// latent (ReferenceLatent conditioning), so the person stays the same.
/**
 * Ask the local LLM (llama-server, OpenAI-compatible) to craft a
 * character-sequence scenario JSON from the topic (one text-only call).
 * The reference prompt always leads with the reference-image line (see
 * REF_LEAD) — the user may upload a reference image later, and Flux uses it
 * as the img2img reference for the person.
 */
async function craftScenario({ topic, requirements = "", name }) {
  const reference = craftReference();
  const system = [
    "You write ComfyUI video-generation scenario configs. Output ONLY a JSON object, no prose, no markdown fences.",
    "Schema: { description: string, character: string, referencePrompt: string, duration: number,",
    '  sequence: [ { title: snake_case_file_safe, image: string, motion: string } ] }',
    "Rules: character = one consistent subject description reused verbatim in referencePrompt and every image prompt.",
    `referencePrompt = the cinematic key-visual of the character (static). It MUST start with the exact line "${REF_LEAD}" and then describe the scene — the person is taken from the reference image, the rest of the prompt is your part (pose, setting, lighting, composition).`,
    `sequence = 4 story beats in chronological order; each image = static keyframe prompt for Flux. Every image prompt MUST ALSO start with the exact line "${REF_LEAD}" and then describe the scene (the person is taken from the reference image, the rest is your part — pose, setting, lighting, composition);`,
    "each motion = 1-2 sentences of motion + camera direction for LTX image-to-video (no cuts, no new characters).",
    "duration = seconds per clip (2-5). Titles must be unique, short, snake_case.",
  ].join(" ");
  const user = `Reference example (match its style and level of detail, NOT its subject):
${JSON.stringify(reference, null, 2)}

New scenario to craft:
Topic: ${topic}
Requirements: ${requirements || "(none)"}`;
  const cfg = await llmJson(system, user, 8000);
  if (!cfg.referencePrompt || !Array.isArray(cfg.sequence) || !cfg.sequence.length)
    throw new Error("crafted config missing referencePrompt/sequence");
  cfg.referencePrompt = withRefLead(cfg.referencePrompt);
  cfg.duration = Number(cfg.duration) || 3;
  cfg.sequence = cfg.sequence.map((b, i) => ({
    title: slug(b.title) || `beat${i + 1}`,
    image: withRefLead(String(b.image || "")),
    motion: String(b.motion || ""),
  }));
  const scenarioName = slug(name || topic || cfg.description) || "scenario";
  return { name: scenarioName, config: cfg };
}

/**
 * Ask the local LLM to extend a scenario with the NEXT beat in the story.
 * Context = the scenario JSON itself (description / character / referencePrompt
 * + existing beats), so the new beat continues chronologically from the last
 * existing beat and keeps the same character and visual style.
 */
async function craftNextBeat(cfg) {
  const existing = (cfg.sequence || []).map((b, i) => ({
    n: i + 1,
    title: b.title,
    image: b.image,
    motion: b.motion,
  }));
  const system = [
    "You extend a ComfyUI video-generation scenario with exactly ONE next beat.",
    "The story must continue chronologically from the last existing beat — pick the natural next moment in the arc.",
    "Rules: title = short snake_case_file_safe and unique among existing titles;",
    `image = static keyframe prompt for Flux. It MUST start with the exact line "${REF_LEAD}" and then describe the scene (reuse the character block VERBATIM, keep the same visual style, new moment/pose/setting detail);`,
    "motion = 1-2 sentences of motion + camera direction for LTX image-to-video (no cuts, no new characters).",
    "Output ONLY a JSON object { title, image, motion } — no prose, no markdown fences.",
  ].join(" ");
  const user = `Scenario context:
${JSON.stringify({
    description: cfg.description || "",
    character: cfg.character || "",
    referencePrompt: cfg.referencePrompt || "",
    existingBeats: existing,
  }, null, 2)}

Write the next beat (beat ${existing.length + 1}).`;
  const b = await llmJson(system, user, 2000);
  if (!b.image || !b.motion) throw new Error("crafted beat missing image/motion");
  let title = slug(b.title) || `beat${existing.length + 1}`;
  const taken = new Set(existing.map((x) => x.title));
  if (taken.has(title)) title = `${title}_next`;
  return { title, image: withRefLead(String(b.image)), motion: String(b.motion) };
}

/** Generate `count` consecutive beats; each call continues from the previous one. */
async function craftNextBeats(cfg, count) {
  const beats = [];
  const cur = { ...cfg, sequence: [...(cfg.sequence || [])] };
  for (let i = 0; i < count; i++) {
    const b = await craftNextBeat(cur);
    beats.push(b);
    cur.sequence.push(b);
  }
  return beats;
}

// ---------------------------------------------------------------- static files
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".wav": "audio/wav", ".ico": "image/x-icon" };
function serveStatic(req, res, urlPath) {
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}
function serveOutput(res, scenario, file) {
  const p = path.join(OUTPUTS, scenario, file);
  if (!isSafe(scenario) || !isSafe(file) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}

// ---------------------------------------------------------------- outputs (versions + mains)
// Output dir name -> scenario config name (Wan runs use outputs/<scenario>_wan/).
const cfgNameFor = (dirName) => (dirName.endsWith("_wan") ? dirName.slice(0, -4) : dirName);
const prefixFor = (dirName) => (dirName.endsWith("_wan") ? `${cfgNameFor(dirName)}_wan` : dirName);

/**
 * List output files + versioned assets for a scenario output dir.
 * versions: { ref: [{file,v}], beats: { n: { keyframe: [...], clip: [...] } } }
 * mains:    { ref: file|null,    beats: { n: { keyframe: file|null, clip: file|null } } }
 */
function outputsPayload(name) {
  const dir = path.join(OUTPUTS, name);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort()
    : [];
  const versions = { ref: [], beats: {} };
  const mains = { ref: null, beats: {} };
  const cfgPath = path.join(PROMPTS, cfgNameFor(name) + ".json");
  if (files.length && fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if ((cfg.referencePrompt || cfg.narrationPrompt) && Array.isArray(cfg.sequence) && cfg.sequence.length) {
      // Director runs name keyframes movie_kf<n>_<title> and the reference <scenario>_ref.
      const vm = cfg.narrationPrompt
        ? versionMap(dir, "movie", cfg.sequence, { kfKind: "kf", refPrefix: prefixFor(name) })
        : versionMap(dir, prefixFor(name), cfg.sequence);
      mains.ref = vm.refMain;
      for (const [n, b] of Object.entries(vm.beats)) {
        versions.beats[n] = { keyframe: b.keyframe, clip: b.clip };
        mains.beats[n] = { keyframe: b.keyframeMain, clip: b.clipMain };
      }
      versions.ref = vm.ref;
    }
  }
  return { files, versions, mains };
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    if (p === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      const ok = String(body.username || "") === AUTH_USER && String(body.password || "") === AUTH_PASS;
      if (!ok) return json(res, 401, { error: "invalid credentials" });
      pruneSessions();
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { user: AUTH_USER, exp: Date.now() + SESSION_TTL_MS });
      res.setHeader("Set-Cookie", sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
      return json(res, 200, { user: AUTH_USER });
    }
    if (p === "/api/logout" && req.method === "POST") {
      const token = cookieValue(req);
      if (token) sessions.delete(token);
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      return json(res, 200, { ok: true });
    }
    if (p === "/api/me" && req.method === "GET") {
      const user = authedUser(req);
      return user ? json(res, 200, { user }) : json(res, 401, { error: "unauthorized" });
    }

    // Everything below (API + generated outputs) requires a session.
    if ((p.startsWith("/api/") || p.startsWith("/outputs/")) && !authedUser(req))
      return json(res, 401, { error: "unauthorized" });

    if (p === "/api/scenarios" && req.method === "GET") {
      const favs = readFavs();
      return json(res, 200, dbListScenarios().map((r) => {
        const c = JSON.parse(r.config);
        const kind = !Array.isArray(c.sequence) ? null
          : c.narrationPrompt ? "director" : c.referencePrompt ? "sequence" : null;
        return {
          name: r.name,
          kind,
          isSequence: kind === "sequence",
          mtimeMs: r.updated_at,
          favorite: favs.includes(r.name),
        };
      }).sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.mtimeMs - a.mtimeMs)); // favorites first, then latest edited
    }
    if (p === "/api/favorites" && req.method === "POST") {
      const { name, on } = await readJson(req);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      let favs = readFavs();
      favs = on ? (favs.includes(name) ? favs : [...favs, name]) : favs.filter((n) => n !== name);
      fs.writeFileSync(FAVS, JSON.stringify({ names: favs }, null, 2));
      return json(res, 200, { ok: true, names: favs });
    }
    if (p.startsWith("/api/scenario/") && req.method === "GET") {
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const raw = dbGetScenario(name);
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      return json(res, 200, { name, config: JSON.parse(raw) });
    }
    if (p.startsWith("/api/scenario/") && req.method === "PUT") {
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const cfg = await readJson(req);
      dbSaveScenario(name, cfg);
      // Keep the JSON export for the CLI runners.
      fs.writeFileSync(path.join(PROMPTS, name + ".json"), JSON.stringify(cfg, null, 2));
      return json(res, 200, { ok: true });
    }
    if (p.startsWith("/api/scenario/") && req.method === "DELETE") {
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if (dbGetScenario(name) === null) return json(res, 404, { error: "no such scenario" });
      dbDeleteScenario(name);
      const f = path.join(PROMPTS, name + ".json");
      if (fs.existsSync(f)) fs.unlinkSync(f);
      const outDir = path.join(OUTPUTS, name);
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    if (p === "/api/runs" && req.method === "POST") {
      const body = await readJson(req);
      const run = startRun(body.scenario, {
        stitch: !!body.stitch,
        engine: body.engine || "ltx",
        regen: body.regen || null,
      });
      return json(res, 200, { id: run.id });
    }
    if (p === "/api/runs" && req.method === "GET")
      return json(res, 200, [...runs.values()].map(({ proc, subs, log, ...r }) => r).reverse());
    if (p === "/api/live" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      sse(res, "state", liveSnapshot());
      if (lastPreview) sse(res, "preview", { src: lastPreview, promptId: live.job?.promptId ?? null });
      liveSubs.add(res);
      req.on("close", () => liveSubs.delete(res));
      return;
    }
    if (p.startsWith("/api/runs/") && req.method === "GET") {
      const run = runs.get(p.split("/")[3]);
      if (!run) return json(res, 404, { error: "no run" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ line: run.log })}\n\n`);
      for (const a of run.assets) sse(res, "asset", a);
      if (run.stage) sse(res, "stage", run.stage);
      if (run.status !== "running") { sse(res, "close", { status: run.status }); return res.end(); }
      run.subs.add(res);
      req.on("close", () => run.subs.delete(res));
      return;
    }
    if (p.startsWith("/api/runs/") && req.method === "DELETE") {
      const run = runs.get(p.split("/")[3]);
      if (run && run.status === "running") run.proc.kill("SIGTERM");
      return json(res, 200, { ok: true });
    }
    if (p === "/api/outputs" && req.method === "GET") {
      const name = u.searchParams.get("scenario");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      return json(res, 200, outputsPayload(name));
    }
    if (p === "/api/outputs/select" && req.method === "POST") {
      const body = await readJson(req);
      const { scenario, kind, index, file } = body;
      if (!isSafe(scenario) || typeof file !== "string") return json(res, 400, { error: "bad body" });
      const dir = path.join(OUTPUTS, scenario);
      if (!fs.existsSync(dir)) return json(res, 404, { error: "no outputs" });
      setMain(dir, prefixFor(scenario), kind, kind === "ref" ? 0 : index, null, file);
      return json(res, 200, outputsPayload(scenario));
    }
    if (p === "/api/generate/ref" && req.method === "POST") {
      // Standalone Flux reference generation (no full run): appends the next
      // ref version in outputs/<scenario>/ from the scenario's referencePrompt.
      // If a reference image already exists (uploaded, or an earlier generated
      // version selected as main), Flux uses it as the reference latent
      // (ReferenceLatent conditioning), so the person stays the same across
      // regenerations.
      // The new version is set MAIN: the intended flow is upload -> generate
      // (apply the reference prompt, check the effect) -> run, so the full run
      // anchors on the generated image. Version chips can still select an
      // older version (e.g. the raw upload) back as main.
      const body = await readJson(req);
      const scenario = String(body.scenario || "");
      if (!isSafe(scenario)) return json(res, 400, { error: "bad scenario" });
      if ([...runs.values()].some((r) => r.status === "running"))
        return json(res, 409, { error: "another run is still active — wait for it to finish" });
      const raw = dbGetScenario(scenario);
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      const cfg = JSON.parse(raw);
      const prompt = body.prompt ? String(body.prompt) : cfg.referencePrompt;
      if (!prompt) return json(res, 400, { error: "scenario has no referencePrompt" });
      const outDir = path.join(OUTPUTS, scenario);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(scenario);
      const v = nextVersion(outDir, prefix, "ref", 0, ".png");
      const file = v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`;
      const refFile = resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir));
      // Director trailers: render the key visual at the shot format (portrait by
      // default) and, when re-rolling over an existing ref, lead with the
      // reference line so Flux keeps the same subject.
      const director = !!cfg.narrationPrompt;
      const dims = director ? { width: cfg.keyframeWidth ?? 768, height: cfg.keyframeHeight ?? 1280 } : {};
      const lead = cfg.refLead ?? "Take the main subject from the reference image, ";
      const finalPrompt = director && refFile && !/^take .*from .*reference image/i.test(prompt) ? lead + prompt : prompt;
      await withTaskLabel(`${scenario} · Reference v${v}`, async () => {
        const image = refFile ? await uploadToInput(path.join(outDir, refFile), `${prefix}_refgen`) : null;
        const entry = await run(buildFluxGraph({ prompt: finalPrompt, image, prefix: `${prefix}/ref_gen`, ...dims }), `ref v${v}`);
        await download(firstImageUrl(entry), path.join(outDir, file));
      });
      setMain(outDir, prefix, "ref", 0, null, file);
      return json(res, 200, { file, ...outputsPayload(scenario) });
    }
    if (p === "/api/upload/ref" && req.method === "POST") {
      // Upload an image as the scenario's reference (browse / drag-drop / clipboard).
      // Stored as the next ref version in outputs/<scenario>/ and selected as main,
      // so the pipeline skips Flux ref generation and uses the uploaded image.
      const body = await readJson(req);
      const scenario = String(body.scenario || "");
      if (!isSafe(scenario)) return json(res, 400, { error: "bad scenario" });
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:image\/\w+;base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:image base64 payload" });
      const buf = Buffer.from(m[1], "base64");
      if (!buf.length) return json(res, 400, { error: "empty image" });
      const outDir = path.join(OUTPUTS, scenario);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(scenario);
      const v = nextVersion(outDir, prefix, "ref", 0, ".png");
      const file = v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`;
      fs.writeFileSync(path.join(outDir, file), buf);
      setMain(outDir, prefix, "ref", 0, null, file);
      return json(res, 200, outputsPayload(scenario));
    }
    if (p === "/api/outputs/stitch" && req.method === "POST") {
      const body = await readJson(req);
      if (!isSafe(body.scenario)) return json(res, 400, { error: "bad scenario" });
      const run = startRun(body.scenario, { stitch: true, engine: body.engine || "ltx" });
      return json(res, 200, { id: run.id });
    }
    if (p === "/api/craft" && req.method === "POST") {
      const body = await readJson(req);
      // Text-only craft: the topic drives the scenario. The reference image is
      // uploaded later in the Outputs panel (it becomes Flux's img2img ref).
      if (!body.topic) return json(res, 400, { error: "topic required" });
      return json(res, 200, body.mode === "director" ? await craftDirector(body) : await craftScenario(body));
    }
    if (p === "/api/craft-beat" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      const count = Math.min(8, Math.max(1, Number(body.count) || 1));
      return json(res, 200, { beats: await craftNextBeats(cfg, count) });
    }
    if (p === "/api/img2img" && req.method === "POST")
      return withTaskLabel("Img2Img", () => handleImg2Img(req, res, { readJson, json }));
    if (p === "/api/comfy" && req.method === "GET") return json(res, 200, await comfyStatus());
    if (p.startsWith("/outputs/")) {
      const [, , scenario, file] = p.split("/");
      return serveOutput(res, decodeURIComponent(scenario), decodeURIComponent(file));
    }
    if (p.startsWith("/api/")) return json(res, 404, { error: "unknown route" });
    serveStatic(req, res, p === "/" ? "/index.html" : p);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});
server.listen(PORT, () => console.log(`frontend server on http://localhost:${PORT}`));
connectLive();
