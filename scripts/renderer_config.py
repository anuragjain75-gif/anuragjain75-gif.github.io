from pathlib import Path

# ----------------------------------------------------
# Project Paths
# ----------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent

FONT_DIR = PROJECT_ROOT / "assets" / "fonts"

LOGO_PATH = PROJECT_ROOT / "static" / "images" / "tree-logo.png"

# ----------------------------------------------------
# Canvas
# ----------------------------------------------------

WIDTH = 1200
HEIGHT = 630

BACKGROUND = "#F8F5EF"

# ----------------------------------------------------
# Colours
# ----------------------------------------------------

TEXT = "#2B2B2B"

MUTED = "#555555"

OLIVE = "#6F7552"

# ----------------------------------------------------
# Fonts
# ----------------------------------------------------

REGULAR_FONT = FONT_DIR / "CormorantGaramond-Regular.ttf"

ITALIC_FONT = FONT_DIR / "CormorantGaramond-Italic.ttf"

BOLD_FONT = FONT_DIR / "CormorantGaramond-Bold.ttf"

# ----------------------------------------------------
# Fragment Typography
# ----------------------------------------------------

FRAGMENT_BODY_START = 64
FRAGMENT_BODY_MIN = 48

SIGNATURE_SIZE = 34

# ----------------------------------------------------
# Essay Typography
# ----------------------------------------------------

TITLE_SIZE = 54

DESCRIPTION_SIZE = 30

# ----------------------------------------------------
# Shared Layout
# ----------------------------------------------------

MAX_TEXT_WIDTH = 860

BOTTOM_MARGIN = 30