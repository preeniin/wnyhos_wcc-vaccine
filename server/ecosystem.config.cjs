module.exports = {
  apps: [{
    name: 'wcc-vaccine',
    script: 'server.js',
    cwd: __dirname,
    env: { PORT: 8100, HOST: '0.0.0.0' }, // ช่วงแรกเปิด LAN — ผูก Cloudflare แล้วเปลี่ยนเป็น 127.0.0.1
    max_memory_restart: '200M',
    time: true,
  }],
};
