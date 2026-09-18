import { appendFileSync, readFileSync } from 'node:fs';
import webpush from 'web-push';

const envPath = new URL('../.env', import.meta.url);
const env = readFileSync(envPath, 'utf8');
if (/^VAPID_PUBLIC_KEY=\S+/m.test(env) && /^VAPID_PRIVATE_KEY=\S+/m.test(env)) {
  console.log('ALREADY_SET');
  process.exit(0);
}
const k = webpush.generateVAPIDKeys();
appendFileSync(
  envPath,
  `\nVAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:noreply@powerliftingtracker.com\n`
);
console.log('KEYS_ADDED');
