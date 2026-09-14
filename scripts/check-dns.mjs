// Diagnóstico de la resolución DNS que necesita mongodb+srv://
import dns from 'dns';

const host = 'power.ax8gn87.mongodb.net';

async function trySrv(label) {
  try {
    const srv = await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
    console.log(`${label}: OK -> ${srv.map((s) => `${s.name}:${s.port}`).join(', ')}`);
    return true;
  } catch (e) {
    console.log(`${label}: FALLO (${e.code || e.message})`);
    return false;
  }
}

async function tryTxt(label) {
  try {
    const txt = await dns.promises.resolveTxt(host);
    console.log(`${label}: TXT -> ${txt.map((t) => t.join('')).join(' | ')}`);
  } catch (e) {
    console.log(`${label}: TXT FALLO (${e.code || e.message})`);
  }
}

console.log(`DNS del sistema: ${dns.getServers().join(', ')}`);
await trySrv('1) DNS del sistema');

dns.setServers(['1.1.1.1', '8.8.8.8']);
console.log(`DNS forzado a: ${dns.getServers().join(', ')}`);
const ok = await trySrv('2) DNS publico');
await tryTxt('3) DNS publico');

process.exit(ok ? 0 : 1);
