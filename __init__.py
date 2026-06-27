"""
ComfyUI-Llama-Prompt-Generator — a single node for local-LLM prompt generation,
image analysis, and Ideogram-4 captioning (llama.cpp or Ollama).

Fork of FranckyB/comfyui-prompt-manager, trimmed to just the generator and
rebuilt with a custom Generator/Options UI.
"""
__version__ = "1.5.0"
__author__ = "GlatTissekone (fork of François Beaudry)"
__license__ = "MIT"

# prompt_generator / prompt_generator_options are imported for their logic and
# server routes (force-kill, create_options, system-prompt presets) that the
# merged node reuses. prompt_generator_pro is the only registered node.
from .nodes.prompt_generator import PromptGenerator  # noqa: F401 (logic + force-kill route)
from .nodes.prompt_generator_options import PromptGenOptions  # noqa: F401 (create_options + helpers)
from .nodes.prompt_generator_pro import PromptGeneratorPro

NODE_CLASS_MAPPINGS = {
    "PromptGeneratorPro": PromptGeneratorPro,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptGeneratorPro": "Llama | Prompt Generator",
}

WEB_DIRECTORY = "./js"
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
print("[Llama-Prompt-Generator] Registered: Llama | Prompt Generator")
