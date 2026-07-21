from PIL import Image, ImageDraw, ImageFont
from renderer_config import *


def load_font(size):
    return ImageFont.truetype(str(REGULAR_FONT), size)


SIGNATURE_FONT = ImageFont.truetype(
    str(ITALIC_FONT),
    SIGNATURE_SIZE,
)


def wrap(draw, text, font, width):
    words = text.split()
    lines = []
    line = ""

    for word in words:
        candidate = word if not line else f"{line} {word}"

        if draw.textbbox((0, 0), candidate, font=font)[2] <= width:
            line = candidate
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
            TITLE_BOX_WIDTH,
        )

        line_height = draw.textbbox(
            (0, 0),
            "Ag",
            font=font,
        )[3]

        total_height = (
            len(lines) * line_height
            + (len(lines) - 1) * 8
        )

        if total_height <= TITLE_BOX_HEIGHT:
            return (
                font,
                lines,
                line_height,
                total_height,
            )

    font = load_font(TITLE_MIN)

    lines = wrap(
        draw,
        title,
        font,
        TITLE_BOX_WIDTH,
    )

    line_height = draw.textbbox(
        (0, 0),
        "Ag",
        font=font,
    )[3]

    total_height = (
        len(lines) * line_height
        + (len(lines) - 1) * 8
    )

    return (
        font,
        lines,
        line_height,
        total_height,
    )


def render(
    layout,
    title,
    image,
    markdown_file,
    output_file,
):
    """
    Shared card renderer.

    Currently supports:

        layout="essay"

    Additional layouts (fragment, books, etc.)
    will be added without changing the public API.
    """

    if layout != "essay":
        raise ValueError(f"Unsupported layout: {layout}")

    canvas = Image.new(
        "RGB",
        (WIDTH, HEIGHT),
        BACKGROUND,
    )

    draw = ImageDraw.Draw(canvas)

    hero_height = int(HEIGHT * IMAGE_HEIGHT_RATIO)

    hero = Image.open(image).convert("RGB")

    source_ratio = hero.width / hero.height
    destination_ratio = WIDTH / hero_height

    if source_ratio > destination_ratio:
        new_height = hero_height
        new_width = int(hero.width * hero_height / hero.height)
    else:
        new_width = WIDTH
        new_height = int(hero.height * WIDTH / hero.width)

    hero = hero.resize(
        (new_width, new_height),
        Image.Resampling.LANCZOS,
    )

    left = (new_width - WIDTH) // 2
    top = (new_height - hero_height) // 2

    hero = hero.crop(
        (
            left,
            top,
            left + WIDTH,
            top + hero_height,
        )
    )

    canvas.paste(hero, (0, 0))

    title_top = hero_height + TITLE_TOP_MARGIN

    font, lines, line_height, total_height = fit_title(
        draw,
        title,
    )

    y = title_top + (TITLE_BOX_HEIGHT - total_height) / 2

    for line in lines:
        bbox = draw.textbbox(
            (0, 0),
            line,
            font=font,
        )

        x = (WIDTH - (bbox[2] - bbox[0])) / 2

        draw.text(
            (x, y),
            line,
            font=font,
            fill=TEXT,
        )

        y += line_height + 8

    signature_y = (
        title_top
        + TITLE_BOX_HEIGHT
        + TITLE_SIGNATURE_GAP
        - 14
    )

    if LOGO_PATH.exists():
        logo = Image.open(LOGO_PATH).convert("RGBA")

        logo.thumbnail((42, 42))

        text_bbox = draw.textbbox(
            (0, 0),
            "Lilamaya",
            font=SIGNATURE_FONT,
        )

        text_width = text_bbox[2] - text_bbox[0]

        gap = 12

        start_x = (
            WIDTH
            - (logo.width + gap + text_width)
        ) // 2

        canvas.paste(
            logo,
            (start_x, int(signature_y)),
            logo,
        )

        draw.text(
            (
                start_x + logo.width + gap,
                signature_y + 2,
            ),
            "Lilamaya",
            font=SIGNATURE_FONT,
            fill=OLIVE,
        )

    output_file.parent.mkdir(
        parents=True,from PIL import Image, ImageDraw, ImageFont
from renderer_config import *


def load_font(size):
    return ImageFont.truetype(str(REGULAR_FONT), size)


SIGNATURE_FONT = ImageFont.truetype(
    str(ITALIC_FONT),
    SIGNATURE_SIZE,
)


def wrap(draw, text, font, width):
    words = text.split()
    lines = []
    line = ""

    for word in words:
        candidate = word if not line else f"{line} {word}"

        if draw.textbbox((0, 0), candidate, font=font)[2] <= width:
            line = candidate
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
            TITLE_BOX_WIDTH,
        )

        line_height = draw.textbbox(
            (0, 0),
            "Ag",
            font=font,
        )[3]

        total_height = (
            len(lines) * line_height
            + (len(lines) - 1) * 8
        )

        if total_height <= TITLE_BOX_HEIGHT:
            return (
                font,
                lines,
                line_height,
                total_height,
            )

    font = load_font(TITLE_MIN)

    lines = wrap(
        draw,
        title,
        font,
        TITLE_BOX_WIDTH,
    )

    line_height = draw.textbbox(
        (0, 0),
        "Ag",
        font=font,
    )[3]

    total_height = (
        len(lines) * line_height
        + (len(lines) - 1) * 8
    )

    return (
        font,
        lines,
        line_height,
        total_height,
    )


def render(
    layout,
    title,
    image,
    markdown_file,
    output_file,
):
    """
    Shared card renderer.

    Currently supports:

        layout="essay"

    Additional layouts (fragment, books, etc.)
    will be added without changing the public API.
    """

    if layout != "essay":
        raise ValueError(f"Unsupported layout: {layout}")

    canvas = Image.new(
        "RGB",
        (WIDTH, HEIGHT),
        BACKGROUND,
    )

    draw = ImageDraw.Draw(canvas)

    hero_height = int(HEIGHT * IMAGE_HEIGHT_RATIO)

    hero = Image.open(image).convert("RGB")

    source_ratio = hero.width / hero.height
    destination_ratio = WIDTH / hero_height

    if source_ratio > destination_ratio:
        new_height = hero_height
        new_width = int(hero.width * hero_height / hero.height)
    else:
        new_width = WIDTH
        new_height = int(hero.height * WIDTH / hero.width)

    hero = hero.resize(
        (new_width, new_height),
        Image.Resampling.LANCZOS,
    )

    left = (new_width - WIDTH) // 2
    top = (new_height - hero_height) // 2

    hero = hero.crop(
        (
            left,
            top,
            left + WIDTH,
            top + hero_height,
        )
    )

    canvas.paste(hero, (0, 0))

    title_top = hero_height + TITLE_TOP_MARGIN

    font, lines, line_height, total_height = fit_title(
        draw,
        title,
    )

    y = title_top + (TITLE_BOX_HEIGHT - total_height) / 2

    for line in lines:
        bbox = draw.textbbox(
            (0, 0),
            line,
            font=font,
        )

        x = (WIDTH - (bbox[2] - bbox[0])) / 2

        draw.text(
            (x, y),
            line,
            font=font,
            fill=TEXT,
        )

        y += line_height + 8

    signature_y = (
        title_top
        + TITLE_BOX_HEIGHT
        + TITLE_SIGNATURE_GAP
        - 14
    )

    if LOGO_PATH.exists():
        logo = Image.open(LOGO_PATH).convert("RGBA")

        logo.thumbnail((42, 42))

        text_bbox = draw.textbbox(
            (0, 0),
            "Lilamaya",
            font=SIGNATURE_FONT,
        )

        text_width = text_bbox[2] - text_bbox[0]

        gap = 12

        start_x = (
            WIDTH
            - (logo.width + gap + text_width)
        ) // 2

        canvas.paste(
            logo,
            (start_x, int(signature_y)),
            logo,
        )

        draw.text(
            (
                start_x + logo.width + gap,
                signature_y + 2,
            ),
            "Lilamaya",
            font=SIGNATURE_FONT,
            fill=OLIVE,
        )

    output_file.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    canvas.save(output_file)
        exist_ok=True,
    )

    canvas.save(output_file)