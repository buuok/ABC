const { inject } = require(process.env.POSTJECT ?? './x/postject/package/dist/api.js');
const fs = require('fs');
const [bin, blob, mac] = process.argv.slice(2);
inject(bin, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(mac === 'mac' && { machoSegmentName: 'NODE_SEA' }),
}).then(() => console.log('injected', bin)).catch((e) => { console.error(e); process.exit(1); });
