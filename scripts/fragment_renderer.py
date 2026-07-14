
from pathlib import Path
import frontmatter, markdown
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRAGMENTS_DIR = PROJECT_ROOT / "content" / "fragments"
OUTPUT_DIR = PROJECT_ROOT / "static" / "images" / "social" / "fragments"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

WIDTH, HEIGHT = 1200, 630
BACKGROUND = "#F8F5EF"

FONT_DIR = PROJECT_ROOT / "assets" / "fonts"
LOGO_PATH = PROJECT_ROOT / "static" / "images" / "tree-logo.png"

DATE_SIZE = 30
BODY_SIZE = 44
SIG_SIZE = 28

TREE_Y = 18
DIVIDER_Y = 86
DIVIDER_WIDTH = 380

DATE_Y = 114
BODY_Y = 170

DATE_BODY_GAP = 42
BODY_SIG_GAP = 42
SIG_NAME_GAP = 18
BOTTOM_MARGIN = 34
MAX_WIDTH = 700

LINE = "#6F7552"
TEXT = "#2B2B2B"
DATE = "#555555"

def fonts(body_size):
    return (
        ImageFont.truetype(str(FONT_DIR/"CormorantGaramond-Regular.ttf"), DATE_SIZE),
        ImageFont.truetype(str(FONT_DIR/"CormorantGaramond-Regular.ttf"), body_size),
        ImageFont.truetype(str(FONT_DIR/"CormorantGaramond-Italic.ttf"), SIG_SIZE),
    )

def center(draw, txt, font, y, fill):
    b = draw.textbbox((0,0), txt, font=font)
    x = (WIDTH-(b[2]-b[0]))/2
    draw.text((x,y), txt, font=font, fill=fill)

def wrap(draw, text, font):
    out=[]
    for para in text.split("\n"):
        if not para.strip():
            out.append("")
            continue
        words=para.split()
        line=""
        for w in words:
            t=w if not line else line+" "+w
            if draw.textbbox((0,0), t, font=font)[2] <= MAX_WIDTH:
                line=t
            else:
                out.append(line)
                line=w
        if line:
            out.append(line)
        out.append("")
    return out

for md in sorted(FRAGMENTS_DIR.glob("*.md")):
    if md.name.startswith("_"):
        continue

    post=frontmatter.load(md)
    html=markdown.markdown(post.content)
    text=BeautifulSoup(html,"html.parser").get_text("\n").strip()

    body_size=BODY_SIZE

    while True:
        date_font, body_font, sig_font = fonts(body_size)
        img=Image.new("RGB",(WIDTH,HEIGHT),BACKGROUND)
        draw=ImageDraw.Draw(img)

        lines=wrap(draw,text,body_font)
        y=BODY_Y
        for l in lines:
            y += (draw.textbbox((0,0),l,font=body_font)[3]+14) if l else 18

        sig_y=y+BODY_SIG_GAP
        name_y=sig_y+draw.textbbox((0,0),"⁂",font=sig_font)[3]+SIG_NAME_GAP
        end=name_y+draw.textbbox((0,0),"Lilamaya",font=sig_font)[3]

        if end <= HEIGHT-BOTTOM_MARGIN or body_size<=34:
            break
        body_size -= 2

    if LOGO_PATH.exists():
        logo=Image.open(LOGO_PATH).convert("RGBA")
        logo.thumbnail((52,52))
        img.paste(logo,((WIDTH-logo.width)//2,TREE_Y),logo)

    draw.line(((WIDTH-DIVIDER_WIDTH)//2,DIVIDER_Y,
               (WIDTH+DIVIDER_WIDTH)//2,DIVIDER_Y),
              fill=LINE,width=2)

    center(draw,post["date"].strftime("%d %B %Y"),date_font,DATE_Y,DATE)

    y=BODY_Y
    for l in lines:
        if l:
            center(draw,l,body_font,y,TEXT)
            y += draw.textbbox((0,0),l,font=body_font)[3]+14
        else:
            y += 18

    y += BODY_SIG_GAP
    center(draw,"⁂",sig_font,y,LINE)
    y += draw.textbbox((0,0),"⁂",font=sig_font)[3]+SIG_NAME_GAP
    center(draw,"Lilamaya",sig_font,y,LINE)

    img.save(OUTPUT_DIR/f"{md.stem}.png")
    print("Rendered",md.stem)
