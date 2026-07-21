from pathlib import Path
import frontmatter

from fragment_renderer import render

PROJECT_ROOT = Path(__file__).resolve().parent.parent

FRAGMENTS_DIR = PROJECT_ROOT / "content" / "fragments"
OUTPUT_DIR = PROJECT_ROOT / "static" / "images" / "social" / "fragments"


def clean_fragment(text: str) -> str:
    """
    Remove Hugo shortcodes and normalize whitespace.
    """

    replacements = [
        "{{< invocation >}}",
        "{{< /invocation >}}",
        "{{< blockquote >}}",
        "{{< /blockquote >}}",
        "{{< pullquote >}}",
        "{{< /pullquote >}}",
    ]

    for item in replacements:
        text = text.replace(item, "")

    return text.strip()


def main():

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for bundle in sorted(FRAGMENTS_DIR.iterdir()):

        if not bundle.is_dir():
            continue

        markdown = bundle / "index.md"

        if not markdown.exists():
            continue

        post = frontmatter.load(markdown)

        fragment = post.content

        date = post.get("date")

        if date:
            date_text = date.strftime("%d %B %Y")
        else:
            date_text = ""

        output_file = OUTPUT_DIR / f"{bundle.name}.png"

        render(
    fragment_text=fragment,
    date_text=date_text,
    output_path=output_file,
)

        print(f"✓ {bundle.name}")

    print()
    print("Finished generating fragment cards.")


if __name__ == "__main__":
    main()