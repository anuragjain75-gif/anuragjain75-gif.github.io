import test from 'node:test';
import assert from 'node:assert/strict';
import {formatMetadataDate,metadataDraftLabel,metadataThemeLabel,metadataRows} from '../../assets/js/lilamaya-metadata-panel.js';
for(const [source,expected] of [
 ['2026-05-28','28 May 2026'],['2026-05-28T00:10:00+05:30','28 May 2026'],
 ['2026-05-28T23:50:00-12:00','28 May 2026'],['2026-05-28T00:10:00+14:00','28 May 2026'],
 ['2024-02-29','29 February 2024'],['2026-12-31T23:00:00Z','31 December 2026'],
 ['2026-02-29','Date unavailable'],['2026-13-01','Date unavailable'],['bad','Date unavailable'],
 ['', 'Date unavailable'],[null,'Not specified'],[undefined,'Not specified']
])test('Authored calendar date '+source,()=>{const before=source;assert.equal(formatMetadataDate(source),expected);assert.equal(source,before)});
for(const [value,expected] of [[true,'Draft'],[false,'Published in local metadata'],[undefined,'Not specified'],['false','Not specified'],[null,'Not specified']])test('Local-only status '+value,()=>assert.equal(metadataDraftLabel(value),expected));
for(const [type,value,expected] of [['essays','mIxEd','mIxEd'],['fragments','childhood','Childhood'],['fragments','mIxEd','MIxEd'],['paintings','nature','Nature'],['paintings','नमस्ते','नमस्ते']])test('Display-only theme '+type+value,()=>assert.equal(metadataThemeLabel(value,type),expected));
for(const type of ['essays','fragments','paintings'])test('Presentation cannot mutate metadata '+type,()=>{
 const theme={essays:'themes',fragments:'fragmentthemes',paintings:'paintingthemes'}[type];
 const data=Object.freeze({type,fields:Object.freeze({date:'2026-05-28T00:10:00+05:30',draft:false,[theme]:Object.freeze(['nature']),introduction:'Excluded',custom:'Keep'})});
 const before=JSON.stringify(data);formatMetadataDate(data.fields.date);metadataDraftLabel(data.fields.draft);metadataRows(data);assert.equal(JSON.stringify(data),before);assert.ok(!metadataRows(data).some(([label])=>/introduction|custom/i.test(label)));
});
