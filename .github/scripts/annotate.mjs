import { readFileSync, existsSync } from 'node:fs';

const [level, title, file, tailArg] = process.argv.slice(2);
const limit = Number(tailArg || 30000);
let text = existsSync(file) ? readFileSync(file, 'utf8') : `(no file ${file})`;
if (text.length > limit) text = '…\n' + text.slice(text.length - limit);
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
console.log(`::${level} title=${esc(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}::${esc(text)}`);
