// stub_hang.mjs — 模拟卡死的分析器：输出一行进度后永不退出。
console.log(JSON.stringify({ stage: 't0', status: 'running' }));
setInterval(() => {}, 1000);
