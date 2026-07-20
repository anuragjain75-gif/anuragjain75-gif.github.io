
from PIL import Image, ImageDraw, ImageFont
from renderer_config import *

def load_font(size):
    return ImageFont.truetype(str(REGULAR_FONT), size)

SIGNATURE_FONT = ImageFont.truetype(str(ITALIC_FONT), SIGNATURE_SIZE)

def wrap(draw,text,font,width):
    words=text.split(); lines=[]; line=""
    for w in words:
        t=w if not line else line+" "+w
        if draw.textbbox((0,0),t,font=font)[2] <= width:
            line=t
        else:
            lines.append(line); line=w
    if line: lines.append(line)
    return lines

def fit_title(draw,title):
    for s in range(TITLE_START,TITLE_MIN-1,-2):
        f=load_font(s)
        lines=wrap(draw,title,f,TITLE_BOX_WIDTH)
        lh=draw.textbbox((0,0),"Ag",font=f)[3]
        total=len(lines)*lh+(len(lines)-1)*8
        if total<=TITLE_BOX_HEIGHT:
            return f,lines,lh,total
    f=load_font(TITLE_MIN)
    lines=wrap(draw,title,f,TITLE_BOX_WIDTH)
    lh=draw.textbbox((0,0),"Ag",font=f)[3]
    total=len(lines)*lh+(len(lines)-1)*8
    return f,lines,lh,total

def render(title,image,markdown_file,output_file):
    canvas=Image.new("RGB",(WIDTH,HEIGHT),BACKGROUND)
    draw=ImageDraw.Draw(canvas)
    hero_h=int(HEIGHT*IMAGE_HEIGHT_RATIO)
    hero=Image.open(image).convert("RGB")
    sr=hero.width/hero.height; dr=WIDTH/hero_h
    if sr>dr:
        nh=hero_h; nw=int(hero.width*hero_h/hero.height)
    else:
        nw=WIDTH; nh=int(hero.height*WIDTH/hero.width)
    hero=hero.resize((nw,nh),Image.Resampling.LANCZOS)
    l=(nw-WIDTH)//2; t=(nh-hero_h)//2
    hero=hero.crop((l,t,l+WIDTH,t+hero_h))
    canvas.paste(hero,(0,0))
    top=hero_h+TITLE_TOP_MARGIN
    font,lines,lh,total=fit_title(draw,title)
    y=top+(TITLE_BOX_HEIGHT-total)/2
    for line in lines:
        bb=draw.textbbox((0,0),line,font=font)
        x=(WIDTH-(bb[2]-bb[0]))/2
        draw.text((x,y),line,font=font,fill=TEXT)
        y+=lh+8
    sy=top+TITLE_BOX_HEIGHT+TITLE_SIGNATURE_GAP - 14
    if LOGO_PATH.exists():
        logo=Image.open(LOGO_PATH).convert("RGBA"); logo.thumbnail((42,42))
        tb=draw.textbbox((0,0),"Lilamaya",font=SIGNATURE_FONT)
        tw=tb[2]-tb[0]; gap=12
        sx=(WIDTH-(logo.width+gap+tw))//2
        canvas.paste(logo,(sx,int(sy)),logo)
        draw.text((sx+logo.width+gap,sy+2),"Lilamaya",font=SIGNATURE_FONT,fill=OLIVE)
    output_file.parent.mkdir(parents=True,exist_ok=True)
    canvas.save(output_file)