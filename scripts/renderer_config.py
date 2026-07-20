# fragment_renderer.py
# Social version: no date, no divider.

from PIL import Image, ImageDraw, ImageFont
import frontmatter
import markdown
from bs4 import BeautifulSoup

from renderer_config import (
    PROJECT_ROOT,
    FONT_DIR,
    LOGO_PATH,
    WIDTH,
    HEIGHT,
    BACKGROUND,
    TEXT,
    OLIVE,
    REGULAR_FONT,
    ITALIC_FONT,
    FRAGMENT_BODY_START,
    FRAGMENT_BODY_MIN,
    SIGNATURE_SIZE,
    MAX_TEXT_WIDTH,
    BOTTOM_MARGIN,
)

FRAGMENTS_DIR = PROJECT_ROOT / "content" / "fragments"

OUTPUT_DIR = PROJECT_ROOT / "static" / "images" / "social" / "fragments"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

BODY_START = FRAGMENT_BODY_START
BODY_MIN = FRAGMENT_BODY_MIN

TREE_Y = 26
BODY_Y = 110

LINE_GAP = 20
PARA_GAP = 28
BODY_SIG_GAP = 42
SIG_NAME_GAP = 16


def get_fonts(size):
    return (
        ImageFont.truetype(str(REGULAR_FONT), size),
        ImageFont.truetype(str(ITALIC_FONT), SIGNATURE_SIZE),
    )


def center(draw, text, font, y, colour):
    bbox = draw.textbbox((0, 0), text, font=font)
    x = (WIDTH - (bbox[2] - bbox[0])) / 2
    draw.text((x, y), text, font=font, fill=colour)


def wrap(draw, text, font):
    lines = []

    for paragraph in text.split("\n"):
        if not paragraph.strip():
            lines.append("")
            continue

        current = ""

        for word in paragraph.split():
            trial = word if not current else f"{current} {word}"

            if draw.textbbox((0, 0), trial, font=font)[2] <= MAX_TEXT_WIDTH:
                current = trial
            else:
                lines.append(current)
                current = word

        if current:
            lines.append(current)

        lines.append("")

    return lines


for md_file in sorted(FRAGMENTS_DIR.glob("*.md")):

    if md_file.name.startswith("_"):
        continue

    post = frontmatter.load(md_file)

    text = BeautifulSoup(
        markdown.markdown(post.content),
        "html.parser",
    ).get_text("\n").strip()

    font_size = BODY_START

    while True:

        body_font, signature_font = get_fonts(font_size)

        image = Image.new(
            "RGB",
            (WIDTH, HEIGHT),
            BACKGROUND,
        )

        draw = ImageDraw.Draw(image)

        lines = wrap(draw, text, body_font)

        y = BODY_Y

        for line in lines:
            if line:
                y += (
                    draw.textbbox((0, 0), line, font=body_font)[3]
                    + LINE_GAP
                )
            else:
                y += PARA_GAP

        symbol_height = draw.textbbox(
            (0, 0),
            "⁂",
            font=signature_font,
        )[3]

        name_height = draw.textbbox(
            (0, 0),
            "Lilamaya",
            font=signature_font,
        )[3]

        if (
            y
            + BODY_SIG_GAP
            + symbol_height
            + SIG_NAME_GAP
            + name_height
            <= HEIGHT - BOTTOM_MARGIN
            or font_size <= BODY_MIN
        ):
            break

        font_size -= 2

    if LOGO_PATH.exists():
        logo = Image.open(LOGO_PATH).convert("RGBA")
        logo.thumbnail((72, 72))

        image.paste(
            logo,
            ((WIDTH - logo.width) // 2, TREE_Y),
            logo,
        )

    y = BODY_Y

    for line in lines:
        if line:
            center(
                draw,
                line,
                body_font,
                y,
                TEXT,
            )

            y += (
                draw.textbbox((0, 0), line, font=body_font)[3]
                + LINE_GAP
            )
        else:
            y += PARA_GAP

    y += BODY_SIG_GAP

    center(
        draw,
        "⁂",
        signature_font,
        y,
        OLIVE,
    )

    y += symbol_height + SIG_NAME_GAP

    center(
        draw,
        "Lilamaya",
        signature_font,
        y,
        OLIVE,
    )

    image.save(
        OUTPUT_DIR / f"{md_file.stem}.png"
    )

    print(f"Rendered {md_file.stem}")