/**
 * 口径计算层 v1 —— 纯 JS，无第三方依赖。
 * Electron 主进程 / 渲染进程 / 浏览器直接打开 index.html 都可用。
 *
 * 口径来源：dashboard/metrics-spec.json（唯一权威）
 *   - 每日销售额 gmv = 线上成交金额 + 线下交易金额（总表线下列按日期并入，v7）
 *   - 净销售额 = SUM(gmv) - SUM(取消及售后退款金额)，单日可为负
 *   - 综合 ROI = 全店成交金额（含线下）/ 全店推广总花费（整店口径，不用京准通后台 ROI）
 *   - 推广占比 = 推广花费 / 净销售额（含线下、已扣退款；净销售额 ≤ 0 时返回 null 显示「—」）
 *   - 平均点击单价 = 推广总花费 / 推广点击数
 *   - 退款按明细行「时间」归期、不追溯；合计行已在数据接入层剔除
 *   - 整店总花费只取每日推广 CSV 的 SKU 日明细；线下单无推广归因、不新增花费
 *   - 未同步显示「—」，主动留缺口显示「待接入」，都不写 0
 *   - 展示层命名：SPU 编码 → 商品货号名称（spu-labels.json），编码只在 spu_id / tooltip 保留
 *   - 月度目标本身不写入 daily；线下列已并入 daily 并参与全部主口径
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DashboardMetrics = api;   // 浏览器 / Electron 渲染进程挂到 window
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null), function () {
  'use strict';

  var DAY_MS = 86400000;
  var EMPTY = '—';
  var DEFERRED = '待接入';

  function parseDate(s) {
    var p = String(s).slice(0, 10).split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }
  function addDays(ts, n) { return ts + n * DAY_MS; }

  /** 周期选择：当月 / 上月 / 近 7/15/30 天 / 上一周期 / 同比 / 自定义 */
  function pickRange(daily, mode, anchor, custom) {
    var dates = daily.map(function (r) { return parseDate(r.date); });
    var max = anchor ? parseDate(anchor) : (dates.length ? Math.max.apply(null, dates) : parseDate('2026-11-04'));
    var start, end, label;
    switch (mode) {
      case 'this_month':
        start = Date.UTC(new Date(max).getUTCFullYear(), new Date(max).getUTCMonth(), 1);
        end = max; label = '当月'; break;
      case 'last_month':
        // 上一个自然月：月初往前退一个月；end 用「本月第 0 天」= 上月末，自动适配 28/29/30/31 天与跨年
        start = Date.UTC(new Date(max).getUTCFullYear(), new Date(max).getUTCMonth() - 1, 1);
        end = Date.UTC(new Date(max).getUTCFullYear(), new Date(max).getUTCMonth(), 0);
        label = '上月'; break;
      case 'last_7':   start = addDays(max, -6);  end = max; label = '近 7 天'; break;
      case 'last_15':  start = addDays(max, -14); end = max; label = '近 15 天'; break;
      case 'last_30':  start = addDays(max, -29); end = max; label = '近 30 天'; break;
      case 'custom':
        start = parseDate(custom.start); end = parseDate(custom.end); label = custom.label || '自定义'; break;
      default:         start = Date.UTC(new Date(max).getUTCFullYear(), new Date(max).getUTCMonth(), 1);
                       end = max; label = '当月';
    }
    var rows = daily.filter(function (r) {
      var t = parseDate(r.date); return t >= start && t <= end;
    });
    return { start: fmtDate(start), end: fmtDate(end), label: label, rows: rows, days: (end - start) / DAY_MS + 1 };
  }

  /** 上一周期：与当前周期等长、紧邻在前 */
  function prevRange(range) {
    var s = parseDate(range.start), e = parseDate(range.end), n = (e - s) / DAY_MS + 1;
    return { start: fmtDate(addDays(s, -n)), end: fmtDate(addDays(s, -1)), days: n };
  }

  /** 同比：日期整体回退一年 */
  function yoyRange(range) {
    var s = new Date(parseDate(range.start)), e = new Date(parseDate(range.end));
    return {
      start: fmtDate(Date.UTC(s.getUTCFullYear() - 1, s.getUTCMonth(), s.getUTCDate())),
      end: fmtDate(Date.UTC(e.getUTCFullYear() - 1, e.getUTCMonth(), e.getUTCDate()))
    };
  }

  function rowsBetween(daily, r) {
    if (!r) return [];
    return daily.filter(function (x) {
      var t = parseDate(x.date);
      return t >= parseDate(r.start) && t <= parseDate(r.end);
    });
  }

  /** 周期聚合。hasData 区分「真的没数据」与「未同步」 */
  function aggregate(rows) {
    var a = {
      gmv: 0, online_gmv: 0, offline_sales: 0, refund: 0, net_sales: 0,
      orders: 0, visitors: 0, add_cart: 0,
      ad_spend: 0, ad_clicks: 0, ad_impressions: 0, ad_order_amount: 0,
      refund_orders: 0, sales_days: 0, ad_days: 0
    };
    rows.forEach(function (r) {
      a.gmv += r.gmv || 0;
      a.online_gmv += r.online_gmv !== undefined ? (r.online_gmv || 0) : (r.gmv || 0);
      a.offline_sales += r.offline_sales || 0;
      a.refund += r.refund || 0;
      a.orders += r.orders || 0;
      a.visitors += r.visitors || 0;
      a.add_cart += r.add_cart || 0;
      a.ad_spend += r.ad_spend || 0;
      a.ad_clicks += r.ad_clicks || 0;
      a.ad_impressions += r.ad_impressions || 0;
      a.ad_order_amount += r.ad_order_amount || 0;
      a.refund_orders += r.refund_orders || 0;
      if (r.has_sales) a.sales_days++;
      if (r.has_ads) a.ad_days++;
    });
    a.net_sales = a.gmv - a.refund;   // 含线下，可为负，按已确认口径
    a.net_sales_online_only = a.online_gmv - a.refund;  // 仅作对照
    a.roi = a.ad_spend ? a.gmv / a.ad_spend : null;
    // 分母为净销售额（用户 2026-11-05 确认）。净销售额 ≤ 0 时比率无业务含义，返回 null → 显示「—」
    a.ad_ratio = a.net_sales > 0 ? a.ad_spend / a.net_sales : null;
    a.cpc = a.ad_clicks ? a.ad_spend / a.ad_clicks : null;
    a.aov = a.orders ? a.gmv / a.orders : null;
    a.cvr = a.visitors ? a.orders / a.visitors : null;
    a.has_sales = a.sales_days > 0;
    a.has_ads = a.ad_days > 0;
    return a;
  }

  function money(v) {
    if (v === null || v === undefined || !isFinite(v)) return EMPTY;
    return '¥' + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(v) {
    if (v === null || v === undefined || !isFinite(v)) return EMPTY;
    return (v * 100).toFixed(2) + '%';
  }
  function ratio(v) {
    if (v === null || v === undefined || !isFinite(v)) return EMPTY;
    return Number(v).toFixed(2);
  }
  function count(v) {
    if (v === null || v === undefined || !isFinite(v)) return EMPTY;
    return Math.round(v).toLocaleString('zh-CN');
  }

  /** 涨跌配色遵循 A 股习惯：涨=红(up)，跌=绿(down) */
  function toneOf(cur, prev) {
    if (cur === null || prev === null || !isFinite(cur) || !isFinite(prev) || prev === 0) return 'flat';
    var d = (cur - prev) / Math.abs(prev);
    if (Math.abs(d) < 0.00005) return 'flat';
    return d > 0 ? 'up' : 'down';
  }
  function deltaOf(cur, prev) {
    if (cur === null || prev === null || !isFinite(cur) || !isFinite(prev) || prev === 0) return null;
    return (cur - prev) / Math.abs(prev);
  }

  /** six KPI cards，与参考图一致 */
  function kpiCards(agg, prev) {
    prev = prev || {};
    var defs = [
      { key: 'net_sales', name: '净销售额', fmt: money, hint: '线上成交 + 线下 − 退款（退款按申请日归期）' },
      { key: 'ad_spend',  name: '总花费',   fmt: money, hint: '京准通全店推广消耗，只取 SKU 日明细' },
      { key: 'roi',       name: '综合ROI',  fmt: ratio, hint: '整店口径：全店成交金额（含线下）÷ 全店推广花费' },
      { key: 'ad_ratio',  name: '推广占比', fmt: pct,   hint: '推广花费 ÷ 净销售额（含线下；分母 ≤ 0 时显示 —）' },
      { key: 'cpc',       name: '平均点击单价', fmt: money, hint: '推广花费 ÷ 推广点击数' },
      { key: 'visitors',  name: '访客数',   fmt: count, hint: '商品访客数按日期汇总' }
    ];
    return defs.map(function (d) {
      var cur = agg[d.key], pv = prev[d.key];
      var delta = deltaOf(cur, pv);
      return {
        key: d.key, name: d.name, value: cur, display: d.fmt(cur),
        hint: d.hint,
        delta: delta,
        deltaDisplay: delta === null ? EMPTY : (delta > 0 ? '+' : '') + (delta * 100).toFixed(2) + '%',
        tone: toneOf(cur, pv)
      };
    });
  }

  /** 校验状态：missing 显示「—」，deferred 显示「待接入」 */
  function validationView(validation) {
    return validation.map(function (v) {
      return {
        id: v.id, name: v.name, status: v.status, detail: v.detail,
        badge: v.status === 'missing' ? EMPTY
          : (v.status === 'deferred' ? DEFERRED
            : (v.status === 'ready_range' ? '已同步·区间'
              : (v.status === 'ready_from_master' ? '已同步·总表' : '已同步'))),
        ok: v.status !== 'missing' && v.status !== 'deferred'
      };
    });
  }

  /** SPU 编码 → 商品货号名称（展示层唯一命名入口） */
  function spuLabel(data, spu) {
    var m = data && data.spu_labels && data.spu_labels.map;
    var v = m && m[String(spu)];
    if (v && v.display) return v.display;
    var s = String(spu || '');
    return s ? '未建档货号 · ' + s.slice(-4) : EMPTY;
  }

  /** 月度目标达成层：全部由数据接入层算好，这里只做格式化 */
  function targetCards(t) {
    if (!t || t.status !== 'enabled') return [];
    return [
      { name: '月度目标', display: money(t.monthly_target), hint: t.monthly_target_label + ' · ' + t.monthly_target_source },
      { name: '累计净销售额', display: money(t.actual_net_sales), hint: '含线下：线上成交 + 线下 − 退款' },
      { name: '目标达成率', display: pct(t.achievement), hint: '含线下净销售额 ÷ 月度目标' },
      { name: '时间进度', display: pct(t.time_progress), hint: t.elapsed_days + '/' + t.month_days + ' 天' },
      { name: '进度差 · ' + t.pace_status, display: money(t.pace_gap), hint: '累计逐日目标 − 累计净销售额（含线下）' },
      { name: '剩余缺口', display: money(t.gap_to_target), hint: '月度目标 − 累计净销售额（含线下）' },
      { name: '剩余日均需', display: money(t.required_daily_net), hint: '缺口 ÷ 剩余 ' + t.remaining_days + ' 天' },
      { name: '线下交易金额', display: money(t.offline_total), hint: '已按日期并入每日销售额，参与主口径' },
      { name: '线上净销售额', display: money(t.net_sales_online_only), hint: '仅作对照：成交 − 退款，未含线下' },
      { name: '全渠道综合ROI', display: ratio(t.roi), hint: '成交金额（含线下）÷ 整店推广总花费' }
    ];
  }

  /* ============ 洞察层（2026-11-25）============
     纯计算、无 DOM、无数据源读取，app.js 与 selftest.js 共用同一套口径。
     设计原则：只用 daily 已有字段，不引入新数据源；异常用「对照基线」而非绝对阈值，
     换月/换类目无需改阈值；所有结论标注方法与样本数，不做黑箱判断。 */

  /** 滚动基线：以 end 之前的最近 window 天（不含 end 本身）为对照样本。
   *  ROI / 加购率这类比率用「分子和÷分母和」的合并口径，不取逐日比率的均值，
   *  避免 0 花费日把 ROI 拉到极端值。返回 null 表示样本不足或分母为 0。 */
  var ANOMALY_METRICS = [
    { key: 'gmv',       name: '成交额',     fmt: money,  goodUp: true },
    { key: 'net_sales', name: '净销售额',   fmt: money,  goodUp: true },
    { key: 'ad_spend',  name: '推广花费',   fmt: money,  goodUp: false },
    { key: 'refund',    name: '退款',       fmt: money,  goodUp: false },
    { key: 'visitors',  name: '访客数',     fmt: count,  goodUp: true },
    { key: 'add_cart',  name: '加购人数',   fmt: count,  goodUp: true },
    { key: 'orders',    name: '成交单量',   fmt: count,  goodUp: true },
    { key: 'roi',       name: '综合ROI',    fmt: ratio,  goodUp: true,  num: 'gmv',  den: 'ad_spend' },
    { key: 'cart_rate', name: '加购率',     fmt: pct,    goodUp: true,  num: 'add_cart', den: 'visitors' },
    { key: 'refund_rate', name: '退款率',   fmt: pct,    goodUp: false, num: 'refund', den: 'gmv' }
  ];

  function metricValue(row, def) {
    if (!row) return null;
    if (!def.num) return (row[def.key] === null || row[def.key] === undefined) ? null : Number(row[def.key]);
    var n = Number(row[def.num] || 0), d = Number(row[def.den] || 0);
    return d > 0 ? n / d : null;
  }

  function baselineStats(samples) {
    var xs = samples.filter(function (x) { return x !== null && isFinite(x); });
    if (xs.length < 7) return null;   // 样本不足不出结论
    var mean = xs.reduce(function (s, x) { return s + x; }, 0) / xs.length;
    var varSum = xs.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0);
    var sd = Math.sqrt(varSum / (xs.length - 1));
    return { mean: mean, sd: sd, n: xs.length };
  }

  /** 单日异常：cur 为当日 daily 行，baseRows 为对照日（默认 cur 之前 window 天）。
   *  z = (当日 − 基线均值) ÷ 基线标准差；|z| >= zThreshold 记异常。
   *  基线 sd=0 时若当日 ≠ 均值仍算异常（确定性突变），z 用 ±Infinity 表达，展示层写「基线无波动」。 */
  function scanDay(cur, baseRows, opts) {
    opts = opts || {};
    var zThreshold = opts.zThreshold || 3;
    var out = [];
    ANOMALY_METRICS.forEach(function (def) {
      var v = metricValue(cur, def);
      if (v === null) return;
      var b = baselineStats(baseRows.map(function (r) { return metricValue(r, def); }));
      if (!b) return;
      var diff = v - b.mean;
      var z = b.sd > 0 ? diff / b.sd : (Math.abs(diff) > 1e-9 ? (diff > 0 ? Infinity : -Infinity) : 0);
      if (Math.abs(z) < zThreshold) return;
      out.push({
        key: def.key, name: def.name, value: v, mean: b.mean, sd: b.sd, z: z,
        pct: b.mean !== 0 ? diff / Math.abs(b.mean) : null,
        fmt: def.fmt, goodUp: def.goodUp, n: b.n,
        good: def.goodUp ? diff > 0 : diff < 0
      });
    });
    return out.sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); });
  }

  /** 区间异常汇总：对 days 里的每一天跟它自己的滚动基线比，返回异常最显著的若干条。
   *  同一指标若多天异常只保留 |z| 最大的一天，避免刷屏；按 |z| 降序。 */
  function scanRange(daily, days, opts) {
    opts = opts || {};
    var window = opts.window || 28, limit = opts.limit || 8;
    var byDate = {};
    daily.forEach(function (r) { byDate[r.date] = r; });
    var picked = {};
    (days || []).forEach(function (r) {
      var i = daily.findIndex(function (x) { return x.date === r.date; });
      if (i < 0) return;
      var base = daily.slice(Math.max(0, i - window), i);
      scanDay(r, base, opts).forEach(function (a) {
        var k = a.key;
        if (!picked[k] || Math.abs(a.z) > Math.abs(picked[k].z)) {
          picked[k] = Object.assign({}, a, { date: r.date });
        }
      });
    });
    return Object.keys(picked).map(function (k) { return picked[k]; })
      .sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); }).slice(0, limit);
  }

  /** 变化归因：把「当期 vs 上一周期」的总差额按维度拆开，回答「是谁贡献了这次变化」。
   *  输入 [key,value] 数组；贡献占比 = 该维度差额 ÷ 总差额（同向才算正贡献，反向为抵消）。
   *  总差额为 0 时占比返回 null，不做除法。 */
  function attributeDelta(curPairs, prevPairs, opts) {
    opts = opts || {};
    var limit = opts.limit || 6;
    var pv = {}, cv = {};
    (prevPairs || []).forEach(function (p) { pv[p[0]] = p[1] || 0; });
    (curPairs || []).forEach(function (p) { cv[p[0]] = p[1] || 0; });
    var keys = Object.keys(pv).concat(Object.keys(cv)).filter(function (k, i, a) { return a.indexOf(k) === i; });
    var rows = keys.map(function (k) {
      return { key: k, cur: cv[k] || 0, prev: pv[k] || 0, delta: (cv[k] || 0) - (pv[k] || 0) };
    });
    var total = rows.reduce(function (s, r) { return s + r.delta; }, 0);
    var baseSum = rows.reduce(function (s, r) { return s + Math.abs(r.prev); }, 0);
    rows.forEach(function (r) {
      r.share = Math.abs(total) > 1e-9 ? r.delta / total : null;
      r.pct = Math.abs(r.prev) > 1e-9 ? r.delta / Math.abs(r.prev) : null;
      r.weight = baseSum > 1e-9 ? Math.abs(r.prev) / baseSum : null;
    });
    rows.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    return { total: total, rows: rows.slice(0, limit), rowsAll: rows };
  }

  /** 今日经营摘要的一句话判断：把目标进度、环比、异常数压成一句可执行的结论。
   *  {level: good|warn|bad, text, actions:[]} */
  function judgementText(ctx) {
    var T = ctx.target, d = ctx.delta, an = ctx.anomalies || [];
    var parts = [], level = 'good';
    if (T && T.status === 'enabled' && isFinite(T.pace_gap)) {
      if (T.pace_gap > 0) {
        level = T.time_progress > 0 && T.pace_gap / Math.max(T.monthly_target, 1) > 0.1 ? 'bad' : 'warn';
        parts.push('净销售额落后时间进度 ' + money(T.pace_gap) + '，剩余 ' + T.remaining_days +
          ' 天日均需 ' + money(T.required_daily_net));
      } else {
        parts.push('净销售额领先时间进度 ' + money(-T.pace_gap));
      }
    }
    if (d && d.gmvPct !== null && isFinite(d.gmvPct)) {
      parts.push('成交额环比' + (d.gmvPct >= 0 ? '增长 ' : '下降 ') + (Math.abs(d.gmvPct) * 100).toFixed(1) + '%');
      if (d.gmvPct < -0.1 && level === 'good') level = 'warn';
    }
    if (an.length) {
      var bad = an.filter(function (a) { return !a.good; });
      if (bad.length) {
        parts.push('检测到 ' + bad.length + ' 项不利偏离（' + bad.slice(0, 2).map(function (a) { return a.name; }).join('、') + '）');
        if (level === 'good') level = 'warn';
      }
      if (an.length > bad.length) parts.push((an.length - bad.length) + ' 项有利偏离');
    }
    return { level: level, text: parts.length ? parts.join('；') + '。' : '各指标在基线区间内，暂无显著偏离。' };
  }

  return {
    EMPTY: EMPTY, DEFERRED: DEFERRED,
    spuLabel: spuLabel, targetCards: targetCards,
    parseDate: parseDate, fmtDate: fmtDate, pickRange: pickRange,
    addDays: addDays,
    prevRange: prevRange, yoyRange: yoyRange, rowsBetween: rowsBetween,
    aggregate: aggregate, kpiCards: kpiCards, validationView: validationView,
    money: money, pct: pct, ratio: ratio, count: count, toneOf: toneOf, deltaOf: deltaOf,
    ANOMALY_METRICS: ANOMALY_METRICS, metricValue: metricValue, baselineStats: baselineStats,
    scanDay: scanDay, scanRange: scanRange, attributeDelta: attributeDelta, judgementText: judgementText
  };
});
