// MOVIE DIRECTOR: narrated cinematic trailer.
//   voiceover  — LTX t2v at a tiny frame (video thrown away, audio kept)
//   music bed  — same trick from cfg.musicPrompt (optional)
//   reference  — Flux key visual of the recurring subject (cfg.referencePrompt),
//                or an uploaded image (outputs/<scenario>/<scenario>_ref.png);
//                anchors every keyframe via Flux reference conditioning
//   keyframes  — Flux, N shots (9:16 or 16:9), ref-conditioned unless shot.useRef === false
//   clips      — LTX i2v per keyframe
//   final cut  — clips stream-copied, VO on top, music + shot audio ducked under
//
// Versioning (lib/sequence_state.mjs): re-rolls write _vN files, never overwrite;
// state.json picks the "main" take per asset; the cut always uses the mains.
//   ref        <scenario>_ref.png            keyframes  movie_kf<n>_<title>.png
//   clips      movie_clip<n>_<title>.mp4     voiceover  narration.wav   music  music.wav
//
// Usage:
//   node scripts/movie_director.mjs [scenario]                   # full pipeline (resumable, default: movie_director)
//   node scripts/movie_director.mjs [scenario] --stitch          # only re-cut the final from the mains
//   node scripts/movie_director.mjs [scenario] --regen ref|narration|music
//   node scripts/movie_director.mjs [scenario] --regen keyframe|clip <shot>
//
// Emits `[stage] {...}` / `[asset] {...}` lines for the frontend.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  run, download, uploadToInput,
  buildFluxGraph, buildLtxGraph, firstImageUrl, firstVideoUrl,
} from "../lib/comfy.mjs";
import { loadState, nextVersion, resolveMain, setMain, versionsOf } from "../lib/sequence_state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith("-")) || "movie_director";
const cfg = JSON.parse(fs.readFileSync(path.join(here, `../prompts/${scenario}.json`), "utf8"));
const outDir = path.resolve(here, `../outputs/${scenario}`);
fs.mkdirSync(outDir, { recursive: true });

const seq = cfg.sequence;
const N = seq.length;
const TOTAL = cfg.narrationDuration ?? 20;
const FINAL = cfg.finalDuration ?? TOTAL; // cut the final to this many seconds (default: narration length)
const PREFIX = "movie";                    // keyframe / clip file prefix
const REF_PREFIX = scenario;               // reference file prefix (shared with the studio's upload/generate)
const REF_LEAD = cfg.refLead ?? "Take the main subject from the reference image, ";
const withLead = (p) => (/^take .*from .*reference image/i.test(p) ? p : REF_LEAD + p);
const finalName = `${scenario}_final.mp4`;
const finalPath = path.join(outDir, finalName);

const stage = (s, index, label) =>
  console.log(`[stage] ${JSON.stringify({ stage: s, index, total: N, label })}`);
const asset = (kind, file, s, index) =>
  console.log(`[asset] ${JSON.stringify({ kind, file, stage: s, index })}`);

function ff(argv) {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...argv], { stdio: "inherit" });
}

/** LTX t2v at 64x64 -> extract the generated audio as a wav. */
async function audioTrack({ prompt, duration, dest, rawName, prefix, label }) {
  const mp4 = path.join(outDir, rawName);
  const ph = path.join(outDir, "placeholder.png");
  if (!fs.existsSync(ph)) ff(["-f", "lavfi", "-i", "color=0x111111:s=64x64", "-frames:v", "1", ph]);
  const inputName = await uploadToInput(ph, "movie_ph");
  const graph = buildLtxGraph({
    prompt, image: inputName, t2v: true, duration,
    fps: cfg.narrationFps ?? 24,
    size: cfg.narrationSize ?? [64, 64], // exact WxH (bypasses ResolutionSelector's 0.1MP floor)
    prefix,
  });
  const entry = await run(graph, label);
  await download(firstVideoUrl(entry), mp4);
  ff(["-i", mp4, "-vn", "-t", String(duration), "-acodec", "pcm_s16le", "-ar", "44100", dest]);
}

/** Keep the previous take of a single-file asset (narration / music) before re-rolling. */
function retire(file) {
  const p = path.join(outDir, file);
  if (fs.existsSync(p)) fs.renameSync(p, path.join(outDir, `prev_${Date.now()}_${file}`));
}

// ---------------------------------------------------------------- stages
const mainRef = () => resolveMain(outDir, REF_PREFIX, "ref", 0, ".png", null, loadState(outDir));

async function genNarration(force = false) {
  const wav = path.join(outDir, "narration.wav");
  if (force) retire("narration.wav");
  if (fs.existsSync(wav)) console.log(`[movie] voiceover — exists, skipping`);
  else {
    console.log(`[movie] voiceover (t2v, ${TOTAL}s, tiny frame)...`);
    stage("narration", 0, `Voiceover · ${TOTAL}s`);
    await audioTrack({ prompt: cfg.narrationPrompt, duration: TOTAL, dest: wav, rawName: "narration_raw.mp4", prefix: "movie/narration", label: "narration" });
  }
  asset("audio", "narration.wav", "narration");
}

async function genMusic(force = false) {
  if (!cfg.musicPrompt) return;
  const wav = path.join(outDir, "music.wav");
  if (force) retire("music.wav");
  const dur = cfg.musicDuration ?? FINAL;
  if (fs.existsSync(wav)) console.log(`[movie] music — exists, skipping`);
  else {
    console.log(`[movie] music bed (t2v, ${dur}s, tiny frame)...`);
    stage("music", 0, `Music bed · ${dur}s`);
    await audioTrack({ prompt: cfg.musicPrompt, duration: dur, dest: wav, rawName: "music_raw.mp4", prefix: "movie/music", label: "music" });
  }
  asset("audio", "music.wav", "music");
}

// Reference: uploaded image (studio) or generated from cfg.referencePrompt.
// When a ref already exists it conditions the regeneration (same subject).
async function genRef(force = false) {
  if (!cfg.referencePrompt && !mainRef()) return;
  if (!force && versionsOf(outDir, REF_PREFIX, "ref", 0, ".png").length) {
    console.log(`[movie] reference — exists, skipping`);
  } else if (cfg.referencePrompt) {
    const v = nextVersion(outDir, REF_PREFIX, "ref", 0, ".png");
    const file = v === 1 ? `${REF_PREFIX}_ref.png` : `${REF_PREFIX}_ref_v${v}.png`;
    console.log(`[movie] reference key visual (v${v})...`);
    stage("reference", 0, `Reference v${v}`);
    const prev = mainRef();
    const image = prev ? await uploadToInput(path.join(outDir, prev), `${scenario}_refgen`) : null;
    const entry = await run(buildFluxGraph({
      prompt: image ? withLead(cfg.referencePrompt) : cfg.referencePrompt,
      image,
      width: cfg.keyframeWidth ?? 768,
      height: cfg.keyframeHeight ?? 1280,
      prefix: `movie/${scenario}_ref`,
    }), `ref v${v}`);
    await download(firstImageUrl(entry), path.join(outDir, file));
    setMain(outDir, REF_PREFIX, "ref", 0, null, file);
  }
  const f = mainRef();
  if (f) asset("image", f, "reference");
}

// The main reference is uploaded to ComfyUI once per run and reused by every shot.
let refInputPromise = null;
const refInput = () => {
  const f = mainRef();
  if (!f) return null;
  if (!refInputPromise) refInputPromise = uploadToInput(path.join(outDir, f), `${scenario}_ref`);
  return refInputPromise;
};

async function genKeyframe(i, force = false) {
  const n = i + 1, s = seq[i];
  if (!force && versionsOf(outDir, PREFIX, "kf", n, ".png", s.title).length) {
    console.log(`[movie] keyframe ${n}/${N} (${s.title}) — exists, skipping`);
  } else {
    const v = nextVersion(outDir, PREFIX, "kf", n, ".png", s.title);
    const file = v === 1 ? `${PREFIX}_kf${n}_${s.title}.png` : `${PREFIX}_kf${n}_${s.title}_v${v}.png`;
    const image = s.useRef === false ? null : await refInput();
    console.log(`[movie] keyframe ${n}/${N} (${s.title}, v${v})${image ? " (ref-conditioned)" : ""}...`);
    stage("keyframe", n, `Keyframe ${n}/${N} · ${s.title} v${v}`);
    const entry = await run(buildFluxGraph({
      prompt: image ? withLead(s.image) : s.image,
      image,
      width: cfg.keyframeWidth ?? 768,
      height: cfg.keyframeHeight ?? 1280,
      prefix: `movie/kf${n}`,
    }), `kf${n}`);
    await download(firstImageUrl(entry), path.join(outDir, file));
    setMain(outDir, PREFIX, "kf", n, s.title, file);
  }
  asset("image", resolveMain(outDir, PREFIX, "kf", n, ".png", s.title, loadState(outDir)), "keyframe", n);
}

async function genClip(i, force = false) {
  const n = i + 1, s = seq[i];
  if (!force && versionsOf(outDir, PREFIX, "clip", n, ".mp4", s.title).length) {
    console.log(`[movie] clip ${n}/${N} (${s.title}) — exists, skipping`);
  } else {
    const kf = resolveMain(outDir, PREFIX, "kf", n, ".png", s.title, loadState(outDir));
    if (!kf) throw new Error(`no keyframe for shot ${n} (${s.title}) — generate it first`);
    const v = nextVersion(outDir, PREFIX, "clip", n, ".mp4", s.title);
    const file = v === 1 ? `${PREFIX}_clip${n}_${s.title}.mp4` : `${PREFIX}_clip${n}_${s.title}_v${v}.mp4`;
    console.log(`[movie] i2v clip ${n}/${N} (${s.title}, v${v}) from ${kf}...`);
    stage("clip", n, `Clip ${n}/${N} · ${s.title} v${v}`);
    const inputName = await uploadToInput(path.join(outDir, kf), `movie_kf${n}`);
    const entry = await run(buildLtxGraph({
      prompt: s.motion,
      image: inputName,
      duration: s.duration ?? 4,
      ratio: cfg.ratio ?? "9:16 (Portrait Widescreen)",
      megapixels: cfg.megapixels ?? 0.5,
      prefix: `movie/clip${n}_${s.title}`,
    }), `clip${n}`);
    await download(firstVideoUrl(entry), path.join(outDir, file));
    setMain(outDir, PREFIX, "clip", n, s.title, file);
  }
  asset("video", resolveMain(outDir, PREFIX, "clip", n, ".mp4", s.title, loadState(outDir)), "clip", n);
}

function stitch(requireAll = true) {
  const st = loadState(outDir);
  const picks = [];
  for (let i = 0; i < N; i++) {
    const f = resolveMain(outDir, PREFIX, "clip", i + 1, ".mp4", seq[i].title, st);
    if (!f) {
      if (requireAll) throw new Error(`no clip for shot ${i + 1} (${seq[i].title}) — generate it before cutting`);
      console.log(`[movie] final cut skipped — shot ${i + 1} (${seq[i].title}) has no clip yet`);
      return false;
    }
    picks.push(`file '${f}'`);
  }
  if (!fs.existsSync(path.join(outDir, "narration.wav"))) {
    if (requireAll) throw new Error("no voiceover yet — generate it before cutting");
    return false;
  }
  stage("final", 0, "Mixing & cutting final");
  // 1) concat the main clips (same codec/res/fps from one ComfyUI run -> stream copy)
  const concat = path.join(outDir, "clips_concat.mp4");
  const list = path.join(outDir, "concat_list.txt");
  fs.writeFileSync(list, picks.join("\n") + "\n");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", concat]);

  // 2) mix: VO full, shot audio at clipAudioVolume, music at musicVolume with a
  //    tail fade, everything capped at FINAL
  const vol = cfg.clipAudioVolume ?? 0.2;
  const music = fs.existsSync(path.join(outDir, "music.wav")) ? path.join(outDir, "music.wav") : null;
  const fade = Math.min(2, FINAL / 4);
  let filter =
    `[0:a]volume=${vol},apad=whole_dur=${FINAL}[bg];` +
    `[1:a]atrim=0:${FINAL},asetpts=N/SR/TB[narr];`;
  const inputs = ["-i", concat, "-i", path.join(outDir, "narration.wav")];
  if (music) {
    inputs.push("-i", music);
    filter += `[2:a]volume=${cfg.musicVolume ?? 0.35},apad=whole_dur=${FINAL},atrim=0:${FINAL},afade=t=out:st=${(FINAL - fade).toFixed(2)}:d=${fade}[mus];`;
    filter += `[narr][bg][mus]amix=inputs=3:normalize=0,atrim=0:${FINAL},asetpts=N/SR/TB[aout]`;
  } else {
    filter += `[narr][bg]amix=inputs=2:normalize=0,atrim=0:${FINAL},asetpts=N/SR/TB[aout]`;
  }
  ff([...inputs, "-filter_complex", filter,
      "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac",
      "-t", String(FINAL), finalPath]);
  console.log(`[movie] final cut -> ${finalPath}`);
  asset("video", finalName, "final");
  return true;
}

// ---------------------------------------------------------------- main
if (args.includes("--stitch")) {
  stitch();
  process.exit(0);
}

const regenIdx = args.indexOf("--regen");
if (regenIdx >= 0) {
  const kind = args[regenIdx + 1];
  const n = Number(args[regenIdx + 2]) || 0;
  if (kind === "narration") await genNarration(true);
  else if (kind === "music") await genMusic(true);
  else if (kind === "ref") await genRef(true);
  else if ((kind === "keyframe" || kind === "clip") && n >= 1 && n <= N) {
    if (kind === "keyframe") await genKeyframe(n - 1, true);
    else await genClip(n - 1, true);
  } else {
    console.error(`[movie] bad --regen target: ${kind} ${n || ""}`);
    process.exit(1);
  }
  stitch(false);
  console.log("[movie] DONE");
  process.exit(0);
}

// Full run (resumable: anything with a take on disk is skipped).
await genNarration();
await genMusic();
await genRef();
for (let i = 0; i < N; i++) await genKeyframe(i);
for (let i = 0; i < N; i++) await genClip(i);
stitch();
console.log("[movie] DONE");
