import test from 'node:test';
import assert from 'node:assert/strict';
import patch from '../../scripts/lilamaya-metadata-patch.cjs';
for(const type of ['essays','paintings'])for(const eol of ['\n','\r\n']){
 const s=['---','# intact','title: "Synthetic"','date: 2026-05-28T00:10:09.123+05:30','draft: true','description: "Retained"','custom: {keep: true}','---','','{{< introduction >}}','','Poetry Śāntiḥ.  ','','![keep](images/keep.png)',''].join(eol);
 test(type+' no-op '+JSON.stringify(eol),()=>assert.equal(patch.patchMetadata(s,type,{}),s));
 test(type+' explicit insertion '+JSON.stringify(eol),()=>{const out=patch.patchMetadata(s,type,{hero:'images/hero-new.png'});assert.equal(out,s.replace(eol+'---'+eol+eol,eol+'hero: "images/hero-new.png"'+eol+'---'+eol+eol));assert.equal(patch.parse(out).body,patch.parse(s).body)});
 test(type+' removal/restore exact '+JSON.stringify(eol),()=>{const removed=patch.patchMetadata(s,type,{hero:false});assert.equal(patch.parse(removed).data.hero,false);assert.equal(patch.patchMetadata(removed,type,{hero:{restoreLegacy:true}}),s);assert.equal(patch.patchMetadata(s,type,{hero:{restoreLegacy:true}}),s)});
 test(type+' replacement preserves comment '+JSON.stringify(eol),()=>{const a=s.replace('custom: {keep: true}', 'hero: "images/old.jpg" # keep hero comment'+eol+'custom: {keep: true}');const b=patch.patchMetadata(a,type,{hero:'images/new.webp'});assert.equal(b,a.replace('images/old.jpg','images/new.webp'));assert.equal(patch.patchMetadata(a,type,{hero:{restoreLegacy:true}}),s.replace('custom: {keep: true}','# keep hero comment'+eol+'custom: {keep: true}'))});
}
for(const value of ['',null,true,0,'hero.png','/images/a.png','../a.jpg','images/../a.png','images/a.svg','https://example.invalid/a.png','images/a.png?q','images/a.png#x','images/a%2e.png',{}, {restoreLegacy:true,extra:true}])test('Reject hero '+JSON.stringify(value),()=>assert.throws(()=>patch.patchMetadata('---\ntitle: Synthetic\n---\n\nBody\n','essays',{hero:value})));
test('Fragments remain excluded',()=>assert.throws(()=>patch.patchMetadata('---\ntitle: Synthetic\n---\n\nBody\n','fragments',{hero:false}),/not editable/));
