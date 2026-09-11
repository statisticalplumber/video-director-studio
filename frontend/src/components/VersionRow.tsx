// Version chips (v1, v2, …) + regenerate button for one versioned asset.
import type { AssetVersion } from "../types";
import { IconCheck, IconRefresh } from "./Icons";

export function VersionRow({ versions, main, kind, onSelect, onRegen, generating, disabled, regenLabel }: {
  versions: AssetVersion[];
  main: string | null | undefined;
  kind: "image" | "video";
  onSelect: (file: string) => void;
  onRegen?: () => void;
  generating?: boolean; // a run is producing the next version right now
  disabled?: boolean;   // a run is active — no new regen
  regenLabel?: string;
}) {
  if (versions.length === 0 && !generating) return null;
  const nextV = versions.length ? versions[versions.length - 1].v + 1 : 1;
  return (
    <div className="versions">
      {versions.map((v) => (
        <button
          key={v.file}
          className={`vchip ${main === v.file ? "on" : ""}`}
          title={main === v.file ? `${v.file} (main — used in the cut)` : `Use ${v.file} as main`}
          onClick={() => onSelect(v.file)}
        >
          {main === v.file && <IconCheck size={10} />}
          v{v.v}
        </button>
      ))}
      {generating && (
        <span className="vchip gen" title={`Rendering v${nextV} — previous takes are kept`}>
          <span className="dot pulse" />
          v{nextV} rendering
        </span>
      )}
      {onRegen && versions.length > 0 && (
        <button
          className="vchip regen"
          disabled={disabled}
          title={`Re-roll this ${kind} — keeps previous takes`}
          onClick={onRegen}
        >
          <IconRefresh size={10} />
          {regenLabel ?? "regen"}
        </button>
      )}
    </div>
  );
}
