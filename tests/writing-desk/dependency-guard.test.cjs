'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {profile,dependencies}=require('../../scripts/publishing/profiles.cjs');

const selected='content/fragments/can-we-call-any-idea-our-own/index.md';
const kind=profile(selected);
const metadata={introduction:''};
const expectedAssets=['static/images/social/fragments/can-we-call-any-idea-our-own.png'];

test('dependency guard accepts an exact standalone br line',()=>{
  assert.deepEqual(dependencies(process.cwd(),selected,kind,'Before\n<br />\nAfter',metadata),expectedAssets);
});

test('dependency guard accepts the invocation shortcode pair',()=>{
  assert.deepEqual(dependencies(process.cwd(),selected,kind,'{{< invocation >}}\nText\n{{< /invocation >}}',metadata),expectedAssets);
});

for(const [label,body] of [
  ['other HTML tags','Before\n<br>\nAfter'],
  ['self-closing HTML without the exact spacing','Before\n<br/>\nAfter'],
  ['inline HTML','Before <em>text</em>'],
  ['Markdown reference definition','[source]: https://example.test'],
  ['Markdown reference use','[text][source]'],
]) test('dependency guard rejects '+label,()=>{
  assert.throws(()=>dependencies(process.cwd(),selected,kind,body,metadata),/HTML\/reference dependencies/);
});
