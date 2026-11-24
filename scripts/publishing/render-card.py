"""Render ONE reviewed publication card inside a private candidate only."""
import sys,json,datetime,importlib
from pathlib import Path
root=Path(sys.argv[1]).resolve();spec=json.loads(Path(sys.argv[2]).read_text())
sys.path.insert(0,str(root/'scripts'))
kind=spec['type'];out=root/spec['output'];out.parent.mkdir(parents=True,exist_ok=True)
image=root/spec['hero'] if spec.get('hero') else None
if kind=='essays':importlib.import_module('essay_renderer').render(spec['title'],image,root/spec['selected'],out)
elif kind=='paintings':importlib.import_module('painting_renderer').render(spec['title'],spec['artist'],str(spec['year']),image,out)
elif kind=='fragments':importlib.import_module('fragment_renderer').render(spec['body'],datetime.date.fromisoformat(spec['date'][:10]).strftime('%d %B %Y'),out)
else:raise ValueError('Unsupported social-card profile')
