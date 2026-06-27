"""Ideogram 4 caption schema: the LLM instruction prompt + a tolerant parser.

The model is asked to emit a single JSON object matching Ideogram 4's structured
caption format. Real models add prose, code fences, or trailing commentary, so
`parse_caption` extracts the first balanced object and coerces it into the exact
shape the editor expects (key order is normalized on export by the node, not here).

Vendored from the comfyui-ideogram-autoprompter project (nodes/caption_schema.py):
https://github.com/collbroGTR/comfyui-ideogram-autoprompter
Used to power the "Ideogram4 Vision" modes in the Prompt Generator.
"""

import json
import re

# ── The schema instruction handed to the LLM as a system / leading prompt ──
SYSTEM_PROMPT = """You are an expert prompt engineer for Ideogram 4, an image model trained on \
structured JSON captions. Convert the user's idea (and the reference image, if one is given) \
into ONE Ideogram 4 caption JSON object. Output ONLY the JSON — no markdown fences, no commentary.

SCHEMA (key order matters):
{
  "high_level_description": "<one or two sentence overview of the whole image>",
  "style_description": {
    // include this block only when style is meaningful. Pick EXACTLY ONE of photo / art_style.
    // Photo order:    aesthetics, lighting, photo, medium, color_palette
    // Non-photo order: aesthetics, lighting, medium, art_style, color_palette
    "aesthetics": "<visual mood keywords>",
    "lighting": "<lighting description>",
    "photo": "<camera/lens specs, e.g. '35mm, f/1.4, shallow depth of field'>",   // photos only
    "art_style": "<style description>",                                            // non-photos only
    "medium": "<photograph | illustration | 3d_render | painting | ...>",
    "color_palette": ["#RRGGBB", ...]   // up to 16 UPPERCASE hex codes, optional
  },
  "compositional_deconstruction": {
    "background": "<description of the scene/environment>",
    "elements": [
      {
        "type": "obj",
        "bbox": [ymin, xmin, ymax, xmax],   // integers 0-1000, origin top-left, optional
        "desc": "<detailed description of this object>",
        "color_palette": ["#RRGGBB", ...]   // up to 5 UPPERCASE hex codes, optional
      },
      {
        "type": "text",
        "bbox": [ymin, xmin, ymax, xmax],
        "text": "<the literal text to render>",
        "desc": "<how the text looks: font feel, weight, treatment>",
        "color_palette": ["#RRGGBB", ...]
      }
    ]
  }
}

RULES:
- high_level_description and compositional_deconstruction.background are required; always fill them.
- Break the scene into concrete elements. Give each a bbox on the 0-1000 grid; place them where they
  belong (rough placement in hundreds is fine). The grid is [ymin, xmin, ymax, xmax], top-left origin.
- Use type "text" for any rendered words/letters and put the exact words in "text".
- All hex colors UPPERCASE #RRGGBB. <=16 colors in the style palette, <=5 per element.
- Choose photo vs art_style from the idea; if it reads photographic use "photo", otherwise "art_style".
- Return a single valid JSON object and nothing else."""

# Appended to the system prompt when the user asks for high element density. The model
# should decompose the scene far more granularly — one element (and bbox) per distinct
# object instead of grouping co-located things together.
DENSITY_HIGH = """

ELEMENT DENSITY: HIGH.
- Decompose the scene as granularly as possible. Give EVERY distinct object its own element
  with its own bbox — never merge several objects into one region.
- Example: a table holding a vase becomes TWO elements (one bbox for the table, one for the
  vase), not one. Split groups, sets, and clusters into individual elements as well.
- Include small and secondary objects (props, accents, background details) as their own
  elements with tight bboxes. Aim for a thorough, exhaustive breakdown of the composition."""


def get_system_prompt(density="normal"):
    """Return the system prompt for the requested element density ('normal' | 'high')."""
    if density == "high":
        return SYSTEM_PROMPT + DENSITY_HIGH
    return SYSTEM_PROMPT


def build_user_prompt(idea, has_image):
    idea = (idea or "").strip()
    parts = []
    if has_image:
        parts.append("A reference image is provided. Describe and deconstruct what it depicts.")
    if idea:
        parts.append("User idea: " + idea)
    if not parts:
        parts.append("Invent a compelling, well-composed image and deconstruct it.")
    parts.append("Produce the Ideogram 4 caption JSON now.")
    return "\n".join(parts)


def _extract_json(text):
    """Return the first balanced {...} block in text, or None.

    Tolerates ```json fences and TRUNCATED output: if the model ran out of tokens
    mid-object the braces never balance, so we close any still-open strings/arrays/
    objects at the point the text ends and return that repaired block. This is the
    common cause of "No JSON object found" on slow local models that hit the token cap.
    """
    if not text:
        return None
    # strip ```json ... ``` fences if present (closing fence optional when truncated)
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    else:
        fence_open = re.search(r"```(?:json)?\s*(.*)", text, re.DOTALL)
        if fence_open:
            text = fence_open.group(1)
    start = text.find("{")
    if start == -1:
        return None
    depth, in_str, esc = 0, False, False
    stack = []                                 # track '{' / '[' for truncation repair
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c in "{[":
                stack.append(c)
                if c == "{":
                    depth += 1
            elif c in "}]":
                if stack:
                    stack.pop()
                if c == "}":
                    depth -= 1
                    if depth == 0:
                        return text[start:i + 1]
    # Truncated: rebuild from the start, closing whatever is still open.
    frag = text[start:]
    if in_str:
        frag += '"'
    frag = frag.rstrip().rstrip(",")           # drop a dangling trailing comma
    # drop a dangling "key": with no value yet, and any comma it left behind
    frag = re.sub(r',?\s*"[^"]*"\s*:\s*$', "", frag).rstrip().rstrip(",")
    for opener in reversed(stack):
        frag += "}" if opener == "{" else "]"
    return frag


def _clean_hex_list(v, cap):
    out = []
    if isinstance(v, str):
        v = [v]
    if isinstance(v, list):
        for c in v:
            if isinstance(c, str) and re.fullmatch(r"#?[0-9a-fA-F]{6}", c.strip()):
                h = c.strip().lstrip("#").upper()
                out.append("#" + h)
    return out[:cap]


def _clamp_bbox(v):
    if not isinstance(v, list) or len(v) != 4:
        return None
    try:
        b = [max(0, min(1000, int(round(float(x))))) for x in v]
    except (TypeError, ValueError):
        return None
    ymin, xmin, ymax, xmax = b
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    return [ymin, xmin, ymax, xmax]


def _snippet(text, limit=400):
    s = (text or "").strip().replace("\n", " ")
    return s[:limit] + ("…" if len(s) > limit else "")


def parse_caption(text):
    """Parse model output into a normalized caption dict, or raise ValueError."""
    raw = _extract_json(text)
    if raw is None:
        raise ValueError(
            "No JSON object found in model output. The model replied with prose instead "
            "of JSON (try a stronger/instruct vision model). Raw output: %s" % _snippet(text)
        )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(
            "Model output was not valid JSON (%s). Raw output: %s" % (e, _snippet(text))
        )
    if not isinstance(data, dict):
        raise ValueError("Model output was not a JSON object. Raw output: %s" % _snippet(text))

    cap = {}
    hld = data.get("high_level_description")
    if isinstance(hld, str) and hld.strip():
        cap["high_level_description"] = hld.strip()

    sd = data.get("style_description")
    if isinstance(sd, dict):
        style = {}
        for k in ("aesthetics", "lighting", "medium"):
            if isinstance(sd.get(k), str):
                style[k] = sd[k]
        if isinstance(sd.get("photo"), str):
            style["photo"] = sd["photo"]
        elif isinstance(sd.get("art_style"), str):
            style["art_style"] = sd["art_style"]
        pal = _clean_hex_list(sd.get("color_palette"), 16)
        if pal:
            style["color_palette"] = pal
        if style:
            cap["style_description"] = style

    cd = data.get("compositional_deconstruction")
    if not isinstance(cd, dict):
        cd = {}
    background = cd.get("background")
    elements_in = cd.get("elements") if isinstance(cd.get("elements"), list) else []

    elements = []
    for el in elements_in:
        if not isinstance(el, dict):
            continue
        etype = "text" if el.get("type") == "text" else "obj"
        out = {"type": etype}
        bb = _clamp_bbox(el.get("bbox"))
        if bb is not None:
            out["bbox"] = bb
        if etype == "text":
            out["text"] = el.get("text", "") if isinstance(el.get("text"), str) else ""
        out["desc"] = el.get("desc", "") if isinstance(el.get("desc"), str) else ""
        pal = _clean_hex_list(el.get("color_palette"), 5)
        if pal:
            out["color_palette"] = pal
        elements.append(out)

    cap["compositional_deconstruction"] = {
        "background": background if isinstance(background, str) else "",
        "elements": elements,
    }
    return cap
