from pathlib import Path

import frontmatter

from essay_renderer import render


# ----------------------------------------------------
# Paths
# ----------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent

ESSAYS_DIR = PROJECT_ROOT / "content" / "essays"

OUTPUT_DIR = (
    PROJECT_ROOT
    / "static"
    / "images"
    / "social"
    / "essays"
)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ----------------------------------------------------
# Supported Hero Image Extensions
# ----------------------------------------------------

IMAGE_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
)


# ----------------------------------------------------
# Find Hero Image
# ----------------------------------------------------

def find_hero(bundle: Path):

    for ext in IMAGE_EXTENSIONS:

        hero = bundle / f"hero{ext}"

        if hero.exists():
            return hero

    return None


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

    hero = find_hero(bundle)

    if hero is None:

        print(f"Skipping {bundle.name}: no hero image found.")

        continue

    render(
        title=post["title"],
        image=hero,
        markdown_file=md_file,
        output_file=OUTPUT_DIR / f"{bundle.name}.png",
    )

    print(f"Rendered {bundle.name}")