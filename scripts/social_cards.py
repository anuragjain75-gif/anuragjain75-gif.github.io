"""Single-document derived cards. Never writes manuscripts or original images."""
from pathlib import Path
import os, re, json, hashlib, uuid, fcntl, importlib, sys, shutil
import frontmatter
import yaml
from PIL import Image, __version__ as PILLOW_VERSION
ROOT=Path(__file__).absolute().parent.parent
STATE='backups/editor-derived/social-cards'
class CardError(Exception):pass
def digest(data):return hashlib.sha256(data).hexdigest()
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def directory(relative,create=False):
 fd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in relative.split('/'):
   if part in ['','.', '..']:raise CardError('Unsafe directory')
   if create:
    try:os.mkdir(part,0o700,dir_fd=fd)
    except FileExistsError:pass
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
  return fd
 except Exception:os.close(fd);raise
def read(relative,optional=False):
 try:
  parent,name=relative.rsplit('/',1);dfd=directory(parent)
  try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dfd)
  finally:os.close(dfd)
  with os.fdopen(fd,'rb') as stream:
   a=os.fstat(stream.fileno());import stat
   if not stat.S_ISREG(a.st_mode):raise CardError('Only regular card resources are allowed')
   data=stream.read();b=os.fstat(stream.fileno())
   import stat
   if not stat.S_ISREG(a.st_mode) or (a.st_ino,a.st_dev,a.st_size,a.st_mtime_ns,a.st_ctime_ns)!=(b.st_ino,b.st_dev,b.st_size,b.st_mtime_ns,b.st_ctime_ns):raise CardError('Resource changed during read')
   return data
 except FileNotFoundError:
  if optional:return None
  raise CardError('Required card input is missing')
def atomic(relative,data):
 parent,name=relative.rsplit('/',1);fd=directory(parent,True);tmp='.'+name+'-'+uuid.uuid4().hex;created=None
 try:
  out=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
  created=os.fstat(out)
  with os.fdopen(out,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
  # Refuse a symlink/nonregular destination, including receipts and derived cards.
  read(relative,True)
  os.replace(tmp,name,src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
 finally:
  if created is not None:
   try:
    now=os.stat(tmp,dir_fd=fd,follow_symlinks=False)
    if (now.st_dev,now.st_ino)==(created.st_dev,created.st_ino):os.unlink(tmp,dir_fd=fd)
   except FileNotFoundError:pass
  os.close(fd)
def remove_state(relative):
 read(relative);parent,name=relative.rsplit('/',1);fd=directory(parent)
 try:os.unlink(name,dir_fd=fd);os.fsync(fd)
 finally:os.close(fd)
def identity(document):
 m=re.fullmatch(r'content/(essays|paintings)/([a-z0-9-]+)/index\.md',document)
 if not m:raise CardError('Only Essay and Painting bundles support social cards')
 kind,slug=m.groups();return kind,slug,kind+'-'+slug,'static/images/social/'+kind+'/'+slug+'.png'
class UniqueLoader(yaml.SafeLoader):pass
def mapping(loader,node,deep=False):
 result={}
 for key,value in node.value:
  k=loader.construct_object(key,deep=deep)
  if k in result:raise CardError('Duplicate frontmatter keys')
  result[k]=loader.construct_object(value,deep=deep)
 return result
UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,mapping)
def inputs(document,expected):
 kind,slug,key,output=identity(document);source=read(document)
 if digest(source)!=expected:raise CardError('The saved manuscript changed; retry against its current revision')
 text=source.decode('utf8');header=re.match(r'^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)',text)
 if not header:raise CardError('Unambiguous frontmatter is required')
 for token in yaml.scan(header[1]):
  if isinstance(token,(yaml.tokens.AnchorToken,yaml.tokens.AliasToken,yaml.tokens.TagToken)):raise CardError('Unsupported frontmatter aliases or tags')
 data=yaml.load(header[1],Loader=UniqueLoader)
 if not isinstance(data,dict) or not isinstance(data.get('title'),str) or not data['title'].strip():raise CardError('A title is required')
 # Retain the existing frontmatter dependency/conventions without rewriting source.
 post=frontmatter.loads(text)
 parent=document.rsplit('/',1)[0];hero=None;state='legacy'
 if 'hero' in data:
  value=data['hero']
  if value is False:state='none'
  elif isinstance(value,str) and re.fullmatch(r'images/[a-z0-9][a-z0-9_-]{0,79}\.(jpg|jpeg|png|webp)',value):hero=parent+'/'+value;state='explicit'
  else:raise CardError('Invalid explicit hero reference')
 else:
  fd=directory(parent)
  try:names=[n for n in os.listdir(fd) if n.lower().startswith('hero.')]
  finally:os.close(fd)
  if len(names)>1:raise CardError('Multiple legacy hero resources are ambiguous; select an explicit hero')
  if names:
   if not re.fullmatch(r'hero\.(png|jpg|jpeg|webp|gif)',names[0]):raise CardError('Unsupported legacy hero resource')
   hero=parent+'/'+names[0]
 image=read(hero) if hero else None
 if image:
  import io
  with Image.open(io.BytesIO(image)) as im:
   im.verify();fmt=im.format
  expected_format={'jpg':'JPEG','jpeg':'JPEG','png':'PNG','webp':'WEBP','gif':'GIF'}[hero.rsplit('.',1)[1]]
  if fmt!=expected_format:raise CardError('Hero format and extension differ')
 dependency=['scripts/social_cards.py','scripts/renderer_config.py','scripts/'+('essay_renderer.py' if kind=='essays' else 'painting_renderer.py'),'assets/fonts/CormorantGaramond-Regular.ttf','assets/fonts/CormorantGaramond-Italic.ttf']
 deps={p:digest(read(p)) for p in dependency}
 for p in ['static/images/tree-logo.png','assets/textures/washi.png']:
  content=read(p,True);deps[p]=digest(content) if content is not None else None
 artist=str(post.get('artist',''));year=str(post.get('year',''))
 relevant={'pillowVersion':PILLOW_VERSION,'type':kind,'title':data['title'],'heroState':state,'heroPath':hero,'imageHash':digest(image) if image else None,'dependencies':deps}
 if kind=='paintings':relevant.update(artist=artist,year=year)
 return {'fingerprint':digest(encoded(relevant)),'sourceHash':expected,'output':output,'key':key,'signal':'data/lilamaya_social_cards/'+kind+'/'+slug+'.json','kind':kind,'hero':hero,'image':image,'title':data['title'],'artist':artist,'year':year,'dependencies':deps}
def paths(info):return STATE+'/'+info['key']+'.json',STATE+'/'+info['key']+'.pending.json'
def receipt(info):
 raw=read(paths(info)[0],True)
 try:return json.loads(raw) if raw else {}
 except ValueError:return {}
def current(info):
 if read(paths(info)[1],True) is not None:return False
 card=read(info['output'],True);r=receipt(info)
 signal=read(info['signal'],True)
 return card is not None and signal==encoded({'cardHash':digest(card)}) and r.get('fingerprint')==info['fingerprint'] and r.get('cardHash')==digest(card) and not r.get('stale')
def recover(info):
 rec,journal=paths(info);pending=read(journal,True)
 if not pending:return
 p=json.loads(pending)
 old_signal=bytes.fromhex(p['oldSignal']) if p.get('oldSignal') is not None else None
 if p.get('backup') is not None and not re.fullmatch(re.escape(STATE+'/'+info['key'])+r'-prior-[a-f0-9]{32}\.png',p['backup']):raise CardError('Invalid pending card recovery record')
 card=read(info['output'],True);actual=digest(card) if card else None
 if actual==p['newHash']:
  if receipt(info).get('cardHash')!=p['newHash']:
   if p['backup'] is not None:atomic(info['output'],read(p['backup']))
   else:remove_state(info['output']) # only our hash-proven newly generated card
 elif actual!=p['oldHash']:raise CardError('Card changed during interrupted update; manual review is required')
 signal=read(info['signal'],True);new_signal=encoded({'cardHash':p['newHash']})
 if receipt(info).get('cardHash')==p['newHash'] and actual==p['newHash']:
  if signal!=new_signal:atomic(info['signal'],new_signal)
 elif signal==new_signal:
  if old_signal is None:remove_state(info['signal'])
  else:atomic(info['signal'],old_signal)
 elif signal!=old_signal:raise CardError('Card rebuild signal changed concurrently; manual review is required')
 remove_state(journal)
def run(document,expected,check=False):
 info=inputs(document,expected)
 if check:return {'status':'current' if current(info) else 'stale','sourceHash':expected}
 fd=directory(STATE+'/locks',True);lock=None
 try:
  lock=os.open(info['key']+'.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=fd)
  import stat
  if not stat.S_ISREG(os.fstat(lock).st_mode):raise CardError('Invalid card lock')
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise CardError('Another card update is running; retry shortly')
  recover(info);info=inputs(document,expected)
  if current(info):return {'status':'current','sourceHash':expected,'cardHash':receipt(info)['cardHash']}
  # Render only immutable copied hero bytes, never a changing original image.
  tempname='.social-'+uuid.uuid4().hex;statefd=directory(STATE,True)
  try:os.mkdir(tempname,0o700,dir_fd=statefd);tmpfd=os.open(tempname,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=statefd)
  finally:os.close(statefd)
  tmp=Path('/proc/self/fd')/str(tmpfd)
  try:
   image=None
   if info['image'] is not None:image=tmp/('hero.'+info['hero'].rsplit('.',1)[1]);image.write_bytes(info['image'])
   output=tmp/'card.png';module=importlib.import_module('essay_renderer' if info['kind']=='essays' else 'painting_renderer')
   args={'title':info['title'],'image':image,'output_file':output}
   if info['kind']=='essays':args['markdown_file']=ROOT/document
   else:args.update(artist=info['artist'],year=info['year'])
   module.render(**args)
   with Image.open(output) as im:
    im.load()
    if im.format!='PNG' or im.size!=(1200,630):raise CardError('Renderer produced an invalid card')
   card=output.read_bytes();fresh=inputs(document,expected)
   if fresh['fingerprint']!=info['fingerprint']:raise CardError('Card inputs changed during rendering; retry')
   previous=read(info['output'],True);backup=STATE+'/'+info['key']+'-prior-'+uuid.uuid4().hex+'.png' if previous is not None else None
   if backup:atomic(backup,previous)
   rec,journal=paths(info);newhash=digest(card);oldSignal=read(info['signal'],True);pending={'oldHash':digest(previous) if previous else None,'newHash':newhash,'backup':backup,'oldSignal':oldSignal.hex() if oldSignal is not None else None};atomic(journal,encoded(pending))
   try:
    # Recheck all inputs immediately before replacing the derived file.
    if inputs(document,expected)['fingerprint']!=info['fingerprint']:raise CardError('Card inputs changed before publication')
    if read(info['output'],True)!=previous:raise CardError('The previous card changed concurrently')
    atomic(info['output'],card)
    if inputs(document,expected)['fingerprint']!=info['fingerprint']:raise CardError('Card inputs changed before acknowledgment')
    atomic(info['signal'],encoded({'cardHash':newhash}))
    atomic(rec,encoded({'fingerprint':info['fingerprint'],'cardHash':newhash,'sourceHash':expected,'stale':False}));remove_state(journal)
   except Exception:
    recover(info);raise
   return {'status':'updated','sourceHash':expected,'cardHash':newhash}
  finally:
   # Only files created in this private per-job scratch directory are removed.
   for name in os.listdir(tmpfd):os.unlink(name,dir_fd=tmpfd)
   os.close(tmpfd);parentfd=directory(STATE)
   try:os.rmdir(tempname,dir_fd=parentfd)
   finally:os.close(parentfd)
 finally:
  if lock is not None:os.close(lock)
  os.close(fd)
def execute(document,expected,check=False):
 try:return run(document,expected,check)
 except Exception as error:
  message=str(error) if isinstance(error,CardError) else 'Card rendering or storage failed; the manuscript is saved and previous card is retained where recovery can be proven'
  return {'status':'failed','sourceHash':expected,'message':message,'retryable':True}
def main(kind=None):
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('--document');parser.add_argument('--source-sha');parser.add_argument('--check',action='store_true');a=parser.parse_args()
 if a.document:
  if kind and identity(a.document)[0]!=kind:raise CardError('Wrong content type')
  expected=a.source_sha or digest(read(a.document));result=execute(a.document,expected,a.check);print(json.dumps(result));return 1 if result['status']=='failed' else 0
 if not kind:parser.error('--document is required')
 failed=False
 for path in sorted((ROOT/'content'/kind).glob('*/index.md')):
  relative=str(path.relative_to(ROOT));result=execute(relative,digest(read(relative)),a.check);print(json.dumps({'document':relative,**result}));failed=failed or result['status']=='failed'
 return int(failed)
if __name__=='__main__':sys.exit(main())
