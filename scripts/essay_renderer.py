from PIL import Image, ImageDraw, ImageFont
from renderer_config import *


def load_font(size):
    return ImageFont.truetype(str(REGULAR_FONT), size)


INTRO_FONT = ImageFont.truetype(str(ITALIC_FONT), DESCRIPTION_SIZE)
SIGNATURE_FONT = ImageFont.truetype(str(ITALIC_FONT), SIGNATURE_SIZE)


def wrap(draw, text, font, width):
    words = text.split()
    lines = []
    line = ""

    for w in words:
        t = w if not line else line + " " + w

        if draw.textbbox((0, 0), t, font=font)[2] <= width:
            line = t
        else:
            lines.append(line)
            line = w

    if line:
        lines.append(line)

    return lines


def render(introduction, image, markdown_file, output_file):

    canvas = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(canvas)

    # ----------------------------------------------------
    # Hero image
    # ----------------------------------------------------

    hero_h = int(HEIGHT * IMAGE_HEIGHT_RATIO)

    hero = Image.open(image).convert("RGB")

    src_ratio = hero.width / hero.height
    dst_ratio = WIDTH / hero_h

    if src_ratio > dst_ratio:
        new_h = hero_h
        new_w = int(hero.width * hero_h / hero.height)
    else:
        new_w = WIDTH
        new_h = int(hero.height * WIDTH / hero.width)

    hero = hero.resize((new_w, new_h), Image.Resampling.LANCZOS)

    left = (new_w - WIDTH) // 2
    top = (new_h - hero_h) // 2

    hero = hero.crop((left, top, left + WIDTH, top + hero_h))

    canvas.paste(hero, (0, 0))

    # ----------------------------------------------------
    # Introduction
    # ----------------------------------------------------

    lines = wrap(draw, introduction, INTRO_FONT, TITLE_BOX_WIDTH)

    line_height = draw.textbbox((0, 0), "Ag", font=INTRO_FONT)[3]
    line_gap = 10

    total_height = len(lines) * line_height + (len(lines) - 1) * line_gap

    y = hero_h + TITLE_TOP_MARGIN + (TITLE_BOX_HEIGHT - total_height) / 2 - 18

    for line in lines:

        bbox = draw.textbbox((0, 0), line, font=INTRO_FONT)

        x = (WIDTH - (bbox[2] - bbox[0])) / 2

        draw.text(
            (x, y),
            line,
            font=INTRO_FONT,
            fill=OLIVE,
        )

        y += line_height + line_gap

    # ----------------------------------------------------
    # Lilamaya Branding
    # ----------------------------------------------------

    if LOGO_PATH.exists():

        logo = Image.open(LOGO_PATH).convert("RGBA")
        logo.thumbnail((40, 40), Image.Resampling.LANCZOS)

        brand_font = ImageFont.truetype(str(ITALIC_FONT), 30)

        text = "The Lilamaya"

        tb = draw.textbbox((0, 0), text, font=brand_font)
        text_width = tb[2] - tb[0]

        gap = 14

        total_width = logo.width + gap + text_width

        x = (WIDTH - total_width) // 2

        y_brand = HEIGHT - 52

        canvas.paste(logo, (x, y_brand - 4), logo)

        draw.text(
            (x + logo.width + gap, y_brand),
            text,
            font=brand_font,
            fill=MUTED,
        )

    output_file.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_file)