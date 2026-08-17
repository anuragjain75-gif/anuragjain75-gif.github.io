from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from renderer_config import *


# ------------------------------------------------------------
# Typography
# ------------------------------------------------------------

TITLE_FONT = ImageFont.truetype(
    str(REGULAR_FONT),
    46
)

META_FONT = ImageFont.truetype(
    str(REGULAR_FONT),
    28
)

BRAND_FONT = ImageFont.truetype(
    str(ITALIC_FONT),
    30
)


# ------------------------------------------------------------
# Text helpers
# ------------------------------------------------------------

def line_width(draw, text, font):

    bbox = draw.textbbox(
        (0, 0),
        text,
        font=font
    )

    return bbox[2] - bbox[0]


# ------------------------------------------------------------
# Washi background
# ------------------------------------------------------------

def apply_washi_texture(canvas):

    texture_path = (
        PROJECT_ROOT
        / "assets"
        / "textures"
        / "washi.png"
    )

    if not texture_path.exists():
        return canvas

    texture = (
        Image.open(texture_path)
        .convert("RGBA")
        .resize(canvas.size)
    )

    texture.putalpha(14)

    return Image.alpha_composite(
        canvas.convert("RGBA"),
        texture
    ).convert("RGB")


# ------------------------------------------------------------
# Branding
# ------------------------------------------------------------

def draw_branding(canvas, draw):

    if not LOGO_PATH.exists():
        return

    logo = (
        Image.open(LOGO_PATH)
        .convert("RGBA")
    )

    logo.thumbnail(
        (40, 40),
        Image.Resampling.LANCZOS
    )

    brand = "The Lilamaya"

    text_box = draw.textbbox(
        (0, 0),
        brand,
        font=BRAND_FONT
    )

    text_width = (
        text_box[2] -
        text_box[0]
    )

    gap = 14

    total_width = (
        logo.width +
        gap +
        text_width
    )

    x = (
        WIDTH -
        total_width
    ) // 2

    y = HEIGHT - 50

    canvas.paste(
        logo,
        (
            x,
            y - 5
        ),
        logo
    )

    draw.text(
        (
            x +
            logo.width +
            gap,
            y
        ),
        brand,
        font=BRAND_FONT,
        fill=TEXT
    )


# ------------------------------------------------------------
# Painting fitting
# ------------------------------------------------------------

def fit_painting(
    image,
    max_width,
    max_height
):

    source_width = image.width
    source_height = image.height

    scale = min(
        max_width / source_width,
        max_height / source_height
    )

    width = max(
        1,
        int(source_width * scale)
    )

    height = max(
        1,
        int(source_height * scale)
    )

    return image.resize(
        (
            width,
            height
        ),
        Image.Resampling.LANCZOS
    )


# ------------------------------------------------------------
# Main renderer
# ------------------------------------------------------------

def render(
    title,
    artist,
    year,
    image,
    output_file
):

    canvas = Image.new(
        "RGB",
        (
            WIDTH,
            HEIGHT
        ),
        BACKGROUND
    )

    canvas = apply_washi_texture(
        canvas
    )

    draw = ImageDraw.Draw(
        canvas
    )

    # --------------------------------------------------------
    # Painting
    # --------------------------------------------------------

    painting = (
        Image.open(image)
        .convert("RGB")
    )

    # Generous adaptive image area.
    #
    # The artwork is NEVER cropped or distorted.
    # Its natural aspect ratio determines its final size.
    #
    # These are maximum bounds rather than fixed dimensions,
    # so landscape, square and portrait paintings are all
    # handled automatically.

    painting_area_width = 1080
    painting_area_height = 455

    painting = fit_painting(
        painting,
        painting_area_width,
        painting_area_height
    )

    painting_x = (
        WIDTH -
        painting.width
    ) // 2

    painting_y = 30

    canvas.paste(
        painting,
        (
            painting_x,
            painting_y
        )
    )

    painting_bottom = (
        painting_y +
        painting.height
    )

    # --------------------------------------------------------
    # Title
    # --------------------------------------------------------

    title_width = line_width(
        draw,
        title,
        TITLE_FONT
    )

    title_y = (
        painting_bottom +
        18
    )

    draw.text(
        (
            (WIDTH - title_width) / 2,
            title_y
        ),
        title,
        font=TITLE_FONT,
        fill=TEXT
    )

    # --------------------------------------------------------
    # Artist / year
    # --------------------------------------------------------

    metadata = artist.strip()

    if year.strip():
        metadata += f" · {year.strip()}"

    if metadata:

        metadata_width = line_width(
            draw,
            metadata,
            META_FONT
        )

        metadata_y = (
            title_y +
            50
        )

        draw.text(
            (
                (WIDTH - metadata_width) / 2,
                metadata_y
            ),
            metadata,
            font=META_FONT,
            fill=MUTED
        )

    # --------------------------------------------------------
    # Branding
    # --------------------------------------------------------

    draw_branding(
        canvas,
        draw
    )

    # --------------------------------------------------------
    # Save
    # --------------------------------------------------------

    output_file.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    canvas.save(
        output_file,
        quality=95
    )
