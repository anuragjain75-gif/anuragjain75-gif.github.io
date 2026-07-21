"""
fragment_renderer.py

Renderer for Lilamaya fragment social cards.

Layout

    Header
        Tree logo + The Lilamaya

    Invocation
        Largest typography
        Independent text fitting

    Reflection
        Smaller typography
        Independent text fitting

    Footer
        Divider
        Author
        Date

The renderer intentionally treats a fragment as a typographic composition
rather than a single flowing block of text.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

from PIL import (
    Image,
    ImageDraw,
    ImageFont,
)

from renderer_config import *


# --------------------------------------------------------------------
# Typography
# --------------------------------------------------------------------

HEADER_SIZE = 34

INVOCATION_START = 68
INVOCATION_MIN = 44

REFLECTION_START = 38
REFLECTION_MIN = 26

FOOTER_SIZE = 22


# --------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------

HEADER_TOP = 42

INVOCATION_TOP = 156

REFLECTION_TOP = 372

FOOTER_TOP = 530

DIVIDER_Y = 515

DIVIDER_WIDTH = 260

LOGO_SIZE = 44

LOGO_GAP = 12

INVOCATION_BOX_WIDTH = 860
INVOCATION_BOX_HEIGHT = 180

REFLECTION_BOX_WIDTH = 760
REFLECTION_BOX_HEIGHT = 120


# --------------------------------------------------------------------
# Fonts
# --------------------------------------------------------------------

HEADER_FONT = ImageFont.truetype(
    str(REGULAR_FONT),
    HEADER_SIZE,
)

FOOTER_FONT = ImageFont.truetype(
    str(REGULAR_FONT),
    FOOTER_SIZE,
)

def load_font(
    size: int,
    italic: bool = False,
    bold: bool = False,
) -> ImageFont.FreeTypeFont:

    if bold and italic:
        font_path = BOLD_ITALIC_FONT
    elif bold:
        font_path = BOLD_FONT
    elif italic:
        font_path = ITALIC_FONT
    else:
        font_path = REGULAR_FONT

    return ImageFont.truetype(
        str(font_path),
        size,
    )

# --------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------

INVOCATION_PATTERN = re.compile(
    r"\{\{<\s*invocation\s*>\}\}(.*?)\{\{<\s*/invocation\s*>\}\}",
    re.DOTALL,
)


def parse_fragment(text: str) -> tuple[str, str]:
    """
    Returns

        invocation
        reflection
    """

    # 1. Clean the HTML line breaks from the entire text first.
    # We use a pattern that catches the tag with or without slashes/spaces.
    clean_text = re.sub(
        r"<\s*br\s*/?>",
        "\n",
        text,
        flags=re.IGNORECASE,
    )

    # 2. Now search for the invocation block in the cleaned text.
    match = INVOCATION_PATTERN.search(clean_text)

    if not match:
        return "", clean_text.strip()

    invocation = match.group(1).strip()
    reflection = clean_text[match.end():].strip()

    return invocation, reflection

# --------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------

def line_width(
    draw: ImageDraw.ImageDraw,
    text: str,
    font,
) -> int:

    left, top, right, bottom = draw.textbbox(
        (0, 0),
        text,
        font=font,
    )

    return right - left


def line_height(
    draw: ImageDraw.ImageDraw,
    font,
) -> int:

    left, top, right, bottom = draw.textbbox(
        (0, 0),
        "Ag",
        font=font,
    )

    return bottom - top

    # --------------------------------------------------------------------
# Word wrapping
# --------------------------------------------------------------------

def wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font,
    max_width: int,
) -> list[str]:

    lines: list[str] = []

    paragraphs = text.split("\n")

    for paragraph in paragraphs:

        paragraph = paragraph.strip()

        if not paragraph:
            lines.append("")
            continue

        words = paragraph.split()

        current = ""

        for word in words:

            trial = word if current == "" else current + " " + word

            if line_width(draw, trial, font) <= max_width:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = word

        if current:
            lines.append(current)

    return lines


# --------------------------------------------------------------------
# Block fitting
# --------------------------------------------------------------------

def fit_text_block(
    draw: ImageDraw.ImageDraw,
    text: str,
    start_size: int,
    minimum_size: int,
    box_width: int,
    box_height: int,
    font_path,
):

    for size in range(
        start_size,
        minimum_size - 1,
        -2,
    ):

        font = ImageFont.truetype(
            str(font_path),
            size,
        )


        lines = wrap_text(
            draw,
            text,
            font,
            box_width,
        )

        lh = line_height(draw, font)

        spacing = max(2, size // 8)

        total_height = (
            len(lines) * lh +
            (len(lines) - 1) * spacing
        )

        if total_height <= box_height:

            return {
                "font": font,
                "lines": lines,
                "line_height": lh,
                "spacing": spacing,
                "height": total_height,
                "size": size,
            }

    font = ImageFont.truetype(
        str(font_path),
        minimum_size,
    )

    lines = wrap_text(
        draw,
        text,
        font,
        box_width,
    )

    lh = line_height(draw, font)

    spacing = max(6, minimum_size // 5)

    total_height = (
        len(lines) * lh +
        (len(lines) - 1) * spacing
    )

    return {
        "font": font,
        "lines": lines,
        "line_height": lh,
        "spacing": spacing,
        "height": total_height,
        "size": minimum_size,
    }

# --------------------------------------------------------------------
# Draw centred text block
# --------------------------------------------------------------------
def draw_centered_block(
    draw: ImageDraw.ImageDraw,
    x_center: int,
    top: int,
    fitted,
    colour: str,
):
    y = top
    font = fitted["font"]
    is_bold = fitted.get("bold", False)

    for line in fitted["lines"]:
        if line == "":
            y += fitted["line_height"]
            continue

        w = line_width(draw, line, font)

        draw.text(
            (x_center - w / 2, y),
            line,
            font=font,
            fill=colour,
            # Simulates bold weight if no distinct bold font file is available
            stroke_width=1 if is_bold else 0,
            stroke_fill=colour if is_bold else None,
        )

        y += fitted["line_height"] + fitted["spacing"]

 # --------------------------------------------------------------------
# Background
# --------------------------------------------------------------------

def apply_washi_texture(canvas: Image.Image) -> Image.Image:
    """
    Applies a subtle paper texture if one has been configured.

    The renderer still works perfectly if no texture exists.
    """

    texture_path = PROJECT_ROOT / "assets" / "textures" / "washi.png"

    if not texture_path.exists():
        return canvas

    texture = (
        Image.open(texture_path)
        .convert("RGBA")
        .resize(canvas.size)
    )

    # Very subtle.
    texture.putalpha(14)

    return Image.alpha_composite(
        canvas.convert("RGBA"),
        texture,
    ).convert("RGB")


# --------------------------------------------------------------------
# Header
# --------------------------------------------------------------------

def draw_header(
    canvas: Image.Image,
    draw: ImageDraw.ImageDraw,
):
    title = "The Lilamaya"

    title_width = line_width(
        draw,
        title,
        HEADER_FONT,
    )

    logo_exists = LOGO_PATH.exists()

    if logo_exists:
        logo = Image.open(LOGO_PATH).convert("RGBA")
        logo.thumbnail((LOGO_SIZE, LOGO_SIZE))
        actual_logo_w, actual_logo_h = logo.size
    else:
        actual_logo_w, actual_logo_h = 0, 0

    total_width = (
        actual_logo_w +
        (LOGO_GAP if logo_exists else 0) +
        title_width
    )

    start_x = (WIDTH - total_width) / 2

    if logo_exists:
        # Calculate text height for vertical alignment
        _, top, _, bottom = draw.textbbox((0, 0), title, font=HEADER_FONT)
        text_height = bottom - top

        # Centering the logo vertically with the text box
        logo_y = HEADER_TOP + (text_height - actual_logo_h) // 2

        canvas.paste(
            logo,
            (int(start_x), int(logo_y)),
            logo,
        )

        text_x = start_x + actual_logo_w + LOGO_GAP
    else:
        text_x = start_x

    draw.text(
        (
            text_x,
            HEADER_TOP,
        ),
        title,
        font=HEADER_FONT,
        fill=OLIVE,
    )


# --------------------------------------------------------------------
# Divider
# --------------------------------------------------------------------

def draw_divider(
    draw: ImageDraw.ImageDraw,
):

    left = (
        WIDTH / 2 -
        DIVIDER_WIDTH / 2
    )

    right = (
        WIDTH / 2 +
        DIVIDER_WIDTH / 2
    )

    draw.line(
        (
            left,
            DIVIDER_Y,
            right,
            DIVIDER_Y,
        ),
        fill=OLIVE,
        width=1,
    )

# --------------------------------------------------------------------
# Footer
# --------------------------------------------------------------------

def draw_footer(
    draw: ImageDraw.ImageDraw,
    date_text: str,
):

    footer = (
        f"Anurag Jain · {date_text}"
    )

    width = line_width(
        draw,
        footer,
        FOOTER_FONT,
    )

    draw.text(
        (
            WIDTH / 2 - width / 2,
            FOOTER_TOP,
        ),
        footer,
        font=FOOTER_FONT,
        fill=MUTED,
    )

    # --------------------------------------------------------------------
# Main renderer
# --------------------------------------------------------------------

def render(
    fragment_text: str,
    date_text: str,
    output_path: Path,
):

    invocation, reflection = parse_fragment(
        fragment_text,
    )

    canvas = Image.new(
        "RGB",
        (
            WIDTH,
            HEIGHT,
        ),
        BACKGROUND,
    )

    canvas = apply_washi_texture(
        canvas,
    )

    draw = ImageDraw.Draw(
        canvas,
    )

    draw_header(
        canvas,
        draw,
    )

    # ------------------------------------------------------------
    # Invocation
    # ------------------------------------------------------------

   # ------------------------------------------------------------
    # Invocation
    # ------------------------------------------------------------

    if invocation.strip():

        invocation_fit = fit_text_block(
            draw=draw,
            text=invocation,
            start_size=INVOCATION_START,
            minimum_size=INVOCATION_MIN,
            box_width=INVOCATION_BOX_WIDTH,
            box_height=INVOCATION_BOX_HEIGHT,
            font_path=BOLD_ITALIC_FONT,
        )
        invocation_fit["spacing"] = 2   # Try 2, 3 or 4
    
        draw_centered_block(
            draw=draw,
            x_center=WIDTH // 2,
            top=INVOCATION_TOP,
            fitted=invocation_fit,
            colour=TEXT,
        )
        # --------------------------------------------------------------------
        # Decorative separator dot
        # --------------------------------------------------------------------

        DOT_RADIUS = 3
        DOT_Y = REFLECTION_TOP - 26

        draw.ellipse(
            (
                WIDTH // 2 - DOT_RADIUS,
                DOT_Y - DOT_RADIUS,
                WIDTH // 2 + DOT_RADIUS,
                DOT_Y + DOT_RADIUS,
            ),
            fill=TEXT,
        )
        
    # ------------------------------------------------------------
    # Reflection
    # ------------------------------------------------------------

    if reflection.strip():

        reflection_fit = fit_text_block(
            draw=draw,
            text=reflection,
            start_size=REFLECTION_START,
            minimum_size=REFLECTION_MIN,
            box_width=REFLECTION_BOX_WIDTH,
            box_height=REFLECTION_BOX_HEIGHT,
            font_path=REGULAR_FONT,
        )

        reflection_top = REFLECTION_TOP

        #
        # If there is no invocation,
        # lift the reflection upward
        # so the card remains visually balanced.
        #

        if not invocation.strip():

            reflection_top = (
                INVOCATION_TOP + 20
            )

        draw_centered_block(
            draw=draw,
            x_center=WIDTH // 2,
            top=reflection_top,
            fitted=reflection_fit,
            colour=TEXT,
        )

    # ------------------------------------------------------------
    # Footer
    # ------------------------------------------------------------

    draw_divider(
        draw,
    )

    draw_footer(
        draw,
        date_text,
    )
     
    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    canvas.save(output_path)

    # --------------------------------------------------------------------
# Convenience wrapper
# --------------------------------------------------------------------

def render_fragment_card(
    fragment_text: str,
    date_text: str,
    output_path,
):
    """
    Convenience wrapper used by generate_fragment_cards.py.
    """

    if not isinstance(output_path, Path):
        output_path = Path(output_path)

    render(
        fragment_text=fragment_text,
        date_text=date_text,
        output_path=output_path,
    )


# --------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------

__all__ = [
    "parse_fragment",
    "render",
    "render_fragment_card",
]
