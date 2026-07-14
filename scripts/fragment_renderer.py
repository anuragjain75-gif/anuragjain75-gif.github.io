# fragment_renderer_v9.py
# Social version: no date, no divider.
from pathlib import Path
import frontmatter, markdown
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont

PROJECT_ROOT=Path(__file__).resolve().parent.parent
FRAGMENTS_DIR=PROJECT_ROOT/'content'/'fragments'
OUTPUT_DIR=PROJECT_ROOT/'static'/'images'/'social'/'fragments'
OUTPUT_DIR.mkdir(parents=True,exist_ok=True)
WIDTH,HEIGHT=1200,630
BACKGROUND='#F8F5EF'
FONT_DIR=PROJECT_ROOT/'assets'/'fonts'
LOGO_PATH=PROJECT_ROOT/'static'/'images'/'tree-logo.png'
BODY_START=62; BODY_MIN=46; SIG_SIZE=34
TREE_Y=26; BODY_Y=110; MAX_WIDTH=860
LINE_GAP=20; PARA_GAP=28; BODY_SIG_GAP=42; SIG_NAME_GAP=16; BOTTOM_MARGIN=30
TEXT='#2B2B2B'; OLIVE='#6F7552'

def get_fonts(sz):
    return (
        ImageFont.truetype(str(FONT_DIR/'CormorantGaramond-Regular.ttf'),sz),
        ImageFont.truetype(str(FONT_DIR/'CormorantGaramond-Italic.ttf'),SIG_SIZE)
    )

def center(d,t,f,y,c):
    b=d.textbbox((0,0),t,font=f)
    d.text(((WIDTH-(b[2]-b[0]))/2,y),t,font=f,fill=c)

def wrap(d,text,font):
    out=[]
    for para in text.split('\n'):
        if not para.strip():
            out.append(''); continue
        line=''
        for w in para.split():
            trial=w if not line else line+' '+w
            if d.textbbox((0,0),trial,font=font)[2] <= MAX_WIDTH:
                line=trial
            else:
                out.append(line); line=w
        if line: out.append(line)
        out.append('')
    return out

for md in sorted(FRAGMENTS_DIR.glob('*.md')):
    if md.name.startswith('_'): continue
    post=frontmatter.load(md)
    txt=BeautifulSoup(markdown.markdown(post.content),'html.parser').get_text('\n').strip()
    size=BODY_START
    while True:
        body_font,sig_font=get_fonts(size)
        img=Image.new('RGB',(WIDTH,HEIGHT),BACKGROUND)
        draw=ImageDraw.Draw(img)
        lines=wrap(draw,txt,body_font)
        y=BODY_Y
        for ln in lines:
            if ln:
                y+=draw.textbbox((0,0),ln,font=body_font)[3]+LINE_GAP
            else:
                y+=PARA_GAP
        sh=draw.textbbox((0,0),'⁂',font=sig_font)[3]
        nh=draw.textbbox((0,0),'Lilamaya',font=sig_font)[3]
        if y+BODY_SIG_GAP+sh+SIG_NAME_GAP+nh <= HEIGHT-BOTTOM_MARGIN or size<=BODY_MIN:
            break
        size-=2
    if LOGO_PATH.exists():
        logo=Image.open(LOGO_PATH).convert('RGBA')
        logo.thumbnail((72,72))
        img.paste(logo,((WIDTH-logo.width)//2,TREE_Y),logo)
    y=BODY_Y
    for ln in lines:
        if ln:
            center(draw,ln,body_font,y,TEXT)
            y+=draw.textbbox((0,0),ln,font=body_font)[3]+LINE_GAP
        else:
            y+=PARA_GAP
    y+=BODY_SIG_GAP
    center(draw,'⁂',sig_font,y,OLIVE)
    y+=sh+SIG_NAME_GAP
    center(draw,'Lilamaya',sig_font,y,OLIVE)
    img.save(OUTPUT_DIR/f'{md.stem}.png')
    print('Rendered',md.stem)
