from pathlib import Path

import frontmatter

from painting_renderer import render


# ------------------------------------------------------------
# Paths
# ------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent

PAINTINGS_DIR = (
    PROJECT_ROOT /
    "content" /
    "paintings"
)

OUTPUT_DIR = (
    PROJECT_ROOT /
    "static" /
    "images" /
    "social" /
    "paintings"
)


# ------------------------------------------------------------
# Supported Hero Image Extensions
# ------------------------------------------------------------

IMAGE_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
)


# ------------------------------------------------------------
# Find Hero
# ------------------------------------------------------------

def find_hero(bundle: Path):

    for ext in IMAGE_EXTENSIONS:

        hero = bundle / f"hero{ext}"

        if hero.exists():
            return hero

    return None


# ------------------------------------------------------------
# Generate Cards
# ------------------------------------------------------------

def main():

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    if not PAINTINGS_DIR.exists():

        print(
            "No paintings directory found."
        )

        return

    for bundle in sorted(
        PAINTINGS_DIR.iterdir()
    ):

        if not bundle.is_dir():
            continue

        md_file = bundle / "index.md"

        if not md_file.exists():
            continue

        post = frontmatter.load(
            md_file
        )

        hero = find_hero(bundle)

        if hero is None:

            print(
                f"Skipping {bundle.name}: "
                "no hero image found."
            )

            continue

        artist = str(
            post.get(
                "artist",
                ""
            )
        )

        year = str(
            post.get(
                "year",
                ""
            )
        )

        render(
            title=str(
                post["title"]
            ),
            artist=artist,
            year=year,
            image=hero,
            output_file=(
                OUTPUT_DIR /
                f"{bundle.name}.png"
            )
        )

        print(
            f"Rendered {bundle.name}"
        )

    print()
    print(
        "Finished generating painting cards."
    )


if __name__ == "__main__":
    main()
