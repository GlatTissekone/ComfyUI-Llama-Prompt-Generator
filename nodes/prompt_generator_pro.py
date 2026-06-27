"""
Prompt Generator (Pro) — a single merged node that combines the former
`Prompt Generator` and `Prompt Generator Options` nodes into one UI with a
Generator/Options toggle (handled entirely in JS).

Design:
- All backend logic is reused, not reimplemented:
    * Generation reuses `PromptGenerator.convert_prompt` (llama.cpp + Ollama).
    * Option/model handling reuses `PromptGenOptions.create_options`
      (model download, mmproj resolution, system-prompt override, legacy fixes).
- The whole UI state lives in one hidden, multiline STRING widget named
  `config` (a JSON blob). Because it is a normal serialized widget, ComfyUI
  persists it into the workflow automatically — so every setting survives node
  reloads, refreshes and workflow save/load.
"""

import json
import os
import random
import re
import time
import uuid

from .prompt_generator import PromptGenerator, normalize_timeout
from .prompt_generator_options import (
    PromptGenOptions,
    get_default_context_size,
    _system_prompt_override_choices,
    _load_system_prompts_from_prompt_manager,
)
from ..py.model_manager import get_all_models, get_local_mmproj_files, register_extra_model_dir, _preferences_cache
from ..py.ollama_wrapper import discover_ollama_models
from ..py.ideogram_caption import get_system_prompt as ideogram_system_prompt, \
    build_user_prompt as ideogram_user_prompt, parse_caption as ideogram_parse_caption

IDEOGRAM_STANDARD = "Ideogram4 Vision Standard"
IDEOGRAM_DETAILED = "Ideogram4 Vision Detailed"

# Sentinel selectable in the System Prompt dropdowns meaning "send NO system prompt
# at all" — overrides the instructions box whether it's empty or not.
NO_SYS_PROMPT = "(No system prompt)"

# "None" = a raw text run with NO system prompt at all (box content ignored).
NO_MODE = "None"

MODE_CHOICES = [
    NO_MODE,
    "Enhance Prompt (Text)",
    "Enhance Prompt (Video)",
    "Analyze Image with Prompt",
    IDEOGRAM_STANDARD,
    IDEOGRAM_DETAILED,
]

# UI mode label -> backend mode understood by PromptGenerator.convert_prompt.
# "Enhance Prompt (Text)" is the corrected label for what used to be
# "Enhance Prompt (Image)" (it enhances text, not an image). "None" is also a
# text run, just with the system prompt suppressed (handled via no_system_prompt).
_MODE_BACKEND = {
    "Enhance Prompt (Text)": "Enhance Prompt (Image)",
    NO_MODE: "Enhance Prompt (Image)",
}

# Modes that consume an image (used to decide whether to load an uploaded image).
_VISION_MODES = {"Analyze Image with Prompt", "Enhance Prompt (Video)",
                 IDEOGRAM_STANDARD, IDEOGRAM_DETAILED}

# ── System-prompt presets stored as .txt files in prompts/presets/ ──
_PRESETS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts", "presets")

# Preset used as the system prompt when the box is empty in the default text mode.
_DEFAULT_PRESET = "Clean Cinematic Enhancer"


def _read_preset_text(name):
    """Return the text of a saved .txt preset by name, or '' if missing."""
    try:
        p = os.path.join(_PRESETS_DIR, _safe_preset_name(name) + ".txt")
        if os.path.isfile(p):
            with open(p, "r", encoding="utf-8") as fh:
                return fh.read()
    except Exception:
        pass
    return ""


def _safe_preset_name(name):
    """Sanitize a preset name into a safe bare filename (no extension, no path)."""
    base = os.path.basename(str(name or "").strip())
    if base.lower().endswith(".txt"):
        base = base[:-4]
    base = re.sub(r'[^A-Za-z0-9 _\-\(\)\.]', '', base).strip()
    return base


# ── Preset metadata (type: vision vs text) ──
# Kept OUT of the .txt files so the prompt text stays pure. One small JSON index
# in the presets folder maps preset name -> {"vision": bool}. The .json extension
# means _list_file_presets (which only reads .txt) never treats it as a preset.
_PRESETS_META_PATH = os.path.join(_PRESETS_DIR, "_presets_meta.json")


def _load_presets_meta():
    """Return the {name: {"vision": bool}} metadata map (empty on any error)."""
    try:
        if os.path.isfile(_PRESETS_META_PATH):
            with open(_PRESETS_META_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
                if isinstance(data, dict):
                    return data
    except Exception:
        pass
    return {}


def _save_presets_meta(meta):
    """Persist the metadata map (best-effort)."""
    try:
        os.makedirs(_PRESETS_DIR, exist_ok=True)
        with open(_PRESETS_META_PATH, "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[PromptGeneratorPro] Could not write presets metadata: {e}")


def _set_preset_meta(name, vision):
    """Record (or clear) a preset's vision flag in the metadata index."""
    meta = _load_presets_meta()
    entry = meta.get(name) if isinstance(meta.get(name), dict) else {}
    entry["vision"] = bool(vision)
    meta[name] = entry
    _save_presets_meta(meta)


def _is_vision_preset(name):
    """True if the named preset is flagged as a vision preset."""
    entry = _load_presets_meta().get(name)
    return bool(entry.get("vision")) if isinstance(entry, dict) else False


def _list_file_presets():
    """User presets saved as .txt files (deletable)."""
    out = []
    meta = _load_presets_meta()
    if os.path.isdir(_PRESETS_DIR):
        for fname in sorted(os.listdir(_PRESETS_DIR), key=lambda s: s.lower()):
            if not fname.lower().endswith(".txt"):
                continue
            p = os.path.join(_PRESETS_DIR, fname)
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    text = fh.read()
            except Exception:
                text = ""
            name = fname[:-4]
            entry = meta.get(name)
            vision = bool(entry.get("vision")) if isinstance(entry, dict) else False
            out.append({"name": name, "text": text, "deletable": True,
                        "path": os.path.normpath(p), "vision": vision})
    return out


def _list_all_presets():
    """All presets: built-in (from Prompt Manager 'System Prompts', undeletable) + file presets."""
    presets = []
    try:
        builtin = _load_system_prompts_from_prompt_manager()
    except Exception:
        builtin = {}
    for name in sorted(builtin.keys(), key=lambda s: s.lower()):
        presets.append({"name": name, "text": builtin[name], "deletable": False, "path": "", "vision": False})
    presets.extend(_list_file_presets())
    return presets


# ── Prompt Library ──
# A curated, server-side store of the user's INPUT prompts, organized into named
# categories and searchable in the node's "Prompts ▸ Library" tab. Mirrors the
# preset pattern: one JSON file in the prompts folder, edited via /prompt-generator/*
# routes. Each entry keeps the Mode/Preset that produced it and an optional image
# reference (annotated filename only — never a copy of the image).
_LIBRARY_PATH = os.path.join(_PRESETS_DIR, "..", "library.json")
_LIBRARY_PATH = os.path.normpath(_LIBRARY_PATH)

# Always-present category the UI falls back to (deleting a category reassigns here).
_LIB_DEFAULT_CATEGORY = "Uncategorized"


def _load_library():
    """Return the library store {categories:[...], entries:[...]} (sane empty default)."""
    try:
        if os.path.isfile(_LIBRARY_PATH):
            with open(_LIBRARY_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                cats = data.get("categories")
                ents = data.get("entries")
                return {
                    "categories": cats if isinstance(cats, list) else [_LIB_DEFAULT_CATEGORY],
                    "entries": ents if isinstance(ents, list) else [],
                }
    except Exception:
        pass
    return {"categories": [_LIB_DEFAULT_CATEGORY], "entries": []}


def _save_library(store):
    """Persist the library store (best-effort)."""
    try:
        os.makedirs(os.path.dirname(_LIBRARY_PATH), exist_ok=True)
        with open(_LIBRARY_PATH, "w", encoding="utf-8") as fh:
            json.dump(store, fh, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"[PromptGeneratorPro] Could not write library: {e}")
        return False


def _lib_ensure_category(store, name):
    """Make sure `name` exists in the category list (returns the cleaned name)."""
    name = str(name or "").strip() or _LIB_DEFAULT_CATEGORY
    if name not in store["categories"]:
        store["categories"].append(name)
    return name


def _lib_norm_source(src):
    """Normalize an entry's source descriptor {type, name, vision}."""
    if not isinstance(src, dict):
        return {"type": "", "name": "", "vision": False}
    t = str(src.get("type", "") or "")
    return {
        "type": t if t in ("mode", "preset") else "",
        "name": str(src.get("name", "") or ""),
        "vision": _coerce_bool(src.get("vision"), False),
    }


def _lib_save_entry(data):
    """Add a new entry or update an existing one (by id). Returns the saved entry."""
    store = _load_library()
    eid = str(data.get("id", "") or "").strip()
    category = _lib_ensure_category(store, data.get("category"))
    # image_meta = the exact saved location {name, subfolder, type}; preserved verbatim so
    # the UI can render a thumbnail with no string round-trip. image_ref is the annotated
    # string form the backend uses to actually load the image.
    img_meta = data.get("image_meta")
    if not isinstance(img_meta, dict):
        img_meta = None
    entry = {
        "id": eid or (uuid.uuid4().hex[:12]),
        "name": str(data.get("name", "") or "").strip(),
        "text": str(data.get("text", "") or ""),
        "source": _lib_norm_source(data.get("source")),
        "image_ref": str(data.get("image_ref", "") or ""),
        "image_meta": img_meta,
        "category": category,
        "pinned": _coerce_bool(data.get("pinned"), False),
        "uses": int(_coerce_num(data.get("uses"), 0) or 0),
        "ts": int(_coerce_num(data.get("ts"), 0) or 0) or int(time.time() * 1000),
    }
    # Replace in place when the id already exists, else append.
    for i, e in enumerate(store["entries"]):
        if isinstance(e, dict) and e.get("id") == entry["id"]:
            store["entries"][i] = entry
            break
    else:
        store["entries"].append(entry)
    _save_library(store)
    return entry


def _lib_delete_entry(eid):
    store = _load_library()
    eid = str(eid or "").strip()
    before = len(store["entries"])
    store["entries"] = [e for e in store["entries"] if not (isinstance(e, dict) and e.get("id") == eid)]
    _save_library(store)
    return before != len(store["entries"])


def _lib_category_op(op, name, new_name=""):
    """add / rename / delete a category. Delete reassigns its entries to Uncategorized."""
    store = _load_library()
    name = str(name or "").strip()
    new_name = str(new_name or "").strip()
    if op == "add":
        if not name:
            return False, "Empty category name"
        _lib_ensure_category(store, name)
    elif op == "rename":
        if not name or not new_name:
            return False, "Need both old and new names"
        store["categories"] = [new_name if c == name else c for c in store["categories"]]
        if new_name not in store["categories"]:
            store["categories"].append(new_name)
        for e in store["entries"]:
            if isinstance(e, dict) and e.get("category") == name:
                e["category"] = new_name
    elif op == "delete":
        if name == _LIB_DEFAULT_CATEGORY:
            return False, "Can't delete the default category"
        store["categories"] = [c for c in store["categories"] if c != name]
        if _LIB_DEFAULT_CATEGORY not in store["categories"]:
            store["categories"].insert(0, _LIB_DEFAULT_CATEGORY)
        for e in store["entries"]:
            if isinstance(e, dict) and e.get("category") == name:
                e["category"] = _LIB_DEFAULT_CATEGORY
    else:
        return False, f"Unknown op: {op}"
    _save_library(store)
    return True, "ok"


def _load_uploaded_image(annotated_name):
    """Load an image uploaded via the in-node loader into a ComfyUI IMAGE tensor.

    Mirrors ComfyUI's LoadImage behavior: resolves the annotated input path,
    applies EXIF orientation, converts to RGB and returns a (1,H,W,3) float
    tensor in 0..1.
    """
    if not annotated_name:
        return None
    try:
        import folder_paths
        import numpy as np
        import torch
        from PIL import Image, ImageOps

        path = folder_paths.get_annotated_filepath(annotated_name)
        if not path or not os.path.exists(path):
            print(f"[PromptGeneratorPro] Uploaded image not found: {annotated_name}")
            return None
        img = Image.open(path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        return torch.from_numpy(arr)[None, ]
    except Exception as e:
        print(f"[PromptGeneratorPro] Failed to load uploaded image '{annotated_name}': {e}")
        return None


def _img_dims(image):
    """(width, height) of a ComfyUI IMAGE tensor (B,H,W,C), or (0, 0) if none."""
    try:
        if image is not None and hasattr(image, "shape") and len(image.shape) >= 3:
            return int(image.shape[2]), int(image.shape[1])
    except Exception:
        pass
    return 0, 0


def _resolved_dims(cfg, image):
    """(width, height) for the node's width/height OUTPUTS — used on BOTH the normal and the
    in-node-bypass return paths so the Resolution picker always drives them. The picker's value
    wins (re-snapped per-axis to its divisor), else the pass-through image's dims, else a safe
    1024×1024 — never 0×0 (which would crash an empty-latent / KSampler downstream)."""
    try:
        rw = int(_coerce_num(cfg.get("res_width"), 0) or 0)
        rh = int(_coerce_num(cfg.get("res_height"), 0) or 0)
        if rw > 0 and rh > 0:
            rd = int(_coerce_num(cfg.get("res_divisor"), 1) or 1) or 1
            return max(rd, round(rw / rd) * rd), max(rd, round(rh / rd) * rd)
    except Exception:
        pass
    iw, ih = _img_dims(image)
    if iw > 0 and ih > 0:
        return iw, ih
    return 1024, 1024


def _coerce_bool(value, default):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _coerce_num(value, default=None):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _apply_affixes(text, cfg):
    """Wrap the EMITTED prompt with the per-node prefix/suffix (", " joined, empty parts skipped).

    Applied to the downstream 'output' on every emit path (LLM result, image render, bypass) so a
    prefix like a LoRA trigger is always present — and survives LLM refine, because the model only
    ever sees the core. The in-node Output box keeps the core (UI values are left undecorated).
    """
    prefix = str(cfg.get("prefix", "") or "").strip()
    suffix = str(cfg.get("suffix", "") or "").strip()
    core = str(text or "").strip()
    return ", ".join(p for p in (prefix, core, suffix) if p)


def _strip_affixes(text, cfg):
    """Best-effort inverse of _apply_affixes: peel a leading 'prefix, ' and trailing ', suffix' off
    `text` so the LLM refines only the core (the wrap is re-applied to the result, so it survives
    refine). A no-op when they don't match — e.g. the user changed/edited them."""
    s = str(text or "")
    prefix = str(cfg.get("prefix", "") or "").strip()
    suffix = str(cfg.get("suffix", "") or "").strip()
    if prefix and s.startswith(prefix + ", "):
        s = s[len(prefix) + 2:]
    if suffix and s.endswith(", " + suffix):
        s = s[: -(len(suffix) + 2)]
    return s


class PromptGeneratorPro(PromptGenerator):
    """Merged Prompt Generator + Options node.

    Inherits all server/generation logic from `PromptGenerator`.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xffffffffffffffff,
                    "tooltip": "Seed for reproducible generation.",
                    "control_after_generate": True,
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": "Connect an image (used by 'Analyze Image' modes). You can also load one directly in the node."
                }),
                # Single hidden JSON blob holding the whole UI state. Kept as a
                # normal serialized STRING widget so ComfyUI persists it.
                "config": ("STRING", {
                    "default": "{}",
                    "multiline": True,
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    CATEGORY = "Llama Prompt Generator"
    DESCRIPTION = "Generate or enhance prompts using a local LLM (llama.cpp or Ollama). Generator + Options merged into one node."
    RETURN_TYPES = ("STRING", "STRING", "IMAGE", "INT", "INT")
    RETURN_NAMES = ("output", "thoughts", "image", "width", "height")
    FUNCTION = "run"
    # Always execute on queue even when the outputs aren't wired anywhere (it produces a
    # UI preview, like a preview/show-text node). When 'output' IS wired into e.g. a CLIP
    # Text Encode, the generated prompt still flows downstream for a 1-click gen setup.
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, seed, **kwargs):
        return seed

    def run(self, seed: int, image=None, config="{}", unique_id=None, **kwargs):
        # Node id used to route live token-stream events to the right node UI.
        self._pg_node_id = unique_id
        try:
            cfg = json.loads(config) if config else {}
            if not isinstance(cfg, dict):
                cfg = {}
        except (ValueError, TypeError):
            cfg = {}

        # ── One-click image render from a SPECIFIC text (the Input/Output "Generate Image" buttons) ──
        # MUST be checked BEFORE bypass: the chosen text has to win even in Skip-LLM/bypass mode — otherwise
        # bypass returns the Input passthrough and the Output-box render is ignored. The JS sets _render_image
        # (+ _render_image_text) only for the duration of that queued render, so the node emits exactly the
        # Input/Output box text straight to 'output' (no LLM). pg_ran carries the text:
        # it registers the node as run (so the saved image attaches in the library) and is recorded as the
        # entry's prompt — WITHOUT a pg_output, so the in-node Output box is left untouched.
        # The text passed by the Generate-Image buttons is ALREADY wrapped (Output box renders carry
        # the wrapped output; Input renders are wrapped in the JS before queuing), so emit it as-is —
        # wrapping again here would double the prefix/suffix.
        if _coerce_bool(cfg.get("_render_image"), False):
            render_txt = str(cfg.get("_render_image_text", "") or "")
            _w, _h = _resolved_dims(cfg, image)
            return {"ui": {"pg_ran": [render_txt]}, "result": (render_txt, "", image, _w, _h)}

        # ── In-node Bypass ──
        # A custom no-op: skip the LLM entirely and pass the prompt text straight to the
        # 'output' so downstream nodes still get something, with the image passed through.
        # Unlike ComfyUI's native bypass it never touches node.mode (no purple graph), so
        # it doesn't disturb the rest of the workflow's look/behavior.
        if _coerce_bool(cfg.get("_bypass"), False):
            passthrough = _apply_affixes(str(cfg.get("prompt", "") or ""), cfg)   # wrap the input passthrough once
            _w, _h = _resolved_dims(cfg, image)   # Resolution picker still drives width/height in bypass
            return {
                "ui": {"pg_output": [passthrough], "pg_usage": [{}]},
                "result": (passthrough, "", image, _w, _h),
            }

        # ── Generator-level fields ──
        mode = cfg.get("mode", "Enhance Prompt (Text)")
        if mode not in MODE_CHOICES:
            mode = "Enhance Prompt (Text)"
        # When the dropdown is showing the Preset list, the task is driven by the preset,
        # not the (hidden) Mode selection. A plain preset → text-enhance run (no image);
        # a preset flagged "vision" → image-analysis run (consumes the in-node image),
        # using the preset text as the system prompt.
        if cfg.get("_modeView") == "presets":
            preset_vision = _coerce_bool(cfg.get("_preset_vision"), False) \
                or _is_vision_preset(str(cfg.get("override_system_prompt", "") or ""))
            mode = "Analyze Image with Prompt" if preset_vision else "Enhance Prompt (Text)"
        # Map UI label -> backend mode (keeps convert_prompt behavior identical).
        backend_mode = _MODE_BACKEND.get(mode, mode)
        prompt = str(cfg.get("prompt", "") or "")

        # If no image is wired into the socket, fall back to one loaded directly
        # in the node (the in-node loader for the Analyze Image modes).
        if image is None and mode in _VISION_MODES:
            image = _load_uploaded_image(cfg.get("image_upload", ""))

        # ── Ideogram4 Vision modes ──
        # These run the existing vision pipeline ("Analyze Image with Prompt"),
        # but with Ideogram 4's structured-caption system prompt + user prompt,
        # then post-process the model output through the tolerant JSON parser so
        # the result matches the comfyui-ideogram-autoprompter project exactly.
        # Refine: revise a prior output using the prompt as the change instruction. Strip any
        # prefix/suffix off the base first so the LLM only sees the core — the wrap is re-applied to
        # the result on the way out, so a prefix (LoRA trigger) survives every refine.
        prior_output = _strip_affixes(str(cfg.get("_refine_base", "") or ""), cfg)
        is_refine = bool(prior_output)

        is_ideogram = mode in (IDEOGRAM_STANDARD, IDEOGRAM_DETAILED)
        ideogram_density = "high" if mode == IDEOGRAM_DETAILED else "normal"
        if is_ideogram:
            backend_mode = "Analyze Image with Prompt"
            # On a fresh run, build the Ideogram user prompt; on refine, the prompt
            # is the change instruction and the prior JSON is supplied separately.
            if not is_refine:
                prompt = ideogram_user_prompt(prompt, has_image=(image is not None))


        format_as_json = _coerce_bool(cfg.get("format_as_json"), False)
        enable_thinking = _coerce_bool(cfg.get("enable_thinking"), False)
        stop_server_after = _coerce_bool(cfg.get("stop_server_after"), True)
        clear_vram_on_run = _coerce_bool(cfg.get("clear_vram_on_run"), True)

        # ── Backend (llama.cpp / ollama) — the ULTIMATE decider ──
        # The Options > LLM > Backend selector is stored per-node in config and fully
        # enforces which backend runs, overriding the global ComfyUI setting. We push
        # it into the shared cache up-front so model resolution / option building all
        # use it, and force it into the options dict below so convert_prompt obeys it.
        backend = str(cfg.get("backend", "") or "").strip().lower()
        if backend not in ("ollama", "llama.cpp"):
            backend = ""  # no per-node choice → fall back to the global setting
        if backend:
            _preferences_cache["llm_backend"] = backend

        # ── Per-node llama.cpp overrides (path + port), saved in config ──
        # Only override when provided; blank fields fall back to the global
        # ComfyUI settings / defaults the backend already uses.
        llama_path = str(cfg.get("llama_path", "") or "").strip()
        if llama_path:
            _preferences_cache["custom_llama_path"] = llama_path
        llama_port = cfg.get("llama_port")
        try:
            llama_port = int(str(llama_port).strip())
        except (TypeError, ValueError):
            llama_port = None
        if llama_port and 1 <= llama_port <= 65535:
            # SERVER_PORT lives on the base class; static methods read it from there.
            PromptGenerator.SERVER_PORT = llama_port
            _preferences_cache["custom_llama_port"] = llama_port

        # ── Per-node Ollama URL (ip + port) override, saved in config ──
        # Only when the Ollama backend is selected and a value is provided; otherwise the
        # global ComfyUI "Ollama URL" setting is used.
        ollama_url = str(cfg.get("ollama_url", "") or "").strip()
        if backend == "ollama" and ollama_url:
            _preferences_cache["ollama_url"] = ollama_url

        # ── Per-node custom model / mmproj scan directories ──
        # Register them so the selected (absolute-path) model + mmproj resolve and
        # load, and so vision-capability detection can find a matching mmproj.
        register_extra_model_dir(str(cfg.get("model_dir", "") or "").strip())
        register_extra_model_dir(str(cfg.get("mmproj_dir", "") or "").strip())

        # ── Options-level fields → reuse the original options builder ──
        context_size = cfg.get("context_size")
        try:
            context_size = int(context_size)
        except (TypeError, ValueError):
            context_size = None
        if not context_size or context_size < 512:
            context_size = get_default_context_size()

        # System-prompt presets are pure loaders: selecting one drops its text into
        # the system_prompt box, which is the single source of truth. So we never
        # let the dropdown inject a second prompt — override is always neutral here.
        opts_system_prompt = str(cfg.get("system_prompt", "") or "")
        # Default: the system-prompt box REPLACES (dominates) the mode's built-in
        # system prompt. 'append' is available for users who want to extend it.
        # 'none' (or the "(No system prompt)" preset entry) sends NO system prompt.
        opts_mode = str(cfg.get("system_prompt_mode", "replace") or "replace")
        override_sel = str(cfg.get("override_system_prompt", "") or "")
        # "Send no system prompt at all" — overrides the box whether empty or not.
        # Triggered by the "None" mode, the "none" system-prompt mode, or the sentinel preset.
        no_system_prompt = (mode == NO_MODE) or (opts_mode.lower() == "none") or (override_sel == NO_SYS_PROMPT)
        # create_options only understands replace/append; 'none' is handled via the flag.
        if opts_mode not in ("replace", "append"):
            opts_mode = "replace"
        opts_override = "(Use Generator's Prompt)"
        if is_ideogram:
            # Ideogram drives its own schema prompt (injected below).
            opts_system_prompt = ""
            format_as_json = False
        elif (not opts_system_prompt.strip() and not no_system_prompt
              and mode == "Enhance Prompt (Text)" and override_sel in ("", "(None)")):
            # Empty box on the default text mode → fall back to the Clean Cinematic
            # Enhancer preset (if present). Other modes keep their own built-in prompt.
            _default_text = _read_preset_text(_DEFAULT_PRESET)
            if _default_text.strip():
                opts_system_prompt = _default_text
                opts_mode = "replace"

        opts_node = PromptGenOptions()
        (options,) = opts_node.create_options(
            model=cfg.get("model"),
            mmproj=cfg.get("mmproj", "auto"),
            image2=None,
            image3=None,
            image4=None,
            image5=None,
            system_prompt=opts_system_prompt,
            system_prompt_mode=opts_mode,
            # The UI no longer has a "use model defaults" toggle — the sampling sliders
            # (with a Reset-to-defaults button) are always authoritative.
            use_model_default_sampling=False,
            temperature=_coerce_num(cfg.get("temperature")),
            top_k=int(_coerce_num(cfg.get("top_k"), 0) or 0),
            top_p=_coerce_num(cfg.get("top_p")),
            min_p=_coerce_num(cfg.get("min_p")),
            repeat_penalty=_coerce_num(cfg.get("repeat_penalty")),
            presence_penalty=_coerce_num(cfg.get("presence_penalty")),
            context_size=context_size,
            extra_launch_args=str(cfg.get("extra_launch_args", "") or ""),
            show_everything_in_console=_coerce_bool(cfg.get("show_everything_in_console"), False),
            override_system_prompt=opts_override,
        )

        # Enforce the per-node backend on the options so convert_prompt uses exactly
        # this backend regardless of the global setting or any stale value.
        if backend:
            options["llm_backend"] = backend

        # Per-node generation request timeout (seconds), shared by both backends.
        options["request_timeout"] = normalize_timeout(cfg.get("request_timeout"))

        # "No system prompt" — drop the system message entirely (never for Ideogram,
        # which depends on its own schema prompt).
        options["no_system_prompt"] = bool(no_system_prompt) and not is_ideogram

        # Inject Ideogram's structured-caption schema as the system prompt.
        if is_ideogram:
            options["override_system_prompt_text"] = ideogram_system_prompt(ideogram_density)

        # ── Run generation with the inherited pipeline ──
        _gen_t0 = time.time()
        result = self.convert_prompt(
            seed,
            mode=backend_mode,
            prompt=prompt,
            image=image,
            format_as_json=format_as_json,
            enable_thinking=enable_thinking,
            stop_server_after=stop_server_after,
            clear_vram_on_run=clear_vram_on_run,
            options=options,
            prior_output=(prior_output or None),
        )
        _gen_secs = time.time() - _gen_t0

        output, thoughts = (result + ("",))[:2] if isinstance(result, tuple) else (str(result), "")

        # Post-process Ideogram output: normalize the model's JSON exactly like the
        # source project (tolerant of fences / truncation). On failure, fall back to
        # the raw model text so the user still gets output instead of a hard error.
        if is_ideogram:
            try:
                output = json.dumps(ideogram_parse_caption(output), indent=2, ensure_ascii=False)
            except ValueError as e:
                print(f"[PromptGeneratorPro] Ideogram caption parse failed: {e}")

        # Return output + token usage to the node UI (preview box + token meter), pass the
        # resolved image through (e.g. Resolution Master), and expose its width/height.
        usage = getattr(self, "_pg_last_usage", None) or {}
        try:
            usage = dict(usage)
            usage["gen_time"] = round(_gen_secs, 2)   # seconds the LLM took — shown in the UI as "Time to Generate"
        except Exception:
            pass
        _w, _h = _resolved_dims(cfg, image)   # Resolution picker (re-snapped) → width/height outputs
        output = _apply_affixes(output, cfg)   # wrap once: the Output box AND downstream both carry the final prompt
        return {
            "ui": {"pg_output": [output], "pg_usage": [usage]},
            "result": (output, thoughts, image, _w, _h),
        }


# --- API route: feed the JS UI with the current model / mmproj / override lists ---
try:
    import server as _pgp_server
    import asyncio as _pg_asyncio
    from collections import OrderedDict as _PgOrderedDict

    # ── In-memory thumbnail cache ──────────────────────────────────────────────
    # Resize source images to small webp previews, cached in RAM (no disk files), with the PIL
    # work run in a thread executor so encoding never blocks ComfyUI's single event loop. This is
    # what the Prompts grid/preview thumbnails use (full resolution is kept only for the lightbox).
    _THUMB_CACHE = _PgOrderedDict()   # key (filepath, mtime, size) -> webp bytes
    _THUMB_CACHE_CAP = 400

    def _thumb_make(filepath, size):
        try:
            from PIL import Image, ImageOps
            import io
            with Image.open(filepath) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((size, size))   # default resample; good for thumbnails
                buf = io.BytesIO()
                im.save(buf, format="webp", quality=80)
                return buf.getvalue()
        except Exception:
            return None

    @_pgp_server.PromptServer.instance.routes.get("/prompt-generator/thumb")
    async def _thumb(request):
        from aiohttp import web
        try:
            q = request.rel_url.query
            filename = q.get("filename", "") or ""
            subfolder = q.get("subfolder", "") or ""
            if not filename or ".." in filename or ".." in subfolder:
                return web.Response(status=400, text="bad request")
            ftype = q.get("type", "output") or "output"
            try:
                size = max(64, min(640, int(q.get("size", "320"))))
            except Exception:
                size = 320
            import folder_paths
            base = folder_paths.get_directory_by_type(ftype)
            if not base:
                return web.Response(status=400, text="bad type")
            base = os.path.abspath(base)
            target_dir = os.path.abspath(os.path.join(base, subfolder)) if subfolder else base
            # Reject anything resolving outside the type's base directory (no path traversal).
            if os.path.commonpath([target_dir, base]) != base:
                return web.Response(status=403, text="forbidden")
            filepath = os.path.join(target_dir, os.path.basename(filename))
            if not os.path.isfile(filepath):
                return web.Response(status=404, text="not found")
            key = (filepath, os.path.getmtime(filepath), size)
            data = _THUMB_CACHE.get(key)
            if data is not None:
                _THUMB_CACHE.move_to_end(key)
            else:
                data = await _pg_asyncio.get_event_loop().run_in_executor(None, _thumb_make, filepath, size)
                if data is None:
                    return web.Response(status=500, text="thumb failed")
                _THUMB_CACHE[key] = data
                _THUMB_CACHE.move_to_end(key)
                while len(_THUMB_CACHE) > _THUMB_CACHE_CAP:
                    _THUMB_CACHE.popitem(last=False)
            return web.Response(body=data, content_type="image/webp", headers={"Cache-Control": "max-age=3600"})
        except Exception as e:
            return web.Response(status=500, text=str(e))

    def _scan_gguf(folder, want_mmproj):
        """Scan a folder recursively for .gguf files, returning ABSOLUTE paths.
        want_mmproj=True returns only mmproj projector files; False excludes them."""
        import glob
        out = []
        if not folder or not os.path.isdir(folder):
            return out
        for f in glob.glob(os.path.join(folder, "**", "*.gguf"), recursive=True):
            is_mmproj = "mmproj" in os.path.basename(f).lower()
            if want_mmproj == is_mmproj:
                out.append(os.path.normpath(f))
        return sorted(out)

    @_pgp_server.PromptServer.instance.routes.get("/prompt-generator/options-data")
    async def _options_data(request):
        from aiohttp import web
        try:
            # The node passes its own (authoritative) backend so the dropdowns reflect
            # exactly what it will run. Persist it so the rest of the cache agrees.
            req_backend = (request.rel_url.query.get("backend", "") or "").strip().lower()
            if req_backend in ("ollama", "llama.cpp"):
                _preferences_cache["llm_backend"] = req_backend
                backend = req_backend
            else:
                backend = _preferences_cache.get("llm_backend", "llama.cpp")
            # Optional per-node custom scan roots for the model / mmproj dropdowns.
            model_dir = (request.rel_url.query.get("model_dir", "") or "").strip()
            mmproj_dir = (request.rel_url.query.get("mmproj_dir", "") or "").strip()
            # Register so the model also loads/resolves from these dirs at run time.
            if model_dir:
                register_extra_model_dir(model_dir)
            if mmproj_dir:
                register_extra_model_dir(mmproj_dir)

            if backend == "ollama":
                cfg = dict(_preferences_cache)
                oll_url = (request.rel_url.query.get("ollama_url", "") or "").strip()
                if oll_url:
                    cfg["ollama_url"] = oll_url
                models, _status = discover_ollama_models(cfg)
                if not models:
                    # Distinguish "server down" from "running but no models pulled" so a
                    # killed Ollama doesn't keep showing a stale/misleading model list.
                    from ..py.ollama_wrapper import is_ollama_available
                    if is_ollama_available(cfg):
                        models = ["No Ollama models found - run 'ollama pull <model>'"]
                    else:
                        models = ["Ollama not running — press Serve"]
            elif model_dir and os.path.isdir(model_dir):
                models = _scan_gguf(model_dir, want_mmproj=False)
                if not models:
                    models = ["No .gguf models found in that folder"]
            else:
                models = get_all_models()
                if not models:
                    models = ["No models found - check HuggingFace"]

            if mmproj_dir and os.path.isdir(mmproj_dir):
                mmproj = ["None", "auto"] + _scan_gguf(mmproj_dir, want_mmproj=True)
            else:
                mmproj = ["None", "auto"] + get_local_mmproj_files()

            preferred_model = str(_preferences_cache.get("preferred_model", "") or "").strip()
            default_model = preferred_model if (preferred_model and preferred_model in models) else (models[0] if models else "")

            return web.json_response({
                "backend": backend,
                "models": models,
                "default_model": default_model,
                "mmproj": mmproj,
                "override_system_prompt": _system_prompt_override_choices(),
                "default_context_size": get_default_context_size(),
                "modes": MODE_CHOICES,
            })
        except Exception as e:
            return web.json_response({"error": str(e), "models": [], "mmproj": ["None", "auto"],
                                      "override_system_prompt": ["(Use Generator's Prompt)"]}, status=200)

    # ── System-prompt preset management ──
    @_pgp_server.PromptServer.instance.routes.get("/prompt-generator/system-prompts")
    async def _list_system_prompts(request):
        from aiohttp import web
        try:
            return web.json_response({"presets": _list_all_presets()})
        except Exception as e:
            return web.json_response({"presets": [], "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/save-system-prompt")
    async def _save_system_prompt(request):
        from aiohttp import web
        try:
            data = await request.json()
            name = _safe_preset_name(data.get("name", ""))
            text = str(data.get("text", "") or "")
            vision = _coerce_bool(data.get("vision"), False)
            if not name:
                return web.json_response({"ok": False, "error": "Invalid preset name"})
            os.makedirs(_PRESETS_DIR, exist_ok=True)
            path = os.path.join(_PRESETS_DIR, name + ".txt")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            _set_preset_meta(name, vision)   # record type in the metadata index (not the .txt)
            return web.json_response({"ok": True, "name": name, "path": os.path.normpath(path), "vision": vision})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/delete-system-prompt")
    async def _delete_system_prompt(request):
        from aiohttp import web
        try:
            data = await request.json()
            name = _safe_preset_name(data.get("name", ""))
            if not name:
                return web.json_response({"ok": False, "error": "Invalid preset name"})
            path = os.path.join(_PRESETS_DIR, name + ".txt")
            # Only file-based presets (inside the presets dir) can be deleted.
            if not os.path.isfile(path):
                return web.json_response({"ok": False, "error": "Preset file not found (built-in presets can't be deleted)"})
            os.remove(path)
            # Drop its metadata entry too so the index doesn't accumulate stale names.
            meta = _load_presets_meta()
            if name in meta:
                meta.pop(name, None)
                _save_presets_meta(meta)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    # ── Prompt Library (curated saved prompts) ──
    @_pgp_server.PromptServer.instance.routes.get("/prompt-generator/library")
    async def _library_get(request):
        from aiohttp import web
        try:
            return web.json_response(_load_library())
        except Exception as e:
            return web.json_response({"categories": [_LIB_DEFAULT_CATEGORY], "entries": [], "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/library/save")
    async def _library_save(request):
        from aiohttp import web
        try:
            data = await request.json()
            if not str(data.get("text", "") or "").strip():
                return web.json_response({"ok": False, "error": "Empty prompt text"})
            entry = _lib_save_entry(data)
            return web.json_response({"ok": True, "entry": entry})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/library/delete")
    async def _library_delete(request):
        from aiohttp import web
        try:
            data = await request.json()
            ok = _lib_delete_entry(data.get("id", ""))
            return web.json_response({"ok": bool(ok)})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/library/category")
    async def _library_category(request):
        from aiohttp import web
        try:
            data = await request.json()
            ok, msg = _lib_category_op(
                str(data.get("op", "") or "").strip().lower(),
                data.get("name", ""),
                data.get("new_name", ""),
            )
            return web.json_response({"ok": bool(ok), "message": msg, "library": _load_library()})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    # ── LLM server status / unload / connection test ──
    @_pgp_server.PromptServer.instance.routes.get("/prompt-generator/server-status")
    async def _server_status(request):
        from aiohttp import web
        # The node passes its OWN backend (and Ollama URL) so the status reflects what that node will
        # actually run, not the global setting. Read params on the loop (cheap), then run the BLOCKING
        # probe (an HTTP /health hit or Ollama reachability — up to a timeout) in a THREAD. Doing it
        # inline used to stall the whole ComfyUI asyncio loop (websocket + queue dispatch) for the
        # timeout whenever the backend was down — the periodic ~2s UI freeze during batches.
        req_backend = (request.rel_url.query.get("backend", "") or "").strip().lower()
        backend = req_backend if req_backend in ("ollama", "llama.cpp") else _preferences_cache.get("llm_backend", "llama.cpp")
        ollama_url = (request.rel_url.query.get("ollama_url", "") or "").strip()
        req_path = (request.rel_url.query.get("llama_path", "") or "").strip()

        def _probe():
            import shutil
            try:
                if backend == "ollama":
                    from ..py.ollama_wrapper import is_ollama_available
                    cfg = dict(_preferences_cache)
                    if ollama_url:
                        cfg["ollama_url"] = ollama_url
                    running = bool(is_ollama_available(cfg))
                    found = running or (shutil.which("ollama") is not None)
                    return {"backend": "ollama", "running": running, "found": found}
                # llama.cpp: running = server alive; found = the llama-server exe can be located.
                running = bool(PromptGenerator.is_server_alive())
                exe = "llama-server.exe" if os.name == "nt" else "llama-server"
                custom = os.path.normpath(req_path or _preferences_cache.get("custom_llama_path", "") or "")
                found = running or bool(
                    (custom and os.path.isfile(custom)) or
                    (custom and os.path.isdir(custom) and os.path.isfile(os.path.join(custom, exe))) or
                    shutil.which(exe)
                )
                return {"backend": "llama.cpp", "running": running, "found": found}
            except Exception as e:
                return {"backend": "?", "running": False, "found": False, "error": str(e)}

        result = await _pg_asyncio.get_event_loop().run_in_executor(None, _probe)
        return web.json_response(result)

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/unload")
    async def _unload(request):
        from aiohttp import web
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}
            req_backend = str(data.get("backend", "") or "").strip().lower()
            backend = req_backend if req_backend in ("ollama", "llama.cpp") else _preferences_cache.get("llm_backend", "llama.cpp")
            if backend == "ollama":
                from ..py.ollama_wrapper import unload_model as _ollama_unload
                model = str(data.get("model", "") or "").strip()
                if not model:
                    return web.json_response({"ok": False, "error": "No Ollama model selected to unload."})
                cfg = dict(_preferences_cache)
                url = str(data.get("ollama_url", "") or "").strip()
                if url:
                    cfg["ollama_url"] = url
                ok, msg = _ollama_unload(cfg, model)
                return web.json_response({"ok": bool(ok), "message": msg})
            # llama.cpp: stop the local server (frees VRAM).
            PromptGenerator.stop_server()
            return web.json_response({"ok": True, "message": "llama-server stopped."})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/refine")
    async def _refine(request):
        """Revise a previous output using an instruction, reusing the full pipeline
        (same model / sampling / system prompt / backend). Returns the revised text
        directly (does not go through the graph)."""
        from aiohttp import web
        import asyncio
        try:
            data = await request.json()
            cfg = dict(data.get("config") or {})
            cfg["_refine_base"] = str(data.get("prior_output", "") or "")
            cfg["prompt"] = str(data.get("instruction", "") or "")
            try:
                seed = int(data.get("seed") or 0)
            except (TypeError, ValueError):
                seed = 0
            if not cfg["_refine_base"].strip():
                return web.json_response({"ok": False, "error": "Nothing to refine yet — run once first."})
            if not cfg["prompt"].strip():
                return web.json_response({"ok": False, "error": "Type a change instruction in the prompt box."})
            node_id = data.get("node_id")

            def _go():
                node = PromptGeneratorPro()
                res = node.run(seed=seed, image=None, config=json.dumps(cfg), unique_id=node_id)
                if isinstance(res, dict):
                    return (res.get("result") or ("",))[0]
                if isinstance(res, tuple):
                    return res[0]
                return str(res)

            loop = asyncio.get_event_loop()
            out = await loop.run_in_executor(None, _go)
            return web.json_response({"ok": True, "output": out})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/generate")
    async def _generate(request):
        """Run the LLM once with the node's current settings, OUT of the graph, so the
        user can craft prompts without queuing the whole workflow. Streams live tokens to
        the originating node (node_id) and returns the final text. Uses the in-node loaded
        image for vision modes (a socket-wired image is only available during a graph run)."""
        from aiohttp import web
        import asyncio
        try:
            data = await request.json()
            cfg = dict(data.get("config") or {})
            cfg.pop("_refine_base", None)  # ensure a fresh generation, not a refine
            try:
                seed = int(data.get("seed") or 0)
            except (TypeError, ValueError):
                seed = 0
            node_id = data.get("node_id")

            def _go():
                node = PromptGeneratorPro()
                res = node.run(seed=seed, image=None, config=json.dumps(cfg), unique_id=node_id)
                if isinstance(res, dict):
                    return (res.get("result") or ("",))[0]
                if isinstance(res, tuple):
                    return res[0]
                return str(res)

            loop = asyncio.get_event_loop()
            out = await loop.run_in_executor(None, _go)
            return web.json_response({"ok": True, "output": out})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.get("/prompt-generator/test-backend")
    async def _test_backend(request):
        from aiohttp import web
        import shutil
        try:
            req_backend = (request.rel_url.query.get("backend", "") or "").strip().lower()
            backend = req_backend if req_backend in ("ollama", "llama.cpp") else _preferences_cache.get("llm_backend", "llama.cpp")
            if backend == "ollama":
                from ..py.ollama_wrapper import discover_ollama_models
                cfg = dict(_preferences_cache)
                url = (request.rel_url.query.get("ollama_url", "") or "").strip()
                if url:
                    cfg["ollama_url"] = url
                models, status = discover_ollama_models(cfg)
                return web.json_response({"ok": bool(models), "message": status})
            # llama.cpp: verify the llama-server executable can be located. Prefer the
            # node's own Llama-Server Path (passed as ?llama_path=) over the global cache,
            # so Test reflects exactly what's typed in the field — even before any run.
            exe = "llama-server.exe" if os.name == "nt" else "llama-server"
            req_path = (request.rel_url.query.get("llama_path", "") or "").strip()
            custom = os.path.normpath(req_path or _preferences_cache.get("custom_llama_path", "") or "")
            if custom and os.path.isfile(custom):
                return web.json_response({"ok": True, "message": f"Found: {custom}"})
            if custom and os.path.isdir(custom) and os.path.isfile(os.path.join(custom, exe)):
                return web.json_response({"ok": True, "message": f"Found: {os.path.join(custom, exe)}"})
            # A path was typed but nothing's there → say so explicitly.
            if custom:
                return web.json_response({"ok": False, "message": f"Not found at the set path: {custom}"})
            found = shutil.which(exe)
            if found:
                return web.json_response({"ok": True, "message": f"Found on PATH: {found}"})
            return web.json_response({"ok": False, "message": f"'{exe}' not found — set the Llama-Server Path or add it to PATH."})
        except Exception as e:
            return web.json_response({"ok": False, "message": str(e)})

    @_pgp_server.PromptServer.instance.routes.get("/prompt-generator/ollama-model-info")
    async def _ollama_model_info(request):
        """Report whether a given Ollama model supports vision (via /api/show)."""
        from aiohttp import web
        try:
            model = (request.rel_url.query.get("model", "") or "").strip()
            if not model:
                return web.json_response({"model": "", "vision": False})
            from ..py.ollama_wrapper import model_has_vision
            cfg = dict(_preferences_cache)
            url = (request.rel_url.query.get("ollama_url", "") or "").strip()
            if url:
                cfg["ollama_url"] = url
            return web.json_response({"model": model, "vision": bool(model_has_vision(cfg, model))})
        except Exception as e:
            return web.json_response({"model": "", "vision": False, "error": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/ollama-pull")
    async def _ollama_pull(request):
        """Download a model into Ollama (blocks until done). Runs the blocking pull in a
        thread so the event loop stays free."""
        from aiohttp import web
        import asyncio
        try:
            data = await request.json()
            model = str(data.get("model", "") or "").strip()
            if not model:
                return web.json_response({"ok": False, "message": "Type a model name to pull."})
            from ..py.ollama_wrapper import pull_model
            cfg = dict(_preferences_cache)
            url = str(data.get("ollama_url", "") or "").strip()
            if url:
                cfg["ollama_url"] = url
            loop = asyncio.get_event_loop()
            ok, msg = await loop.run_in_executor(None, pull_model, cfg, model)
            return web.json_response({"ok": bool(ok), "message": msg})
        except Exception as e:
            return web.json_response({"ok": False, "message": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/ollama-serve")
    async def _ollama_serve(request):
        """Launch `ollama serve` (background). Blocks briefly until it's reachable."""
        from aiohttp import web
        import asyncio
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}
            from ..py.ollama_wrapper import serve_ollama
            cfg = dict(_preferences_cache)
            url = str(data.get("ollama_url", "") or "").strip()
            if url:
                cfg["ollama_url"] = url
            loop = asyncio.get_event_loop()
            ok, msg = await loop.run_in_executor(None, serve_ollama, cfg)
            return web.json_response({"ok": bool(ok), "message": msg})
        except Exception as e:
            return web.json_response({"ok": False, "message": str(e)})

    @_pgp_server.PromptServer.instance.routes.post("/prompt-generator/ollama-kill")
    async def _ollama_kill(request):
        """Terminate the Ollama server process(es)."""
        from aiohttp import web
        import asyncio
        try:
            from ..py.ollama_wrapper import kill_ollama
            loop = asyncio.get_event_loop()
            ok, msg = await loop.run_in_executor(None, kill_ollama)
            return web.json_response({"ok": bool(ok), "message": msg})
        except Exception as e:
            return web.json_response({"ok": False, "message": str(e)})

except Exception as _e:
    print(f"[PromptGeneratorPro] Could not register options-data route: {_e}")


NODE_CLASS_MAPPINGS = {
    "PromptGeneratorPro": PromptGeneratorPro,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptGeneratorPro": "Llama | Prompt Generator",
}
