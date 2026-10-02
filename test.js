/* 冒烟测试：模拟 rulesServer 运行，验证混沌注入核心逻辑
   运行：node test.js（需先 npx tsc 编译）
*/
const assert = require('assert');
const handler = require('./dist/rulesServer').default;
const { parseConfig, buildFault, pickDelay, pickStatusCode, shouldInject } = require('./dist/chaos');

// ---------- 单元测试 ----------

// JSON 配置解析
const c1 = parseConfig('{"rate":30,"type":"delay","delay":[1000,3000]}');
assert.strictEqual(c1.rate, 30);
assert.deepStrictEqual(c1.delay, [1000, 3000]);

// kv 配置解析
const c2 = parseConfig('type=error,rate=50,statusCode=500|502|503');
assert.strictEqual(c2.type, 'error');
assert.strictEqual(c2.rate, 50);
assert.deepStrictEqual(c2.statusCode, [500, 502, 503]);

// 延迟区间解析
const c3 = parseConfig('type=delay,delay=100-200');
assert.deepStrictEqual(c3.delay, [100, 200]);

// 预设名解析
const c4 = parseConfig('abort');
assert.strictEqual(c4.type, 'abort');

// 竖线分隔多类型
const c5 = parseConfig('delay|error');
assert.deepStrictEqual(c5.type, ['delay', 'error']);

// 延迟区间取值
for (let i = 0; i < 100; i++) {
  const d = pickDelay([1000, 3000]);
  assert.ok(d >= 1000 && d <= 3000, `delay out of range: ${d}`);
}
assert.strictEqual(pickDelay(500), 500);
assert.strictEqual(pickDelay(undefined), 1000);

// 状态码随机取值
for (let i = 0; i < 100; i++) {
  const s = pickStatusCode([500, 502, 503]);
  assert.ok([500, 502, 503].includes(s));
}
assert.strictEqual(pickStatusCode(undefined), 500);
assert.strictEqual(pickStatusCode(999), 500); // 非法状态码回退 500

// 比例边界
assert.strictEqual(shouldInject(0), false);
assert.strictEqual(shouldInject(100), true);
assert.strictEqual(shouldInject(undefined), true);
assert.strictEqual(shouldInject(150), true); // 超界按 100 处理

// 规则生成
assert.ok(buildFault({ type: 'abort' }).rules.includes('enable://abort'));
assert.ok(buildFault({ type: 'fail' }).rules.includes('enable://abortReq'));
assert.ok(buildFault({ type: 'delay', delay: 800 }).rules.includes('resDelay://800'));
assert.ok(buildFault({ type: 'delay', phase: 'both', delay: 1000 }).rules.includes('reqDelay://300'));
assert.ok(buildFault({ type: 'slow', speed: 20 }).rules.includes('resSpeed://20'));
assert.strictEqual(buildFault({ type: 'redirect' }), null); // 缺少 location 时 fail-open
const f1 = buildFault({ type: 'error', statusCode: 503 });
assert.ok(f1.rules.includes('statusCode://503'));
assert.ok(JSON.parse(f1.values.whistleChaosHeaders)['x-whistle-chaos'] === 'error-503');
const f2 = buildFault({ type: 'delay', header: false });
assert.ok(!f2.rules.includes('x-whistle-chaos'));

// ---------- 集成测试：模拟 whistle rulesServer ----------

let requestHandler;
const server = { on: (name, cb) => { if (name === 'request') requestHandler = cb; } };
const options = {
  getValue: (name, cb) =>
    cb(name === 'chaos-preset' ? '{"rate":100,"type":"error","statusCode":503}' : undefined),
};
handler(server, options);

const run = (ruleValue) => {
  let out = '';
  requestHandler(
    { originalReq: { ruleValue, fullUrl: 'https://example.com/api' } },
    { end: (data) => { out = data; } }
  );
  return out;
};

// error 注入：返回 rules + values 的 JSON
const out1 = run('{"rate":100,"type":"error","statusCode":503}');
const parsed1 = JSON.parse(out1);
assert.ok(parsed1.rules.includes('statusCode://503'));
assert.ok(parsed1.values.whistleChaosBody.includes('chaos injected'));

// delay 注入：返回纯 rules 文本
const out2 = run('type=delay,delay=100-200');
assert.ok(out2.includes('resDelay://'));

// rate=0 永不注入
for (let i = 0; i < 200; i++) {
  assert.strictEqual(run('rate=0,type=delay'), '');
}

// 非法配置 fail-open（不抛错、不注入）
assert.strictEqual(run('not-a-valid-type'), '');

// Values 预设引用
const out3 = run('{chaos-preset}');
assert.ok(JSON.parse(out3).rules.includes('statusCode://503'));

// 不存在的 Values 名称：回退默认配置（delay 1000ms），仍正常注入
assert.ok(run('{not-exist}').includes('resDelay://1000'));

// 空配置默认 delay 1000ms
assert.ok(run('').includes('resDelay://1000'));

// 权重分布：error:9 delay:1，error 占比应在 70%~100% 之间
let errorCount = 0;
for (let i = 0; i < 1000; i++) {
  if (run('{"rate":100,"type":"error:9,delay:1"}').includes('statusCode://')) {
    errorCount++;
  }
}
assert.ok(errorCount > 700 && errorCount < 1000, `weighted distribution abnormal: ${errorCount}/1000`);

// 比例分布：rate=30，注入比例应在 15%~45% 之间
let injected = 0;
for (let i = 0; i < 1000; i++) {
  if (run('rate=30,type=delay') !== '') {
    injected++;
  }
}
assert.ok(injected > 150 && injected < 450, `rate distribution abnormal: ${injected}/1000`);

console.log('All tests passed');
console.log(`  weighted error: ${errorCount}/1000 (~90% expected)`);
console.log(`  rate=30 injected: ${injected}/1000 (~30% expected)`);
