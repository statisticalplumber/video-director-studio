// Shared character-sequence pipeline (version-aware).
// Both scripts/character_sequence.mjs (LTX) and character_sequence_wan.mjs (Wan)
// are thin wrappers around runSequence() — they only differ in the clip builder.
//
// Versioning: regenerating an asset writes a new _vN file and never overwrites
// old versions. state.json (see lib/sequence_state.mjs) records which version
// is "main" per asset; stitch() always concatenates the selected mains.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  run, download, uploadToInput, firstImageUrl, firstVideoUrl,
} from "./comfy.mjs";
import {
  loadState, nextVersion, resolveMain, setMain, versionsOf,
} from "./sequence_state.mjs";

// The reference-image lead line: the person is taken from the (uploaded /
// generated) reference image, the rest of the prompt is the scene. Used by
// the reference prompt AND every keyframe prompt — identity is carried by
// the ReferenceLatent conditioning, and the lead line tells Flux where the
// person comes from.
export const REF_LEAD = "Take this person from the reference image, ";
export const withRefLead = (p) => {
  const s = String(p || "").trim();
  if (!s) return s;
  return /^take .*from .*reference image/i.test(s) ? s : REF_LEAD + s;
};

/**
 * Run (or resume) the full character sequence.
 * @param {object} o
 *   scenario, outDir, prefix, tag, cfg,
 *   buildRef(prompt)            -> Flux graph for the reference image
 *   buildKeyframe(prompt, i)    -> Flux graph for beat i (1-based)
 *   buildClip(motion, image, i) -> i2v graph for beat i
 *   videoNode                   -> SaveVideo node id (LTX "75", Wan "56")
 *   regen?: { kind: "ref"|"keyframe"|"clip", index: number }  -> generate only this asset
 */
export async function runSequence({
  scenario, outDir, prefix, tag, cfg,
  buildRef, buildKeyframe, buildClip, videoNode, regen,
}) {
  const seq = cfg.sequence;
  const N = seq.length;
  const finalPath = path.join(outDir, `${prefix}_final.mp4`);

  const asset = (kind, file, stage, index) =>
    console.log(`[asset] ${JSON.stringify({ kind, file, stage, index })}`);
  // Structured "now generating" marker — the frontend's pipeline tracker and
  // live monitor label follow these (only emitted when a job is actually queued).
  const stage = (s, index, label) =>
    console.log(`[stage] ${JSON.stringify({ stage: s, index, total: N, label })}`);

  // The main reference image (uploaded or generated) is fed to Flux as the
  // REFERENCE LATENT (identity anchor) for every keyframe, so the
  // character/visuals stay anchored to it. Uploaded once, reused for all beats.
  let refInputPromise = null;
  const refInput = async () => {
    const refFile = resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir));
    if (!refFile) return null;
    if (!refInputPromise) refInputPromise = uploadToInput(path.join(outDir, refFile), `${prefix}_ref`);
    return refInputPromise;
  };

  // force=true (regen) always writes a fresh version; force=false (full run)
  // skips the asset when any version already exists on disk (resume).
  const genRef = async (force = false) => {
    if (!force && versionsOf(outDir, prefix, "ref", 0, ".png").length) {
      console.log(`${tag} reference — already generated, skipping`);
    } else {
      const v = nextVersion(outDir, prefix, "ref", 0, ".png");
      const dest = path.join(outDir, v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`);
      if (fs.existsSync(dest)) {
        console.log(`${tag} reference — v${v} exists, skipping`);
      } else {
        console.log(`${tag} reference image (v${v})...`);
        stage("reference", 0, `Reference v${v}`);
        const entry = await run(buildRef(cfg.referencePrompt));
        await download(firstImageUrl(entry), dest);
      }
    }
    setMain(outDir, prefix, "ref", 0, null, path.basename(resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir))));
    asset("image", path.basename(resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir))), "reference");
  };

  const genKeyframe = async (i, force = false) => {
    const n = i + 1;
    if (!force && versionsOf(outDir, prefix, "seq", n, ".png", seq[i].title).length) {
      console.log(`${tag} keyframe ${n}/${N} (${seq[i].title}) — already generated, skipping`);
    } else {
      const v = nextVersion(outDir, prefix, "seq", n, ".png", seq[i].title);
      const dest = path.join(outDir, v === 1 ? `${prefix}_seq${n}_${seq[i].title}.png` : `${prefix}_seq${n}_${seq[i].title}_v${v}.png`);
      if (fs.existsSync(dest)) {
        console.log(`${tag} keyframe ${n}/${N} — v${v} exists, skipping`);
      } else {
        const refImg = await refInput();
        // Identity comes from the reference latent (ReferenceLatent conditioning);
        // the prompt leads with the ref-lead line ("Take this person from the
        // reference image, ") so Flux knows the person comes from the reference
        // image and the rest of the prompt is the scene.
        console.log(`${tag} keyframe ${n}/${N} (${seq[i].title}, v${v})${refImg ? " (ref-conditioned)" : ""}...`);
        stage("keyframe", n, `Keyframe ${n}/${N} · ${seq[i].title} v${v}`);
        const entry = await run(buildKeyframe(withRefLead(seq[i].image), i, refImg));
        await download(firstImageUrl(entry), dest);
      }
    }
    setMain(outDir, prefix, "seq", n, seq[i].title, path.basename(resolveMain(outDir, prefix, "seq", n, ".png", seq[i].title, loadState(outDir))));
    asset("image", path.basename(resolveMain(outDir, prefix, "seq", n, ".png", seq[i].title, loadState(outDir))), "keyframe", n);
  };

  const genClip = async (i, force = false) => {
    const n = i + 1;
    if (!force && versionsOf(outDir, prefix, "clip", n, ".mp4", seq[i].title).length) {
      console.log(`${tag} clip ${n}/${N} (${seq[i].title}) — already generated, skipping`);
    } else {
      const v = nextVersion(outDir, prefix, "clip", n, ".mp4", seq[i].title);
      const dest = path.join(outDir, v === 1 ? `${prefix}_clip${n}_${seq[i].title}.mp4` : `${prefix}_clip${n}_${seq[i].title}_v${v}.mp4`);
      if (fs.existsSync(dest)) {
        console.log(`${tag} clip ${n}/${N} — v${v} exists, skipping`);
      } else {
        // A clip is always generated from the keyframe currently selected as main.
        const kfFile = resolveMain(outDir, prefix, "seq", n, ".png", seq[i].title, loadState(outDir));
        if (!kfFile) throw new Error(`no keyframe for beat ${n} — generate it first`);
        console.log(`${tag} i2v clip ${n}/${N} (${seq[i].title}, v${v}) from ${kfFile}...`);
        stage("clip", n, `Clip ${n}/${N} · ${seq[i].title} v${v}`);
        const inputName = await uploadToInput(path.join(outDir, kfFile), `${prefix}_kf${n}`);
        const entry = await run(buildClip(seq[i].motion, inputName, i), `clip${n}`);
        await download(firstVideoUrl(entry, videoNode), dest);
      }
    }
    setMain(outDir, prefix, "clip", n, seq[i].title, path.basename(resolveMain(outDir, prefix, "clip", n, ".mp4", seq[i].title, loadState(outDir))));
    asset("video", path.basename(resolveMain(outDir, prefix, "clip", n, ".mp4", seq[i].title, loadState(outDir))), "clip", n);
  };

  const stitch = (requireAll = true) => {
    const st = loadState(outDir);
    const picks = [];
    for (let i = 0; i < seq.length; i++) {
      const file = resolveMain(outDir, prefix, "clip", i + 1, ".mp4", seq[i].title, st);
      if (!file) {
        if (requireAll) throw new Error(`no clip for beat ${i + 1} (${seq[i].title}) — generate it before stitching`);
        console.log(`${tag} final cut skipped — beat ${i + 1} (${seq[i].title}) has no clip yet`);
        return false;
      }
      picks.push(`file '${file}'`);
    }
    stage("final", 0, "Stitching final cut");
    const list = path.join(outDir, "concat_list.txt");
    fs.writeFileSync(list, picks.join("\n") + "\n");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", finalPath], { stdio: "inherit" });
    console.log(`${tag} final cut -> ${finalPath}`);
    return true;
  };

  // --regen: generate a single asset (or its downstream chain) and re-stitch.
  if (regen) {
    const { kind, index } = regen;
    if (kind === "ref") await genRef(true);
    else {
      if (index < 1 || index > N) throw new Error(`beat ${index} out of range (1..${N})`);
      if (kind === "keyframe") await genKeyframe(index - 1, true);
      else if (kind === "clip") await genClip(index - 1, true);
      else throw new Error(`unknown regen kind: ${kind}`);
    }
    if (stitch(false)) asset("video", path.basename(finalPath), "final");
    console.log(`${tag} DONE`);
    return;
  }

  // Full run (resumable: assets that already have a version on disk are
  // skipped, so a re-run only generates what is missing, then stitches).
  await genRef();
  for (let i = 0; i < N; i++) await genKeyframe(i);
  for (let i = 0; i < N; i++) await genClip(i);
  stitch();
  asset("video", path.basename(finalPath), "final");
  console.log(`${tag} DONE`);
}

/** Re-stitch the final cut from the currently selected main versions. */
export function stitchSequence({ scenario, outDir, prefix, tag, cfg }) {
  const seq = cfg.sequence;
  const finalPath = path.join(outDir, `${prefix}_final.mp4`);
  const st = loadState(outDir);
  const list = path.join(outDir, "concat_list.txt");
  const picks = seq.map((s, i) => {
    const file = resolveMain(outDir, prefix, "clip", i + 1, ".mp4", s.title, st);
    if (!file) throw new Error(`no clip for beat ${i + 1} (${s.title}) — generate it before stitching`);
    return `file '${file}'`;
  });
  fs.writeFileSync(list, picks.join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", finalPath], { stdio: "inherit" });
  console.log(`[asset] ${JSON.stringify({ kind: "video", file: path.basename(finalPath), stage: "final" })}`);
  console.log(`${tag} final cut -> ${finalPath}`);
}
