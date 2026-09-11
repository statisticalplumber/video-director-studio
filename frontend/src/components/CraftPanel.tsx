import { useState } from "react";
import type { AnyScenario, ScenarioKind } from "../types";
import { craft as craftApi } from "../api";
import { IconSparkles, Spinner } from "./Icons";

interface Props {
  mode: ScenarioKind;
  onCrafted: (name: string, config: AnyScenario) => void;
}

const COPY = {
  sequence: {
    title: "Craft a sequence",
    topic: "e.g. a cyberpunk street medic in Neo-Mumbai",
    reqs: "e.g. neo-noir, rain, 4 beats: arrival, surgery, escape, dawn on the roof",
    hint: "The LLM drafts the character, reference prompt and story beats. Review them in Script, upload the person’s reference image in Outputs, then render.",
  },
  director: {
    title: "Direct a trailer",
    topic: "e.g. the last lighthouse keeper on a drowning coast",
    reqs: "e.g. epic documentary tone, deep male narrator, 5 shots, storm to sunrise, 20s",
    hint: "The LLM writes the voiceover, voice direction and a 5-shot list sized to the narration. Tweak it in Script, then render — VO, keyframes, clips and the final mix.",
  },
};

// High-level topic + requirements -> local LLM crafts a scenario (sequence or
// director trailer). The result opens as an unsaved draft in the Script tab.
export default function CraftPanel({ mode, onCrafted }: Props) {
  const [topic, setTopic] = useState("");
  const [reqs, setReqs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const copy = COPY[mode];

  const craft = async () => {
    setBusy(true);
    setError("");
    setSeconds(0);
    const t0 = Date.now();
    const tick = setInterval(() => setSeconds((Date.now() - t0) / 1000), 500);
    try {
      const d = await craftApi(topic, reqs, mode);
      onCrafted(d.name, d.config);
      setTopic("");
      setReqs("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(tick);
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconSparkles size={15} /></span>
          {copy.title}
        </h2>
        {busy && (
          <span className="pill running">
            <Spinner size={11} />
            {Math.round(seconds)}s
          </span>
        )}
      </div>

      <label>Logline / topic</label>
      <input value={topic} placeholder={copy.topic} onChange={(e) => setTopic(e.target.value)} disabled={busy} />
      <label>Direction — style, mood, beats, length…</label>
      <textarea rows={4} value={reqs} placeholder={copy.reqs} onChange={(e) => setReqs(e.target.value)} disabled={busy} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={craft} disabled={busy || !topic.trim()}>
          {busy ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {busy ? "Writing…" : mode === "director" ? "Direct it" : "Craft sequence"}
        </button>
      </div>
      {error && <p className="hint err-text">{error}</p>}
      <p className="hint">{copy.hint}</p>
    </section>
  );
}
