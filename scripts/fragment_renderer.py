# fragment_renderer_v8.py
# Social-feed optimized renderer
from pathlib import Path
import frontmatter, markdown
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont

PROJECT_ROOT=Path(__file__).resolve().parent.parent
FRAGMENTS_DIR=PROJECT_ROOT/"content"/"fragments"
OUTPUT_DIR=PROJECT_ROOT/"static"/"images"/"social"/"fragments"
OUTPUT_DIR.mkdir(parents=True,exist_ok=True)
WIDTH,HEIGHT=1200,630
BACKGROUND="#F8F5EF"
FONT_DIR=PROJECT_ROOT/"assets"/"fonts"
LOGO_PATH=PROJECT_ROOT/"static"/"images"/"tree-logo.png"
DATE_SIZE=36
BODY_START=56
BODY_MIN=42
SIG_SIZE=32
TREE_Y=18
DIVIDER_Y=86
DIVIDER_WIDTH=340
DIVIDER_THICKNESS=3
DATE_Y=122
BODY_Y=185
BODY_SIG_GAP=36
SIG_NAME_GAP=18
BOTTOM_MARGIN=28
MAX_WIDTH=820
LINE="#6F7552";TEXT="#2B2B2B";DATE="#555555"
def get_fonts(bs):
    return (
        ImageFont.truetype(str(FONT_DIR/"CormorantGaramond-Regular.ttf"),DATE_SIZE),
        ImageFont.truetype(str(FONT_DIR/"CormorantGaramond-Regular.ttf"),bs),
        ImageFont.truetype(str(FONT_DIR/"CormorantGaramond-Italic.ttf"),SIG_SIZE)
    )
def center(d,t,f,y,c):
    b=d.textbbox((0,0),t,font=f)
    d.text(((WIDTH-(b[2]-b[0]))/2,y),t,font=f,fill=c)
def wrap(d,text,f):
    out=[]
    for para in text.split("\n"):
        if not para.strip():
            out.append("");continue
        line=""
        for w in para.split():
            trial=w if not line else line+" "+w
            if d.textbbox((0,0),trial,font=f)[2]<=MAX_WIDTH:
                line=trial
            else:
                out.append(line);line=w
        if line: out.append(line)
        out.append("")
    return out
for md in sorted(FRAGMENTS_DIR.glob("*.md")):
    if md.name.startswith("_"): continue
    post=frontmatter.load(md)
    txt=BeautifulSoup(markdown.markdown(post.content),"html.parser").get_text("\n").strip()
    bs=BODY_START
    while True:
        df,bf,sf=get_fonts(bs)
        img=Image.new("RGB",(WIDTH,HEIGHT),BACKGROUND)
        d=ImageDraw.Draw(img)
        lines=wrap(d,txt,bf)
        y=BODY_Y
        for l in lines:
            if l:
                h=d.textbbox((0,0),l,font=bf)[3]+18
            else:
                h=24
            y+=h
        sh=d.textbbox((0,0),"⁂",font=sf)[3]
        nh=d.textbbox((0,0),"Lilamaya",font=sf)[3]
        if y+BODY_SIG_GAP+sh+SIG_NAME_GAP+nh<=HEIGHT-BOTTOM_MARGIN or bs<=BODY_MIN:
            break
        bs-=2
    if LOGO_PATH.exists():
        logo=Image.open(LOGO_PATH).convert("RGBA")
        logo.thumbnail((68,68))
        img.paste(logo,((WIDTH-logo.width)//2,TREE_Y),logo)
    d.line(((WIDTH-DIVIDER_WIDTH)//2,DIVIDER_Y,(WIDTH+DIVIDER_WIDTH)//2,DIVIDER_Y),fill=LINE,width=DIVIDER_THICKNESS)
    center(d,post["date"].strftime("%d %B %Y"),df,DATE_Y,DATE)
    y=BODY_Y
    for l in lines:
        if l:
            center(d,l,bf,y,TEXT)
            y+=d.textbbox((0,0),l,font=bf)[3]+18
        else:
            y+=24
    y+=BODY_SIG_GAP
    center(d,"⁂",sf,y,LINE)
    y+=sh+SIG_NAME_GAP
    center(d,"Lilamaya",sf,y,LINE)
    img.save(OUTPUT_DIR/f"{md.stem}.png")
    print("Rendered",md.stem)
