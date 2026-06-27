/**
 * Llama | Prompt Generator (merged) — full DOM/CSS UI for the PromptGeneratorPro node.
 *
 * Merges the old "Prompt Generator" and "Prompt Generator Options" nodes into a
 * single node with a top toggle that swaps between two views:
 *   - "Generator"  : mode, prompt, output toggles, force-kill button.
 *   - "Options"    : model, mmproj, system prompt, sampling params, launch args.
 *
 * Every setting is mirrored into one hidden serialized STRING widget ("config")
 * as a JSON blob, so ComfyUI persists the whole UI state in the workflow file —
 * settings survive node reloads, refreshes and save/load.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PM_UI_PALETTE } from "./ui_palette.js";

const PG_PRO_VERSION = "1.5.0";
console.log(`[PromptGeneratorPro] UI loaded (${PG_PRO_VERSION})`);

// Live token-stream from the backend → route to the originating node's output box.
api.addEventListener("pg-stream", (e) => {
    const d = e?.detail; if (!d) return;
    const g = app.graph; if (!g) return;
    const node = (g.getNodeById && g.getNodeById(Number(d.node))) || g._nodes_by_id?.[d.node];
    node?._pgSetStreaming?.(d.text, d.done);
    // Tokens flowing → this node is generating; done → it finished.
    node?._pgSetRunning?.(!d.done);
});

// Track which PromptGeneratorPro node is actively generating so the Stop control can
// switch between "Stop Prompt" (running) and "Nothing running" (idle).
function _pgEachProNode(fn) {
    const g = app.graph; if (!g) return;
    for (const n of (g._nodes || [])) {
        if (n?.comfyClass === "PromptGeneratorPro" || n?.type === "PromptGeneratorPro") fn(n);
    }
}
// Mark each PromptGeneratorPro node running/idle as ComfyUI executes nodes (drives the in-node
// running indicator). `detail` is the executing node id, or null when the run ends.
api.addEventListener("executing", (e) => {
    const raw = e?.detail;
    const id = (raw && typeof raw === "object") ? raw.node : raw;
    _pgEachProNode((n) => n._pgSetRunning?.(id != null && String(n.id) === String(id)));
});
// On finish/interrupt/error, nothing is running anymore.
for (const evt of ["execution_success", "execution_interrupted", "execution_error"]) {
    api.addEventListener(evt, () => { _pgEachProNode((n) => n._pgSetRunning?.(false)); });
}

// ── Relate a workflow's SAVED output image to the prompt that produced it ──
// ComfyUI broadcasts every node's outputs over the "executed" event. Save/Preview Image
// nodes emit { images: [{filename, subfolder, type}] } — REAL files /view can serve from
// the user's (arbitrary) output dir. We remember which Prompt-Generator nodes ran in a
// given prompt, then when a saved image arrives for that same prompt we attach its actual
// disk location to that node's just-recorded prompt entry. No duplicate thumbnails — the
// library shows the real file, scaled down in the browser.
const _pgRunsByPrompt = new Map();   // prompt_id -> Set(node id) of PG nodes that ran
// Attach a workflow's SAVED output image to the PG node(s) that ran in the same prompt — ORDER-INDEPENDENT.
// An UNLINKED PG node (it's an OUTPUT_NODE so it always runs) can execute AFTER the Save node, so we buffer
// the saved image per prompt and attach at run END (when every node has run + recorded its prompt). NOTE:
// only the IMAGE is captured — NO model/sampler/steps "recipe", because that can't be read reliably across
// arbitrary custom loader/sampler nodes, and a wrong recipe would mislead anyone trying to recreate a setup.
const _pgImgByPrompt = new Map();   // prompt_id -> image meta {name, subfolder, type}
function _pgFlushRun(pid) {
    const set = _pgRunsByPrompt.get(pid), meta = _pgImgByPrompt.get(pid);
    if (!set || !set.size || !meta) return;
    const g = app.graph; if (!g) return;
    for (const nid of set) {
        const node = (g.getNodeById && g.getNodeById(Number(nid))) || g._nodes_by_id?.[nid];
        node?._pgAttachRunImage?.(meta);
    }
}
api.addEventListener("executed", (e) => {
    const d = e?.detail; if (!d) return;
    const pid = d.prompt_id ?? "_";   // fall back to a single per-run bucket on older builds
    const out = d.output || {};
    // A PG node ran (normal run emits pg_output; a one-click image render emits pg_ran) → register it.
    if (out.pg_output || out.pg_ran) {
        let set = _pgRunsByPrompt.get(pid);
        if (!set) { set = new Set(); _pgRunsByPrompt.set(pid, set); }
        set.add(String(d.display_node ?? d.node));
    }
    // A Save/Preview Image node reported files → buffer the latest saved image for this prompt.
    const imgs = Array.isArray(out.images) ? out.images.filter((im) => im && im.filename) : [];
    if (imgs.length) {
        const im = imgs[imgs.length - 1];
        _pgImgByPrompt.set(pid, { name: im.filename, subfolder: im.subfolder || "", type: im.type || "output" });
    }
});
// At run END (every node executed + each PG node's onExecuted already recorded its prompt) attach ONCE —
// this is what makes it order-independent — then drop the per-prompt buffers shortly after.
for (const evt of ["execution_success", "execution_interrupted", "execution_error"]) {
    api.addEventListener(evt, (e) => {
        const pid = e?.detail?.prompt_id ?? "_";
        _pgFlushRun(pid);
        setTimeout(() => { _pgRunsByPrompt.delete(pid); _pgImgByPrompt.delete(pid); }, 2000);
    });
}

// Ctrl/⌘+V an image straight into a selected Llama Prompt Generator node.
document.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items; if (!items) return;
    let file = null;
    for (const it of items) { if (it.kind === "file" && String(it.type).startsWith("image/")) { file = it.getAsFile(); break; } }
    if (!file) return;
    const sel = app.canvas?.selected_nodes ? Object.values(app.canvas.selected_nodes) : [];
    const target = sel.find((n) => (n?.type === "PromptGeneratorPro" || n?.comfyClass === "PromptGeneratorPro") && n?._pgLoadImageFile);
    if (!target) return;
    e.preventDefault(); e.stopPropagation();
    target._pgLoadImageFile(file);
});

const P = PM_UI_PALETTE || {};
// Minimal dark-mode palette: near-black surfaces, silver text, one restrained blue accent.
// Solid fills only (no gradients on buttons), no blurred shadows or glows. These override
// the shared PM palette so the node has a clean, modern look regardless of theme.
const C = {
    // Surface tokens route through CSS vars (fallback = the normal cool value), so the bypass
    // theme can re-tint them to neutral silver by overriding the vars on the node root — without
    // touching text/accent colors or the background. Body-mounted menus/modals use the fallback.
    panel:     "var(--pg-panel, hsl(220 9% 9%))",
    card:      "var(--pg-card, hsl(220 8% 13%))",
    input:     "var(--pg-input, hsl(220 12% 8%))",
    border:    "var(--pg-border, hsl(220 8% 20%))",
    accent:    "hsl(208 70% 56%)",
    accentSoft:"hsl(208 70% 56% / 0.16)",
    accentBorder: "hsl(208 70% 56% / 0.55)",
    text:      "hsl(0 0% 88%)",
    textMuted: "hsl(0 0% 56%)",
    heading:   "hsl(0 0% 72%)",
};

// ---- flat minimal style tokens: solid fills, no gradients/shadows/glows ----
const GRAD_ACCENT = "hsl(208 70% 56%)";          // (legacy name) now a solid accent
const GRAD_BTN    = "var(--pg-btn, hsl(220 8% 14%))";          // solid button fill
const GRAD_BTN_HI = "var(--pg-btn-hi, hsl(220 8% 20%))";       // button hover fill
const GRAD_CARD   = "var(--pg-grad-card, hsl(220 8% 11%))";    // solid card / status-bar fill
// Toggle ON-track: blue accent normally, but routed through a var so the bypass theme can re-tint
// it to dark neutral grey (the bright blue switch looked out of place on the bypassed red surface).
const TOGGLE_ON_BG     = `var(--pg-toggle-on, ${C.accent})`;
const TOGGLE_ON_BORDER = `var(--pg-toggle-on-border, ${C.accentBorder})`;
const GRAD_NODE   = "#0a0b0d";                    // solid near-black node body
const NODE_BG     = "#080809";
// Subtle vertical white shine (white → transparent → white) layered OVER the node background,
// in both normal and bypassed states. Helpers build "shine, <bgColor>" so the color shows through.
const _nodeShine  = (a) => `linear-gradient(180deg, rgba(255,255,255,${a}), rgba(255,255,255,0) 50%, rgba(255,255,255,${a}))`;
// Default strength suits the red bypass wash; the normal (blue) body uses a softer value.
const nodeBg      = (color, a = 0.07) => `${_nodeShine(a)}, ${color}`;
// Bypass look: a faint pale matte red wash (instead of dimming the node transparent).
const BYPASS_ROOT_BG = "#30181c";                 // DOM root background while bypassed
const BYPASS_NODE_BG = "#211215";                 // litegraph body/title to match
// Bypass surface theme: neutral SILVER-grey (no blue hue) with very subtle vertical gradient
// shines, overriding the surface CSS vars on the node root while bypassed. Keeps the red bg and
// all text/accent colors untouched. Removing these vars (un-bypass) falls back to the cool theme.
const BYPASS_SURFACE_VARS = {
    // Dark NEUTRAL greys (same darkness as the normal theme, just no blue hue) at 80% opacity, so
    // the red background bleeds through ~20% and ties the surfaces into the bypass theme. Keeps
    // surfaces dark → existing light text stays readable.
    "--pg-panel":           "hsl(0 0% 9% / 0.8)",
    "--pg-card":            "linear-gradient(180deg, hsl(0 0% 12% / 0.8), hsl(0 0% 9% / 0.8))",
    "--pg-input":           "hsl(0 0% 8% / 0.8)",
    "--pg-border":          "hsl(0 0% 24% / 0.8)",
    "--pg-btn":             "linear-gradient(180deg, hsl(0 0% 11% / 0.8), hsl(0 0% 8% / 0.8))",
    "--pg-btn-hi":          "linear-gradient(180deg, hsl(0 0% 16% / 0.8), hsl(0 0% 12% / 0.8))",
    "--pg-grad-card":       "linear-gradient(180deg, hsl(0 0% 12% / 0.8), hsl(0 0% 9% / 0.8))",
    "--pg-tab-off":         "linear-gradient(180deg, hsl(0 0% 11% / 0.8), hsl(0 0% 8% / 0.8))",
    "--pg-input-grad":      "linear-gradient(180deg, hsl(0 0% 11% / 0.8), hsl(0 0% 8% / 0.8))",
    "--pg-input-grad-hover":"linear-gradient(180deg, hsl(0 0% 14% / 0.8), hsl(0 0% 11% / 0.8))",
    "--pg-res-accent":      "hsl(220 6% 66%)",            // Resolution sliders: blue → light grey while bypassed
    "--pg-res-active":      "hsl(220 6% 48%)",            // darker grey while a slider is held/dragged (bypass)
    "--pg-res-thumbdot":    "hsl(0 72% 52% / 0.9)",       // faint red dot in the slider thumb center (bypass only)
    "--pg-box":             "linear-gradient(180deg, hsl(0 0% 11% / 0.8), hsl(0 0% 8% / 0.8))",
    "--pg-box-hover":       "linear-gradient(180deg, hsl(0 0% 15% / 0.8), hsl(0 0% 12% / 0.8))",
    "--pg-textcard":        "hsl(0 0% 8% / 0.6)",   // text-view thumbnail cards: a bit more transparent (red shows through)
    "--pg-tab-on":          "hsl(0 0% 9% / 0.82)",   // selected main category: much darker grey, ~18% transparent
    "--pg-tab-glow":        "inset 0 0 14px hsl(355 35% 50% / 0.06)",   // very faint desaturated-red inner glow on the selected tab
    "--pg-toggle-on":       "hsl(0 0% 22% / 0.85)",   // ON switch track: dark transparent grey (was bright blue)
    "--pg-toggle-on-border":"hsl(0 0% 34% / 0.8)",
};
// SKIP-LLM (bypass) only: a medium-dark card behind the Input section and the Output cluster, so the
// grouped controls read as a solid block instead of floating on the red wash. Transparent in normal
// mode. Placeholder values — to be dialed in.
const BYPASS_GROUP_BG     = "hsl(0 0% 78% / 0.15)";   // light grey wash — lifts the grouped region above the near-black inner boxes (tune the alpha to taste)
const BYPASS_GROUP_BORDER = "hsl(0 0% 80% / 0.22)";
// Category tabs: active = a dark accent-blue (stands out as selected); inactive = the same
// near-black faint gradient the dropdown fields use, so unselected tabs read as quiet.
const GRAD_TAB_ON  = "var(--pg-tab-on, hsl(220 7% 22%))";    // active tab fill; bypass overrides to a darker, faintly-transparent grey
const GRAD_TAB_OFF = "var(--pg-tab-off, linear-gradient(180deg, hsl(220 12% 10%), hsl(220 12% 7%)))";  // = dropdown field look
const TAB_ON_TEXT  = "hsl(0 0% 84%)";       // active text: light grey (slightly dimmed, not piercing)
const GLOW_ACCENT = "none";
const GLOW_GREEN  = "none";
const SHADOW_SOFT  = "none";
const SHADOW_HOVER = "none";
// Text fields are the ONLY place with a (very faint) gradient — a subtle top→bottom
// darkening, plus a thin border, like a clean dark-mode input.
const INPUT_GRAD   = "var(--pg-input-grad, linear-gradient(180deg, hsl(220 12% 10%), hsl(220 12% 7%)))";
// ~3% brighter — a barely-there lift used when a dropdown (or its label) is hovered.
const INPUT_GRAD_HOVER = "var(--pg-input-grad-hover, linear-gradient(180deg, hsl(220 12% 13%), hsl(220 12% 10%)))";
const INSET_INPUT  = "none";
const FOCUS_RING   = "0 0 0 2px hsl(208 70% 56% / 0.35)";
const ACCENT_DEEP  = "hsl(208 70% 44%)";   // darker accent — pressed/held state (same hue as C.accent)

// ---- custom-dropdown row states (selected / hover) ----
// Both stay dark and on-theme: selected = the same dark blue as the active tab; hover =
// a subtle blue-grey elevation. Near-white text on each (no bright bars / light-grey fills).
const DD_SEL_BG = "hsl(214 30% 22%)";
const DD_SEL_TX = "hsl(0 0% 96%)";
const DD_HOV_BG = "hsl(214 16% 17%)";
const DD_HOV_TX = "hsl(0 0% 96%)";

// Shared active/inactive styling for every tab (top toggle + sub-tab bars), so a
// selected tab gets the gradient + glow consistently wherever it lives.
// Faint horizontal hairline along the bottom of every tab (selected + unselected alike),
// so the divider reads consistently across the whole toggle bar.
const TAB_HAIRLINE = "inset 0 -1px 0 hsl(0 0% 100% / 0.07)";
// Faint radial "shine" for the SELECTED main category tab: a big soft white glow centred ABOVE
// the tab (50% -55%), so only its lower curve falls across the top — a gentle arced highlight,
// not a flat line. Layered over the tab fill (which stays the final background-color).
const TAB_ON_SHINE = "radial-gradient(150% 115% at 50% -55%, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 58%)";
function tabOn(t) {
    t._pgActive = true;
    // Only the main category tabs (flagged _pgMainTab) get the radial shine; sub-tabs stay flat.
    t.style.background = (t._pgMainTab ? TAB_ON_SHINE + ", " : "") + GRAD_TAB_ON;   // active = neutral lighter grey
    t.style.color = TAB_ON_TEXT;        // near-white text
    // Main tabs add a faint inner glow via --pg-tab-glow (transparent by default; red in bypass).
    t.style.boxShadow = t._pgMainTab ? (TAB_HAIRLINE + ", var(--pg-tab-glow, inset 0 0 0 rgba(0,0,0,0))") : TAB_HAIRLINE;
    t.style.textShadow = "none";
    t.style.filter = "none";             // clear any leftover hover brightness
}
function tabOff(t) {
    t._pgActive = false;
    t.style.background = GRAD_TAB_OFF;   // inactive blue
    t.style.color = C.textMuted;
    t.style.boxShadow = TAB_HAIRLINE;
    t.style.textShadow = "none";
    t.style.filter = "none";
}
// Hover-brighten an inactive tab only (the active one already stands out).
function attachTabHover(t) {
    t.addEventListener("mouseenter", () => { if (!t._pgActive) t.style.filter = "brightness(1.3)"; });
    t.addEventListener("mouseleave", () => { if (!t._pgActive) t.style.filter = "none"; });
}

// Attach a focus glow (accent ring) to a text/number/select control. Uses only the
// box-shadow ring — NOT a border-color change — so it never tints a transparent border
// (e.g. the big text boxes' 18px transparent bottom border, which would turn solid blue).
function attachFocusGlow(elm) {
    elm.addEventListener("focus", () => { elm.style.boxShadow = FOCUS_RING; });
    elm.addEventListener("blur", () => { elm.style.boxShadow = INSET_INPUT; });
}

// Barely-there background lift for a text box on hover OR while focused ("actively used").
// Exposes elm._pgSetHover(on) so a row label can drive it too. baseBg/hoverBg are stored on
// the element so callers (e.g. the prompt/output boxes) can re-point it to their own colors.
function attachBoxHover(elm, baseBg, hoverBg) {
    elm._pgBg = { base: baseBg, hover: hoverBg };
    if (!elm._pgBgListeners) {
        elm._pgBgListeners = true;
        elm._pgApplyBg = () => { const active = document.activeElement === elm; elm.style.background = (elm._pgHovered || active) ? elm._pgBg.hover : elm._pgBg.base; };
        elm._pgSetHover = (on) => { elm._pgHovered = on; elm._pgApplyBg(); };
        elm.addEventListener("mouseenter", () => elm._pgSetHover(true));
        elm.addEventListener("mouseleave", () => elm._pgSetHover(false));
        elm.addEventListener("focus", () => elm._pgApplyBg());
        elm.addEventListener("blur", () => elm._pgApplyBg());
    }
    elm._pgApplyBg();
}

// Interactive-text rule for standalone clickable text (not a labelRow): muted by default,
// white on hover, and white while isActive() is true. Returns a sync() to call when the
// active condition changes. (Mirrors the labelRow label behavior.)
function makeInteractiveText(elm, isActive) {
    elm.style.transition = "color .15s";
    let hovered = false;
    const sync = () => { elm.style.color = (hovered || (isActive && isActive())) ? C.text : C.textMuted; };
    elm.addEventListener("mouseenter", () => { hovered = true; sync(); });
    elm.addEventListener("mouseleave", () => { hovered = false; sync(); });
    sync();
    return sync;
}

const FONT = "Inter, system-ui, -apple-system, sans-serif";
// "Use system prompt text field" is no longer a task mode — it's a system-prompt
// SOURCE option living in the Preset dropdown (alongside saved presets + None).
const PRESET_MODE = "Use system prompt text field";
const NO_SYS_PROMPT = "(No system prompt)";   // dropdown sentinel: send no system prompt
const NO_MODE = "None";   // mode that runs a raw text prompt with NO system prompt at all
const MODES = [
    NO_MODE,
    "Enhance Prompt (Text)",
    "Enhance Prompt (Video)",
    "Analyze Image with Prompt",
    "Ideogram4 Vision Standard",
    "Ideogram4 Vision Detailed",
];
// Modes that analyze an image — these show the in-node image loader.
const IMAGE_MODES = new Set([
    "Analyze Image with Prompt",
    "Ideogram4 Vision Standard", "Ideogram4 Vision Detailed",
]);
const NONE_PRESET = "(None)";

const DEFAULTS = {
    _view: "generator",
    _optView: "llm",
    _genView: "prompt",
    // Generator ▸ Resolution sub-view — drives the width/height outputs
    res_width: 1024,     // FINAL output (base × scale, snapped) — what the width/height outputs read
    res_height: 1024,
    res_base_w: 1024,    // base/design resolution set on the canvas (≤ 2048 frame)
    res_base_h: 1024,
    res_scale: 1.0,      // output multiplier (1.0 = default; lets the final exceed the 2048 frame)
    res_divisor: 64,
    res_aspect: "Custom",    // "Custom" = no locked W:H (renamed from "Free"; both behave the same)
    res_sqsize: 0,       // manual size of the picker square in px (0 = auto-fill the column)
    _modeView: "modes",
    _execOpen: true,
    _genTabsHidden: false,
    _optTabsHidden: false,
    _showSeed: true,     // show the native seed / control_after_generate widgets
    _showStatus: true,   // show the llama/Model/MMPROJ/System-Prompt status bar
    // Prompts tab (Recent / Library)
    _libView: "recent",       // recent | library
    _libCardView: "text",     // text | gallery
    _libAlbum: false,         // Album Mode: preview LEFT, grid RIGHT (side-by-side) for dense browsing
    _libCategory: "",         // selected Library category ("" = first / all-pinned virtual)
    _libSearch: "",
    _libScope: "category",    // category | all
    _libSort: "new",          // new | az | uses
    _libPage: 0,
    _libPrevImgOpen: true,     // preview-header: show the image section
    _libPrevTxtOpen: true,     // preview-header: show the text section
    _libPreviewLatest: false,  // preview-header: auto-select the newest generation on each run
    _libPrevImgW: 180,         // preview image frame size — fixed/locked until the user drags
    _libPrevImgH: 230,         // to rescale (portrait default; keeps the node from jumping)
    _libAlbumPrevW: 300,       // Album mode ONLY: the preview COLUMN width (drag its edge → grid fills the rest)
    _libAlbumTextH: 120,       // Album mode ONLY: the preview TEXT box height (drag its bottom edge to rescale)
    // generator
    mode: "Enhance Prompt (Text)",
    prompt: "",
    image_upload: "",
    image_upload_meta: null,
    image_hidden: false,
    format_as_json: false,
    enable_thinking: false,
    stop_server_after: true,
    clear_vram_on_run: true,
    _batchN: 1,               // ×N variations per Generate (stacked as versions / queued N×)
    _bypass: false,
    _render_image: false,     // transient: set only while a "Generate Image" button queues a render
    _render_image_text: "",   // transient: the exact text (Input or Output box) that render emits downstream
    prefix: "",               // DERIVED string (prefixTags.join(", ")) — the EMITTED wrap the Python backend reads. e.g. a LoRA trigger. Survives LLM refine.
    suffix: "",               // DERIVED string (suffixTags.join(", ")) — the EMITTED wrap the Python backend reads. e.g. quality tags. Survives LLM refine.
    prefixTags: [],           // AUTHORITATIVE per-tag list for the UI. The prefix string above is derived from it, so a tag that itself contains a comma is preserved across save/reload.
    suffixTags: [],           // AUTHORITATIVE per-tag list for the UI (suffix string is derived from it).
    // options
    backend: "llama.cpp",
    model: "",
    mmproj: "auto",
    system_prompt_mode: "replace",
    system_prompt: "",
    use_model_default_sampling: false,   // legacy field; sliders are always authoritative now
    temperature: 0.75,
    top_k: 64,
    top_p: 0.9,
    min_p: 0.01,
    repeat_penalty: 1.0,
    presence_penalty: 0.0,
    context_size: 4096,
    request_timeout: 120,
    llama_path: "",
    llama_port: "",
    ollama_url: "",
    extra_launch_args: "",
    model_dir: "",
    mmproj_dir: "",
    show_everything_in_console: false,
    override_system_prompt: NONE_PRESET,
};

// ---- cached server data (models / mmproj / overrides), keyed by scan dirs ----
const _optionsDataCache = new Map();
function fetchOptionsData(modelDir = "", mmprojDir = "", { fresh = false, backend = "", ollamaUrl = "" } = {}) {
    const key = (backend || "") + "|" + (modelDir || "") + "|" + (mmprojDir || "") + "|" + (ollamaUrl || "");
    if (!fresh && _optionsDataCache.has(key)) return _optionsDataCache.get(key);
    const p = new URLSearchParams();
    if (backend) p.set("backend", backend);
    if (modelDir) p.set("model_dir", modelDir);
    if (mmprojDir) p.set("mmproj_dir", mmprojDir);
    if (backend === "ollama" && ollamaUrl) p.set("ollama_url", ollamaUrl);
    const qs = p.toString();
    const promise = fetch("/prompt-generator/options-data" + (qs ? "?" + qs : ""))
        .then((r) => r.json())
        .catch(() => ({ models: [], mmproj: ["None", "auto"], override_system_prompt: ["(Use Generator's Prompt)"] }));
    _optionsDataCache.set(key, promise);
    return promise;
}

// ---- sticky "last used" settings (browser-local) ----
// Goal: a freshly created node (or one deleted & recreated) restores the last
// values you used instead of falling back to defaults / a wrong model. Every
// field write updates this snapshot; new nodes seed their state from it.
const LS_KEY = "PromptGeneratorPro.lastConfig";
function loadLastConfig() {
    try {
        const s = localStorage.getItem(LS_KEY);
        const o = s ? JSON.parse(s) : null;
        return (o && typeof o === "object") ? o : {};
    } catch { return {}; }
}
function saveLastConfig(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* quota/full — non-fatal */ }
}

// ---- LLM presets / bundles (browser-local) ----
// A named snapshot of ONLY the LLM + sampling + backend settings (everything in both Options
// sub-views). DELIBERATELY excludes the system prompt / prompt text — loading a bundle never
// touches what you're writing, only how the model runs. Stored in localStorage like Res presets.
const LLM_PRESET_KEYS = [
    "backend", "model", "mmproj",
    "context_size", "request_timeout",
    "temperature", "top_k", "top_p", "min_p", "repeat_penalty", "presence_penalty",
    "llama_path", "llama_port", "ollama_url", "extra_launch_args", "model_dir", "mmproj_dir",
];
const LLM_PRESETS_KEY = "PromptGeneratorPro.llmPresets";
function loadLlmPresets() {
    try { const a = JSON.parse(localStorage.getItem(LLM_PRESETS_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch { return []; }
}
function saveLlmPresets(a) {
    try { localStorage.setItem(LLM_PRESETS_KEY, JSON.stringify(Array.isArray(a) ? a : [])); } catch { /* non-fatal */ }
}

// ---- rolling output-length history (browser-local) — drives the rough progress bar ----
// Generation is open-ended (no known total), so we estimate completion against the
// average length of recent outputs. Asymptotic: caps at 95% until the model signals done.
const OUTLEN_KEY = "PromptGeneratorPro.outLens";
function recordOutLen(len) {
    if (!len || len < 1) return;
    try {
        let a = JSON.parse(localStorage.getItem(OUTLEN_KEY) || "[]");
        if (!Array.isArray(a)) a = [];
        a.push(len); a = a.slice(-8);
        localStorage.setItem(OUTLEN_KEY, JSON.stringify(a));
    } catch { /* non-fatal */ }
}
function expectedOutLen() {
    try {
        const a = JSON.parse(localStorage.getItem(OUTLEN_KEY) || "[]");
        if (Array.isArray(a) && a.length) return Math.max(200, a.reduce((s, x) => s + x, 0) / a.length);
    } catch { /* ignore */ }
    return 600; // sane default before any history exists
}

// ---- recent prompt history (browser-local, most-recent first, capped at 8) ----
const HIST_KEY = "PromptGeneratorPro.promptHistory";
const HIST_CAP = 500;   // large rolling cap — "feels infinite" but stays bounded
// Recent entries are OBJECTS: { text, source:{type,name,vision}, image_ref, ts }.
// Legacy entries were bare strings — migrate them on read so badges/thumbnails work.
function _histId() { return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function _histNorm(x) {
    if (typeof x === "string") return { id: "", text: x, source: null, image_ref: "", image_meta: null, ts: 0 };
    if (x && typeof x === "object" && typeof x.text === "string") {
        return { id: x.id || "", text: x.text, source: x.source || null, image_ref: x.image_ref || "", image_meta: x.image_meta || null, ts: x.ts || 0 };
    }
    return null;
}
// History persistence is backed by an in-memory MIRROR: we JSON.parse localStorage ONCE, serve
// every read from the parsed array, and DEBOUNCE writes (coalesced) instead of synchronously
// re-serialising + writing the whole array on every result. This kills the write-storm during big
// batches (was ~2 full parse+stringify+setItem passes PER generated image). Flushed on batch-end /
// page-hide so nothing is lost; a cross-tab edit nulls the mirror so the next read re-parses fresh.
let _histCache = null;
let _histDirty = false;
let _histFlushT = null;
function _histRead() {
    if (_histCache) return _histCache;
    try {
        const a = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
        _histCache = Array.isArray(a) ? a.map(_histNorm).filter(Boolean) : [];
    } catch { _histCache = []; }
    return _histCache;
}
function _histFlush() {   // write NOW (if pending)
    if (_histFlushT) { clearTimeout(_histFlushT); _histFlushT = null; }
    if (!_histDirty) return;
    _histDirty = false;
    try { localStorage.setItem(HIST_KEY, JSON.stringify(_histCache || [])); } catch { /* non-fatal */ }
}
function _histTouch() {   // mark dirty + schedule one debounced write (~0.5s)
    _histDirty = true;
    if (!_histFlushT) _histFlushT = setTimeout(() => { _histFlushT = null; _histFlush(); }, 500);
}
function loadPromptHistory() { return _histRead(); }   // live mirror (parsed once); read-only callers .map/.slice
function recordPromptHistory(entry) {
    const e = _histNorm(typeof entry === "string" ? { text: entry } : entry);
    if (!e || !(e.text = String(e.text || "").trim())) return e?.id || "";
    if (!e.id) e.id = _histId();
    if (!e.ts) e.ts = Date.now();
    const a = _histRead();
    // Keep DISTINCT runs of the same prompt (different seeds → different saved images all
    // worth keeping). Only collapse a redundant *craft* run: replace the newest entry in
    // place when it has the same text AND still carries no image (so rapid in-node Generates
    // don't pile up identical imageless rows). An image-bearing run is never overwritten.
    if (a.length && a[0].text === e.text && !a[0].image_ref && !a[0].image_meta) {
        e.id = a[0].id || e.id;   // reuse the slot's id so a pending image-attach still targets it
        a[0] = e;
    } else {
        a.unshift(e);
    }
    if (a.length > HIST_CAP) a.length = HIST_CAP;   // trim in place (mirror stays the same array)
    _histTouch();
    return e.id;
}
// Remove by entry id (precise) or, if no id matches, by text (legacy peek / bulk).
function removePromptHistory(key) {
    const list = _histRead();
    const byId = list.some((e) => e.id && e.id === key);
    _histCache = byId ? list.filter((e) => e.id !== key) : list.filter((e) => e.text !== key);
    _histTouch();
}
// One-time: backfill stable ids onto any pre-existing entries so cards, image-attach and
// per-entry delete all key off a persistent id (not a volatile index).
(function _ensureHistoryIds() {
    const list = _histRead();
    let changed = false;
    for (const e of list) if (!e.id) { e.id = _histId(); changed = true; }
    if (changed) _histTouch();
})();
function clearPromptHistory() {
    _histCache = [];
    _histDirty = false;
    if (_histFlushT) { clearTimeout(_histFlushT); _histFlushT = null; }
    try { localStorage.removeItem(HIST_KEY); } catch { /* non-fatal */ }
}
// Persist promptly when a run/batch ends or the page goes away; re-read on a cross-tab edit.
for (const evt of ["execution_success", "execution_interrupted", "execution_error"]) api.addEventListener(evt, _histFlush);
window.addEventListener("pagehide", _histFlush);
window.addEventListener("beforeunload", _histFlush);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") _histFlush(); });
window.addEventListener("storage", (e) => { if (e.key === HIST_KEY) _histCache = null; });

// ---- Prompt Library (server-side curated prompts) ----
const LIB_DEFAULT_CATEGORY = "Uncategorized";
const LIB_FAVORITES = "⭐ Favorites";   // virtual category aggregating pinned entries
let _libraryCache = null;               // last fetched { categories, entries }
function fetchLibrary({ fresh = false } = {}) {
    if (!fresh && _libraryCache) return Promise.resolve(_libraryCache);
    return fetch("/prompt-generator/library")
        .then((r) => r.json())
        .then((d) => {
            _libraryCache = {
                categories: Array.isArray(d?.categories) && d.categories.length ? d.categories : [LIB_DEFAULT_CATEGORY],
                entries: Array.isArray(d?.entries) ? d.entries : [],
            };
            return _libraryCache;
        })
        .catch(() => (_libraryCache = { categories: [LIB_DEFAULT_CATEGORY], entries: [] }));
}
function libSaveEntry(entry) {
    return fetch("/prompt-generator/library/save", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}
function libDeleteEntry(id) {
    return fetch("/prompt-generator/library/delete", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}
function libCategoryOp(op, name, new_name = "") {
    return fetch("/prompt-generator/library/category", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, name, new_name }),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

// ---- system-prompt presets (saved .txt files + built-ins) ----
let _presetsPromise = null;
function fetchPresets({ fresh = false } = {}) {
    if (_presetsPromise && !fresh) return _presetsPromise;
    _presetsPromise = fetch("/prompt-generator/system-prompts")
        .then((r) => r.json())
        .then((d) => (Array.isArray(d.presets) ? d.presets : []))
        .catch(() => []);
    return _presetsPromise;
}
function savePreset(name, text, vision = false) {
    return fetch("/prompt-generator/save-system-prompt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text, vision }),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}
function deletePreset(name) {
    return fetch("/prompt-generator/delete-system-prompt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

const DANGER = "rgba(220, 53, 69, 0.95)";

// Push a ComfyUI-settings value into the server-side preferences cache.
function savePref(key, value) {
    fetch("/prompt-manager/save-preference", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
    }).catch(() => {});
}

// ---- tiny DOM helpers ----
function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (text !== undefined) e.textContent = text;
    return e;
}
function stop(e) { e.stopPropagation(); }

// Aspect-ratio label for a W×H pair: reduced "w:h" when both sides stay small after the GCD,
// else a decimal "n.nn:1". One definition — reused by the Resolution picker and the output readout.
function pgGcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; }
function pgRatioLabel(w, h) { if (!w || !h) return ""; const g = pgGcd(w, h), aw = w / g, ah = h / g; return (aw <= 64 && ah <= 64) ? `${aw}:${ah}` : (w / h).toFixed(2) + ":1"; }

function forwardWheel(node, element) {
    element.addEventListener("wheel", (e) => {
        const canvas = app.canvas?.canvas;
        if (!canvas) return;
        canvas.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true, cancelable: true,
            clientX: e.clientX, clientY: e.clientY,
            deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ,
            deltaMode: e.deltaMode,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        }));
    }, { passive: true });
}

// ---- control factories: each returns { row, set } and wires onChange ----
function labelRow(label, controlEl, opts = {}) {
    const row = el("div", {
        display: "flex", alignItems: "center", gap: "8px",
        padding: "4px 0", width: "100%", boxSizing: "border-box",
        ...(opts.rowStyle || {}),
    });
    if (label) {
        const lab = el("span", {
            color: C.textMuted, fontSize: "12px", flex: "0 0 auto",
            minWidth: opts.labelWidth || "120px", transition: "color .15s",
        }, label);
        row.appendChild(lab);
        row._label = lab;
        // Interactive-label rule: the label brightens to white on hover, and STAYS white
        // while the row's control is "active" — an input is focused (focusin/out) or a
        // dropdown is open (pg-active event from makeSelect). Otherwise it's muted.
        // opts.staticLabel skips this (for non-interactive display rows).
        if (!opts.staticLabel) {
            let hovered = false, active = false;
            const sync = () => { lab.style.color = (hovered || active) ? C.text : C.textMuted; };
            // Hovering the label also lifts its control's background (dropdown or text box).
            row.addEventListener("mouseenter", () => { hovered = true; sync(); controlEl._pgSetHover?.(true); });
            row.addEventListener("mouseleave", () => { hovered = false; sync(); controlEl._pgSetHover?.(false); });
            row.addEventListener("focusin", () => { active = true; sync(); });
            row.addEventListener("focusout", () => { active = false; sync(); });
            row.addEventListener("pg-active", (e) => { active = !!e.detail; sync(); });
            row._setLabelActive = (v) => { active = !!v; sync(); };
        }
    }
    if (opts.stack) { row.style.flexDirection = "column"; row.style.alignItems = "stretch"; }
    row.appendChild(controlEl);
    return row;
}

const baseInputStyle = {
    background: INPUT_GRAD, color: C.text, border: `1px solid ${C.border}`,
    borderRadius: "6px", padding: "9px 10px", fontSize: "12px",
    fontFamily: FONT, outline: "none", boxSizing: "border-box", flex: "1 1 auto",
    boxShadow: INSET_INPUT, transition: "border-color .15s ease, box-shadow .15s ease",
    // minWidth:0 lets these flex children shrink below their content's intrinsic width.
    // Without it, a long model name / path makes a <select>/<input> overflow the node border.
    minWidth: "0", maxWidth: "100%",
};

// Shared "big text box" look (output + prompt textareas): a slightly brighter solid fill
// so the box stands out from the node body, plus reserved space below the last line.
// NOTE: Chrome/WebKit DROPS a <textarea>'s padding-bottom once its content scrolls, so the
// last line ends up flush against the edge. A transparent bottom *border* is not dropped
// (it's part of the box and the background paints under it), so we use that for the bottom
// breathing room instead of padding-bottom.
const OUTPUT_BOX_STYLE = {
    background: "var(--pg-box, hsl(220 10% 13%))", padding: "0 10px",  // hover/focus lift: OUTPUT_BOX_HOVER (~3% brighter)
    // Persistent top AND bottom breathing room via transparent borders — the background
    // paints under them and they sit OUTSIDE the scroll viewport, so the gap survives even
    // when the box is scrolled (a textarea's padding-bottom is dropped by Chrome once it
    // scrolls). resize:vertical lets the user drag the box's height. Bottom border is 0 so the native
    // resize grip lands exactly on the box's true bottom edge (any bottom border floats it short).
    borderTop: "10px solid transparent",
    borderBottom: "0",
    resize: "vertical",
};

// Absolute paths get displayed as just their filename (full path on hover) so
// custom-directory entries don't blow out the dropdown width.
const _isAbsPath = (s) => /^([a-zA-Z]:[\\/]|\/)/.test(String(s));
const _optLabel = (v) => {
    const s = String(v);
    if (_isAbsPath(s)) { const parts = s.split(/[\\/]/); return parts[parts.length - 1] || s; }
    return s;
};
// Label an absolute path relative to a chosen base folder (keeps subfolders
// visible, e.g. "gemma/model.gguf"); falls back to basename if not under it.
function relPathLabel(v, baseDir) {
    const s = String(v);
    if (baseDir && _isAbsPath(s)) {
        const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
        const sNorm = norm(s), bNorm = norm(baseDir);
        if (sNorm.toLowerCase().startsWith(bNorm.toLowerCase() + "/")) {
            return sNorm.slice(bNorm.length + 1);
        }
    }
    return _optLabel(v);
}
// Display the filename first, then a folder glyph + its directory, so the two are
// easy to tell apart in the (single-color) native dropdown.
function fileFirstLabel(v, baseDir) {
    const lbl = relPathLabel(v, baseDir);
    const i = lbl.lastIndexOf("/");
    if (i < 0) return lbl;                       // no subfolder — just the name
    return `${lbl.slice(i + 1)}   📁 ${lbl.slice(0, i)}`;
}
// Custom dropdown — replaces the native <select>. The browser/OS renders the native
// option popup itself and ignores option:hover/:checked colors (that's the un-killable
// blue highlight), so we render our own list mounted on document.body (escapes the
// node's overflow clipping) with a near-black hover row + light-grey text. The returned
// API is identical to the old makeSelect: { el, set, fill }.
function makeSelect(values, onChange, labeler, opts = {}) {
    const lab = (v) => { try { return labeler ? labeler(v) : _optLabel(v); } catch { return _optLabel(v); } };
    // Optional predicate: values it returns true for are "vision" items → get an 👁 marker.
    const visionOf = (v) => { try { return !!(opts.visionOf && opts.visionOf(v)); } catch { return false; } };

    let items = [];
    let current = null;
    let menu = null;

    const ctrl = el("div", {
        ...baseInputStyle, display: "flex", alignItems: "center", gap: "6px",
        cursor: "pointer", userSelect: "none",
    });
    const labelSpan = el("span", { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    // Monochrome (text-presentation) eye — pinned to the right EDGE of the closed field via
    // absolute positioning (flex margin-auto was unreliable in this container). Shown only
    // when the CHOSEN value is a vision item.
    const visionEye = el("span", { position: "absolute", right: "10px", top: "50%", transform: "translateY(-50%)", display: "none", fontSize: "12px", opacity: "0.85", pointerEvents: "none" }, "\u{1F441}\u{FE0E}");
    // No dropdown caret — kept as a detached no-op so the open/close textContent updates don't error.
    const caret = el("span", {});
    ctrl.style.position = "relative";
    ctrl.append(labelSpan, visionEye);

    // opts.dimOf(v) → render this value as a muted placeholder (e.g. "Ollama not running").
    const dimOf = (v) => { try { return !!(opts.dimOf && opts.dimOf(v)); } catch { return false; } };
    const setCurrent = (v) => {
        current = v;
        const empty = (v == null || v === "");
        labelSpan.textContent = empty ? (opts.placeholder || "") : lab(v);
        labelSpan.style.color = (empty && opts.placeholder) ? C.textMuted : ((v != null && dimOf(v)) ? C.textMuted : "");
        const vis = (v != null && visionOf(v));
        visionEye.style.display = vis ? "block" : "none";   // eye on the chosen vision item (right edge)
        labelSpan.style.paddingRight = vis ? "20px" : "";   // reserve room so long names don't run under it
        ctrl.title = (v == null) ? "" : String(v);
    };

    const closeMenu = () => {
        if (!menu) return;
        menu.remove(); menu = null;
        document.removeEventListener("mousedown", onDocDown, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onAway, true);
        ctrl.style.borderColor = C.border; ctrl.style.boxShadow = INSET_INPUT;
        caret.textContent = "▾";
        // Signal "no longer active" so an enclosing row label can drop its highlight.
        ctrl.dispatchEvent(new CustomEvent("pg-active", { bubbles: true, detail: false }));
    };
    const onDocDown = (e) => { if (menu && !menu.contains(e.target) && !ctrl.contains(e.target)) closeMenu(); };
    const onAway = () => closeMenu();
    // Close on page scroll, but NOT when scrolling inside the menu itself (so a long list
    // can be scrolled). A scroll on the menu's own overflow box has target === the menu.
    const onScroll = (e) => { if (menu && e.target && e.target.nodeType === 1 && menu.contains(e.target)) return; closeMenu(); };
    const onKey = (e) => { if (e.key === "Escape") { stop(e); closeMenu(); } };

    const openMenu = () => {
        if (menu) { closeMenu(); return; }
        const r = ctrl.getBoundingClientRect();
        // Column layout so an optional search field stays pinned on top while the list scrolls.
        menu = el("div", {
            position: "fixed", zIndex: "99999",
            left: r.left + "px", top: (r.bottom + 3) + "px", width: r.width + "px",
            maxHeight: "340px", boxSizing: "border-box", display: "flex", flexDirection: "column",
            background: C.input, border: `1px solid ${C.accentBorder}`, borderRadius: "6px",
            boxShadow: SHADOW_HOVER, fontFamily: FONT, fontSize: "12px", color: C.text, padding: "3px",
        });
        menu.addEventListener("mousedown", stop);
        menu.addEventListener("wheel", (e) => e.stopPropagation());

        // Scrollable list region (the search field, when present, sits above it).
        const listEl = el("div", { flex: "1 1 auto", overflowY: "auto", minHeight: "0" });

        // Build (or rebuild, on each keystroke) the rows, optionally filtered by `filter`.
        const renderRows = (filter) => {
            listEl.innerHTML = "";
            const f = String(filter || "").trim().toLowerCase();
            const shown = !f ? items
                : items.filter((v) => lab(v).toLowerCase().includes(f) || String(v).toLowerCase().includes(f));
            // Free-entry: a valid custom value (opts.acceptCustom) not already listed → offered as a row.
            let customVal = null;
            if (opts.acceptCustom && f) { const cv = opts.acceptCustom(String(filter).trim()); if (cv != null && !items.includes(cv)) customVal = cv; }
            if (!shown.length && customVal == null) { listEl.appendChild(el("div", { padding: "6px 9px", color: C.textMuted }, "No matches")); return; }
            let _i = 0;
            const addRow = (v, labelText, custom) => {
                const isSel = v === current;
                // Subtle zebra striping (by visible index); the selected row's brighter fill overrides it.
                const baseBg = isSel ? DD_SEL_BG : ((_i++ % 2) ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.22)");
                const baseTx = isSel ? DD_SEL_TX : ((!custom && dimOf(v)) ? C.textMuted : C.text);
                const row = el("div", {
                    display: "flex", alignItems: "center", gap: "6px",
                    padding: "5px 9px", borderRadius: "4px", cursor: "pointer",
                    color: baseTx, background: baseBg, fontWeight: isSel ? "600" : "400",
                    transition: "background .1s, color .1s",
                });
                row.appendChild(el("span", { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, labelText));
                if (!custom && visionOf(v)) {
                    const eye = el("span", { flex: "0 0 auto", fontSize: "12px", opacity: "0.85" }, "\u{1F441}\u{FE0E}");
                    eye.title = "Vision item — uses an image";
                    row.appendChild(eye);
                }
                row.title = String(v);
                row.dataset.pgRow = "1";
                row.addEventListener("mouseenter", () => { row.style.background = DD_HOV_BG; row.style.color = DD_HOV_TX; });
                row.addEventListener("mouseleave", () => { row.style.background = baseBg; row.style.color = baseTx; });
                row.addEventListener("click", (e) => { stop(e); setCurrent(v); closeMenu(); onChange(v); });
                listEl.appendChild(row);
            };
            if (customVal != null) addRow(customVal, `Use “${customVal}”`, true);
            shown.forEach((v) => addRow(v, lab(v), false));
        };

        // Optional type-to-filter field — focused on open so you can search immediately.
        let searchInput = null;
        if (opts.searchable) {
            searchInput = el("input", { ...baseInputStyle, flex: "0 0 auto", margin: "1px 1px 4px", padding: "6px 8px" });
            searchInput.type = "text";
            searchInput.placeholder = opts.searchPlaceholder || "Search…";
            searchInput.addEventListener("mousedown", stop);
            searchInput.addEventListener("click", stop);
            searchInput.addEventListener("keydown", (e) => {
                e.stopPropagation();   // keep ComfyUI canvas shortcuts from eating keystrokes
                if (e.key === "Enter") { const first = listEl.querySelector("[data-pg-row]"); if (first) { stop(e); first.click(); } }
            });
            searchInput.addEventListener("input", () => renderRows(searchInput.value));
            menu.appendChild(searchInput);
        }
        menu.appendChild(listEl);
        renderRows("");
        document.body.appendChild(menu);
        if (searchInput) setTimeout(() => searchInput.focus(), 0);
        // Flip above the control if it would overflow the viewport bottom.
        const mh = menu.getBoundingClientRect().height;
        if (r.bottom + 3 + mh > window.innerHeight && r.top - 3 - mh > 0) {
            menu.style.top = (r.top - 3 - mh) + "px";
        }
        ctrl.style.borderColor = C.accentBorder; ctrl.style.boxShadow = FOCUS_RING;
        caret.textContent = "▴";
        // Signal "active" so an enclosing row label stays highlighted while the menu is open.
        ctrl.dispatchEvent(new CustomEvent("pg-active", { bubbles: true, detail: true }));
        document.addEventListener("mousedown", onDocDown, true);
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onAway, true);
    };

    ctrl.addEventListener("mousedown", stop);
    ctrl.addEventListener("click", (e) => { stop(e); openMenu(); });
    // Barely-there hover lift on the box itself; also callable by the row label (labelRow).
    ctrl._pgSetHover = (on) => { ctrl.style.background = on ? INPUT_GRAD_HOVER : INPUT_GRAD; };
    ctrl.addEventListener("mouseenter", () => ctrl._pgSetHover(true));
    ctrl.addEventListener("mouseleave", () => ctrl._pgSetHover(false));

    // opts.wheelCycle → scroll over the CLOSED control to step the value ±1 (menu open = list scrolls).
    // Mirrors the scope-picker / tab steppers; short cooldown tames trackpad bursts.
    if (opts.wheelCycle) {
        let _wheelT = 0;
        ctrl.addEventListener("wheel", (e) => {
            if (menu || items.length < 2) return;   // open → let the list scroll; nothing to cycle
            e.preventDefault(); e.stopPropagation();
            const now = performance.now();
            if (now - _wheelT < 220) return;
            _wheelT = now;
            let i = items.indexOf(current);
            i = ((i < 0 ? 0 : i) + (e.deltaY > 0 ? 1 : -1) + items.length) % items.length;
            setCurrent(items[i]); onChange(items[i]);
        }, { passive: false });
    }

    const fill = (vals, cur) => {
        items = Array.from(vals || []);
        if (cur != null) {
            if (!items.includes(cur)) items.push(cur);
            setCurrent(cur);
        } else if (current != null && items.includes(current)) {
            setCurrent(current);
        } else {
            setCurrent(items.length ? items[0] : null);
        }
        if (menu) { closeMenu(); openMenu(); }   // rebuild if open while refilled
    };

    fill(values);
    return {
        el: ctrl,
        set: (v) => { if (!items.includes(v)) items.push(v); setCurrent(v); },
        fill,
    };
}

function makeText(multiline, placeholder, onChange, opts = {}) {
    const inp = el(multiline ? "textarea" : "input", {
        ...baseInputStyle,
        ...(multiline ? { minHeight: "90px", resize: "vertical", lineHeight: "1.4" } : {}),
    });
    if (!multiline) inp.type = "text";
    inp.placeholder = placeholder || "";
    // opts.noGlow → no focus ring (the big prompt boxes match the plain output box).
    if (!opts.noGlow) attachFocusGlow(inp);
    attachBoxHover(inp, INPUT_GRAD, INPUT_GRAD_HOVER);   // ~3% lift on hover/focus
    inp.addEventListener("mousedown", stop);
    inp.addEventListener("input", (e) => { stop(e); onChange(inp.value); });
    inp.addEventListener("keydown", stop);
    return { el: inp, set: (v) => { inp.value = v ?? ""; } };
}

function makeNumber(min, max, step, isInt, onChange) {
    const inp = el("input", { ...baseInputStyle, textAlign: "right" });
    inp.type = "number";
    if (min != null) inp.min = min;
    if (max != null) inp.max = max;
    inp.step = step;
    attachFocusGlow(inp);
    attachBoxHover(inp, INPUT_GRAD, INPUT_GRAD_HOVER);   // ~3% lift on hover/focus (e.g. Context Size)
    inp.addEventListener("mousedown", stop);
    inp.addEventListener("keydown", stop);
    inp.addEventListener("input", (e) => {
        stop(e);
        let v = isInt ? parseInt(inp.value, 10) : parseFloat(inp.value);
        if (!Number.isFinite(v)) v = 0;
        onChange(v);
    });
    return { el: inp, set: (v) => { inp.value = (v == null || Number.isNaN(v)) ? "" : v; }, setDisabled: (d) => { inp.disabled = d; inp.style.opacity = d ? "0.45" : "1"; } };
}

// Filled-track slider — track + filled-left + round thumb + tick marks, with a value bubble that
// pops above the thumb while dragging. Themed from the node accent. opts: { ticks, tickStep,
// format, onGrab, onRelease }. Returns { el, set(v), setRange(min,max,step) }.
function makeSlider(min, max, step, onInput, opts = {}) {
    const ACC = opts.accent || C.accent;
    const ACT = opts.activeAccent || ACCENT_DEEP;   // darker (held/dragged) — tactile press feel
    let _min = min, _max = max, _step = step || 1, _val = min;
    const fmt = opts.format || ((v) => String(v));
    const wrap = el("div", { position: "relative", flex: "1 1 auto", minWidth: "0", height: "18px", display: "flex", alignItems: "center", cursor: "pointer", touchAction: "none", userSelect: "none" });
    const track = el("div", { position: "relative", flex: "1 1 auto", height: "5px", borderRadius: "3px", background: "var(--pg-input, hsl(220 12% 8%))", boxShadow: `inset 0 0 0 1px ${C.border}` });
    const fill = el("div", { position: "absolute", left: "0", top: "0", bottom: "0", width: "0%", borderRadius: "3px", background: ACC });
    const ticks = el("div", { position: "absolute", inset: "0", pointerEvents: "none" });
    const thumb = el("div", { position: "absolute", top: "50%", left: "0%", width: "13px", height: "13px", marginLeft: "-6.5px", transform: "translateY(-50%)", transition: "transform .12s ease, background .12s", borderRadius: "50%", background: ACC, border: "2px solid hsl(0 0% 96%)", boxShadow: "0 1px 3px rgba(0,0,0,0.5)" });
    if (opts.thumbDot) thumb.appendChild(el("div", { position: "absolute", top: "50%", left: "50%", width: "5px", height: "5px", transform: "translate(-50%, -50%)", borderRadius: "50%", background: opts.thumbDot, pointerEvents: "none" }));
    const bubble = el("div", { position: "absolute", bottom: "18px", left: "0%", transform: "translateX(-50%)", padding: "2px 6px", borderRadius: "5px", background: "hsl(0 0% 10% / 0.96)", border: `1px solid ${C.border}`, color: C.text, fontSize: "11px", fontWeight: "600", whiteSpace: "nowrap", pointerEvents: "none", opacity: "0", transition: "opacity .1s", zIndex: "6" }, "");
    track.append(fill, ticks);
    wrap.append(track, thumb, bubble);
    const pct = (v) => (_max <= _min ? 0 : Math.max(0, Math.min(1, (v - _min) / (_max - _min))));
    const layout = () => { const p = pct(_val) * 100; fill.style.width = p + "%"; thumb.style.left = p + "%"; bubble.style.left = p + "%"; bubble.textContent = fmt(_val); };
    const renderTicks = () => {
        ticks.innerHTML = "";
        if (!opts.ticks || _max <= _min) return;
        const ts = opts.tickStep || (_max - _min) / 8;
        for (let v = _min; v <= _max + 1e-6; v += ts) ticks.appendChild(el("div", { position: "absolute", top: "50%", left: pct(v) * 100 + "%", width: "2px", height: "2px", marginLeft: "-1px", transform: "translateY(-50%)", borderRadius: "50%", background: "rgba(255,255,255,0.35)" }));
    };
    const apply = (v) => { v = Math.max(_min, Math.min(_max, v)); v = _min + Math.round((v - _min) / _step) * _step; _val = Math.max(_min, Math.min(_max, v)); layout(); onInput(_val); };
    const valFromX = (cx) => { const r = track.getBoundingClientRect(); return _min + (r.width ? Math.max(0, Math.min(1, (cx - r.left) / r.width)) : 0) * (_max - _min); };
    let dragging = false, _hover = false;
    const bumpThumb = () => { thumb.style.transform = "translateY(-50%) scale(" + ((dragging || _hover) ? 1.3 : 1) + ")"; };   // 30% larger on hover/drag
    wrap.addEventListener("mouseenter", () => { _hover = true; bumpThumb(); });
    wrap.addEventListener("mouseleave", () => { _hover = false; bumpThumb(); });
    const paintThumb = () => { thumb.style.background = dragging ? ACT : ACC; };
    wrap.addEventListener("pointerdown", (e) => { stop(e); dragging = true; bumpThumb(); paintThumb(); bubble.style.opacity = "1"; opts.onGrab?.(); try { wrap.setPointerCapture(e.pointerId); } catch {} apply(valFromX(e.clientX)); });
    wrap.addEventListener("pointermove", (e) => { if (!dragging) return; stop(e); apply(valFromX(e.clientX)); });
    const end = (e) => { if (!dragging) return; dragging = false; bumpThumb(); paintThumb(); bubble.style.opacity = "0"; opts.onRelease?.(); try { wrap.releasePointerCapture(e.pointerId); } catch {} };
    wrap.addEventListener("pointerup", end);
    wrap.addEventListener("pointercancel", end);
    // Scroll over the slider to nudge the value (no-drag alternative); preventDefault stops graph zoom.
    wrap.addEventListener("wheel", (e) => { e.preventDefault(); e.stopPropagation(); const ws = opts.wheelStep || _step; apply(_val + (e.deltaY < 0 ? ws : -ws)); }, { passive: false });
    renderTicks(); layout();
    return { el: wrap, set: (v) => { _val = Math.max(_min, Math.min(_max, v)); layout(); }, applyUser: (v) => { _val = Math.max(_min, Math.min(_max, v)); layout(); onInput(_val); }, setRange: (mn, mx, st) => { _min = mn; _max = mx; if (st) _step = st; renderTicks(); layout(); } };
}

function makeToggle(onChange) {
    const wrap = el("label", { display: "inline-flex", alignItems: "center", cursor: "pointer", flex: "0 0 auto" });
    const track = el("span", {
        width: "38px", height: "20px", borderRadius: "12px",
        background: C.input, border: `1px solid ${C.border}`,
        position: "relative", transition: "background .15s, border-color .15s",
    });
    const knob = el("span", {
        position: "absolute", top: "2px", left: "2px", width: "14px", height: "14px",
        borderRadius: "50%", background: "#ccc", transition: "left .15s, background .15s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.45)",
    });
    track.appendChild(knob);
    wrap.appendChild(track);
    let state = false;
    const render = () => {
        track.style.background = state ? TOGGLE_ON_BG : C.input;
        track.style.borderColor = state ? TOGGLE_ON_BORDER : C.border;
        track.style.boxShadow = "none";
        knob.style.left = state ? "20px" : "2px";
        knob.style.background = state ? "#fff" : "#999";
    };
    wrap.addEventListener("mousedown", stop);
    wrap.addEventListener("click", (e) => { stop(e); state = !state; render(); onChange(state); });
    render();
    return {
        el: wrap,
        set: (v) => { state = !!v; render(); },                                   // visual only (no onChange)
        get: () => state,
        toggle: () => { state = !state; render(); onChange(state); },             // flip + fire onChange
        setUser: (v) => { v = !!v; if (state !== v) { state = v; render(); onChange(state); } },  // set to v, fire only when it changes
    };
}

// Make a whole label+toggle row the hit target: click ANYWHERE on the row toggles; scroll up = ON, down = OFF.
// (The toggle's own click stops propagation, so clicking it directly doesn't double-fire the row handler.)
function wireToggleRow(row, toggle) {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => toggle.toggle());
    row.addEventListener("wheel", (e) => { e.preventDefault(); e.stopPropagation(); toggle.setUser(e.deltaY < 0); }, { passive: false });
    return row;
}

// Thin horizontal splitter line used between sections. Returns a fresh element each call.
function divider(extra) {
    // flexShrink:0 so the line keeps its margins when the node body is height-constrained.
    return el("div", { borderTop: `1px solid ${C.border}`, opacity: "0.75", margin: "4px 0 8px", flexShrink: "0", ...(extra || {}) });
}

function makeButton(label, onClick, extra) {
    const baseBg = extra?.background || GRAD_BTN;
    const b = el("button", {
        padding: "8px 10px", border: "none", borderRadius: "7px",
        color: C.text, cursor: "pointer", fontSize: "12px",
        fontWeight: "600", fontFamily: FONT, width: "100%",
        transition: "background .15s ease, filter .15s ease",
        ...(extra || {}), background: baseBg,
    }, label);
    // Flat hover: default buttons swap to a slightly lighter solid fill; special-color
    // buttons (accent/danger) just brighten a touch. No transform, shadow, or glow.
    const hoverBg = extra?.background ? null : GRAD_BTN_HI;
    b.onmouseenter = () => { if (hoverBg) b.style.background = hoverBg; else b.style.filter = "brightness(1.1)"; };
    b.onmouseleave = () => { b.style.background = baseBg; b.style.filter = "none"; };
    b.addEventListener("mousedown", stop);
    b.addEventListener("click", (e) => { stop(e); onClick(b); });
    return b;
}

// Small pill button — ONE definition used as mkMini (generator/output cluster) AND lpill (library),
// so the two scopes can never drift. opts: { bg, bgHi, border } override the fill/edge.
function pillBtn(label, title, onClick, opts = {}) {
    const _bg = opts.bg || GRAD_BTN, _bgHi = opts.bgHi || GRAD_BTN_HI;
    const b = el("div", {
        cursor: "pointer", userSelect: "none", fontSize: "11px", fontWeight: "600",
        color: C.text, border: opts.border || "none", borderRadius: "6px", boxSizing: "border-box",
        padding: "4px 9px", background: _bg, flex: "0 0 auto", transition: "background .15s",
    }, label);
    if (title) b.title = title;
    b.addEventListener("mouseenter", () => { b.style.background = _bgHi; });
    b.addEventListener("mouseleave", () => { b.style.background = _bg; });
    b.addEventListener("mousedown", stop);
    b.addEventListener("click", (e) => { stop(e); onClick(b); });
    return b;
}

const PG_BATCH_MAX = 100;
// Compact "×N" variations stepper that sits next to a Generate button. Click to TYPE a number
// (1–100), scroll to nudge ±1. The value is shared via state (_batchN) so every stepper (main +
// theater + Prompts preview) mirrors it through node._pgSetBatchN. Accent when N>1.
function makeBatchStepper(onChange) {
    let n = 1;
    const b = el("div", {
        cursor: "pointer", userSelect: "none", fontSize: "11px", fontWeight: "700",
        color: C.text, border: `1px solid ${C.border}`, borderRadius: "6px", boxSizing: "border-box",
        padding: "4px 8px", background: GRAD_BTN, flex: "0 0 auto", minWidth: "32px", textAlign: "center",
        transition: "background .15s, color .15s", position: "relative",
    });
    const lbl = el("span", {}, "×1");
    const inp = el("input", {
        display: "none", width: "36px", textAlign: "center", fontSize: "11px", fontWeight: "700",
        fontFamily: FONT, color: C.text, background: "transparent", border: "none", outline: "none", padding: "0",
    });
    inp.type = "text"; inp.inputMode = "numeric";
    b.append(lbl, inp);
    b.title = "Batch count — click to type, scroll to adjust. Affects both Input and Output Generations.";
    const paint = () => { lbl.textContent = "×" + n; b.style.color = n > 1 ? C.accent : C.text; };
    const set = (v) => { n = Math.max(1, Math.min(PG_BATCH_MAX, (v | 0) || 1)); paint(); };
    const commit = (v) => { set(v); onChange(n); };
    const editing = () => inp.style.display !== "none";
    const startEdit = () => { inp.value = String(n); lbl.style.display = "none"; inp.style.display = "inline-block"; b.style.background = GRAD_BTN_HI; setTimeout(() => { inp.focus(); inp.select(); }, 0); };
    const endEdit = (save) => { if (!editing()) return; if (save) commit(parseInt(inp.value, 10)); inp.style.display = "none"; lbl.style.display = "inline"; b.style.background = GRAD_BTN; };
    b.addEventListener("mousedown", stop);
    b.addEventListener("mouseenter", () => { if (!editing()) b.style.background = GRAD_BTN_HI; });
    b.addEventListener("mouseleave", () => { if (!editing()) b.style.background = GRAD_BTN; });
    b.addEventListener("click", (e) => { stop(e); if (!editing()) startEdit(); });
    inp.addEventListener("mousedown", stop);
    inp.addEventListener("click", stop);
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); endEdit(true); } else if (e.key === "Escape") { endEdit(false); } });
    inp.addEventListener("blur", () => endEdit(true));
    b.addEventListener("wheel", (e) => { if (editing()) return; e.preventDefault(); e.stopPropagation(); commit(n + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    paint();
    return { el: b, set };
}

// Small uppercase section/row label (Width, Aspect Ratio, …) — one definition so they stay
// consistent. Pass `extra` to tweak per use (e.g. { flex: "0 0 auto" }).
function miniLabel(text, extra) {
    return el("div", { fontSize: "11px", fontWeight: "600", color: C.heading, textTransform: "uppercase", letterSpacing: "0.3px", transition: "color .12s", ...(extra || {}) }, text);
}

function sectionTitle(text) {
    const wrap = el("div", {
        display: "flex", alignItems: "center", gap: "6px", margin: "8px 0 2px 0",
    });
    wrap.append(
        el("span", {
            color: C.heading, fontSize: "11px", fontWeight: "700", letterSpacing: "0.4px",
            textTransform: "uppercase", opacity: "0.85",
        }, text),
    );
    return wrap;
}

// Word-level LCS diff for the Refine version comparison.
// Returns [{ t: "eq" | "ins" | "del", s }] where ins = added in the newer version.
function wordDiff(prevStr, curStr) {
    const split = (s) => String(s ?? "").split(/(\s+)/).filter((x) => x.length);
    const a = split(prevStr), b = split(curStr);
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { out.push({ t: "eq", s: b[j] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", s: a[i] }); i++; }
        else { out.push({ t: "ins", s: b[j] }); j++; }
    }
    while (i < n) out.push({ t: "del", s: a[i++] });
    while (j < m) out.push({ t: "ins", s: b[j++] });
    return out;
}

// Small modal dialog. With `input`, resolves to the typed string (or null if
// cancelled). Without `input`, resolves to true (confirm) / null (cancel).
// When `checkbox` is supplied, the resolved value becomes an object
// { value, checked } (value is "" when there's no text input) instead of a string,
// so a caller can collect a name + a flag in one dialog. Cancel still resolves null.
// `fields` (optional) renders multiple labeled inputs; each { key, label, placeholder, value, list }.
// A `list` array turns that field into a combobox (type a new value OR pick from the datalist).
// Result is then { values: {key: val}, checked }. `input`/`checkbox` keep their legacy behavior.
function pmModal({ title, message, input = null, fields = null, checkbox = null, confirmLabel = "OK", cancelLabel = "Cancel", danger = false }) {
    return new Promise((resolve) => {
        const overlay = el("div", {
            position: "fixed", inset: "0", background: "rgba(0,0,0,0.6)",
            zIndex: "10000", display: "flex", alignItems: "center", justifyContent: "center",
        });
        const box = el("div", {
            background: C.panel, border: `1px solid ${C.border}`, borderRadius: "10px",
            padding: "16px", width: "380px", maxWidth: "92vw", fontFamily: FONT, color: C.text,
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
        });
        if (title) box.appendChild(el("div", { fontSize: "15px", fontWeight: "700", marginBottom: "8px", color: C.heading }, title));
        if (message) box.appendChild(el("div", { fontSize: "12px", color: C.textMuted, marginBottom: "10px", lineHeight: "1.45", whiteSpace: "pre-line" }, message));
        let field = null;
        if (input) {
            field = el("input", { ...baseInputStyle, width: "100%", marginBottom: "12px" });
            field.type = "text"; field.placeholder = input.placeholder || ""; field.value = input.value || "";
            box.appendChild(field);
        }
        const fieldEls = {};
        if (Array.isArray(fields)) {
            for (const f of fields) {
                if (f.label) box.appendChild(el("div", { fontSize: "11px", color: C.textMuted, margin: "0 0 4px" }, f.label));
                if (Array.isArray(f.options)) {
                    // Real dropdown (the node's own makeSelect): pick an existing value, or type a new one
                    // (acceptCustom). Used for category pickers so they match the rest of the gallery.
                    let cur = f.value || "";
                    const sel = makeSelect(f.options, (v) => { cur = v; }, null,
                        { searchable: true, acceptCustom: (s) => String(s).trim(), searchPlaceholder: f.placeholder || "Type or pick…" });
                    sel.el.style.width = "100%"; sel.el.style.marginBottom = "10px";
                    sel.fill(f.options, cur || null);
                    box.appendChild(sel.el);
                    fieldEls[f.key] = { get value() { return cur; } };
                } else {
                    const inp = el("input", { ...baseInputStyle, width: "100%", marginBottom: "10px" });
                    inp.type = "text"; inp.placeholder = f.placeholder || ""; inp.value = f.value || "";
                    if (Array.isArray(f.list) && f.list.length) {
                        const dlId = "pgdl_" + Math.random().toString(36).slice(2);
                        const dl = document.createElement("datalist"); dl.id = dlId;
                        for (const opt of f.list) { const o = document.createElement("option"); o.value = opt; dl.appendChild(o); }
                        box.appendChild(dl); inp.setAttribute("list", dlId);
                    }
                    box.appendChild(inp);
                    fieldEls[f.key] = inp;
                }
            }
        }
        let checkEl = null;
        if (checkbox) {
            const wrap = el("label", { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", color: C.text, marginBottom: "12px", userSelect: "none" });
            checkEl = document.createElement("input");
            checkEl.type = "checkbox";
            checkEl.checked = !!checkbox.value;
            checkEl.style.cursor = "pointer";
            wrap.append(checkEl, el("span", {}, checkbox.label || ""));
            box.appendChild(wrap);
        }
        // Resolve shape: `fields` → { values, checked }; checkbox → { value, checked }; else legacy.
        const result = () => {
            if (Array.isArray(fields)) {
                const values = {};
                for (const k in fieldEls) values[k] = fieldEls[k].value || "";
                return { values, checked: !!checkEl?.checked };
            }
            return checkbox ? { value: input ? (field.value || "") : "", checked: !!checkEl?.checked }
                            : (input ? (field.value || "") : true);
        };
        const row = el("div", { display: "flex", gap: "8px", justifyContent: "flex-end" });
        const cleanup = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
        const cancel = makeButton(cancelLabel, () => { cleanup(); resolve(null); }, { width: "auto" });
        const ok = makeButton(confirmLabel, () => { cleanup(); resolve(result()); },
            { width: "auto", background: danger ? DANGER : C.accent, color: "#fff", borderColor: "transparent" });
        row.append(cancel, ok);
        box.appendChild(row);
        overlay.appendChild(box);
        const onKey = (e) => {
            if (e.key === "Escape") { cleanup(); resolve(null); }
            else if (e.key === "Enter" && input) { cleanup(); resolve(result()); }
        };
        document.addEventListener("keydown", onKey);
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });
        document.body.appendChild(overlay);
        const firstFocus = field || (Array.isArray(fields) && fields[0] && fieldEls[fields[0].key]);
        if (firstFocus) setTimeout(() => firstFocus.focus?.(), 30);   // dropdown fields have no .focus()
    });
}

// ---- Affix library: saved prefix/suffix snippets grouped into categories (localStorage, shared
// across nodes) + a short History of the latest UNSAVED values used per side. ----
const LS_AFFIX = "PromptGeneratorPro.affixLib";
const LS_AFFIX_HISTORY = "PromptGeneratorPro.affixHistory";
const AFFIX_HISTORY_CAP = 10;
function loadAffixLib() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_AFFIX) || "{}");
        return { prefix: (s && typeof s.prefix === "object" && s.prefix) || {},
                 suffix: (s && typeof s.suffix === "object" && s.suffix) || {} };
    } catch { return { prefix: {}, suffix: {} }; }
}
function saveAffixLib(lib) { try { localStorage.setItem(LS_AFFIX, JSON.stringify(lib)); } catch {} }
function loadAffixHistory() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_AFFIX_HISTORY) || "{}");
        return { prefix: Array.isArray(s.prefix) ? s.prefix : [], suffix: Array.isArray(s.suffix) ? s.suffix : [] };
    } catch { return { prefix: [], suffix: [] }; }
}
function saveAffixHistory(h) { try { localStorage.setItem(LS_AFFIX_HISTORY, JSON.stringify(h)); } catch {} }
// A saved item is { name, text }. Older plain-string entries normalize to an unnamed item.
function affixNorm(x) { return (typeof x === "string") ? { name: "", text: x } : { name: String((x && x.name) || ""), text: String((x && x.text) || "") }; }
// Split a stored affix string into individual tags. Only used as a FALLBACK for legacy configs that
// have a `prefix`/`suffix` string but no `…Tags` array yet (such tags can't contain commas anyway).
function splitAffix(s) { return String(s || "").split(",").map((t) => t.trim()).filter(Boolean); }
// Authoritative per-tag list for a side. Prefers the `…Tags` ARRAY (which preserves tags that contain
// commas); falls back to splitting the derived string for legacy/loaded state that predates the array.
function affixTags(node, which) {
    const arr = node._pgState[which + "Tags"];
    if (Array.isArray(arr)) return arr.map((t) => String(t || "").trim()).filter(Boolean);
    return splitAffix(node._pgState[which] || "");
}
// Write a side's tags: store the cleaned ARRAY (source of truth) AND the derived ", "-joined string
// (what the Python backend reads). Keeping both in sync means a comma-bearing tag round-trips intact.
function setAffixTags(node, which, tags) {
    const clean = (tags || []).map((t) => String(t || "").trim()).filter(Boolean);
    node._pgState[which + "Tags"] = clean;
    node._pgState[which] = clean.join(", ");
}
function affixIsSaved(which, value) {
    const lib = loadAffixLib();
    for (const cat of Object.keys(lib[which] || {})) for (const it of (lib[which][cat] || [])) if (affixNorm(it).text === value) return true;
    return false;
}
// Record a freshly-used value in History — but never one that's already a saved preset.
function pushAffixHistory(which, value) {
    value = String(value || "").trim(); if (!value || affixIsSaved(which, value)) return;
    const h = loadAffixHistory();
    h[which] = [value, ...(h[which] || []).filter((v) => v !== value)].slice(0, AFFIX_HISTORY_CAP);
    saveAffixHistory(h);
}

// Two-box browser for a prefix/suffix value. Left = "History" + your saved categories; hover one to
// fill the right box, click a value → append it (", " joined) to the field. Typing a new value + Enter
// appends it AND drops it into History in the background (never shown loose in the menu). From History,
// 🔖 promotes a value into a category you pick. `which` ("prefix"|"suffix") picks the side + field.
function openAffixBrowser(node, which) {
    const name = which === "prefix" ? "Prefix" : "Suffix";
    const HISTORY = "🕘 History";
    let parts = affixTags(node, which);   // each selected tag is its own editable "chip" (array = source of truth)
    const USED_GREEN = "hsl(140 45% 62%)";   // faint-green tint for menu rows already added below
    let activeCat = HISTORY;
    let query = "";

    const overlay = el("div", { position: "fixed", inset: "0", background: "rgba(0,0,0,0.6)", zIndex: "10000", display: "flex", alignItems: "center", justifyContent: "center" });
    const box = el("div", { background: C.panel, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "14px", width: "560px", maxWidth: "94vw", fontFamily: FONT, color: C.text, boxShadow: "0 8px 30px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", gap: "10px" });
    box.addEventListener("mousedown", stop);
    box.appendChild(el("div", { fontSize: "14px", fontWeight: "700", color: C.heading }, `${name} — type, browse & build`));

    // top: new-value entry. Enter appends it to the field + records it to History (background only).
    const entry = el("input", { ...baseInputStyle, padding: "6px 8px" });
    entry.type = "text"; entry.placeholder = "search saved (name · tag · category) — or type a new value, Enter to add…";
    entry.addEventListener("input", () => { query = entry.value; renderVals(); });
    box.appendChild(entry);

    // two boxes: categories (left) | values (right)
    const catCol = el("div", { flex: "0 0 150px", overflow: "auto", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "4px" });
    const valCol = el("div", { flex: "1 1 auto", overflow: "auto", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "4px" });
    const colWrap = el("div", { display: "flex", gap: "8px", height: "240px" });
    colWrap.append(catCol, valCol);
    box.appendChild(colWrap);

    // bottom: the value being built — one editable "chip" box per selected tag (multiple columns) + Done
    const buildWrap = el("div", { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", flex: "1 1 auto", minWidth: "0", minHeight: "34px", maxHeight: "92px", overflow: "auto", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "5px 6px", background: NODE_BG });
    // Re-render the chip row from `parts`. Each chip is its own editable box; its ✕ drops just that one.
    const renderBuild = () => {
        buildWrap.innerHTML = "";
        if (!parts.length) {
            buildWrap.append(el("span", { fontSize: "11px", color: C.textMuted, padding: "3px 2px" }, "click tags above, or type a value — each becomes its own box"));
            return;
        }
        parts.forEach((p, i) => {
            const chip = el("div", { display: "inline-flex", alignItems: "center", gap: "3px", background: INPUT_GRAD, border: `1px solid ${C.border}`, borderRadius: "6px", padding: "2px 3px 2px 7px", maxWidth: "100%" });
            const inp = el("input", { ...baseInputStyle, border: "none", background: "transparent", padding: "2px 0", fontSize: "12px", minWidth: "24px", boxShadow: "none" });
            inp.type = "text"; inp.value = p; inp.size = Math.max(4, p.length);
            inp.addEventListener("mousedown", stop);
            inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
            // Live: editing a chip re-colors the menu's "used" rows (so typing an existing tag turns it green).
            inp.addEventListener("input", () => { parts[i] = inp.value; inp.size = Math.max(4, inp.value.length); renderVals(); });
            const x = el("span", { flex: "0 0 auto", cursor: "pointer", fontSize: "12px", color: C.textMuted, padding: "0 3px" }, "✕");
            x.title = "Remove this tag";
            x.addEventListener("mousedown", stop);
            x.addEventListener("click", (e) => { stop(e); parts.splice(i, 1); renderBuild(); renderVals(); });
            chip.append(inp, x);
            buildWrap.append(chip);
        });
    };
    const clearBtn = pillBtn("✕", `Clear ${name.toLowerCase()}`, () => { parts = []; renderBuild(); renderVals(); });
    const doneBtn = makeButton("Done", () => close(true), { width: "auto", background: C.accent, color: "#fff", borderColor: "transparent" });
    const botRow = el("div", { display: "flex", gap: "6px", alignItems: "flex-start" });
    botRow.append(el("span", { fontSize: "11px", color: C.textMuted, flex: "0 0 auto", paddingTop: "9px" }, `${name}:`), buildWrap, clearBtn, doneBtn);
    box.appendChild(botRow);

    // Append a tag as a new chip. `fromSaved` = it came from a category preset (so it does NOT
    // re-enter History — History only holds unsaved values). Skips exact (case-insensitive) duplicates
    // — already-added tags show green as "used" rather than stacking a second identical box.
    const appendValue = (v, fromSaved = false) => {
        v = String(v || "").trim(); if (!v) return;
        if (parts.some((p) => p.trim().toLowerCase() === v.toLowerCase())) return;
        parts.push(v);
        if (!fromSaved) pushAffixHistory(which, v);
        renderBuild(); renderVals();
    };

    // One list row: label + optional hover action icons [{icon,title,fn}] + hover/click callbacks.
    const rowEl = (label, { onClick = null, onHover = null, actions = [], used = false } = {}) => {
        const row = el("div", { display: "flex", alignItems: "center", gap: "6px", padding: "4px 6px", borderRadius: "6px", cursor: onClick ? "pointer" : "default", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden" });
        // "used" = this tag is already in the build row below → faint-green text + inset bar (the bar
        // survives hover, which only repaints the background).
        if (used) row.style.boxShadow = `inset 2px 0 0 ${USED_GREEN}`;
        row.append(el("span", { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", color: used ? USED_GREEN : "" }, label));
        const aEls = [];
        for (const a of actions) {
            const ae = el("span", { flex: "0 0 auto", cursor: "pointer", opacity: "0", fontSize: "12px", transition: "opacity .1s" }, a.icon);
            ae.title = a.title || "";
            ae.addEventListener("mousedown", stop);
            ae.addEventListener("click", (e) => { stop(e); a.fn(); });
            row.append(ae); aEls.push(ae);
        }
        row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,0.07)"; for (const ae of aEls) ae.style.opacity = "0.85"; if (onHover) onHover(); });
        row.addEventListener("mouseleave", () => { row.style.background = ""; for (const ae of aEls) ae.style.opacity = "0"; });
        if (onClick) { row.addEventListener("mousedown", stop); row.addEventListener("click", (e) => { stop(e); onClick(); }); }
        return row;
    };

    // Create an empty category (so you can make one up-front and fill it later).
    const newCategory = async () => {
        const r = await pmModal({ title: "New category", input: { placeholder: "Category name…", value: "" }, confirmLabel: "Create" });
        if (r === null) return;
        const cat = String(r || "").trim(); if (!cat) return;
        const lib = loadAffixLib();
        if (!lib[which]) lib[which] = {};
        if (!(cat in lib[which])) lib[which][cat] = [];
        saveAffixLib(lib);
        activeCat = cat; renderCats(); renderVals();
    };

    const renderCats = () => {
        catCol.innerHTML = "";
        catCol.append(rowEl(HISTORY, { onHover: () => { activeCat = HISTORY; renderVals(); } }));
        const lib = loadAffixLib();
        for (const cat of Object.keys(lib[which] || {}).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
            catCol.append(rowEl(cat, {
                onHover: () => { activeCat = cat; renderVals(); },
                actions: [{ icon: "🗑", title: "Delete category", fn: () => { const l = loadAffixLib(); delete l[which][cat]; saveAffixLib(l); if (activeCat === cat) activeCat = HISTORY; renderCats(); renderVals(); } }],
            }));
        }
        catCol.append(rowEl("＋ New category", { onClick: () => newCategory() }));
    };

    // Promote a History value into a saved category (existing or a brand-new one you type).
    const promote = async (v) => {
        const cats = Object.keys(loadAffixLib()[which] || {}).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const r = await pmModal({ title: "Save as preset", fields: [
            { key: "label", label: "Name (optional — shown before the tag):", value: "", placeholder: "e.g. Realism LoRA" },
            { key: "cat", label: `Tag: “${v.length > 40 ? v.slice(0, 40) + "…" : v}” — save to category:`, list: cats, value: "", placeholder: "Type a new category or pick one…" },
        ], confirmLabel: "Save" });
        if (!r) return;
        const cat = String(r.values?.cat || "").trim(); if (!cat) return;
        const label = String(r.values?.label || "").trim();
        const lib = loadAffixLib();
        if (!lib[which]) lib[which] = {};
        const list = (lib[which][cat] || []).map(affixNorm);
        if (!list.some((it) => it.text === v)) list.push({ name: label, text: v });
        lib[which][cat] = list; saveAffixLib(lib);
        const h = loadAffixHistory(); h[which] = (h[which] || []).filter((x) => x !== v); saveAffixHistory(h);   // out of History now
        appendValue(v, true);   // saving a tag implies intent to use it → drop it straight into the build row
        activeCat = cat; renderCats(); renderVals();
    };

    let addInpRef = null;
    // Quick-add a tag straight into the active (non-History) category — type + Enter, or the ＋ button.
    const addToCat = (label, t) => {
        t = String(t || "").trim(); if (!t || activeCat === HISTORY) return;
        label = String(label || "").trim();
        const lib = loadAffixLib();
        if (!lib[which]) lib[which] = {};
        const list = (lib[which][activeCat] || []).map(affixNorm);
        if (!list.some((it) => it.text === t)) list.push({ name: label, text: t });
        lib[which][activeCat] = list; saveAffixLib(lib);
        appendValue(t, true);   // creating a tag implies intent to use it → drop it straight into the build row
        renderVals(); if (addInpRef) addInpRef.focus();   // keep the cursor in the add box to stack tags
    };

    const renderVals = () => {
        valCol.innerHTML = "";
        addInpRef = null;
        const q = query.trim().toLowerCase();
        const used = new Set(parts.map((p) => p.trim().toLowerCase()).filter(Boolean));   // tags already in the build row
        if (q) {   // SEARCH: matching saved presets across every category (by name · tag · category)
            const lib = loadAffixLib(), results = [];
            for (const cat of Object.keys(lib[which] || {})) for (const x of (lib[which][cat] || [])) {
                const it = affixNorm(x);
                if (it.name.toLowerCase().includes(q) || it.text.toLowerCase().includes(q) || cat.toLowerCase().includes(q)) results.push({ cat, it });
            }
            if (!results.length) { valCol.append(el("div", { fontSize: "11px", color: C.textMuted, padding: "10px", textAlign: "center" }, "no saved matches — press Enter to add it as a new value")); return; }
            for (const { cat, it } of results) {
                const label = `${it.name ? it.name + "  |  " : ""}${it.text}   ·  ${cat}`;
                valCol.append(rowEl(label, {
                    onClick: () => appendValue(it.text, true),
                    used: used.has(it.text.trim().toLowerCase()),
                    actions: [{ icon: "🗑", title: "Delete value", fn: () => { const l = loadAffixLib(); l[which][cat] = (l[which][cat] || []).map(affixNorm).filter((y) => !(y.text === it.text && y.name === it.name)); saveAffixLib(l); renderVals(); } }],
                }));
            }
            return;
        }
        const isHist = activeCat === HISTORY;
        // A non-History category gets a top "add a tag to this category" row (always, even when empty).
        if (!isHist) {
            const nameInp = el("input", { ...baseInputStyle, flex: "0 0 34%", minWidth: "0", padding: "5px 7px", fontSize: "12px" });
            nameInp.type = "text"; nameInp.placeholder = "name (optional)";
            const tagInp = el("input", { ...baseInputStyle, flex: "1 1 auto", minWidth: "0", padding: "5px 7px", fontSize: "12px" });
            tagInp.type = "text"; tagInp.placeholder = `tag for “${activeCat}”…`;
            const submit = () => addToCat(nameInp.value, tagInp.value);
            for (const inp of [nameInp, tagInp]) {
                inp.addEventListener("mousedown", stop);
                inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); submit(); } });
            }
            const addB = pillBtn("＋", "Add this tag (with its optional name) to the category", submit);
            const addRow = el("div", { display: "flex", gap: "6px", alignItems: "center", marginBottom: "5px" });
            addRow.append(nameInp, tagInp, addB);
            valCol.append(addRow); addInpRef = tagInp;
        }
        const items = isHist ? loadAffixHistory()[which] : (loadAffixLib()[which][activeCat] || []);
        if (!items.length) { valCol.append(el("div", { fontSize: "11px", color: C.textMuted, padding: "10px", textAlign: "center" }, isHist ? "no history yet — type a value above" : "no tags yet — add one above")); return; }
        for (const x of items) {
            if (isHist) {
                const v = String(x);
                valCol.append(rowEl(v, { onClick: () => appendValue(v, false), used: used.has(v.trim().toLowerCase()), actions: [{ icon: "🔖", title: "Save as preset (name + category)", fn: () => promote(v) }] }));
            } else {
                const it = affixNorm(x);
                const label = it.name ? `${it.name}  |  ${it.text}` : it.text;   // name first; only the tag is appended on click
                valCol.append(rowEl(label, {
                    onClick: () => appendValue(it.text, true),
                    used: used.has(it.text.trim().toLowerCase()),
                    actions: [{ icon: "🗑", title: "Delete value", fn: () => { const l = loadAffixLib(); l[which][activeCat] = (l[which][activeCat] || []).map(affixNorm).filter((y) => !(y.text === it.text && y.name === it.name)); saveAffixLib(l); renderVals(); } }],   // keep the category even when it's now empty
                }));
            }
        }
    };

    entry.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); const t = entry.value.trim(); if (t) { appendValue(t, false); entry.value = ""; query = ""; renderVals(); } }
        else if (e.key === "Escape") { e.preventDefault(); close(false); }
    });

    function close(apply) {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        if (apply) { setAffixTags(node, which, parts); node._pgWriteConfig(true); node._pgRefreshAffixPills(); }
    }
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(true); });

    renderCats(); renderVals(); renderBuild();
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    setTimeout(() => entry.focus(), 30);
}

// Upload a file to ComfyUI's input dir; returns { name, subfolder, type }.
async function uploadImage(file) {
    const body = new FormData();
    body.append("image", file);
    body.append("overwrite", "true");
    const resp = await fetch("/upload/image", { method: "POST", body });
    if (!resp.ok) throw new Error("upload failed: " + resp.status);
    const meta = await resp.json();
    // Stamp a one-shot cache token at upload time. Uploads use overwrite=true, so a replaced
    // image reuses the same /view URL — without this the browser would show the stale cached
    // bytes. A fresh _v busts the cache exactly once; re-renders of the same meta keep the
    // same URL and are served from cache (no disk re-read, no flicker). See viewUrl().
    if (meta && typeof meta === "object") meta._v = Date.now();
    return meta;
}
function viewUrl(meta) {
    if (!meta || !meta.name) return "";
    const p = new URLSearchParams({
        filename: meta.name || "", type: meta.type || "input",
        subfolder: meta.subfolder || "",
    });
    // Bust the cache ONLY when the upload actually changed (a new _v), not on every render.
    // Metas without _v (saved output/library/history files — immutable) stay fully cacheable.
    if (meta._v) p.set("v", String(meta._v));
    return "/view?" + p.toString();
}
// Stable (cacheable) variant — no random cache-buster. Used for library/preview thumbnails
// so the browser caches them instead of re-downloading the full-res image on every render
// or hover. (The loader still uses viewUrl with the buster to refresh a replaced upload.)
function viewUrlStable(meta) {
    if (!meta || !meta.name) return "";
    const p = new URLSearchParams({
        filename: meta.name || "", type: meta.type || "input", subfolder: meta.subfolder || "",
    });
    return "/view?" + p.toString();
}
// Re-encoded webp PREVIEW for card thumbnails + the preview frame: ComfyUI's /view re-encodes
// the source image as webp at the given quality, which is a fraction of the source PNG's bytes
// and far quicker to decode — so grids of images load fast instead of pulling multi-MB PNGs for
// 84px cards. Full resolution is still used for the click-to-zoom lightbox. Cacheable (no buster).
function viewUrlPreview(meta) {
    if (!meta || !meta.name) return "";
    // Our in-memory thumbnail route: a small webp, resized + encoded once in a thread executor and
    // cached in server RAM, so grids of thumbnails load fast and never block ComfyUI's event loop.
    const p = new URLSearchParams({
        filename: meta.name || "", type: meta.type || "input", subfolder: meta.subfolder || "", size: "320",
    });
    return "/prompt-generator/thumb?" + p.toString();
}
// Tiny shared LRU of DECODED preview images (no disk files). The browser's HTTP cache holds the
// bytes, but it can drop the decoded bitmap between renders; keeping the most-recent Image objects
// referenced here keeps them paint-ready, so paging back/forth or swapping Recent⇄Library and then
// hovering stays instant instead of re-decoding. Keyed by URL; shared across all nodes.
const _pgImgCache = new Map();
const PG_IMG_CACHE_CAP = 80;
const _pgWarmedUrls = new Set();         // every URL we've already requested this session (bytes in HTTP cache)
const _pgWarmInflight = new Set();       // hold refs so background fetches aren't GC-aborted mid-flight
const _pgIdle = (fn, t) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: t }) : setTimeout(fn, t));
function pgPrefetchImage(url) {
    if (!url) return;
    _pgWarmedUrls.add(url);
    if (_pgImgCache.has(url)) { const im = _pgImgCache.get(url); _pgImgCache.delete(url); _pgImgCache.set(url, im); return; }   // touch → most-recent
    const im = new Image();
    im.decoding = "async";
    im.src = url;
    im.decode?.().catch(() => {});
    _pgImgCache.set(url, im);
    while (_pgImgCache.size > PG_IMG_CACHE_CAP) _pgImgCache.delete(_pgImgCache.keys().next().value);   // evict oldest
}
// Warm a thumbnail's BYTES into the browser HTTP cache without keeping it decoded — so paging to a
// not-yet-visited page is instant (already downloaded, just a quick decode). Once per URL per session.
function pgWarmBytes(url) {
    if (!url || _pgWarmedUrls.has(url)) return;
    _pgWarmedUrls.add(url);
    const im = new Image();
    _pgWarmInflight.add(im);
    const done = () => _pgWarmInflight.delete(im);
    im.onload = done; im.onerror = done;
    im.decoding = "async";
    im.src = url;
}
// Background-warm a whole list of thumbnail URLs, a few per idle tick, so reloading makes ALL
// history pages ready to browse without swamping the initial load or the server's webp re-encode.
function pgWarmAll(urls) {
    const queue = [];
    for (const u of urls) if (u && !_pgWarmedUrls.has(u)) queue.push(u);
    if (!queue.length) return;
    let i = 0;
    const pump = () => {
        for (let n = 0; n < 4 && i < queue.length; n++, i++) pgWarmBytes(queue[i]);
        if (i < queue.length) _pgIdle(pump, 400);
    };
    _pgIdle(pump, 400);
}
// Annotated path string that folder_paths.get_annotated_filepath() understands.
// Encodes the folder type (e.g. "[output]") for non-input images (last-gen).
function annotatedName(meta) {
    if (!meta?.name) return "";
    const sub = meta.subfolder ? meta.subfolder + "/" : "";
    const base = sub + meta.name;
    return (meta.type && meta.type !== "input") ? `${base} [${meta.type}]` : base;
}

// Reverse of annotatedName(): parse "subfolder/name [type]" back into a { name, subfolder,
// type } meta so a stored image_ref can be rendered via viewUrl(). Returns null if empty.
function metaFromAnnotated(s) {
    s = String(s || "").trim();
    if (!s) return null;
    let type = "input";
    const m = s.match(/^(.*)\s+\[(\w+)\]$/);
    if (m) { s = m[1].trim(); type = m[2]; }
    const idx = s.lastIndexOf("/");
    const subfolder = idx >= 0 ? s.slice(0, idx) : "";
    const name = idx >= 0 ? s.slice(idx + 1) : s;
    return { name, subfolder, type };
}

// In-node image loader (drop/click) used for the Analyze Image modes.
function makeImageBox(node, onChange) {
    const box = el("div", {
        display: "none", flexDirection: "column", gap: "6px",
        border: `1px dashed ${C.accentBorder}`, borderRadius: "8px",
        background: C.input, padding: "10px", cursor: "pointer",
        alignItems: "center", justifyContent: "center", textAlign: "center",
        minHeight: "70px", boxSizing: "border-box",
    });
    const hint = el("div", { color: C.textMuted, fontSize: "12px", lineHeight: "1.4" },
        "🖼  Click or drop an image here\nfor vision analysis");
    hint.style.whiteSpace = "pre-line";
    const preview = el("img", {
        display: "none", maxWidth: "100%", maxHeight: "180px",
        borderRadius: "6px", objectFit: "contain",
    });
    const remove = el("div", {
        display: "none", color: C.textMuted, fontSize: "11px",
        textDecoration: "underline", marginTop: "2px", cursor: "pointer",
    }, "✕ Remove image");
    box.append(hint, preview, remove);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";

    const doUpload = async (file) => {
        if (!file) return;
        hint.textContent = "Uploading…";
        try {
            const meta = await uploadImage(file);
            onChange(meta);
        } catch (err) {
            hint.textContent = "Upload failed — click to retry";
        }
    };

    box.addEventListener("mousedown", stop);
    box.addEventListener("click", (e) => { stop(e); fileInput.click(); });
    // Barely-there hover lift on the image drop-zone (drag-highlight still overrides it).
    attachBoxHover(box, C.input, "hsl(220 12% 11%)");
    box.addEventListener("dragover", (e) => { e.preventDefault(); stop(e); box.style.background = C.accentSoft; });
    box.addEventListener("dragleave", (e) => { stop(e); box._pgApplyBg?.(); });
    box.addEventListener("drop", (e) => {
        e.preventDefault(); stop(e); box._pgApplyBg?.();
        const f = e.dataTransfer?.files?.[0];
        if (f) doUpload(f);
    });
    fileInput.addEventListener("change", (e) => { const f = e.target.files?.[0]; doUpload(f); });
    remove.addEventListener("mousedown", stop);
    remove.addEventListener("click", (e) => { stop(e); onChange(null); });

    return {
        el: box,
        // refresh preview from current meta
        refresh: (meta) => {
            if (meta?.name) {
                const url = viewUrl(meta);
                if (preview._pgSrc !== url) { preview._pgSrc = url; preview.src = url; }   // skip re-decode of the same image
                preview.style.display = "block";
                hint.style.display = "none";
                remove.style.display = "block";
            } else {
                preview._pgSrc = "";
                preview.removeAttribute("src");
                preview.style.display = "none";
                hint.style.display = "block";
                hint.textContent = "🖼  Click or drop an image here\nfor vision analysis";
                remove.style.display = "none";
            }
        },
        show: (visible) => { box.style.display = visible ? "flex" : "none"; },
    };
}

// Reusable segmented tab bar (div tabs — robust inside ComfyUI DOM widgets).
function makeTabBar(tabs, onSelect, opts = {}) {
    const small = !!opts.small;
    const bar = el("div", {
        display: "flex", width: "100%", boxSizing: "border-box",
        borderRadius: small ? "7px" : "8px", overflow: "hidden",
        minHeight: small ? "30px" : "38px",
        border: `1px solid ${opts.primary ? C.accentBorder : C.border}`,
        marginBottom: "6px", background: C.input, boxShadow: SHADOW_SOFT,
    });
    const els = {};
    tabs.forEach((t, i) => {
        const e = el("div", {
            flex: "1 1 " + (100 / tabs.length) + "%", textAlign: "center",
            padding: small ? "6px 4px" : "9px 4px", boxSizing: "border-box",
            cursor: "pointer", userSelect: "none",
            fontSize: small ? "12px" : "13px", fontWeight: "700", fontFamily: FONT,
            lineHeight: small ? "16px" : "20px", minHeight: small ? "16px" : "20px",
            background: C.input, color: C.textMuted,
            transition: "background .15s, color .15s, box-shadow .15s, filter .15s",
        }, t.label);
        if (i > 0) e.style.borderLeft = `1px solid ${C.border}`;
        attachTabHover(e);
        e.addEventListener("mousedown", stop);
        e.addEventListener("pointerdown", stop);
        e.addEventListener("click", (ev) => { stop(ev); onSelect(t.key); });
        els[t.key] = e;
        bar.appendChild(e);
    });
    const setActive = (key) => {
        for (const k in els) (k === key ? tabOn : tabOff)(els[k]);
    };
    return { bar, els, setActive };
}

// ====================================================================
app.registerExtension({
    name: "LlamaPromptGenerator",
    // ComfyUI Settings → "Llama Prompt Generator". These sync into the server-side
    // preference cache (the per-node fields cover llama path/port/args/model dirs).
    settings: [
        {
            id: "PromptManager.LLMBackend",
            category: ["Llama Prompt Generator", "Backend", "LLM Backend"],
            name: "LLM Backend",
            tooltip: "Choose the backend: llama.cpp (local llama-server, default) or Ollama.",
            type: "combo",
            options: ["llama.cpp", "ollama"],
            defaultValue: "llama.cpp",
            onChange(value) { savePref("llm_backend", value); },
        },
        {
            id: "PromptManager.OllamaUrl",
            category: ["Llama Prompt Generator", "Backend", "Ollama URL"],
            name: "Ollama URL",
            tooltip: "URL of the Ollama server (default: http://127.0.0.1:11434).",
            type: "text",
            defaultValue: "http://127.0.0.1:11434",
            onChange(value) { savePref("ollama_url", value); },
        },
        {
            id: "PromptManager.OllamaKeepAlive",
            category: ["Llama Prompt Generator", "Backend", "Ollama Keep Alive"],
            name: "Ollama Keep Alive",
            tooltip: "How long Ollama keeps the model loaded after a request: '5m', '30m', '1h', '0' (unload now), '-1' (forever).",
            type: "text",
            defaultValue: "5m",
            onChange(value) { savePref("ollama_keep_alive", value); },
        },
        {
            id: "PromptManager.CloseLlama",
            category: ["Llama Prompt Generator", "Backend", "Close llama-server on exit"],
            name: "Close llama-server on exit",
            tooltip: "Stop the llama.cpp server process when ComfyUI exits.",
            type: "boolean",
            defaultValue: true,
            onChange(value) { savePref("close_llama_on_exit", value); },
        },
    ],
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptGeneratorPro") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            buildPro(this);
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = onConfigure?.apply(this, arguments);
            // The 'config' widget value has been restored by ComfyUI by now.
            requestAnimationFrame(() => {
                // Re-assert the node's theme color so a shared/downloaded workflow always
                // shows the same look, even if it saved a different bgcolor/color.
                try { this.bgcolor = NODE_BG; this.color = NODE_BG; } catch {}
                this._pgReadConfig?.();
                this._pgRefreshModelLists?.();
                this._pgRefreshPresets?.();
                this._pgApplyState?.();
                this._pgApplyView?.();
            });
            return r;
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            size[0] = Math.max(330, size[0]);   // size IS this.size, so node.size[0] is now clamped
            // Keep the DOM widget element glued to the node's live width as it's dragged (otherwise
            // ComfyUI's shrink-to-fit container leaves the content at its own width — see _pgSyncWidth).
            try { this._pgSyncWidth?.(); } catch {}
            // After the user settles a resize, refit the height to content ONLY when the WIDTH
            // changed (the grid reflowed into more/fewer columns) — so widening snaps the node
            // shorter to match. Pure vertical drags are left alone, so the user can freely make
            // the node taller without it collapsing back to content height.
            const w = size[0];
            if (this._pgResizeFitT) clearTimeout(this._pgResizeFitT);
            this._pgResizeFitT = setTimeout(() => {
                if (Math.abs((this._pgLastFitW ?? w) - w) > 2) {
                    this._pgLastFitW = w;
                    // Width changed → recompute the page size (columns × rows) so a narrow node
                    // shows fewer items, then refit height to the new, shorter grid.
                    if (this._pgState?._view === "prompts") { try { this._pgLibRender?.(); } catch {} }
                    try { this._pgReflow?.(); } catch {}
                } else this._pgLastFitW = w;
            }, 220);
            return onResize ? onResize.apply(this, arguments) : size;
        };

        // Opening ComfyUI's right-click menu (and node-property changes from it) can
        // desync the DOM-widget element from the node body, leaving controls poking
        // outside the border. Re-apply our view + reflow shortly after so it self-corrects.
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            const r = getExtraMenuOptions?.apply(this, arguments);
            for (const t of [150, 400]) {
                setTimeout(() => { try { this._pgApplyView?.(); this._pgReflow?.(); } catch {} }, t);
            }
            return r;
        };

        // Receive the generated output + token usage back from the server.
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const out = message?.pg_output?.[0];
            const ranText = message?.pg_ran?.[0];   // image-render runs (🖼 buttons) carry the text used, with no box update
            // Only LOG this graph run to the library if the node's OUTPUT is wired into the workflow — i.e. its
            // text actually contributed. An UNLINKED node still executes (OUTPUT_NODE) but its text generated
            // nothing here, so recording it would add a fake/orphan gallery entry (no image, unused prompt).
            // (The ✨ Generate / ⟳ Refine buttons record directly, out-of-graph, so crafting with an unlinked
            // node still works — this gate is only for the graph-run path.)
            const _outWired = (this.outputs || []).some((o) => o && o.name === "output" && o.links && o.links.length);
            if (_outWired) this._pgRecordPrompt?.(out !== undefined ? out : (typeof ranText === "string" ? ranText : undefined));   // record the text the node SENT OUT (what generated the image)
            this._pgSetRunning?.(false);
            const usage = message?.pg_usage?.[0];
            if (out !== undefined) this._pgSetOutput?.(out);
            if (usage) this._pgSetUsage?.(usage);
        };

        // Stop the status poll when the node is removed.
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (this._pgStatusTimer) { clearInterval(this._pgStatusTimer); this._pgStatusTimer = null; }
            if (this._pgResizeFitT) { clearTimeout(this._pgResizeFitT); this._pgResizeFitT = null; }
            if (this._pgLibLockT) { clearTimeout(this._pgLibLockT); this._pgLibLockT = null; }
            if (this._pgRootRO) { try { this._pgRootRO.disconnect(); } catch {} this._pgRootRO = null; }
            if (this._pgResDropCleanup) { try { this._pgResDropCleanup(); } catch {} this._pgResDropCleanup = null; }
            if (this._pgRunBoxCleanup) { try { this._pgRunBoxCleanup(); } catch {} this._pgRunBoxCleanup = null; }
            return onRemoved?.apply(this, arguments);
        };
    },
});

function buildPro(node) {
    node._pgState = { ...DEFAULTS };
    node._pgControls = {};
    node.serialize_widgets = true;

    const configWidget = () => node.widgets?.find((w) => w.name === "config");

    // Resolve initial/loaded state. Precedence (low → high):
    //   DEFAULTS  <  last-used snapshot (sticky)  <  this node's saved config.
    // A brand-new node has an empty saved config, so it inherits the last-used
    // snapshot. A node loaded from a saved workflow keeps its own stored values.
    node._pgReadConfig = function () {
        const w = configWidget();
        let parsed = {};
        if (w) {
            try {
                const p = JSON.parse(w.value || "{}");
                if (p && typeof p === "object") parsed = p;
            } catch { /* ignore */ }
        }
        node._pgState = { ...DEFAULTS, ...loadLastConfig(), ...parsed };
    };

    // Write _pgState into the hidden config widget (persisted in the workflow)
    // AND into the browser-local last-used snapshot (sticky across new nodes).
    let writeTimer = null;
    // A persistable snapshot of the state: strips transient placeholder list-entries
    // ("Ollama not running…", "No models…") so a workflow saved while the backend is down
    // doesn't store one as the model. The LIVE state keeps showing it (helpful in the UI);
    // on reload model is blank and _pgRefreshModelLists picks a real default.
    const _cleanForSave = (s) => {
        const o = { ...s };
        if (/not running|^No /i.test(String(o.model || ""))) o.model = "";
        return o;
    };
    node._pgWriteConfig = function (immediate) {
        const flush = () => {
            const clean = _cleanForSave(node._pgState);
            const w = configWidget();
            if (w) w.value = JSON.stringify(clean);
            saveLastConfig(clean);
        };
        if (immediate) { if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; } flush(); return; }
        if (writeTimer) clearTimeout(writeTimer);
        writeTimer = setTimeout(flush, 150);
    };

    const setVal = (key, val) => { node._pgState[key] = val; node._pgWriteConfig(); };

    // ---- root container ----
    const root = el("div", {
        display: "flex", flexDirection: "column", gap: "7px",
        // Wider side padding so controls keep breathing room from the node edge when the node is
        // dragged narrow (rows used to butt right up against the rounded border).
        padding: "8px 12px 22px 12px", width: "100%", boxSizing: "border-box",
        fontFamily: FONT, overflow: "hidden",
        background: nodeBg(GRAD_NODE, 0.035), borderRadius: "8px",
    });
    forwardWheel(node, root);
    node._pgRoot = root;
    // Match the canvas-drawn node body/title to the dark-grey theme so the whole node
    // reads as one piece (the DOM root above carries the white-sheen gradient).
    try { node.bgcolor = NODE_BG; node.color = NODE_BG; } catch {}

    // ---- top toggle (Generator | Options) ----
    // NOTE: use <div> tabs (not <button>) with a real flex-basis. Inside ComfyUI's
    // DOM-widget overlay, <button> flex items with flex-basis:0 can collapse to 0
    // height and render invisibly — divs with explicit padding always show.
    const toggleBar = el("div", {
        display: "flex", width: "100%", boxSizing: "border-box",
        borderRadius: "8px", overflow: "hidden", minHeight: "38px",
        border: `1px solid ${C.border}`, marginBottom: "0", flexShrink: "0",
        background: C.input, boxShadow: SHADOW_SOFT,
    });
    // Sub-navigation lives INSIDE the main toggle buttons now (the old open/closeable
    // sub-tab bar is gone — less clutter). Each button has a ‹ (left sub-section) and
    // › (right sub-section) with big hit zones, a center area that switches to the view,
    // and a caption showing the active sub-section.
    const SUBVIEWS = {
        generator: { key: "_genView", order: ["prompt", "sysprompt", "resolution"],
                     labels: { prompt: "Prompt", sysprompt: "System Prompt", resolution: "Resolution" } },
        // Prompts has no recent/library sub-sections (that duplicated the scope picker). Instead its
        // arrows/scroll cycle the browse SCOPES (History → All → ⭐ → categories) — see scopeNav below.
        prompts:   { scopeNav: true },
        options:   { key: "_optView", left: "llm", right: "settings",
                     labels: { llm: "LLM", settings: "LLM Settings" } },
    };
    node._pgTabSubUpdaters = [];
    node._pgMainTabs = [];   // {view, titleEl, center} for the shared title-fitter
    const mkTab = (label, view) => {
        const cfg = SUBVIEWS[view];
        const t = el("div", {
            flex: "1 1 33%", display: "flex", alignItems: "stretch",
            boxSizing: "border-box", cursor: "pointer", userSelect: "none", minHeight: "44px",
            background: C.input, color: C.textMuted, fontFamily: FONT,
            position: "relative", overflow: "hidden",
            transition: "background .15s, color .15s, box-shadow .15s, filter .15s",
        });
        attachTabHover(t);

        // Switch to this view (optionally jumping to a specific sub-section).
        const go = (sub) => {
            node._pgState._view = view; setVal("_view", view);
            if (sub && cfg.key) { node._pgState[cfg.key] = sub; setVal(cfg.key, sub); }
            node._pgApplyView();
        };

        // Ordered list of this tab's sub-sections — arrows step through it and WRAP,
        // so ‹/› cycle endlessly (e.g. Prompt → System Prompt → Prompt …).
        const order = cfg.scopeNav ? null : (cfg.order || [cfg.left, cfg.right]);
        const stepSub = (dir) => {
            const cur = node._pgState[cfg.key];
            let i = order.indexOf(cur);
            if (i < 0) i = 0;
            return order[(i + dir + order.length) % order.length];
        };
        // Unified step for arrows + scroll. Regular tabs cycle their two sub-sections; the Prompts
        // (scopeNav) tab switches to itself and cycles the browse scopes via the late-bound hook.
        const step = (dir) => {
            if (cfg.scopeNav) {
                node._pgState._view = view; setVal("_view", view);
                node._pgApplyView();
                node._pgScopeStep?.(dir);
            } else {
                go(stepSub(dir));
            }
        };
        // Clean arrow zone: a thin separator line marks the column (always visible), and the
        // glyph sits in a small rounded chip that lights up on hover — no chunky grey block.
        const mkArrow = (glyph, dir) => {
            const a = el("div", {
                // Always visible on EVERY tab so you can jump straight to another menu's sub-section
                // in one click (no "click into the tab, then click the arrow"). The title text itself
                // auto-shrinks to fit (see fitTitle) rather than these columns getting squeezed.
                flex: "0 0 auto", width: "32px", display: "flex", position: "relative", zIndex: "1",
                alignItems: "center", justifyContent: "center", cursor: "pointer",
                transition: "background .12s",
                [dir < 0 ? "borderRight" : "borderLeft"]: "1px solid hsl(220 8% 13%)",   // splitter — a touch darker than C.border
            });
            const chip = el("div", {
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "14px", fontWeight: "700", opacity: "0.5", transition: "opacity .12s",
            }, glyph);
            a.appendChild(chip);
            a.title = cfg.scopeNav ? (dir < 0 ? "Previous scope" : "Next scope") : (dir < 0 ? "Previous section" : "Next section");
            a.addEventListener("mousedown", stop);
            // Hover fills the WHOLE arrow column (down to the bottom hairline), not a chip.
            a.addEventListener("mouseenter", () => { chip.style.opacity = "1"; a.style.background = "rgba(255,255,255,0.05)"; });
            a.addEventListener("mouseleave", () => { chip.style.opacity = "0.5"; a.style.background = "transparent"; });
            a.addEventListener("click", (e) => { stop(e); step(dir); });
            return a;
        };
        const arrowL = mkArrow("‹", -1);
        const arrowR = mkArrow("›", +1);

        // Center: view title + caption of the active sub-section. Clicking it just
        // switches to this view (keeping whatever sub-section was last active).
        // overflow visible (not hidden) so that if the label is STILL too wide at its smallest
        // size, it bleeds over the arrow backgrounds instead of being chopped. The label sits on a
        // higher layer than the arrows (z-index below) and is click-through (pointerEvents none) so
        // the arrows underneath stay fully clickable.
        const center = el("div", {
            flex: "1 1 auto", minWidth: "0", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", padding: "2px 2px",
            textAlign: "center", overflow: "visible", position: "relative", zIndex: "2",
        });
        const titleEl = el("div", { fontSize: "13px", fontWeight: "700", lineHeight: "16px", whiteSpace: "nowrap", pointerEvents: "none" }, label);
        const capEl = el("div", { fontSize: "9.5px", fontWeight: "600", opacity: "0.6", lineHeight: "12px", whiteSpace: "nowrap", textTransform: "lowercase", letterSpacing: "0.2px", marginTop: "2px", pointerEvents: "none" }, "");
        center.append(titleEl, capEl);
        center.addEventListener("mousedown", stop);
        center.addEventListener("click", (e) => { stop(e); go(null); });

        t.append(arrowL, center, arrowR);

        // Scroll anywhere over the whole button to step its sub-sections — a no-click alternative
        // to the ‹ › arrows (scrolling an inactive tab also switches to it, like clicking an arrow).
        // preventDefault stops the graph canvas from zooming; a short cooldown stops trackpad/inertia
        // wheel-event storms from cycling several windows per gesture.
        let wheelLockT = 0;
        t.addEventListener("wheel", (e) => {
            e.preventDefault(); e.stopPropagation();
            const now = performance.now();
            if (now - wheelLockT < 220) return;
            wheelLockT = now;
            step(e.deltaY > 0 ? +1 : -1);
        }, { passive: false });

        // Register for the shared title-fitter (defined once all tabs exist). Titles shrink to fit
        // rather than clip; the two INACTIVE tabs are then sized in lockstep to one common size so
        // they read as a uniform pair, while the active tab fits independently. See _pgFitMainTabs.
        node._pgMainTabs.push({ view, titleEl, center });

        // Reflect the active sub-section in the caption. Arrows stay visible on every tab.
        const updateSub = () => {
            capEl.textContent = cfg.scopeNav ? (node._pgScopeLabel?.() || "") : (cfg.labels[node._pgState[cfg.key]] || "");
        };
        node._pgTabSubUpdaters.push(updateSub);

        t._view = view;
        t._pgMainTab = true;   // gets the radial top-shine when selected (see tabOn)
        return t;
    };
    const tabGen = mkTab("Generator", "generator");
    const tabPrompts = mkTab("Prompts", "prompts");
    const tabOpt = mkTab("Options", "options");
    tabPrompts.style.borderLeft = `1px solid ${C.border}`;
    tabOpt.style.borderLeft = `1px solid ${C.border}`;
    // Seed the active state inline so the bar is visible even before applyView runs.
    tabOn(tabGen);
    toggleBar.append(tabGen, tabPrompts, tabOpt);
    root.appendChild(toggleBar);

    // ---- shared main-tab title fitter ----
    // Each title shrinks (13→10px floor) to fit its button instead of clipping. The two INACTIVE
    // tabs then snap to a single common size (the smallest needed among them) so they read as a
    // uniform pair; the active tab keeps its own independent fit. Font-size changes don't alter the
    // measured button width, so observing the centers can't feed back into a loop.
    {
        const BASE = 13, MIN = 10;
        const needPx = (t) => {
            t.titleEl.style.fontSize = BASE + "px";
            const avail = t.center.clientWidth - 4;   // minus the 2px horizontal padding each side
            if (avail <= 0) return BASE;
            let px = BASE;
            while (t.titleEl.scrollWidth > avail && px > MIN) { px -= 0.5; t.titleEl.style.fontSize = px + "px"; }
            return px;
        };
        node._pgFitMainTabs = () => {
            const tabs = node._pgMainTabs || [];
            const active = node._pgState._view;
            let inactiveMin = BASE;
            for (const t of tabs) if (t.view !== active) inactiveMin = Math.min(inactiveMin, needPx(t));
            for (const t of tabs) {
                if (t.view === active) needPx(t);                     // active fits on its own
                else t.titleEl.style.fontSize = inactiveMin + "px";   // inactive pair share one size
            }
        };
        try { const ro = new ResizeObserver(() => node._pgFitMainTabs()); for (const t of node._pgMainTabs) ro.observe(t.center); } catch {}
        requestAnimationFrame(() => node._pgFitMainTabs());
    }

    // ---- Seed / Status visibility toggles (small pills, like the output mini-buttons) ----
    // Seed   → show/hide the native seed + control_after_generate widgets.
    // Status → show/hide the llama/Model/MMPROJ/System-Prompt status bar.
    node._pgTopToggleRefresh = [];
    const mkTopToggle = (label, key, title, onToggle, onBg) => {
        const b = el("div", {
            cursor: "pointer", userSelect: "none", fontSize: "11px", fontWeight: "600",
            color: C.text, border: "none", borderRadius: "6px", padding: "4px 11px",
            background: GRAD_BTN, flex: "0 0 auto", transition: "background .15s, color .15s",
            textTransform: "uppercase", letterSpacing: "0.5px",
        }, label);
        if (title) b.title = title;
        const isOn = () => node._pgState[key] !== false;
        // ON = medium dark-grey solid fill (not bright accent blue); OFF = quiet dark.
        const ON_BG = onBg || "hsl(220 6% 30%)";
        const refresh = () => { const on = isOn(); b.style.background = on ? ON_BG : GRAD_BTN; b.style.color = on ? "hsl(0 0% 94%)" : C.textMuted; };
        b.addEventListener("mousedown", stop);
        b.addEventListener("mouseenter", () => { if (!isOn()) b.style.background = GRAD_BTN_HI; });
        b.addEventListener("mouseleave", refresh);
        b.addEventListener("click", (e) => { stop(e); const v = !isOn(); node._pgState[key] = v; setVal(key, v); refresh(); node._pgApplyView(); node._pgReflow(); onToggle?.(v); });
        refresh();
        node._pgTopToggleRefresh.push(refresh);
        return b;
    };
    const topToggleRow = el("div", { display: "flex", gap: "6px", alignItems: "center", margin: "2px 0 2px", flexShrink: "0" });
    // Bypass pill — same visuals as Seed/Status, identical function to the Execution-row
    // Bypass: toggles _bypass and syncs the exec icon/toggle + node dim via _pgRefreshBypass.
    const bypassTop = mkTopToggle("Skip LLM", "_bypass", "Bypass node (skip the LLM, pass the prompt straight through)",
        (v) => { node._pgControls._bypass?.set?.(v); node._pgRefreshBypass?.(); },
        "hsl(0 0% 11% / 0.85)");   // active Bypass pill: ~90% black, 15% transparent
    bypassTop.style.marginLeft = "auto";   // push to the far right
    // RES — quick-jump pill to the Generator ▸ Resolution picker (a nav button, not a toggle).
    const resNavBtn = el("div", {
        cursor: "pointer", userSelect: "none", fontSize: "11px", fontWeight: "600",
        color: C.textMuted, border: "none", borderRadius: "6px", padding: "4px 11px",
        background: GRAD_BTN, flex: "0 0 auto", transition: "background .15s, color .15s",
        textTransform: "uppercase", letterSpacing: "0.5px",
    }, "Res");
    resNavBtn.title = "Open the Resolution picker (Generator ▸ Resolution)";
    resNavBtn.addEventListener("mousedown", stop);
    resNavBtn.addEventListener("mouseenter", () => { resNavBtn.style.background = GRAD_BTN_HI; resNavBtn.style.color = C.text; });
    resNavBtn.addEventListener("mouseleave", () => { resNavBtn.style.background = GRAD_BTN; resNavBtn.style.color = C.textMuted; });
    resNavBtn.addEventListener("click", (e) => { stop(e); node._pgOpenResolution?.(); });
    // GEN — quick-jump pill to the Generator ▸ Prompt view (mirrors the RES pill).
    const genNavBtn = el("div", {
        cursor: "pointer", userSelect: "none", fontSize: "11px", fontWeight: "600",
        color: C.textMuted, border: "none", borderRadius: "6px", padding: "4px 11px",
        background: GRAD_BTN, flex: "0 0 auto", transition: "background .15s, color .15s",
        textTransform: "uppercase", letterSpacing: "0.5px",
    }, "Gen");
    genNavBtn.title = "Open the Generator ▸ Prompt view";
    genNavBtn.addEventListener("mousedown", stop);
    genNavBtn.addEventListener("mouseenter", () => { genNavBtn.style.background = GRAD_BTN_HI; genNavBtn.style.color = C.text; });
    genNavBtn.addEventListener("mouseleave", () => { genNavBtn.style.background = GRAD_BTN; genNavBtn.style.color = C.textMuted; });
    genNavBtn.addEventListener("click", (e) => { stop(e); node._pgOpenGenerator?.(); });
    topToggleRow.append(
        mkTopToggle("Seed", "_showSeed", "Show/hide the seed + control_after_generate row"),
        mkTopToggle("Status", "_showStatus", "Show/hide the model status bar"),
        genNavBtn,
        resNavBtn,
        bypassTop,
    );
    node._pgTopToggleRow = topToggleRow;
    // Mounted later (just under the status bar, ABOVE the toggle-bar divider) — see below.

    // ---- panels ----
    // flexShrink:0 keeps the panels at their natural height inside the (height-constrained,
    // overflow-hidden) root flex column, so children never get squished when ComfyUI
    // transiently sizes the node smaller than its content.
    const genPanel = el("div", { display: "flex", flexDirection: "column", gap: "4px", flexShrink: "0" });
    const optPanel = el("div", { display: "flex", flexDirection: "column", gap: "4px", flexShrink: "0" });
    const libPanel = el("div", { display: "none", flexDirection: "column", gap: "4px", flexShrink: "0" });
    root.append(genPanel, libPanel, optPanel);

    const reg = (name, ctrl) => { node._pgControls[name] = ctrl; return ctrl; };

    // Is the currently-selected preset flagged as a vision preset?
    node._pgActivePresetVision = () => !!node._pgPresetMap?.get(node._pgState.override_system_prompt)?.vision;
    // The effective task depends on which dropdown is showing. In "Preset" view a plain
    // preset is a text-enhance run (no image), but a VISION preset analyzes an uploaded
    // image (like the Ideogram modes). In "Mode" view, the Mode dropdown decides.
    node._pgEffectiveMode = () => {
        if (node._pgState._modeView === "presets")
            return node._pgActivePresetVision() ? "Analyze Image with Prompt" : "Enhance Prompt (Text)";
        return node._pgState.mode;
    };

    // ================= GENERATOR PANEL =================
    {
        // ---- sub-tab bar: Prompt | System Prompt ----
        const genTabs = makeTabBar(
            [{ label: "Prompt", key: "prompt" }, { label: "System Prompt", key: "sysprompt" }, { label: "Resolution", key: "resolution" }],
            (key) => { node._pgState._genView = key; setVal("_genView", key); node._pgApplyGenView(); },
            { small: true }
        );
        node._pgGenTabsBar = genTabs.bar;   // kept for setActive() calls; no longer in the DOM
        // Sub-tab bar removed — sub-navigation now lives in the main Generator button.
        // (No splitter under the main tabs — it was unnecessary clutter.)

        // =========== Prompt sub-panel ===========
        const promptPanel = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
        // Prompt-input sync registry (main box + theater box stay mirrored).
        node._pgPromptInputs = [];
        node._pgSyncPrompt = (v, srcEl) => { setVal("prompt", v); for (const p of node._pgPromptInputs) if (p.el !== srcEl) p.set(v); node._pgUpdateInputCount?.(); };
        node._pgSetPromptAll = (v) => { setVal("prompt", v); for (const p of node._pgPromptInputs) p.set(v); node._pgUpdateInputCount?.(); };
        // Live char + word count under each INPUT prompt box (mirrors the output box's char count).
        node._pgInputCounts = [];
        node._pgUpdateInputCount = () => {
            const v = String(node._pgState.prompt || "");
            const words = (v.match(/\S+/g) || []).length;
            const txt = v.length ? `${v.length.toLocaleString()} chars · ${words.toLocaleString()} word${words === 1 ? "" : "s"}` : "";
            for (const c of node._pgInputCounts) c.textContent = txt;
        };
        // ---- Prefix / Suffix affixes ----
        // A SINGLE shared prefix/suffix that ALWAYS wraps the emitted prompt (", " joined), applied
        // wherever the prompt is actually used: downstream output + image render (Python side), and
        // Copy/Save (here). The LLM only ever sees the core, so a prefix (e.g. a LoRA trigger) survives
        // Generate / Refine. The pills sit UNDER the input box (with its char·word count) AND in the
        // output meta row — one shared value, in BOTH the main and Expanded views.
        node._pgApplyAffixes = (text) => {
            const pre = String(node._pgState.prefix || "").trim();
            const core = String(text ?? "").trim();
            const suf = String(node._pgState.suffix || "").trim();
            return [pre, core, suf].filter((s) => s.length).join(", ");
        };
        // Each prefix/suffix is shown as ONE pill PER tag (not a single combined pill): a leading
        // "＋ Prefix/Suffix" add-pill (opens the browser/builder), then one compact pill per tag. Each
        // tag pill shows the first few chars (hover → full text via title) and carries its own ✕ that
        // removes just that tag. Pill groups are dynamic, so refresh rebuilds them rather than relabeling.
        const AFFIX_PILL_CHARS = 6;   // visible chars per tag pill before truncating with "…"
        // The ＋ add / open-builder pill for a side. Created once and placed FIRST in the row (prefix
        // then suffix) so the two add-pills always sit together, ahead of any tag pills.
        const mkAffixAddPill = (which) => {
            const name = which === "prefix" ? "Prefix" : "Suffix";
            const where = which === "prefix" ? "BEFORE" : "AFTER";
            const pill = pillBtn(`＋ ${name}`,
                `Text added ${where} the prompt whenever it's used (image · downstream · copy · save). Survives LLM refine. Click to browse / build.`,
                () => openAffixBrowser(node, which));
            pill.style.display = "inline-flex"; pill.style.alignItems = "center"; pill.style.gap = "6px";
            // Tint the whole "＋ Prefix/Suffix" label to EXACTLY match the per-tag P/S badges: same hue AND the
            // same 0.7 faintness (the badge uses opacity 0.7, so bake 0.7 alpha into the text color here).
            pill.style.color = which === "prefix" ? "hsl(0 45% 60% / 0.82)" : "hsl(210 56% 82% / 0.82)";
            // ✕ on the right → clear ALL tags for this side. Shown only when there's something to clear. Kept its
            // own neutral color so it doesn't inherit the tinted label.
            const xEl = el("span", { cursor: "pointer", opacity: "0.6", fontWeight: "700", lineHeight: "1", transition: "opacity .12s", color: C.textMuted }, "✕");
            xEl.title = `Clear all ${which === "prefix" ? "Prefixes" : "Suffixes"}`;
            xEl.style.display = affixTags(node, which).length ? "" : "none";
            xEl.addEventListener("mouseenter", () => { xEl.style.opacity = "1"; });
            xEl.addEventListener("mouseleave", () => { xEl.style.opacity = "0.6"; });
            xEl.addEventListener("mousedown", stop);
            xEl.addEventListener("click", (e) => {
                stop(e);   // don't open the builder — clear the whole side
                setAffixTags(node, which, []);
                node._pgWriteConfig(true);
                node._pgRefreshAffixPills();
            });
            pill.append(xEl);
            node._pgAffixAddPills.push({ xEl, which });
            return pill;
        };
        node._pgBuildAffixGroup = (container, which) => {
            container.innerHTML = "";
            const tags = affixTags(node, which);
            tags.forEach((tag, i) => {
                const short = tag.length > AFFIX_PILL_CHARS ? tag.slice(0, AFFIX_PILL_CHARS) + "…" : tag;
                const pill = pillBtn("", "", () => openAffixBrowser(node, which));
                pill.title = tag;   // hover → full tag text
                pill.style.display = "inline-flex"; pill.style.alignItems = "center"; pill.style.gap = "5px";
                // Faint side marker so prefix vs suffix tags are distinguishable at a glance: red "P" / blue "S".
                const badge = el("span", { flex: "0 0 auto", fontWeight: "700", fontSize: "10px", opacity: "0.82",
                    color: which === "prefix" ? "hsl(0 45% 60%)" : "hsl(210 56% 82%)" }, which === "prefix" ? "P" : "S");
                const labelEl = el("span", {}, short);
                const xEl = el("span", { cursor: "pointer", opacity: "0.6", fontWeight: "700", lineHeight: "1", transition: "opacity .12s" }, "✕");
                xEl.title = `Remove “${tag}”`;
                xEl.addEventListener("mouseenter", () => { xEl.style.opacity = "1"; });
                xEl.addEventListener("mouseleave", () => { xEl.style.opacity = "0.6"; });
                xEl.addEventListener("mousedown", stop);
                xEl.addEventListener("click", (e) => {
                    stop(e);   // don't open the builder — just drop this one tag
                    const rest = affixTags(node, which);
                    rest.splice(i, 1);
                    setAffixTags(node, which, rest);
                    node._pgWriteConfig(true);
                    node._pgRefreshAffixPills();
                });
                pill.append(badge, labelEl, xEl);
                container.append(pill);
            });
        };
        node._pgAffixGroups = [];   // {el, which} tag containers to rebuild on refresh
        node._pgAffixAddPills = [];   // {xEl, which} add-pills whose "clear all" ✕ toggles with tag count
        node._pgRefreshAffixPills = () => {
            for (const g of node._pgAffixGroups) node._pgBuildAffixGroup(g.el, g.which);
            for (const a of node._pgAffixAddPills) a.xEl.style.display = affixTags(node, a.which).length ? "" : "none";
        };
        // A per-side pill GROUP (used in BOTH the Input and Output rows): one pill per tag. The ＋ add-pill
        // is created separately (mkAffixAddPill) and placed ahead of both groups.
        const mkAffixGroup = (which) => {
            const g = el("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" });
            node._pgAffixGroups.push({ el: g, which });
            node._pgBuildAffixGroup(g, which);
            return g;
        };

        // The row UNDER each input box: prefix/suffix pills (left) + char·word count (right) — mirrors the
        // output box's meta row, in both the main and Expanded views.
        const mkInputCount = () => {
            const c = el("div", { fontSize: "10px", color: C.textMuted, textAlign: "right", padding: "1px 2px 2px", userSelect: "none", minHeight: "12px", whiteSpace: "nowrap", flex: "0 0 auto" }, "");
            node._pgInputCounts.push(c);
            const affixGroup = el("div", { display: "flex", alignItems: "center", gap: "10px", flex: "1 1 auto", minWidth: "0", flexWrap: "wrap", rowGap: "4px" });
            affixGroup.append(mkAffixAddPill("prefix"), mkAffixAddPill("suffix"), mkAffixGroup("prefix"), mkAffixGroup("suffix"));
            const row = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", rowGap: "4px", padding: "1px 2px 0" });
            row.append(affixGroup, c);
            return row;
        };
        node._pgMkInputCount = mkInputCount;

        // ---- Mode / Preset selector (factory — mirrored in the theater view) ----
        node._pgModeSelects = []; node._pgQuickSelects = []; node._pgModeRows = [];
        node._pgSetModeAll = (v) => { for (const m of node._pgModeSelects) m.set(v); };
        const buildModeRow = () => {
            const modeSel = makeSelect(MODES, (v) => {
                setVal("mode", v);
                for (const m of node._pgModeSelects) if (m !== modeSel) m.set(v);
                node._pgUpdateImageBox?.(); node._pgReflow();
            }, null, { visionOf: (v) => IMAGE_MODES.has(v), wheelCycle: true });
            const quickSel = makeSelect([PRESET_MODE], (v) => {
                if (v === PRESET_MODE) {            // use the System Prompt text field as-is
                    node._pgState.override_system_prompt = NONE_PRESET;
                    if (node._pgState.system_prompt_mode === "none") node._pgState.system_prompt_mode = "replace";
                    node._pgWriteConfig(true);
                    node._pgControls.system_prompt_mode?.set?.(node._pgState.system_prompt_mode);
                    node._pgControls.override_system_prompt?.set?.(NONE_PRESET);
                    for (const q of node._pgQuickSelects) q.set(PRESET_MODE);
                    node._pgUpdatePresetUI?.(); node._pgUpdateImageBox?.(); node._pgReflow();
                    return;
                }
                if (v === NO_SYS_PROMPT) { node._pgApplyPreset?.(NO_SYS_PROMPT); node._pgReflow(); return; }
                if (!v || !node._pgPresetMap?.get(v)?.deletable) return;
                node._pgApplyPreset?.(v);          // loads the preset text into the box
                node._pgReflow();
            }, (v) => v === NO_SYS_PROMPT ? "None" : v,   // show the sentinel as just "None"
               { visionOf: (v) => !!node._pgPresetMap?.get(v)?.vision, searchable: true, wheelCycle: true });
            const lbl = el("span", { color: C.textMuted, fontSize: "12px", flex: "0 0 auto", minWidth: "70px", cursor: "pointer", userSelect: "none", transition: "color .15s" });
            lbl.title = "Click to switch between Modes and your saved Presets";
            lbl.addEventListener("mousedown", stop);
            lbl.addEventListener("click", (e) => { stop(e); node._pgState._modeView = node._pgState._modeView === "presets" ? "modes" : "presets"; setVal("_modeView", node._pgState._modeView); node._pgSyncModePreset?.(); node._pgApplyModeView(); node._pgUpdateImageBox?.(); node._pgReflow(); });
            const row = el("div", { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0", width: "100%", boxSizing: "border-box" });
            row.append(lbl, modeSel.el, quickSel.el);
            // Interactive label: white on row hover, and stays white while a dropdown is open.
            let lblHover = false, lblActive = false;
            const lblSync = () => { lbl.style.color = (lblHover || lblActive) ? C.text : C.textMuted; };
            row.addEventListener("mouseenter", () => { lblHover = true; lblSync(); });
            row.addEventListener("mouseleave", () => { lblHover = false; lblSync(); });
            row.addEventListener("pg-active", (e) => { lblActive = !!e.detail; lblSync(); });
            node._pgModeSelects.push(modeSel); node._pgQuickSelects.push(quickSel);
            node._pgModeRows.push({ lbl, modeSel, quickSel });
            return { row, modeSel, quickSel };
        };
        node._pgBuildModeRow = buildModeRow;

        const mainModeRow = buildModeRow();
        promptPanel.appendChild(mainModeRow.row);

        // splitter
        promptPanel.appendChild(el("div", { borderTop: `1px solid ${C.border}`, margin: "4px 0 2px" }));

        node._pgApplyModeView = () => {
            const v = node._pgState._modeView === "presets" ? "presets" : "modes";
            for (const r of node._pgModeRows) {
                r.modeSel.el.style.display = v === "modes" ? "" : "none";
                r.quickSel.el.style.display = v === "presets" ? "" : "none";
                r.lbl.textContent = v === "presets" ? "Preset ⇄" : "Mode ⇄";
            }
        };
        // In MODE view a selected preset must NOT keep dominating the system-prompt box — the backend
        // treats that box as the source of truth, so the preset would override the chosen mode. When
        // entering MODE view, if the box still holds the active preset's text, stash the preset + clear
        // it so the mode's own system prompt is used; restore it on switching back to Preset view.
        node._pgSyncModePreset = () => {
            if (node._pgState._modeView !== "presets") {
                const cur = node._pgState.override_system_prompt;
                const info = (cur && cur !== NONE_PRESET && cur !== NO_SYS_PROMPT) ? node._pgPresetMap?.get(cur) : null;
                if (info && String(node._pgState.system_prompt || "") === String(info.text || "")) {
                    node._pgModePresetMemo = cur;
                    node._pgState.override_system_prompt = NONE_PRESET; setVal("override_system_prompt", NONE_PRESET);
                    node._pgState.system_prompt = ""; setVal("system_prompt", "");
                    node._pgControls.system_prompt?.set?.("");
                    node._pgControls.override_system_prompt?.set?.(NONE_PRESET);
                    for (const q of (node._pgQuickSelects || [])) q.set?.(PRESET_MODE);
                    node._pgUpdatePresetUI?.();
                }
            } else if (node._pgModePresetMemo) {
                const memo = node._pgModePresetMemo; node._pgModePresetMemo = null;
                if ((node._pgState.override_system_prompt === NONE_PRESET || !node._pgState.override_system_prompt) && node._pgPresetMap?.get(memo)) node._pgApplyPreset?.(memo);
            }
        };

        // ---- top row (image toggle) + normal/history view containers ----
        // (📖 History now lives in the OUTPUT header next to Copy/Save — see buildOutputCluster.)
        const topRow = el("div", { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0" });
        const normalWrap = el("div", { display: "flex", flexDirection: "column", gap: "4px" });

        // Track generation running-state only to clear the progress bar on interrupt/error.
        node._pgSetRunning = (running) => {
            node._pgRunning = !!running;
            if (!running && !node._pgProgDone) { node._pgHideProgress?.(); node._pgHideStepProgress?.(); node._pgExpectedLen = null; }
        };

        // Load an image into the node (from a File or a history/output meta).
        node._pgLoadImageMeta = (meta) => {
            node._pgState.image_upload_meta = meta || null;
            node._pgState.image_upload = meta ? annotatedName(meta) : "";
            node._pgState.image_hidden = false;
            node._pgWriteConfig(true);
            node._pgControls.image_upload?.set?.();
            node._pgUpdateImageBox();
            node._pgReflow();
        };
        node._pgLoadImageFile = async (file) => {
            try { node._pgLoadImageMeta(await uploadImage(file)); } catch { /* ignore */ }
        };

        node._pgRecordPrompt = (usedText) => {
            // Save the TEXT THAT WAS ACTUALLY USED to generate — i.e. what the node sent out its `output`
            // socket (the LLM result, or the input passthrough on Skip-LLM). onExecuted passes it in. For
            // out-of-graph crafts (✨ button / refine) there's no socket text, so fall back to the input box.
            const text = (typeof usedText === "string" && usedText.trim()) ? usedText : String(node._pgState.prompt || "");
            // Capture the prompt WITH the mode/preset + image it ran with, so Recent cards
            // show badges/thumbnails and can be saved into the Library with full context.
            // Only attach the image for vision sources — image_upload is sticky and would
            // otherwise stamp every text prompt with the last-loaded image.
            const src = node._pgCurrentSource?.();
            const useImg = src && src.vision && node._pgState.image_upload_meta;
            node._pgLastRecordedText = String(text || "").trim();   // fallback match
            // Remember the exact entry id so a later saved-image attach targets THIS run,
            // not just the newest same-text row (lets repeated runs each keep their own image).
            node._pgLastRecordedId = recordPromptHistory({
                text: text,
                source: src,
                image_ref: useImg ? (node._pgState.image_upload || "") : "",
                image_meta: useImg ? node._pgState.image_upload_meta : null,
            });
            if (node._pgState._view === "prompts" && node._pgState._libView === "recent") {
                // Splice in just the new card (cheap) instead of rebuilding the whole grid each run;
                // follow-latest selects it too. Falls back to a full render outside the simple case.
                node._pgLibOnNewEntry?.(node._pgState._libPreviewLatest);
            }
        };

        // Vision warning (clickable → LLM Settings) when a vision mode lacks a usable model/mmproj.
        const visionWarn = el("div", {
            display: "none", cursor: "pointer", color: "#e0b050", fontSize: "11px", lineHeight: "1.4",
            border: "1px solid rgba(224,176,80,0.5)", borderRadius: "6px", padding: "6px 8px",
            background: "rgba(224,176,80,0.12)",
        }, "⚠ Click to navigate to LLM Settings. Select a compatible MMPROJ and Model.");
        visionWarn.addEventListener("mousedown", stop);
        visionWarn.addEventListener("click", (e) => {
            stop(e);
            node._pgState._view = "options"; setVal("_view", "options");
            node._pgState._optView = "llm"; setVal("_optView", "llm");
            node._pgApplyView();
        });
        node._pgUpdateVisionWarn = () => {
            const isImg = IMAGE_MODES.has(node._pgEffectiveMode());
            const oll = node._pgState.backend === "ollama";
            const m = node._pgState.model, mm = node._pgState.mmproj;
            // llama.cpp needs an mmproj for vision; Ollama needs a model with vision baked in
            // (detected via /api/show — `false` means confirmed text-only; `null` = unknown, no warn).
            const bad = !m || /^No /.test(String(m)) || (oll ? (node._pgOllamaVision === false) : (mm === "None"));
            visionWarn.style.display = (isImg && bad) ? "block" : "none";
            node._pgUpdateChecklist?.();
        };

        promptPanel.append(topRow, normalWrap);
        // ── Grouping cards (REUSABLE — see node._pgMkGroupCard) ──
        // Wrap a set of related controls in a card. In SKIP-LLM (bypass) mode the card gets a medium-dark
        // background so the group doesn't look "floaty" on the red wash; in normal mode it's transparent
        // (geometry is identical — only the bg/border color changes on toggle, so nothing jumps). Children
        // live INSIDE the card, so they stay contained on node resize. _pgRefreshBypass paints every card
        // registered in node._pgGroupCards. Reuse this helper anywhere the same grouping is wanted (it's
        // already mirrored into the Expanded view below).
        node._pgGroupCards = [];
        node._pgBypassTextColors = [];   // {el, on, off}: text recolored ONLY while bypassed (its own color for the SKIP-LLM look)
        // Turn an EXISTING element into a bypass-painted group card: keep its own display/flex, just add the
        // card chrome (padding/radius/transparent border) + register it for painting. _pgMkGroupCard builds
        // a fresh column card on top of it (the common case).
        node._pgAsGroupCard = (c) => {
            // Group cards are ALWAYS shown now (both normal + SKIP-LLM modes) — grey wash from creation.
            Object.assign(c.style, { boxSizing: "border-box", padding: "8px", borderRadius: "10px", border: `1px solid ${BYPASS_GROUP_BORDER}`, background: BYPASS_GROUP_BG, transition: "background .15s, border-color .15s", marginBottom: "3px" });
            node._pgGroupCards.push(c);
            return c;
        };
        node._pgMkGroupCard = () => node._pgAsGroupCard(el("div", { display: "flex", flexDirection: "column", gap: "4px", width: "100%", minWidth: "0" }));
        const inputCard = node._pgMkGroupCard();
        normalWrap.appendChild(inputCard);
        inputCard.appendChild(visionWarn);

        // Expose the loaded image as node.imgs so downstream auto-detect nodes
        // (e.g. Resolution Master) can read its dimensions live, with no run —
        // wire our "image" output into their input_image.
        node._pgSyncImgs = function () {
            const meta = node._pgState.image_upload_meta;
            const url = meta?.name ? viewUrl(meta) : "";
            if (url === node._pgImgsUrl) return;   // same image already loaded — skip the redundant decode + canvas repaint
            node._pgImgsUrl = url;
            if (url) {
                const im = new Image();
                im.onload = () => { node.imgs = [im]; node.setDirtyCanvas(true, true); };
                im.src = url;
            } else {
                node.imgs = undefined;
                node.setDirtyCanvas(true, true);
            }
        };

        // In-node image loader — appears under Mode for the Analyze Image modes.
        const imgBox = makeImageBox(node, (meta) => {
            node._pgState.image_upload_meta = meta || null;
            node._pgState.image_upload = meta ? annotatedName(meta) : "";
            node._pgWriteConfig();
            imgBox.refresh(meta);
            node._pgSyncImgs();
            node._pgReflow();
        });
        reg("image_upload", { set: () => { imgBox.refresh(node._pgState.image_upload_meta); node._pgSyncImgs?.(); } });

        // Single "Show / Hide Image" text above the box — collapses the whole box.
        const imgToggle = el("div", {
            display: "none", cursor: "pointer", userSelect: "none", flex: "0 0 auto",
            fontSize: "11px", fontWeight: "600", color: C.text, borderRadius: "6px",
            padding: "4px 9px", background: GRAD_BTN, transition: "background .15s",
        });
        imgToggle.addEventListener("mousedown", stop);
        imgToggle.addEventListener("mouseenter", () => { imgToggle.style.background = GRAD_BTN_HI; });
        // On leave, settle back to the state fill: brighter (active) while the image is shown.
        imgToggle.addEventListener("mouseleave", () => { imgToggle.style.background = node._pgState.image_hidden ? GRAD_BTN : GRAD_BTN_HI; });
        imgToggle.addEventListener("click", (e) => {
            stop(e);
            node._pgState.image_hidden = !(node._pgState.image_hidden === true);
            node._pgWriteConfig?.();
            node._pgUpdateImageBox();
            node._pgReflow();
        });
        topRow.append(imgToggle);
        inputCard.appendChild(imgBox.el);

        node._pgUpdateImageBox = () => {
            node._pgUpdateVisionWarn?.();
            // Mirror the active preset's vision flag into state so the backend run/generate
            // knows to consume the in-node image when a vision preset is selected.
            node._pgState._preset_vision = (node._pgState._modeView === "presets") && node._pgActivePresetVision();
            const isImg = IMAGE_MODES.has(node._pgEffectiveMode());
            const hidden = node._pgState.image_hidden === true;
            imgToggle.style.display = isImg ? "block" : "none";
            imgToggle.textContent = "🖼 Show / Hide Image";
            imgToggle.style.background = hidden ? GRAD_BTN : GRAD_BTN_HI;   // active (brighter) fill while the image is shown
            imgBox.show(isImg && !hidden);
        };

        const prompt = reg("prompt", makeText(true, "Enter prompt…  (Ctrl/⌘+Enter to run)", (v) => node._pgSyncPrompt(v, prompt.el), { noGlow: true }));
        Object.assign(prompt.el.style, OUTPUT_BOX_STYLE);   // match the output box (brighter fill + bottom room, no focus glow)
        attachBoxHover(prompt.el, "var(--pg-box, hsl(220 10% 13%))", "var(--pg-box-hover, hsl(220 10% 16%))");   // re-point lift to the output-box colors
        node._pgPromptInputs.push(prompt);
        // Ctrl/⌘+Enter is owned by ONE global capture-phase listener (see _pgRunBoxCleanup below) that renders
        // from whichever box is focused — input OR output, this view OR Expanded — and ONLY that box. makeText
        // already stops keydown propagation here, so no per-box handler is needed.
        const mainPromptRow = labelRow("", prompt.el, { stack: true });
        inputCard.appendChild(mainPromptRow);   // the input-actions row (Generate Prompt / ×N / Copy / Save Input) is inserted ABOVE this — see _pgBuildInputActions
        inputCard.appendChild(mkInputCount());   // live char · word count under the input box (mirrors the output count)

        // ---- Collapsible "Execution Settings" box ----
        const execHeader = el("div", {
            cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: "6px",
            color: C.heading, fontSize: "11px", fontWeight: "700", letterSpacing: "0.4px",
            textTransform: "uppercase", opacity: "0.85", margin: "0", padding: "2px 0",
        });
        const execChevron = el("span", { flex: "0 0 auto", fontSize: "10px" }, "▾");
        // ---- Execution icon bar (factory — mirrored in the theater view) ----
        // 🧠 thinking · ⏏ stop-server-after are toggles (square box: green = ON, grey = OFF).
        // 💀 force-kills the LLM process. Each stops propagation so it won't collapse the box.
        node._pgExecIcons = [];
        // Bypass toggle icons (amber when ON) — separate from the green exec toggles.
        node._pgBypassIcons = [];
        // Skull icons (💀 force-kill llama / serve⇄kill Ollama) and the 🔌 stop-server icons
        // (llama-only) — registered so we can retarget / hide them per backend.
        node._pgSkullIcons = []; node._pgStopSrvIcons = [];
        // Resting backing for every icon-bar item (🧠 ♻️ 🔌 💀 🚫) — a ~40% near-black wash so the
        // glyphs read as solid chips against the panel on BOTH the Execution bar and the top status bar.
        const ICON_REST_BG = "rgba(10,13,18,0.65)";
        const ICON_HOVER_BG = "rgba(10,13,18,0.80)";
        function _applyBypassIcon(box) {
            const on = node._pgState._bypass === true;
            box.style.backgroundColor = on ? "rgba(245,170,50,0.30)" : ICON_REST_BG;
            box.style.borderColor = on ? "rgba(245,170,50,0.85)" : C.border;
            box.style.color = on ? C.text : C.textMuted;
            if (box._pgGlyph) box._pgGlyph.style.opacity = on ? "1" : "0.5";   // dim the GLYPH, not the chip
            box.style.boxShadow = "none";
        }
        // Refresh every bypass icon + dim the whole node body when bypassed (no purple graph).
        node._pgRefreshBypass = () => {
            for (const b of node._pgBypassIcons) _applyBypassIcon(b);
            node._pgTopToggleRefresh?.forEach((fn) => { try { fn(); } catch {} });   // keep the top Bypass pill in sync
            const on = node._pgState._bypass === true;
            // Bypassed → faint pale matte red wash (not a transparent dim).
            if (node._pgRoot) {
                node._pgRoot.style.opacity = "1"; node._pgRoot.style.filter = "none";
                node._pgRoot.style.background = on ? nodeBg(BYPASS_ROOT_BG) : nodeBg(GRAD_NODE, 0.035);
                // Re-tint surfaces to silver while bypassed (vars), or fall back to the cool theme.
                for (const k in BYPASS_SURFACE_VARS) {
                    if (on) node._pgRoot.style.setProperty(k, BYPASS_SURFACE_VARS[k]);
                    else node._pgRoot.style.removeProperty(k);
                }
            }
            // Group cards (Input / Output, + any others): medium-dark backing while bypassed so the
            // grouped controls don't float on the red wash; transparent otherwise.
            for (const c of (node._pgGroupCards || [])) {
                // Always grey (both modes); re-asserted here in case a theme value changes dynamically.
                c.style.background = BYPASS_GROUP_BG;
                c.style.borderColor = BYPASS_GROUP_BORDER;
            }
            for (const t of (node._pgBypassTextColors || [])) t.el.style.color = on ? t.on : t.off;   // bypass-only text recolor
            try { node.bgcolor = on ? BYPASS_NODE_BG : NODE_BG; node.color = on ? BYPASS_NODE_BG : NODE_BG; } catch {}
            node.setDirtyCanvas?.(true, true);
            // Refresh the LLM status the instant bypass flips: ON → shows "Bypassed" immediately;
            // OFF → probes the backend right away instead of waiting up to 10s for the next poll.
            node._pgRefreshStatus?.();
            node._pgResReflowCanvas?.();   // recolor the Resolution picker canvas (blue ⇄ grey) for the theme
        };
        const _applyExecIcon = (box, on) => {
            // Use backgroundColor (not the background shorthand) so the hover white-sheen
            // overlay (backgroundImage) layers on top of the ON/OFF fill without wiping it.
            box.style.backgroundColor = on ? "rgba(76,175,80,0.28)" : ICON_REST_BG;
            box.style.borderColor = on ? "rgba(76,175,80,0.75)" : C.border;
            box.style.color = on ? C.text : C.textMuted;
            if (box._pgGlyph) box._pgGlyph.style.opacity = on ? "1" : "0.5";   // dim the GLYPH, not the chip → backing stays equally visible
            box.style.boxShadow = on ? GLOW_GREEN : "none";
        };
        node._pgRefreshExecIcons = () => { for (const it of node._pgExecIcons) _applyExecIcon(it.box, !!node._pgState[it.key]); };
        const _mkIconBox = (glyph, title) => {
            const b = el("span", { cursor: "pointer", userSelect: "none", flex: "0 0 auto", fontSize: "12px", lineHeight: "1", padding: "3px 6px", borderRadius: "5px", backgroundColor: ICON_REST_BG, border: `1px solid ${C.border}`, textTransform: "none", letterSpacing: "normal", transition: "background-color .15s, background-image .15s, border-color .15s, box-shadow .15s" });
            // Glyph in an inner span so the OFF-state dim fades the GLYPH only — never the chip backing,
            // so every icon's background reads at the same visibility (ON/OFF/skull alike).
            b._pgGlyph = el("span", { display: "inline-block", transition: "opacity .15s" }, glyph);
            b.appendChild(b._pgGlyph);
            b.title = title; b.addEventListener("mousedown", stop);
            // Hover: a flat brightness lift (no gradient sheen), works ON/OFF/skull/bypass.
            b.addEventListener("mouseenter", () => {
                b.style.filter = "brightness(1.35)"; b.style.borderColor = C.accentBorder;
                // Bump the near-black chip to its hover alpha — only while the dark backing is showing
                // (not when a toggle/bypass is lit with its ON color).
                const darkResting = b._pgKey ? !node._pgState[b._pgKey] : (b._pgBypass ? node._pgState._bypass !== true : true);
                if (darkResting) b.style.backgroundColor = ICON_HOVER_BG;
            });
            b.addEventListener("mouseleave", () => {
                b.style.filter = "none";
                // Toggle icons restore their ON/OFF look; bypass restores its amber look;
                // the skull resets its border + dark chip.
                if (b._pgKey) _applyExecIcon(b, !!node._pgState[b._pgKey]);
                else if (b._pgBypass) _applyBypassIcon(b);
                else { b.style.borderColor = C.border; b.style.backgroundColor = ICON_REST_BG; }
            });
            return b;
        };
        const _mkExecToggleIcon = (glyph, title, key) => {
            const b = _mkIconBox(glyph, title);
            b._pgKey = key;   // lets the hover handler restore the correct ON/OFF look on leave
            b.addEventListener("click", (e) => { stop(e); const v = !node._pgState[key]; node._pgState[key] = v; node._pgWriteConfig(true); node._pgControls[key]?.set?.(v); node._pgRefreshExecIcons(); });
            node._pgExecIcons.push({ key, box: b });
            return b;
        };
        // opts.only = array of icon names to include (default: all). Lets the top pill bar reuse
        // this with just ["brain","clearvram","skull"] while the Execution Settings header uses all.
        const buildExecIconBar = (opts = {}) => {
            const only = opts.only;
            const want = (n) => !only || only.includes(n);
            const bar = el("div", { display: "flex", alignItems: "center", gap: "6px", flex: "0 0 auto", ...(opts.marginLeftAuto === false ? {} : { marginLeft: "auto" }) });
            const kids = [];
            if (want("brain")) kids.push(_mkExecToggleIcon("🧠", "Enable thinking (reasoning) — streams live, final output stays clean", "enable_thinking"));
            if (want("stopsrv")) { const stopsrv = _mkExecToggleIcon("🔌", "Stop the LLM server after each run (unloads the LLM, slower next run)", "stop_server_after"); node._pgStopSrvIcons.push(stopsrv); kids.push(stopsrv); }   // llama.cpp-only → hidden in Ollama mode
            if (want("clearvram")) kids.push(_mkExecToggleIcon("♻️", "Clear VRAM on run (unload other ComfyUI models before/after — for tight GPUs)", "clear_vram_on_run"));
            if (want("bypass")) {
                // Bypass toggle (amber) — skips the LLM, passes the prompt straight through.
                const bypass = _mkIconBox("🚫", "Bypass: skip the LLM and pass the prompt straight to output (no purple graph)");
                bypass._pgBypass = true;
                bypass.addEventListener("click", (e) => { stop(e); const v = !(node._pgState._bypass === true); node._pgState._bypass = v; node._pgWriteConfig(true); node._pgControls._bypass?.set?.(v); node._pgRefreshBypass(); });
                node._pgBypassIcons.push(bypass);
                _applyBypassIcon(bypass);
                kids.push(bypass);
            }
            if (want("skull")) {
                // 💀 = force-kill llama.cpp. In Ollama mode it becomes a serve⇄kill toggle:
                // 🦙 (start `ollama serve`) when stopped, 💀 (kill Ollama) when running.
                const skull = _mkIconBox("💀", "Force kill the LLM process");
                node._pgSkullIcons.push(skull);
                skull.addEventListener("click", async (e) => {
                    stop(e);
                    const orig = skull.textContent; skull.textContent = "⏳";
                    const oll = node._pgState.backend === "ollama";
                    try {
                        if (oll) {
                            const running = !!node._pgServerRunning;
                            const url = node._pgState.ollama_url;
                            if (running) await fetch("/prompt-generator/ollama-kill", { method: "POST" });
                            else await fetch("/prompt-generator/ollama-serve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ollama_url: url }) });
                            await node._pgRefreshStatus?.();           // updates running → refreshes glyph
                            node._pgRefreshModelLists?.({ fresh: true });   // serve adds models / kill clears them
                            node._pgRefreshSkull?.();
                        } else {
                            const r = await fetch("/prompt-manager/force-kill-llm", { method: "POST" }); const d = await r.json().catch(() => ({}));
                            skull.textContent = d?.status === "ok" ? "✓" : "✗";
                            setTimeout(() => node._pgRefreshSkull?.(), 1400);
                        }
                    } catch { skull.textContent = "✗"; setTimeout(() => node._pgRefreshSkull?.(), 1400); }
                });
                kids.push(skull);
            }
            bar.append(...kids);
            return bar;
        };
        node._pgBuildExecIconBar = buildExecIconBar;
        execHeader.append(execChevron, el("span", {}, "Execution Settings"), buildExecIconBar());
        // Interactive header: white on hover, and STAYS white while the section is open.
        execHeader.style.transition = "color .15s";
        let execHover = false;
        const syncExecColor = () => { execHeader.style.color = (execHover || node._pgState._execOpen !== false) ? C.text : C.heading; };
        execHeader.addEventListener("mouseenter", () => { execHover = true; syncExecColor(); });
        execHeader.addEventListener("mouseleave", () => { execHover = false; syncExecColor(); });
        const execBody = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
        execHeader.title = "Click to show/hide execution settings";
        execHeader.addEventListener("mousedown", stop);
        execHeader.addEventListener("click", (e) => {
            stop(e);
            node._pgState._execOpen = !(node._pgState._execOpen !== false);
            setVal("_execOpen", node._pgState._execOpen);
            node._pgApplyExecOpen();
            node._pgReflow();
        });
        // Scroll over the header (EITHER direction) toggles it — one flip per gesture (220ms cooldown).
        let _execWheelT = 0;
        execHeader.addEventListener("wheel", (e) => {
            e.preventDefault(); e.stopPropagation();
            const now = performance.now();
            if (now - _execWheelT < 220) return;
            _execWheelT = now;
            node._pgState._execOpen = !(node._pgState._execOpen !== false);
            setVal("_execOpen", node._pgState._execOpen);
            node._pgApplyExecOpen(); node._pgReflow();
        }, { passive: false });
        node._pgApplyExecOpen = () => {
            const open = node._pgState._execOpen !== false;
            execBody.style.display = open ? "flex" : "none";
            execChevron.textContent = open ? "▾" : "▸";
            syncExecColor();
        };
        normalWrap.append(execHeader, execBody);

        const mkToggleRow = (key, label, body = execBody) => {
            const t = reg(key, makeToggle((v) => { setVal(key, v); node._pgRefreshExecIcons?.(); }));
            const row = labelRow(label, t.el, { labelWidth: "auto" });
            row.style.justifyContent = "space-between";
            row._label.style.flex = "1 1 auto";
            wireToggleRow(row, t);   // click anywhere on the row or scroll over it to toggle
            body.appendChild(row);
            return row;
        };
        mkToggleRow("format_as_json", "Format as JSON");
        mkToggleRow("enable_thinking", "Enable Thinking");
        // "Stop Server After" is llama.cpp-only (stops the local llama-server). Ollama is a
        // persistent daemon, so this row + its 🔌 icon are hidden in Ollama mode.
        const stopSrvRow = mkToggleRow("stop_server_after", "Stop Server After");
        mkToggleRow("clear_vram_on_run", "Clear VRAM on Run");

        // Backend-specific execution-settings visibility (Ollama hides the llama-only items).
        node._pgApplyBackendExec = () => {
            const oll = node._pgState.backend === "ollama";
            if (stopSrvRow) stopSrvRow.style.display = oll ? "none" : "flex";   // labelRow default
            for (const ic of (node._pgStopSrvIcons || [])) ic.style.display = oll ? "none" : "";
        };
        // Skull glyph/behavior: 💀 force-kill for llama.cpp; for Ollama, 🦙 (serve) when
        // stopped / 💀 (kill) when running.
        node._pgRefreshSkull = () => {
            const oll = node._pgState.backend === "ollama";
            const running = !!node._pgServerRunning;
            for (const s of (node._pgSkullIcons || [])) {
                if (oll) { s.textContent = running ? "💀" : "🦙"; s.title = running ? "Kill the Ollama server" : "Start the Ollama server (ollama serve)"; }
                else { s.textContent = "💀"; s.title = "Force kill the LLM process"; }
            }
        };
        // Bypass toggle — synchronized with the 🚫 icon in the header bar (and vice-versa).
        const bypassToggle = reg("_bypass", makeToggle((v) => {
            node._pgState._bypass = v; node._pgWriteConfig(true); node._pgRefreshBypass();
        }));
        const bypassRow = labelRow("Bypass (skip LLM, pass prompt through)", bypassToggle.el, { labelWidth: "auto" });
        bypassRow.style.justifyContent = "space-between";
        bypassRow._label.style.flex = "1 1 auto";
        execBody.appendChild(bypassRow);

        const killBtn = makeButton("Force kill LLM Process", async (b) => {
            const orig = b.textContent;
            b.textContent = "Killing…";
            try {
                const resp = await fetch("/prompt-manager/force-kill-llm", { method: "POST" });
                const data = await resp.json().catch(() => ({}));
                b.textContent = data?.status === "ok" ? "LLM killed ✓" : "Kill failed ✗";
            } catch { b.textContent = "Kill failed ✗"; }
            setTimeout(() => { b.textContent = orig; }, 1600);
        }, { marginTop: "6px" });
        execBody.appendChild(killBtn);

        // ---- Output cluster(s): main view + theater view share these factories ----
        const mkMini = pillBtn;   // shared module-level pill button (single definition)

        // Registries so every output cluster (main view + theater view) stays in sync.
        node._pgOutBoxes = []; node._pgDiffBoxes = []; node._pgVerLabels = [];
        node._pgPrevBtns = []; node._pgNextBtns = []; node._pgDiffBtns = []; node._pgProgEls = [];
        // Every ×N stepper (main + theater + Prompts preview) mirrors the one shared _batchN value.
        node._pgBatchCtrls = [];
        node._pgSetBatchN = (v) => {
            const n = Math.max(1, Math.min(PG_BATCH_MAX, (v | 0) || 1));
            node._pgState._batchN = n; setVal("_batchN", n);
            for (const c of node._pgBatchCtrls) c.set?.(n);
        };
        // Live output character count (shown under each output box; every cluster mirrors it).
        node._pgCharCounts = [];
        // Gen-time readouts, bundled with the char·word count (one per cluster, kept in sync by _renderMeter).
        node._pgGenTimeEls = [];
        // "·" separators between gen-time and char·word count — shown only when both are present.
        node._pgMetaSeps = [];
        node._pgUpdateCharCount = () => {
            const v = node._pgOutBoxes[0]?.value ?? "";
            const words = (v.match(/\S+/g) || []).length;
            const txt = v.length ? `${v.length.toLocaleString()} chars · ${words.toLocaleString()} word${words === 1 ? "" : "s"}` : "";
            for (const c of node._pgCharCounts) c.textContent = txt;
            node._pgSyncMetaSeps?.();
        };
        // Show the "·" between gen-time and char·word count only when BOTH are present (no dangling dot).
        node._pgSyncMetaSeps = () => {
            const seps = node._pgMetaSeps || [];
            for (let i = 0; i < seps.length; i++) {
                const t = node._pgGenTimeEls[i]?.textContent, c = node._pgCharCounts[i]?.textContent;
                seps[i].style.display = (t && c) ? "" : "none";
            }
        };
        // Output dimensions readout (under each output box): "W × H | aspect". Click → Resolution picker.
        node._pgResInfos = [];
        node._pgUpdateResInfo = () => {
            const w = node._pgState.res_width, h = node._pgState.res_height;
            // Only show a LOCKED "W:H" verbatim; "Custom"/"Free" → the actual computed ratio of the dims.
            const asp = /^\d+:\d+$/.test(node._pgState.res_aspect || "") ? node._pgState.res_aspect : pgRatioLabel(w, h);
            const txt = (w && h) ? `${w} × ${h}  |  ${asp}` : "";
            for (const r of node._pgResInfos) r.textContent = txt;
        };
        // Jump to Generator ▸ Resolution. One definition — shared by the status-bar RES pill and the readout.
        node._pgOpenResolution = () => {
            node._pgState._view = "generator"; setVal("_view", "generator");
            node._pgState._genView = "resolution"; setVal("_genView", "resolution");
            node._pgApplyView?.(); node._pgReflow?.();
        };
        // Jump to Generator ▸ Prompt — the status-bar GEN pill.
        node._pgOpenGenerator = () => {
            node._pgState._view = "generator"; setVal("_view", "generator");
            node._pgState._genView = "prompt"; setVal("_genView", "prompt");
            node._pgApplyView?.(); node._pgApplyGenView?.(); node._pgReflow?.();
        };
        node._pgSetVerText = (t) => { for (const v of node._pgVerLabels) v.textContent = t; };
        node._pgSyncBoxes = (src) => { const v = src.value; for (const b of node._pgOutBoxes) if (b !== src) b.value = v; };

        // ---- shared output actions (reused by every cluster's buttons) ----
        // Show the progress bar immediately on click (live tokens then fill it); finalize
        // it when the request returns so it's reliably visible regardless of stream timing.
        const _pgKickProgress = () => { node._pgExpectedLen = null; node._pgProgDone = false; node._pgSetStepProgress?.(0.03, false); };
        node._pgDoGenerate = async (b, { thenImage = false } = {}) => {
            const o = b.textContent;
            const N = Math.max(1, Math.min(PG_BATCH_MAX, node._pgState._batchN || 1));
            const baseSeed = Number(node.widgets?.find((w) => w.name === "seed")?.value ?? 0) || 0;
            const results = [];
            node._pgStartGenTimer?.();
            for (let i = 0; i < N; i++) {
                b.textContent = N > 1 ? `Generating ${i + 1}/${N}…` : "Generating…";
                _pgKickProgress();
                let r;
                try {
                    r = await fetch("/prompt-generator/generate", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ config: _cleanForSave(node._pgState), seed: baseSeed + i, node_id: node.id }),
                    }).then((x) => x.json());
                } catch { r = null; }
                if (r?.ok && typeof r.output === "string") { node._pgSetStepProgress?.(1, true); results.push(r.output); }
                else { node._pgHideStepProgress?.(); node._pgSetVerText(r?.error || "generate failed"); setTimeout(() => node._pgRenderVersion(), 2800); break; }
            }
            node._pgStopGenTimer?.();   // freeze the live timer at the final elapsed time
            if (results.length) {
                // Each variation becomes a version — step with ◀ ▶, compare with ⇄ Diff.
                node._pgHistory = results; node._pgHistoryIdx = results.length - 1; node._pgDiffOn = false;
                node._pgRenderVersion(); node._pgRecordPrompt?.(); node._pgReflow();
                // One-click "Generate Image (LLM)": after crafting the prompt, render an image from
                // the produced text. Skipped when generation failed (results empty).
                if (thenImage) await node._pgRenderImage(node._pgHistory[node._pgHistoryIdx] ?? "");
            }
            b.textContent = o;
        };
        node._pgDoRefine = async (b) => {
            const base = node._pgHistory[node._pgHistoryIdx];
            const instr = String(node._pgState.prompt || "").trim();
            if (base == null) { node._pgSetVerText("run once first"); setTimeout(() => node._pgRenderVersion(), 1600); return; }
            if (!instr) { node._pgSetVerText("type a change in the prompt box"); setTimeout(() => node._pgRenderVersion(), 1800); return; }
            const o = b.textContent; b.textContent = "Refining…";
            _pgKickProgress();
            const seed = node.widgets?.find((w) => w.name === "seed")?.value ?? 0;
            node._pgStartGenTimer?.();
            try {
                const r = await fetch("/prompt-generator/refine", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ config: _cleanForSave(node._pgState), prior_output: base, instruction: instr, seed, node_id: node.id }),
                }).then((x) => x.json());
                if (r?.ok && typeof r.output === "string") {
                    node._pgSetStepProgress?.(1, true); node._pgRecordPrompt?.();
                    node._pgHistory = node._pgHistory.slice(0, node._pgHistoryIdx + 1);
                    node._pgHistory.push(r.output);
                    node._pgHistoryIdx = node._pgHistory.length - 1;
                    node._pgDiffOn = true;
                    node._pgRenderVersion(); node._pgReflow();
                } else { node._pgHideStepProgress?.(); node._pgSetVerText(r?.error || "refine failed"); setTimeout(() => node._pgRenderVersion(), 2500); }
            } catch { node._pgHideStepProgress?.(); node._pgSetVerText("refine failed"); setTimeout(() => node._pgRenderVersion(), 2500); }
            node._pgStopGenTimer?.();   // freeze the live timer at the final elapsed time
            b.textContent = o;
        };
        node._pgDoCopy = (b) => {
            const text = node._pgHistory[node._pgHistoryIdx] ?? "";   // output already includes prefix/suffix (wrapped once at generation)
            navigator.clipboard?.writeText(text).then(
                () => { b.textContent = "Copied ✓"; setTimeout(() => b.textContent = "📋 Copy", 1200); },
                () => { b.textContent = "Copy ✗"; setTimeout(() => b.textContent = "📋 Copy", 1200); }
            );
        };
        // Copy the INPUT prompt box text (the input-actions row's 📋 Copy) — vs _pgDoCopy which copies the output.
        node._pgDoCopyInput = (b) => {
            navigator.clipboard?.writeText(node._pgState.prompt || "").then(
                () => { b.textContent = "Copied ✓"; setTimeout(() => b.textContent = "📋 Copy", 1200); },
                () => { b.textContent = "Copy ✗"; setTimeout(() => b.textContent = "📋 Copy", 1200); }
            );
        };
        // Generate Image from a SPECIFIC text (Input box vs Output box). Queues the workflow with a transient
        // _render_image flag so the node emits exactly `text` downstream (no LLM, output box untouched).
        // ComfyUI snapshots the config when graphToPrompt runs inside queuePrompt, so we restore AFTER awaiting.
        node._pgRenderImage = async (text) => {
            const N = Math.max(1, Math.min(PG_BATCH_MAX, node._pgState._batchN || 1));
            const pf = node._pgState._render_image, pt = node._pgState._render_image_text;
            node._pgState._render_image = true;
            node._pgState._render_image_text = String(text ?? "");
            node._pgWriteConfig?.(true);   // flush to the config widget BEFORE the queue snapshots it
            try { await app.queuePrompt(0, N); }
            finally {
                node._pgState._render_image = pf || false;
                node._pgState._render_image_text = pt || "";
                node._pgWriteConfig?.(true);
            }
        };

        // Input-actions row — sits ABOVE the input prompt box in BOTH the main and Expanded views: it holds
        // the actions on the INPUT (✨ Generate Prompt · 🖼 Generate Image · ×N · 📋 Copy · 💾 Save Input).
        // The Prefix/Suffix pills live UNDER the input box (in its count row) — see mkInputCount.
        node._pgBuildInputActions = () => {
            const genB = mkMini("✨ Generate Prompt", "Run the LLM now to craft the prompt text from the input below — no image render. ×N stacks variations as versions.", (b) => node._pgDoGenerate(b));
            const genImgB = mkMini("🖼 Generate Image", "Generate an Image using the Input Prompt Text (prefix/suffix applied).", () => node._pgRenderImage(node._pgApplyAffixes(node._pgState.prompt || "")));
            const genImgLlmB = mkMini("🖼 Generate Image (LLM)", "One click: run the LLM on the input to craft the prompt, then render an Image from that result. ×N applies to both the prompt variations and the renders.", (b) => node._pgDoGenerate(b, { thenImage: true }));
            const batchStep = makeBatchStepper((n) => node._pgSetBatchN(n));   // ×N — shared by Generate Prompt + Generate Image
            node._pgBatchCtrls.push(batchStep);
            const copyB = mkMini("📋 Copy", "Copy the input prompt text below", (b) => node._pgDoCopyInput(b));
            const saveInB = mkMini("💾 Save Input", "Save the Prompt text in the Input box.\nSave the Prompt AND its generated Image via the Prompts menu.", () => node._pgSaveInputToLibrary?.());
            const row = el("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", rowGap: "6px", margin: "2px 0 4px" });
            row.append(genB, genImgB, genImgLlmB, batchStep.el, copyB, saveInB);
            return row;
        };
        // Mount it directly above the main view's input prompt box.
        inputCard.insertBefore(node._pgBuildInputActions(), mainPromptRow);

        // Build one output cluster (header buttons + stepper/progress + box + diff),
        // registering its parts so the shared render/stream functions update them all.
        const buildOutputCluster = ({ big = false } = {}) => {
            const title = el("div", { color: C.heading, fontSize: "11px", fontWeight: "700", letterSpacing: "0.4px", textTransform: "uppercase", opacity: "0.8", flex: "0 0 auto" }, "Output");
            // Dimensions readout — lives in the OUTPUT header, right after the label and BEFORE Copy/Save.
            // Click → Resolution picker; hover-brightens like the rest.
            const resInfo = el("div", { fontSize: "10px", color: C.textMuted, userSelect: "none", cursor: "pointer", whiteSpace: "nowrap", transition: "color .12s", flex: "0 0 auto" }, "");
            resInfo.title = "Output dimensions (W × H | aspect ratio) — click to open the Resolution picker";
            resInfo.addEventListener("mouseenter", () => { resInfo.style.color = C.text; });
            resInfo.addEventListener("mouseleave", () => { resInfo.style.color = C.textMuted; });
            resInfo.addEventListener("mousedown", stop);
            resInfo.addEventListener("click", (e) => { stop(e); node._pgOpenResolution?.(); });
            // ✨ Generate Prompt + ×N moved to the input-actions row (above the input box) — see _pgBuildInputActions.
            // OUTPUT-side Generate Image renders the OUTPUT box text (the shown version) verbatim, ×N.
            const genImgB = mkMini("🖼 Generate Image", "Generate an Image using the Output Prompt Text.", () => node._pgRenderImage(box.value ?? ""));   // read the OUTPUT box directly = exactly what's shown/edited
            const refineB = mkMini("⟳ Refine Prompt", "Refine the prompt using the selected LLM. Input your instruction, that will be used to refine the current text that appears in the Output text field", (b) => node._pgDoRefine(b));
            const diffB = mkMini("⇄ Difference", "Toggle: highlight what changed vs the previous version", () => { node._pgDiffOn = !node._pgDiffOn; node._pgApplyDiffView?.(); node._pgReflow(); });
            const copyB = mkMini("📋 Copy", "Copy the shown output version", (b) => node._pgDoCopy(b));
            const saveOutB = mkMini("💾 Save Output", "Save the Prompt text in the Output box and the Refined edition if any exists.\nSave the Prompt AND its generated Image via the Prompts menu.", () => node._pgSaveOutputToLibrary?.());
            const histB = mkMini("📖 History", "Open the Prompts ▸ Recent tab", () => { node._pgGoToPrompts?.("recent"); });
            // Header (both views): title + Copy / Save Output / History on the top row, then the
            // Generate Image / Refine / Difference cluster underneath — same layout in main + Expanded.
            const topRight = el("div", { display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto", flexWrap: "wrap", rowGap: "6px", justifyContent: "flex-end" });
            topRight.append(copyB, saveOutB, histB);
            const row1 = el("div", { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", rowGap: "6px" });
            row1.append(title, resInfo, topRight);   // OUTPUT · W×H|aspect · (spacer) · Copy · Save Output · History
            const row2 = el("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "6px" });
            row2.append(refineB, genImgB, diffB);
            const head = el("div", { display: "flex", flexDirection: "column" });
            head.append(row1, row2);

            const prevB = mkMini("◀", "Previous version", () => { if (node._pgHistoryIdx > 0) { node._pgHistoryIdx--; node._pgRenderVersion(); node._pgReflow(); } }, { bg: INPUT_GRAD, bgHi: INPUT_GRAD_HOVER, border: `1px solid ${C.border}` });
            const nextB = mkMini("▶", "Next version", () => { if (node._pgHistoryIdx < node._pgHistory.length - 1) { node._pgHistoryIdx++; node._pgRenderVersion(); node._pgReflow(); } }, { bg: INPUT_GRAD, bgHi: INPUT_GRAD_HOVER, border: `1px solid ${C.border}` });
            // Center cell: the version label, with the live progress bar as its BACKGROUND.
            const ver = el("div", { position: "relative", flex: "1 1 auto", minWidth: "0", textAlign: "center", overflow: "hidden", borderRadius: "6px", background: INPUT_GRAD, border: `1px solid ${C.border}`, boxSizing: "border-box", transition: "background .15s" });
            // Backing chip behind the version/empty label — same dropdown surface + hover lift as the
            // library pager (the progress fill still layers above it during generation).
            ver.addEventListener("mouseenter", () => { ver.style.background = INPUT_GRAD_HOVER; });
            ver.addEventListener("mouseleave", () => { ver.style.background = INPUT_GRAD; });
            const fill = el("div", { position: "absolute", left: "0", top: "0", bottom: "0", width: "0%", background: "hsl(208 73% 57% / 0.40)", transition: "width .2s linear" });
            const verText = el("div", { position: "relative", fontSize: "11px", color: C.textMuted, userSelect: "none", padding: "3px 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, "No output yet — run Generate Prompt");
            ver.append(fill, verText);
            const step = el("div", { display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" });   // = the divider's gap ABOVE the row, so the box sits symmetric below it
            step.append(prevB, ver, nextB);

            // Same min-height as every other box (84px) so it's draggable down the same way; `big` only
            // sets a tall INITIAL height (read-friendly) via `height`, not a floor that blocks resizing.
            const box = el("textarea", { ...baseInputStyle, ...OUTPUT_BOX_STYLE, minHeight: "84px", ...(big ? { height: "300px" } : {}), lineHeight: "1.4" });
            attachBoxHover(box, "var(--pg-box, hsl(220 10% 13%))", "var(--pg-box-hover, hsl(220 10% 16%))");
            box.placeholder = "(Output appears here after running — editable)";
            box.addEventListener("mousedown", stop);
            box.addEventListener("wheel", stop);
            box.addEventListener("keydown", stop);   // Ctrl/⌘+Enter (render this output box) is owned by the global listener — see _pgRunBoxCleanup
            box.addEventListener("input", (e) => {
                stop(e);
                // Keep history in sync with the edited box. If there's no version yet (user typed straight into
                // an EMPTY Output box), START one so Generate Image / Save / Copy use exactly this text.
                let i = node._pgHistoryIdx;
                if (i < 0 || i >= node._pgHistory.length) { node._pgHistory = [box.value]; node._pgHistoryIdx = i = 0; }
                else node._pgHistory[i] = box.value;
                node._pgSyncBoxes(box);
                node._pgUpdateCharCount?.();
            });
            const diff = el("div", { ...baseInputStyle, ...OUTPUT_BOX_STYLE, minHeight: "84px", ...(big ? { height: "300px" } : {}), maxHeight: big ? "700px" : "320px", overflow: "auto", whiteSpace: "pre-wrap", lineHeight: "1.4", display: "none", cursor: "default" });
            diff.addEventListener("mousedown", stop);
            diff.addEventListener("wheel", stop);

            // Bottom meta row: token meter on the LEFT, gen-time + char·word count grouped together
            // on the RIGHT (time first).
            const genTimeEl = el("div", { fontSize: "10px", color: C.textMuted, userSelect: "none", whiteSpace: "nowrap", flex: "0 0 auto" }, "");
            const metaSep = el("span", { fontSize: "10px", color: C.textMuted, userSelect: "none", flex: "0 0 auto", display: "none" }, "·");
            const charCount = el("div", { fontSize: "10px", color: C.textMuted, userSelect: "none", whiteSpace: "nowrap", flex: "0 0 auto" }, "");
            const countGroup = el("div", { display: "flex", alignItems: "center", gap: "8px", flex: "0 0 auto" });
            countGroup.append(genTimeEl, metaSep, charCount);
            const meterEl = el("div", { fontSize: "11px", color: C.textMuted, minHeight: "13px", flex: "1 1 auto", minWidth: "0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, "");
            // Prefix / Suffix pills (far left): write text that always wraps the emitted prompt.
            const affixGroup = el("div", { display: "flex", alignItems: "center", gap: "10px", flex: "1 1 auto", minWidth: "0", flexWrap: "wrap", rowGap: "4px" });
            affixGroup.append(mkAffixAddPill("prefix"), mkAffixAddPill("suffix"), mkAffixGroup("prefix"), mkAffixGroup("suffix"));
            const metaRow = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "1px 2px 0", flexWrap: "wrap", rowGap: "4px" });
            metaRow.append(affixGroup, meterEl, countGroup);
            const wrap = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
            // Divider under the OUTPUT header row only. NO divider UNDER the ◀ ▶ version ("Page Swap") row
            // (it was unnecessary) — the stepper sits directly above the box. Same in main + Expanded.
            wrap.append(head, divider({ margin: "3px 0 4px" }), step, box, diff, metaRow);

            node._pgCharCounts.push(charCount);
            node._pgGenTimeEls.push(genTimeEl);
            node._pgMetaSeps.push(metaSep);
            node._pgResInfos.push(resInfo);
            node._pgOutBoxes.push(box); node._pgDiffBoxes.push(diff); node._pgVerLabels.push(verText);
            node._pgPrevBtns.push(prevB); node._pgNextBtns.push(nextB); node._pgDiffBtns.push(diffB);
            node._pgProgEls.push({ fill });

            // Responsive header: when the cluster is wide enough to fit all six action pills on ONE row,
            // drop Copy/Save/History down to row2 (header keeps just the label + dims). When narrow, keep
            // them on the header row so they don't collide/wrap with row2. Measured (no magic px).
            const outPills = [refineB, genImgB, diffB, copyB, saveOutB, histB];
            const relayout = () => {
                const avail = wrap.clientWidth;
                if (!avail) return;   // hidden / not yet laid out
                let need = 6 * (outPills.length - 1);   // inter-pill gaps (6px)
                for (const p of outPills) need += p.offsetWidth;
                const wide = need <= avail;
                if (wide && copyB.parentNode !== row2) row2.append(copyB, saveOutB, histB);
                else if (!wide && copyB.parentNode !== topRight) topRight.append(copyB, saveOutB, histB);
            };
            (node._pgOutLayouts || (node._pgOutLayouts = [])).push(relayout);
            return { wrap, head, step, box, diff, meter: meterEl };
        };
        node._pgBuildOutputCluster = buildOutputCluster;

        // ---- main-view output cluster ----
        const mainCluster = buildOutputCluster({ big: false });
        const outWrap = mainCluster.wrap;
        const meters = [];   // token/gen-time line(s) — main + Expanded clusters, kept in sync by _renderMeter
        meters.push(mainCluster.meter);   // the meter now lives on the cluster's bottom meta-row (next to char·word count)
        node._pgAddMeter = (m) => { meters.push(m); _renderMeter(); };   // mirror the meter into another cluster (Expanded view)
        // The meter shows token usage AND the generation time — a LIVE count-up while generating that
        // freezes at the final time. Just the value, no label. One renderer keeps both in sync.
        let _meterUsage = null, _meterGenSecs = null, _genTimer = null, _genT0 = 0;
        const _fmtGenSecs = (s) => s == null ? "" : (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(1)}s`);
        const _renderMeter = () => {
            let frac = 0, tokTxt = "";
            if (_meterUsage) {
                const pin = Number(_meterUsage.prompt || 0), pout = Number(_meterUsage.completion || 0), ctx = Number(_meterUsage.context || 0), total = pin + pout;
                tokTxt = ctx ? `Tokens: ${pin} in + ${pout} out = ${total} / ${ctx} ctx` : `Tokens: ${pin} in + ${pout} out = ${total}`;
                frac = ctx ? total / ctx : 0;
            }
            const col = frac >= 0.9 ? DANGER : (frac >= 0.75 ? "#d9a23a" : C.textMuted);
            for (const m of meters) { m.textContent = tokTxt; m.style.color = col; }
            // Generation time now lives with the char·word count (bundled, time first), not in the token meter.
            const timeTxt = _meterGenSecs != null ? _fmtGenSecs(_meterGenSecs) : "";
            for (const g of (node._pgGenTimeEls || [])) g.textContent = timeTxt;
            node._pgSyncMetaSeps?.();
        };
        const _stopGenTimer = () => { if (_genTimer) { clearInterval(_genTimer); _genTimer = null; } };
        node._pgSetGenTime = (secs) => { if (secs != null && Number.isFinite(Number(secs))) _meterGenSecs = Number(secs); _renderMeter(); };
        // Live timer: starts at 0.0s and ticks up while generating, then freezes at the elapsed total.
        node._pgStartGenTimer = () => { _stopGenTimer(); _genT0 = performance.now(); _meterGenSecs = 0; _renderMeter(); _genTimer = setInterval(() => { _meterGenSecs = (performance.now() - _genT0) / 1000; _renderMeter(); }, 100); };
        node._pgStopGenTimer = () => { _stopGenTimer(); if (_genT0) { _meterGenSecs = (performance.now() - _genT0) / 1000; _renderMeter(); } };
        // Open the big "theater" view for reading long outputs.
        const expandBtn = makeButton("⤢ Expanded Output", () => { node._pgState._view = "expanded"; setVal("_view", "expanded"); node._pgApplyView(); }, { marginTop: "4px" });
        const outputCard = node._pgMkGroupCard();
        outputCard.appendChild(outWrap);
        normalWrap.appendChild(outputCard);
        normalWrap.appendChild(expandBtn);   // the Expanded-Output button sits BELOW the card (not part of the group)

        // Diff view: compare the shown version against the previous one (word-level).
        // Applies to EVERY registered cluster (main + theater).
        node._pgDiffOn = false;
        node._pgApplyDiffView = () => {
            const on = !!node._pgDiffOn;
            for (const d of node._pgDiffBtns) d.style.color = on ? C.accent : C.text;
            const i = node._pgHistoryIdx;
            const canDiff = on && i > 0 && i < node._pgHistory.length;
            const parts = canDiff ? wordDiff(node._pgHistory[i - 1], node._pgHistory[i]) : null;
            for (let k = 0; k < node._pgOutBoxes.length; k++) {
                const box = node._pgOutBoxes[k], dbox = node._pgDiffBoxes[k];
                // No diff possible (off, or at the Original with no previous) → show the
                // plain text box. Only render the diff when there's an earlier version.
                if (!canDiff) { dbox.style.display = "none"; box.style.display = "block"; continue; }
                // Match the diff view to the output box's current (possibly resized) height
                // so toggling Diff ⇄ Original doesn't jump the box size.
                const h = box.offsetHeight;
                box.style.display = "none"; dbox.style.display = "block"; dbox.innerHTML = "";
                if (h > 0) { dbox.style.height = h + "px"; dbox.style.maxHeight = "none"; }
                for (const p of parts) {
                    if (p.t === "eq") dbox.appendChild(el("span", { color: C.text }, p.s));
                    else if (p.t === "ins") dbox.appendChild(el("span", { background: "rgba(76,175,80,0.30)", color: "#d8f5d8", borderRadius: "2px" }, p.s));
                    else dbox.appendChild(el("span", { background: "rgba(220,53,69,0.22)", color: "#f3b6bd", textDecoration: "line-through", borderRadius: "2px" }, p.s));
                }
            }
        };

        // Version history (in memory). A normal run resets it; Refine appends.
        node._pgHistory = [];
        node._pgHistoryIdx = -1;
        node._pgRenderVersion = () => {
            const n = node._pgHistory.length;
            const setBoxes = (val) => { for (const b of node._pgOutBoxes) b.value = val; node._pgUpdateCharCount?.(); };
            if (!n) { setBoxes(""); node._pgSetVerText("No output yet — run Generate Prompt"); for (const b of node._pgPrevBtns) b.style.color = C.textMuted; for (const b of node._pgNextBtns) b.style.color = C.textMuted; node._pgApplyDiffView?.(); return; }
            const i = Math.max(0, Math.min(node._pgHistoryIdx, n - 1));
            node._pgHistoryIdx = i;
            setBoxes(node._pgHistory[i] ?? "");
            node._pgSetVerText((i === 0 ? "Original" : "v" + (i + 1)) + (n > 1 ? " / " + n : ""));
            for (const b of node._pgPrevBtns) b.style.color = i > 0 ? C.text : C.textMuted;
            for (const b of node._pgNextBtns) b.style.color = i < n - 1 ? C.text : C.textMuted;
            node._pgApplyDiffView?.();
        };
        node._pgSetOutput = (text) => { node._pgHistory = [text ?? ""]; node._pgHistoryIdx = 0; node._pgDiffOn = false; node._pgRenderVersion(); node._pgReflow(); };

        // The progress bar between the arrows: filled % during generation, then it
        // briefly shows 100% and hands the space back to the version label (all clusters).
        let stepProgHideT = null;
        node._pgSetStepProgress = (frac, done) => {
            if (stepProgHideT) { clearTimeout(stepProgHideT); stepProgHideT = null; }
            const pct = done ? 100 : Math.round(Math.max(0, Math.min(1, frac)) * 100);
            for (const g of node._pgProgEls) g.fill.style.width = pct + "%";   // bar fills behind the version text
            if (done) { node._pgProgDone = true; stepProgHideT = setTimeout(() => { node._pgHideStepProgress(); }, 700); }
        };
        node._pgHideStepProgress = () => {
            if (stepProgHideT) { clearTimeout(stepProgHideT); stepProgHideT = null; }
            for (const g of node._pgProgEls) g.fill.style.width = "0%";
        };

        // Live token stream: update the box as tokens arrive (history is finalized by onExecuted).
        node._pgSetStreaming = (text, done) => {
            node._pgDiffOn = false;
            for (let k = 0; k < node._pgOutBoxes.length; k++) { const bx = node._pgOutBoxes[k]; node._pgDiffBoxes[k].style.display = "none"; bx.style.display = "block"; bx.value = text ?? ""; bx.scrollTop = bx.scrollHeight; }
            node._pgUpdateCharCount?.();
            // Rough progress vs a rolling expected length (computed once per generation).
            const _firstTok = node._pgExpectedLen == null;
            if (_firstTok) { node._pgExpectedLen = expectedOutLen(); node._pgProgDone = false; }
            const len = (text || "").length;
            const frac = done ? 1 : Math.min(0.95, len / node._pgExpectedLen);
            node._pgSetProgress?.(frac, { done });        // thin line in the status bar
            node._pgSetStepProgress?.(frac, done);         // % bar between the arrows
            if (done) { recordOutLen(len); node._pgExpectedLen = null; }
            // The output box is fixed-height and scrolls internally, so mid-stream text does NOT change
            // the node's height. Reflow ONLY on the first token (box may switch diff→text view) and on
            // done — never the middle tokens, which were a redundant setSize + canvas-redraw storm (the
            // per-generation freeze). The guarded _pgReflow also caps any burst at one resize per frame.
            if (_firstTok || done) node._pgReflow();
        };
        node._pgSetUsage = (u) => {
            _meterUsage = u || null;
            if (u && u.gen_time != null && Number.isFinite(Number(u.gen_time))) _meterGenSecs = Number(u.gen_time);   // backend-reported time (graph runs)
            _renderMeter();
        };

        genPanel.appendChild(promptPanel);

        // =========== System Prompt sub-panel ===========
        const sysPromptPanel = el("div", { display: "flex", flexDirection: "column", gap: "6px" });
        const sp1 = node._pgMkGroupCard();   // group card: Load System Prompt header + Select file + Mode
        sysPromptPanel.appendChild(sp1);
        sp1.appendChild(sectionTitle("Load System Prompt"));

        const spText = reg("system_prompt", makeText(true, "Write or insert your system prompt here.\n- Drag and drop, or select a file locally.\nSave your preset when it is done.", (v) => setVal("system_prompt", v), { noGlow: true }));
        Object.assign(spText.el.style, OUTPUT_BOX_STYLE);   // same look as the Prompt/Output boxes
        attachBoxHover(spText.el, "var(--pg-box, hsl(220 10% 13%))", "var(--pg-box-hover, hsl(220 10% 16%))");
        spText.el.style.lineHeight = "1.4";   // identical line spacing to the Prompt/Output boxes
        // Drag & drop a text file straight onto the box to load it (REPLACE), like Select file.
        spText.el.addEventListener("dragover", (e) => { e.preventDefault(); stop(e); spText.el.style.borderColor = C.accentBorder; });
        spText.el.addEventListener("dragleave", (e) => { stop(e); spText.el.style.borderColor = C.border; });
        spText.el.addEventListener("drop", (e) => {
            e.preventDefault(); stop(e); spText.el.style.borderColor = C.border;
            const f = e.dataTransfer?.files?.[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => { const c = String(reader.result ?? ""); spText.set(c); setVal("system_prompt", c); node._pgReflow?.(); };
            reader.readAsText(f);
        });

        const fileBtn = makeButton("📁 Select file…", () => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".txt,.text,.md,.markdown,.json,.csv,.yaml,.yml,.xml,.html,.log,.ini,.cfg,.py,.js,text/*";
            input.style.display = "none";
            input.onchange = (e) => {
                const file = e.target.files?.[0];
                if (!file) { input.remove(); return; }
                const reader = new FileReader();
                reader.onload = () => {
                    // Load the file's text straight into the box (replace), like presets.
                    const content = String(reader.result ?? "");
                    spText.set(content); setVal("system_prompt", content);
                    node._pgReflow?.();
                    input.remove();
                };
                reader.onerror = () => input.remove();
                reader.readAsText(file);
            };
            document.body.appendChild(input);
            input.click();
        });
        sp1.appendChild(labelRow("", fileBtn, { stack: true }));

        const spMode = reg("system_prompt_mode", makeSelect(
            ["replace", "append", "none"],
            (v) => { setVal("system_prompt_mode", v); node._pgUpdatePresetUI?.(); },
            (v) => v === "none" ? "None — no system prompt" : (v.charAt(0).toUpperCase() + v.slice(1)),
            { wheelCycle: true },
        ));
        sp1.appendChild(labelRow("Mode", spMode.el, { labelWidth: "90px" }));

        // group card: the writing box down through the preset controls (Save as preset).
        const sp2 = node._pgMkGroupCard();
        sysPromptPanel.appendChild(sp2);

        // Path of the currently loaded preset (cursive) — under Mode, just above the box.
        const presetPath = el("div", {
            fontStyle: "italic", fontSize: "11px", color: "hsl(0 0% 62%)",
            padding: "0 2px 2px 2px", wordBreak: "break-all", display: "none", transition: "color .15s",
        });
        // Brighten on hover, matching the rest of the UI's interactive text.
        presetPath.addEventListener("mouseenter", () => { presetPath.style.color = C.text; });
        presetPath.addEventListener("mouseleave", () => { presetPath.style.color = "hsl(0 0% 62%)"; });
        sp2.appendChild(presetPath);

        sp2.appendChild(labelRow("", spText.el, { stack: true }));

        // ---- System prompt presets dropdown + delete ----
        node._pgPresetMap = new Map();
        // Shared: select a preset by name — loads its text (REPLACE) and syncs all UI.
        // Used by this dropdown AND the Prompt-view quick-pick.
        node._pgApplyPreset = (name) => {
            node._pgState.override_system_prompt = name;
            node._pgWriteConfig();
            presetSel.set(name);
            // Keep the Prompt-view quick-pick(s) in sync ((None) shows as the text-field option).
            const qv = (name === NONE_PRESET) ? PRESET_MODE : name;
            for (const q of (node._pgQuickSelects || [])) q.set(qv);
            const info = node._pgPresetMap.get(name);
            if (info) {
                spText.set(info.text); setVal("system_prompt", info.text);
                spMode.set("replace"); setVal("system_prompt_mode", "replace");
            }
            node._pgUpdatePresetUI();
            node._pgUpdateImageBox?.();   // vision presets reveal the image loader
        };
        const presetSel = reg("override_system_prompt", makeSelect([NONE_PRESET], (v) => {
            node._pgApplyPreset(v);
            node._pgReflow();
        }, (v) => v === NONE_PRESET ? "None" : (v === NO_SYS_PROMPT ? "No system prompt" : v),   // display-only (values unchanged)
           { visionOf: (v) => !!node._pgPresetMap?.get(v)?.vision, searchable: true, wheelCycle: true }));
        const delBtn = el("div", {
            flex: "0 0 auto", width: "30px", textAlign: "center", padding: "5px 0",
            border: `1px solid ${C.border}`, borderRadius: "6px", background: C.card,
            color: C.text, cursor: "pointer", fontSize: "13px", userSelect: "none",
        }, "🗑");
        delBtn.title = "Delete selected preset (file presets only)";
        delBtn.addEventListener("mousedown", stop);
        delBtn.addEventListener("click", async (e) => {
            stop(e);
            const name = node._pgState.override_system_prompt;
            const info = node._pgPresetMap.get(name);
            if (!info || !info.deletable) return;
            const ok = await pmModal({
                title: "Delete preset?",
                message: `Delete "${name}"?\n\nThis permanently deletes the file from disk:\n${info.path}`,
                confirmLabel: "Delete", danger: true,
            });
            if (!ok) return;
            const r = await deletePreset(name);
            if (r?.ok) {
                node._pgState.override_system_prompt = NONE_PRESET;
                node._pgWriteConfig(true);
                await node._pgRefreshPresets({ fresh: true });
                // Advance to the next of YOUR (deletable) presets so you can delete several in a row;
                // if none remain, stay on None. (Matches the resolution saved-presets delete behaviour.)
                const next = [...(node._pgPresetMap?.values() || [])].find((p) => p.deletable);
                if (next) node._pgApplyPreset(next.name);
                node._pgReflow();
            } else {
                await pmModal({ title: "Delete failed", message: r?.error || "Unknown error", confirmLabel: "OK", cancelLabel: "Close" });
            }
        });
        // ---- Rename selected preset (file presets only) ----
        const renameBtn = el("div", {
            flex: "0 0 auto", width: "40px", textAlign: "center", padding: "5px 0",
            border: `1px solid ${C.border}`, borderRadius: "6px", background: C.card,
            color: C.text, cursor: "pointer", fontSize: "13px", userSelect: "none",
        }, "✎");
        renameBtn.title = "Rename selected preset (file presets only)";
        renameBtn.addEventListener("mousedown", stop);
        renameBtn.addEventListener("click", async (e) => {
            stop(e);
            const name = node._pgState.override_system_prompt;
            const info = node._pgPresetMap.get(name);
            if (!info || !info.deletable) return;
            const res = await pmModal({ title: "Rename preset", message: `Rename "${name}" to:`, input: { placeholder: "New name", value: name }, confirmLabel: "Rename" });
            if (res === null) return;
            const clean = String(res).trim();
            if (!clean || clean === name) return;
            // Save under the new name (carry the text + vision flag), then delete the old file.
            const r = await savePreset(clean, info.text, !!info.vision);
            if (r?.ok) {
                await deletePreset(name);
                node._pgState.override_system_prompt = r.name;
                node._pgWriteConfig(true);
                await node._pgRefreshPresets({ fresh: true });
                node._pgReflow();
            } else {
                await pmModal({ title: "Rename failed", message: r?.error || "Unknown error", confirmLabel: "OK", cancelLabel: "Close" });
            }
        });
        // Presets dropdown goes full width (aligns with the right edge like other controls);
        // the ✎ rename + 🗑 delete move down next to "Save as preset".
        sp2.appendChild(sectionTitle("Presets"));
        const presetRow = labelRow("Presets", presetSel.el, { labelWidth: "90px" });
        sp2.appendChild(presetRow);

        // ---- Save current text as a new preset ----
        const saveBtn = makeButton("💾 Save as preset", async () => {
            const text = node._pgState.system_prompt || "";
            if (!text.trim()) {
                await pmModal({ title: "Nothing to save", message: "The system prompt text box is empty.", confirmLabel: "OK", cancelLabel: "Close" });
                return;
            }
            const cur = node._pgState.override_system_prompt;
            const curInfo = node._pgPresetMap.get(cur);
            const def = (curInfo && curInfo.deletable) ? cur : "";
            const res = await pmModal({
                title: "Save system prompt preset",
                message: "Saves a .txt file in the node's prompts/presets folder. This name appears in the presets dropdown.",
                input: { placeholder: "Preset name", value: def }, confirmLabel: "Save",
                // Vision presets get the in-node image loader (like the Ideogram modes).
                checkbox: { label: "👁 Vision preset (analyze an uploaded image)", value: !!(curInfo && curInfo.vision) },
            });
            if (res === null) return;
            const clean = String(res.value || "").trim();
            if (!clean) return;
            const r = await savePreset(clean, text, !!res.checked);
            if (r?.ok) {
                node._pgState.override_system_prompt = r.name;
                node._pgWriteConfig(true);
                await node._pgRefreshPresets({ fresh: true });
            } else {
                await pmModal({ title: "Save failed", message: r?.error || "Unknown error", confirmLabel: "OK", cancelLabel: "Close" });
            }
        }, { marginTop: "2px" });
        // Save (grows) + 🗑 delete on one row, so the dropdown above stays full width.
        saveBtn.style.flex = "1 1 auto"; saveBtn.style.width = "auto";
        delBtn.style.width = "40px";
        const saveRow = el("div", { display: "flex", alignItems: "stretch", gap: "6px", marginTop: "2px" });
        saveRow.append(saveBtn, renameBtn, delBtn);
        sp2.appendChild(saveRow);

        // Update the path label + delete-button enabled state from the selection.
        node._pgUpdatePresetUI = function () {
            const sel = node._pgState.override_system_prompt;
            const info = node._pgPresetMap.get(sel);
            const noSys = (sel === NO_SYS_PROMPT) || (node._pgState.system_prompt_mode === "none");
            if (noSys) {
                presetPath.style.display = "block";
                presetPath.textContent = "⛔ No system prompt will be sent (the instructions box is ignored).";
                presetPath.title = "";
            } else if (info) {
                presetPath.style.display = "block";
                presetPath.textContent = info.deletable ? info.path : "(built-in preset)";
                presetPath.title = info.path || "";
            } else {
                presetPath.style.display = "none";
                presetPath.textContent = "";
            }
            const deletable = !!(info && info.deletable);
            delBtn.style.opacity = deletable ? "1" : "0.35";
            delBtn.style.pointerEvents = deletable ? "auto" : "none";
            renameBtn.style.opacity = deletable ? "1" : "0.35";   // rename only your own presets
            renameBtn.style.pointerEvents = deletable ? "auto" : "none";
            node._pgUpdateChecklist?.();   // keep the ⚙ Prompt chip in sync
        };

        // Fetch presets from the server and (re)populate the dropdown.
        node._pgRefreshPresets = function (opts = {}) {
            return fetchPresets(opts).then((presets) => {
                node._pgPresetMap = new Map();
                // NONE_PRESET = use mode default; NO_SYS_PROMPT = send nothing.
                const names = [NONE_PRESET, NO_SYS_PROMPT];
                for (const p of presets) { node._pgPresetMap.set(p.name, p); names.push(p.name); }
                const sel = node._pgState.override_system_prompt;
                const keep = (node._pgPresetMap.has(sel) || sel === NONE_PRESET || sel === NO_SYS_PROMPT) ? sel : NONE_PRESET;
                node._pgState.override_system_prompt = keep;
                presetSel.fill(names, keep);
                // Prompt-view quick-pick: only the user's own (deletable) presets.
                const userNames = presets.filter((p) => p.deletable).map((p) => p.name);
                // Order: None (no system prompt) · text field · your saved presets.
                const quickItems = [NO_SYS_PROMPT, PRESET_MODE, ...userNames];
                const quickKeep = (keep === NO_SYS_PROMPT) ? NO_SYS_PROMPT
                    : (node._pgPresetMap.get(keep)?.deletable ? keep : PRESET_MODE);
                for (const q of (node._pgQuickSelects || [])) q.fill?.(quickItems, quickKeep);
                node._pgUpdatePresetUI();
                node._pgWriteConfig();
            });
        };

        const showConsole = reg("show_everything_in_console", makeToggle((v) => setVal("show_everything_in_console", v)));
        const scRow = labelRow("Show Everything in Console", showConsole.el, { labelWidth: "auto" });
        scRow.style.justifyContent = "space-between"; scRow._label.style.flex = "1 1 auto";
        wireToggleRow(scRow, showConsole);   // click anywhere on the row or scroll over it to toggle
        sysPromptPanel.appendChild(scRow);
        genPanel.appendChild(sysPromptPanel);

        // =========== Resolution sub-panel ===========
        // Visual resolution picker. A fixed 1:1 square is a 0–2048 frame; the inner rectangle is the
        // chosen W×H drawn to scale (anchored top-left). Drag the right-edge (width), bottom-edge
        // (height) or corner (both) handle. EVERY path funnels through _pgResCommit → resSnap, which
        // rounds EACH axis independently to the active divisor — divisibility is the invariant.
        const RES_MAX = 2048;          // canvas/base cap (the square frame)
        const RES_OUT_MAX = 8192;      // final-output cap — base × scale may exceed the 2048 frame
        const resDiv = () => Math.max(1, node._pgState.res_divisor | 0);
        const resSnap = (v) => { const d = resDiv(); return Math.max(d, Math.min(RES_MAX, Math.round(v / d) * d)); };        // base axis
        const resSnapOut = (v) => { const d = resDiv(); return Math.max(d, Math.min(RES_OUT_MAX, Math.round(v / d) * d)); }; // final axis
        node._pgResSnap = resSnap;
        // FINAL output = base × scale, snapped per-axis to the divisor (can exceed 2048). Written to
        // config → the node's width/height outputs read these.
        const resRecomputeFinal = () => {
            const s = node._pgState.res_scale || 1;
            node._pgState.res_width = resSnapOut(node._pgState.res_base_w * s);
            node._pgState.res_height = resSnapOut(node._pgState.res_base_h * s);
            setVal("res_width", node._pgState.res_width);
            setVal("res_height", node._pgState.res_height);
        };
        // Choke-point: set the BASE (canvas) resolution, per-axis-snapped to the divisor and ≤2048;
        // then recompute the scaled final + resync everything (divisibility stays the invariant).
        // Locked aspect ratio (parsed from res_aspect "W:H"), or null when Free. Divisibility still
        // WINS — the lock just derives the other axis before each per-axis snap (so the ratio is
        // approximate, decimals allowed, exactly as specced).
        const resAspectRatio = () => { const m = /^(\d+):(\d+)$/.exec(node._pgState.res_aspect || ""); return (m && +m[1] > 0 && +m[2] > 0) ? (+m[1] / +m[2]) : null; };
        node._pgResAspectRatio = resAspectRatio;
        node._pgResCommit = (w, h, axis) => {
            const R = resAspectRatio();
            if (R) { if (axis === "h") w = h * R; else h = w / R; }   // lock: width drives unless height is the axis being set
            node._pgState.res_base_w = resSnap(w);
            node._pgState.res_base_h = resSnap(h);
            setVal("res_base_w", node._pgState.res_base_w);
            setVal("res_base_h", node._pgState.res_base_h);
            resRecomputeFinal();
            node._pgResSync?.();
        };

        const resolutionPanel = el("div", { display: "none", flexDirection: "column", gap: "6px", flexShrink: "0" });
        // Header row: "Resolution" title + a "Send to Vision" pill that hands the canvas's loaded
        // reference image to the node's vision input, so it can be analyzed by the Prompt Generator.
        const resHead = sectionTitle("Resolution");
        resHead.style.justifyContent = "space-between";
        const sendVisionBtn = pillBtn("\u{1F441}\u{FE0E} Send to Vision",
            "Load this image as the node's vision input (Analyze Image / Ideogram modes) and jump to the Prompt view",
            async (b) => {
                const f = node._pgResImageFile;
                if (!f) return;
                const o = b.textContent; b.textContent = "Sending…";
                try {
                    const meta = await uploadImage(f);
                    node._pgLoadImageMeta?.(meta);   // set it as the in-node vision image (sticky)
                    node._pgState._view = "generator"; setVal("_view", "generator");
                    node._pgState._genView = "prompt"; setVal("_genView", "prompt");
                    node._pgApplyView?.();
                    b.textContent = "\u{1F441}\u{FE0E} Sent ✓"; setTimeout(() => { b.textContent = o; }, 1400);
                } catch { b.textContent = "Send failed"; setTimeout(() => { b.textContent = o; }, 1400); }
            });
        // Greyed + inert until an image is actually loaded in the canvas (drop / 🖼 Load Image).
        node._pgResSyncSendVision = () => {
            const has = !!node._pgResImageFile;
            sendVisionBtn.style.opacity = has ? "1" : "0.4";
            sendVisionBtn.style.pointerEvents = has ? "auto" : "none";
        };
        node._pgResSyncSendVision();
        resHead.appendChild(sendVisionBtn);
        resolutionPanel.appendChild(resHead);
        resolutionPanel.appendChild(divider({ margin: "2px 0 4px" }));
        // Responsive side-by-side: square (left) + options (right) — same flex split as the preview.
        const resSplit = el("div", { display: "flex", flexDirection: "row", gap: "10px", alignItems: "flex-start", flexWrap: "wrap" });
        const resLeftCol = el("div", { display: "flex", flexDirection: "column", gap: "6px", flex: "0 0 auto" });   // hugs the square (no dead gap before the sliders)
        const resRightCol = el("div", { display: "flex", flexDirection: "column", gap: "6px", flex: "1 1 auto", minWidth: "0" });   // fills the rest → sliders resize with the space

        // The 1:1 square canvas (always square via aspect-ratio; sized to the left column's width).
        const resCanvasWrap = el("div", { position: "relative", width: "280px", aspectRatio: "1 / 1", background: INPUT_GRAD, border: `1px solid ${C.border}`, borderRadius: "8px", overflow: "hidden", cursor: "crosshair", touchAction: "none", boxSizing: "border-box" });
        const resCanvas = el("canvas", { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block" });
        resCanvasWrap.appendChild(resCanvas);
        // Manual resize grip (bottom-right) — drag to size the MAIN square directly (the inner
        // rectangle redraws proportionally since it's (res/2048)×size). Persists in res_sqsize;
        // 0 = auto-fill the column. A set size still caps at the column width via maxWidth:100%.
        if (node._pgState.res_sqsize) resCanvasWrap.style.width = node._pgState.res_sqsize + "px";
        const resGrip = el("div", { position: "absolute", right: "0", bottom: "0", width: "18px", height: "18px", cursor: "nwse-resize", zIndex: "4", display: "flex", alignItems: "flex-end", justifyContent: "flex-end", padding: "2px", boxSizing: "border-box" });
        resGrip.appendChild(el("div", { width: "0", height: "0", borderLeft: "9px solid transparent", borderBottom: `9px solid ${C.textMuted}`, opacity: "0.65" }));
        resCanvasWrap.appendChild(resGrip);
        let _resGripDrag = false;
        resGrip.addEventListener("pointerdown", (e) => { stop(e); _resGripDrag = true; try { resGrip.setPointerCapture(e.pointerId); } catch {} });
        resGrip.addEventListener("pointermove", (e) => {
            if (!_resGripDrag) return; stop(e);
            const r = resCanvasWrap.getBoundingClientRect();
            const sz = Math.max(160, Math.min(4096, Math.round(Math.max(e.clientX - r.left, e.clientY - r.top))));
            node._pgState.res_sqsize = sz; setVal("res_sqsize", sz);
            resCanvasWrap.style.width = sz + "px";
            resDraw(); node._pgReflow?.();
        });
        const _resGripEnd = (e) => { if (_resGripDrag) { _resGripDrag = false; try { resGrip.releasePointerCapture(e.pointerId); } catch {} } };
        resGrip.addEventListener("pointerup", _resGripEnd);
        resGrip.addEventListener("pointercancel", _resGripEnd);
        const resCtx = resCanvas.getContext("2d");
        let _resCss = 0;   // current CSS px size of the square (square → one number)
        let _resImage = null, _resImageUrl = null;   // optional drag-dropped reference image (0.6 underlay)

        const resRatioLabel = pgRatioLabel;   // module-level — shared with the output readout
        // Canvas accent rgb: cool blue normally, light grey while bypassed (the sliders do the same
        // via the --pg-res-* CSS vars; the canvas can't use vars so it reads bypass state here).
        const resRgb = () => node._pgState._bypass ? "172,174,180" : "96,165,250";
        const resGeom = () => {
            const rw = Math.min(1, node._pgState.res_base_w / RES_MAX) * _resCss;
            const rh = Math.min(1, node._pgState.res_base_h / RES_MAX) * _resCss;
            const top = _resCss - rh;   // rectangle anchored at the BOTTOM-left, grows UP + right
            return { rw, rh, top, handles: { w: [rw, top + rh / 2], h: [rw / 2, top], c: [rw, top] } };
        };
        const resDraw = () => {
            const css = Math.max(0, resCanvasWrap.getBoundingClientRect().width || 0);
            if (css < 8) return;
            _resCss = css;
            const dpr = window.devicePixelRatio || 1;
            const pxs = Math.round(css * dpr);
            if (resCanvas.width !== pxs) { resCanvas.width = pxs; resCanvas.height = pxs; }
            const g = resCtx;
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, css, css);
            // Subtle grid the rectangle LOCKS to: one cell = the divisor, so a snapped edge always
            // lands on a dot column/row. Coarsen the DRAWN grid if cells get too dense for the size.
            // Aligned to LEFT + BOTTOM (the rect's anchor) so the rect's edges sit right on the dots.
            let gp = (resDiv() / RES_MAX) * css;
            while (gp > 0 && gp < 7) gp *= 2;
            if (gp > 0.5) {
                g.fillStyle = "rgba(255,255,255,0.16)";
                for (let x = 0; x <= css + 0.5; x += gp) for (let y = css; y >= -0.5; y -= gp) { g.beginPath(); g.arc(x, y, 1.0, 0, 6.2832); g.fill(); }
            }
            // inner rectangle = chosen W×H scaled into the 2048 frame, anchored top-left
            const { rw, rh, top, handles } = resGeom();
            g.fillStyle = `rgba(${resRgb()},0.16)`;
            g.fillRect(0, top, rw, rh);
            // Loaded image as a 60%-opacity background, clipped to + stretched across the rectangle.
            if (_resImage) { g.save(); g.beginPath(); g.rect(0, top, rw, rh); g.clip(); g.globalAlpha = 0.6; try { g.drawImage(_resImage, 0, top, rw, rh); } catch {} g.globalAlpha = 1; g.restore(); }
            g.strokeStyle = `rgba(${resRgb()},0.95)`;
            g.lineWidth = 1.5;
            g.strokeRect(0.75, top + 0.75, Math.max(0, rw - 1.5), Math.max(0, rh - 1.5));
            // handles: pink = width (right edge), blue = height (bottom edge), white = corner (both)
            const dot = (xy, fill) => { g.beginPath(); g.arc(xy[0], xy[1], 6, 0, 6.2832); g.fillStyle = fill; g.fill(); g.lineWidth = 2; g.strokeStyle = "rgba(0,0,0,0.45)"; g.stroke(); };
            dot(handles.h, "#5b8def");
            dot(handles.w, "#f06595");
            dot(handles.c, "#ffffff");
        };
        node._pgResReflowCanvas = () => requestAnimationFrame(resDraw);

        // Drag interaction (pointer events + capture, so a drag survives leaving the square).
        let _resDrag = null;   // "w" | "h" | "c"
        const resLocal = (e) => { const r = resCanvasWrap.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        const resHit = (p) => {
            const { handles } = resGeom();
            const near = (xy) => Math.hypot(p.x - xy[0], p.y - xy[1]) <= 15;
            if (near(handles.c)) return "c";
            if (near(handles.w)) return "w";
            if (near(handles.h)) return "h";
            return null;
        };
        const resApplyDrag = (p) => {
            const vx = (Math.max(0, Math.min(_resCss, p.x)) / _resCss) * RES_MAX;
            const vy = ((_resCss - Math.max(0, Math.min(_resCss, p.y))) / _resCss) * RES_MAX;   // measured from the BOTTOM up
            if (_resDrag === "w") node._pgResCommit(vx, node._pgState.res_base_h, "w");
            else if (_resDrag === "h") node._pgResCommit(node._pgState.res_base_w, vy, "h");
            else node._pgResCommit(vx, vy, "w");
        };
        resCanvasWrap.addEventListener("pointerdown", (e) => { stop(e); const p = resLocal(e); _resDrag = resHit(p) || "c"; try { resCanvasWrap.setPointerCapture(e.pointerId); } catch {} resApplyDrag(p); });
        resCanvasWrap.addEventListener("pointermove", (e) => { if (!_resDrag) return; stop(e); resApplyDrag(resLocal(e)); });
        const resEndDrag = (e) => { if (_resDrag) { _resDrag = null; try { resCanvasWrap.releasePointerCapture(e.pointerId); } catch {} } };
        resCanvasWrap.addEventListener("pointerup", resEndDrag);
        resCanvasWrap.addEventListener("pointercancel", resEndDrag);
        resCanvasWrap.addEventListener("wheel", stop);
        // Drag-and-drop an image directly onto the big square. ComfyUI also listens for file drops
        // (to spawn a LoadImage node), so a plain element handler can lose the race — we intercept at
        // the DOCUMENT in CAPTURE phase, but ONLY when a file is dragged over our visible square, and
        // stopImmediatePropagation so ComfyUI's handler never fires. The 🖼 Load button is the fallback.
        const resPtOverSquare = (e) => {
            if (!resCanvasWrap.offsetParent) return false;   // panel hidden → ignore
            const r = resCanvasWrap.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        };
        const resHasFiles = (e) => { const dt = e.dataTransfer; return !!(dt && Array.from(dt.types || []).includes("Files")); };
        const resDocDragOver = (e) => {
            if (!resHasFiles(e) || !resPtOverSquare(e)) { resCanvasWrap.style.borderColor = C.border; return; }
            e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            resCanvasWrap.style.borderColor = C.accent;
        };
        const resDocDrop = (e) => {
            resCanvasWrap.style.borderColor = C.border;
            if (!resHasFiles(e) || !resPtOverSquare(e)) return;
            e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) node._pgResLoadImageFile?.(f);
        };
        document.addEventListener("dragover", resDocDragOver, true);
        document.addEventListener("drop", resDocDrop, true);
        node._pgResDropCleanup = () => { document.removeEventListener("dragover", resDocDragOver, true); document.removeEventListener("drop", resDocDrop, true); };

        // Readout under the square: W × H · MP · ratio (only the dims bold).
        const resReadout = el("div", { textAlign: "center", fontSize: "12px", color: C.textMuted, userSelect: "none", padding: "1px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        const resOutLine = el("div", { textAlign: "center", fontSize: "11px", color: C.textMuted, userSelect: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        const resUpdateReadout = () => {
            // Square readout = the BASE (design) resolution the canvas represents (≤ 2048).
            const bw = node._pgState.res_base_w, bh = node._pgState.res_base_h;
            resReadout.innerHTML = "";
            const span = (t, strong) => el("span", strong ? { color: C.text, fontWeight: "600" } : {}, t);
            resReadout.append(span(`${bw} × ${bh}`, true), span("  ·  "), span(`${(bw * bh / 1e6).toFixed(2)} MP`), span("  ·  "), span(resRatioLabel(bw, bh)));
            // The actual emitted resolution after the Scale multiplier (what the outputs carry).
            resOutLine.innerHTML = "";
            resOutLine.append(el("span", {}, "Resolution after Scaling:  "), el("span", { color: C.text, fontWeight: "600" }, `${node._pgState.res_width} × ${node._pgState.res_height}`));
        };

        resLeftCol.append(resCanvasWrap, resReadout, resOutLine);

        // Image load/unload (drag-drop onto the square also works). Loading adopts the image's dims
        // (fit to the 2048 base frame, snapped to the divisor); Unload clears the underlay but keeps
        // the current resolution.
        const resImgInput = document.createElement("input");
        resImgInput.type = "file"; resImgInput.accept = "image/*"; resImgInput.style.display = "none";
        resImgInput.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; resImgInput.value = ""; if (f) node._pgResLoadImageFile(f); });
        const resUnloadBtn = makeButton("✕ Unload Image", () => node._pgResUnloadImage(), { width: "auto", flex: "0 0 auto", padding: "5px 10px", fontSize: "11px", display: "none", background: C.card });
        const resLoadBtn = makeButton("🖼 Load Image", () => resImgInput.click(), { width: "auto", flex: "1 1 auto", padding: "5px 10px", fontSize: "11px" });
        const resImgRow = el("div", { display: "flex", alignItems: "center", gap: "6px", marginTop: "auto" });   // pin to the bottom of the (stretched) column
        resImgRow.append(resLoadBtn, resUnloadBtn);   // appended to the shared bottom action bar below (not the column)
        node._pgResLoadImageFile = (file) => {
            if (!file || !/^image\//.test(file.type || "")) return;
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                if (_resImageUrl) { try { URL.revokeObjectURL(_resImageUrl); } catch {} }
                _resImage = img; _resImageUrl = url;
                node._pgResImageFile = file;   // keep the File so "Send to Vision" can upload it
                let w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
                const mx = Math.max(w, h); if (mx > RES_MAX) { const k = RES_MAX / mx; w *= k; h *= k; }
                node._pgState.res_aspect = "Custom"; setVal("res_aspect", "Custom");   // image drives both axes
                node._pgResCommit(w, h, "w");
                resUnloadBtn.style.display = "";
                node._pgResSyncSendVision?.();
            };
            img.onerror = () => { try { URL.revokeObjectURL(url); } catch {} };
            img.src = url;
        };
        node._pgResUnloadImage = () => {
            if (_resImageUrl) { try { URL.revokeObjectURL(_resImageUrl); } catch {} _resImageUrl = null; }
            _resImage = null; node._pgResImageFile = null; resUnloadBtn.style.display = "none"; node._pgResSync?.();
            node._pgResSyncSendVision?.();
        };

        // --- right column: per-value filled-track sliders (LABEL · value / slider / divider) ---
        // Each row: "LABEL … [editable value][unit]" header, then the slider, then a divider. The
        // value is a click-to-type input that routes through slider.applyUser → the same snap/commit
        // pipeline (so a typed value is still forced divisible), not a drag-only control.
        const resSliderRow = (label, slider, opts) => {
            const valInput = el("input", { width: "48px", textAlign: "right", fontSize: "12px", fontWeight: "600", color: C.text, background: "transparent", border: "none", borderBottom: "1px solid transparent", transition: "border-color .12s, color .12s", padding: "0 0 1px", outline: "none", fontFamily: FONT, cursor: "text", boxSizing: "border-box" });
            valInput.type = "text"; valInput.title = "Click to type a value";
            // setVal/setColor skip while the box is focused so they never clobber what you're typing.
            const setDisplay = (v) => { if (document.activeElement !== valInput) valInput.value = opts.fmt(v); };
            const setColor = (c) => { if (document.activeElement !== valInput) valInput.style.color = c || C.text; };
            const commit = () => { const v = opts.parse(valInput.value); if (Number.isFinite(v)) slider.applyUser(v); else node._pgResSync?.(); };
            valInput.addEventListener("mousedown", stop);
            // On focus, edit the UNDERLYING (base) value in normal color — opts.editValue supplies it for the
            // Width/Height rows, whose displayed value may be the post-scale output (see resSyncControls).
            valInput.addEventListener("focus", () => { valInput.style.borderBottomColor = C.accent; if (opts.editValue) valInput.value = opts.fmt(opts.editValue()); valInput.style.color = C.text; valInput.select(); });
            valInput.addEventListener("blur", () => { valInput.style.borderBottomColor = "transparent"; commit(); });
            valInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") valInput.blur(); });
            const valWrap = el("div", { display: "flex", alignItems: "baseline", gap: "3px", flex: "0 0 auto" });
            valWrap.appendChild(valInput);
            if (opts.unit) valWrap.appendChild(el("span", { fontSize: "11px", fontWeight: "600", color: C.textMuted }, opts.unit));
            const labelEl = miniLabel(label);
            const head = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" });
            head.append(labelEl, valWrap);
            const block = el("div", { display: "flex", flexDirection: "column", gap: "3px" });
            // Hovering the row brightens its label (matches the rest of the UI's interactive feedback).
            block.addEventListener("mouseenter", () => { labelEl.style.color = C.text; });
            block.addEventListener("mouseleave", () => { labelEl.style.color = C.heading; });
            block.append(head, slider.el, divider({ margin: "3px 0 1px" }));
            return { block, setVal: setDisplay, setColor };
        };
        const SLOPT = { accent: `var(--pg-res-accent, ${C.accent})`, activeAccent: `var(--pg-res-active, ${ACCENT_DEEP})`, thumbDot: "var(--pg-res-thumbdot, transparent)" };
        const wSlider = makeSlider(64, RES_MAX, 1, (v) => node._pgResCommit(v, node._pgState.res_base_h, "w"), { ...SLOPT, wheelStep: 64, ticks: true, tickStep: 256, format: (v) => String(Math.round(v)) });
        const hSlider = makeSlider(64, RES_MAX, 1, (v) => node._pgResCommit(node._pgState.res_base_w, v, "h"), { ...SLOPT, wheelStep: 64, ticks: true, tickStep: 256, format: (v) => String(Math.round(v)) });
        const scaleSlider = makeSlider(25, 400, 5, (pv) => { node._pgState.res_scale = pv / 100; setVal("res_scale", node._pgState.res_scale); resRecomputeFinal(); node._pgResSync?.(); }, { ...SLOPT, wheelStep: 5, ticks: true, tickStep: 25, format: (v) => Math.round(v) + "%" });
        const mpSlider = makeSlider(0.25, 4.19, 0.01, (mp) => { const r = node._pgResAspectRatio?.() || (node._pgState.res_base_w / Math.max(1, node._pgState.res_base_h)); node._pgResCommit(Math.sqrt(mp * 1e6 * r), Math.sqrt(mp * 1e6 / r), "w"); }, { ...SLOPT, wheelStep: 0.05, ticks: true, tickStep: 1, format: (v) => v.toFixed(2) + " MP" });
        const intParse = (s) => parseInt(String(s).replace(/[^\d.]/g, ""), 10);
        const fltParse = (s) => parseFloat(String(s).replace(/[^\d.]/g, ""));
        // Faint red marks values affected by a non-100% Scale (Width/Height then show the post-scale output).
        const RES_SCALED_TX = "hsl(0 72% 67%)";
        const wRow = resSliderRow("Width", wSlider, { unit: "", parse: intParse, fmt: (v) => String(Math.round(v)), editValue: () => node._pgState.res_base_w });
        const hRow = resSliderRow("Height", hSlider, { unit: "", parse: intParse, fmt: (v) => String(Math.round(v)), editValue: () => node._pgState.res_base_h });
        const sRow = resSliderRow("Scale", scaleSlider, { unit: "%", parse: fltParse, fmt: (v) => String(Math.round(v)) });
        const mpRow = resSliderRow("Megapixel", mpSlider, { unit: "MP", parse: fltParse, fmt: (v) => v.toFixed(2) });
        resRightCol.append(wRow.block, hRow.block, sRow.block, mpRow.block);
        // --- aspect-ratio + divisibility dropdowns (scroll-cycle like the other dropdowns) ---
        const aspectSel = makeSelect(["Custom", "1:1", "4:3", "3:2", "16:9", "21:9", "3:4", "2:3", "9:16"], (v) => {
            node._pgState.res_aspect = v; setVal("res_aspect", v);
            const R = resAspectRatio();
            if (R) { const area = node._pgState.res_base_w * node._pgState.res_base_h; node._pgResCommit(Math.sqrt(area * R), Math.sqrt(area / R), "w"); }   // reshape to the ratio, keep ~area
            else node._pgResSync?.();
        }, (v) => v === "Custom" ? (pgRatioLabel(node._pgState.res_base_w, node._pgState.res_base_h) || "Custom") : v,   // never show the word "Custom" — show the live computed ratio of the current W:H
           { wheelCycle: true, searchable: true, searchPlaceholder: "Search or type W:H…", acceptCustom: (s) => { const m = /^(\d+)\s*:\s*(\d+)$/.exec(String(s).trim()); return (m && +m[1] > 0 && +m[2] > 0) ? (m[1] + ":" + m[2]) : null; } });
        const divSel = makeSelect(["8", "16", "32", "64", "128"], (v) => {
            node._pgState.res_divisor = parseInt(v, 10) || 64; setVal("res_divisor", node._pgState.res_divisor);
            node._pgResCommit(node._pgState.res_base_w, node._pgState.res_base_h, "w");   // re-snap current res to the new divisor immediately
        }, (v) => "÷ " + v, { wheelCycle: true });
        const resDDRow = (label, sel) => {
            sel.el.style.flex = "0 0 auto"; sel.el.style.width = "118px";
            const lab = miniLabel(label, { flex: "0 0 auto" });
            const row = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginTop: "4px" });
            // Brighten the label on hover — matches the slider rows' interactive feedback.
            row.addEventListener("mouseenter", () => { lab.style.color = C.text; });
            row.addEventListener("mouseleave", () => { lab.style.color = C.heading; });
            row.append(lab, sel.el);
            return row;
        };
        resRightCol.append(resDDRow("Aspect ratio", aspectSel), resDDRow("Divisible by", divSel));

        // --- save / load named resolutions (localStorage) ---
        const RES_SAVE_KEY = "pg_res_saved";
        const resLoadSaved = () => { try { return JSON.parse(localStorage.getItem(RES_SAVE_KEY) || "[]") || []; } catch { return []; } };
        const resWriteSaved = (arr) => { try { localStorage.setItem(RES_SAVE_KEY, JSON.stringify(arr)); } catch {} };
        // Display as "AspectRatio  -  W x H" using the FINAL (post-scale) output dims; ratio is the
        // locked aspect, or the computed ratio of the dims when Free.
        // Auto descriptive label ("16:9  -  1920 x 1080") — used as the default suggested name.
        const resSavedDesc = (e) => {
            const d = e.divisor || 64, s = e.scale || 1;
            const fw = Math.max(d, Math.round(e.base_w * s / d) * d), fh = Math.max(d, Math.round(e.base_h * s / d) * d);
            const asp = /^\d+:\d+$/.test(e.aspect || "") ? e.aspect : resRatioLabel(fw, fh);   // tolerant of "Free"/"Custom"
            // Order mirrors the readout under the square: Width × Height · MP · AspectRatio.
            return `${fw} × ${fh}  ·  ${(fw * fh / 1e6).toFixed(2)} MP  ·  ${asp}`;
        };
        // The dropdown/identity label: the user-given name when present, else the auto description.
        const resSavedName = (e) => (e.name && String(e.name).trim()) ? String(e.name).trim() : resSavedDesc(e);
        const RES_SAVE_EMPTY = "(no saved resolutions)";
        let _resSavedPick = null;
        const resSavedSel = makeSelect([RES_SAVE_EMPTY], (name) => {
            if (name === RES_SAVE_EMPTY) return;
            _resSavedPick = name;
            const e = resLoadSaved().find((x) => resSavedName(x) === name);
            if (!e) return;
            node._pgState.res_divisor = e.divisor || 64; setVal("res_divisor", node._pgState.res_divisor);
            node._pgState.res_aspect = /^\d+:\d+$/.test(e.aspect || "") ? e.aspect : "Custom"; setVal("res_aspect", node._pgState.res_aspect);
            node._pgState.res_scale = e.scale || 1; setVal("res_scale", node._pgState.res_scale);
            node._pgState.res_base_w = resSnap(e.base_w); node._pgState.res_base_h = resSnap(e.base_h);
            setVal("res_base_w", node._pgState.res_base_w); setVal("res_base_h", node._pgState.res_base_h);
            resRecomputeFinal(); node._pgResSync?.();
        }, null, { wheelCycle: true });
        const refreshSavedSel = () => {
            const arr = resLoadSaved();
            const names = arr.length ? arr.map(resSavedName) : [RES_SAVE_EMPTY];
            const pick = (_resSavedPick && names.includes(_resSavedPick)) ? _resSavedPick : names[0];
            _resSavedPick = (pick === RES_SAVE_EMPTY) ? null : pick;   // keep the selected id in sync with what's SHOWN → the shown entry is immediately deletable (no stale/null id)
            resSavedSel.fill(names, pick);
        };
        const resSaveBtn = makeButton("💾 Save Preset", async () => {
            const e = { base_w: node._pgState.res_base_w, base_h: node._pgState.res_base_h, scale: node._pgState.res_scale || 1, divisor: node._pgState.res_divisor || 64, aspect: node._pgState.res_aspect || "Custom", ts: Date.now() };
            // Let the user name the preset; the auto description ("16:9 - 1920 x 1080") is the default.
            const res = await pmModal({
                title: "Save resolution preset",
                message: "Saves this resolution (W×H · scale · divisor · aspect) under a name you choose. The name appears in the preset dropdown.",
                input: { placeholder: "Preset name", value: resSavedDesc(e) }, confirmLabel: "Save",
            });
            if (res === null) return;
            const nm = String(res || "").trim();
            if (!nm) return;
            e.name = nm;
            const arr = resLoadSaved().filter((x) => resSavedName(x) !== nm);   // overwrite any preset with the same name
            arr.unshift(e); resWriteSaved(arr);
            _resSavedPick = nm; refreshSavedSel();
        }, { width: "auto", flex: "0 0 auto", padding: "6px 10px", fontSize: "11px" });
        const resDelBtn = makeButton("🗑", () => {
            if (!_resSavedPick) return;
            resWriteSaved(resLoadSaved().filter((x) => resSavedName(x) !== _resSavedPick));
            _resSavedPick = null; refreshSavedSel();
        }, { width: "auto", flex: "0 0 auto", padding: "6px 9px", fontSize: "12px", background: C.card });
        resDelBtn.title = "Delete the selected saved resolution";
        resSavedSel.el.style.flex = "1 1 auto"; resSavedSel.el.style.minWidth = "0";
        const resSaveRow = el("div", { display: "flex", alignItems: "center", gap: "6px", marginTop: "auto" });   // pin to the bottom → lines up with the Load/Unload row
        resSaveRow.append(resSaveBtn, resSavedSel.el, resDelBtn);   // appended to the shared bottom action bar below (not the column)
        refreshSavedSel();

        // Mirror the live W/H onto the node's width/height OUTPUT slots (like Resolution Master).
        const resSetOutLabels = () => {
            for (const o of (node.outputs || [])) {
                if (o.name === "width") o.label = "width  " + node._pgState.res_width;
                else if (o.name === "height") o.label = "height  " + node._pgState.res_height;
            }
            node.setDirtyCanvas?.(true, false);
        };
        const resSyncControls = () => {
            const bw = node._pgState.res_base_w, bh = node._pgState.res_base_h, s = node._pgState.res_scale || 1;
            // When Scale ≠ 100%, the Width/Height VALUES show the post-scale OUTPUT (res_width/height) and the
            // Width/Height/Scale values all turn faint red — so it's obvious scaling is altering the emitted size.
            const scaled = Math.abs(s - 1) > 1e-6;
            const col = scaled ? RES_SCALED_TX : "";
            wSlider.set(bw); wRow.setVal(scaled ? node._pgState.res_width : bw); wRow.setColor(col);
            hSlider.set(bh); hRow.setVal(scaled ? node._pgState.res_height : bh); hRow.setColor(col);
            scaleSlider.set(s * 100); sRow.setVal(s * 100); sRow.setColor(col);
            const mp = bw * bh / 1e6; mpSlider.set(mp); mpRow.setVal(mp);
            aspectSel.set(/^\d+:\d+$/.test(node._pgState.res_aspect || "") ? node._pgState.res_aspect : "Custom");
            divSel.set(String(node._pgState.res_divisor || 64));
        };

        resSplit.append(resLeftCol, resRightCol);
        resolutionPanel.appendChild(resSplit);
        // One shared bottom action bar: image buttons (left) + save controls (right) on a single
        // aligned row — instead of fighting two columns of different heights.
        resImgRow.style.flex = "0 0 auto"; resImgRow.style.marginTop = "0";
        resSaveRow.style.flex = "1 1 auto"; resSaveRow.style.marginTop = "0"; resSaveRow.style.minWidth = "260px";
        const resBottomBar = el("div", { display: "flex", alignItems: "center", gap: "12px", marginTop: "8px", flexWrap: "wrap" });
        resBottomBar.append(resImgRow, resSaveRow);
        resolutionPanel.appendChild(resBottomBar);
        genPanel.appendChild(resolutionPanel);

        node._pgResSync = () => { resRecomputeFinal(); resDraw(); resUpdateReadout(); resSyncControls(); resSetOutLabels(); node._pgUpdateResInfo?.(); };
        resRecomputeFinal(); resUpdateReadout(); resSyncControls(); resSetOutLabels();
        try { const _resRO = new ResizeObserver(() => resDraw()); _resRO.observe(resCanvasWrap); } catch {}

        // ---- Generator sub-view switcher ----
        node._pgApplyGenView = function () {
            const sv = node._pgState._genView;
            const v = (sv === "sysprompt" || sv === "resolution") ? sv : "prompt";
            promptPanel.style.display = v === "prompt" ? "flex" : "none";
            sysPromptPanel.style.display = v === "sysprompt" ? "flex" : "none";
            resolutionPanel.style.display = v === "resolution" ? "flex" : "none";
            if (v === "resolution") node._pgResReflowCanvas?.();
            node._pgResSync?.();   // keep sliders + output-slot labels current (incl. after reload)
            genTabs.setActive(v);
        };
    }

    // ================= OPTIONS PANEL =================
    {
        // ---- secondary sub-tab bar: LLM | LLM Settings ----
        const subBar = el("div", {
            display: "flex", width: "100%", boxSizing: "border-box",
            borderRadius: "7px", overflow: "hidden", minHeight: "30px",
            border: `1px solid ${C.border}`, marginBottom: "6px", background: C.input, boxShadow: SHADOW_SOFT,
        });
        const mkSubTab = (label, key) => {
            const t = el("div", {
                flex: "1 1 50%", textAlign: "center", padding: "6px 4px",
                boxSizing: "border-box", cursor: "pointer", userSelect: "none",
                fontSize: "12px", fontWeight: "700", fontFamily: FONT,
                lineHeight: "16px", minHeight: "16px",
                background: C.input, color: C.textMuted,
                transition: "background .15s, color .15s, box-shadow .15s, filter .15s",
            }, label);
            attachTabHover(t);
            t.addEventListener("mousedown", stop);
            t.addEventListener("pointerdown", stop);
            t.addEventListener("click", (e) => { stop(e); node._pgState._optView = key; setVal("_optView", key); node._pgApplyOptView(); });
            return t;
        };
        const stLLM = mkSubTab("LLM", "llm");
        const stSet = mkSubTab("LLM Settings", "settings");
        stSet.style.borderLeft = `1px solid ${C.border}`;
        tabOn(stLLM); // seed active inline
        subBar.append(stLLM, stSet);
        node._pgOptSubBar = subBar;   // kept for setActive() calls; no longer in the DOM
        // Sub-tab bar removed — sub-navigation now lives in the main Options button.
        // (No splitter under the main tabs — it was unnecessary clutter.)

        // ---- sub-panel: LLM (model, mmproj, context size, launch params) ----
        const llmPanel = el("div", { display: "flex", flexDirection: "column", gap: "6px" });

        // Backend toggle — the ULTIMATE decider of which backend runs. Stored per-node
        // in config (so it travels with the node and is enforced at run time) and also
        // mirrored into the global preference so the model dropdowns stay in sync.
        // Switching re-scans the model list.
        const applyBackend = (v) => {
            const old = node._pgState.backend;
            // Remember each backend's model/mmproj separately so swapping llama.cpp ⇄ Ollama
            // restores what you last used there (instead of carrying an Ollama model into
            // llama.cpp and vice-versa). Persisted in config via setVal below.
            if (v !== old) {
                const memo = (node._pgState._modelMemo && typeof node._pgState._modelMemo === "object") ? node._pgState._modelMemo : {};
                memo[old] = { model: node._pgState.model, mmproj: node._pgState.mmproj };
                node._pgState._modelMemo = memo;
                const prev = memo[v];
                if (prev) { node._pgState.model = prev.model || ""; node._pgState.mmproj = prev.mmproj || "auto"; }
            }
            setVal("backend", v);
            savePref("llm_backend", v);
            node._pgBackendSel?.set(v);       // keep the dropdown display in sync
            node._pgApplyBackendFields?.();   // swap llama path/port ⇄ Ollama URL
            node._pgRefreshModelLists?.({ fresh: true });
            node._pgRefreshStatus?.();
            node._pgRefreshOllamaVision?.();
        };
        const backendSel = makeSelect(["llama.cpp", "ollama"], applyBackend, (v) => v === "ollama" ? "Ollama" : "Llama.cpp", { wheelCycle: true });
        node._pgBackendSel = backendSel;
        const backendRow = labelRow("Backend", backendSel.el, { labelWidth: "110px" });
        // Clicking the "Backend" label swaps llama.cpp ⇄ ollama (quick toggle).
        if (backendRow._label) {
            backendRow._label.style.cursor = "pointer";
            backendRow._label.title = "Click to switch backend (llama.cpp ⇄ Ollama)";
            backendRow._label.addEventListener("mousedown", stop);
            backendRow._label.addEventListener("click", (e) => { stop(e); applyBackend(node._pgState.backend === "ollama" ? "llama.cpp" : "ollama"); });
        }
        const llmCard1 = node._pgMkGroupCard();   // group: Backend + status + Model + MMProj + Context Size
        llmPanel.appendChild(llmCard1);
        llmCard1.appendChild(backendRow);

        // Server status dot + Test / Unload.
        // Faint green when the backend is running, faint red when stopped/unavailable.
        const DOT_ON = "#5fae6a", DOT_OFF = "#ae5f5f";
        const statusDot = el("span", { width: "9px", height: "9px", borderRadius: "50%", background: DOT_OFF, flex: "0 0 auto" });
        const statusText = el("span", { fontSize: "11px", color: C.textMuted, flex: "1 1 auto", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, "status —");
        const smallBtn = (label, onClick) => {
            const b = el("div", { cursor: "pointer", userSelect: "none", fontSize: "11px", fontWeight: "600", color: C.text, border: `1px solid ${C.border}`, borderRadius: "6px", padding: "3px 8px", background: C.card, flex: "0 0 auto" }, label);
            b.addEventListener("mousedown", stop);
            b.addEventListener("click", (e) => { stop(e); onClick(b); });
            return b;
        };
        // Query string carrying THIS node's backend + Ollama URL so status/test reflect it.
        const backendQS = () => {
            const p = new URLSearchParams();
            if (node._pgState.backend) p.set("backend", node._pgState.backend);
            if (node._pgState.backend === "ollama") { if (node._pgState.ollama_url) p.set("ollama_url", node._pgState.ollama_url); }
            else if (node._pgState.llama_path) p.set("llama_path", node._pgState.llama_path);   // verify THIS node's path
            const s = p.toString();
            return s ? "?" + s : "";
        };
        // llama.cpp: Test verifies the llama-server executable can be located (path check).
        const testBtn = smallBtn("Test", async (b) => {
            const o = b.textContent; b.textContent = "…";
            try { const r = await fetch("/prompt-generator/test-backend" + backendQS()).then(x => x.json()); statusText.textContent = (r?.ok ? "✓ " : "✗ ") + (r?.message || ""); }
            catch { statusText.textContent = "✗ test failed"; }
            b.textContent = o; node._pgRefreshStatus?.();
        });
        // Ollama: Serve launches `ollama serve`; Kill terminates the Ollama process.
        const serveBtn = smallBtn("Serve", async (b) => {
            const o = b.textContent; b.textContent = "…"; statusText.textContent = "starting ollama…";
            try { const r = await fetch("/prompt-generator/ollama-serve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ollama_url: node._pgState.ollama_url }) }).then(x => x.json());
                  if (!r?.ok && r?.message) statusText.textContent = "✗ " + r.message; }
            catch { statusText.textContent = "✗ serve failed"; }
            b.textContent = o; await node._pgRefreshStatus?.(); node._pgRefreshModelLists?.({ fresh: true });
        });
        const killBtn = smallBtn("Kill", async (b) => {
            const o = b.textContent; b.textContent = "…";
            try { const r = await fetch("/prompt-generator/ollama-kill", { method: "POST" }).then(x => x.json()); if (r?.message) statusText.textContent = r.message; }
            catch { statusText.textContent = "✗ kill failed"; }
            b.textContent = o; await node._pgRefreshStatus?.(); node._pgRefreshModelLists?.({ fresh: true });
        });
        const unloadBtn = smallBtn("Unload", async (b) => {
            const o = b.textContent; b.textContent = "…";
            try { await fetch("/prompt-generator/unload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: node._pgState.model, backend: node._pgState.backend, ollama_url: node._pgState.ollama_url }) }); }
            catch {}
            b.textContent = o; node._pgRefreshStatus?.();
        });
        const statusRow = el("div", { display: "flex", alignItems: "center", gap: "6px", padding: "2px 0" });
        statusRow.append(statusDot, statusText, testBtn, serveBtn, killBtn, unloadBtn);
        llmCard1.appendChild(statusRow);
        // Click the dot/label for a SINGLE on-demand status check (no background polling).
        const _beName0 = node._pgState.backend === "ollama" ? "Ollama" : "Llama";
        statusDot.title = statusText.title = `Click to check status of ${_beName0}`;
        for (const elx of [statusDot, statusText]) {
            elx.style.cursor = "pointer";
            elx.addEventListener("mousedown", stop);
            elx.addEventListener("click", (e) => { stop(e); node._pgRefreshStatus?.(); });
        }

        // ── LLM Presets (bundles) — the FIRST row of Options ▸ LLM Settings. Saves/loads ALL the
        // LLM + sampling + backend settings (both Options sub-views) as a named preset; the system
        // prompt / prompt text are intentionally NOT included. localStorage, like the Res presets.
        let _llmPresetCur = "";
        const applyLlmPreset = (name) => {
            _llmPresetCur = name;
            const p = loadLlmPresets().find((x) => x.name === name);
            if (!p || !p.settings) return;
            for (const k of LLM_PRESET_KEYS) if (k in p.settings) node._pgState[k] = p.settings[k];
            for (const k of LLM_PRESET_KEYS) node._pgControls[k]?.set?.(node._pgState[k]);
            node._pgBackendSel?.set?.(node._pgState.backend);
            savePref("llm_backend", node._pgState.backend);
            node._pgWriteConfig(true);
            node._pgApplyBackendFields?.(); node._pgApplyBackendModelFields?.(); node._pgApplyBackendStatusBtns?.();
            node._pgRefreshModelLists?.({ fresh: true });   // repopulates + re-selects model/mmproj from the loaded state
            node._pgRefreshStatus?.(); node._pgRefreshOllamaVision?.();
        };
        const llmPresetSel = makeSelect([], applyLlmPreset, null, { searchable: true, wheelCycle: true, searchPlaceholder: "LLM preset…" });
        llmPresetSel.el.style.flex = "1 1 auto"; llmPresetSel.el.style.minWidth = "0";
        node._pgRefreshLlmPresets = (sel) => {
            const names = loadLlmPresets().map((p) => p.name);
            const cur = (sel != null) ? sel : (names.includes(_llmPresetCur) ? _llmPresetCur : "");
            _llmPresetCur = cur;
            llmPresetSel.fill(names, cur || null);
        };
        const llmPresetSave = smallBtn("+", async () => {
            const r = await pmModal({ title: "Save LLM preset", message: "Name this bundle of LLM + sampling + backend settings.\n(The system prompt / prompt text are NOT saved or loaded.)", input: { placeholder: "Preset name", value: _llmPresetCur || "" }, confirmLabel: "Save" });
            const name = String(r || "").trim(); if (!name) return;
            const settings = {}; for (const k of LLM_PRESET_KEYS) settings[k] = node._pgState[k];
            const arr = loadLlmPresets().filter((x) => x.name !== name);   // same-name save overwrites
            arr.push({ name, ts: Date.now(), settings });
            arr.sort((a, b) => a.name.localeCompare(b.name));
            saveLlmPresets(arr); node._pgRefreshLlmPresets(name);
        });
        llmPresetSave.title = "Save the current LLM settings as a preset";
        const llmPresetDel = smallBtn("🗑", async () => {
            const name = _llmPresetCur; if (!name) return;
            const r = await pmModal({ title: "Delete LLM preset?", message: `Delete "${name}"? This can't be undone.`, confirmLabel: "Delete", danger: true });
            if (!r) return;
            saveLlmPresets(loadLlmPresets().filter((x) => x.name !== name));
            node._pgRefreshLlmPresets("");
        });
        llmPresetDel.title = "Delete the selected LLM preset";
        const llmPresetCluster = el("div", { display: "flex", alignItems: "center", gap: "6px", flex: "1 1 auto", minWidth: "0" });
        llmPresetCluster.append(llmPresetSel.el, llmPresetSave, llmPresetDel);
        llmPanel.insertBefore(labelRow("LLM Presets", llmPresetCluster, { labelWidth: "110px" }), llmCard1);   // first row, above the group cards
        node._pgRefreshLlmPresets();

        // Show Test for llama.cpp; Serve/Kill for Ollama.
        node._pgApplyBackendStatusBtns = () => {
            const oll = node._pgState.backend === "ollama";
            testBtn.style.display = oll ? "none" : "";
            serveBtn.style.display = oll ? "" : "none";
            killBtn.style.display = oll ? "" : "none";
            const beName = oll ? "Ollama" : "Llama";
            statusDot.title = statusText.title = `Click to check status of ${beName}`;
        };

        node._pgRefreshStatus = async () => {
            const prevRunning = node._pgServerRunning;
            // ALWAYS name the backend from THIS node's state — never the route's response,
            // which can fall back to the shared global and report the wrong backend.
            const beName = node._pgState.backend === "ollama" ? "Ollama" : "Llama";
            // Bypassed → the LLM never runs, so don't poll the backend at all (it would needlessly
            // probe a possibly-dead server). Show a neutral state and skip the network call.
            if (node._pgState._bypass) {
                node._pgServerRunning = false; node._pgServerFound = false;
                statusDot.style.background = "#777"; statusText.textContent = "Bypassed — LLM skipped";
                node._pgUpdateChecklist?.();
                return;
            }
            try {
                const r = await fetch("/prompt-generator/server-status" + backendQS()).then(x => x.json());
                node._pgServerRunning = !!r?.running;
                node._pgServerFound = r?.found !== false;
                if (node._pgServerRunning) { statusDot.style.background = DOT_ON; statusText.textContent = `${beName} is running`; }
                else if (node._pgServerFound) { statusDot.style.background = DOT_OFF; statusText.textContent = `${beName} is not running`; }
                else { statusDot.style.background = "#777"; statusText.textContent = `${beName} not found`; }   // grey: can't locate the backend
            } catch { node._pgServerRunning = false; node._pgServerFound = false; statusDot.style.background = "#777"; statusText.textContent = "status unavailable"; }
            // Server running-state changed → refresh the model list (kill clears the list,
            // serve repopulates it) so the dropdown never shows a stale/dead set of models.
            // Only Ollama's model list depends on whether the server is up; llama.cpp models are
            // local files (valid regardless), so never trigger a disk-scanning refresh on a llama flip.
            if (node._pgState.backend === "ollama" && prevRunning !== undefined && prevRunning !== node._pgServerRunning) node._pgRefreshModelLists?.({ fresh: true });
            node._pgUpdateChecklist?.();
            node._pgRefreshSkull?.();          // 💀 ⇄ 🦙 depends on running state in Ollama mode
            node._pgRefreshOllamaVision?.();   // reset vision to unknown when Ollama goes down
        };

        // Whether the selected Ollama model has vision baked in (null = unknown / not Ollama).
        // Detected from Ollama's /api/show capabilities — independent of how it's named.
        node._pgOllamaVision = null;
        let _visionFetchKey = "";
        node._pgRefreshOllamaVision = async () => {
            if (node._pgState.backend !== "ollama") { node._pgOllamaVision = null; _visionFetchKey = ""; return; }
            const model = String(node._pgState.model || "");
            // Can't determine vision when Ollama is down (killed) or no real model is
            // selected (a placeholder entry) → unknown (grey).
            if (!model || /^No /.test(model) || /not running/i.test(model) || node._pgServerRunning === false) {
                node._pgOllamaVision = null; _visionFetchKey = ""; node._pgUpdateChecklist?.(); return;
            }
            const key = (node._pgState.ollama_url || "") + "|" + model;
            if (key === _visionFetchKey) return;   // already current
            _visionFetchKey = key;
            // Show "checking…" (◌) immediately for the newly selected model, then resolve.
            node._pgOllamaVision = null; node._pgUpdateChecklist?.();
            try {
                const p = new URLSearchParams({ model });
                if (node._pgState.ollama_url) p.set("ollama_url", node._pgState.ollama_url);
                const r = await fetch("/prompt-generator/ollama-model-info?" + p.toString()).then(x => x.json());
                if (key === _visionFetchKey) { node._pgOllamaVision = !!r?.vision; node._pgUpdateChecklist?.(); node._pgUpdateVisionWarn?.(); }
            } catch { /* leave as-is */ }
        };

        // Placeholders ("Ollama not running …" / "No models …") are shown greyed, and any
        // surrounding parens are stripped (handles the pre-restart route output too).
        const _isModelPlaceholder = (v) => /not running|^No /i.test(String(v || ""));
        const model = reg("model", makeSelect([],
            (v) => { setVal("model", v); node._pgUpdateVisionWarn?.(); node._pgRefreshOllamaVision?.(); },
            (v) => fileFirstLabel(v, node._pgState.model_dir).replace(/^\((.*)\)$/, "$1"),
            { dimOf: _isModelPlaceholder, wheelCycle: true }));
        llmCard1.appendChild(labelRow("Model", model.el, { labelWidth: "110px" }));
        const mmproj = reg("mmproj", makeSelect(["None", "auto"], (v) => { setVal("mmproj", v); node._pgUpdateVisionWarn?.(); }, (v) => fileFirstLabel(v, node._pgState.mmproj_dir), { wheelCycle: true }));
        // MMProj is a llama.cpp-only concept (separate vision file). Ollama bundles vision
        // into the model, so this row is hidden in Ollama mode (see _pgApplyBackendFields).
        const mmprojRow = labelRow("MMProj", mmproj.el, { labelWidth: "110px" });
        llmCard1.appendChild(mmprojRow);

        // ---- Ollama: Pull (download) a model locally ----
        const pullInput = makeText(false, "Model to pull, e.g.  llama3.2  ·  qwen2.5vl:7b", () => {});
        const pullBtn = makeButton("⬇ Pull", () => doPull(), { width: "auto", padding: "8px 16px" });
        pullBtn.style.flex = "0 0 auto";
        const pullRow = el("div", { display: "flex", gap: "6px", alignItems: "stretch" });
        pullRow.append(pullInput.el, pullBtn);
        const pullStatus = el("div", { display: "none", alignItems: "center", gap: "8px", fontSize: "12px", padding: "7px 10px", borderRadius: "6px", background: "var(--pg-box, hsl(220 10% 13%))", color: C.text });
        const pullSection = el("div", { display: "none", flexDirection: "column", gap: "6px" });
        pullSection.append(sectionTitle("Pull Model"), pullRow, pullStatus);
        llmCard1.appendChild(pullSection);
        node._pgPullSection = pullSection;

        let pullSpin = null, pullCountdown = null;
        const stopPullTimers = () => { if (pullSpin) { clearInterval(pullSpin); pullSpin = null; } if (pullCountdown) { clearInterval(pullCountdown); pullCountdown = null; } };
        const doPull = async () => {
            const model = String(pullInput.el.value || "").trim();
            if (!model) { pullInput.el.focus(); return; }
            stopPullTimers();
            pullStatus.onclick = null; pullStatus.style.cursor = ""; pullStatus.title = "";
            pullStatus.style.display = "flex"; pullStatus.innerHTML = "";
            const SPN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
            let si = 0;
            const ic = el("span", { color: C.accent, fontFamily: "monospace", fontSize: "14px" }, SPN[0]);
            const tx = el("span", {}, `Pulling ${model}…`);
            pullStatus.append(ic, tx);
            pullSpin = setInterval(() => { si = (si + 1) % SPN.length; ic.textContent = SPN[si]; }, 90);
            pullBtn.disabled = true; pullBtn.style.opacity = "0.5"; pullBtn.style.pointerEvents = "none";
            node._pgReflow?.();
            let res;
            try {
                res = await fetch("/prompt-generator/ollama-pull", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model, ollama_url: node._pgState.ollama_url }),
                }).then((x) => x.json());
            } catch (e) { res = { ok: false, message: String(e) }; }
            stopPullTimers();
            pullBtn.disabled = false; pullBtn.style.opacity = "1"; pullBtn.style.pointerEvents = "";
            pullStatus.innerHTML = "";
            const dismiss = () => { stopPullTimers(); pullStatus.style.display = "none"; pullStatus.onclick = null; pullStatus.style.cursor = ""; pullStatus.title = ""; node._pgReflow?.(); };
            if (res?.ok) {
                node._pgRefreshModelLists?.({ fresh: true });   // the new model is now selectable
                const ok = el("span", { color: "#5fae6a", fontWeight: "700", fontSize: "14px" }, "✓");
                let secs = 10;
                const t = el("span", {}, `Success — ${model} pulled.  (hiding in ${secs}s)`);
                pullStatus.append(ok, t);
                pullStatus.style.cursor = "pointer"; pullStatus.title = "Click to dismiss now"; pullStatus.onclick = dismiss;
                pullCountdown = setInterval(() => {
                    secs--;
                    if (secs <= 0) dismiss();
                    else t.textContent = `Success — ${model} pulled.  (hiding in ${secs}s)`;
                }, 1000);
            } else {
                const x = el("span", { color: "#e06464", fontWeight: "700", fontSize: "14px" }, "✗");
                const t = el("span", {}, `Pulling model failed${res?.message ? " — " + res.message : "."}`);
                pullStatus.append(x, t);
                pullStatus.style.cursor = "pointer"; pullStatus.title = "Click to dismiss"; pullStatus.onclick = dismiss;
            }
            node._pgReflow?.();
        };
        // Context size lives here AND is mirrored in LLM Settings (ctxB, appended later).
        // Both bind to the same config value — editing either updates the other.
        let ctxA, ctxB;
        ctxA = makeNumber(512, 32768, 512, true, (v) => { setVal("context_size", v); ctxB?.set(v); });
        ctxB = makeNumber(512, 32768, 512, true, (v) => { setVal("context_size", v); ctxA?.set(v); });
        reg("context_size", {
            el: ctxA.el,
            set: (v) => { ctxA.set(v); ctxB.set(v); },
            setDisabled: (d) => { ctxA.setDisabled?.(d); ctxB.setDisabled?.(d); },
        });
        llmCard1.appendChild(labelRow("Context Size", ctxA.el, { labelWidth: "110px" }));

        // ── Connection / launch params — the rows shown adapt to the chosen backend ──
        const connTitle = sectionTitle("Launch Parameters");
        const llmCard2 = node._pgMkGroupCard();   // group: Launch Parameters (path/port/args) / Ollama connection
        llmPanel.appendChild(llmCard2);
        llmCard2.appendChild(connTitle);
        const llamaPath = reg("llama_path", makeText(false, "I:\\llama.cpp\\llama-server.exe (blank = global / PATH)", (v) => setVal("llama_path", v)));
        const llamaPathRow = labelRow("Llama-Server Path", llamaPath.el, { labelWidth: "110px" });
        llmCard2.appendChild(llamaPathRow);
        const llamaPort = reg("llama_port", makeText(false, "8080 (default)", (v) => setVal("llama_port", v)));
        const llamaPortRow = labelRow("Server Port", llamaPort.el, { labelWidth: "110px" });
        llmCard2.appendChild(llamaPortRow);
        const args = reg("extra_launch_args", makeText(false, "--mlock --no-mmap --threads 16 ...", (v) => setVal("extra_launch_args", v)));
        const argsRow = labelRow("Extra Args", args.el, { labelWidth: "110px" });
        llmCard2.appendChild(argsRow);
        // Ollama path (ip + port). Per-node; blank = the global ComfyUI "Ollama URL" setting.
        let ollUrlTimer = null;
        const ollamaUrl = reg("ollama_url", makeText(false, "http://127.0.0.1:11434 (blank = global setting)", (v) => {
            setVal("ollama_url", v);
            if (node._pgState.backend === "ollama") {
                if (ollUrlTimer) clearTimeout(ollUrlTimer);
                ollUrlTimer = setTimeout(() => { node._pgRefreshModelLists?.({ fresh: true }); node._pgRefreshStatus?.(); node._pgRefreshOllamaVision?.(); }, 600);
            }
        }));
        const ollamaUrlRow = labelRow("Ollama URL", ollamaUrl.el, { labelWidth: "110px" });
        llmCard2.appendChild(ollamaUrlRow);

        // Show llama.cpp launch fields for llama.cpp, the Ollama URL field for Ollama.
        node._pgApplyBackendFields = () => {
            const oll = node._pgState.backend === "ollama";
            // Restore to "flex" (the labelRow default) when showing — NOT "" (which falls
            // back to display:block and stacks the label above the control).
            llamaPathRow.style.display = oll ? "none" : "flex";
            llamaPortRow.style.display = oll ? "none" : "flex";
            argsRow.style.display = oll ? "none" : "flex";
            ollamaUrlRow.style.display = oll ? "flex" : "none";
            if (connTitle.firstChild) connTitle.firstChild.textContent = oll ? "Connection" : "Launch Parameters";
            node._pgApplyBackendModelFields?.();   // hide mmproj + Model Directory in Ollama mode
            node._pgApplyBackendStatusBtns?.();     // Test ⇄ Serve/Kill
            node._pgApplyBackendExec?.();           // hide llama-only execution toggles
            node._pgUpdateChecklist?.();            // drop the MMPROJ chip in Ollama mode
            node._pgRefreshSkull?.();               // skull ⇄ serve/kill glyph
        };

        // ---- Model Directory: override the scan roots for the dropdowns above ----
        // These are llama.cpp folder-scan roots; Ollama lists models from its own server,
        // so the whole section (and the MMProj dir) is hidden in Ollama mode.
        const modelDirTitle = sectionTitle("Model Directory");
        const llmCard3 = node._pgMkGroupCard();   // group: Model Directory (llama scan roots)
        llmPanel.appendChild(llmCard3);
        llmCard3.appendChild(modelDirTitle);
        let dirRefreshTimer = null;
        const scheduleDirRefresh = () => {
            if (dirRefreshTimer) clearTimeout(dirRefreshTimer);
            dirRefreshTimer = setTimeout(() => node._pgRefreshModelLists?.({ fresh: true }), 500);
        };
        const makeDirRow = (label, key, placeholder) => {
            const inp = reg(key, makeText(false, placeholder, (v) => { setVal(key, v); scheduleDirRefresh(); }));
            return labelRow(label, inp.el, { labelWidth: "110px" });
        };
        const modelDirRow = makeDirRow("Model", "model_dir", "Full path of folder to scan for models (blank = default)");
        const mmprojDirRow = makeDirRow("MMProj", "mmproj_dir", "Full path of folder to scan for mmproj (blank = default)");
        llmCard3.appendChild(modelDirRow);
        llmCard3.appendChild(mmprojDirRow);
        // Hide the mmproj dropdown + the llama-only Model Directory section in Ollama mode.
        node._pgApplyBackendModelFields = () => {
            const oll = node._pgState.backend === "ollama";
            mmprojRow.style.display = oll ? "none" : "flex";   // "flex" (labelRow default), not "" → no stacking
            modelDirTitle.style.display = oll ? "none" : "flex";
            modelDirRow.style.display = oll ? "none" : "flex";
            mmprojDirRow.style.display = oll ? "none" : "flex";
            llmCard3.style.display = oll ? "none" : "flex";   // hide the whole Model Directory card in Ollama mode (no empty box)
            if (node._pgPullSection) node._pgPullSection.style.display = oll ? "flex" : "none";   // Pull = Ollama only
        };
        optPanel.appendChild(llmPanel);

        // ---- sub-panel: LLM Settings (sampling) ----
        // Sliders are always active and always used; "Reset to defaults" restores the
        // node's built-in template values.
        const settingsPanel = el("div", { display: "flex", flexDirection: "column", gap: "6px" });
        const samplingCard = node._pgMkGroupCard();   // group: Sampling params + reset
        settingsPanel.appendChild(samplingCard);
        samplingCard.appendChild(sectionTitle("Sampling"));

        const numRows = [];
        const addNum = (key, label, min, max, step, isInt) => {
            const n = reg(key, makeNumber(min, max, step, isInt, (v) => setVal(key, v)));
            samplingCard.appendChild(labelRow(label, n.el, { labelWidth: "130px" }));
            numRows.push({ key, ctrl: n });
        };
        addNum("temperature", "Temperature", 0, 2, 0.01, false);
        addNum("top_k", "Top K", 0, 100, 1, true);
        addNum("top_p", "Top P", 0, 1, 0.01, false);
        addNum("min_p", "Min P", 0, 1, 0.01, false);
        addNum("repeat_penalty", "Repeat Penalty", 1, 2, 0.01, false);
        addNum("presence_penalty", "Presence Penalty", -2, 2, 0.01, false);

        // Reset the six sampling values to the node's built-in defaults.
        const resetSampling = makeButton("↺ Reset sampling to defaults", () => {
            for (const k of ["temperature", "top_k", "top_p", "min_p", "repeat_penalty", "presence_penalty"]) {
                node._pgState[k] = DEFAULTS[k];
                node._pgControls[k]?.set?.(DEFAULTS[k]);
            }
            node._pgWriteConfig(true);
        }, { marginTop: "4px" });
        samplingCard.appendChild(resetSampling);

        // Generation settings.
        const generationCard = node._pgMkGroupCard();   // group: Generation (context size + timeout)
        settingsPanel.appendChild(generationCard);
        generationCard.appendChild(sectionTitle("Generation"));
        // Mirror of Options > LLM > Context Size (shares the same value; edit either).
        generationCard.appendChild(labelRow("Context Size", ctxB.el, { labelWidth: "130px" }));
        const timeoutCtrl = reg("request_timeout", makeNumber(5, 3600, 5, true, (v) => setVal("request_timeout", v)));
        const timeoutRow = labelRow("Timeout (s)", timeoutCtrl.el, { labelWidth: "130px" });
        timeoutRow.title = "Max seconds to wait for a generation response before erroring (both backends).";
        generationCard.appendChild(timeoutRow);

        optPanel.appendChild(settingsPanel);

        // ---- sub-view switcher ----
        node._pgApplyOptView = function () {
            const v = node._pgState._optView === "settings" ? "settings" : "llm";
            llmPanel.style.display = v === "llm" ? "flex" : "none";
            settingsPanel.style.display = v === "settings" ? "flex" : "none";
            const setSub = (t, on) => (on ? tabOn : tabOff)(t);
            setSub(stLLM, v === "llm");
            setSub(stSet, v === "settings");
            if (v === "llm") node._pgRefreshStatus?.();   // on-demand check when the LLM panel opens (no background poll)
        };
    }

    // ================= PROMPTS PANEL (Recent / Library) =================
    // A full prompt-library system living in its own top-level tab. "Recent" is the
    // auto-captured rolling history (localStorage); "Library" is the curated, server-side
    // store (prompts/library.json) organized into searchable categories. Both share one
    // card grid (Text ⇄ Gallery view) and a preview header. Built entirely from the node's
    // existing primitives (C palette, GRAD_BTN, baseInputStyle, makeSelect, pmModal, viewUrl).
    {
        // Hard cap of 2 rows at ANY width, so the node never gets tall. Page size = the EXACT
        // column count × 2. We read the resolved auto-fill tracks (precise) rather than estimate
        // from width, so cols×2 never spills into a 3rd row.
        const LIB_MAX_ROWS = 3;
        const ALBUM_MAX_ROWS = 6;   // Album layout: grid is beside the preview, so it can run taller
        const libColumns = (minCard) => {
            // Resolved track count is exact; fall back to a width estimate only when the grid
            // isn't laid out yet (panel hidden → getComputedStyle returns "none").
            try { const t = getComputedStyle(grid).gridTemplateColumns; if (t && t !== "none") { const n = t.split(" ").filter(Boolean).length; if (n) return n; } } catch {}
            const gw = grid.clientWidth || (((node.size && node.size[0]) || 400) - 28);
            return Math.max(1, Math.floor((gw + 6) / (minCard + 6)));
        };
        // Prefer the stored exact location object; fall back to parsing the annotated string.
        const libImageMeta = (e) => (e && e.image_meta) || metaFromAnnotated(e?.image_ref || "");
        const srcLabel = (s) => (s && s.name) ? ((s.vision ? "👁 " : "") + s.name) : "";
        // The label an entry "displays as": its custom name, else the system-prompt (source) name,
        // else the first line of the prompt text. Used as the card/preview title (option A).
        const entryTitle = (e) => (e && (e.name || "").trim()) || srcLabel(e && e.source) || ((e && e.text || "").split("\n")[0]) || "";

        // The Mode/Preset that the CURRENT node settings represent (captured on save/run).
        node._pgCurrentSource = () => {
            if (node._pgState._modeView === "presets") {
                const name = node._pgState.override_system_prompt;
                const clean = (name === NONE_PRESET || name === PRESET_MODE || name === NO_SYS_PROMPT) ? "" : name;
                return { type: "preset", name: clean, vision: !!node._pgActivePresetVision?.() };
            }
            const m = node._pgState.mode;
            return { type: "mode", name: m, vision: IMAGE_MODES.has(m) };
        };

        // ---- small shared controls (match the node's pill/button styling) ----
        const lpill = pillBtn;   // shared module-level pill button (single definition)

        // ===== Condensed browse bar: scope picker (History / All / categories) + search + items =====
        const SCOPE_HISTORY = "📋 History";
        const SCOPE_ALL = "🌐 All";
        // Scope options: History on top, then All, then ⭐ Favorites, then each saved category.
        const scopeOptions = () => [SCOPE_HISTORY, SCOPE_ALL, LIB_FAVORITES, ...((_libraryCache?.categories) || [LIB_DEFAULT_CATEGORY])];
        // The scope the underlying state currently represents.
        const currentScope = () => {
            if (node._pgState._libView === "recent") return SCOPE_HISTORY;
            if (node._pgState._libScope === "all") return SCOPE_ALL;
            return node._pgState._libCategory || LIB_DEFAULT_CATEGORY;
        };
        // Apply a chosen scope → the existing _libView/_libScope/_libCategory state, then re-render.
        const setScope = (v) => {
            if (v === SCOPE_HISTORY) { node._pgState._libView = "recent"; setVal("_libView", "recent"); }
            else {
                node._pgState._libView = "library"; setVal("_libView", "library");
                if (v === SCOPE_ALL) { node._pgState._libScope = "all"; setVal("_libScope", "all"); }
                else { node._pgState._libScope = "category"; setVal("_libScope", "category"); node._pgState._libCategory = v; setVal("_libCategory", v); }
            }
            node._pgState._libPage = 0;
            node._pgUpdateCatMgmt?.(); node._pgLibRender();
            node._pgTabSubUpdaters?.forEach((fn) => { try { fn(); } catch {} });   // refresh the Prompts tab caption (current scope)
        };
        // Drive the Prompts main-tab arrows / scroll + caption from this scope list (late-bound:
        // the tab is built before this panel). Stepping wraps around the full scope list.
        node._pgScopeStep = (dir) => {
            const opts = scopeOptions();
            let i = opts.indexOf(currentScope());
            if (i < 0) i = 0;
            setScope(opts[(i + dir + opts.length) % opts.length]);
            node._pgSyncScopeSel?.();
        };
        node._pgScopeLabel = () => currentScope().replace(/^[^\w\s]+\s+/u, "");   // strip a leading emoji for the tiny caption

        const scopeSel = makeSelect(scopeOptions(), setScope, null, { searchable: true });
        scopeSel.el.style.flex = "0 0 auto"; scopeSel.el.style.minWidth = "118px"; scopeSel.el.style.maxWidth = "150px";
        node._pgSyncScopeSel = () => scopeSel.fill(scopeOptions(), currentScope());
        // Scroll over the scope picker to cycle scopes (History → All → ⭐ → categories) without
        // clicking — same step logic as the Prompts tab arrows. Short cooldown tames trackpad bursts.
        let _scopeWheelT = 0;
        scopeSel.el.addEventListener("wheel", (e) => {
            e.preventDefault(); e.stopPropagation();
            const now = performance.now();
            if (now - _scopeWheelT < 220) return;
            _scopeWheelT = now;
            node._pgScopeStep?.(e.deltaY > 0 ? +1 : -1);
        }, { passive: false });

        const CARD_VIEWS = ["text", "gallery", "image"];   // cycle order: Text → Gallery → Image
        const cardViewBtn = lpill("", "Card view — cycle: Text → Gallery → Image", () => {
            const i = CARD_VIEWS.indexOf(node._pgState._libCardView);
            node._pgState._libCardView = CARD_VIEWS[(i + 1) % CARD_VIEWS.length];
            setVal("_libCardView", node._pgState._libCardView);
            syncCardViewBtn(); node._pgLibRender(); node._pgReflow();
        });
        const syncCardViewBtn = () => {
            const v = node._pgState._libCardView;
            cardViewBtn.textContent = v === "gallery" ? "▦ Gallery" : v === "image" ? "🖼 Image" : "≣ Text";
        };
        syncCardViewBtn();
        // Album Mode: flips the panel to preview-LEFT / grid-RIGHT so the grid gets full height and
        // many more prompts show per screen. Applies to every Prompts scope; choice is persisted.
        const albumBtn = lpill("⬍ Vertical", "Layout — ⬍ Vertical (preview above grid) ⇄ ⬌ Horizontal (preview left, grid right). Click to switch.", () => {
            node._pgState._libAlbum = !node._pgState._libAlbum;
            setVal("_libAlbum", node._pgState._libAlbum);
            node._pgApplyAlbum?.();
        });
        const syncAlbumBtn = () => { albumBtn.textContent = node._pgState._libAlbum ? "⬌ Horizontal" : "⬍ Vertical"; };
        syncAlbumBtn();
        const sortSel = makeSelect(["new", "old", "az", "uses"], (v) => { setVal("_libSort", v); node._pgState._libPage = 0; node._pgLibRender(); },
            (v) => ({ new: "Newest", old: "Oldest", az: "A–Z", uses: "Most used" }[v] || v), { wheelCycle: true });
        sortSel.el.style.flex = "0 0 auto"; sortSel.el.style.minWidth = "96px";

        // Search field with a ▾ "browse items" dropdown built into the right edge (one field).
        const searchWrap = el("div", { ...baseInputStyle, display: "flex", alignItems: "center", padding: "0", flex: "1 1 150px", minWidth: "120px", overflow: "hidden" });
        const searchInput = el("input", { background: "transparent", border: "none", color: C.text, fontSize: "12px", fontFamily: FONT, outline: "none", flex: "1 1 auto", minWidth: "0", padding: "9px 4px 9px 10px" });
        searchInput.type = "text"; searchInput.placeholder = "🔍 Search…";
        searchInput.addEventListener("mousedown", stop);
        searchInput.addEventListener("keydown", stop);
        searchInput.addEventListener("input", (e) => { stop(e); node._pgState._libSearch = e.target.value; setVal("_libSearch", e.target.value); node._pgState._libPage = 0; node._pgLibRender(); });
        const itemsBtn = el("div", { flex: "0 0 auto", alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", width: "28px", cursor: "pointer", color: C.textMuted, borderLeft: `1px solid ${C.border}`, fontSize: "12px" }, "▾");
        itemsBtn.title = "Browse items in this scope (type to filter)";
        itemsBtn.addEventListener("mousedown", stop);
        searchWrap.append(searchInput, itemsBtn);

        // Floating "items" menu — the prompts in the CURRENT scope, filterable, hover-previews live.
        let itemsMenu = null;
        const onItemsDown = (e) => { if (itemsMenu && !itemsMenu.contains(e.target) && !searchWrap.contains(e.target)) closeItemsMenu(); };
        const closeItemsMenu = () => { if (itemsMenu) { itemsMenu.remove(); itemsMenu = null; document.removeEventListener("mousedown", onItemsDown, true); } };
        const openItemsMenu = () => {
            if (itemsMenu) { closeItemsMenu(); return; }
            const r = searchWrap.getBoundingClientRect();
            itemsMenu = el("div", { position: "fixed", zIndex: "99999", left: r.left + "px", top: (r.bottom + 3) + "px", width: r.width + "px", maxHeight: "320px", boxSizing: "border-box", display: "flex", flexDirection: "column", background: C.input, border: `1px solid ${C.accentBorder}`, borderRadius: "6px", fontFamily: FONT, fontSize: "12px", color: C.text, padding: "3px" });
            itemsMenu.addEventListener("mousedown", stop);
            itemsMenu.addEventListener("wheel", (e) => e.stopPropagation());
            const listEl = el("div", { flex: "1 1 auto", overflowY: "auto", minHeight: "0" });
            const filterInp = el("input", { ...baseInputStyle, flex: "0 0 auto", margin: "1px 1px 4px", padding: "6px 8px" });
            filterInp.type = "text"; filterInp.placeholder = "Filter " + currentScope() + "…";
            filterInp.addEventListener("mousedown", stop); filterInp.addEventListener("click", stop);
            filterInp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeItemsMenu(); });
            filterInp.addEventListener("input", () => renderItemRows(filterInp.value));
            // Label rows as "CustomName | prompt text" (the name is dropped when the entry has none).
            // Used for both the displayed row and the filter match below.
            const itemLabel = (e) => {
                const nm = (e && e.name || "").trim();
                const txt = (e && e.text || "").trim();
                return nm ? `${nm}  |  ${txt}` : txt;
            };
            const renderItemRows = (filter) => {
                listEl.innerHTML = "";
                const f = String(filter || "").trim().toLowerCase();
                const items = libActiveList(false);   // current scope's items, ignoring the main search box
                const shown = !f ? items : items.filter((e) => itemLabel(e).toLowerCase().includes(f) || (e.text || "").toLowerCase().includes(f));
                if (!shown.length) { listEl.appendChild(el("div", { padding: "6px 9px", color: C.textMuted }, "No items")); return; }
                shown.forEach((e, i) => {
                    const baseBg = i % 2 ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.22)";
                    const row = el("div", { padding: "5px 9px", borderRadius: "4px", cursor: "pointer", color: C.text, background: baseBg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", transition: "background .1s" });
                    // Bold custom name (if any) | muted prompt text, on one ellipsised line.
                    const _nm = (e.name || "").trim();
                    if (_nm) row.append(el("span", { fontWeight: "700" }, _nm), el("span", { color: C.textMuted }, "  |  "));
                    row.append(el("span", { color: _nm ? C.textMuted : C.text }, (e.text || "").trim()));
                    row.title = e.text || "";
                    // Hover previews the entry live (text / image / preset) without committing.
                    row.addEventListener("mouseenter", () => { row.style.background = DD_HOV_BG; node._pgLibSelected = e; node._pgLibRenderPreview(); node._pgUpdateCardSelection?.(); });
                    row.addEventListener("mouseleave", () => { row.style.background = baseBg; });
                    row.addEventListener("click", (ev) => { stop(ev); closeItemsMenu(); node._pgLibSelect(e); });
                    listEl.appendChild(row);
                });
            };
            itemsMenu.append(filterInp, listEl);
            renderItemRows("");
            document.body.appendChild(itemsMenu);
            setTimeout(() => filterInp.focus(), 0);   // drop straight into the filter field
            document.addEventListener("mousedown", onItemsDown, true);
        };
        itemsBtn.addEventListener("click", (e) => { stop(e); openItemsMenu(); });

        // Category management — ＋ new (always); ✎ rename / 🗑 delete only when a real category is active.
        const catAdd = lpill("＋", "New category", async () => {
            const r = await pmModal({ title: "New category", input: { placeholder: "Category name" }, confirmLabel: "Create" });
            const name = (typeof r === "string" ? r : r?.value || "").trim();
            if (!name) return;
            await libCategoryOp("add", name);
            await node._pgLibRefresh({ fresh: true });
            setScope(name);
        });
        const catRename = lpill("✎", "Rename current category", async () => {
            const cur = node._pgState._libCategory;
            if (!cur || cur === LIB_FAVORITES || cur === LIB_DEFAULT_CATEGORY) return;
            const r = await pmModal({ title: "Rename category", input: { placeholder: "New name", value: cur }, confirmLabel: "Rename" });
            const name = (typeof r === "string" ? r : r?.value || "").trim();
            if (!name || name === cur) return;
            await libCategoryOp("rename", cur, name);
            await node._pgLibRefresh({ fresh: true });
            setScope(name);
        });
        const catDel = lpill("🗑", "Delete current category (its prompts move to Uncategorized)", async () => {
            const cur = node._pgState._libCategory;
            if (!cur || cur === LIB_FAVORITES || cur === LIB_DEFAULT_CATEGORY) return;
            const r = await pmModal({ title: "Delete category?", message: `"${cur}" — its prompts move to ${LIB_DEFAULT_CATEGORY}.`, confirmLabel: "Delete", danger: true });
            if (!r) return;
            await libCategoryOp("delete", cur);
            await node._pgLibRefresh({ fresh: true });
            setScope(LIB_DEFAULT_CATEGORY);
        });
        node._pgUpdateCatMgmt = () => {
            const realCat = node._pgState._libView === "library" && node._pgState._libScope === "category" &&
                node._pgState._libCategory && node._pgState._libCategory !== LIB_FAVORITES && node._pgState._libCategory !== LIB_DEFAULT_CATEGORY;
            // Keep ✎/🗑 in place for a STABLE bar (Uncategorized used to differ by hiding them); grey
            // them out + make them inert where they don't apply (Uncategorized / Favorites / History).
            for (const b of [catRename, catDel]) {
                b.style.display = "flex";
                b.style.opacity = realCat ? "1" : "0.35";
                b.style.pointerEvents = realCat ? "auto" : "none";
            }
        };

        // ---- assemble the single browse bar ----
        const headRow = el("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", padding: "2px 0" });
        // Sort + category-management as ONE flex child so they wrap to the next line together (atomically)
        // when the bar is too narrow, instead of breaking up individually.
        const catGroup = el("div", { display: "flex", alignItems: "center", gap: "6px", flex: "0 0 auto" });
        catGroup.append(sortSel.el, catAdd, catRename, catDel);
        headRow.append(scopeSel.el, searchWrap, albumBtn, cardViewBtn, catGroup);
        const PILL_MATCH = { padding: "9px 10px", fontSize: "12px", border: "1px solid transparent", boxSizing: "border-box" };
        for (const b of [albumBtn, cardViewBtn, catAdd, catRename, catDel]) Object.assign(b.style, PILL_MATCH);

        // ---- preview header: two independent toggles (Preview Image · Preview Text) ----
        // flexWrap + minWidth:0 so in Album mode (narrow 38% preview column) these toggles wrap
        // WITHIN their column instead of overflowing right onto the grid column's pager (◀).
        const prevHeaderRow = el("div", { display: "flex", alignItems: "center", gap: "6px", padding: "2px 0", flexWrap: "wrap", minWidth: "0" });
        // On/off pill that reflects its state (active = dark-blue tab fill, like a selected tab).
        // Own hover handling so the active fill survives mouse-out (lpill would reset it).
        const mkPrevToggle = (label, key) => {
            const b = el("div", {
                cursor: "pointer", userSelect: "none", fontSize: "11px", fontWeight: "600",
                borderRadius: "6px", padding: "4px 9px", flex: "0 0 auto", transition: "background .15s, color .15s, filter .12s",
            }, label);
            b._pgKey = key;
            b.title = "Show / hide " + label.toLowerCase();
            b.addEventListener("mousedown", stop);
            b.addEventListener("mouseenter", () => { b.style.filter = "brightness(1.25)"; });
            b.addEventListener("mouseleave", () => { b.style.filter = "none"; });
            b.addEventListener("click", (e) => {
                stop(e);
                node._pgState[key] = !(node._pgState[key] !== false);
                setVal(key, node._pgState[key]);
                applyPrevSections(); node._pgReflow();
            });
            return b;
        };
        const prevImgBtn = mkPrevToggle("🖼 Preview Image", "_libPrevImgOpen");
        const prevTxtBtn = mkPrevToggle("📄 Preview Text", "_libPrevTxtOpen");
        // When ON, each generation auto-jumps to page 1 and selects the newest prompt in the
        // preview (follow-the-latest). When OFF, generating leaves your page/selection alone.
        const prevLatestBtn = mkPrevToggle("⟳ Preview Latest", "_libPreviewLatest");
        prevLatestBtn.title = "Auto-select the newest generation in the preview on each run";
        prevLatestBtn.addEventListener("click", () => { if (node._pgState._libPreviewLatest) node._pgLibSelectLatest?.(); });
        prevHeaderRow.append(prevImgBtn, prevTxtBtn, prevLatestBtn);
        // Slightly brighter than the shared tab/button fills so these preview toggles read as
        // more defined against the near-black background (subtle ~+5% lightness).
        const PREV_ON_BG = "hsl(0 0% 12% / 0.85)";   // active (~90% black, 15% transparent)
        const PREV_OFF_BG = "hsl(0 0% 8% / 0.85)";   // inactive (~90% black, 15% transparent)
        const syncPrevBtns = () => {
            for (const b of [prevImgBtn, prevTxtBtn, prevLatestBtn]) {
                const on = node._pgState[b._pgKey] !== false;
                b.style.background = on ? PREV_ON_BG : PREV_OFF_BG;
                b.style.color = on ? TAB_ON_TEXT : C.textMuted;
            }
        };
        const prevBody = el("div", { display: "flex", flexDirection: "column", gap: "9px" });
        // Image preview lives in a FIXED-size frame (portrait by default) the user can
        // drag-resize (CSS resize:both). Its size is locked + persisted so the node footprint
        // stays put as you hover entries; a blank frame of the same size shows when there's no
        // image. Centered, so it scales evenly to both sides when the text box is hidden.
        // Image + text share ONE row at the SAME height. The image frame (portrait default) is
        // the size driver: drag its corner to rescale — wider makes the text box narrower, taller
        // makes the row (and the stretched text box) taller. Centered when shown on its own.
        const prevRow = el("div", { display: "flex", alignItems: "stretch", justifyContent: "center", gap: "8px", width: "100%", boxSizing: "border-box" });
        const prevImgFrame = el("div", {
            position: "relative", boxSizing: "border-box", overflow: "hidden", flex: "0 0 auto",
            width: (node._pgState._libPrevImgW || 180) + "px", height: (node._pgState._libPrevImgH || 230) + "px",
            minWidth: "40px", minHeight: "80px", maxWidth: "calc(100% - 96px)",
            border: `1px solid ${C.border}`, borderRadius: "6px", background: C.input,
            display: "flex", alignItems: "center", justifyContent: "center", resize: "both",
        });
        // width/height:100% + object-fit:contain = fills the frame, letterboxed (the proven
        // gallery-card pattern). Hidden until an image is set.
        const prevImg = el("img", { width: "100%", height: "100%", objectFit: "contain", cursor: "zoom-in", display: "none" });
        prevImg.decoding = "async";
        const prevBlank = el("div", { color: C.textMuted, fontSize: "22px", opacity: "0.45", userSelect: "none" }, "🖼");
        const prevImgMissing = el("div", { display: "none", color: C.textMuted, fontSize: "11px", padding: "8px", textAlign: "center" }, "🖼 image no longer available");
        prevImgFrame.append(prevImg, prevBlank, prevImgMissing);
        prevImg.addEventListener("mousedown", stop);
        prevImg.addEventListener("error", () => { prevImg.style.display = "none"; prevBlank.style.display = "none"; prevImgMissing.style.display = "block"; });
        prevImg.addEventListener("click", (e) => {
            stop(e);
            const sel = node._pgLibSelected; const meta = sel && libImageMeta(sel);
            if (meta) showImageLightbox(viewUrlStable(meta));
        });
        // Top-right ↗ button: open the FULL-res shown image in a new browser tab.
        const prevOpenBtn = el("div", {
            // Non-intrusive: bare up-arrow (no background chip), faint at 10% until hovered. Equal
            // inset from the top and right edges. A text-shadow keeps it legible over bright images.
            position: "absolute", top: "6px", right: "6px", zIndex: "4", display: "none", cursor: "pointer",
            color: "#fff", fontSize: "18px", fontWeight: "700", lineHeight: "1", padding: "3px", userSelect: "none",
            opacity: "0.2", textShadow: "0 1px 3px rgba(0,0,0,0.9)", transition: "opacity .12s, transform .12s",
        }, "↑");
        prevOpenBtn.title = "Open image in a new tab";
        prevOpenBtn.addEventListener("mousedown", stop);
        prevOpenBtn.addEventListener("mouseenter", () => { prevOpenBtn.style.opacity = "0.7"; prevOpenBtn.style.transform = "scale(1.15)"; });
        prevOpenBtn.addEventListener("mouseleave", () => { prevOpenBtn.style.opacity = "0.2"; prevOpenBtn.style.transform = "none"; });
        prevOpenBtn.addEventListener("click", (e) => {
            stop(e);
            const sel = node._pgLibSelected; const meta = sel && libImageMeta(sel);
            if (meta) window.open(viewUrlStable(meta), "_blank", "noopener");
        });
        prevImgFrame.append(prevOpenBtn);
        // Persist the user's chosen frame size (debounced) + reflow so the node grows to fit.
        // Width persists only when NOT clamped against the row width, so narrowing the node
        // doesn't quietly overwrite the user's preferred width.
        let _prevImgSizeT = null, _albumRenderT = null;
        const _persistPrevImgSize = () => {
            const w = Math.round(prevImgFrame.offsetWidth), h = Math.round(prevImgFrame.offsetHeight);
            if (!w || !h) return;
            const album = node._pgState._libAlbum === true;
            let changed = false;
            if (album) {
                prevText.style.width = w + "px"; prevMeta.style.width = w + "px";   // live-track: keep text + metadata width equal to the image as it's dragged
                // Album: the frame OWNS the preview width. Persist it as a FRACTION of the split (so it stays
                // proportional when the node window resizes), and only when un-clamped, so a node-shrink clamp
                // never overwrites the user's choice. Then re-flow the grid for the new width.
                const split = node._pgLibSplit?.clientWidth || 0;
                const max = (split || 9999) - 220;
                if (split > 0 && w < max - 1) {
                    const frac = Math.max(0.12, Math.min(w / split, 0.85));
                    if (Math.abs(frac - (node._pgState._libAlbumPrevFrac || 0)) > 0.002) { node._pgState._libAlbumPrevFrac = frac; node._pgState._libAlbumPrevW = w; changed = true; }
                }
                if (_albumRenderT) clearTimeout(_albumRenderT);
                _albumRenderT = setTimeout(() => node._pgLibRender?.(), 180);
            } else if (w < (prevRow.clientWidth || 9999) - 1 && w !== node._pgState._libPrevImgW) {
                node._pgState._libPrevImgW = w; changed = true;
            }
            if (h !== node._pgState._libPrevImgH) { node._pgState._libPrevImgH = h; changed = true; }
            if (!changed) return;
            if (_prevImgSizeT) clearTimeout(_prevImgSizeT);
            _prevImgSizeT = setTimeout(() => node._pgWriteConfig(), 300);
            node._pgReflow?.();
        };
        if (window.ResizeObserver) { try { new ResizeObserver(_persistPrevImgSize).observe(prevImgFrame); } catch {} }

        // Editable preview: tweak any history/library text in place, then Generate or send it
        // straight to the node output — no round-trip through the main Prompt view. It STRETCHES
        // to the image frame's height (synchronized) and narrows in width as the image grows.
        // While the box is focused, hovering other cards won't clobber what you're typing.
        const prevText = el("textarea", { ...baseInputStyle, ...OUTPUT_BOX_STYLE, flex: "1 1 0", minWidth: "0", minHeight: "90px", height: "auto", lineHeight: "1.4", resize: "none" });
        prevText.placeholder = "(Hover or select a prompt to preview — edit here, then ⤴ Output or ⤵ Load)";
        attachBoxHover(prevText, "var(--pg-box, hsl(220 10% 13%))", "var(--pg-box-hover, hsl(220 10% 16%))");
        prevText.addEventListener("mousedown", stop);
        prevText.addEventListener("wheel", stop);
        prevText.addEventListener("keydown", (e) => {
            e.stopPropagation();   // keep ComfyUI canvas shortcuts from eating keystrokes
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); node._pgPrevOutput?.(); }   // Prompts is a library — Ctrl/⌘+Enter sends the edited text to the node output (no render here)
        });
        prevRow.append(prevImgFrame, prevText);
        // Album mode: persist the user-dragged height of the preview text box (debounced).
        if (window.ResizeObserver) {
            let _ptH = null;
            try {
                new ResizeObserver(() => {
                    if (node._pgState._libAlbum !== true) return;
                    const h = Math.round(prevText.offsetHeight);
                    if (h && h !== node._pgState._libAlbumTextH) {
                        node._pgState._libAlbumTextH = h;
                        if (_ptH) clearTimeout(_ptH);
                        _ptH = setTimeout(() => node._pgWriteConfig?.(), 300);
                        node._pgReflow?.();
                    }
                }).observe(prevText);
            } catch {}
        }
        // Push the (edited) preview text straight into the node's output box.
        node._pgPrevOutput = () => {
            node._pgSetOutput?.(String(prevText.value || ""));
            // Jump to the Generator view (Prompt sub-tab) where the output box lives, so you see it.
            node._pgState._view = "generator"; setVal("_view", "generator");
            node._pgState._genView = "prompt"; setVal("_genView", "prompt");
            node._pgApplyView();
        };
        const prevMeta = el("div", { fontSize: "11px", color: C.textMuted, minHeight: "13px", minWidth: "0", maxWidth: "100%", boxSizing: "border-box", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, "");   // one line; truncates to match the image/text width
        node._pgBypassTextColors.push({ el: prevMeta, off: C.textMuted, on: "hsl(0 0% 90%)" });   // near-white in SKIP-LLM; muted otherwise
        // One combined action row: edit-and-go (Output/Copy) + entry actions (Save/Load/Pin/Delete) on a
        // single horizontal line right under the Preset/Mode row. Wraps when narrow. Clear History is
        // appended later, pushed to the far right. NOTE: no Generate here — Prompts is a browse/library;
        // use ⤵ Load to take a prompt (text + Mode/Preset + image) into the Generator, where rendering lives.
        const prevRunRow = el("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" });
        const outBtn = lpill("⤴ Output", "Send this (edited) text straight to the node's output box", () => node._pgPrevOutput());
        const copyPrevBtn = lpill("📋 Copy", "Copy this text to the clipboard", (b) => {
            const o = b.textContent;
            navigator.clipboard?.writeText(prevText.value || "").then(() => { b.textContent = "Copied ✓"; setTimeout(() => b.textContent = o, 1200); }, () => {});
        });
        // One Load button = the full setup: prompt text + its Mode/Preset + its image (loaded as the
        // node's vision input). The old text-only "Load" was removed to keep the row uncluttered.
        const loadFullBtn = lpill("⤵ Load", "Load the full setup: the prompt text, its Mode/Preset, and its image (sent to the node's vision input)", () => node._pgLibLoad(true));
        const saveLibBtn = lpill("💾 Save to Library", "Save this prompt into a category", () => node._pgLibSaveSelected());
        const pinBtn = lpill("⭐ Pin", "Pin/unpin (Library)", () => node._pgLibTogglePin());
        const delEntryBtn = lpill("✕ Delete", "Remove this entry", () => node._pgLibDeleteSelected());
        prevRunRow.append(pinBtn);
        // Output + Copy lead the preview-buttons row. Save to Library + Load go on the Select/Delete row
        // (prepended below) instead of wrapping to their own line when the preview row runs out of width.
        prevHeaderRow.insertBefore(copyPrevBtn, prevHeaderRow.firstChild);
        prevHeaderRow.insertBefore(outBtn, copyPrevBtn);
        // Read-only Mode/Preset display for the history tab — reflects the PREVIEWED entry's
        // source for coherence, WITHOUT touching the Generator. Styled like a dropdown but
        // non-interactive; use "⤵ Load full setup" to actually apply it to the Generator.
        const prevSrcSel = makeSelect([], () => {}, null, {});
        prevSrcSel.el.style.pointerEvents = "none";
        prevSrcSel.el.style.cursor = "default";
        prevSrcSel.el.style.opacity = "0.85";
        const prevSrcLbl = el("span", { color: C.textMuted, fontSize: "12px", flex: "0 0 auto", minWidth: "70px" }, "Mode");
        const prevSrcRow = el("div", { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0", width: "100%", boxSizing: "border-box" });
        prevSrcRow.title = "How the previewed prompt was made — Load full setup to apply it to the Generator";
        prevSrcRow.append(prevSrcLbl, prevSrcSel.el);
        node._pgPrevReflectSource = (source) => {
            const isPreset = !!(source && source.type === "preset" && source.name);
            prevSrcLbl.textContent = isPreset ? "Preset" : "Mode";
            const name = (source && source.name) ? source.name : "—";
            prevSrcSel.fill([name], name);
        };
        // Preview column = meta line (name · preset · tokens · date) ALONE above the image, then the
        // image+text "pictured" row. The action buttons (prevRunRow) live OUTSIDE this column — in a
        // full-width row under the browse bar (see libPanel.append below). The old read-only
        // Preset/Mode row (prevSrcRow) is dropped — its info is already in the meta line (also kills
        // the empty "Mode —" row). prevSrcSel/prevSrcLbl stay defined so _pgPrevReflectSource no-ops.
        prevBody.append(prevMeta, prevRow);

        // Size the image frame per mode: Album fills its column; IMAGE-ONLY (no text box) spans the
        // FULL width and resizes on the Y axis only (image fills the height, centered); with the text
        // box shown it's the user's dragged width (resize both). _persistPrevImgSize already skips
        // persisting width when the frame is full-width, so this never clobbers the dragged width.
        const applyPrevImgFrameSize = () => {
            const album = node._pgState._libAlbum === true;
            const fullWide = !album && node._pgState._libPrevTxtOpen === false;   // image-only → full width, Y-resize
            if (album) {   // Album: the FRAME owns the preview width — drag its corner (resize:both) to scale the
                // image; the column hugs it and the grid fills the rest. Clamp so it never swallows the grid.
                const split = node._pgLibSplit?.clientWidth || 0;
                const max = Math.max(160, (split || 9999) - 220);
                // Width is stored as a FRACTION of the split, so it scales when the node window is resized
                // (not a fixed px). Seed the fraction once from any legacy dragged px width.
                if (node._pgState._libAlbumPrevFrac == null)
                    node._pgState._libAlbumPrevFrac = split > 0 ? Math.min(0.8, (node._pgState._libAlbumPrevW || 300) / split) : 0.42;
                const frac = Math.max(0.12, Math.min(node._pgState._libAlbumPrevFrac, 0.85));
                const w = split > 0 ? Math.max(40, Math.min(Math.round(frac * split), max))
                                    : Math.max(40, Math.min(node._pgState._libAlbumPrevW || 300, max));
                prevImgFrame.style.width = w + "px"; prevImgFrame.style.maxWidth = max + "px"; prevImgFrame.style.resize = "both";
                // text box mirrors the image width EXACTLY — always equal, scales down together (no independent
                // floor). When the image is toggled off, let the text fill the column instead.
                const tw = (node._pgState._libPrevImgOpen !== false) ? (w + "px") : "";
                prevText.style.width = tw; prevMeta.style.width = tw;   // text + metadata both mirror the image width
            }
            else if (fullWide) { prevImgFrame.style.width = "100%"; prevImgFrame.style.maxWidth = "100%"; prevImgFrame.style.resize = "vertical"; prevText.style.width = ""; prevMeta.style.width = ""; }
            else { prevImgFrame.style.width = (node._pgState._libPrevImgW || 180) + "px"; prevImgFrame.style.maxWidth = "calc(100% - 96px)"; prevImgFrame.style.resize = "both"; prevText.style.width = ""; prevMeta.style.width = ""; }
            prevImgFrame.style.height = (node._pgState._libPrevImgH || 230) + "px";
            // Image: fill the box HEIGHT (centered) in full-width mode; fit-within (contain) otherwise.
            if (fullWide) { prevImg.style.width = "auto"; prevImg.style.maxWidth = "100%"; }
            else { prevImg.style.width = "100%"; prevImg.style.maxWidth = "none"; }
        };

        // Image + text preview sections toggle independently. Both share one row at equal
        // height; the image frame is always reserved (blank when no image) while Preview Image
        // is on, so the node doesn't jump as you hover. Toggle either off to reclaim its space.
        const applyPrevSections = () => {
            const imgOpen = node._pgState._libPrevImgOpen !== false;
            const txtOpen = node._pgState._libPrevTxtOpen !== false;
            prevImgFrame.style.display = imgOpen ? "flex" : "none";
            prevText.style.display = txtOpen ? "block" : "none";
            applyPrevImgFrameSize();
            syncPrevBtns();
        };

        // ---- grid + footer ----
        // CSS Grid with auto-fill = the column count follows the node's CURRENT width with no
        // measuring: widen the node and cards flow into more columns (fewer rows = shorter);
        // narrow it and they collapse back. Density (min card width) is set per view in render.
        const grid = el("div", { display: "grid", gap: "6px", marginTop: "2px", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" });
        // Scroll anywhere over the thumbnail grid to flip pages. When there's more than one page the
        // grid becomes a paging zone — it claims the wheel (stopPropagation keeps it from reaching
        // root's forwardWheel = canvas zoom), so hovering any thumbnail and scrolling steps pages
        // instead of zooming. One notch = one page (cooldown throttles a fast scroll); a single-page
        // grid is left alone so the canvas still zooms normally.
        grid.addEventListener("wheel", (e) => {
            const pages = node._pgLibPages || 1;
            if (pages <= 1) return;
            e.preventDefault(); e.stopPropagation();
            const now = performance.now();
            if (now - (node._pgGridWheelT || 0) < 150) return;   // throttle to one page per notch
            const cur = node._pgState._libPage || 0;
            const next = Math.max(0, Math.min(pages - 1, cur + (e.deltaY > 0 ? 1 : -1)));
            if (next === cur) return;   // already at the first/last page
            node._pgGridWheelT = now;
            node._pgState._libPage = next;
            node._pgLibRender();
        }, { passive: false });
        const footRow = el("div", { display: "flex", alignItems: "center", gap: "8px", marginTop: "4px", minWidth: "0" });
        const pagePrev = lpill("◀", "Previous page", () => { if (node._pgState._libPage > 0) { node._pgState._libPage--; node._pgLibRender(); } }, { bg: INPUT_GRAD, bgHi: INPUT_GRAD_HOVER, border: `1px solid ${C.border}` });
        // Ruling system: the label fills the gap between ◀ ▶ but can shrink to 0 (arrows close up)
        // and then ellipsize its text — so the pager never grows past its column / collides.
        const pageLbl = el("div", { flex: "1 1 auto", minWidth: "0", textAlign: "center", fontSize: "11px", color: C.textMuted, userSelect: "none", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", background: INPUT_GRAD, border: `1px solid ${C.border}`, borderRadius: "6px", padding: "4px 10px", boxSizing: "border-box", transition: "background .15s" }, "—");
        // Backing chip behind the page/empty label — matches the dropdowns/search field; lifts to the
        // hover gradient so it reads as the active surface, consistent with the rest of the UI.
        pageLbl.addEventListener("mouseenter", () => { pageLbl.style.background = INPUT_GRAD_HOVER; });
        pageLbl.addEventListener("mouseleave", () => { pageLbl.style.background = INPUT_GRAD; });
        const pageNext = lpill("▶", "Next page", () => { node._pgState._libPage++; node._pgLibRender(); }, { bg: INPUT_GRAD, bgHi: INPUT_GRAD_HOVER, border: `1px solid ${C.border}` });
        const clearBtn = lpill("🧹 Delete All", "Delete all images in the currently selected category", async () => {
            const list = libActiveList(false);   // the whole present scope/category (ignores the search box)
            if (!list.length) return;
            const scopeName = node._pgScopeLabel?.() || "this view";
            const r = await pmModal({ title: "Delete all present?", message: `Delete all ${list.length} prompt${list.length === 1 ? "" : "s"} in “${scopeName}”?\nRecent entries are removed from History; Library entries are deleted. This can't be undone.`, confirmLabel: "Delete All", danger: true });
            if (!r) return;
            if (node._pgState._libView === "recent") clearPromptHistory();          // History scope → wipe all Recent at once
            else for (const e of list) if (e._recent) removePromptHistory(e.id);     // mixed (All) scope → drop the recent ones
            let touchedLib = false;
            for (const e of list) if (!e._recent) { await libDeleteEntry(e.id); touchedLib = true; }
            if (touchedLib) await fetchLibrary({ fresh: true });
            node._pgLibSelected = null; node._pgLibBulk?.clear?.(); node._pgUpdateBulkUI?.(); node._pgLibRender(); node._pgReflow();
        });
        // "Clear History" lives at the far right of the run row (Generate/Output/Copy), Recent only.
        // Delete (this entry) + Clear History live on the pager row (appended to footRow below).
        // Library-only: back up / share the whole library as a JSON file, or merge one in.
        const exportBtn = lpill("⤓ Export", "Download the whole Library as a JSON file", async () => {
            const store = await fetchLibrary({ fresh: true });
            const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "prompt-library.json";
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        });
        const importInput = document.createElement("input");
        importInput.type = "file"; importInput.accept = "application/json,.json"; importInput.style.display = "none";
        importInput.addEventListener("change", async (ev) => {
            const file = ev.target.files?.[0]; importInput.value = "";
            if (!file) return;
            let data; try { data = JSON.parse(await file.text()); } catch { await pmModal({ title: "Import failed", message: "Not a valid JSON file.", confirmLabel: "OK", cancelLabel: "Close" }); return; }
            const entries = Array.isArray(data) ? data : (Array.isArray(data?.entries) ? data.entries : null);
            if (!entries) { await pmModal({ title: "Import failed", message: "No prompt entries found in that file.", confirmLabel: "OK", cancelLabel: "Close" }); return; }
            const r = await pmModal({ title: "Import prompts?", message: `Merge ${entries.length} prompt(s) into the Library?`, confirmLabel: "Import" });
            if (!r) return;
            for (const e of entries) {
                if (!e || !String(e.text || "").trim()) continue;
                // Omit id so each imported prompt is added fresh (no overwrite/collision).
                await libSaveEntry({ name: e.name || "", text: e.text, source: e.source, image_ref: e.image_ref || "", image_meta: e.image_meta || null, category: e.category || LIB_DEFAULT_CATEGORY, pinned: !!e.pinned, uses: e.uses || 0 });
            }
            await fetchLibrary({ fresh: true });
            node._pgLibSyncCategories(); node._pgLibRender(); node._pgReflow();
        });
        const importBtn = lpill("⤒ Import", "Merge a Library JSON file into this one", () => importInput.click());
        footRow.append(pagePrev, pageLbl, pageNext, importBtn, exportBtn);

        // Pagination row sits ABOVE the thumbnails so you can swap pages without scrolling to the
        // bottom of the grid each time.
        // Preview block (header toggles + image/text/actions) and the grid block (pager + cards)
        // live in two columns of a flex wrapper. Normal mode stacks them (column): preview on top,
        // grid below. Album Mode switches the wrapper to a row: preview LEFT, grid RIGHT — so the
        // grid gets the full height and many more prompts show per screen. See _pgApplyAlbum.
        const previewCol = node._pgAsGroupCard(el("div", { display: "flex", flexDirection: "column", gap: "9px", minWidth: "0" }));   // group: Select/Delete row + image & text preview
        // Delete + Clear History form the preview column's header (left, above the image) so they
        // align with the image, while the pager stays the grid column's header (aligns with the grid).
        // ── Multi-select — pick several cards, then Save-them-to-a-category or Delete them together.
        // ONE "Select" button: click = enter select-mode; click AGAIN = clear the selection + exit (no
        // separate Unselect). In select-mode the whole card toggles; selection persists across scopes
        // until you click Select again or leave the Prompts tab. Keyed by String(id) (recent + library
        // ids never collide). Save/Delete then act on the whole selection.
        node._pgLibBulk = new Map();        // String(id) -> entry snapshot
        node._pgLibSelectMode = false;
        node._pgLibBulkToggle = (e) => {
            const k = String(e.id);
            if (node._pgLibBulk.has(k)) node._pgLibBulk.delete(k); else node._pgLibBulk.set(k, e);
            node._pgUpdateCardSelection(); node._pgUpdateBulkUI();
        };
        node._pgLibBulkDelete = async () => {
            const items = [...node._pgLibBulk.values()]; if (!items.length) return;
            const r = await pmModal({ title: "Delete selected?", message: `Delete ${items.length} selected prompt${items.length === 1 ? "" : "s"}?\nRecent entries are removed from History; Library entries are deleted.`, confirmLabel: "Delete", danger: true });
            if (!r) return;
            let touchedLib = false;
            for (const e of items) {
                if (e._recent) removePromptHistory(e.id);
                else { await libDeleteEntry(e.id); touchedLib = true; }
            }
            if (touchedLib) await fetchLibrary({ fresh: true });
            node._pgLibBulk.clear(); node._pgLibSelectMode = false; node._pgLibSelected = null;
            node._pgUpdateBulkUI(); node._pgLibRenderPreview(); node._pgLibRender(); node._pgReflow();
        };
        node._pgLibBulkSave = async () => {
            const items = [...node._pgLibBulk.values()];
            if (!items.length) { await pmModal({ title: "Nothing selected", message: "Click some cards first (while Select is on), then Save to a category.", confirmLabel: "OK", cancelLabel: "" }); return; }
            const cats = (_libraryCache?.categories) || [LIB_DEFAULT_CATEGORY];
            const r = await pmModal({
                title: `Save ${items.length} prompt${items.length === 1 ? "" : "s"} to a category`,
                message: "Pick an existing category or type a new one.\nRecent prompts are copied into the Library; Library prompts move to it.",
                fields: [{ key: "category", label: "Category — pick one or type a new one", placeholder: "Category", value: cats[0] || LIB_DEFAULT_CATEGORY, options: cats.filter((c) => c !== LIB_FAVORITES) }],
                confirmLabel: "Save",
            });
            if (!r) return;
            const category = String(r.values?.category || "").trim() || LIB_DEFAULT_CATEGORY;
            for (const e of items) {
                await libSaveEntry({
                    id: e._recent ? "" : e.id,   // recent → NEW library entry; library → update in place (moves its category)
                    name: e.name || "", text: e.text, source: e.source,
                    image_ref: e.image_ref || "", image_meta: e.image_meta || null,
                    category, pinned: e._recent ? false : !!e.pinned, uses: e.uses || 0,
                });
            }
            await fetchLibrary({ fresh: true });
            node._pgLibBulk.clear(); node._pgLibSelectMode = false; node._pgUpdateBulkUI();
            node._pgLibSyncCategories?.(); node._pgLibRender(); node._pgReflow();
        };

        const selectBtn = lpill("☑ Select", "Multi-select cards, then Save-to-category or Delete them together. Click again to clear the selection.", () => {
            node._pgLibSelectMode = !node._pgLibSelectMode;
            if (!node._pgLibSelectMode) node._pgLibBulk.clear();   // turning OFF = clear the selection (no separate Unselect)
            node._pgUpdateCardSelection(); node._pgUpdateBulkUI();
        });
        const saveSelBtn = lpill("💾 Save to category", "Save all selected prompts into a category", () => node._pgLibBulkSave());
        node._pgUpdateBulkUI = () => {
            const n = node._pgLibBulk ? node._pgLibBulk.size : 0;
            const on = !!node._pgLibSelectMode;
            selectBtn.textContent = on ? `✓ Selecting (${n})` : "☑ Select";
            selectBtn.style.outline = on ? `1px solid ${C.accentBorder}` : "none";   // outline survives lpill's hover bg swaps
            selectBtn.style.color = on ? C.accent : C.text;
            saveSelBtn.style.display = on ? "block" : "none";        // Save appears with select-mode (not mid-pick)
            delEntryBtn.textContent = (on && n) ? `✕ Delete (${n})` : "✕ Delete";
        };
        const delClearRow = el("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", boxSizing: "border-box" });
        delClearRow.append(saveLibBtn, loadFullBtn, selectBtn, saveSelBtn, delEntryBtn, clearBtn);
        previewCol.append(prevBody);   // image group = metadata + image + text (Select/Delete row moved up to the actions group)
        node._pgUpdateBulkUI();   // seed initial state (Save hidden until select-mode is on)
        const splitMidDivider = divider({ margin: "6px 0 4px" });   // separates preview/grid in column mode only
        const gridCol = node._pgAsGroupCard(el("div", { display: "flex", flexDirection: "column", gap: "4px", minWidth: "0" }));   // group: pager + thumbnail grid
        gridCol.append(footRow, grid);
        const splitWrap = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
        splitWrap.append(previewCol, gridCol);   // cards separate the two columns now (no in-between divider)
        // Album image-frame width is clamped against this split's width so the preview never swallows the
        // grid; expose it for applyPrevImgFrameSize + re-clamp whenever the node (split) resizes.
        node._pgLibSplit = splitWrap;
        if (window.ResizeObserver) { try { new ResizeObserver(() => { if (node._pgState._libAlbum === true) applyPrevImgFrameSize(); }).observe(splitWrap); } catch {} }
        // Lead with a divider under the main toggle (matches Generator/Options); then the browse bar,
        // then the full-width ACTION ROW (Generate/Save/Load/… + Clear History), then the preview+grid
        // split. Buttons sit here — under the browse bar, spanning the whole panel — instead of being
        // cramped inside the narrow preview column.
        node._pgAsGroupCard(headRow);   // group: the browse bar (scope · search · layout · sort · category mgmt)
        // Middle button group — NO background (plain transparent container, NOT a painted card). Holds the
        // preview-buttons row (Output/Copy + Preview toggles), the entry actions (Save/Load/Pin), and the
        // Select/Delete/Delete-All row moved up here from the preview column.
        const libActionsCard = el("div", { display: "flex", flexDirection: "column", gap: "4px", width: "100%", minWidth: "0", boxSizing: "border-box", padding: "8px" });
        libActionsCard.append(prevHeaderRow, prevRunRow, delClearRow);
        libPanel.append(headRow, libActionsCard, splitWrap);

        // Toggle the side-by-side Album layout. Stacks the preview's image OVER its text (the left
        // column is narrow), hides the in-column divider, and lets the grid run more rows.
        node._pgApplyAlbum = () => {
            const album = node._pgState._libAlbum === true;
            splitWrap.style.flexDirection = album ? "row" : "column";
            // stretch (both modes): in album the grid card stretches to match the taller preview card's
            // height, so the two boxes are always equal height instead of the grid ending up short.
            splitWrap.style.alignItems = "stretch";
            splitWrap.style.gap = album ? "10px" : "4px";
            // Album: the preview column HUGS the image frame's width (the frame owns the explicit, resizable
            // width — see applyPrevImgFrameSize). The column + the text box under it follow the image, and the
            // grid (flex:1) fills whatever's left — so dragging the image's corner scales image, text AND grid.
            previewCol.style.flex = album ? "0 0 auto" : "";
            previewCol.style.width = "";
            previewCol.style.minWidth = "0";
            previewCol.style.maxWidth = "";
            previewCol.style.resize = "";
            previewCol.style.overflow = "";
            gridCol.style.flex = album ? "1 1 auto" : "";
            splitMidDivider.style.display = album ? "none" : "";
            prevRow.style.flexDirection = album ? "column" : "row";   // image over text in the narrow left column
            // Album: image is ABOVE the text, so let the user drag the TEXT box's height (persisted in _libAlbumTextH).
            // Normal mode keeps the original (image drives the row height; text fills it, no handle).
            prevText.style.resize = album ? "vertical" : "none";
            prevText.style.flex = album ? "0 0 auto" : "1 1 0";
            prevText.style.height = album ? ((node._pgState._libAlbumTextH || 120) + "px") : "auto";
            // Album: the image frame OWNS the width; the text box is sized to EXACTLY match it (applyPrevImgFrameSize
            // + the resize observer), so the two always share one width with no independent floor and scale down
            // together. Column mode: width cleared so flex:1 fills the row.
            applyPrevImgFrameSize();
            prevHeaderRow.style.minHeight = ""; prevHeaderRow.style.boxSizing = "";
            // Align the two column headers (Delete/Clear over the image vs the pager over the grid) so
            // the image and thumbnail grid start on the same line. Neither wraps, so a fixed floor does it.
            delClearRow.style.minHeight = footRow.style.minHeight = album ? "34px" : "";
            delClearRow.style.boxSizing = footRow.style.boxSizing = album ? "border-box" : "";
            footRow.style.marginTop = album ? "0" : "4px";
            gridCol.style.gap = album ? "9px" : "4px";          // match previewCol's 9px gap in album
            grid.style.marginTop = album ? "0" : "2px";
            // In Album, lift ONLY the meta line + the Preview-toggle row to FULL-WIDTH rows above the
            // split (so the toggles don't crush in the 38% column). Delete/Clear stay the preview
            // column's header (left, over the image); the pager stays the grid column's header (right,
            // over the grid) — so each lines up with its own column.
            // prevHeaderRow (actions) and prevMeta (metadata) now live permanently above/with their groups in
            // BOTH modes — prevMeta stays in the preview body with the image, so nothing relocates here anymore.
            syncAlbumBtn?.();
            node._pgLibRender?.(); node._pgReflow?.();
        };

        // ---- simple image lightbox (reuses the modal overlay look) ----
        function showImageLightbox(url) {
            const overlay = el("div", { position: "fixed", inset: "0", background: "rgba(0,0,0,0.75)", zIndex: "10000", display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" });
            const big = el("img", { maxWidth: "90vw", maxHeight: "90vh", borderRadius: "8px", boxShadow: "0 8px 40px rgba(0,0,0,0.6)" });
            big.src = url;
            overlay.appendChild(big);
            overlay.addEventListener("mousedown", () => overlay.remove());
            document.body.appendChild(overlay);
        }

        // ---- data + render ----
        node._pgLibSelected = null;
        node._pgLibRefresh = async ({ fresh = false } = {}) => {
            // Always ensure the library is loaded (cached after the first call) — the scope picker
            // needs the category list even while you're viewing History.
            await fetchLibrary({ fresh });
            node._pgLibSyncCategories();
            node._pgLibRender();
        };
        node._pgLibSyncCategories = () => {
            const cats = (_libraryCache?.categories) || [LIB_DEFAULT_CATEGORY];
            if (node._pgState._libCategory && !cats.includes(node._pgState._libCategory) && node._pgState._libCategory !== LIB_FAVORITES) {
                node._pgState._libCategory = cats[0] || LIB_DEFAULT_CATEGORY;
            }
            node._pgSyncScopeSel?.();   // refresh the scope picker's options + current value
        };

        const libRecentList = () => loadPromptHistory().map((e, i) => ({ ...e, _recent: true, id: e.id || ("r" + i + "_" + (e.ts || 0)), category: "", pinned: false, uses: 0 }));
        const libActiveList = (applySearch = true) => {
            const isRecent = node._pgState._libView === "recent";
            const scopeAll = !isRecent && node._pgState._libScope === "all";
            let list;
            if (isRecent) list = libRecentList();
            else if (scopeAll) {
                // "All" = EVERYTHING: Recent/History + every Library category, combined. Duplicate texts
                // keep their own unique ids (recent "h…/r…" vs library 12-hex) so dupes coexist, by design.
                list = [...libRecentList(), ...((_libraryCache?.entries) || [])];
            } else {
                list = ((_libraryCache?.entries) || []).slice();
                const cat = node._pgState._libCategory;
                if (cat === LIB_FAVORITES) list = list.filter((e) => e.pinned);
                else if (cat) list = list.filter((e) => (e.category || LIB_DEFAULT_CATEGORY) === cat);
            }
            const q = applySearch ? String(node._pgState._libSearch || "").trim().toLowerCase() : "";
            if (q) list = list.filter((e) => (e.name || "").toLowerCase().includes(q) || (e.text || "").toLowerCase().includes(q) || (e.source?.name || "").toLowerCase().includes(q) || (e.category || "").toLowerCase().includes(q));
            const s = node._pgState._libSort;
            if (s === "az") list.sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)));
            else if (s === "uses") list.sort((a, b) => (b.uses || 0) - (a.uses || 0));
            else if (s === "old") list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
            else list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
            return list;
        };

        node._pgLibRenderPreview = () => {
            const e = node._pgLibSelected;
            // Don't stomp an in-progress edit while the box is focused (the user may be tweaking
            // text to Generate/Output). Clicking out / selecting another card loads it normally.
            if (document.activeElement !== prevText) prevText.value = e ? (e.text || "") : "";
            const meta = e && libImageMeta(e);
            prevImgMissing.style.display = "none";
            node._pgPrevHasImage = !!meta;
            const url = meta ? viewUrlPreview(meta) : "";
            if (url) {
                prevBlank.style.display = "none";
                prevImg.style.display = "block";
                if (prevImg._pgSrc !== url) { prevImg._pgSrc = url; prevImg.src = url; }   // cacheable webp preview; no redundant decode
            } else {
                prevImg.style.display = "none";
                prevImg._pgSrc = ""; prevImg.removeAttribute("src");
                prevBlank.style.display = "block";   // blank frame, same fixed size
            }
            prevOpenBtn.style.display = url ? "block" : "none";   // ↗ open-in-new-tab only when an image is shown
            // Re-assert the frame size after a render. Album mode fills the narrow left column width;
            // normal mode keeps the user's locked/dragged width.
            applyPrevImgFrameSize();
            // Reflect the previewed entry's Mode/Preset in the read-only display — for coherence
            // only; it does NOT change the Generator (use ⤵ Load full setup for that).
            node._pgPrevReflectSource?.(e && e.source);
            applyPrevSections();   // respects the Preview Image / Preview Text toggles
            if (e) {
                const date = e.ts ? new Date(e.ts).toLocaleDateString() : "";
                const bits = [];   // {t, italic?}
                if ((e.name || "").trim()) bits.push({ t: "📝 " + e.name.trim() });
                if (!e._recent && e.category) bits.push({ t: e.category });
                if (srcLabel(e.source)) bits.push({ t: srcLabel(e.source) });
                // First 5 words of the prompt as a quick (italic) preview, with ".." when there's more.
                const _pw = (e.text || "").trim().split(/\s+/).filter(Boolean);
                if (_pw.length) bits.push({ t: _pw.slice(0, 5).join(" ") + (_pw.length > 5 ? ".." : ""), italic: true });
                if (date) bits.push({ t: date });
                bits.push({ t: (e.text || "").length + " chars" });
                if (e.uses) bits.push({ t: e.uses + "× used" });
                prevMeta.textContent = "";
                bits.forEach((b, i) => {
                    if (i) prevMeta.appendChild(document.createTextNode("  ·  "));
                    prevMeta.appendChild(el("span", b.italic ? { fontStyle: "italic" } : {}, b.t));
                });
            } else prevMeta.textContent = "";
            // Recent vs Library action availability.
            const isRecent = !!(e && e._recent);
            saveLibBtn.style.display = (e && isRecent) ? "block" : "none";
            pinBtn.style.display = (e && !isRecent) ? "block" : "none";
            // Keep the Delete pill always visible (greyed + inert when nothing is selected) so it
            // never looks like it vanished next to Clear History; the per-card ✕ also deletes.
            delEntryBtn.style.display = "block";
            delEntryBtn.style.opacity = e ? "1" : "0.35";
            delEntryBtn.style.pointerEvents = e ? "auto" : "none";
            loadFullBtn.style.display = e ? "block" : "none";
            if (e && !isRecent) pinBtn.textContent = e.pinned ? "★ Unpin" : "⭐ Pin";
        };

        // Reflect the current selection by toggling card borders in place — O(cards on page),
        // no DOM teardown and no image re-decode. (The old path rebuilt the entire grid just
        // to move one accent border, which re-created every <img> and felt janky/desynced.)
        node._pgUpdateCardSelection = () => {
            const selId = node._pgLibSelected?.id;
            const bulk = node._pgLibBulk;
            for (const card of grid.children) {
                const id = card.dataset?.pgCardId;
                if (id == null) continue;   // skip the empty-state placeholder
                const inBulk = !!(bulk && bulk.has(id));   // multi-select membership → full-card accent overlay
                card.style.borderColor = (inBulk || id === String(selId)) ? C.accentBorder : C.border;
                if (card._pgSelOverlay) card._pgSelOverlay.style.display = inBulk ? "block" : "none";
            }
        };
        // Clicking a card selects it AND briefly suspends hover-switching (~2.5s) so you can move the
        // mouse up to the editor without another thumbnail stealing the preview. It auto-releases;
        // focusing the preview text box keeps it protected for as long as you're editing.
        node._pgLibSelect = (e) => {
            node._pgLibSelected = e;
            node._pgLibLock = e.id;
            if (node._pgLibLockT) clearTimeout(node._pgLibLockT);
            node._pgLibLockT = setTimeout(() => { node._pgLibLock = null; }, 2500);
            node._pgUpdateCardSelection(); node._pgLibRenderPreview();
        };
        // Jump to page 1 and select the newest entry in the active list (used by "Preview Latest").
        node._pgLibSelectLatest = () => {
            node._pgState._libPage = 0;
            node._pgLibRender();
            const list = libActiveList();
            if (list.length) { node._pgLibSelected = list[0]; node._pgUpdateCardSelection(); node._pgLibRenderPreview(); }
        };

        const buildLibCard = (e) => {
            const view = node._pgState._libCardView;
            const gallery = view === "gallery";
            const imageOnly = view === "image";
            const thumb = gallery || imageOnly;   // both are small image-card layouts
            const selected = node._pgLibSelected && node._pgLibSelected.id === e.id;
            const meta = libImageMeta(e);
            const card = el("div", {
                position: "relative", boxSizing: "border-box", overflow: "hidden", cursor: "pointer",
                border: `1px solid ${selected ? C.accentBorder : C.border}`, borderRadius: "6px",
                // Text cards show their fill (no image over it); give them a slightly more transparent
                // token in bypass so the dark red background reads through a touch more.
                background: thumb ? C.input : "var(--pg-textcard, hsl(220 12% 8%))",
                ...(thumb ? { height: "66px" } : { height: "88px" }),   // denser cards → more items per area; width comes from the grid cell
            });
            if (thumb && meta) {
                const im = el("img", { width: "100%", height: "100%", objectFit: "cover", display: "block" });
                im.decoding = "async"; im.loading = "lazy";   // don't block the main thread / off-screen cards
                im.src = viewUrlPreview(meta);                 // same URL as the preview pane + prefetch → one shared cache entry
                const ph = el("div", { display: "none", position: "absolute", inset: "0", alignItems: "center", justifyContent: "center", color: C.textMuted, fontSize: "11px", padding: "4px", textAlign: "center" }, "🖼");
                im.addEventListener("error", () => { im.style.display = "none"; ph.style.display = "flex"; });
                if (imageOnly) {
                    // Image-only: just the thumbnail at 85% opacity, full brightness on hover — no caption/dim.
                    im.style.opacity = "0.85"; im.style.transition = "opacity .15s";
                    card.append(im, ph);
                    card.addEventListener("mouseenter", () => { im.style.opacity = "1"; });
                    card.addEventListener("mouseleave", () => { im.style.opacity = "0.85"; });
                } else {
                    // Gallery: dimmed-by-default with the prompt text legible on top; hovering fades the
                    // dim + caption out so the thumbnail shows at full brightness.
                    const dim = el("div", { position: "absolute", inset: "0", background: "rgba(0,0,0,0.5)", transition: "opacity .2s", pointerEvents: "none" });
                    const cap = el("div", { position: "absolute", inset: "0", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6px", transition: "opacity .2s", pointerEvents: "none" });
                    cap.append(el("div", {
                        fontSize: "11px", fontWeight: "700", lineHeight: "1.25", color: "rgba(255,255,255,0.9)", textAlign: "center",
                        textShadow: "0 1px 3px rgba(0,0,0,0.95)", overflow: "hidden",
                        display: "-webkit-box", webkitBoxOrient: "vertical", webkitLineClamp: "3",
                    }, (e.name || "").trim() || e.text || ""));   // custom name if set, else the PROMPT TEXT (never the preset/mode); top-aligned
                    card.append(im, ph, dim, cap);
                    card.addEventListener("mouseenter", () => { dim.style.opacity = "0"; cap.style.opacity = "0"; });
                    card.addEventListener("mouseleave", () => { dim.style.opacity = "1"; cap.style.opacity = "1"; });
                }
                // 🔍 opens the full-res image (a plain card click selects/pins, so zoom gets its own button).
                const zoomBtn = el("div", { position: "absolute", top: "2px", left: "4px", color: "#fff", fontSize: "10px", lineHeight: "1", cursor: "zoom-in", padding: "2px 4px", borderRadius: "4px", userSelect: "none", background: "rgba(0,0,0,0.4)", zIndex: "3", transition: "transform .12s ease", transformOrigin: "top left" }, "🔍");
                zoomBtn.title = "View full image";
                zoomBtn.addEventListener("mousedown", stop);
                zoomBtn.addEventListener("mouseenter", () => { zoomBtn.style.transform = "scale(1.2)"; });   // grow 20% on hover
                zoomBtn.addEventListener("mouseleave", () => { zoomBtn.style.transform = "none"; });
                zoomBtn.addEventListener("click", (ev) => { stop(ev); showImageLightbox(viewUrlStable(meta)); });
                card.append(zoomBtn);
            } else if (thumb) {
                card.append(el("div", { position: "absolute", inset: "0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.textMuted, fontSize: "11px", padding: "4px", textAlign: "center", gap: "2px" },
                    "🖼"));
                card.append(el("div", { position: "absolute", left: "0", right: "0", bottom: "0", padding: "3px 5px", fontSize: "10px", fontWeight: "700", color: C.text, background: "rgba(0,0,0,0.45)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, (e.name || "").trim() || e.text || ""));
            } else {
                const title = entryTitle(e);
                if (title) card.append(el("div", { position: "absolute", top: "0", left: "0", right: "0", padding: "3px 34px 3px 6px", fontSize: "11px", fontWeight: "700", color: C.text, background: "rgba(0,0,0,0.35)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, title));
                card.append(el("div", {
                    height: "100%", overflow: "auto", boxSizing: "border-box",
                    padding: (title ? "22px" : "6px") + " 34px 6px 6px",
                    fontSize: "11px", color: C.textMuted, whiteSpace: "pre-wrap", wordBreak: "break-word",
                }, e.text || ""));
            }
            if (e.pinned) card.append(el("div", { position: "absolute", top: "2px", right: "34px", fontSize: "11px", color: "#e8c14a" }, "★"));
            // Quick delete (✕) — top-right; for Recent removes from history, for Library deletes entry.
            const xBtn = el("div", { position: "absolute", top: "2px", right: thumb ? "4px" : "16px", color: "#e06464", fontSize: "12px", fontWeight: "700", lineHeight: "1", cursor: "pointer", padding: "1px 4px", borderRadius: "4px", userSelect: "none", background: "rgba(0,0,0,0.3)" }, "✕");
            xBtn.title = "Remove";
            xBtn.addEventListener("mousedown", stop);
            xBtn.addEventListener("click", async (ev) => {
                stop(ev);
                node._pgLibBulk?.delete(String(e.id));   // drop from the multi-select set if it was in it
                if (e._recent) { removePromptHistory(e.id); }
                else { await libDeleteEntry(e.id); await fetchLibrary({ fresh: true }); }
                if (node._pgLibSelected && node._pgLibSelected.id === e.id) node._pgLibSelected = null;
                node._pgUpdateBulkUI?.(); node._pgLibRenderPreview(); node._pgLibRender(); node._pgReflow();
            });
            card.append(xBtn);
            // Multi-select highlight — a full-card accent wash + ✓ corner, shown only while selected.
            // (pointerEvents:none so it never blocks the card's own click.) Unmissable on image cards.
            const selOverlay = el("div", { position: "absolute", inset: "0", display: "none", background: "hsl(208 70% 56% / 0.38)", border: `2px solid ${C.accent}`, borderRadius: "6px", boxSizing: "border-box", zIndex: "5", pointerEvents: "none" });
            selOverlay.append(el("div", { position: "absolute", top: "3px", left: "3px", width: "20px", height: "20px", borderRadius: "50%", background: C.accent, color: "#fff", fontSize: "13px", fontWeight: "800", lineHeight: "20px", textAlign: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.6)" }, "✓"));
            if (node._pgLibBulk && node._pgLibBulk.has(String(e.id))) selOverlay.style.display = "block";
            card.append(selOverlay);
            card._pgSelOverlay = selOverlay;
            card.title = e.text || "";
            card.dataset.pgCardId = String(e.id);
            card.addEventListener("mousedown", stop);
            card.addEventListener("wheel", stop);
            // Hover previews the entry and selects it (existing behavior); borders are driven
            // centrally so exactly one card carries the accent — no leftover highlight trail.
            card.addEventListener("mouseenter", () => { if (node._pgLibLock != null || document.activeElement === prevText) return; node._pgLibSelected = e; node._pgLibRenderPreview(); node._pgUpdateCardSelection(); });
            card.addEventListener("mouseleave", () => { node._pgUpdateCardSelection(); });
            // In multi-select mode the WHOLE card toggles bulk membership; otherwise it selects/previews.
            card.addEventListener("click", (ev) => { stop(ev); if (node._pgLibSelectMode) node._pgLibBulkToggle(e); else node._pgLibSelect(e); });
            return card;
        };

        const _pgLibRenderImpl = () => {
            // "Delete All Present" shows in every scope; Export/Import only in Library scopes.
            const isRecent = node._pgState._libView === "recent";
            node._pgUpdateCatMgmt?.();
            clearBtn.style.display = "block";
            exportBtn.style.display = isRecent ? "none" : "block";
            importBtn.style.display = isRecent ? "none" : "block";
            grid.innerHTML = "";
            // Auto-fill picks the columns from the current width; read the resolved track count
            // AFTER setting the template, then cap the page at columns × LIB_MAX_ROWS.
            const thumb = node._pgState._libCardView === "gallery" || node._pgState._libCardView === "image";
            let minCard = thumb ? 80 : 150;
            if (!thumb) {
                // Keep at least 2 columns even when the node is narrow → a 2×2 grid of smaller
                // cards instead of one wide column. When wider, the base 150 lets more columns in.
                const gw = grid.clientWidth || (((node.size && node.size[0]) || 400) - 28);
                minCard = Math.max(110, Math.min(minCard, Math.floor((gw - 6) / 2)));
            }
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${minCard}px, 1fr))`;
            // Album mode runs more rows — the grid sits beside the preview with the full height to use.
            const maxRows = node._pgState._libAlbum ? ALBUM_MAX_ROWS : LIB_MAX_ROWS;
            const pageSize = Math.max(2, libColumns(minCard) * maxRows);
            node._pgLibPageSize = pageSize;   // remembered for the incremental live-update helpers
            const all = libActiveList();
            const pages = Math.max(1, Math.ceil(all.length / pageSize));
            node._pgLibPages = pages;   // source of truth for the grid scroll-to-page handler
            if (node._pgState._libPage >= pages) node._pgState._libPage = pages - 1;
            if (node._pgState._libPage < 0) node._pgState._libPage = 0;
            const page = node._pgState._libPage;
            const slice = all.slice(page * pageSize, page * pageSize + pageSize);
            // Empty state is shown in the page label between the ◀ ▶ arrows (below), not as a card.
            const emptyMsg = isRecent ? "No recent prompts yet — run a few." : "No saved prompts here yet.";
            for (const e of slice) grid.appendChild(buildLibCard(e));
            node._pgUpdateCardSelection();   // reflect single-select + multi-select highlights on the fresh cards
            // Warm the cache + decode for THIS page's preview images NOW (while the user reads /
            // moves the mouse), so hovering a card swaps the preview pane instantly instead of
            // starting a fresh fetch on hover. Same URL as the cards + pane → one shared cache
            // entry. Kept referenced on the node so the browser doesn't drop the decode early.
            for (const e of slice) { const m = libImageMeta(e); if (m) pgPrefetchImage(viewUrlPreview(m)); }
            // Background-warm only the ADJACENT pages (prev/current/next), not the whole history —
            // warming all 500 floods the server with synchronous webp encodes and stalls the load.
            const warmSlice = all.slice(Math.max(0, (page - 1) * pageSize), (page + 2) * pageSize);
            pgWarmAll(warmSlice.map((e) => { const m = libImageMeta(e); return m ? viewUrlPreview(m) : ""; }));
            pageLbl.textContent = all.length ? `Page ${page + 1} / ${pages}  ·  ${all.length} prompt${all.length === 1 ? "" : "s"}` : emptyMsg;
            pagePrev.style.color = page > 0 ? C.text : C.textMuted;
            pageNext.style.color = page < pages - 1 ? C.text : C.textMuted;
            // Default-select the first visible entry whenever nothing valid is selected, so the
            // preview pane AND its action buttons (Load / Load full setup / Pin / Delete) populate
            // immediately on open — instead of staying hidden until the user hovers a card (the
            // long-standing "buttons take ages to appear" bug). Never stomp an active click-lock or
            // a selection that's still on this page; clear selection only when the list is empty.
            if (!slice.length) {
                node._pgLibSelected = null;
            } else if (node._pgLibLock == null) {
                const sel = node._pgLibSelected;
                if (!sel || !slice.some((e) => e.id === sel.id)) {
                    node._pgLibSelected = slice[0];
                    node._pgUpdateCardSelection();
                }
            }
            node._pgLibRenderPreview();
        };
        // Coalesce bursts of render requests (the init/onConfigure _pgApplyView storm fires several
        // in a row) into ONE actual rebuild on the next frame — instead of tearing down + recreating
        // the whole grid + all its <img> 2–3× on open.
        let _libRenderRAF = 0;
        node._pgLibRender = () => {
            if (_libRenderRAF) return;
            _libRenderRAF = requestAnimationFrame(() => { _libRenderRAF = 0; try { _pgLibRenderImpl(); } catch (err) { console.error("[PromptGeneratorPro] lib render", err); } });
        };

        // ---- incremental gallery updates (avoid a full teardown on every live result) ----
        // During gallery-open spam-gen, rebuilding all ~N cards + re-decoding their <img> on EVERY
        // result is the stutter source. These splice ONE card instead; anything non-trivial falls
        // back to the full render, so behavior is identical everywhere except the cheap hot path.
        const _libFindCard = (id) => { for (const c of grid.children) if (c.dataset && c.dataset.pgCardId === String(id)) return c; return null; };
        const _libCurPageSize = () => node._pgLibPageSize || Math.max(2, libColumns((node._pgState._libCardView === "gallery" || node._pgState._libCardView === "image") ? 80 : 150) * (node._pgState._libAlbum ? ALBUM_MAX_ROWS : LIB_MAX_ROWS));
        // A new History entry arrived. Cheap path ONLY when the entry truly belongs at the front
        // (History · newest · page 0 · no search); otherwise fall back to a full render.
        node._pgLibOnNewEntry = (selectNew) => {
            const simple = node._pgState._view === "prompts" && node._pgState._libView === "recent"
                && node._pgState._libSort === "new" && (node._pgState._libPage || 0) === 0
                && !String(node._pgState._libSearch || "").trim();
            if (!simple) { if (selectNew) node._pgLibSelectLatest?.(); else node._pgLibRender?.(); return; }
            const all = libActiveList();
            if (!all.length) { node._pgLibRender?.(); return; }
            const e = all[0];
            const pageSize = _libCurPageSize();
            const existing = _libFindCard(e.id);
            const card = buildLibCard(e);
            if (existing) { grid.replaceChild(card, existing); }   // a collapsed-in-place run → swap the front card
            else { grid.insertBefore(card, grid.firstChild); while (grid.children.length > pageSize) grid.removeChild(grid.lastChild); }
            const pages = Math.max(1, Math.ceil(all.length / pageSize));
            pageLbl.textContent = `Page 1 / ${pages}  ·  ${all.length} prompt${all.length === 1 ? "" : "s"}`;
            pageNext.style.color = pages > 1 ? C.text : C.textMuted;
            if (selectNew || !node._pgLibSelected) { node._pgLibSelected = e; node._pgLibRenderPreview(); }
            node._pgUpdateCardSelection();
            const m = libImageMeta(e); if (m) pgPrefetchImage(viewUrlPreview(m));
        };
        // An existing entry's data changed (e.g. its saved image just attached). Rebuild just that
        // one card in place if it's on the current page — position is unchanged, so this is safe in
        // any sort/scope; if it isn't visible there's nothing to repaint.
        node._pgLibReplaceCard = (id) => {
            if (node._pgState._view !== "prompts") return;
            const existing = _libFindCard(id);
            if (!existing) return;
            const e = libActiveList().find((x) => String(x.id) === String(id));
            if (!e) { node._pgLibRender?.(); return; }
            grid.replaceChild(buildLibCard(e), existing);
            node._pgUpdateCardSelection();
            const m = libImageMeta(e); if (m) pgPrefetchImage(viewUrlPreview(m));
        };

        // ---- load / save / pin actions ----
        // Apply an entry's source (the Mode or Preset it was generated with) to the selectors —
        // shared by "Load full setup" and the live preview-sync below. Synced across all menus;
        // no-op when it already matches.
        node._pgApplyEntrySource = (source) => {
            if (!source || !source.name) return;
            if (source.type === "mode") {
                if (node._pgState._modeView !== "modes") { node._pgState._modeView = "modes"; setVal("_modeView", "modes"); node._pgApplyModeView?.(); }
                if (node._pgState.mode !== source.name) { setVal("mode", source.name); node._pgSetModeAll?.(source.name); node._pgUpdateImageBox?.(); }
            } else if (source.type === "preset") {
                if (node._pgState._modeView !== "presets") { node._pgState._modeView = "presets"; setVal("_modeView", "presets"); node._pgApplyModeView?.(); }
                if (node._pgState.override_system_prompt !== source.name) node._pgApplyPreset?.(source.name);
            }
        };
        node._pgLibLoad = (full) => {
            const e = node._pgLibSelected; if (!e) return;
            node._pgSetPromptAll?.(e.text || "");
            if (full && e.source) node._pgApplyEntrySource(e.source);
            if (full && e.image_ref) { const meta = libImageMeta(e); if (meta) node._pgLoadImageMeta?.(meta); }
            // Count a use (Library entries only).
            if (!e._recent) { libSaveEntry({ ...e, uses: (e.uses || 0) + 1 }).then(() => fetchLibrary({ fresh: true })); }
            // Jump to the Generator so the loaded prompt is visible.
            node._pgState._view = "generator"; setVal("_view", "generator"); node._pgApplyView();
            node._pgReflow();
        };

        // Save an arbitrary {text, source, image_ref} into the library via a category dialog.
        node._pgLibSaveTo = async ({ text, source, image_ref, image_meta, id, name, pinned, uses, category } = {}) => {
            text = String(text || "").trim();
            if (!text) { await pmModal({ title: "Nothing to save", message: "The prompt is empty.", confirmLabel: "OK", cancelLabel: "Close" }); return; }
            await fetchLibrary({ fresh: true });
            const cats = (_libraryCache?.categories) || [LIB_DEFAULT_CATEGORY];
            const def = (category && cats.includes(category)) ? category : (node._pgState._libCategory && cats.includes(node._pgState._libCategory) ? node._pgState._libCategory : cats[0]);
            const r = await pmModal({
                title: "Save to Library",
                fields: [
                    { key: "name", label: "Name (optional — blank shows the system prompt name)", placeholder: "e.g. Ferrari red", value: name || "" },
                    { key: "category", label: "Category — pick one or type a new one", placeholder: "Category", value: def === LIB_FAVORITES ? LIB_DEFAULT_CATEGORY : def, options: cats.filter((c) => c !== LIB_FAVORITES) },
                ],
                checkbox: { label: "⭐ Pin", value: !!pinned },
                confirmLabel: "Save",
            });
            if (!r) return;
            const nm = (r.values.name || "").trim();
            const cat = (r.values.category || LIB_DEFAULT_CATEGORY).trim() || LIB_DEFAULT_CATEGORY;
            const entry = { id, name: nm, text, source: source || node._pgCurrentSource(), image_ref: image_ref || "", image_meta: image_meta || null, category: cat, pinned: !!r.checked, uses: uses || 0 };
            const res = await libSaveEntry(entry);
            if (!res?.ok) { await pmModal({ title: "Save failed", message: res?.error || "Unknown error", confirmLabel: "OK", cancelLabel: "Close" }); return; }
            await fetchLibrary({ fresh: true });
            node._pgState._libCategory = cat; setVal("_libCategory", cat);
            node._pgLibSyncCategories();
            if (node._pgState._view === "prompts") node._pgLibRender();
        };
        // 💾 Save Input — the prompt INPUT box text (+ live mode/preset; vision image only for
        // vision sources, since image_upload is sticky across text modes).
        node._pgSaveInputToLibrary = () => {
            const src = node._pgCurrentSource();
            const useImg = src.vision && node._pgState.image_upload_meta;
            return node._pgLibSaveTo({ text: node._pgState.prompt, source: src,
                image_ref: useImg ? (node._pgState.image_upload || "") : "",
                image_meta: useImg ? node._pgState.image_upload_meta : null });
        };
        // 💾 Save Output — the OUTPUT box text (the shown version = the refined edition when one
        // exists, since Refine advances to the latest version in the box).
        node._pgSaveOutputToLibrary = () => {
            const src = node._pgCurrentSource();
            const useImg = src.vision && node._pgState.image_upload_meta;
            const out = (node._pgOutBoxes && node._pgOutBoxes[0]) ? (node._pgOutBoxes[0].value || "") : "";   // Output box already includes prefix/suffix
            return node._pgLibSaveTo({ text: out, source: src,
                image_ref: useImg ? (node._pgState.image_upload || "") : "",
                image_meta: useImg ? node._pgState.image_upload_meta : null });
        };
        node._pgLibSaveSelected = () => { const e = node._pgLibSelected; if (e) node._pgLibSaveTo({ text: e.text, source: e.source, image_ref: e.image_ref, image_meta: e.image_meta, name: e.name }); };
        node._pgLibTogglePin = async () => {
            const e = node._pgLibSelected; if (!e || e._recent) return;
            await libSaveEntry({ ...e, pinned: !e.pinned });
            await fetchLibrary({ fresh: true });
            node._pgLibSelected = { ...e, pinned: !e.pinned };
            node._pgLibRender();
        };
        node._pgLibDeleteSelected = async () => {
            if (node._pgLibBulk && node._pgLibBulk.size) return node._pgLibBulkDelete();   // bulk selection wins
            const e = node._pgLibSelected; if (!e) return;
            if (e._recent) { removePromptHistory(e.id); }
            else { await libDeleteEntry(e.id); await fetchLibrary({ fresh: true }); }
            node._pgLibSelected = null; node._pgLibRender(); node._pgReflow();
        };

        // Attach a workflow's saved output image (its real /view location) to the most-recent
        // Recent entry this node produced — matched by the prompt text it last recorded.
        node._pgAttachRunImage = (meta) => {
            if (!meta || !meta.name) return;
            // ONLY pair an image with this node's prompt if the node's prompt OUTPUT is actually wired into
            // the workflow. If it's unlinked, the image was generated from some OTHER node's text, so pairing
            // it here would be a MISMATCH (an image with the wrong prompt). Pure connection state — no guessing.
            const outSlot = (node.outputs || []).find((o) => o && o.name === "output");
            if (!outSlot || !outSlot.links || !outSlot.links.length) return;
            const list = loadPromptHistory();
            if (!list.length) return;
            // Target THIS run's exact entry by id; fall back to newest matching text.
            let idx = node._pgLastRecordedId ? list.findIndex((e) => e.id === node._pgLastRecordedId) : -1;
            if (idx < 0) idx = node._pgLastRecordedText ? list.findIndex((e) => e.text === node._pgLastRecordedText) : 0;
            if (idx < 0) return;
            list[idx].image_meta = meta;
            list[idx].image_ref = annotatedName(meta);
            _histTouch();   // mutated the live mirror in place → debounced persist (no per-image write storm)
            // Refresh if the Recent view is showing (and keep this entry's selection in sync).
            if (node._pgState._view === "prompts" && node._pgState._libView === "recent") {
                if (node._pgLibSelected && node._pgLibSelected.id === list[idx].id) {
                    node._pgLibSelected = { ...node._pgLibSelected, image_meta: meta, image_ref: list[idx].image_ref };
                    node._pgLibRenderPreview?.();   // refresh the preview pane if this entry is the one shown
                }
                node._pgLibReplaceCard?.(list[idx].id);   // repaint just this card's thumbnail, not the whole grid
            }
        };

        // Jump to the Prompts tab (optionally a specific sub-view), from anywhere.
        node._pgGoToPrompts = (sub) => {
            node._pgState._view = "prompts"; setVal("_view", "prompts");
            if (sub === "recent" || sub === "library") { node._pgState._libView = sub; setVal("_libView", sub); }
            // If we were in the theater view, drop back to the normal layout first.
            node._pgApplyView();
            node._pgReflow();
        };

        node._pgApplyLibView = () => {
            syncCardViewBtn(); syncAlbumBtn(); applyPrevSections();
            node._pgApplyAlbum?.();
            sortSel.set(node._pgState._libSort);
            searchInput.value = node._pgState._libSearch || "";
            node._pgSyncScopeSel?.(); node._pgUpdateCatMgmt?.();
            node._pgLibRefresh({ fresh: false });
        };
    }

    // ---- pin the DOM widget element to the node's width ----
    // root is styled width:100%, but ComfyUI's widget container is shrink-to-fit, so that 100%
    // collapses onto the CONTENT's natural width instead of the node's. That single mismatch caused
    // BOTH bugs: the wide Expanded view ballooned past the node body, and dragging the node wider in
    // Prompts didn't grow the content (its width came from content, not node.size[0]). Pinning root
    // to node.size[0] (graph units — ComfyUI's canvas transform scales it) keeps the element exactly
    // the node's width: it fills when you widen the node and never overflows it.
    // ComfyUI positions the element inset from the node's LEFT edge by its standard widget margin
    // (~15 graph units, zoom-independent). So a width of the full node.size[0] overruns the RIGHT
    // border by that margin (the clipping you see). Subtract it from both sides → the element fills
    // the node width with a symmetric inset and never clips. PG_DOM_MARGIN is the one tuning knob.
    const PG_DOM_MARGIN = 15;
    node._pgSyncWidth = function () {
        const w = Math.max(0, ((node.size && node.size[0]) || 400) - PG_DOM_MARGIN * 2);
        if (root.__pgW !== w) { root.__pgW = w; root.style.width = w + "px"; }
    };

    // ---- reflow node height after DOM changes ----
    let _pgReflowRAF = 0;
    node._pgReflow = function () {
        node.setDirtyCanvas(true, true);
        // Collapse bursts: keep only ONE pending resize per frame so a flood of callers can't stack
        // hundreds of setSize + canvas redraws into a freeze.
        if (_pgReflowRAF) return;
        _pgReflowRAF = requestAnimationFrame(() => { _pgReflowRAF = 0; try { node._pgSyncWidth(); for (const fn of (node._pgOutLayouts || [])) { try { fn(); } catch {} } node.setSize([node.size[0], node.computeSize()[1]]); } catch {} });
    };

    // ---- apply state -> controls ----
    node._pgApplyState = function () {
        for (const [name, ctrl] of Object.entries(node._pgControls)) {
            if (ctrl?.set) ctrl.set(node._pgState[name]);
        }
        // Mode selects and prompt inputs live in their own sync registries (not _pgControls)
        // because they're mirrored across the main + theater views — restore them here.
        node._pgSetModeAll?.(node._pgState.mode);
        for (const p of (node._pgPromptInputs || [])) p.set?.(node._pgState.prompt);
        node._pgUpdateInputCount?.();
        for (const c of (node._pgBatchCtrls || [])) c.set?.(node._pgState._batchN || 1);
        // Backend select isn't in _pgControls — restore it from this node's config and
        // mirror it to the global pref so the dropdowns/status reflect the node's choice.
        if (node._pgState.backend) {
            node._pgBackendSel?.set(node._pgState.backend);
            savePref("llm_backend", node._pgState.backend);
        }
        node._pgUpdateImageBox?.();
        node._pgUpdatePresetUI?.();
        node._pgRefreshExecIcons?.();
        node._pgRefreshBypass?.();
        node._pgApplyBackendFields?.();
        node._pgApplyModeView?.();
        node._pgApplyExecOpen?.();
        node._pgUpdateVisionWarn?.();
    };

    // ---- view toggle (also hides native seed widgets in Options view) ----
    // ================= EXPANDED ("theater") VIEW =================
    // A big read-friendly view mirroring the main controls: Close · Mode/Preset ·
    // Prompt · output actions · arrows + History + progress · large output box.
    const expandedPanel = el("div", { display: "none", flexDirection: "column", gap: "6px", flexShrink: "0" });
    const closeViewBtn = makeButton("⤡  Close View", () => { node._pgState._view = "generator"; setVal("_view", "generator"); node._pgApplyView(); }, { width: "100%", fontWeight: "700", padding: "10px" });
    expandedPanel.appendChild(closeViewBtn);
    const expModeRow = node._pgBuildModeRow();
    expandedPanel.appendChild(expModeRow.row);
    const expPrompt = makeText(true, "Enter prompt…  (Ctrl/⌘+Enter to run)", (v) => node._pgSyncPrompt(v, expPrompt.el), { noGlow: true });
    Object.assign(expPrompt.el.style, OUTPUT_BOX_STYLE);
    attachBoxHover(expPrompt.el, "var(--pg-box, hsl(220 10% 13%))", "var(--pg-box-hover, hsl(220 10% 16%))");
    node._pgPromptInputs.push(expPrompt);
    // (Ctrl/⌘+Enter handled by the global capture listener — renders whichever box is focused. makeText stops keydown.)
    const expPromptRow = labelRow("", expPrompt.el, { stack: true });
    // Input group card (mirrors the main view): actions row + input box + affix/count, grouped so the
    // SKIP-LLM backing wraps them too. See node._pgMkGroupCard.
    const expInputCard = node._pgMkGroupCard();
    expandedPanel.appendChild(expInputCard);
    expInputCard.appendChild(node._pgBuildInputActions());   // input-actions row above the box — mirrors the main view
    expInputCard.appendChild(expPromptRow);
    expInputCard.appendChild(node._pgMkInputCount());   // live char · word count under the Expanded input box
    // Execution settings header — mirror the main view: label on the left, icon bar
    // (🧠 thinking · 🔌 stop-server · ♻️ clear-VRAM · 💀 kill) pushed to the right.
    const expExecHeader = el("div", {
        display: "flex", alignItems: "center", gap: "6px",
        color: C.heading, fontSize: "11px", fontWeight: "700", letterSpacing: "0.4px",
        textTransform: "uppercase", opacity: "0.85", margin: "6px 0 2px", padding: "2px 0",
    });
    expExecHeader.append(el("span", {}, "Execution Settings"), node._pgBuildExecIconBar());
    // Coherency: brighten the header text on hover, like the main view's Execution Settings header.
    expExecHeader.style.transition = "color .15s";
    expExecHeader.addEventListener("mouseenter", () => { expExecHeader.style.color = C.text; });
    expExecHeader.addEventListener("mouseleave", () => { expExecHeader.style.color = C.heading; });
    expandedPanel.appendChild(expExecHeader);
    const expCluster = node._pgBuildOutputCluster({ big: true });
    const expOutputCard = node._pgMkGroupCard();   // output group card — mirrors the main view
    expOutputCard.appendChild(expCluster.wrap);
    expandedPanel.appendChild(expOutputCard);
    node._pgAddMeter?.(expCluster.meter);   // its meter already sits on the cluster's bottom meta-row
    // A second Close View at the bottom (mirrors the top one) so you don't have to scroll
    // back up after reading a long output.
    const closeViewBtnBottom = makeButton("⤡  Close View", () => { node._pgState._view = "generator"; setVal("_view", "generator"); node._pgApplyView(); }, { width: "100%", fontWeight: "700", padding: "10px", marginTop: "4px" });
    expandedPanel.appendChild(closeViewBtnBottom);
    root.appendChild(expandedPanel);

    // ── Global Ctrl/⌘+Enter → render an image from the box you're CURRENTLY editing, and ONLY that box ──
    // One capture-phase listener (fires before ComfyUI's own shortcuts) inspects document.activeElement: if it
    // is THIS node's INPUT box → render the input text; its OUTPUT box → render the output text; anything else
    // (other fields, the Prompts library box, another node, the canvas) → ignored. So no matter which menu/view
    // you're in, it only runs the active text box and never triggers a box from a different view.
    const onGlobalRunBox = (e) => {
        if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
        const ae = document.activeElement;
        if (!ae) return;
        const isInput = (node._pgPromptInputs || []).some((p) => p.el === ae);
        const isOutput = (node._pgOutBoxes || []).includes(ae);
        if (!isInput && !isOutput) return;   // focus isn't in THIS node's input/output box → leave it alone
        e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        node._pgRenderImage?.(ae.value ?? "");   // render EXACTLY what's in the focused box (input or output)
    };
    document.addEventListener("keydown", onGlobalRunBox, true);
    node._pgRunBoxCleanup = () => { try { document.removeEventListener("keydown", onGlobalRunBox, true); } catch {} };

    node._pgApplyView = function () {
        const view = node._pgState._view;
        const isExpanded = view === "expanded";
        const isOpt = !isExpanded && view === "options";
        const isPrompts = !isExpanded && view === "prompts";
        const isGen = !isExpanded && !isOpt && !isPrompts;
        // Leaving the Prompts tab clears the multi-select (selection is scoped to browsing).
        if (!isPrompts && node._pgLibBulk && node._pgLibBulk.size) { node._pgLibBulk.clear(); node._pgLibSelectMode = false; node._pgUpdateBulkUI?.(); }
        genPanel.style.display = isGen ? "flex" : "none";
        libPanel.style.display = isPrompts ? "flex" : "none";
        optPanel.style.display = isOpt ? "flex" : "none";
        expandedPanel.style.display = isExpanded ? "flex" : "none";
        // Main tab bar hidden in the theater view; status bar also obeys the Status toggle.
        toggleBar.style.display = isExpanded ? "none" : "flex";
        const showStatus = node._pgState._showStatus !== false;
        const statusVisible = !isExpanded && showStatus;
        statusBar.style.display = statusVisible ? "flex" : "none";
        if (node._pgStatusDivider) node._pgStatusDivider.style.display = statusVisible ? "" : "none";   // divider only when the status bar shows
        if (node._pgTopToggleRow) node._pgTopToggleRow.style.display = isExpanded ? "none" : "flex";
        node._pgTopToggleRefresh?.forEach((fn) => { try { fn(); } catch {} });
        if (isGen) node._pgApplyGenView?.();
        else if (isOpt) node._pgApplyOptView?.();
        else if (isPrompts) node._pgApplyLibView?.();
        const setTab = (t, on) => (on ? tabOn : tabOff)(t);
        setTab(tabGen, isGen);
        setTab(tabPrompts, isPrompts);
        setTab(tabOpt, isOpt);
        // Refresh each main button's caption + active-arrow highlight.
        node._pgTabSubUpdaters?.forEach((fn) => { try { fn(); } catch {} });
        // Re-fit titles: the active/inactive split just changed, so the inactive pair's common size does too.
        node._pgFitMainTabs?.();
        // Native seed / control_after_generate stay visible in BOTH the Generator and
        // Options views (hidden only in the theater view). Keeping them mounted means the
        // status bar + category buttons hold the exact same vertical position when you
        // switch Generator ⇄ Options — only the panel content below the buttons changes.
        const showSeed = !isExpanded && node._pgState._showSeed !== false;
        for (const w of node.widgets || []) {
            if (w.name === "seed" || w.name === "control_after_generate") {
                if (showSeed) {
                    if (w._pgHidden) { w.hidden = false; w.computeSize = w._pgOrigComputeSize; w._pgHidden = false; }
                } else if (!w._pgHidden) {
                    w._pgOrigComputeSize = w.computeSize;
                    w.hidden = true; w.computeSize = () => [0, -4]; w._pgHidden = true;
                }
            }
        }
        node.setDirtyCanvas(true, true);
        // Re-pin the element width: the just-shown panel (e.g. the wide Expanded view) has a
        // different content width, which would otherwise re-balloon the shrink-to-fit container.
        node._pgSyncWidth?.();
        requestAnimationFrame(() => { try { node._pgSyncWidth?.(); node.setSize([node.size[0], node.computeSize()[1]]); } catch {} });
    };

    // ---- hide the config widget (keep type STRING for serialization) ----
    for (const w of node.widgets || []) {
        if (w.name !== "config") continue;
        w.computeSize = () => [0, -4];
        w.hidden = true;
        w.draw = function () {};
        if (w.element) w.element.style.display = "none";
    }

    // Keep node.imgs for downstream auto-detect (Resolution Master) but DON'T let
    // ComfyUI paint the image on the node body — we show it only in our DOM box in
    // the Generator > Prompt view. Suppressing the canvas preview avoids it bleeding
    // through under the DOM widget in the Options view.
    node.onDrawBackground = function () {};

    // ---- mount DOM widget ----
    const domW = node.addDOMWidget("pg_ui", "div", root, { hideOnZoom: false, serialize: false });
    domW.computeSize = function (width) {
        // Report HEIGHT (fit to content) only. WIDTH must pass through the arg litegraph hands us
        // (its base/min width) — NOT node.size[0]. Returning the live width here makes litegraph
        // treat the current width as the node's MINIMUM, which ratchets: the node can never be
        // dragged narrower again. The element's fill width is handled separately by _pgSyncWidth.
        const h = Math.max(Math.ceil(root.scrollHeight || 0), 120);
        return [width, h];
    };

    // Keep the node body locked to the live content height. Some changes (grid reflow on a width
    // drag, image loads, editing the preview) grow/shrink the content WITHOUT litegraph
    // recomputing the node, so the drawn background ends up taller than the content until you
    // click out and back in. Observing the content height and refitting on real changes fixes
    // that automatically. A pure height-drag doesn't change the content, so it isn't undone here.
    if (window.ResizeObserver) {
        let _fitPending = false;
        const ro = new ResizeObserver(() => {
            if (_fitPending) return;
            _fitPending = true;
            requestAnimationFrame(() => {
                _fitPending = false;
                try {
                    const h = node.computeSize()[1];
                    if (Math.abs(h - node.size[1]) > 1) { node.setSize([node.size[0], h]); node.setDirtyCanvas(true, true); }
                } catch {}
            });
        });
        try { ro.observe(root); node._pgRootRO = ro; } catch {}
    }

    // ---- compact status checklist (one line, top of the custom UI) ----
    // Four fixed factors — backend, Model, MMPROJ, ⚙ Prompt — each ✓/green when on,
    // ✗/red when off, so setup gaps are obvious at a glance without opening Options.
    const statusBar = el("div", {
        position: "relative", flexShrink: "0",
        display: "flex", alignItems: "center", gap: "11px",
        padding: "5px 14px", margin: "3px 0 3px",
        background: GRAD_CARD, border: `1px solid ${C.border}`, borderRadius: "8px",
        boxShadow: SHADOW_SOFT,
        fontSize: "11px", fontFamily: FONT, fontWeight: "600",
        whiteSpace: "nowrap", overflow: "hidden", boxSizing: "border-box", width: "100%",
    });
    // Chips centered with thin "|" dividers between them; the progress bar persists (not cleared on re-render).
    const statusContent = el("div", { display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", flex: "1 1 auto", overflow: "hidden", whiteSpace: "nowrap" });
    // Rough generation progress (token-length estimate vs a rolling expected length).
    const progressBar = el("div", { position: "absolute", left: "0", bottom: "0", height: "2px", width: "0%", background: C.accent, opacity: "0", borderRadius: "1px", transition: "width .2s linear, opacity .3s" });
    statusBar.append(statusContent, progressBar);
    let progHideT = null;
    node._pgSetProgress = (frac, { done = false } = {}) => {
        if (progHideT) { clearTimeout(progHideT); progHideT = null; }
        progressBar.style.opacity = "1";
        progressBar.style.width = (done ? 100 : Math.round(Math.max(0, Math.min(1, frac)) * 100)) + "%";
        if (done) { node._pgProgDone = true; progHideT = setTimeout(() => { progressBar.style.opacity = "0"; progressBar.style.width = "0%"; }, 700); }
    };
    node._pgHideProgress = () => {
        if (progHideT) { clearTimeout(progHideT); progHideT = null; }
        progressBar.style.opacity = "0"; progressBar.style.width = "0%";
    };
    node._pgUpdateChecklist = () => {
        statusContent.innerHTML = "";
        const running = !!node._pgServerRunning;
        const isOllama = node._pgState.backend === "ollama";
        const backendLabel = isOllama ? "ollama" : "llama";   // status-bar labels are lowercase
        const ollDown = isOllama && !running;   // Ollama selected but not running
        const model = String(node._pgState.model || "");
        // A "real" model: present, not a placeholder ("No …" / "Ollama not running …").
        const hasModel = !!model && !/^No /.test(model) && !/not running/i.test(model);
        const hasMmproj = !!node._pgState.mmproj && node._pgState.mmproj !== "None";
        const noSys = node._pgState.mode === NO_MODE || node._pgState.system_prompt_mode === "none" || node._pgState.override_system_prompt === NO_SYS_PROMPT;
        // Minimal status chips: a small state DOT (faint green/red/grey, like the Options ▸
        // LLM dot) followed by a uniform light-grey label. No coloured text, no ✓/✗/⚙ glyphs —
        // the dot alone conveys state. state: "on" (green) | "off" (red) | "neutral" (grey).
        const DOT_GREEN = "#5fae6a", DOT_RED = "#ae5f5f", DOT_GREY = "#777";
        const mkChip = (state, label, title, onClick) => {
            const c = el("span", { display: "inline-flex", alignItems: "center", gap: "6px", flex: "0 0 auto", color: C.text });
            const dot = el("span", { width: "8px", height: "8px", borderRadius: "50%", flex: "0 0 auto", background: state === "on" ? DOT_GREEN : (state === "neutral" ? DOT_GREY : DOT_RED) });
            c.append(dot, el("span", {}, label));
            c.title = title || "";
            if (onClick) { c.style.cursor = "pointer"; c.addEventListener("mousedown", stop); c.addEventListener("click", (e) => { stop(e); onClick(); }); }
            return c;
        };
        const sep = () => el("span", { color: C.textMuted, opacity: "0.35", fontWeight: "400", flex: "0 0 auto" }, "|");
        // All chip labels are lowercase. Backend dot: green=running, red=found-not-running,
        // grey=not found (consistent with the Options ▸ LLM status dot, incl. llama.cpp).
        const beState = running ? "on" : (node._pgServerFound === false ? "neutral" : "off");
        const beName = isOllama ? "Ollama" : "Llama";
        const beStateTxt = running ? "running" : (node._pgServerFound === false ? "not found" : "not running");
        // Backend chip is click-to-check: a single on-demand status probe (no background polling).
        const chips = [
            mkChip(beState, backendLabel, `Click to check status of ${beName} (currently: ${beStateTxt})`, () => node._pgRefreshStatus?.()),
        ];
        // Model — Ollama's model list comes from the server, so grey it when Ollama is down.
        // llama.cpp models are local files, valid regardless of whether the server is running.
        if (ollDown) chips.push(mkChip("neutral", "model", "Ollama not running."));
        else chips.push(mkChip(hasModel ? "on" : "off", "model", hasModel ? model : "No model selected — Options ▸ LLM ▸ Model"));
        // MMPROJ (llama.cpp, separate vision file) ⇄ Vision (Ollama bakes vision into the model).
        if (isOllama) {
            if (ollDown) chips.push(mkChip("neutral", "vision", "Ollama not running."));
            else {
                const v = node._pgOllamaVision;
                if (v == null) chips.push(mkChip("neutral", "vision", "Checking the model's vision capability… (restart ComfyUI if it stays grey)"));
                else chips.push(mkChip(v ? "on" : "off", "vision", v ? "Model supports vision (image input)" : "This model is text-only (no vision)"));
            }
        } else {
            chips.push(mkChip(hasMmproj ? "on" : "off", "mmproj", hasMmproj ? `mmproj: ${node._pgState.mmproj}` : "No mmproj (needed for vision) — Options ▸ LLM ▸ MMProj"));
        }
        // System Prompt — green dot when on; grey dot (like Vision's grey) when none/off.
        // Hover shows which preset/mode is currently providing the system prompt. Clickable.
        const sysDesc = () => {
            const ov = node._pgState.override_system_prompt;
            if (ov && ov !== NONE_PRESET && ov !== NO_SYS_PROMPT) return `preset "${ov}"`;
            if ((node._pgState.system_prompt || "").trim()) return "custom text-field prompt";
            return `mode default (${node._pgState.mode})`;
        };
        if (noSys) chips.push(mkChip("neutral", "system prompt", "No system prompt — click to turn on", () => node._pgToggleSystemPrompt?.()));
        else chips.push(mkChip("on", "system prompt", `Using ${sysDesc()} — click to turn off`, () => node._pgToggleSystemPrompt?.()));
        chips.forEach((c, i) => { if (i) statusContent.append(sep()); statusContent.append(c); });
    };
    // Toggle the system prompt on/off straight from the status chip. Turning OFF switches
    // the Preset/Mode dropdowns to "None" (and remembers what was selected); turning ON
    // restores that last-used preset + mode.
    node._pgToggleSystemPrompt = () => {
        const off = node._pgState.mode === NO_MODE || node._pgState.system_prompt_mode === "none" || node._pgState.override_system_prompt === NO_SYS_PROMPT;
        if (off) {
            // ON → restore the last-used preset + mode (or sane defaults).
            const last = node._pgLastSysPrompt || {};
            if (node._pgState.mode === NO_MODE) {
                const m = (last.mode && last.mode !== NO_MODE) ? last.mode : "Enhance Prompt (Text)";
                node._pgState.mode = m; node._pgSetModeAll?.(m);
            }
            if (node._pgState.system_prompt_mode === "none") {
                node._pgState.system_prompt_mode = (last.system_prompt_mode && last.system_prompt_mode !== "none") ? last.system_prompt_mode : "replace";
                node._pgControls.system_prompt_mode?.set?.(node._pgState.system_prompt_mode);
            }
            const restore = (last.override_system_prompt && last.override_system_prompt !== NO_SYS_PROMPT) ? last.override_system_prompt : NONE_PRESET;
            node._pgApplyPreset?.(restore);   // syncs the Preset + quick-pick dropdowns
            node._pgUpdateImageBox?.();
        } else {
            // OFF → remember the current selection, then switch the dropdown(s) to None.
            node._pgLastSysPrompt = {
                override_system_prompt: node._pgState.override_system_prompt,
                system_prompt_mode: node._pgState.system_prompt_mode,
                mode: node._pgState.mode,
            };
            node._pgApplyPreset?.(NO_SYS_PROMPT);   // Preset/quick dropdowns now read "None"
            // Also switch the Mode dropdown to "None" so BOTH selectors reflect "no system
            // prompt" (turning it back on restores the remembered mode via _pgLastSysPrompt).
            node._pgState.mode = NO_MODE; node._pgSetModeAll?.(NO_MODE);
            node._pgUpdateImageBox?.();
        }
        node._pgWriteConfig(true);
        node._pgUpdatePresetUI?.();   // refreshes the preset path note + the status chip
        node._pgReflow?.();
    };
    // Jump to Options ▸ LLM on click (where all three are configured).
    statusBar.addEventListener("mousedown", stop);
    statusBar.style.cursor = "pointer";
    statusBar.title = "Setup status — click to open Options ▸ LLM";
    statusBar.addEventListener("click", (e) => {
        stop(e);
        node._pgState._view = "options"; node._pgState._optView = "llm";
        node._pgWriteConfig?.(); node._pgApplyOptView?.(); node._pgApplyView?.();
    });
    // Place at the TOP of the custom UI (just under the native seed / control widgets),
    // inside the main DOM widget — avoids clipping behind the io row and any widget reorder.
    root.insertBefore(statusBar, root.firstChild || null);
    // Splitter line directly under the status bar (shown only when the status bar is).
    const statusDivider = divider({ margin: "6px 0 4px" });
    node._pgStatusDivider = statusDivider;
    root.insertBefore(statusDivider, statusBar.nextSibling);
    // Seed / Status toggles sit just under the status bar, ABOVE the splitter that tops the
    // Generator/Options buttons.
    root.insertBefore(node._pgTopToggleRow, statusDivider.nextSibling);
    // Splitter line under the toggles (between them and the Generator/Options buttons).
    root.insertBefore(divider({ margin: "1px 0 4px" }), node._pgTopToggleRow.nextSibling);
    node._pgUpdateChecklist();

    // ---- capture latest state on serialize (belt-and-suspenders) ----
    const origSerialize = node.onSerialize;
    node.onSerialize = function (o) {
        try { node._pgWriteConfig(true); } catch {}
        if (origSerialize) return origSerialize.apply(this, arguments);
    };

    // ---- (re)populate the model / mmproj / override dropdowns from the server,
    //      honoring the per-node custom scan directories ----
    node._pgRefreshModelLists = function (opts = {}) {
        fetchOptionsData(node._pgState.model_dir, node._pgState.mmproj_dir, { ...opts, backend: node._pgState.backend, ollamaUrl: node._pgState.ollama_url }).then((data) => {
            const models = Array.isArray(data.models) ? data.models : [];
            const mmprojs = Array.isArray(data.mmproj) ? data.mmproj : ["None", "auto"];
            // The node's own backend (config) is authoritative — keep the selector on it
            // rather than letting the server's global value override the per-node choice.
            node._pgBackendSel?.set(node._pgState.backend);

            const usingModelDir = !!String(node._pgState.model_dir || "").trim();
            const usingMmprojDir = !!String(node._pgState.mmproj_dir || "").trim();

            // Model: when a custom folder is active, the list shows ONLY that folder's
            // files. If the saved selection isn't in it, reset to the folder's first
            // entry (replace, no stale append). With no custom folder, keep the saved
            // selection even if absent (bulletproofing) — fill() re-adds it.
            // For Ollama the returned list is authoritative (it's exactly what the server
            // serves), so a stale selection that isn't in it MUST be replaced — otherwise
            // switching to Ollama leaves the old llama.cpp model selected and the list
            // looks like it "didn't pull" the Ollama models.
            const ollamaBackend = node._pgState.backend === "ollama";
            let modelSel = node._pgState.model;
            if (((usingModelDir || ollamaBackend) && !models.includes(modelSel)) || !modelSel) {
                modelSel = data.default_model || models[0] || "";
            }
            node._pgState.model = modelSel;
            // In Ollama mode the list is exactly the served models — never append a stale
            // non-Ollama selection to it (pass null so fill() shows ONLY the served models).
            const modelCur = (ollamaBackend && !models.includes(modelSel)) ? null : (modelSel || null);
            node._pgControls.model?.fill?.(models, modelCur);

            // MMproj: same replace semantics under a custom folder ("None"/"auto" always present).
            let mmSel = node._pgState.mmproj;
            if (usingMmprojDir && !mmprojs.includes(mmSel)) {
                mmSel = mmprojs.includes("auto") ? "auto" : (mmprojs[0] || "");
            }
            node._pgState.mmproj = mmSel;
            node._pgControls.mmproj?.fill?.(mmprojs, mmSel || null);
            // NOTE: the system-prompt presets dropdown is managed by _pgRefreshPresets().
            node._pgApplyState();
            node._pgWriteConfig(true);
            node._pgRefreshOllamaVision?.();   // re-check vision for the (possibly new) model
        });
    };

    // Add 🧠 thinking / ♻️ clear-VRAM / 💀 kill to the top pill bar (next to Seed/Status), synced
    // with the Execution Settings icon bar. Inserted before the Bypass pill (which sits far right).
    try { topToggleRow.insertBefore(node._pgBuildExecIconBar({ only: ["brain", "clearvram", "skull"], marginLeftAuto: false }), bypassTop); } catch {}

    // ---- initial population ----
    node._pgReadConfig();
    node._pgRefreshModelLists();
    node._pgRefreshPresets?.();
    node._pgRefreshStatus?.();

    node._pgApplyState();
    node._pgRefreshAffixPills?.();   // show any saved prefix/suffix on the pills
    node._pgApplyView();
    node._pgUpdateResInfo?.();   // seed the output dimensions readout (before the Resolution view is opened)

    // No background status polling. Status is pulled ON DEMAND — click the status dot/label or the
    // backend chip, use Test/Serve/Kill, or open Options ▸ LLM. This removes idle network/disk work
    // and the model-list re-scan that a server state-flip used to trigger.

    try { node.setSize([400, 460]); node._pgSyncWidth(); } catch {}
    requestAnimationFrame(() => { node._pgApplyView(); });
}
