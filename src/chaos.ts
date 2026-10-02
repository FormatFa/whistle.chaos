/*
 * whistle.chaos 混沌测试（故障注入）插件核心逻辑
 *
 * 规则用法：
 *   pattern chaos://{"rate":30,"type":"delay","delay":[1000,3000]}
 *   pattern chaos://type=error,rate=50,statusCode=500|502|503
 *   pattern chaos://delay
 *   pattern chaos://{presetName}   (引用 whistle Values 中定义的 JSON 配置)
 */

export interface ChaosConfig {
  /** 故障发生比例，0-100 的百分比，默认 100 */
  rate?: number;
  /** 故障类型：delay | error | abort | fail | slow | redirect，支持权重配比 */
  type?: string | string[] | Record<string, number>;
  /** delay 类型：延迟毫秒数，支持固定值、[min, max] 区间、{min, max} 区间 */
  delay?: number | number[] | { min?: number; max?: number };
  /** error 类型：HTTP 状态码，支持固定值或列表随机取一个，默认 500 */
  statusCode?: number | number[];
  /** error 类型：自定义响应体 */
  body?: string;
  /** slow 类型：响应限速 kb/s，默认 10 */
  speed?: number;
  /** redirect 类型：重定向目标地址 */
  location?: string;
  /** delay 类型：延迟作用阶段 req | res | both，默认 res */
  phase?: 'req' | 'res' | 'both';
  /** 是否在响应头添加 x-whistle-chaos 标记，默认 true */
  header?: boolean;
  /** 是否在插件控制台输出注入日志，默认 false */
  log?: boolean;
}

export interface FaultResult {
  rules: string;
  values?: Record<string, string>;
}

export const FAULT_TYPES = ['delay', 'error', 'abort', 'fail', 'slow', 'redirect'];

const DEFAULT_RATE = 100;
const DEFAULT_DELAY = 1000;
const DEFAULT_STATUS_CODE = 500;
const DEFAULT_SPEED = 10;
const CHAOS_HEADER = 'x-whistle-chaos';

const randInt = (min: number, max: number): number => {
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const toNum = (val: unknown): number | null => {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

const toBool = (val: unknown): boolean => val !== false && val !== 'false' && val !== '0';

const isFaultType = (name: string): boolean => FAULT_TYPES.indexOf(name) !== -1;

/* ---------------------- 配置解析 ---------------------- */

/** 解析 '1000-3000' 或 '1000' */
const parseNumberOrRange = (val: string): number | number[] => {
  const m = val.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
  if (m) {
    return [Number(m[1]), Number(m[2])];
  }
  const n = toNum(val);
  return n === null ? [] : n;
};

/** 解析 '500|502|503' 或 '500' */
const parseNumberOrList = (val: string): number | number[] => {
  if (val.indexOf('|') !== -1) {
    return val.split('|').map((item) => toNum(item.trim())).filter((n) => n !== null) as number[];
  }
  const n = toNum(val);
  return n === null ? [] : n;
};

/** 解析 key=value 逗号分隔的简易配置：type=delay,rate=30,delay=1000-3000 */
const parseKvConfig = (raw: string): ChaosConfig => {
  const config: ChaosConfig = {};
  raw.split(',').forEach((pair) => {
    const item = pair.trim();
    if (!item) {
      return;
    }
    const index = item.indexOf('=');
    let key: string;
    let val: string;
    if (index === -1) {
      key = 'type';
      val = item;
    } else {
      key = item.slice(0, index).trim();
      val = item.slice(index + 1).trim();
    }
    if (!key) {
      return;
    }
    switch (key) {
      case 'type':
        config.type = val.indexOf('|') !== -1 ? val.split('|').map((s) => s.trim()) : val;
        break;
      case 'rate':
      case 'percent':
        config.rate = toNum(val) ?? DEFAULT_RATE;
        break;
      case 'delay':
      case 'latency':
      case 'ms':
        config.delay = parseNumberOrRange(val);
        break;
      case 'statusCode':
      case 'status':
      case 'code':
        config.statusCode = parseNumberOrList(val);
        break;
      case 'body':
      case 'message':
      case 'msg':
        config.body = val;
        break;
      case 'speed':
      case 'kbps':
        config.speed = toNum(val) ?? DEFAULT_SPEED;
        break;
      case 'location':
      case 'url':
        config.location = val;
        break;
      case 'phase':
        if (val === 'req' || val === 'res' || val === 'both') {
          config.phase = val;
        }
        break;
      case 'header':
        config.header = toBool(val);
        break;
      case 'log':
        config.log = toBool(val);
        break;
      default:
        break;
    }
  });
  return config;
};

/**
 * 解析规则值配置，支持三种格式：
 * 1. JSON：chaos://{"rate":30,"type":"delay","delay":[1000,3000]}
 * 2. kv：chaos://type=delay,rate=30,delay=1000-3000
 * 3. 预设名：chaos://delay（使用默认参数）
 */
export const parseConfig = (rawValue: string): ChaosConfig => {
  const raw = (rawValue || '').trim();
  if (!raw) {
    return {};
  }
  if (raw[0] === '{' || raw[0] === '[') {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return { type: data };
    }
    if (data && typeof data === 'object') {
      return data as ChaosConfig;
    }
    return {};
  }
  if (raw.indexOf('=') !== -1 || raw.indexOf(',') !== -1) {
    return parseKvConfig(raw);
  }
  if (isFaultType(raw)) {
    return { type: raw };
  }
  if (raw.indexOf('|') !== -1) {
    return { type: raw.split('|').map((s) => s.trim()) };
  }
  throw new Error(`unrecognized chaos config: ${raw}`);
};

/* ---------------------- 随机决策 ---------------------- */

/** 按配置比例决定本次请求是否注入故障 */
export const shouldInject = (rate?: number): boolean => {
  let r = DEFAULT_RATE;
  if (typeof rate === 'number' && Number.isFinite(rate)) {
    r = Math.min(100, Math.max(0, rate));
  }
  return Math.random() * 100 < r;
};

/** 按权重随机挑选故障类型，支持 "delay:3,error:1" / ["delay","error"] / {delay:3,error:1} */
const pickWeightedType = (typeConf: ChaosConfig['type']): string | null => {
  let entries: Array<{ name: string; weight: number }>;
  if (!typeConf) {
    entries = [{ name: 'delay', weight: 1 }];
  } else if (typeof typeConf === 'string') {
    entries = typeConf.split(/[,|]/).map((part) => {
      const seg = part.trim();
      const index = seg.indexOf(':');
      if (index === -1) {
        return { name: seg, weight: 1 };
      }
      return { name: seg.slice(0, index).trim(), weight: toNum(seg.slice(index + 1)) ?? 1 };
    });
  } else if (Array.isArray(typeConf)) {
    entries = typeConf.map((name) => ({ name: String(name).trim(), weight: 1 }));
  } else if (typeof typeConf === 'object') {
    entries = Object.keys(typeConf).map((name) => ({
      name: name.trim(),
      weight: toNum((typeConf as Record<string, unknown>)[name]) ?? 1,
    }));
  } else {
    entries = [{ name: 'delay', weight: 1 }];
  }
  entries = entries.filter((entry) => isFaultType(entry.name) && entry.weight > 0);
  if (!entries.length) {
    return null;
  }
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let r = Math.random() * total;
  for (const entry of entries) {
    r -= entry.weight;
    if (r < 0) {
      return entry.name;
    }
  }
  return entries[entries.length - 1].name;
};

/** 随机取延迟毫秒数 */
export const pickDelay = (conf: ChaosConfig['delay']): number => {
  if (typeof conf === 'number' && conf >= 0) {
    return Math.round(conf);
  }
  if (Array.isArray(conf) && conf.length === 2) {
    return randInt(conf[0], conf[1]);
  }
  if (conf && typeof conf === 'object' && !Array.isArray(conf)) {
    const range = conf as { min?: number; max?: number };
    const min = typeof range.min === 'number' ? range.min : DEFAULT_DELAY;
    const max = typeof range.max === 'number' ? range.max : min;
    return randInt(min, max);
  }
  return DEFAULT_DELAY;
};

const validStatus = (code: number): number => {
  const n = Math.round(code);
  return n >= 100 && n <= 599 ? n : DEFAULT_STATUS_CODE;
};

/** 随机取状态码 */
export const pickStatusCode = (conf: ChaosConfig['statusCode']): number => {
  if (typeof conf === 'number') {
    return validStatus(conf);
  }
  if (Array.isArray(conf) && conf.length) {
    return validStatus(conf[randInt(0, conf.length - 1)]);
  }
  return DEFAULT_STATUS_CODE;
};

/* ---------------------- 规则生成 ---------------------- */

const withHeader = (ops: string, value: string, config: ChaosConfig): string =>
  config.header === false ? ops : `${ops} resHeaders://${CHAOS_HEADER}=${value}`;

/**
 * 根据配置生成 whistle 动态规则（与 _rules.txt 等价）
 * 返回 null 表示配置无效，放行请求（fail-open）
 */
export const buildFault = (config: ChaosConfig): FaultResult | null => {
  const type = pickWeightedType(config.type);
  if (!type) {
    return null;
  }
  switch (type) {
    case 'delay': {
      const total = pickDelay(config.delay);
      const phase = config.phase || 'res';
      let ops: string;
      if (phase === 'req') {
        ops = `reqDelay://${total}`;
      } else if (phase === 'both') {
        const reqDelay = Math.round(total * 0.3);
        ops = `reqDelay://${reqDelay} resDelay://${total - reqDelay}`;
      } else {
        ops = `resDelay://${total}`;
      }
      return { rules: `* ${withHeader(ops, `delay-${total}ms`, config)}` };
    }
    case 'error': {
      const code = pickStatusCode(config.statusCode);
      const isDefaultBody = config.body == null;
      const body = isDefaultBody
        ? JSON.stringify({
            error: 'chaos injected',
            plugin: 'whistle.chaos',
            type: 'error',
            statusCode: code,
          })
        : String(config.body);
      const headers: Record<string, string> = {};
      if (isDefaultBody) {
        headers['content-type'] = 'application/json; charset=utf-8';
      }
      if (config.header !== false) {
        headers[CHAOS_HEADER] = `error-${code}`;
      }
      const headerOps = Object.keys(headers).length
        ? ' resHeaders://{whistleChaosHeaders}'
        : '';
      return {
        rules: `* statusCode://${code} resBody://{whistleChaosBody}${headerOps}`,
        values: {
          whistleChaosBody: body,
          whistleChaosHeaders: JSON.stringify(headers),
        },
      };
    }
    case 'abort':
      return { rules: '* enable://abort' };
    case 'fail':
      return { rules: '* enable://abortReq' };
    case 'slow': {
      const speed = Math.max(1, Math.round(toNum(config.speed) ?? DEFAULT_SPEED));
      return { rules: `* ${withHeader(`resSpeed://${speed}`, `slow-${speed}kbs`, config)}` };
    }
    case 'redirect':
      if (!config.location) {
        console.warn('[whistle.chaos] redirect 故障类型必须配置 location 参数');
        return null;
      }
      return { rules: `* redirect://${config.location}` };
    default:
      return null;
  }
};
