from pathlib import Path
import re

import frontmatter

from essay_renderer import render


# ----------------------------------------------------
# Paths
# ----------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent

ESSAYS_DIR = PROJECT_ROOT / "content" / "essays"

OUTPUT_DIR = PROJECT_ROOT / "static" / "images" / "social" / "essays"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ----------------------------------------------------
# Markdown Image Extraction
# ----------------------------------------------------

IMAGE_PATTERN = re.compile(r"!\[[^\]]*]\(([^)]+)\)")


def find_first_image(markdown_text: str):
    match = IMAGE_PATTERN.search(markdown_text)

    if not match:
        return None

    image_path = match.group(1)

    return image_path


# ----------------------------------------------------
# Generate Cards
# ----------------------------------------------------

for md_file in sorted(ESSAYS_DIR.glob("*.md")):

    if md_file.name.startswith("_"):
        continue

    post = frontmatter.load(md_file)

    title = post["title"]

    slug = md_file.stem

    image = find_first_image(post.content)

    render(
        title=title,
        image=image,
        markdown_file=md_file,
        output_file=OUTPUT_DIR / f"{slug}.png",
    )

    print(f"Rendered {slug}")