from PIL import Image, ImageDraw, ImageFont
from renderer_config import *


def load_font(size):
    return ImageFont.truetype(str(ITALIC_FONT), size)


SIGNATURE_FONT = ImageFont.truetype(
    str(ITALIC_FONT),
    SIGNATURE_SIZE
)


def wrap(draw, text, font, width):

    words = text.split()

    lines = []
    line = ""

    for word in words:

        test = word if not line else f"{line} {word}"

        if draw.textbbox((0, 0), test, font=font)[2] <= width:
            line = test
        else:
            lines.append(line)
            line = word

    if line:
        lines.append(line)

    return lines


def fit_title(draw, title):

    for size in range(TITLE_START, TITLE_MIN - 1, -2):

        font = load_font(size)

        lines = wrap(
            draw,
            title,
            font,
            TITLE_BOX_WIDTH
        )

        line_height = draw.textbbox(
            (0, 0),
            "Ag",
            font=font
        )[3]

        total_height = (
            len(lines) * line_height
            + (len(lines) - 1) * 8
        )

        if total_height <= TITLE_BOX_HEIGHT:
            return font, lines, line_height

    font = load_font(TITLE_MIN)

    lines = wrap(
        draw,
        title,
        font,
        TITLE_BOX_WIDTH
    )

    line_height = draw.textbbox(
        (0, 0),
        "Ag",
        font=font
    )[3]

    return font, lines, line_height


def render(
    title,
    image,
    markdown_file,
    output_file
):

    canvas = Image.new(
        "RGB",
        (WIDTH, HEIGHT),
        BACKGROUND
    )

    draw = ImageDraw.Draw(canvas)

    # --------------------------------------------------
    # Hero Image
    # --------------------------------------------------

    hero_height = int(
        HEIGHT * IMAGE_HEIGHT_RATIO
    )

    hero = Image.open(image).convert("RGB")

    source_ratio = hero.width / hero.height
    target_ratio = WIDTH / hero_height

    if source_ratio > target_ratio:

        new_height = hero_height

        new_width = int(
            hero.width * hero_height / hero.height
        )

    else:

        new_width = WIDTH

        new_height = int(
            hero.height * WIDTH / hero.width
        )

    hero = hero.resize(
        (new_width, new_height),
        Image.Resampling.LANCZOS
    )

    left = (new_width - WIDTH) // 2
    top = (new_height - hero_height) // 2

    hero = hero.crop(
        (
            left,
            top,
            left + WIDTH,
            top + hero_height
        )
    )

    canvas.paste(hero, (0, 0))

    # --------------------------------------------------
    # Title
    # --------------------------------------------------

    font, lines, line_height = fit_title(
        draw,
        title
    )

    line_gap = 8

    total_height = (
        len(lines) * line_height
        + (len(lines) - 1) * line_gap
    )

    y = (
        hero_height
        + TITLE_TOP_MARGIN
        + (TITLE_BOX_HEIGHT - total_height) / 2
        - 10
    )

    for line in lines:

        bbox = draw.textbbox(
            (0, 0),
            line,
            font=font
        )

        x = (
            WIDTH
            - (bbox[2] - bbox[0])
        ) / 2

        draw.text(
            (x, y),
            line,
            font=font,
            fill=OLIVE
        )

        y += line_height + line_gap

    # --------------------------------------------------
    # Branding
    # --------------------------------------------------

    if LOGO_PATH.exists():

        logo = Image.open(
            LOGO_PATH
        ).convert("RGBA")

        logo.thumbnail(
            (40, 40),
            Image.Resampling.LANCZOS
        )

        brand_font = ImageFont.truetype(
            str(ITALIC_FONT),
            30
        )

        brand = "The Lilamaya"

        text_box = draw.textbbox(
            (0, 0),
            brand,
            font=brand_font
        )

        text_width = text_box[2] - text_box[0]

        gap = 14

        total_width = (
            logo.width
            + gap
            + text_width
        )

        x = (
            WIDTH
            - total_width
        ) // 2

        y_brand = HEIGHT - 52

        canvas.paste(
            logo,
            (x, y_brand - 4),
            logo
        )

        draw.text(
            (
                x + logo.width + gap,
                y_brand
            ),
            brand,
            font=brand_font,
            fill=MUTED
        )

    output_file.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    canvas.save(output_file)