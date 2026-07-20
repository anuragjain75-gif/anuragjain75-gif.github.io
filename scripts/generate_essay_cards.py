from pathlib import Path

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
# Supported hero image extensions
# ----------------------------------------------------

IMAGE_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
)


# ----------------------------------------------------
# Generate Cards
# ----------------------------------------------------

for bundle in sorted(ESSAYS_DIR.iterdir()):

    if not bundle.is_dir():
        continue

    md_file = bundle / "index.md"

    if not md_file.exists():
        continue

    post = frontmatter.load(md_file)

    title = post["title"]

    hero = None

    for ext in IMAGE_EXTENSIONS:
        candidate = bundle / f"hero{ext}"

        if candidate.exists():
            hero = candidate
            break

    if hero is None:
        print(f"Skipping {bundle.name}: no hero image found.")
        continue

    render(
        title=title,
        image=hero,
        markdown_file=md_file,
        output_file=OUTPUT_DIR / f"{bundle.name}.png",
    )

    print(f"Rendered {bundle.name}")