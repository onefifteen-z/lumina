import React, { useCallback, useEffect, useState } from "react";
import { Tag } from "lucide-react";
import type { FrontmatterData } from "../../shared/types";

type DateParts = {
  y: number | "";
  m: number | "";
  d: number | "";
};

function isoToParts(iso: string): DateParts {
  if (!iso?.trim()) return { y: "", m: "", d: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { y: "", m: "", d: "" };
  return {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
  };
}

/** Local calendar date at noon → ISO (avoids midnight timezone shifting the day). */
function partsToIso(p: DateParts): string {
  if (p.y === "" || p.m === "" || p.d === "") return "";
  const y = Number(p.y);
  const m = Number(p.m);
  const day = Number(p.d);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) {
    return "";
  }
  if (m < 1 || m > 12 || day < 1 || day > 31) return "";
  return new Date(y, m - 1, day, 12, 0, 0, 0).toISOString();
}

function DatePartsEditor({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: string;
  onChange: (iso: string) => void;
}) {
  const [local, setLocal] = useState<DateParts>(() => isoToParts(value));

  useEffect(() => {
    setLocal(isoToParts(value));
  }, [value]);

  const patch = useCallback(
    (partial: Partial<DateParts>) => {
      setLocal((prev) => {
        const next = { ...prev, ...partial };
        onChange(partsToIso(next));
        return next;
      });
    },
    [onChange],
  );

  return (
    <div className="article-live-editor__date-inline" role="group">
      <input
        id={`${idPrefix}-y`}
        type="number"
        className="article-live-editor__date-inline-field article-live-editor__date-inline-year"
        inputMode="numeric"
        min={1970}
        max={2100}
        aria-label="Year"
        value={local.y === "" ? "" : local.y}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") patch({ y: "" });
          else {
            const y = parseInt(raw, 10);
            if (Number.isFinite(y)) patch({ y });
          }
        }}
      />
      <span className="article-live-editor__date-inline-sep" aria-hidden>
        /
      </span>
      <input
        id={`${idPrefix}-m`}
        type="number"
        className="article-live-editor__date-inline-field article-live-editor__date-inline-month"
        inputMode="numeric"
        min={1}
        max={12}
        aria-label="Month"
        value={local.m === "" ? "" : local.m}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") patch({ m: "" });
          else {
            const m = parseInt(raw, 10);
            if (Number.isFinite(m)) patch({ m });
          }
        }}
      />
      <span className="article-live-editor__date-inline-sep" aria-hidden>
        /
      </span>
      <input
        id={`${idPrefix}-d`}
        type="number"
        className="article-live-editor__date-inline-field article-live-editor__date-inline-day"
        inputMode="numeric"
        min={1}
        max={31}
        aria-label="Day"
        value={local.d === "" ? "" : local.d}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") patch({ d: "" });
          else {
            const d = parseInt(raw, 10);
            if (Number.isFinite(d)) patch({ d });
          }
        }}
      />
    </div>
  );
}

export const FM_SNAPSHOT_SKIP = new Set([
  "title",
  "tags",
  "created",
  "modified",
  /** Legacy YAML key; merged into `modified` on parse — hide to avoid duplicate "updated" row */
  "updated",
  "_corrupted",
]);

export function cloneFrontmatter(fm: FrontmatterData): FrontmatterData {
  return JSON.parse(JSON.stringify(fm)) as FrontmatterData;
}

export interface ArticleFrontmatterFieldsProps {
  draftFm: FrontmatterData;
  onPatch: (mutate: (prev: FrontmatterData) => FrontmatterData) => void;
}

function TagsFieldEditor({
  tags,
  onPatch,
}: {
  tags: string[];
  onPatch: ArticleFrontmatterFieldsProps["onPatch"];
}) {
  const [draft, setDraft] = useState("");
  const list = tags ?? [];

  const addTag = useCallback(
    (raw: string) => {
      const t = raw.trim();
      if (!t) return;
      onPatch((p) => {
        const cur = p.tags ?? [];
        if (cur.includes(t)) return p;
        return { ...p, tags: [...cur, t] };
      });
      setDraft("");
    },
    [onPatch],
  );

  const removeTag = useCallback(
    (tag: string) => {
      onPatch((p) => ({
        ...p,
        tags: (p.tags ?? []).filter((x) => x !== tag),
      }));
    },
    [onPatch],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag(draft);
      return;
    }
    if (e.key === ",") {
      e.preventDefault();
      addTag(draft);
      return;
    }
    if (e.key === "Backspace" && draft === "" && list.length > 0) {
      e.preventDefault();
      removeTag(list[list.length - 1]!);
    }
  };

  return (
    <div className="article-live-editor__prop-row article-live-editor__prop-row--tags">
      <label htmlFor="live-fm-tags-input" className="article-live-editor__tags-label">
        <Tag size={14} className="article-live-editor__tags-label-icon" strokeWidth={2} aria-hidden />
        <span>tags</span>
      </label>
      <div className="article-live-editor__tags-editor">
        <div className="article-live-editor__tags-input-shell">
          <div className="article-live-editor__tags-chips">
          {list.map((tag) => (
            <span key={tag} className="article-live-editor__tag-chip">
              <span className="article-live-editor__tag-chip-text">{tag}</span>
              <button
                type="button"
                className="article-live-editor__tag-chip-remove"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => removeTag(tag)}
                aria-label={`Remove tag ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            id="live-fm-tags-input"
            type="text"
            className="article-live-editor__tag-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => addTag(draft)}
            placeholder={list.length === 0 ? "Add tags…" : "Add…"}
            autoComplete="off"
            aria-label="Add a tag"
          />
          </div>
        </div>
      </div>
    </div>
  );
}

function StringArrayFieldEditor({
  fieldKey,
  values,
  onPatch,
}: {
  fieldKey: string;
  values: unknown[];
  onPatch: ArticleFrontmatterFieldsProps["onPatch"];
}) {
  const list = (values as string[]).map(String);
  const [emptyDraft, setEmptyDraft] = useState("");

  useEffect(() => {
    if (list.length === 0) setEmptyDraft("");
  }, [list.length]);

  const setList = (next: string[]) => {
    onPatch((p) => ({ ...p, [fieldKey]: next }));
  };

  const updateRow = (i: number, val: string) => {
    const next = [...list];
    next[i] = val;
    setList(next);
  };

  const removeRow = (i: number) => {
    setList(list.filter((_, j) => j !== i));
  };

  const addRow = () => {
    setList([...list, ""]);
  };

  return (
    <div className="article-live-editor__prop-row article-live-editor__prop-row--string-array">
      <label htmlFor={`live-fm-arr-${fieldKey}-0`}>{fieldKey}</label>
      <div className="article-live-editor__string-array-stack">
        {list.length === 0 ? (
          <div className="article-live-editor__string-array-row">
            <input
              type="text"
              className="article-live-editor__string-array-input"
              id={`live-fm-arr-${fieldKey}-0`}
              value={emptyDraft}
              placeholder="Add an entry…"
              autoComplete="off"
              onChange={(e) => {
                const v = e.target.value;
                setEmptyDraft(v);
                if (v.trim()) {
                  setList([v]);
                  setEmptyDraft("");
                }
              }}
            />
          </div>
        ) : (
          list.map((line, i) => (
            <div key={i} className="article-live-editor__string-array-row">
              <input
                type="text"
                className="article-live-editor__string-array-input"
                id={`live-fm-arr-${fieldKey}-${i}`}
                value={line}
                onChange={(e) => updateRow(i, e.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                className="article-live-editor__string-array-remove"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => removeRow(i)}
                aria-label={`Remove ${fieldKey} row ${i + 1}`}
              >
                ×
              </button>
            </div>
          ))
        )}
        {list.length > 0 && (
          <button type="button" className="article-live-editor__string-array-add" onClick={addRow}>
            + Add line
          </button>
        )}
      </div>
    </div>
  );
}

/** Shared YAML frontmatter fields for live markdown editing (browser + editor). */
export const ArticleFrontmatterFields: React.FC<ArticleFrontmatterFieldsProps> = ({
  draftFm,
  onPatch,
}) => (
  <>
    <div className="article-live-editor__prop-row">
      <label htmlFor="live-fm-title">title</label>
      <input
        id="live-fm-title"
        type="text"
        value={draftFm.title ?? ""}
        onChange={(e) => onPatch((p) => ({ ...p, title: e.target.value }))}
        placeholder="Article title"
        autoComplete="off"
      />
    </div>
    <div className="article-live-editor__prop-row article-live-editor__prop-row--date">
      <span className="article-live-editor__prop-row-heading">created</span>
      <DatePartsEditor
        idPrefix="live-fm-created"
        value={draftFm.created ?? ""}
        onChange={(iso) => onPatch((p) => ({ ...p, created: iso }))}
      />
    </div>
    <div className="article-live-editor__prop-row article-live-editor__prop-row--date">
      <span className="article-live-editor__prop-row-heading">updated</span>
      <DatePartsEditor
        idPrefix="live-fm-modified"
        value={draftFm.modified ?? ""}
        onChange={(iso) => onPatch((p) => ({ ...p, modified: iso }))}
      />
    </div>
    {Object.entries(draftFm)
      .filter(([k, v]) => !FM_SNAPSHOT_SKIP.has(k) && typeof v === "string")
      .map(([k, v]) => (
        <div key={k} className="article-live-editor__prop-row">
          <label htmlFor={`live-fm-${k}`}>{k}</label>
          <input
            id={`live-fm-${k}`}
            type="text"
            value={v as string}
            onChange={(e) => {
              const val = e.target.value;
              onPatch((p) => ({ ...p, [k]: val }));
            }}
            autoComplete="off"
          />
        </div>
      ))}
    {Object.entries(draftFm)
      .filter(([k, v]) => !FM_SNAPSHOT_SKIP.has(k) && Array.isArray(v))
      .map(([k, v]) => (
        <StringArrayFieldEditor key={k} fieldKey={k} values={v as unknown[]} onPatch={onPatch} />
      ))}
    <TagsFieldEditor tags={draftFm.tags ?? []} onPatch={onPatch} />
  </>
);
