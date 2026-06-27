"""
Utility functions for managing llama.cpp models
"""
import os
import glob
import re
import folder_paths
import server
from huggingface_hub import HfApi
from tqdm.auto import tqdm
import requests

# Add preference cache and API endpoints for preferences
_preferences_cache = {
    "preferred_model": "",
    "custom_llama_path": "",            # blank = use system PATH (or set per-node)
    "custom_llama_model_path": "",      # blank = models/gguf (or set per-node Model Directory)
    "close_llama_on_exit": True,
    "custom_llama_port": 8080,          # llama-server default (per-node field can override)
    "custom_llama_args": "",            # extra llama-server launch args (override defaults)
    "llm_backend": "llama.cpp",        # "llama.cpp" or "ollama"
    "ollama_url": "http://127.0.0.1:11434",
    "ollama_keep_alive": "5m",           # How long Ollama keeps model loaded after request
}

# Predefined models - use real filenames as keys
# Qwen3.5 models are unified vision+text — every model supports vision via its mmproj.
# "mmproj" is the LOCAL filename we store on disk.
# "mmproj_repo_filename" is the filename in the HuggingFace repo (may differ).
QWEN_MODELS = {
    "Qwen3.5-9B-UD-Q4_K_XL.gguf": {
        "repo": "unsloth/Qwen3.5-9B-GGUF",
        "mmproj": "mmproj-Qwen3.5-9B-F16.gguf",
        "mmproj_repo_filename": "mmproj-F16.gguf"
    },
    "Qwen3.5-9B-Q8_0.gguf": {
        "repo": "unsloth/Qwen3.5-9B-GGUF",
        "mmproj": "mmproj-Qwen3.5-9B-F16.gguf",
        "mmproj_repo_filename": "mmproj-F16.gguf"
    },
    "Qwen3.5-9B-UD-Q8_K_XL.gguf": {
        "repo": "unsloth/Qwen3.5-9B-GGUF",
        "mmproj": "mmproj-Qwen3.5-9B-F16.gguf",
        "mmproj_repo_filename": "mmproj-F16.gguf"
    },
}

@server.PromptServer.instance.routes.get("/prompt-manager/load-preferences")
async def load_preferences(request):
    """API endpoint to get cached preferences (set from ComfyUI settings)"""
    return server.web.json_response(_preferences_cache)


@server.PromptServer.instance.routes.post("/prompt-manager/save-preference")
async def save_preference(request):
    """API endpoint to update preference cache when settings change"""
    try:
        data = await request.json()
        key = data.get("key")
        value = data.get("value", "")

        if key not in ["preferred_model",
                       "custom_llama_path",
                       "custom_llama_model_path",
                       "close_llama_on_exit",
                       "custom_llama_port",
                       "custom_llama_args",
                       "llm_backend",
                       "ollama_url",
                       "ollama_keep_alive"]:
            return server.web.json_response({"success": False, "error": "Invalid preference key"})

        # Update in-memory cache
        _preferences_cache[key] = value

        return server.web.json_response({"success": True, "preferences": _preferences_cache})
    except Exception as e:
        print(f"[Model Manager] Error saving preference: {e}")
        return server.web.json_response({"success": False, "error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/prompt-manager/ollama-models")
async def list_ollama_models(request):
    """API endpoint to discover available Ollama models."""
    try:
        from .ollama_wrapper import discover_ollama_models
        models, status = discover_ollama_models(_preferences_cache)
        return server.web.json_response({"models": models, "status": status})
    except Exception as e:
        return server.web.json_response({"models": [], "status": f"Error: {e}"}, status=500)


def get_default_context_size():
    """Return a context size scaled to the active GPU's total VRAM.

    Tiers:
        >= 24 GB  →  8192
        >= 16 GB  →  4096
         < 16 GB →   2048
        No GPU / unknown → 4096 (safe CPU default)

    Note:
        This uses GPU capacity (total VRAM), not current free/available VRAM.
    """
    try:
        import importlib
        torch = importlib.import_module("torch")
        if torch.cuda.is_available():
            try:
                device_index = torch.cuda.current_device()
            except Exception:
                device_index = 0

            total_vram_gb = torch.cuda.get_device_properties(device_index).total_memory / (1024 ** 3)
            if total_vram_gb >= 24:
                return 8192
            elif total_vram_gb >= 16:
                return 4096
            else:
                return 2048
    except Exception:
        pass
    return 4096  # CPU or VRAM detection failed


def get_models_directory():
    """Get the path to the primary models directory (ComfyUI/models/gguf) for downloads"""
    # Register both gguf and LLM folders
    if "gguf" not in folder_paths.folder_names_and_paths:
        gguf_dir = os.path.join(folder_paths.models_dir, "gguf")
        folder_paths.add_model_folder_path("gguf", gguf_dir)

    if "LLM" not in folder_paths.folder_names_and_paths:
        llm_dir = os.path.join(folder_paths.models_dir, "LLM")
        folder_paths.add_model_folder_path("LLM", llm_dir)

    custom_llama_model_path = _preferences_cache.get("custom_llama_model_path", "")

    if custom_llama_model_path and os.path.isdir(custom_llama_model_path):
        # Add custom path if not already present
        if "CustomLLM" not in folder_paths.folder_names_and_paths:
            folder_paths.add_model_folder_path("CustomLLM", custom_llama_model_path)
        models_dir = custom_llama_model_path
    else:
        models_dir = folder_paths.get_folder_paths("gguf")[0]
        os.makedirs(models_dir, exist_ok=True)  # Create directory if it doesn't exist

    return models_dir

# Session-registered extra scan dirs (set per-node via the merged node's
# "Model Directory" fields). Included in all model lookups so models/mmproj
# placed in custom folders resolve and load correctly.
_extra_model_dirs = []


def register_extra_model_dir(path):
    """Register an additional directory to scan for models/mmproj. Returns True if added/known."""
    if not path:
        return False
    try:
        p = os.path.normpath(path)
    except Exception:
        return False
    if not os.path.isdir(p):
        return False
    if p not in _extra_model_dirs:
        _extra_model_dirs.append(p)
    return True


def get_all_model_directories():
    """Get all directories where models can be found"""
    get_models_directory()  # Ensure folders are registered

    directories = []
    for folder_type in ["gguf", "LLM", "CustomLLM"]:
        if folder_type in folder_paths.folder_names_and_paths:
            dirs = folder_paths.get_folder_paths(folder_type)
            directories.extend(dirs)

    # Append session-registered custom dirs (dedup, preserve order).
    for d in _extra_model_dirs:
        if d not in directories:
            directories.append(d)

    return directories

def get_local_models():
    """Get list of local .gguf model files from all model directories.

    Recurses into subfolders. Files inside a subdirectory are returned as a
    path RELATIVE to their model directory (forward-slash separated), e.g.
    'qwen/Qwen3.5-9B-Q8_0.gguf'. The relative path is still a valid identifier
    because get_model_path()/is_model_local() join it back onto the model dir.
    """
    all_dirs = get_all_model_directories()

    all_models = set()  # Use set to avoid duplicates
    for models_dir in all_dirs:
        if os.path.exists(models_dir):
            gguf_files = glob.glob(os.path.join(models_dir, "**", "*.gguf"), recursive=True)
            for f in gguf_files:
                # Filter out mmproj files (matched separately for vision support)
                if 'mmproj' in os.path.basename(f).lower():
                    continue
                rel = os.path.relpath(f, models_dir).replace(os.sep, "/")
                all_models.add(rel)

    # Return sorted list of unique (relative) filenames
    return sorted(list(all_models))

def get_local_mmproj_files():
    """List local mmproj .gguf files from all model directories (recursively).

    Returns paths relative to each model directory (forward-slash separated),
    same convention as get_local_models(). Used to populate the mmproj dropdown.
    """
    all_dirs = get_all_model_directories()

    found = set()
    for models_dir in all_dirs:
        if not os.path.exists(models_dir):
            continue
        for f in glob.glob(os.path.join(models_dir, "**", "*.gguf"), recursive=True):
            if 'mmproj' in os.path.basename(f).lower():
                rel = os.path.relpath(f, models_dir).replace(os.sep, "/")
                found.add(rel)

    return sorted(found)

def resolve_mmproj_choice(choice):
    """Resolve an explicit mmproj dropdown choice to a full path.

    `choice` is a relative path as returned by get_local_mmproj_files()
    (e.g. 'vision/MyModel.mmproj-F16.gguf'). Returns the absolute path if the
    file exists in any model directory, otherwise None. 'auto'/'' returns None
    so the caller falls back to automatic detection.
    """
    if not choice or choice == "auto":
        return None
    # A browsed absolute path resolves directly.
    if os.path.isabs(choice) and os.path.isfile(choice):
        return choice
    for d in get_all_model_directories():
        p = os.path.join(d, choice)
        if os.path.exists(p):
            return p
    return None

def get_all_models():
    """Get combined list of local and HuggingFace models, excluding already downloaded ones and mmproj files"""
    local_models = get_local_models()  # Already filtered
    models_dir   = get_models_directory()

    # List all known filenames, local ones first
    all_models = []
    # Add local models first (already filtered by get_local_models)
    if local_models:
        all_models.extend(local_models)
    # Add remote models (not present locally), excluding mmproj files
    for filename in QWEN_MODELS.keys():
        if filename not in all_models and 'mmproj' not in filename.lower():
            all_models.append(filename)
    return all_models

def is_model_local(model_name):
    """Check if a model exists locally in any of the model directories"""
    if model_name == "--- Download from HuggingFace ---":
        return False

    # An absolute path (e.g. from Custom Model Path / preferred_model) resolves directly.
    if os.path.isabs(model_name) and os.path.isfile(model_name):
        return True

    all_dirs = get_all_model_directories()
    for models_dir in all_dirs:
        model_path = os.path.join(models_dir, model_name)
        if os.path.exists(model_path):
            return True

    return False

def get_model_path(model_name):
    """Get the full path to a model file, searching all model directories"""
    # A browsed absolute path resolves directly, no directory search needed.
    if os.path.isabs(model_name) and os.path.isfile(model_name):
        return model_name

    all_dirs = get_all_model_directories()

    # Check each directory for the model
    for models_dir in all_dirs:
        model_path = os.path.join(models_dir, model_name)
        if os.path.exists(model_path):
            return model_path

    # If not found, return path in primary directory (gguf)
    models_dir = get_models_directory()
    return os.path.join(models_dir, model_name)

# Quantization-related filename parts — stripped when matching models to mmproj files
_QUANT_PARTS = frozenset({
    "Q2", "Q3", "Q4", "Q5", "Q6", "Q8",
    "K", "M", "S", "L", "XS", "XL", "XXS", "XXL",
    "IQ1", "IQ2", "IQ3", "IQ4", "NL",
    "BF16", "F16", "F32",
    "0", "1", "UD",
})


def _get_model_keywords(name):
    """Extract normalised keyword set from a model filename for fuzzy matching.

    Splits on hyphens, underscores, dots, and spaces, lowercases everything,
    and strips quantisation tags + the literal 'mmproj' token.

    Example: 'qwen3.5-9b-nsfw-captioning-v3.Q8_0.gguf'
             → {'qwen3.5', '9b', 'nsfw', 'captioning', 'v3'}
             'qwen3.5-9b-nsfw-captioning-v3.mmproj-Q8_0.gguf'
             → {'qwen3.5', '9b', 'nsfw', 'captioning', 'v3'}
    """
    base = os.path.splitext(os.path.basename(name))[0]
    # First split on hyphens, underscores, spaces (not dots)
    raw_parts = [p for p in re.split(r"[-_ ]", base) if p]
    # Then split tokens on dots, UNLESS the token is a version string like 'qwen3.5'
    parts = []
    for token in raw_parts:
        if re.match(r'^[a-zA-Z]+\d+\.\d+$', token):
            # Version string (e.g. 'qwen3.5') — keep intact
            parts.append(token)
        elif '.' in token:
            # Split other dotted tokens (e.g. 'v3.Q8' → 'v3', 'Q8')
            parts.extend(p for p in token.split('.') if p)
        else:
            parts.append(token)
    lc_quant = {q.lower() for q in _QUANT_PARTS}
    return {p.lower() for p in parts if p.lower() not in lc_quant and p.lower() != "mmproj" and p.lower() != "gguf"}


def get_mmproj_for_model(model_name):
    """Get the mmproj filename for a given model from the predefined registry."""
    if model_name in QWEN_MODELS and "mmproj" in QWEN_MODELS[model_name]:
        return QWEN_MODELS[model_name]["mmproj"]
    return None


def get_mmproj_path(model_name):
    """Get the path to the mmproj file for a model, if it exists.

    1. Check the explicit QWEN_MODELS mapping first.
    2. Fall back to heuristic matching by model identity (strips quant parts).
    """
    # --- 1. Explicit mapping ---
    mmproj_name = get_mmproj_for_model(model_name)
    if mmproj_name:
        all_dirs = get_all_model_directories()
        for d in all_dirs:
            matches = glob.glob(os.path.join(d, "**", mmproj_name), recursive=True)
            if matches:
                return matches[0]
        # Mapped but file not found on disk
        return None

    # --- 2. Any mmproj file on disk ---
    # A '.gguf' file with 'mmproj' in its name is treated as the projector.
    # If several exist, prefer the one sharing the most keywords with the model;
    # otherwise the single one found is used as-is.
    model_keywords = _get_model_keywords(model_name)

    all_dirs = get_all_model_directories()
    candidates = []
    for models_dir in all_dirs:
        if not os.path.exists(models_dir):
            continue
        for path in glob.glob(os.path.join(models_dir, "**", "*.gguf"), recursive=True):
            if 'mmproj' in os.path.basename(path).lower():
                candidates.append(path)

    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    # Multiple mmproj files: pick the best keyword overlap (first found wins ties)
    best_match = candidates[0]
    best_match_count = -1
    for path in candidates:
        common = model_keywords & _get_model_keywords(os.path.basename(path))
        if len(common) > best_match_count:
            best_match = path
            best_match_count = len(common)

    return best_match


def has_vision_support(model_name):
    """Check whether a model has vision capabilities.

    Returns True if an mmproj file is available (on disk or in the registry).
    """
    # Check explicit registry first (even if not yet downloaded)
    if get_mmproj_for_model(model_name):
        return True
    # Check if a matching mmproj file already exists on disk
    return get_mmproj_path(model_name) is not None

def download_model(model_name):
    """Download a model from HuggingFace with automatic progress display.
    Also downloads the matching mmproj file if one is defined.

    The mmproj file in the repo may have a generic name (e.g. 'mmproj-F16.gguf').
    We rename it on download to a model-specific name to avoid conflicts when
    multiple model sizes are installed side-by-side.

    Args:
        model_name: Filename of the model (e.g., 'Qwen3.5-9B-Q8_0.gguf')

    Returns:
        Path to downloaded model or None on error
    """
    if model_name not in QWEN_MODELS:
        print(f"[Model Manager] Error: Unknown model: {model_name}")
        return None

    model_info = QWEN_MODELS[model_name]
    repo_id = model_info["repo"]
    models_dir = get_models_directory()

    # Build list of files to download
    # Each entry: repo_filename (name in the HF repo), local_filename (name on disk), desc
    files_to_download = [
        {"repo_filename": model_name, "local_filename": model_name, "desc": "Downloading model"}
    ]

    # Add mmproj file if this model has one
    mmproj_local = get_mmproj_for_model(model_name)
    if mmproj_local:
        mmproj_repo = model_info.get("mmproj_repo_filename", mmproj_local)
        files_to_download.append({
            "repo_filename": mmproj_repo,
            "local_filename": mmproj_local,
            "desc": "Downloading mmproj"
        })

    # Download each file if it doesn't exist
    for file_info in files_to_download:
        repo_filename = file_info["repo_filename"]
        local_filename = file_info["local_filename"]
        local_path = os.path.join(models_dir, local_filename)

        if os.path.exists(local_path):
            print(f"[Model Manager] File already exists: {local_filename}")
            continue

        # Download the file
        try:
            print(f"[Model Manager] Downloading {repo_filename} from {repo_id}...")
            api = HfApi()
            repo_info_obj = api.repo_info(repo_id=repo_id, files_metadata=True)
            file_metadata = next((f for f in repo_info_obj.siblings if f.rfilename == repo_filename), None)
            if not file_metadata or file_metadata.size is None:
                print(f"[Model Manager] Could not find file size for {repo_filename} in {repo_id}")
                return None
            total_size = file_metadata.size
            download_url = f"https://huggingface.co/{repo_id}/resolve/main/{repo_filename}"
            if local_filename != repo_filename:
                print(f"[Model Manager] Will save as: {local_filename}")
            pbar = tqdm(total=total_size, unit="B", unit_scale=True, desc=file_info["desc"])
            with requests.get(download_url, stream=True) as r, open(local_path, "wb") as f:
                r.raise_for_status()
                for chunk in r.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
                        pbar.update(len(chunk))
            pbar.close()
            print(f"[Model Manager] Successfully downloaded {local_filename}")
        except Exception as e:
            print(f"[Model Manager] Error downloading {repo_filename}: {e}")
            return None

    return os.path.join(models_dir, model_name)
