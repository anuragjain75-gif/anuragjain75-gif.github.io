from pathlib import Path
import frontmatter
import markdown
from bs4 import BeautifulSoup

from PIL import Image
from PIL import ImageDraw
from PIL import ImageFont

# ----------------------------------------------------
# Paths
# ----------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent

FRAGMENTS_DIR = PROJECT_ROOT / "content" / "fragments"

OUTPUT_DIR = PROJECT_ROOT / "static" / "images" / "social" / "fragments"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ----------------------------------------------------
# Canvas
# ----------------------------------------------------

WIDTH = 1200
HEIGHT = 630

BACKGROUND = "#F8F5EF"

# ----------------------------------------------------
# Fonts
# ----------------------------------------------------

FONT_DIR = PROJECT_ROOT / "assets" / "fonts"

date_font = ImageFont.truetype(
    str(FONT_DIR / "CormorantGaramond-Regular.ttf"),
    30,
)

body_font = ImageFont.truetype(
    str(FONT_DIR / "CormorantGaramond-Regular.ttf"),
    46,
)

signature_font = ImageFont.truetype(
    str(FONT_DIR / "CormorantGaramond-Italic.ttf"),
    28,
)

# ----------------------------------------------------
# Helper Functions
# ----------------------------------------------------

def draw_centered(draw, text, font, y, fill):
    bbox = draw.textbbox((0, 0), text, font=font)

    text_width = bbox[2] - bbox[0]

    x = (WIDTH - text_width) / 2

    draw.text(
        (x, y),
        text,
        fill=fill,
        font=font,
    )

# ----------------------------------------------------
# Generate Cards
# ----------------------------------------------------

for md_file in sorted(FRAGMENTS_DIR.glob("*.md")):

    if md_file.name.startswith("_"):
        continue

    post = frontmatter.load(md_file)

    html = markdown.markdown(post.content)
    text = BeautifulSoup(html, "html.parser").get_text("\n").strip()

    date = post["date"].strftime("%d %B %Y")

    slug = md_file.stem

    image = Image.new(
        "RGB",
        (WIDTH, HEIGHT),
        BACKGROUND,
    )

    draw = ImageDraw.Draw(image)

    draw_centered(
        draw,
        date,
        date_font,
        80,
        "#555555",
    )

    draw_centered(
        draw,
        text,
        body_font,
        150,
        "#2B2B2B",
    )

    draw_centered(
        draw,
        "Lilamaya",
        signature_font,
        560,
        "#6F7552",
    )

    image.save(
        OUTPUT_DIR / f"{slug}.png"
    )

    print(f"Generated {slug}.png")
