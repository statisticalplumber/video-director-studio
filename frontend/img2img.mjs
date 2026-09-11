// Standalone Flux reference-conditioned generation: uploaded image + prompt
// -> new image. Same graph wiring as reference generation (buildFluxGraph
// with `image` = ReferenceLatent conditioning, sampler starts from the empty
// latent), no scenario needed. Served at POST /api/img2img (see server.mjs route).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFluxGraph, run, download, uploadToInput, firstImageUrl } from "../lib/comfy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../outputs/img2img");

export async function handleImg2Img(req, res, { readJson, json }) {
  const body = await readJson(req);
  const m = String(body.image || "").match(/^data:image\/\w+;base64,(.+)$/s);
  if (!m) return json(res, 400, { error: "image (base64 data URL) required" });
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json(res, 400, { error: "prompt required" });
  const buf = Buffer.from(m[1], "base64");
  if (!buf.length) return json(res, 400, { error: "empty image" });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const src = path.join(OUT_DIR, `src_${Date.now()}.png`);
  fs.writeFileSync(src, buf);
  try {
    const inputName = await uploadToInput(src, "img2img_src");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `img2img_${stamp}.png`;
    const entry = await run(buildFluxGraph({ prompt, image: inputName, prefix: `img2img/${stamp}` }), "img2img");
    await download(firstImageUrl(entry), path.join(OUT_DIR, file));
    return json(res, 200, { file });
  } finally {
    fs.rmSync(src, { force: true });
  }
}
