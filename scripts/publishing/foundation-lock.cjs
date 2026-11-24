'use strict';
const {files}=require('./foundation-lock.json');
const {hash}=require('./engine/editor-publish.cjs');
function verifyFoundationFiles(remoteFiles){
 for(const [name,expected] of Object.entries(files)){
  if(!Buffer.isBuffer(remoteFiles[name])||hash(remoteFiles[name])!==expected){
   throw Error('Remote main does not match the approved publication foundation: '+name);
  }
 }
}
module.exports={verifyFoundationFiles};
