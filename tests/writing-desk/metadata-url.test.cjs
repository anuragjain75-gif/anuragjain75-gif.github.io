const test=require('node:test'),assert=require('node:assert/strict');
const {assertStableURL,csv}=require('../../scripts/lilamaya-metadata-url.cjs');
const config=Buffer.from('baseURL = "https://example.invalid/"\n[taxonomies]\ntheme="themes"\nfragmenttheme="fragmentthemes"\npaintingtheme="paintingthemes"\n[permalinks]\nfragments="/fragments/:year/:month/:day/:slug/"\n');
const src=(title,date,extra='')=>'---\ntitle: "'+title+'"\ndate: '+date+'\ndraft: true\n'+extra+'---\n\n{{< introduction >}}\n\nBody नमस्ते.\n';
function files(p,s){return new Map([['hugo.toml',config],[p,Buffer.from(s)],['layouts/shortcodes/introduction.html',Buffer.from('<p>{{ .Page.Params.introduction }}</p>')]]);}
for(const kind of ['essays','paintings'])test(kind+' title/date stable at bundle path',()=>{const p='content/'+kind+'/fixed/index.md',old=src('Old','2026-05-28'),next=src('New','2026-05-29');assert.deepEqual(assertStableURL(files(p,old),p,next,'/'+kind+'/fixed/'),{before:'/'+kind+'/fixed/',after:'/'+kind+'/fixed/'})});
for(const p of ['content/fragments/standalone.md','content/fragments/bundle/index.md']){
 test('Fragment retitle rejects '+p,()=>{const old=src('Old title','2026-05-28');assert.throws(()=>assertStableURL(files(p,old),p,src('New title','2026-05-28')),/would change/)});
 test('Fragment date change rejects '+p,()=>{const old=src('Old title','2026-05-28');assert.throws(()=>assertStableURL(files(p,old),p,src('Old title','2026-05-29')),/would change/)});
 test('Explicit existing slug permits retitle '+p,()=>{const old=src('Old title','2026-05-28','slug: stable\n');assert.equal(assertStableURL(files(p,old),p,src('New title','2026-05-28','slug: stable\n')).after,'/fragments/2026/05/28/stable/')});
}
test('Loaded permalink mismatch rejects',()=>{const p='content/essays/fixed/index.md',s=src('Old','2026-05-28');assert.throws(()=>assertStableURL(files(p,s),p,s,'/wrong/'),/stale/)});
test('Duplicate destination rejected',()=>{const p='content/essays/fixed/index.md',s=src('Old','2026-05-28','url: /same/\n'),f=files(p,s);f.set('content/paintings/other/index.md',Buffer.from(s));assert.throws(()=>assertStableURL(f,p,s),/collides/)});
test('Module-dependent authority rejected',()=>{const p='content/essays/fixed/index.md',s=src('Old','2026-05-28'),f=files(p,s);f.set('hugo.toml',Buffer.from('[module]\n'));assert.throws(()=>assertStableURL(f,p,s),/separate verification/)});
test('Unsafe file path rejected',()=>{const p='content/essays/fixed/index.md',s=src('Old','2026-05-28'),f=files(p,s);f.set('content/../escape.md',Buffer.from(s));assert.throws(()=>assertStableURL(f,p,s),/unsafe/)});
test('CSV quoted titles/newlines parsed without guessing',()=>assert.deepEqual(csv('path,title,permalink\na,"One, two\nthree",https://example.invalid/a/\n'),[['path','title','permalink'],['a','One, two\nthree','https://example.invalid/a/']]));
