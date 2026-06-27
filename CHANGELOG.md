# Changelog

All notable changes to this fork are documented here.
This is a fork of [FranckyB/comfyui-prompt-manager](https://github.com/FranckyB/comfyui-prompt-manager).

## [1.5.0] — GlatTissekone

A UI grouping + prefix/suffix overhaul: every panel's controls are grouped into cards, and prefixes/suffixes are managed as individual tags.

### Added
- **Group cards** — the Generator (input/output), System Prompt, Prompts, and Options (LLM + Settings) panels are grouped into bordered cards with a subtle light-grey backing, shown in **both** normal and SKIP-LLM modes. 3px of vertical breathing room between cards; the old section dividers are removed since the cards now do the separating.
- **Per-tag Prefix / Suffix** — the builder shows one editable chip per tag; the rows show one pill per tag (truncated with hover-for-full-text, a per-tag **✕**, and a **clear-all ✕** on the ＋ Prefix / ＋ Suffix buttons). Tags containing commas are preserved (per-tag storage). A faint red **P** / blue **S** marks each side, with matching colored ＋ labels. Tags already in use are tinted green; creating a tag auto-adds it.

### Changed
- **Prompts panel** — Output / Copy moved onto the preview-toggle row; Save to Library / Load onto the Select / Delete row. The previewed prompt's metadata moved into the image group (and reads light in SKIP-LLM mode). In **Horizontal** mode the image, text box, and metadata always share one width and scale together (drag the image, the text box, or the node width), with no independent minimum; the grid card matches the preview card's height.

### Fixed
- **Expanded-view output box** had a fixed minimum height; it now resizes down like the other boxes.

## [1.4.0] — GlatTissekone

Prompt prefix/suffix wrapping, a one-click LLM→image button, and an on-demand status model.

### Added
- **Prompt Prefix / Suffix** — pills (in BOTH the Input and Output rows, plus the Expanded view) that set text always wrapping the emitted prompt (`", "` joined). Works with or without the LLM: it wraps the input when prompting directly, and wraps the LLM result on Generate — and **survives Refine** (the model only ever sees the core). Click a pill to edit; the **✕** on its right edge clears it. Applied exactly once — to the downstream output, image render, Copy and Save.
- **🖼 Generate Image (LLM)** — a one-click Input-row button: run the LLM to craft the prompt, then render an image from its result (×N-aware).

### Changed
- **Status is now pull-based** — no background polling. Click the status dot or the backend chip (tooltip: "Click to check status of …") for an on-demand check; it still refreshes on Serve/Kill/Test/Unload and when Options ▸ LLM opens. Removes idle network/disk work.
- The **generation-time** readout now sits with the output **char · word** count (one bundled group, time first), token meter on the left.

### Fixed
- **llama.cpp stutter** — a server state change no longer triggers a recursive model-directory rescan (llama.cpp models are local files, independent of the server); the rescan is now Ollama-only.

### Internal
- De-duplicated the streaming-response parser (shared by llama.cpp + Ollama), the GPU-tiered context-size helper, and request-timeout parsing.

## [1.3.0] — GlatTissekone

A big in-node workflow pass: a Resolution picker, a full Prompts browser (Recent + Library), batch variations, and one-click image renders.

### Added
- **Resolution picker** — a third **Generator** sub-view: a drag canvas with **per-axis divisibility snap**, **base × scale** sizing, Width/Height/Scale/Megapixel sliders, aspect lock, saveable presets (localStorage), and an optional reference-image underlay. Drives the node's **`width`/`height` outputs**. Reachable via the status-bar **RES** pill and the output header's **W × H | aspect** readout.
- **Prompts tab** — a browser for every prompt you've made:
  - **Recent** (auto-saved runs) + a server-side **Library** organized into **categories**, behind one scope picker: History · All · ⭐ Favorites · categories.
  - Live **search**, **sort** (Newest / Oldest / A–Z / Most used), **card views** (text / gallery / image) and an **Album** (horizontal) layout with a large preview; cached webp **thumbnails**.
  - **Multi-select** (Select) across scopes → **Save to category** or delete; **🧹 Delete All** for the current scope; per-entry **⭐ Pin**, **⤵ Load** (text + Mode/Preset + image), **💾 Save Input / Save Output**, and **Import / Export** the whole library as JSON.
  - The generated **image auto-attaches** to its prompt's Recent entry (order-independent, even when the node is unlinked).
- **×N batch variations** — a stepper by Generate stacks N seeded variations as versions (in-node) or queues N renders.
- **Two 🖼 Generate Image buttons** — render an image straight from the **Input** prompt or the **Output** prompt (no LLM), ×N-aware.
- **Input char + word counter**, **GEN** status-bar shortcut, and the output-header **W × H | aspect** readout (click → Resolution).
- **LLM presets** — save/load the whole LLM + sampling + backend bundle from Options ▸ LLM (system prompt excluded).
- Generation-time / token meter now mirrored into the **Expanded** view.

### Changed
- Output-header pills (**Copy · Save Output · History**) drop onto the action row when the node is wide enough, and stay on the header row when narrow.
- The Prompts browse bar's **sort + category** controls wrap to a second line as one group when space is tight.
- **Save** split into **Save Input** / **Save Output**; **History** moved into the output header. Ctrl/⌘+Enter renders the text box you're currently editing.

### Removed
- Image "recipe" / `gen_meta` detection — it couldn't be read reliably across arbitrary loader/sampler nodes, and a wrong recipe misleads. Only the rendered image is captured now.

## [1.2.0] — GlatTissekone

A full Ollama-backend system + a status/UI coherency pass.

### Added
- **Ollama lifecycle controls** — **Serve** / **Kill** the Ollama server and **Pull Model** (download by name, with a live spinner + success/fail) right on the node; all launched silently (no terminal windows). **Generate auto-starts Ollama** if it's down.
- **Backend-adaptive Options ▸ LLM** — Ollama mode shows a per-node **Ollama URL** field and the server's own model list (no local-file scan / MMProj), while llama.cpp keeps path/port/Extra-Args + folder scans. Status, Test, Serve/Kill and Unload all honor the node's backend + URL.
- **Per-model Vision detection** — in Ollama mode the status strip shows whether the selected model supports vision (via `/api/show` capabilities — architecture-based, name-independent).
- **`width` / `height` outputs** from the loaded image.
- **Rename presets (✎)** next to delete; clicking the **Backend** label toggles backend.

### Changed
- **Minimal status strip** — uniform light-grey labels with a single state dot (green = running, red = stopped, grey = not found/neutral), instead of coloured text + glyphs. Backend status text fixed to always reflect the node's own backend.
- **Per-backend model memory** — switching llama.cpp ⇄ Ollama restores each backend's last model/mmproj.
- **Bottom gap fix** — prompt/output/system-prompt boxes keep a persistent top/bottom gap even when scrolled (transparent borders; resize handle dropped to keep it clean). Hover/focus lift on all text boxes + dropdowns.
- llama.cpp **Test** now verifies the node's own Llama-Server path. `Ideogram4 Vision Standard` capitalised.

## [1.1.0] — GlatTissekone

A large interaction + UI pass: the node can now run the LLM **without queuing the graph**, streams tokens live into the node, keeps an in-node version history with diffing, and got a full minimalist dark-mode restyle.

### Added
- **Run out-of-graph** — a **✨ Generate** button runs the LLM immediately with the node's current settings (no full workflow queue), so you can craft prompts interactively. Uses the in-node image for the vision modes.
- **Live token streaming** — generated tokens (and 💭 thinking) stream straight into the node's output box as they're produced, with a progress bar estimated from a rolling output-length history.
- **Refine + version history** — **⟳ Refine** revises the shown output using the prompt box as a change instruction; outputs are kept as versions (◀ ▶) with a **⇄ Diff** word-level comparison against the previous version, plus **📋 Copy**.
- **Per-node backend selector** — choose **llama.cpp** or **Ollama** right on the node (Options ▸ LLM); it's the authoritative backend for that node and overrides the global ComfyUI setting. Includes a server **status dot**, **Test**, and **Unload** controls.
- **Backend-adaptive connection fields** — llama.cpp shows Llama-Server Path / Port / Extra Args / Model+MMProj Directory scan roots; **Ollama** shows a single per-node **Ollama URL** (ip + port) instead, hides the MMProj dropdown + folder-scan fields, and lists models straight from the Ollama server. Status/Test/Unload all honor the per-node backend + URL.
- **Ollama vision detection** — the status strip's MMPROJ chip is replaced by a **Vision** chip in Ollama mode, detected from Ollama's `/api/show` capabilities (architecture-based, independent of model name).
- **Per-node request timeout** for generation (both backends).
- **In-node Bypass** — a custom no-op that skips the LLM and passes the prompt straight to `output` (dims the node, never turns the graph purple). Available as a header icon and an Execution-Settings toggle (synced).
- **Vision presets** — save a system-prompt preset flagged as *Vision*; it reveals the in-node image loader and runs as an image-analysis task. Vision presets and the three vision modes show an 👁 marker in the dropdowns. Preset type is stored in a sidecar `prompts/presets/_presets_meta.json` (the `.txt` stays pure).
- **Prompt history** — recent prompts are saved and reachable from a **📖 History** picker (auto-collapses when you click away).
- **Status checklist bar** — a one-line backend / Model / MMPROJ / System-Prompt readiness strip, with toggles to **show/hide the Seed row and the status bar**.
- **Expanded ("theater") view** — a large read-friendly output view with Close buttons top and bottom.
- **Token meter** — shows prompt/completion/context token usage after a run.
- **`unique_id`** plumbing so live events route to the correct node.

### Changed
- **Full minimalist dark-mode restyle** — flat solid fills (no button gradients), no blurred shadows/glows, near-black surfaces with silver contrast and one restrained blue accent; a faint gradient is kept only on text fields. Category buttons, dropdown selected/hover rows, dividers and spacing were all reworked.
- **Sub-navigation moved into the main Generator/Options buttons** (cycling ‹ › arrows) — the old open/closeable sub-tab bars are gone.
- **Sampling sliders are always authoritative** with a *Reset to defaults* button — the old `use model defaults` toggle is gone. Per-model defaults are now cached per model name.
- **Interactive labels** — row labels brighten to white on hover and stay white while their control is active (input focused / dropdown open / section expanded).
- The **preset dropdown** replaces the old `Use system prompt preset` *mode*; a `None` mode and a `(No system prompt)` option allow sending no system prompt at all.
- Empty system-prompt box on the default text mode falls back to the `Clean Cinematic Enhancer` preset.

### Removed
- The `use_model_default_sampling` UI toggle and the `Enhance Prompt (Audio)` mode / `text_audio_system_prompt.txt`.

## [1.0.0] — GlatTissekone

First release of **ComfyUI-Llama-Prompt-Generator**: a focused rebuild around a single local-LLM prompt generator node.

### Added
- **Merged node** `LLM | Prompt Generator` — combines the old *Prompt Generator* and *Prompt Generator Options* into one node with a custom **Generator ⇄ Options** UI (and Prompt / System Prompt + LLM / LLM Settings sub-tabs).
- **Sticky settings** — every field persists into the workflow *and* a browser-local "last used" snapshot, so new or recreated nodes restore your last setup instead of defaults.
- **System-prompt presets** — save the current system prompt as a named `.txt` in `prompts/presets/`, reload from a dropdown, and delete your own presets (with a confirm dialog); built-in presets are protected.
- **In-node image loader** — load/drop an image directly in the node for the vision modes.
- **Ideogram 4 Vision modes** (standard + detailed) — structured JSON captions using the vendored schema from [comfyui-ideogram-autoprompter](https://github.com/collbroGTR/comfyui-ideogram-autoprompter).
- **Per-node Model Directory fields** — redirect the Model / mmproj dropdown scan roots to any folder (subfolders included).
- **Per-node llama.cpp path & port** — full `llama-server` executable path and server port, no global config required.
- **`image` output** — passthrough that lets the loaded image's dimensions propagate live to auto-detect nodes like [Resolution Master](https://github.com/Azornes/Comfyui-Resolution-Master).

### Changed
- Renamed the misleading `Enhance Prompt (Image)` mode to `Enhance Prompt (Text)`.
- The System Prompt now **replaces** the mode's built-in by default (`append` still available).

### Removed
- All non-generator nodes and their assets: Recipe (builder/manager/renderer/relay/model loader/picker/multi-prompt), LoRA (apply/stacker/combine), Prompt Manager (basic/advanced), Prompt Extractor — plus their JS, helper modules, tests, example workflows, and docs.
- Modes `Analyze Image` and `Enhance Prompt (Audio)`.
- The dead/orphaned `Source` (File/Text) field and `prompt_model_loader.js`.
