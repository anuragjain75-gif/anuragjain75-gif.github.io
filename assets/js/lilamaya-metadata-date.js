import patch from './lilamaya-metadata-patch.cjs';
// Calendar/time editing never constructs a timezone or converts through Date.
export function dateParts(value){
 if(!patch.validDate(value))return null;
 const match=value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(:[\s\S]+))?$/);
 return match?{day:match[1],time:match[2]||null,tail:match[3]||''}:null;
}
export function composeDate(original,day,time){
 const parts=dateParts(original);if(!parts)throw Error('Unsupported stored date; it has not been changed.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!patch.validDate(day))throw Error('Choose a valid calendar date.');
 if(!parts.time){if(time)throw Error('Adding a time requires a separately approved timezone convention.');return day;}
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('Choose a valid 24-hour time.');
 const value=day+'T'+time+parts.tail;if(!patch.validDate(value))throw Error('Invalid date/time.');return value;
}
