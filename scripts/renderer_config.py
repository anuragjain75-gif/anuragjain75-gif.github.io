from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

FONT_DIR = PROJECT_ROOT / "assets" / "fonts"

LOGO_PATH = PROJECT_ROOT / "static" / "images" / "tree-logo.png"


# ----------------------------------------------------
# Canvas
# ----------------------------------------------------

WIDTH = 1200
HEIGHT = 630


# ----------------------------------------------------
# Colours
# ----------------------------------------------------

BACKGROUND = "#F8F5EF"

TEXT = "#2B2B2B"

MUTED = "#555555"

OLIVE = "#6F7552"


# ----------------------------------------------------
# Fonts
# ----------------------------------------------------

REGULAR_FONT = FONT_DIR / "CormorantGaramond-Regular.ttf"

ITALIC_FONT = FONT_DIR / "CormorantGaramond-Italic.ttf"

BOLD_FONT = FONT_DIR / "CormorantGaramond-Bold.ttf"

BOLD_ITALIC_FONT = FONT_DIR / "CormorantGaramond-BoldItalic.ttf"


# ----------------------------------------------------
# Shared Typography
# ----------------------------------------------------

SIGNATURE_SIZE = 36

SIDE_MARGIN = 90

MAX_TEXT_WIDTH = 860

BOTTOM_MARGIN = 30


# ----------------------------------------------------
# Essay Layout
# ----------------------------------------------------

IMAGE_HEIGHT_RATIO = 0.65

TITLE_START = 50

TITLE_MIN = 36

TITLE_BOX_WIDTH = 860

TITLE_BOX_HEIGHT = 120

TITLE_TOP_MARGIN = 24

TITLE_SIGNATURE_GAP = 28

DESCRIPTION_SIZE = 30


# ----------------------------------------------------
# Fragment Layout
#
# (Values will be introduced gradually.)
# ----------------------------------------------------

FRAGMENT_BODY_START = 64

FRAGMENT_BODY_MIN = 48