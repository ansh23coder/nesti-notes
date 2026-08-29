import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Search, Plus, Star, ChevronRight, ChevronDown, MoreHorizontal, Sun, Moon, Monitor,
  FileText, Trash2, Copy, FolderInput, Link2, MessageSquare, Download, Upload, Settings,
  Clock, Bold, Italic, Underline, Strikethrough, List, ListOrdered, CheckSquare, Quote,
  Code, Table, Minus, Command, X, History, RotateCcw, Archive, ArchiveRestore, Printer,
  Baseline, Highlighter, Image as ImageIcon, Paperclip, Heading1, Heading2, Heading3, ChevronDown,
} from "lucide-react";

/* ---------- helpers ---------- */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => Date.now();
const INDEX_KEY = "nesti:index";
const noteKey = (id) => `nesti:note:${id}`;
const REVISION_GAP_MS = 2 * 60 * 1000; // snapshot at most once per 2 min per note

const emptyNote = (parentId = null, title = "", overrides = {}) => ({
  id: uid(),
  parentId,
  title,
  content: "",
  tags: [],
  isFavorite: false,
  isArchived: false,
  createdAt: now(),
  updatedAt: now(),
  sortOrder: now(),
  revisions: [],
  ...overrides,
});

function htmlToText(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

function extractTags(text) {
  const set = new Set();
  const re = /(^|\s)#([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(text))) set.add(m[2].toLowerCase());
  return Array.from(set);
}

function extractLinks(text) {
  const set = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(text))) set.add(m[1].trim().toLowerCase());
  return Array.from(set);
}

function timeAgo(ts) {
  const s = Math.floor((now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---- HTML -> Markdown (for the read-only "Source" view / export) ---- */
function nodeToMd(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return "";
  const tag = node.tagName.toLowerCase();
  if (tag === "table") return tableToMd(node);
  if (tag === "div" && node.classList.contains("cl")) {
    const textSpan = node.querySelector(".cl-text");
    const txt = textSpan ? Array.from(textSpan.childNodes).map(nodeToMd).join("") : node.textContent;
    return `- [${node.classList.contains("done") ? "x" : " "}] ${txt}\n`;
  }
  if (tag === "div" && node.classList.contains("ed-callout")) {
    return `\n! [${node.textContent.replace(/^💡\s*/, "").trim()}]\n`;
  }
  if (tag === "img") return `\n![${node.getAttribute("alt") || "image"}](${node.getAttribute("src") || ""})\n`;
  if (tag === "a" && node.classList.contains("ed-attachment")) return `\n📎 [${node.textContent.replace(/^📎\s*/, "").trim()}](${node.getAttribute("href") || ""})\n`;
  if (tag === "details") {
    const summary = node.querySelector("summary");
    const body = Array.from(node.children).find((c) => c.tagName !== "SUMMARY");
    const bodyMd = body ? Array.from(body.childNodes).map(nodeToMd).join("") : "";
    const level = node.classList.contains("ed-toggle-h1") ? "# " : node.classList.contains("ed-toggle-h2") ? "## " : node.classList.contains("ed-toggle-h3") ? "### " : "";
    return `\n▸ ${level}${summary ? summary.textContent : "Toggle"}\n${bodyMd}\n`;
  }
  const inner = Array.from(node.childNodes).map(nodeToMd).join("");
  switch (tag) {
    case "b": case "strong": return `**${inner}**`;
    case "i": case "em": return `*${inner}*`;
    case "u": return `__${inner}__`;
    case "s": case "strike": case "del": return `~~${inner}~~`;
    case "code": return `\`${inner}\``;
    case "pre": return `\n\`\`\`\n${node.textContent}\n\`\`\`\n`;
    case "h1": return `\n# ${inner}\n`;
    case "h2": return `\n## ${inner}\n`;
    case "h3": return `\n### ${inner}\n`;
    case "blockquote": return `\n> ${inner}\n`;
    case "hr": return `\n---\n`;
    case "br": return `\n`;
    case "a": return `[${inner}](${node.getAttribute("href") || ""})`;
    case "li": return `${node.parentElement && node.parentElement.tagName === "OL" ? "1." : "-"} ${inner}\n`;
    case "p": case "div": return `${inner}\n\n`;
    default: return inner;
  }
}
function tableToMd(table) {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return "";
  const lines = rows.map((r) => {
    const cells = Array.from(r.children).map((c) => Array.from(c.childNodes).map(nodeToMd).join("").trim() || " ");
    return `| ${cells.join(" | ")} |`;
  });
  lines.splice(1, 0, `| ${Array(rows[0].children.length).fill("---").join(" | ")} |`);
  return `\n${lines.join("\n")}\n`;
}
function htmlToMarkdown(html) {
  if (!html) return "";
  const container = document.createElement("div");
  container.innerHTML = html;
  return Array.from(container.childNodes).map(nodeToMd).join("").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---- fuzzy + substring search ---- */
function fuzzyScore(text, q) {
  text = (text || "").toLowerCase();
  q = q.toLowerCase();
  if (!q) return 0;
  const idx = text.indexOf(q);
  if (idx !== -1) return 100 - idx;
  let ti = 0, score = 0, streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = text.indexOf(q[qi], ti);
    if (found === -1) return null;
    streak = found === ti ? streak + 1 : 1;
    score += streak;
    ti = found + 1;
  }
  return score;
}
function searchNotes(list, q) {
  const query = q.trim().toLowerCase();
  if (!query) return null;
  const results = [];
  for (const n of list) {
    if (n.isArchived) continue;
    const text = htmlToText(n.content);
    const titleScore = fuzzyScore(n.title || "untitled", query);
    const contentIdx = text.toLowerCase().indexOf(query);
    const tagHit = (n.tags || []).some((t) => t.includes(query));
    if (titleScore == null && contentIdx === -1 && !tagHit) continue;
    let snippet = "";
    if (contentIdx !== -1) {
      const start = Math.max(0, contentIdx - 30);
      snippet = (start > 0 ? "…" : "") + text.slice(start, contentIdx + query.length + 40) + "…";
    }
    const score = (titleScore != null ? titleScore * 3 : 0) + (contentIdx !== -1 ? 50 : 0) + (tagHit ? 30 : 0);
    results.push({ note: n, snippet, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

/* ---------- slash command definitions (contentEditable HTML snippets) ---------- */
const TOGGLE_HTML = {
  list: '<details class="ed-toggle" open><summary>Toggle</summary><div>Content goes here</div></details>',
  h1: '<details class="ed-toggle ed-toggle-h1" open><summary>Toggle heading 1</summary><div>Content goes here</div></details>',
  h2: '<details class="ed-toggle ed-toggle-h2" open><summary>Toggle heading 2</summary><div>Content goes here</div></details>',
  h3: '<details class="ed-toggle ed-toggle-h3" open><summary>Toggle heading 3</summary><div>Content goes here</div></details>',
};

const SLASH_COMMANDS = [
  { id: "h1", label: "Heading 1", hint: "#", html: "<h1>Heading 1</h1>" },
  { id: "h2", label: "Heading 2", hint: "##", html: "<h2>Heading 2</h2>" },
  { id: "h3", label: "Heading 3", hint: "###", html: "<h3>Heading 3</h3>" },
  { id: "bullet", label: "Bullet list", hint: "-", html: "<ul><li>List item</li></ul>" },
  { id: "number", label: "Numbered list", hint: "1.", html: "<ol><li>List item</li></ol>" },
  { id: "check", label: "Checklist", hint: "[]", html: '<div class="cl"><span class="cl-box" contenteditable="false"></span><span class="cl-text">To-do item</span></div>' },
  { id: "quote", label: "Quote", hint: ">", html: "<blockquote>Quote</blockquote>" },
  { id: "code", label: "Code block", hint: "```", html: '<pre class="ed-code"><code>code</code></pre>' },
  { id: "table", label: "Table", hint: "|", html: '<table class="ed-table"><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></table>' },
  { id: "callout", label: "Callout", hint: "!", html: '<div class="ed-callout">💡 Note this</div>' },
  { id: "toggle", label: "Toggle list", hint: "▸", html: TOGGLE_HTML.list },
  { id: "toggleh1", label: "Toggle heading 1", hint: "▸#", html: TOGGLE_HTML.h1 },
  { id: "toggleh2", label: "Toggle heading 2", hint: "▸##", html: TOGGLE_HTML.h2 },
  { id: "toggleh3", label: "Toggle heading 3", hint: "▸###", html: TOGGLE_HTML.h3 },
  { id: "divider", label: "Divider", hint: "---", html: "<hr/>" },
  { id: "subnote", label: "Subnote", hint: "→", html: "" },
];

const TEXT_COLORS = [
  { name: "Default", value: null },
  { name: "Gray", value: "#787774" },
  { name: "Brown", value: "#9F6B53" },
  { name: "Orange", value: "#D9730D" },
  { name: "Yellow", value: "#CB912F" },
  { name: "Green", value: "#448361" },
  { name: "Blue", value: "#337EA9" },
  { name: "Purple", value: "#9065B0" },
  { name: "Pink", value: "#C14C8A" },
  { name: "Red", value: "#D44C47" },
];

const HIGHLIGHT_COLORS = [
  { name: "Default", value: "transparent" },
  { name: "Gray", value: "#F1F1EF" },
  { name: "Brown", value: "#F4EEEE" },
  { name: "Orange", value: "#FBECDD" },
  { name: "Yellow", value: "#FBF3DB" },
  { name: "Green", value: "#EDF3EC" },
  { name: "Blue", value: "#E7F3F8" },
  { name: "Purple", value: "#F6F3F9" },
  { name: "Pink", value: "#FAF1F5" },
  { name: "Red", value: "#FDEBEC" },
];

/* ---------- main component ---------- */

export default function Nesti() {
  const [notes, setNotes] = useState(null);
  const [theme, setTheme] = useState("system");
  const [selectedId, setSelectedId] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [sidebarView, setSidebarView] = useState("home"); // home|recent|favorites|tag|archived
  const [activeTag, setActiveTag] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [saveState, setSaveState] = useState("saved");
  const [contextMenu, setContextMenu] = useState(null);
  const [slash, setSlash] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [mode, setMode] = useState("edit"); // edit|source
  const [movePicker, setMovePicker] = useState(null);
  const [linkPicker, setLinkPicker] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [dragState, setDragState] = useState(null); // {draggedId}
  const [dropIndicator, setDropIndicator] = useState(null); // {targetId, position}
  const [syncToken, setSyncToken] = useState(0);
  const [textColorOpen, setTextColorOpen] = useState(false);
  const [bgColorOpen, setBgColorOpen] = useState(false);
  const [toggleMenuOpen, setToggleMenuOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(null); // 'image' | 'file' | null
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaName, setMediaName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInputRef = useRef(null);

  const titleRef = useRef(null);
  const editorRef = useRef(null);
  const saveTimer = useRef(null);
  const loadedRef = useRef(false);
  const savedSnapshotRef = useRef(new Map());
  const savedOrderRef = useRef([]);
  const savedMetaRef = useRef("");

  /* ---- load ---- */
  useEffect(() => {
    (async () => {
      try {
        const idxRes = await window.storage.get(INDEX_KEY).catch(() => null);
        if (idxRes && idxRes.value) {
          const idx = JSON.parse(idxRes.value);
          const ids = idx.order || [];
          const results = await Promise.all(ids.map((id) => window.storage.get(noteKey(id)).catch(() => null)));
          const loaded = results.filter(Boolean).map((r) => JSON.parse(r.value));
          loaded.forEach((n) => savedSnapshotRef.current.set(n.id, JSON.stringify(n)));
          savedOrderRef.current = loaded.map((n) => n.id);
          savedMetaRef.current = idxRes.value;
          setNotes(loaded);
          setTheme(idx.theme || "system");
          setExpanded(idx.expanded || {});
        } else {
          const welcome = emptyNote(null, "Welcome to Nesti", {
            content:
              '<h1>Welcome to Nesti</h1><p>Simple notes. Powerful structure.</p><p>Start typing anywhere — this note autosaves as you go.</p>' +
              '<h2>A few things to try</h2><ul><li>Press <strong>Cmd/Ctrl+K</strong> to open the command palette</li>' +
              '<li>Type <strong>/</strong> on a new line for quick formatting</li>' +
              '<li>Create a subnote to nest ideas underneath this one</li>' +
              "<li>Link to another note with [[double brackets]]</li>" +
              "<li>Tag anything with #ideas</li></ul>" +
              "<h2>Why Nesti</h2><blockquote>Notepad is fast but flat. Notion is powerful but heavy. Nesti nests your notes — simple on the surface, structured underneath.</blockquote>" +
              '<div class="cl"><span class="cl-box" contenteditable="false"></span><span class="cl-text">Create your first subnote</span></div>' +
              '<div class="cl"><span class="cl-box" contenteditable="false"></span><span class="cl-text">Try the command palette</span></div>' +
              '<div class="cl"><span class="cl-box" contenteditable="false"></span><span class="cl-text">Drag this note to reorder it</span></div>',
            isFavorite: true,
            tags: ["welcome"],
          });
          setNotes([welcome]);
          setSelectedId(welcome.id);
          await window.storage.set(noteKey(welcome.id), JSON.stringify(welcome));
          const meta = JSON.stringify({ order: [welcome.id], theme: "system", expanded: {} });
          await window.storage.set(INDEX_KEY, meta);
          savedSnapshotRef.current.set(welcome.id, JSON.stringify(welcome));
          savedOrderRef.current = [welcome.id];
          savedMetaRef.current = meta;
        }
      } catch (e) {
        setNotes([]);
      }
      loadedRef.current = true;
    })();
  }, []);

  /* ---- persist (per-note, only what changed) ---- */
  useEffect(() => {
    if (!loadedRef.current || notes === null) return;
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const writes = [];
        const currentIds = notes.map((n) => n.id);
        for (const n of notes) {
          const serialized = JSON.stringify(n);
          if (savedSnapshotRef.current.get(n.id) !== serialized) {
            writes.push(
              window.storage.set(noteKey(n.id), serialized).then(() => savedSnapshotRef.current.set(n.id, serialized))
            );
          }
        }
        for (const id of savedOrderRef.current) {
          if (!currentIds.includes(id)) {
            writes.push(window.storage.delete(noteKey(id)).catch(() => {}));
            savedSnapshotRef.current.delete(id);
          }
        }
        await Promise.all(writes);
        const metaStr = JSON.stringify({ order: currentIds, theme, expanded });
        if (savedMetaRef.current !== metaStr) {
          await window.storage.set(INDEX_KEY, metaStr);
          savedMetaRef.current = metaStr;
        }
        savedOrderRef.current = currentIds;
        setSaveState("saved");
      } catch (e) {
        setSaveState("saved");
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [notes, theme, expanded]);

  /* ---- theme ---- */
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (!mq) return;
    setSystemDark(mq.matches);
    const l = (e) => setSystemDark(e.matches);
    mq.addEventListener ? mq.addEventListener("change", l) : mq.addListener(l);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", l) : mq.removeListener(l));
  }, []);
  const isDark = theme === "dark" || (theme === "system" && systemDark);

  /* ---- derived ---- */
  const notesById = useMemo(() => {
    const map = {};
    (notes || []).forEach((n) => (map[n.id] = n));
    return map;
  }, [notes]);

  const childrenOf = useCallback(
    (parentId) => (notes || []).filter((n) => n.parentId === parentId && !n.isArchived).sort((a, b) => a.sortOrder - b.sortOrder),
    [notes]
  );

  const selected = selectedId ? notesById[selectedId] : null;

  const allTags = useMemo(() => {
    const map = {};
    (notes || []).forEach((n) => !n.isArchived && (n.tags || []).forEach((t) => (map[t] = (map[t] || 0) + 1)));
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [notes]);

  const breadcrumb = useMemo(() => {
    if (!selected) return [];
    const chain = [];
    let cur = selected;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? notesById[cur.parentId] : null;
    }
    return chain;
  }, [selected, notesById]);

  const backlinks = useMemo(() => {
    if (!selected || !selected.title.trim()) return [];
    const titleLower = selected.title.trim().toLowerCase();
    return (notes || []).filter((n) => n.id !== selected.id && extractLinks(htmlToText(n.content)).includes(titleLower));
  }, [selected, notes]);

  const recentNotes = useMemo(() => (notes || []).filter((n) => !n.isArchived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 15), [notes]);
  const favoriteNotes = useMemo(() => (notes || []).filter((n) => n.isFavorite && !n.isArchived).sort((a, b) => b.updatedAt - a.updatedAt), [notes]);
  const tagNotes = useMemo(() => (activeTag ? (notes || []).filter((n) => (n.tags || []).includes(activeTag) && !n.isArchived) : []), [activeTag, notes]);
  const archivedNotes = useMemo(() => (notes || []).filter((n) => n.isArchived).sort((a, b) => b.updatedAt - a.updatedAt), [notes]);

  /* ---- core mutations ---- */
  const updateNote = useCallback((id, patch) => {
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id !== id) return n;
        let revisions = n.revisions || [];
        if ("content" in patch || "title" in patch) {
          const lastTs = revisions.length ? revisions[revisions.length - 1].ts : 0;
          if (now() - lastTs > REVISION_GAP_MS && (n.content || n.title)) {
            revisions = [...revisions, { ts: now(), title: n.title, content: n.content }].slice(-20);
          }
        }
        return { ...n, ...patch, revisions, updatedAt: now() };
      })
    );
  }, []);

  const createNote = useCallback((parentId = null, title = "Untitled") => {
    const n = emptyNote(parentId, title);
    setNotes((prev) => [...(prev || []), n]);
    setSelectedId(n.id);
    setMode("edit");
    if (parentId) setExpanded((e) => ({ ...e, [parentId]: true }));
    setTimeout(() => titleRef.current?.focus(), 30);
    return n.id;
  }, []);

  const deleteNote = useCallback(
    (id) => {
      const toDelete = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        (notes || []).forEach((n) => {
          if (n.parentId && toDelete.has(n.parentId) && !toDelete.has(n.id)) {
            toDelete.add(n.id);
            grew = true;
          }
        });
      }
      setNotes((prev) => prev.filter((n) => !toDelete.has(n.id)));
      if (toDelete.has(selectedId)) setSelectedId(null);
      showToast("Note deleted");
    },
    [notes, selectedId]
  );

  const duplicateNote = useCallback(
    (id) => {
      const n = notesById[id];
      if (!n) return;
      const copy = emptyNote(n.parentId, n.title + " (copy)", { content: n.content, tags: n.tags });
      setNotes((prev) => [...prev, copy]);
      setSelectedId(copy.id);
      showToast("Note duplicated");
    },
    [notesById]
  );

  const toggleFavorite = useCallback((id) => setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, isFavorite: !n.isFavorite } : n))), []);
  const toggleArchive = useCallback((id) => setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, isArchived: !n.isArchived, updatedAt: now() } : n))), []);
  const moveNote = useCallback((id, newParentId) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, parentId: newParentId, sortOrder: now(), updatedAt: now() } : n)));
    showToast("Note moved");
  }, []);

  const isDescendant = useCallback(
    (ancestorId, candidateId) => {
      let cur = notesById[candidateId];
      while (cur && cur.parentId) {
        if (cur.parentId === ancestorId) return true;
        cur = notesById[cur.parentId];
      }
      return false;
    },
    [notesById]
  );

  function handleDropOnNote(draggedId, targetId, position) {
    if (draggedId === targetId || isDescendant(draggedId, targetId)) return;
    setNotes((prev) => {
      const targetNote = prev.find((n) => n.id === targetId);
      if (!targetNote) return prev;
      let newParentId, newSortOrder;
      if (position === "into") {
        newParentId = targetId;
        const sibs = prev.filter((n) => n.parentId === targetId);
        newSortOrder = sibs.length ? Math.max(...sibs.map((s) => s.sortOrder)) + 1 : now();
        setExpanded((e) => ({ ...e, [targetId]: true }));
      } else {
        newParentId = targetNote.parentId;
        const sibs = prev.filter((n) => n.parentId === newParentId && n.id !== draggedId).sort((a, b) => a.sortOrder - b.sortOrder);
        const idx = sibs.findIndex((s) => s.id === targetId);
        const before = position === "before";
        const prevSib = before ? sibs[idx - 1] : sibs[idx];
        const nextSib = before ? sibs[idx] : sibs[idx + 1];
        const prevOrder = prevSib ? prevSib.sortOrder : (sibs[0] ? sibs[0].sortOrder - 1000 : now() - 1000);
        const nextOrder = nextSib ? nextSib.sortOrder : prevOrder + 1000;
        newSortOrder = (prevOrder + nextOrder) / 2;
      }
      return prev.map((n) => (n.id === draggedId ? { ...n, parentId: newParentId, sortOrder: newSortOrder, updatedAt: now() } : n));
    });
    showToast("Note reorganized");
  }

  function handleDropToRoot(draggedId) {
    setNotes((prev) => prev.map((n) => (n.id === draggedId ? { ...n, parentId: null, sortOrder: now(), updatedAt: now() } : n)));
    showToast("Moved to top level");
  }

  function restoreRevision(rev) {
    updateNote(selected.id, { title: rev.title, content: rev.content });
    setSyncToken((t) => t + 1);
    setHistoryOpen(false);
    showToast("Restored version from " + timeAgo(rev.ts));
  }

  function exportNoteAsPdf() {
    if (!selected) return;
    window.print();
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800);
  }

  /* ---- keyboard shortcuts ---- */
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((p) => !p);
        setPaletteQuery("");
      } else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        createNote(null);
      } else if (mod && e.key.toLowerCase() === "n" && e.shiftKey) {
        e.preventDefault();
        if (selectedId) createNote(selectedId);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        setContextMenu(null);
        setSlash(null);
        setMovePicker(null);
        setLinkPicker(null);
        setHistoryOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createNote, selectedId]);

  useEffect(() => {
    const closeMenu = () => { setContextMenu(null); setTextColorOpen(false); setBgColorOpen(false); setToggleMenuOpen(false); setMediaOpen(null); };
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  /* ---- sync contentEditable DOM only when switching notes / restoring ---- */
  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = selected ? selected.content || "" : "";
  }, [selected?.id, syncToken]);

  /* ---- editor logic ---- */
  function syncFromDom() {
    if (!editorRef.current || !selected) return;
    const html = editorRef.current.innerHTML;
    const text = htmlToText(html);
    updateNote(selected.id, { content: html, tags: extractTags(text) });
  }

  function handleEditorInput(e) {
    const html = e.currentTarget.innerHTML;
    const text = htmlToText(html);
    updateNote(selected.id, { content: html, tags: extractTags(text) });
    detectSlash();
  }

  function detectSlash() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return setSlash(null);
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return setSlash(null);
    const textBefore = node.textContent.slice(0, range.startOffset);
    const m = textBefore.match(/(^|\s)\/(\w*)$/);
    if (m) setSlash({ filter: m[2].toLowerCase(), index: 0, node, triggerLen: m[2].length + 1 });
    else setSlash(null);
  }

  function runSlashCommand(cmd) {
    if (!slash) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const endOffset = sel.getRangeAt(0).startOffset;
    const startOffset = Math.max(0, endOffset - slash.triggerLen);
    const range = document.createRange();
    range.setStart(slash.node, startOffset);
    range.setEnd(slash.node, endOffset);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete");
    if (cmd.id === "subnote") {
      createNote(selected.id, "");
      setSlash(null);
      return;
    }
    document.execCommand("insertHTML", false, cmd.html);
    setSlash(null);
    syncFromDom();
    editorRef.current?.focus();
  }

  const filteredSlashCommands = useMemo(() => (slash ? SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(slash.filter)) : []), [slash]);

  function toolbarCommand(action) {
    editorRef.current?.focus();
    action();
    syncFromDom();
  }
  const cmdBold = () => toolbarCommand(() => document.execCommand("bold"));
  const cmdItalic = () => toolbarCommand(() => document.execCommand("italic"));
  const cmdUnderline = () => toolbarCommand(() => document.execCommand("underline"));
  const cmdStrike = () => toolbarCommand(() => document.execCommand("strikeThrough"));
  const cmdBullet = () => toolbarCommand(() => document.execCommand("insertUnorderedList"));
  const cmdNumber = () => toolbarCommand(() => document.execCommand("insertOrderedList"));
  const cmdQuote = () => toolbarCommand(() => document.execCommand("formatBlock", false, "blockquote"));
  const cmdDivider = () => toolbarCommand(() => document.execCommand("insertHorizontalRule"));
  const cmdCheck = () => toolbarCommand(() => document.execCommand("insertHTML", false, '<div class="cl"><span class="cl-box" contenteditable="false"></span><span class="cl-text">To-do item</span></div>'));
  const cmdCode = () => toolbarCommand(() => {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : "code";
    document.execCommand("insertHTML", false, `<code>${escapeHtml(text)}</code>`);
  });
  const cmdCodeBlock = () => toolbarCommand(() => document.execCommand("insertHTML", false, '<pre class="ed-code"><code>code</code></pre>'));
  const cmdTable = () => toolbarCommand(() => document.execCommand("insertHTML", false, '<table class="ed-table"><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></table>'));
  const cmdCallout = () => toolbarCommand(() => document.execCommand("insertHTML", false, '<div class="ed-callout">💡 Note this</div>'));
  const cmdToggle = () => toolbarCommand(() => document.execCommand("insertHTML", false, TOGGLE_HTML.list));
  const cmdToggleH1 = () => toolbarCommand(() => document.execCommand("insertHTML", false, TOGGLE_HTML.h1));
  const cmdToggleH2 = () => toolbarCommand(() => document.execCommand("insertHTML", false, TOGGLE_HTML.h2));
  const cmdToggleH3 = () => toolbarCommand(() => document.execCommand("insertHTML", false, TOGGLE_HTML.h3));
  const insertLink = (title) => toolbarCommand(() => document.execCommand("insertText", false, `[[${title}]]`));

  function insertImageFromUrl() {
    if (!mediaUrl.trim()) return;
    toolbarCommand(() => document.execCommand("insertHTML", false, `<img src="${escapeHtml(mediaUrl.trim())}" alt="${escapeHtml(mediaName.trim() || "image")}" class="ed-img"/>`));
    setMediaOpen(null);
  }
  function insertFileFromUrl() {
    if (!mediaUrl.trim()) return;
    const name = mediaName.trim() || mediaUrl.trim().split("/").pop() || "file";
    toolbarCommand(() => document.execCommand("insertHTML", false, `<a class="ed-attachment" href="${escapeHtml(mediaUrl.trim())}" target="_blank" rel="noreferrer">📎 ${escapeHtml(name)}</a>`));
    setMediaOpen(null);
  }
  function handleFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (file.type.startsWith("image/")) {
        toolbarCommand(() => document.execCommand("insertHTML", false, `<img src="${dataUrl}" alt="${escapeHtml(file.name)}" class="ed-img"/>`));
      } else {
        toolbarCommand(() => document.execCommand("insertHTML", false, `<a class="ed-attachment" href="${dataUrl}" download="${escapeHtml(file.name)}" target="_blank" rel="noreferrer">📎 ${escapeHtml(file.name)}</a>`));
      }
      setMediaOpen(null);
    };
    reader.readAsDataURL(file);
  }

  function applyTextColor(color) {
    editorRef.current?.focus();
    document.execCommand("styleWithCSS", false, true);
    const finalColor = color || getComputedStyle(editorRef.current).color;
    document.execCommand("foreColor", false, finalColor);
    syncFromDom();
    setTextColorOpen(false);
  }

  function applyHighlight(color) {
    editorRef.current?.focus();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("hiliteColor", false, color);
    syncFromDom();
    setBgColorOpen(false);
  }

  function handleEditorMouseDown(e) {
    const box = e.target.closest && e.target.closest(".cl-box");
    if (box) {
      e.preventDefault();
      box.closest(".cl")?.classList.toggle("done");
      setTimeout(syncFromDom, 0);
    }
  }

  /* ---- palette ---- */
  const paletteActions = useMemo(
    () => [
      { id: "new", label: "Create note", icon: Plus, run: () => createNote(null) },
      { id: "newsub", label: selected ? `Create subnote in "${selected.title || "Untitled"}"` : "Create subnote", icon: Plus, disabled: !selected, run: () => selected && createNote(selected.id) },
      { id: "fav", label: selected ? (selected.isFavorite ? "Remove from favorites" : "Add to favorites") : "Favorite note", icon: Star, disabled: !selected, run: () => selected && toggleFavorite(selected.id) },
      { id: "archive", label: selected ? (selected.isArchived ? "Unarchive note" : "Archive note") : "Archive note", icon: Archive, disabled: !selected, run: () => selected && toggleArchive(selected.id) },
      { id: "history", label: "View version history", icon: History, disabled: !selected, run: () => selected && setHistoryOpen(true) },
      { id: "pdf", label: "Export note as PDF", icon: Printer, disabled: !selected, run: () => exportNoteAsPdf() },
      { id: "dup", label: "Duplicate note", icon: Copy, disabled: !selected, run: () => selected && duplicateNote(selected.id) },
      { id: "move", label: "Move note", icon: FolderInput, disabled: !selected, run: () => selected && setMovePicker(selected.id) },
      { id: "del", label: "Delete note", icon: Trash2, disabled: !selected, run: () => selected && deleteNote(selected.id) },
      { id: "export", label: "Export all notes", icon: Download, run: () => setExportOpen(true) },
      { id: "import", label: "Import notes", icon: Upload, run: () => setImportOpen(true) },
      { id: "theme-light", label: "Switch to light theme", icon: Sun, run: () => setTheme("light") },
      { id: "theme-dark", label: "Switch to dark theme", icon: Moon, run: () => setTheme("dark") },
      { id: "theme-system", label: "Match system theme", icon: Monitor, run: () => setTheme("system") },
    ],
    [selected, createNote, toggleFavorite, toggleArchive, duplicateNote, deleteNote]
  );

  const paletteNoteResults = useMemo(() => {
    if (paletteQuery.trim()) return searchNotes(notes || [], paletteQuery) || [];
    return recentNotes.slice(0, 6).map((n) => ({ note: n, snippet: "" }));
  }, [paletteQuery, notes, recentNotes]);

  const paletteFilteredActions = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    return q ? paletteActions.filter((a) => a.label.toLowerCase().includes(q)) : paletteActions;
  }, [paletteQuery, paletteActions]);

  const linkableNotes = useMemo(() => (notes || []).filter((n) => !n.isArchived), [notes]);
  const exportData = useMemo(() => JSON.stringify({ notes: notes || [], exportedAt: new Date().toISOString() }, null, 2), [notes]);

  function doImport() {
    try {
      const parsed = JSON.parse(importText);
      if (Array.isArray(parsed.notes)) {
        setNotes((prev) => [...(prev || []), ...parsed.notes.map((n) => ({ ...n, id: uid(), revisions: n.revisions || [] }))]);
        showToast("Notes imported");
        setImportOpen(false);
        setImportText("");
      } else showToast("Couldn't find notes in that file");
    } catch (e) {
      showToast("Invalid JSON");
    }
  }

  /* ---- tree ---- */
  function TreeNode({ id, depth }) {
    const n = notesById[id];
    if (!n) return null;
    const kids = childrenOf(id);
    const isOpen = !!expanded[id];
    const isSelected = selectedId === id;
    const isDragging = dragState?.draggedId === id;
    const drop = dropIndicator && dropIndicator.targetId === id ? dropIndicator.position : null;
    return (
      <div>
        <div
          className={"tree-row" + (isSelected ? " active" : "") + (isDragging ? " dragging" : "") + (drop ? " drop-" + drop : "")}
          style={{ paddingLeft: 10 + depth * 16 }}
          draggable
          onClick={() => { setSelectedId(id); setSidebarView("home"); setMode("edit"); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, noteId: id }); }}
          onDragStart={(e) => { e.stopPropagation(); setDragState({ draggedId: id }); e.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { setDragState(null); setDropIndicator(null); }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!dragState || dragState.draggedId === id) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientY - rect.top) / rect.height;
            setDropIndicator({ targetId: id, position: ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "into" });
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dragState && dropIndicator && dropIndicator.targetId === id) handleDropOnNote(dragState.draggedId, id, dropIndicator.position);
            setDragState(null);
            setDropIndicator(null);
          }}
        >
          <span className="twig" onClick={(e) => { e.stopPropagation(); setExpanded((ex) => ({ ...ex, [id]: !isOpen })); }}>
            {kids.length > 0 ? (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="twig-dot" />}
          </span>
          <FileText size={13} className="row-icon" />
          <span className="row-title">{n.title || "Untitled"}</span>
          {n.isFavorite && <Star size={11} className="row-fav" fill="currentColor" />}
          <button className="row-more" onClick={(e) => { e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, noteId: id }); }}>
            <MoreHorizontal size={14} />
          </button>
        </div>
        {isOpen && kids.map((k) => <TreeNode key={k.id} id={k.id} depth={depth + 1} />)}
      </div>
    );
  }

  const rootNotes = childrenOf(null);

  function ContextMenu() {
    if (!contextMenu) return null;
    const n = notesById[contextMenu.noteId];
    if (!n) return null;
    const item = (label, Icon, onClick, danger) => (
      <button className={"ctx-item" + (danger ? " danger" : "")} onClick={() => { onClick(); setContextMenu(null); }}>
        <Icon size={14} /> {label}
      </button>
    );
    return (
      <div className="ctx-menu" style={{ top: contextMenu.y, left: contextMenu.x }} onClick={(e) => e.stopPropagation()}>
        {item("New subnote", Plus, () => createNote(n.id))}
        {item(n.isFavorite ? "Remove favorite" : "Add to favorites", Star, () => toggleFavorite(n.id))}
        {item(n.isArchived ? "Unarchive" : "Archive", Archive, () => toggleArchive(n.id))}
        {item("Duplicate", Copy, () => duplicateNote(n.id))}
        {item("Move to…", FolderInput, () => setMovePicker(n.id))}
        {item("Copy note link", Link2, () => showToast("Link copied: [[" + n.title + "]]"))}
        <div className="ctx-sep" />
        {item("Delete permanently", Trash2, () => deleteNote(n.id), true)}
      </div>
    );
  }

  if (notes === null) return <div className={"nesti-root " + (isDark ? "dark" : "light")}><div className="boot">Opening Nesti…</div><Styles /></div>;

  return (
    <div className={"nesti-root " + (isDark ? "dark" : "light")}>
      <Styles />
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div className="brand-text">
            <div className="brand-name">Nesti</div>
            <div className="brand-tag">Simple notes. Powerful structure.</div>
          </div>
        </div>
        <div className="topbar-search" onClick={() => { setPaletteOpen(true); setPaletteQuery(""); }}>
          <Search size={14} />
          <span>Search or jump to…</span>
          <span className="kbd-hint"><Command size={11} />K</span>
        </div>
        <div className="topbar-right">
          <span className={"save-pill " + saveState}>{saveState === "saving" ? "Saving…" : "Saved"}</span>
          <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(isDark ? "light" : "dark")}>{isDark ? <Moon size={16} /> : <Sun size={16} />}</button>
          <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={16} /></button>
        </div>
      </div>

      <div className="body">
        <div
          className="sidebar"
          onDragOver={(e) => dragState && e.preventDefault()}
          onDrop={(e) => { if (dragState) handleDropToRoot(dragState.draggedId); setDragState(null); setDropIndicator(null); }}
        >
          <div className="sidebar-section">
            <button className="side-link" onClick={() => { setSidebarView("home"); setSelectedId(null); }}><FileText size={14} /> Home</button>
            <button className="side-link" onClick={() => setSidebarView("recent")}><Clock size={14} /> Recent</button>
            <button className="side-link" onClick={() => setSidebarView("favorites")}><Star size={14} /> Favorites</button>
            <button className="side-link" onClick={() => setSidebarView("archived")}><Archive size={14} /> Archived</button>
          </div>

          <div className="sidebar-section grow">
            <div className="sidebar-heading">
              <span>Notes</span>
              <button className="icon-btn tiny" onClick={() => createNote(null)} title="New note (Cmd+N)"><Plus size={14} /></button>
            </div>
            <div className="tree-scroll">
              {rootNotes.length === 0 && <div className="empty-hint">No notes yet — press + to start.</div>}
              {rootNotes.map((n) => <TreeNode key={n.id} id={n.id} depth={0} />)}
            </div>
          </div>

          {allTags.length > 0 && (
            <div className="sidebar-section">
              <div className="sidebar-heading"><span>Tags</span></div>
              <div className="tag-cloud">
                {allTags.map(([tag, count]) => (
                  <button key={tag} className={"tag-chip" + (activeTag === tag && sidebarView === "tag" ? " active" : "")} onClick={() => { setActiveTag(tag); setSidebarView("tag"); }}>
                    #{tag} <span className="tag-count">{count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="main">
          {sidebarView === "home" && selected
            ? EditorView()
            : sidebarView === "recent"
            ? ListView({ title: "Recent", items: recentNotes })
            : sidebarView === "favorites"
            ? ListView({ title: "Favorites", items: favoriteNotes })
            : sidebarView === "tag"
            ? ListView({ title: "#" + activeTag, items: tagNotes })
            : sidebarView === "archived"
            ? ListView({ title: "Archived", items: archivedNotes, variant: "archived" })
            : EmptyHome()}
        </div>
      </div>

      {paletteOpen && (
        <div className="overlay" onClick={() => setPaletteOpen(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <div className="palette-input-row">
              <Search size={15} />
              <input autoFocus placeholder="What do you want to do?" value={paletteQuery} onChange={(e) => setPaletteQuery(e.target.value)} />
            </div>
            <div className="palette-results">
              {paletteNoteResults.length > 0 && (
                <div className="palette-group">
                  <div className="palette-group-label">Notes</div>
                  {paletteNoteResults.map(({ note: n, snippet }) => (
                    <button key={n.id} className="palette-item" onClick={() => { setSelectedId(n.id); setSidebarView("home"); setPaletteOpen(false); }}>
                      <FileText size={14} />
                      <span className="palette-item-text">
                        <span className="palette-item-title">{n.title || "Untitled"}</span>
                        {snippet && <span className="palette-item-snippet">{snippet}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="palette-group">
                <div className="palette-group-label">Actions</div>
                {paletteFilteredActions.map((a) => (
                  <button key={a.id} className="palette-item" disabled={a.disabled} onClick={() => { a.run(); setPaletteOpen(false); }}>
                    <a.icon size={14} /> {a.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {movePicker && (
        <div className="overlay" onClick={() => setMovePicker(null)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <div className="palette-group-label" style={{ padding: "12px 14px 4px" }}>Move to…</div>
            <div className="palette-results">
              <button className="palette-item" onClick={() => { moveNote(movePicker, null); setMovePicker(null); }}><FolderInput size={14} /> Top level</button>
              {(notes || []).filter((n) => n.id !== movePicker && !isDescendant(movePicker, n.id) && !n.isArchived).map((n) => (
                <button key={n.id} className="palette-item" onClick={() => { moveNote(movePicker, n.id); setMovePicker(null); }}><FileText size={14} /> {n.title || "Untitled"}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {linkPicker && (
        <div className="overlay" onClick={() => setLinkPicker(null)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <div className="palette-group-label" style={{ padding: "12px 14px 4px" }}>Link to note</div>
            <div className="palette-results">
              {linkableNotes.map((n) => (
                <button key={n.id} className="palette-item" onClick={() => { insertLink(n.title || "Untitled"); setLinkPicker(null); }}><Link2 size={14} /> {n.title || "Untitled"}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {historyOpen && selected && (
        <div className="overlay" onClick={() => setHistoryOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><span>Version history</span><button className="icon-btn" onClick={() => setHistoryOpen(false)}><X size={16} /></button></div>
            <p className="modal-desc">Snapshots are taken automatically as you edit. Restoring saves your current version too.</p>
            <div className="history-list">
              {(!selected.revisions || selected.revisions.length === 0) && <div className="empty-hint">No earlier versions yet — keep editing and Nesti will start saving snapshots.</div>}
              {[...(selected.revisions || [])].reverse().map((rev, idx) => (
                <div key={idx} className="history-row">
                  <div>
                    <div className="history-title">{rev.title || "Untitled"}</div>
                    <div className="history-time">{timeAgo(rev.ts)}</div>
                  </div>
                  <button className="btn ghost small" onClick={() => restoreRevision(rev)}><RotateCcw size={13} /> Restore</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><span>Settings</span><button className="icon-btn" onClick={() => setSettingsOpen(false)}><X size={16} /></button></div>

            <div className="settings-section">
              <div className="settings-label">Appearance</div>
              <div className="seg wide">
                <button className={"seg-btn" + (theme === "light" ? " active" : "")} onClick={() => setTheme("light")}><Sun size={13} /> Light</button>
                <button className={"seg-btn" + (theme === "dark" ? " active" : "")} onClick={() => setTheme("dark")}><Moon size={13} /> Dark</button>
                <button className={"seg-btn" + (theme === "system" ? " active" : "")} onClick={() => setTheme("system")}><Monitor size={13} /> System</button>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">Your data</div>
              <div className="settings-row-btns">
                <button className="btn ghost small" onClick={() => { setSettingsOpen(false); setExportOpen(true); }}><Download size={13} /> Export all notes</button>
                <button className="btn ghost small" onClick={() => { setSettingsOpen(false); setImportOpen(true); }}><Upload size={13} /> Import notes</button>
              </div>
              <p className="modal-desc" style={{ margin: "8px 0 0" }}>Notes live only on this device, saved note by note as you go.</p>
            </div>

            <div className="settings-section">
              <div className="settings-label">Keyboard shortcuts</div>
              <div className="shortcut-grid">
                <div><span className="kbd">⌘K</span> Command palette</div>
                <div><span className="kbd">⌘N</span> New note</div>
                <div><span className="kbd">⌘⇧N</span> New subnote</div>
                <div><span className="kbd">/</span> Slash commands</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {exportOpen && (
        <div className="overlay" onClick={() => setExportOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><span>Export all notes</span><button className="icon-btn" onClick={() => setExportOpen(false)}><X size={16} /></button></div>
            <p className="modal-desc">Your notes, in full — copy this JSON and store it wherever you like.</p>
            <textarea readOnly className="export-area" value={exportData} onClick={(e) => e.target.select()} />
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setImportOpen(true)}>Import instead</button>
              <button className="btn primary" onClick={() => { navigator.clipboard?.writeText(exportData); showToast("Copied to clipboard"); }}>Copy JSON</button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="overlay" onClick={() => setImportOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><span>Import notes</span><button className="icon-btn" onClick={() => setImportOpen(false)}><X size={16} /></button></div>
            <p className="modal-desc">Paste a Nesti backup JSON below. Imported notes are added alongside your existing ones.</p>
            <textarea className="export-area" placeholder='{"notes": [...]}' value={importText} onChange={(e) => setImportText(e.target.value)} />
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setImportOpen(false)}>Cancel</button>
              <button className="btn primary" onClick={doImport}>Import</button>
            </div>
          </div>
        </div>
      )}

      <ContextMenu />
      {toast && <div className="toast">{toast}</div>}

      {selected && (
        <div className="print-area">
          <h1 className="print-title">{selected.title || "Untitled"}</h1>
          <div className="print-body" dangerouslySetInnerHTML={{ __html: selected.content || "" }} />
        </div>
      )}
    </div>
  );

  /* ---------- sub-views ---------- */

  function EmptyHome() {
    return (
      <div className="empty-home">
        <div className="empty-mark">N</div>
        <h1>Nesti</h1>
        <p>Simple notes. Powerful structure.</p>
        <button className="btn primary" onClick={() => createNote(null)}><Plus size={15} /> New note</button>
        <div className="empty-shortcuts">
          <div><span className="kbd">⌘K</span> Command palette</div>
          <div><span className="kbd">⌘N</span> New note</div>
          <div><span className="kbd">/</span> Slash commands, inside a note</div>
        </div>
      </div>
    );
  }

  function ListView({ title, items, variant }) {
    return (
      <div className="list-view">
        <div className="list-head">{title}</div>
        {items.length === 0 && <div className="empty-hint">Nothing here yet.</div>}
        {items.map((n) => (
          <div key={n.id} className="list-row">
            <button className="list-row-main" onClick={() => { setSelectedId(n.id); setSidebarView("home"); }}>
              <div className="list-row-top">
                <FileText size={14} />
                <span className="list-row-title">{n.title || "Untitled"}</span>
                {n.isFavorite && <Star size={12} fill="currentColor" />}
              </div>
              <div className="list-row-sub">{htmlToText(n.content).slice(0, 90) || "Empty note"} · {timeAgo(n.updatedAt)}</div>
            </button>
            {variant === "archived" && (
              <div className="list-row-actions">
                <button className="icon-btn tiny" title="Restore" onClick={() => toggleArchive(n.id)}><ArchiveRestore size={15} /></button>
                <button className="icon-btn tiny" title="Delete permanently" onClick={() => deleteNote(n.id)}><Trash2 size={15} /></button>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  function EditorView() {
    const kids = childrenOf(selected.id);
    return (
      <div className="editor-wrap">
        <div className="editor-topline">
          <div className="breadcrumbs">
            {breadcrumb.map((b, idx) => (
              <span key={b.id}>{idx > 0 && <span className="crumb-sep">/</span>}<button className="crumb" onClick={() => setSelectedId(b.id)}>{b.title || "Untitled"}</button></span>
            ))}
          </div>
          <div className="editor-actions">
            {selected.isArchived && <span className="archived-pill">Archived</span>}
            <button className="icon-btn tiny" title="Favorite" onClick={() => toggleFavorite(selected.id)}><Star size={15} fill={selected.isFavorite ? "currentColor" : "none"} /></button>
            <button className="icon-btn tiny" title="Version history" onClick={() => setHistoryOpen(true)}><History size={15} /></button>
            <button className="icon-btn tiny" title="Export as PDF" onClick={exportNoteAsPdf}><Printer size={15} /></button>
            <div className="seg">
              <button className={"seg-btn" + (mode === "edit" ? " active" : "")} onClick={() => setMode("edit")}>Edit</button>
              <button className={"seg-btn" + (mode === "source" ? " active" : "")} onClick={() => setMode("source")}>Source</button>
            </div>
            <button className="icon-btn tiny" title="More" onClick={(e) => setContextMenu({ x: e.clientX, y: e.clientY, noteId: selected.id })}><MoreHorizontal size={16} /></button>
          </div>
        </div>

        {mode === "edit" && (
          <div className="toolbar">
            <button className="tbtn" title="Bold (Cmd+B)" onClick={cmdBold}><Bold size={14} /></button>
            <button className="tbtn" title="Italic (Cmd+I)" onClick={cmdItalic}><Italic size={14} /></button>
            <button className="tbtn" title="Underline" onClick={cmdUnderline}><Underline size={14} /></button>
            <button className="tbtn" title="Strikethrough" onClick={cmdStrike}><Strikethrough size={14} /></button>
            <span className="tsep" />
            <button className="tbtn" title="Bullet list" onClick={cmdBullet}><List size={14} /></button>
            <button className="tbtn" title="Numbered list" onClick={cmdNumber}><ListOrdered size={14} /></button>
            <button className="tbtn" title="Checklist" onClick={cmdCheck}><CheckSquare size={14} /></button>
            <button className="tbtn" title="Quote" onClick={cmdQuote}><Quote size={14} /></button>
            <span className="tsep" />
            <button className="tbtn" title="Inline code" onClick={cmdCode}><Code size={14} /></button>
            <button className="tbtn" title="Code block" onClick={cmdCodeBlock}><Code size={14} /></button>
            <button className="tbtn" title="Table" onClick={cmdTable}><Table size={14} /></button>
            <button className="tbtn" title="Divider" onClick={cmdDivider}><Minus size={14} /></button>
            <button className="tbtn" title="Link to note" onClick={() => setLinkPicker(true)}><Link2 size={14} /></button>
            <button className="tbtn" title="Callout" onClick={cmdCallout}><MessageSquare size={14} /></button>
            <div className="tbtn-wrap">
              <button className="tbtn" title="Toggle blocks" onClick={(e) => { e.stopPropagation(); setToggleMenuOpen((o) => !o); }}>
                <ChevronRight size={14} /><ChevronDown size={10} className="tbtn-caret" />
              </button>
              {toggleMenuOpen && (
                <div className="color-dropdown" onClick={(e) => e.stopPropagation()}>
                  <button className="color-swatch" onClick={() => { cmdToggle(); setToggleMenuOpen(false); }}><ChevronRight size={13} /> Toggle list</button>
                  <button className="color-swatch" onClick={() => { cmdToggleH1(); setToggleMenuOpen(false); }}><Heading1 size={13} /> Toggle heading 1</button>
                  <button className="color-swatch" onClick={() => { cmdToggleH2(); setToggleMenuOpen(false); }}><Heading2 size={13} /> Toggle heading 2</button>
                  <button className="color-swatch" onClick={() => { cmdToggleH3(); setToggleMenuOpen(false); }}><Heading3 size={13} /> Toggle heading 3</button>
                </div>
              )}
            </div>
            <span className="tsep" />
            <div className="tbtn-wrap">
              <button className="tbtn" title="Insert image" onClick={(e) => { e.stopPropagation(); setMediaOpen("image"); setMediaUrl(""); setMediaName(""); }}><ImageIcon size={14} /></button>
              {mediaOpen === "image" && (
                <div className="media-dropdown" onClick={(e) => e.stopPropagation()}>
                  <div className="media-label">Insert image</div>
                  <button className="btn ghost small full" onClick={() => fileInputRef.current?.click()}>Upload from device</button>
                  <div className="media-or">or paste a URL</div>
                  <input className="media-input" placeholder="https://…" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
                  <input className="media-input" placeholder="Alt text (optional)" value={mediaName} onChange={(e) => setMediaName(e.target.value)} />
                  <button className="btn primary small full" onClick={insertImageFromUrl}>Insert</button>
                </div>
              )}
            </div>
            <div className="tbtn-wrap">
              <button className="tbtn" title="Attach file / PDF" onClick={(e) => { e.stopPropagation(); setMediaOpen("file"); setMediaUrl(""); setMediaName(""); }}><Paperclip size={14} /></button>
              {mediaOpen === "file" && (
                <div className="media-dropdown" onClick={(e) => e.stopPropagation()}>
                  <div className="media-label">Attach a file or PDF</div>
                  <button className="btn ghost small full" onClick={() => fileInputRef.current?.click()}>Upload from device</button>
                  <div className="media-or">or link a file by URL</div>
                  <input className="media-input" placeholder="https://…/file.pdf" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
                  <input className="media-input" placeholder="Display name (optional)" value={mediaName} onChange={(e) => setMediaName(e.target.value)} />
                  <button className="btn primary small full" onClick={insertFileFromUrl}>Insert</button>
                </div>
              )}
            </div>
            <span className="tsep" />
            <div className="tbtn-wrap">
              <button className="tbtn" title="Text color" onClick={(e) => { e.stopPropagation(); setBgColorOpen(false); setTextColorOpen((o) => !o); }}><Baseline size={14} /></button>
              {textColorOpen && (
                <div className="color-dropdown" onClick={(e) => e.stopPropagation()}>
                  {TEXT_COLORS.map((c) => (
                    <button key={c.name} className="color-swatch" onClick={() => applyTextColor(c.value)}>
                      <span className="swatch-dot" style={{ background: c.value || "currentColor" }} /> {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="tbtn-wrap">
              <button className="tbtn" title="Highlight" onClick={(e) => { e.stopPropagation(); setTextColorOpen(false); setBgColorOpen((o) => !o); }}><Highlighter size={14} /></button>
              {bgColorOpen && (
                <div className="color-dropdown" onClick={(e) => e.stopPropagation()}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button key={c.name} className="color-swatch" onClick={() => applyHighlight(c.value)}>
                      <span className="swatch-dot" style={{ background: c.value }} /> {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={handleFileChosen} />
          </div>
        )}

        <div className="editor-scroll">
          <input ref={titleRef} className="title-input" placeholder="Untitled" value={selected.title} onChange={(e) => updateNote(selected.id, { title: e.target.value })} />

          {mode === "edit" ? (
            <div className="textarea-wrap">
              <div
                ref={editorRef}
                className="content-area"
                contentEditable
                suppressContentEditableWarning
                data-placeholder="Start writing — try / for formatting, [[ for links, # for tags"
                onInput={handleEditorInput}
                onMouseDown={handleEditorMouseDown}
                onKeyDown={(e) => {
                  if (slash) {
                    if (e.key === "ArrowDown") { e.preventDefault(); setSlash((s) => ({ ...s, index: Math.min(s.index + 1, filteredSlashCommands.length - 1) })); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setSlash((s) => ({ ...s, index: Math.max(s.index - 1, 0) })); }
                    else if (e.key === "Enter") { e.preventDefault(); const c = filteredSlashCommands[slash.index]; if (c) runSlashCommand(c); }
                    else if (e.key === "Escape") setSlash(null);
                  }
                }}
              />
              {slash && filteredSlashCommands.length > 0 && (
                <div className="slash-menu">
                  {filteredSlashCommands.map((c, idx) => (
                    <button key={c.id} className={"slash-item" + (idx === slash.index ? " active" : "")} onMouseDown={(e) => { e.preventDefault(); runSlashCommand(c); }}>
                      <span className="slash-hint">{c.hint}</span> {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <pre className="source-area">{htmlToMarkdown(selected.content) || "Nothing to show yet."}</pre>
          )}

          <div className="subnotes-block">
            <div className="subnotes-head"><span>Subnotes</span><button className="icon-btn tiny" onClick={() => createNote(selected.id)}><Plus size={13} /></button></div>
            {kids.length === 0 ? <div className="empty-hint">No subnotes yet.</div> : kids.map((k) => (
              <button key={k.id} className="subnote-row" onClick={() => setSelectedId(k.id)}><ChevronRight size={13} /> {k.title || "Untitled"}</button>
            ))}
          </div>

          {backlinks.length > 0 && (
            <div className="backlinks-block">
              <div className="subnotes-head"><span>Linked from</span></div>
              {backlinks.map((b) => <button key={b.id} className="subnote-row" onClick={() => setSelectedId(b.id)}><Link2 size={12} /> {b.title || "Untitled"}</button>)}
            </div>
          )}

          {selected.tags?.length > 0 && (
            <div className="note-tags">
              {selected.tags.map((t) => <button key={t} className="tag-chip" onClick={() => { setActiveTag(t); setSidebarView("tag"); }}>#{t}</button>)}
            </div>
          )}
        </div>
      </div>
    );
  }
}

/* ---------- styles ---------- */
function Styles() {
  return (
    <style>{`
      .nesti-root {
        --paper: #F6F7F4; --paper-raised: #FFFFFF; --ink: #22261F; --ink-soft: #565B4F; --muted: #8A9080;
        --border: #E1E4DA; --accent: #3F6B52; --accent-soft: #DCE8DF; --accent-contrast: #FFFFFF;
        --danger: #B3483F; --shadow: 0 8px 30px rgba(30,35,25,0.10);
        font-family: -apple-system, "Segoe UI", Inter, system-ui, sans-serif; color: var(--ink); background: var(--paper);
        width: 100%; height: 100vh; min-height: 640px; display: flex; flex-direction: column; overflow: hidden; position: relative;
      }
      .nesti-root.dark {
        --paper: #1B1E19; --paper-raised: #22261F; --ink: #E9ECE4; --ink-soft: #B7BDAC; --muted: #7C8271;
        --border: #323629; --accent: #7FB496; --accent-soft: #2B3B30; --accent-contrast: #14251B; --danger: #E08479; --shadow: 0 8px 30px rgba(0,0,0,0.35);
      }
      .nesti-root * { box-sizing: border-box; }
      .boot { margin: auto; color: var(--muted); font-size: 14px; }
      .topbar { height: 52px; flex-shrink: 0; display: flex; align-items: center; gap: 14px; padding: 0 14px; border-bottom: 1px solid var(--border); background: var(--paper-raised); }
      .brand { display: flex; align-items: center; gap: 9px; min-width: 200px; }
      .brand-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--accent-contrast); display: flex; align-items: center; justify-content: center; font-family: Georgia, "Iowan Old Style", serif; font-weight: 700; font-size: 15px; flex-shrink: 0; }
      .brand-name { font-family: Georgia, "Iowan Old Style", serif; font-size: 15px; font-weight: 700; line-height: 1.1; }
      .brand-tag { font-size: 10.5px; color: var(--muted); line-height: 1.2; }
      .topbar-search { flex: 1; max-width: 460px; margin: 0 auto; display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; color: var(--muted); font-size: 13px; cursor: pointer; background: var(--paper); }
      .topbar-search span:first-of-type { flex: 1; }
      .kbd-hint { display: flex; align-items: center; gap: 2px; font-size: 11px; border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
      .topbar-right { display: flex; align-items: center; gap: 6px; min-width: 200px; justify-content: flex-end; }
      .save-pill { font-size: 11px; color: var(--muted); padding: 3px 9px; border-radius: 20px; border: 1px solid var(--border); }
      .save-pill.saving { color: var(--accent); border-color: var(--accent-soft); }
      .icon-btn { width: 30px; height: 30px; border-radius: 7px; border: none; background: transparent; color: var(--ink-soft); display: flex; align-items: center; justify-content: center; cursor: pointer; }
      .icon-btn:hover { background: var(--accent-soft); color: var(--ink); }
      .icon-btn.tiny { width: 26px; height: 26px; }
      .body { flex: 1; display: flex; min-height: 0; }
      .sidebar { width: 250px; flex-shrink: 0; border-right: 1px solid var(--border); background: var(--paper-raised); display: flex; flex-direction: column; padding: 10px 8px; min-height: 0; }
      .sidebar-section { display: flex; flex-direction: column; margin-bottom: 10px; }
      .sidebar-section.grow { flex: 1; min-height: 0; }
      .side-link { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 7px; border: none; background: transparent; color: var(--ink-soft); font-size: 13px; text-align: left; cursor: pointer; }
      .side-link:hover { background: var(--accent-soft); color: var(--ink); }
      .sidebar-heading { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
      .tree-scroll { flex: 1; overflow-y: auto; min-height: 0; }
      .tree-row { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--ink-soft); position: relative; border-top: 2px solid transparent; border-bottom: 2px solid transparent; }
      .tree-row:hover { background: var(--accent-soft); }
      .tree-row.active { background: var(--accent); color: var(--accent-contrast); }
      .tree-row.active .row-icon, .tree-row.active .row-title { color: var(--accent-contrast); }
      .tree-row.dragging { opacity: 0.4; }
      .tree-row.drop-before { border-top-color: var(--accent); }
      .tree-row.drop-after { border-bottom-color: var(--accent); }
      .tree-row.drop-into { background: var(--accent-soft); outline: 1px dashed var(--accent); }
      .twig { width: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--muted); }
      .twig-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--border); display: inline-block; }
      .row-icon { flex-shrink: 0; opacity: 0.7; }
      .row-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row-fav { color: #C9A227; flex-shrink: 0; }
      .row-more { display: none; border: none; background: transparent; color: inherit; cursor: pointer; padding: 2px; border-radius: 4px; }
      .tree-row:hover .row-more { display: flex; }
      .empty-hint { color: var(--muted); font-size: 12.5px; padding: 8px; }
      .tag-cloud { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 8px; }
      .tag-chip { border: 1px solid var(--border); background: var(--paper); color: var(--ink-soft); font-size: 11.5px; padding: 3px 9px; border-radius: 20px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
      .tag-chip:hover, .tag-chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--ink); }
      .tag-count { color: var(--muted); font-size: 10.5px; }
      .main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
      .empty-home { margin: auto; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 20px; }
      .empty-mark { width: 52px; height: 52px; border-radius: 14px; background: var(--accent); color: var(--accent-contrast); display: flex; align-items: center; justify-content: center; font-family: Georgia, serif; font-size: 26px; font-weight: 700; margin-bottom: 8px; }
      .empty-home h1 { font-family: Georgia, "Iowan Old Style", serif; margin: 0; font-size: 24px; }
      .empty-home p { margin: 0 0 14px; color: var(--muted); font-size: 13.5px; }
      .empty-shortcuts { margin-top: 22px; display: flex; flex-direction: column; gap: 8px; color: var(--muted); font-size: 12.5px; }
      .empty-shortcuts div { display: flex; gap: 8px; align-items: center; justify-content: center; }
      .kbd { border: 1px solid var(--border); border-radius: 5px; padding: 1px 7px; font-size: 11px; background: var(--paper-raised); }
      .list-view { padding: 22px 30px; overflow-y: auto; max-width: 760px; margin: 0 auto; width: 100%; }
      .list-head { font-family: Georgia, serif; font-size: 21px; margin-bottom: 14px; }
      .list-row { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); }
      .list-row-main { display: block; flex: 1; min-width: 0; text-align: left; border: none; background: transparent; padding: 11px 4px; cursor: pointer; color: var(--ink); }
      .list-row-main:hover { background: var(--accent-soft); }
      .list-row-top { display: flex; align-items: center; gap: 7px; font-size: 14px; margin-bottom: 3px; }
      .list-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .list-row-sub { font-size: 12px; color: var(--muted); padding-left: 21px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .list-row-actions { display: flex; gap: 2px; flex-shrink: 0; }
      .editor-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
      .editor-topline { display: flex; align-items: center; justify-content: space-between; padding: 10px 22px; border-bottom: 1px solid var(--border); gap: 10px; }
      .breadcrumbs { font-size: 12.5px; color: var(--muted); display: flex; align-items: center; min-width: 0; overflow: hidden; }
      .crumb { border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 12.5px; padding: 2px 3px; }
      .crumb:hover { color: var(--ink); text-decoration: underline; }
      .crumb-sep { margin: 0 4px; }
      .editor-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .archived-pill { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 20px; padding: 2px 9px; }
      .seg { display: flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
      .seg-btn { border: none; background: transparent; padding: 5px 11px; font-size: 12px; cursor: pointer; color: var(--muted); }
      .seg-btn.active { background: var(--accent); color: var(--accent-contrast); }
      .toolbar { display: flex; align-items: center; gap: 2px; padding: 6px 22px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
      .tbtn { width: 28px; height: 28px; border: none; background: transparent; color: var(--ink-soft); border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .tbtn:hover { background: var(--accent-soft); color: var(--ink); }
      .tsep { width: 1px; height: 18px; background: var(--border); margin: 0 5px; }
      .editor-scroll { flex: 1; overflow-y: auto; padding: 22px 0 60px; }
      .title-input { display: block; width: 100%; max-width: 720px; margin: 0 auto 6px; padding: 0 22px; border: none; background: transparent; font-family: Georgia, "Iowan Old Style", serif; font-size: 30px; font-weight: 700; color: var(--ink); outline: none; }
      .title-input::placeholder { color: var(--muted); }
      .textarea-wrap { position: relative; max-width: 720px; margin: 0 auto; padding: 0 22px; }
      .content-area { width: 100%; min-height: 320px; outline: none; font-size: 15px; line-height: 1.7; color: var(--ink); font-family: inherit; }
      .content-area:empty:before { content: attr(data-placeholder); color: var(--muted); }
      .content-area h1 { font-family: Georgia, serif; font-size: 24px; margin: 18px 0 8px; }
      .content-area h2 { font-family: Georgia, serif; font-size: 20px; margin: 16px 0 6px; }
      .content-area h3 { font-family: Georgia, serif; font-size: 17px; margin: 14px 0 6px; }
      .content-area p { margin: 0 0 8px; }
      .content-area ul, .content-area ol { margin: 4px 0 10px; padding-left: 22px; }
      .content-area blockquote { border-left: 3px solid var(--accent); padding: 2px 0 2px 14px; color: var(--ink-soft); margin: 6px 0; font-style: italic; }
      .content-area hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
      .content-area code { background: var(--accent-soft); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
      .content-area .ed-code { background: var(--paper-raised); border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 13px; margin: 8px 0; }
      .content-area .ed-code code { background: transparent; padding: 0; }
      .content-area .ed-callout { background: var(--accent-soft); border-radius: 8px; padding: 10px 14px; margin: 8px 0; }
      .content-area .ed-toggle { margin: 6px 0; }
      .content-area .ed-toggle > summary { cursor: pointer; font-weight: 600; padding: 3px 0; list-style: none; display: flex; align-items: center; gap: 6px; }
      .content-area .ed-toggle > summary::-webkit-details-marker { display: none; }
      .content-area .ed-toggle > summary:before { content: "▸"; display: inline-block; transition: transform .15s; color: var(--muted); }
      .content-area .ed-toggle[open] > summary:before { transform: rotate(90deg); }
      .content-area .ed-toggle > div { padding: 2px 0 4px 18px; border-left: 2px solid var(--border); margin-left: 4px; }
      .content-area .ed-toggle-h1 > summary { font-family: Georgia, "Iowan Old Style", serif; font-size: 24px; font-weight: 700; }
      .content-area .ed-toggle-h2 > summary { font-family: Georgia, "Iowan Old Style", serif; font-size: 20px; font-weight: 700; }
      .content-area .ed-toggle-h3 > summary { font-family: Georgia, "Iowan Old Style", serif; font-size: 17px; font-weight: 700; }
      .content-area .ed-img { max-width: 100%; border-radius: 8px; margin: 8px 0; display: block; }
      .content-area .ed-attachment { display: inline-flex; align-items: center; gap: 6px; background: var(--paper-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; margin: 6px 0; font-size: 13px; color: var(--ink); text-decoration: none; }
      .content-area .ed-attachment:hover { background: var(--accent-soft); }
      .tbtn-caret { margin-left: -4px; color: var(--muted); }
      .tbtn-wrap { position: relative; display: inline-flex; }
      .color-dropdown { position: absolute; top: 32px; left: 0; background: var(--paper-raised); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 6px; width: 150px; z-index: 40; display: flex; flex-direction: column; gap: 1px; }
      .color-swatch { display: flex; align-items: center; gap: 8px; border: none; background: transparent; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 12.5px; color: var(--ink); text-align: left; }
      .color-swatch:hover { background: var(--accent-soft); }
      .swatch-dot { width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--border); flex-shrink: 0; }
      .media-dropdown { position: absolute; top: 32px; left: 0; background: var(--paper-raised); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 10px; width: 220px; z-index: 40; display: flex; flex-direction: column; gap: 7px; }
      .media-label { font-size: 12px; font-weight: 600; color: var(--ink-soft); }
      .media-or { font-size: 11px; color: var(--muted); text-align: center; }
      .media-input { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12.5px; background: var(--paper); color: var(--ink); outline: none; }
      .btn.full { width: 100%; justify-content: center; }
      .seg.wide { width: 100%; }
      .seg.wide .seg-btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 7px; }
      .settings-section { padding: 14px 0; border-top: 1px solid var(--border); }
      .settings-section:first-of-type { border-top: none; padding-top: 6px; }
      .settings-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 8px; }
      .settings-row-btns { display: flex; gap: 8px; flex-wrap: wrap; }
      .shortcut-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; color: var(--ink-soft); font-size: 12.5px; }
      .shortcut-grid div { display: flex; align-items: center; gap: 8px; }
      .content-area .ed-table { border-collapse: collapse; margin: 8px 0; width: 100%; }
      .content-area .ed-table td { border: 1px solid var(--border); padding: 6px 10px; font-size: 13.5px; }
      .content-area .cl { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 4px; }
      .content-area .cl-box { width: 15px; height: 15px; border: 1px solid var(--border); border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; margin-top: 3px; flex-shrink: 0; cursor: pointer; user-select: none; }
      .content-area .cl.done .cl-box { background: var(--accent); border-color: var(--accent); }
      .content-area .cl.done .cl-box:after { content: "✓"; color: var(--accent-contrast); font-size: 10px; }
      .content-area .cl.done .cl-text { color: var(--muted); text-decoration: line-through; }
      .source-area { max-width: 720px; margin: 0 auto; padding: 0 22px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; font-family: ui-monospace, monospace; color: var(--ink-soft); }
      .subnotes-block, .backlinks-block { max-width: 720px; margin: 20px auto 0; padding: 14px 22px 0; border-top: 1px solid var(--border); }
      .subnotes-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 6px; }
      .subnote-row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: none; background: transparent; padding: 6px 4px; border-radius: 6px; cursor: pointer; font-size: 13.5px; color: var(--ink-soft); }
      .subnote-row:hover { background: var(--accent-soft); color: var(--ink); }
      .note-tags { max-width: 720px; margin: 14px auto 0; padding: 0 22px; display: flex; gap: 6px; flex-wrap: wrap; }
      .slash-menu { position: absolute; left: 22px; top: 30px; background: var(--paper-raised); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); width: 240px; padding: 6px; z-index: 30; max-height: 280px; overflow-y: auto; }
      .slash-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; border: none; background: transparent; padding: 7px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--ink); }
      .slash-item.active, .slash-item:hover { background: var(--accent-soft); }
      .slash-hint { color: var(--muted); font-size: 11px; width: 28px; flex-shrink: 0; font-family: monospace; }
      .overlay { position: absolute; inset: 0; background: rgba(20,22,17,0.35); display: flex; align-items: flex-start; justify-content: center; padding-top: 90px; z-index: 50; }
      .palette { width: 560px; max-width: 90%; max-height: 60vh; background: var(--paper-raised); border-radius: 12px; box-shadow: var(--shadow); border: 1px solid var(--border); overflow: hidden; display: flex; flex-direction: column; }
      .palette-input-row { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); color: var(--muted); }
      .palette-input-row input { flex: 1; border: none; outline: none; background: transparent; font-size: 14.5px; color: var(--ink); }
      .palette-results { overflow-y: auto; padding: 6px; }
      .palette-group-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 8px 10px 4px; }
      .palette-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; border: none; background: transparent; padding: 9px 10px; border-radius: 7px; cursor: pointer; font-size: 13.5px; color: var(--ink); }
      .palette-item:hover:not(:disabled) { background: var(--accent-soft); }
      .palette-item:disabled { opacity: 0.4; cursor: default; }
      .palette-item-text { display: flex; flex-direction: column; min-width: 0; }
      .palette-item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .palette-item-snippet { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .modal { width: 560px; max-width: 90%; background: var(--paper-raised); border-radius: 12px; box-shadow: var(--shadow); border: 1px solid var(--border); padding: 18px 20px; max-height: 74vh; display: flex; flex-direction: column; }
      .modal-head { display: flex; align-items: center; justify-content: space-between; font-size: 15px; font-weight: 600; margin-bottom: 6px; }
      .modal-desc { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
      .export-area { width: 100%; height: 220px; border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-family: monospace; font-size: 12px; background: var(--paper); color: var(--ink); resize: vertical; }
      .modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .btn { border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--ink); display: inline-flex; align-items: center; gap: 6px; }
      .btn.primary { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
      .btn.ghost { background: transparent; }
      .btn.small { padding: 5px 10px; font-size: 12px; }
      .history-list { overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .history-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 6px; border-bottom: 1px solid var(--border); }
      .history-title { font-size: 13.5px; }
      .history-time { font-size: 11.5px; color: var(--muted); }
      .ctx-menu { position: fixed; background: var(--paper-raised); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 6px; width: 200px; z-index: 60; }
      .ctx-item { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; border: none; background: transparent; padding: 8px 9px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--ink); }
      .ctx-item:hover { background: var(--accent-soft); }
      .ctx-item.danger { color: var(--danger); }
      .ctx-sep { height: 1px; background: var(--border); margin: 5px 0; }
      .toast { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--paper); padding: 8px 16px; border-radius: 20px; font-size: 12.5px; box-shadow: var(--shadow); z-index: 80; }
      .nesti-root.dark .toast { background: var(--paper-raised); border: 1px solid var(--border); color: var(--ink); }

      .print-area { display: none; }
      @media print {
        body * { visibility: hidden; }
        .nesti-root, .nesti-root * { background: transparent !important; box-shadow: none !important; }
        .print-area, .print-area * { visibility: visible; }
        .print-area {
          display: block; position: absolute; top: 0; left: 0; width: 100%;
          padding: 20px 4px; color: #111; font-family: -apple-system, "Segoe UI", sans-serif;
        }
        .print-title { font-family: Georgia, serif; font-size: 26px; margin: 0 0 14px; }
        .print-body { font-size: 13px; line-height: 1.6; }
        .print-body h1 { font-family: Georgia, serif; font-size: 20px; margin: 16px 0 8px; }
        .print-body h2 { font-family: Georgia, serif; font-size: 17px; margin: 14px 0 6px; }
        .print-body h3 { font-family: Georgia, serif; font-size: 15px; margin: 12px 0 6px; }
        .print-body blockquote { border-left: 3px solid #999; padding-left: 12px; color: #444; font-style: italic; margin: 8px 0; }
        .print-body pre { background: #f3f3f0; border: 1px solid #ddd; border-radius: 6px; padding: 10px; font-size: 11.5px; overflow-x: auto; }
        .print-body code { background: #f0f0ec; padding: 1px 4px; border-radius: 3px; }
        .print-body table { border-collapse: collapse; width: 100%; margin: 8px 0; }
        .print-body td, .print-body th { border: 1px solid #ccc; padding: 5px 8px; font-size: 12px; }
        .print-body .cl { display: flex; gap: 6px; margin-bottom: 3px; }
        .print-body .cl-box { width: 12px; height: 12px; border: 1px solid #888; border-radius: 3px; margin-top: 2px; flex-shrink: 0; }
        .print-body .cl.done .cl-box { background: #888; }
        .print-body .cl.done .cl-text { text-decoration: line-through; color: #777; }
        .print-body .ed-callout { background: #f3f3f0; border-radius: 6px; padding: 8px 12px; margin: 6px 0; }
        .print-body details { margin: 6px 0; }
        .print-body summary { font-weight: 600; list-style: none; }
        .print-body summary::-webkit-details-marker { display: none; }
        .print-body details > div { padding-left: 16px; border-left: 2px solid #ddd; margin-left: 2px; }
        .print-body details > *:not(summary) { display: block !important; }
        .print-body .ed-toggle-h1 > summary { font-size: 20px; font-weight: 700; font-family: Georgia, serif; }
        .print-body .ed-toggle-h2 > summary { font-size: 17px; font-weight: 700; font-family: Georgia, serif; }
        .print-body .ed-toggle-h3 > summary { font-size: 15px; font-weight: 700; font-family: Georgia, serif; }
        .print-body img { max-width: 100%; border-radius: 4px; margin: 8px 0; }
        .print-body .ed-attachment { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #ccc; border-radius: 6px; padding: 4px 10px; font-size: 12px; text-decoration: none; color: #111; }
        @page { margin: 18mm; }
      }
    `}</style>
  );
}
