const fs = require('fs');
function resolve(p, fn) {
  const s = fs.readFileSync(p, 'utf8');
  const re = /<<<<<<< HEAD\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> main\n/g;
  const out = s.replace(re, (_, o, t) => fn(o, t));
  if (out.includes('<<<<<<<')) throw new Error(p + ' unresolved');
  fs.writeFileSync(p, out);
}
resolve('server/zone/internal/game/server.go', (o, t) => o + t);
resolve('server/zone/main.go', (o, t) => t + o);
resolve('server/zone/README.md', (o, t) => o + '\n' + t);
console.log('ok');
