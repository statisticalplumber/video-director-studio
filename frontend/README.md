# frontend — Sequence Studio (web UI)

React + TypeScript (Vite) studio over the pipeline scripts. A zero-dependency
Node server (`server.mjs`) spawns the runners, streams their logs, relays live
ComfyUI telemetry, and serves `outputs/` for in-browser preview.

## Run

### 1. Requirements

- **Node ≥ 22.5** (uses built-in `node:sqlite` and global `WebSocket`)
- **ffmpeg** on `PATH` (stitching, voiceover mixing)
- A reachable **ComfyUI** with the models from `AGENTS.md`
- Optional: a local OpenAI-compatible LLM (llama-server) for “Write with AI”

### 2. Configure `.env` (project root)

```bash
cp .env.example .env
```

```bash
COMFY_BASE="http://localhost:8188"            # default — set if ComfyUI runs elsewhere
LLM_BASE="http://localhost:8080"              # optional — AI writer
LOGIN_USER="admin"                            # studio login (default admin)
LOGIN_PASS="change-me"                        # studio login (default admin)
PORT=8790                                     # optional — server port
```

### 3. Build and start

```bash
cd frontend
npm install
npm run build
npm run serve
```

Open **http://localhost:8790** and sign in with `LOGIN_USER` / `LOGIN_PASS`.

Re-run `npm run build` after changing anything in `src/`. The server alone
(`node frontend/server.mjs`) serves the last build in `dist/`.

### Dev mode (hot reload, two terminals)

```bash
npm run serve     # API backend on :8790
npm run dev       # vite dev server on :5173 (proxies /api + /outputs to :8790)
```

### Live preview frames

Step progress, speed and ETA work out of the box. To also see the image while
it renders, start ComfyUI with latent previews enabled:

```bash
python main.py --preview-method auto
```

## Using the studio

Pick a workspace in the top bar:

- **Sequence** — one character across N story beats (reference → keyframes → clips → final).
  1. **New sequence** → *Write with AI*: topic + direction → draft opens in **Script**.
  2. Review, **Save**. In **Outputs**, upload/paste the person’s reference image (or generate one).
  3. **Render** (or `Ctrl+Enter`). Pick the clip engine: **LTX 2.5** or **Wan 2.1**.
  4. Pick versions (`v1`, `v2`…) per asset, **regen** any one, then **Stitch final**.
- **Director** — a narrated trailer (`scripts/movie_director.mjs`).
  1. **New trailer** → *Write with AI*: the LLM writes the character sheet, reference prompt, voiceover, voice direction, a music cue and a 5-shot list.
  2. **Reference** (in Dailies): upload/paste the subject’s image, or *Generate* the key visual with Flux from the reference prompt. The main take anchors every shot marked **ref** (Flux reference conditioning) so the subject stays the same; toggle **ref** off per shot for establishing shots.
  3. Tune in **Script**: the VO meter shows if the script fits its length; the **storyboard timeline** shows shots vs VO vs cut; set format (9:16 / 16:9), music and shot-audio levels, shot durations and order.
  4. **Render**: voiceover → music → reference → keyframes → clips → mixed final cut (VO on top, music with a tail fade, shot audio ducked).
  5. In **Dailies**: every keyframe and clip is versioned — pick the **main** take, *re-roll* a frame, *re-animate* its motion, *re-take* the VO or score. The final is re-cut from the main takes automatically. Nothing is deleted.
- **Img2Img** — upload an image + prompt → Flux re-render.

While anything renders, the **Program monitor** shows the live frame, sampler
pass/step, s/it, ETA and total %; the **pipeline strip** marks each stage
pending / rendering / done; files land in the gallery as they finish.

Shortcuts: `Ctrl+Enter` render · `b` toggle the project bin.
Reloading the page re-attaches to a running render. A desktop notification
fires when a render finishes in a background tab.

## API (server.mjs)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/login` · `/api/logout` · `/api/me` | POST / POST / GET | session auth |
| `/api/craft` | POST `{topic, requirements, mode}` | LLM writes a sequence (`mode: "sequence"`) or trailer (`"director"`) |
| `/api/craft-beat` | POST `{config, count}` | LLM appends the next beat(s) |
| `/api/scenarios` | GET | list scenarios + `kind` (`sequence` / `director`) |
| `/api/scenario/:name` | GET / PUT / DELETE | read / save / delete a scenario |
| `/api/runs` | POST `{scenario, stitch?, engine?, regen?}` | spawn a runner (`engine`: `ltx` / `wan` / `director`) |
| `/api/runs` | GET | list runs (status + current stage) |
| `/api/runs/:id/logs` | GET | SSE: log, `asset`, `stage`, `close` events |
| `/api/runs/:id` | DELETE | stop a run |
| `/api/live` | GET | SSE: live ComfyUI job `state` + `preview` frames |
| `/api/outputs?scenario=` | GET | files + versions + selected mains |
| `/api/outputs/select` · `/api/outputs/stitch` | POST | pick main version · re-stitch |
| `/api/generate/ref` · `/api/upload/ref` | POST | Flux reference · upload reference |
| `/api/img2img` | POST | Flux img2img |
| `/api/comfy` | GET | ComfyUI system_stats (GPU/VRAM) + queue |
| `/outputs/<scenario>/<file>` | GET | stream an output asset |

**Live telemetry:** the server keeps one websocket to ComfyUI (`/ws`) and tags
every job it queues with its `client_id` (`COMFY_CLIENT_ID`, read by
`lib/comfy.mjs`), then relays progress + preview frames to browsers over
`/api/live`. Runners print `[stage] {...}` / `[asset] {...}` lines that drive
the pipeline strip and gallery.

## Layout

```
frontend/
├── server.mjs               # backend: API, runs, live relay, static dist/
├── img2img.mjs              # /api/img2img handler
├── src/
│   ├── App.tsx              # top bar, project bin, stage, inspector
│   ├── api.ts · types.ts
│   ├── styles.css           # design system (dark + light)
│   └── components/
│       ├── LiveMonitor.tsx      # program monitor (live frames + progress)
│       ├── RunPanel.tsx         # render transport, pipeline strip, console
│       ├── ScenarioEditor.tsx   # sequence script
│       ├── DirectorEditor.tsx   # director script (VO + shot list)
│       ├── OutputGallery.tsx    # sequence outputs + versions
│       ├── DirectorGallery.tsx  # director dailies: takes, VO, score, reference
│       ├── ReferencePanel.tsx   # upload / paste / generate the reference (shared)
│       ├── VersionRow.tsx       # v1/v2 take chips + re-roll (shared)
│       ├── CraftPanel.tsx       # Write with AI
│       ├── Img2Img.tsx · Login.tsx · Icons.tsx
└── dist/                    # vite build output (served by server.mjs)
```
