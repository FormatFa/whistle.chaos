import { FaultResult, parseConfig, buildFault, shouldInject } from './chaos';

export default (server: Whistle.PluginServer, options: Whistle.PluginOptions) => {
  server.on('request', (req: Whistle.PluginRequest, res: Whistle.PluginResponse) => {
    const ruleValue = ((req.originalReq && req.originalReq.ruleValue) || '').trim();

    const respond = (rawConfig: string) => {
      let fault: FaultResult | null = null;
      let log = false;
      try {
        const config = parseConfig(rawConfig);
        log = config.log === true;
        if (shouldInject(config.rate)) {
          fault = buildFault(config);
        }
      } catch (err) {
        // 配置解析失败时放行请求，不影响正常流量（fail-open）
        console.warn('[whistle.chaos] 配置解析失败，本次请求不注入故障:', ruleValue, err);
      }
      if (!fault) {
        return res.end('');
      }
      if (log) {
        console.log('[whistle.chaos] 注入故障:', req.originalReq.fullUrl, fault.rules);
      }
      if (fault.values) {
        return res.end(JSON.stringify({ rules: fault.rules, values: fault.values }));
      }
      res.end(fault.rules);
    };

    // 支持 chaos://{valuesName} 引用 whistle Values 中预置的 JSON 配置
    const m = ruleValue.match(/^\{([\w.\-]+)\}$/);
    if (m) {
      options.getValue(m[1], (value) => respond(typeof value === 'string' ? value : ''));
    } else {
      respond(ruleValue);
    }
  });
};
