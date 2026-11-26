/* 渲染层 v1 —— 纯原生 JS，无框架、无网络请求 */
(function () {
  'use strict';
  var M = window.DashboardMetrics;
  var DATA = null;
  var state = {
    mode: 'this_month', baseMode: 'this_month', compare: true, view: 'bi', planPeriod: null,
    monthPick: null, mpYear: null,
    spuSort: { key: 'gmv', dir: 1 }, spuQuery: '', spuScope: 'all', spuLimit: 200,
    detailSpu: null, detailQuery: '',
    catSort: { key: 'gmv', dir: 1 }, catQuery: '', catScope: 'all', catPick: null,
    planPick: null, planPkQuery: '', planPkSort: { key: 'spend', dir: -1 }, planMarketQuery: '',
    adspuDate: null, adspuDim: 'plan', adspuQuery: '', adspuLimit: 50, adspuPick: null,
    adspuMode: 'period', singleDate: null,
    cmpSort: 'gmv', cmpLimit: 24, cmpQuery: '',
    diagDriverMetric: 'gmv', diagDriverDim: 'cat'
  };
  var adspuDateSig = null;   // 日期下拉重建标记，避免每次重绘冲掉选中项
  // 「每日推广」下钻明细：京准通原始营销场景 → 计划名后显示的短标签
  var ADSPU_SCENE_LABELS = {
    '常规推广-关键词': '快车关键词',
    '常规推广-商品成交': '人群商品推广',
    '全店商品推广': '全店推广',
    '常规推广-全站智能推广': '全站智能推广',
    '常规推广-智能化': '智能化',
    '腰带店铺': '腰带店铺'
  };
  var ADSPU_SCENE_CLASS = {
    '快车关键词': 's-keyword', '人群商品推广': 's-crowd',
    '全店推广': 's-shop', '全站智能推广': 's-shop',
    '智能化': 's-auto', '腰带店铺': 's-other'
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  async function load() {
    if (window.dashboardAPI && window.dashboardAPI.isElectron) {
      var r = await window.dashboardAPI.getDataset();
      if (r && !r.error) DATA = r;
      else if (window.__DASHBOARD_DATASET__) DATA = window.__DASHBOARD_DATASET__;
      else { document.body.innerHTML = '<p style="padding:40px">数据集未生成，请先运行 npm run data</p>'; return; }
      var info = await window.dashboardAPI.getAppInfo();
      if (info && info.root) $('rootPath').textContent = info.root;
    } else {
      DATA = window.__DASHBOARD_DATASET__;
      if (!DATA) { document.body.innerHTML = '<p style="padding:40px">data/dataset.js 未生成，请先运行 build_dataset.py</p>'; return; }
    }
    render();
    bind();
    // 支持 index.html#detail 这类深链，方便直接从桌面书签/分享进到某一页
    if (typeof location !== 'undefined' && location.hash) {
      var hv = location.hash.replace('#', '');
      if (hv && VIEW_META[hv] && hv !== state.view) {
        state.view = hv;
        document.querySelectorAll('.nav-item').forEach(function (a) {
          a.classList.toggle('active', a.dataset.view === hv);
        });
        render();
      }
    }
  }

  function lastDate() {
    return DATA.daily.length ? DATA.daily[DATA.daily.length - 1].date : '2026-11-04';
  }

  /** 有数据的自然月（升序），决定月份选择器里哪些格子可点：无数据的月份一律禁用，不摆空数据。 */
  function availableMonths() {
    var set = {};
    DATA.daily.forEach(function (r) { set[r.date.slice(0, 7)] = 1; });
    return Object.keys(set).sort();
  }

  /** 选中的自然月 → 完整自然月区间（1 号 ~ 月末）。 */
  function monthRange(key) {
    var y = +key.slice(0, 4), m = +key.slice(5, 7);
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var start = key + '-01', end = key + '-' + String(last).padStart(2, '0');
    return { start: start, end: end, days: last, label: m + '月' };
  }

  /** 参考京东商智「月」：年份 + 12 个月网格，选中月带蓝点，无数据月份灰掉。 */
  function renderMonthPicker() {
    var avail = availableMonths();
    var years = avail.map(function (k) { return +k.slice(0, 4); });
    var y = state.mpYear || years[years.length - 1] || +lastDate().slice(0, 4);
    state.mpYear = y;
    $('mpYear').textContent = y + '年';
    $('mpPrevYear').disabled = y <= Math.min.apply(null, years);
    $('mpNextYear').disabled = y >= Math.max.apply(null, years);
    var cells = [];
    for (var m = 1; m <= 12; m++) {
      var key = y + '-' + String(m).padStart(2, '0');
      var ok = avail.indexOf(key) >= 0, sel = state.monthPick === key;
      cells.push('<button type="button" class="mp-cell' + (sel ? ' selected' : '') + '"' +
        (ok ? ' data-month="' + key + '"' : ' disabled') + '>' + m + '月' +
        (sel ? '<i class="mp-dot"></i>' : '') + '</button>');
    }
    $('mpGrid').innerHTML = cells.join('');
    $('mpFoot').textContent = '有数据：' + avail.map(function (k) {
      return k.slice(0, 4) + '/' + k.slice(5);
    }).join('、') + '（其余月份不可选）';
  }

  /** 「上一周期」的区间：
   *  滚动窗口（近7/15/30）与未过完的当月 → 等长紧邻回退，保证环比天数一致、可比；
   *  已过完的「上月」→ 按自然月回退（9/01~9/30），而不是 31 天等长得到 8/31~9/30。 */
  function prevOfBase() {
    var bm = state.baseMode || 'this_month';
    if (bm === 'month' && state.monthPick) {
      var y = +state.monthPick.slice(0, 4), m = +state.monthPick.slice(5, 7);
      var pk = m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
      if (availableMonths().indexOf(pk) >= 0) return monthRange(pk);
      return M.prevRange(monthRange(state.monthPick));
    }
    var base = M.pickRange(DATA.daily, bm, lastDate());
    if (bm === 'last_month') {
      var pm = M.pickRange(DATA.daily, 'last_month', base.start);
      return { start: pm.start, end: pm.end, label: '上月', days: pm.days, rows: pm.rows };
    }
    return M.prevRange(base);
  }

  function currentRange() {
    var mode = state.mode;
    if (mode === 'single_day') {
      // 单日：起止同一天，走 pickRange 的 custom 分支，其余派生口径（上一周期 / 同比 / 达成率）自动一致
      var sd = state.singleDate || lastDate();
      return M.pickRange(DATA.daily, 'custom', lastDate(), { start: sd, end: sd, label: '单日' });
    }
    if (mode === 'month' && state.monthPick) return monthRange(state.monthPick);
    // 「上一周期 / 同比」跟随最近一次选中的周期（baseMode），而不是写死当月
    if (mode === 'prev_period') return prevOfBase();
    if (mode === 'yoy') {
      return M.yoyRange(M.pickRange(DATA.daily, state.baseMode || 'this_month', lastDate()));
    }
    return M.pickRange(DATA.daily, mode, lastDate());
  }

  /** 目标层按周期所属月份切换（2026-11-07 用户确认）：
   *  起止同月且有该月目标 → 用该月目标（如「上月」=10 月 45W、「上一周期」=9 月 38W）；
   *  跨月滚动窗口（近7/15/30）与同比 → 仍用当月目标，避免拿整月目标去除几天实际。 */
  function periodMonth() {
    var r = currentRange();
    if (!r || !r.start) return null;
    var m = String(r.start).slice(0, 7), e = String(r.end || r.start).slice(0, 7);
    return m === e ? m : null;
  }

  function targetsForRange() {
    var m = periodMonth(), by = DATA.targets_by_month || {};
    return (m && by[m]) ? by[m] : DATA.targets;
  }

  function categoriesForRange() {
    var m = periodMonth(), by = DATA.shop_categories_by_month || {};
    return (m && by[m]) ? by[m] : DATA.shop_categories;
  }

  function render() {
    var range = currentRange();
    var rows = M.rowsBetween(DATA.daily, range);
    var agg = M.aggregate(rows);
    // 全站对比基期统一用 cmpPrevRange（上月同日期）：11/01~11/24 → 10/01~10/24。
    // 不再用 M.prevRange 的等长紧邻（那会算成 10/08~10/31），与「数据对比」页保持同一口径。
    var prevRange = state.compare && state.mode !== 'yoy' ? cmpPrevRange(range) : null;
    var prevAgg = prevRange ? M.aggregate(M.rowsBetween(DATA.daily, prevRange)) : null;

    $('metaLine').textContent =
      '紫叶户外家具专卖店 · 数据截至 ' + lastDate() + ' · 口径 ' +
      (DATA.meta.period_basis.sales) + '归期 / 退款按明细行日期归期';
    /* 每日推广页有两套时间口径：跟周期条的「区间」和页内日期下拉的「单日」，
       顶部两个 chip 必须跟着当前口径说，别让「当月」和「当天」混着看。 */
    if (state.mode === 'single_day') {
      $('periodChip').textContent = '单日';
      $('rangeChip').textContent = state.singleDate || state.adspuDate || lastDate();
    } else {
      $('periodChip').textContent = state.mode === 'month' && state.monthPick
        ? state.monthPick.slice(5) + '月'
        : ($('periods').querySelector('.period.active')
          ? $('periods').querySelector('.period.active').textContent
          : ({ this_month: '当月', last_month: '上月', last_7: '近7天', last_15: '近15天',
               last_30: '近30天', prev_period: '上一周期', yoy: '同比' }[state.mode] || state.mode));
      $('rangeChip').textContent = range.start + ' ~ ' + range.end + '（' + rows.length + ' 天' +
        (state.view === 'adspu' ? ' · 区间累计' : '') + '）';
    }

    var done = DATA.validation.filter(function (v) { return v.status !== 'missing' && v.status !== 'deferred'; }).length;
    var missing = DATA.validation.filter(function (v) { return v.status === 'missing'; });
    var noticeEl = $('noticeText');
    if (noticeEl) noticeEl.textContent = '已完成 ' + done + '/' + DATA.validation.length + ' 张校验' +
      (missing.length ? '；' + missing.map(function (v) { return v.name; }).join('、') + ' 未同步' : '') +
      '，完成后自动填充';

    renderKpis(agg, prevAgg, rows, range, prevRange);
    renderValidation();
    renderRanks();
    renderTrend(rows);
    renderVisitorTrend(rows);
    renderView();
  }

  function renderKpis(agg, prevAgg, rows, range, prevRange) {
    var cards = M.kpiCards(agg, prevAgg || {});

    // ── 询单三卡（独立于 kpiCards：询单是另一份明细源，不能混进 daily 聚合）──
    var IQ = range ? inquiryRange(range.start, range.end) : null;
    if (IQ && IQ.ready) {
      // 分子只取「询单覆盖期」内的花费：询单每周一导，比销售/推广晚，
      // 若直接用整段花费，未导询单的那几天会把成本抬高（11/22 实测 167.30 vs 真实 154.50）
      var alignedSpend = 0;
      (rows || []).forEach(function (r) {
        if (!IQ.coveredEnd || r.date <= IQ.coveredEnd) alignedSpend += (r.ad_spend || 0);
      });
      var pAlignedSpend = 0;
      var pRows = prevRange ? M.rowsBetween(DATA.daily, prevRange) : [];
      if (prevRange) {
        var pIQe = inquiryRange(prevRange.start, prevRange.end);
        pRows.forEach(function (r) {
          if (!pIQe.coveredEnd || r.date <= pIQe.coveredEnd) pAlignedSpend += (r.ad_spend || 0);
        });
      }
      var pIQ = prevRange ? inquiryRange(prevRange.start, prevRange.end) : null;
      var spend = alignedSpend;
      var cost = (IQ.persons > 0 && spend > 0) ? spend / IQ.persons : null;
      var pCost = (pIQ && pIQ.persons > 0 && pAlignedSpend > 0)
        ? pAlignedSpend / pIQ.persons : null;
      var conv = IQ.persons > 0 ? IQ.deals / IQ.persons : null;
      var pConv = (pIQ && pIQ.persons > 0) ? pIQ.deals / pIQ.persons : null;
      var pctDelta = function (cur, pv) {
        if (cur == null || pv == null || pv === 0) return null;
        return (cur - pv) / pv;
      };
      var dCost = pctDelta(cost, pCost), dConv = pctDelta(conv, pConv);
      var noData = IQ.persons === 0;
      cards.push({
        key: 'inq_persons', name: '询单人数',
        display: noData ? '—' : M.count(IQ.persons),
        hint: '按「顾客 × SPU」去重（分层可加总）；去重客户 ' +
          (IQ.custs || 0) + ' 人，口径不同不混用',
        delta: null, deltaDisplay: '', tone: ''
      });
      cards.push({
        key: 'inq_cost', name: '询单成本',
        display: cost == null ? '—' : M.money(cost),
        hint: '推广花费 ÷ 询单人数；含自然流量咨询，非纯广告归因' +
          (IQ.partial ? '。询单数据截至 ' + String(IQ.maxDate).slice(5) + '，分子按同期花费截断' : ''),
        delta: dCost, deltaDisplay: dCost == null ? '—' : (dCost > 0 ? '+' : '') + (dCost * 100).toFixed(1) + '%',
        tone: dCost == null ? '' : (dCost > 0 ? 'down' : 'up')
      });
      cards.push({
        key: 'inq_conv', name: '询单→成交率',
        display: conv == null ? '—' : M.pct(conv),
        hint: '咨询后成交的询单人数 ÷ 询单人数（按 (顾客,SPU) 去重）',
        delta: dConv, deltaDisplay: dConv == null ? '—' : (dConv > 0 ? '+' : '') + (dConv * 100).toFixed(1) + '%',
        tone: dConv == null ? '' : (dConv > 0 ? 'up' : 'down')
      });
    }

    $('kpis').innerHTML = cards.map(function (c) {
      var delta = (prevAgg && c.delta !== null && c.delta !== undefined)
        ? '<span class="' + c.tone + '">' + esc(c.deltaDisplay) + '</span> <span class="flat">对比上一周期</span>'
        : (c.deltaDisplay === '' ? '<span class="flat">分层口径</span>'
          : '<span class="flat">— 对比上一周期</span>');
      var empty = !rows.length ? '<span class="flat">　数据不足</span>' : '';
      return '<div class="kpi"><div class="name">' + esc(c.name) + '</div>' +
        '<div class="value">' + esc(c.display) + '</div>' +
        '<div class="delta">' + delta + empty + '</div>' +
        '<div class="hint">' + esc(c.hint) + '</div></div>';
    }).join('');
  }

  function renderValidation() {
    var box = $('validation');
    if (!box) return;
    var vv = M.validationView(DATA.validation);
    $('validation').innerHTML = vv.map(function (v) {
      var cls = v.status === 'missing' ? 'missing' : (v.status === 'deferred' ? 'deferred' : '');
      return '<div class="validation-item"><div><b>' + esc(v.name) + '</b>' +
        '<span class="v-detail">' + esc(v.detail) + '</span></div>' +
        '<span class="v-badge ' + cls + '">' + esc(v.badge) + '</span></div>';
    }).join('') +
    '<div class="card-note">SKU 反查：' + DATA.sku_lookup.promo_rows_total + ' 行投放，SPU ID=0 共 ' +
      DATA.sku_lookup.spu_id_zero_rows + ' 行，字典命中 ' + DATA.sku_lookup.matched_rows +
      ' 行；未匹配 ' + DATA.sku_lookup.unmatched_skus.length + ' 个 SKU 单独记录，不丢弃。</div>';
  }

  function rankHtml(items, key, labelFn, valFn, titleFn) {
    if (!items || !items.length) return '<div class="rank-empty">— 暂无数据</div>';
    var max = Math.max.apply(null, items.map(function (x) { return x[key] || 0; })) || 1;
    return items.slice(0, 10).map(function (x) {
      var w = Math.max(2, (x[key] || 0) / max * 100);
      var label = labelFn(x);
      var tip = titleFn ? titleFn(x) : label;
      return '<div class="rank-row"><span class="rank-name" title="' + esc(tip) + '">' + esc(label) + '</span>' +
        '<span class="rank-bar"><i style="width:' + w.toFixed(1) + '%"></i></span>' +
        '<span class="rank-val">' + esc(valFn(x)) + '</span></div>';
    }).join('');
  }

  function spuTip(x) {
    return (x.key || '') + (x.name ? '｜' + x.name : '') + (x.spu_id ? '｜SPU ' + x.spu_id : '');
  }

  function renderRanks() {
    var range = currentRange();
    // 两个榜单都按「当前所选周期」聚合，而不是写死的整段累计
    // —— 类目推广花费：按日级 daily_category_spend 在所选区间内求和
    var catSpend = {}, dates = DATA.daily_category_spend || {};
    Object.keys(dates).forEach(function (d) {
      if (d < range.start || d > range.end) return;
      var row = dates[d];
      Object.keys(row).forEach(function (c) {
        catSpend[c] = (catSpend[c] || 0) + row[c];
      });
    });
    var catItems = Object.keys(catSpend).map(function (c) {
      return { key: c, spend: catSpend[c] };
    }).filter(function (x) { return x.spend > 0; })
      .sort(function (a, b) { return b.spend - a.spend; });
    $('categoryRank').innerHTML = rankHtml(catItems, 'spend',
      function (x) { return x.key; }, function (x) { return M.money(x.spend); });

    // 类目销售额：按 spu_daily（SPU × 日 的 gmv/refund/offline_gmv 原子层）按 cat_l1 聚合，
    // 全渠道净销售 = gmv − refund + offline_gmv，与整店 daily.net_sales 口径一致，按所选周期求和。
    var sd = DATA.spu_daily || {}, sdr = sd.rows || {}, sdmeta = sd.meta || {}, sdf = sd.fields || [];
    var GI = sdf.indexOf('gmv'), RI = sdf.indexOf('refund'), OI = sdf.indexOf('offline_gmv');
    if (GI < 0) GI = 0; if (RI < 0) RI = 1; if (OI < 0) OI = sdf.length - 1;
    var catSales = {};
    Object.keys(sdr).forEach(function (spu) {
      var mm = sdmeta[spu] || [], cat = mm[1] || '未归类', byDay = sdr[spu] || {};
      Object.keys(byDay).forEach(function (day) {
        if (day < range.start || day > range.end) return;
        var arr = byDay[day]; if (!arr) return;
        var v = (arr[GI] || 0) - (arr[RI] || 0) + (arr[OI] || 0);
        if (v) catSales[cat] = (catSales[cat] || 0) + v;
      });
    });
    var catSalesItems = Object.keys(catSales).map(function (c) {
      return { key: c, sales: catSales[c] };
    }).filter(function (x) { return x.sales > 0; })
      .sort(function (a, b) { return b.sales - a.sales; });
    $('categorySales').innerHTML = rankHtml(catSalesItems, 'sales',
      function (x) { return x.key; }, function (x) { return M.money(x.sales); });

    // 单品成交 Top：按 spu_daily（SPU × 日 gmv/refund/offline_gmv 原子层）在所选区间内求和
    // 含线下，与「类目销售额」口径一致：全渠道净销售 = 线上 gmv − 退款 + 线下
    var spuGmv = {}, labels = DATA.spu_labels || {};
    Object.keys(sdr).forEach(function (spu) {
      var byDay = sdr[spu] || {};
      var g = 0;
      Object.keys(byDay).forEach(function (d) {
        if (d < range.start || d > range.end) return;
        var arr = byDay[d]; if (!arr) return;
        g += (arr[GI] || 0) - (arr[RI] || 0) + (arr[OI] || 0);
      });
      if (g > 0) spuGmv[spu] = g;
    });
    var spuItems = Object.keys(spuGmv).map(function (spu) {
      var lm = (labels.map || {})[spu] || {};
      var meta = ((DATA.spu_daily || {}).meta || {})[spu] || [];
      var name = lm.display || meta[0] || spu;
      return { key: name, gmv: spuGmv[spu], name: name, spu_id: spu };
    }).filter(function (x) { return x.gmv > 0; })
      .sort(function (a, b) { return b.gmv - a.gmv; });
    $('spuRank').innerHTML = rankHtml(spuItems, 'gmv',
      function (x) { return x.key; }, function (x) { return M.money(x.gmv); }, spuTip);
  }

  function renderTrend(rows) {
    var box = $('trend');
    if (!rows.length) { box.innerHTML = '<div class="rank-empty">— 当前周期无数据</div>'; return; }
    var W = 800, H = 210, L = 58, R = 14, T = 14, B = 30;
    var net = rows.map(function (r) { return r.net_sales; });
    var spend = rows.map(function (r) { return r.ad_spend; });
    var min = Math.min.apply(null, [0].concat(net, spend));
    var max = Math.max.apply(null, [1].concat(net, spend));
    var span = (max - min) || 1;
    var x = function (i) { return L + i * (W - L - R) / Math.max(rows.length - 1, 1); };
    var y = function (v) { return T + (max - v) / span * (H - T - B); };
    var path = function (arr) {
      return arr.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    };
    var grid = '';
    [max, (max + min) / 2, min].forEach(function (v) {
      grid += '<line x1="' + L + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(v).toFixed(1) +
        '" stroke="#eceff4" stroke-width="1"/>' +
        '<text x="' + (L - 8) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="#9aa4b4">' +
        Math.round(v).toLocaleString('zh-CN') + '</text>';
    });
    var zero = min < 0
      ? '<line x1="' + L + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(0).toFixed(1) +
        '" stroke="#c8d0de" stroke-width="1" stroke-dasharray="4 3"/>' : '';
    var step = Math.max(1, Math.ceil(rows.length / 6));
    var labels = rows.map(function (r, i) {
      if (i % step && i !== rows.length - 1) return '';
      return '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#9aa4b4">' +
        esc(r.date.slice(5)) + '</text>';
    }).join('');
    var dots = net.map(function (v, i) {
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.4" fill="#4f6bed"><title>' +
        esc(rows[i].date + ' 净销售额 ' + M.money(v)) + '</title></circle>';
    }).join('');
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + grid + zero +
      '<path d="' + path(spend) + '" fill="none" stroke="#f0a13c" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="' + path(net) + '" fill="none" stroke="#4f6bed" stroke-width="2.2" stroke-linejoin="round"/>' +
      dots + labels + '</svg>';
  }

  function renderVisitorTrend(rows) {
    var box = $('visitorTrend');
    if (!rows.length) { box.innerHTML = '<div class="rank-empty">— 当前周期无数据</div>'; return; }
    var W = 800, H = 210, L = 58, R = 14, T = 14, B = 30;
    var visitors = rows.map(function (r) { return r.visitors || 0; });
    var customers = rows.map(function (r) { return r.customers || 0; });
    var max = Math.max.apply(null, [1].concat(visitors, customers));
    var min = 0;
    var span = (max - min) || 1;
    var x = function (i) { return L + i * (W - L - R) / Math.max(rows.length - 1, 1); };
    var y = function (v) { return T + (max - v) / span * (H - T - B); };
    var path = function (arr) {
      return arr.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    };
    var grid = '';
    [max, max / 2, min].forEach(function (v) {
      grid += '<line x1="' + L + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(v).toFixed(1) +
        '" stroke="#eceff4" stroke-width="1"/>' +
        '<text x="' + (L - 8) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="#9aa4b4">' +
        Math.round(v).toLocaleString('zh-CN') + '</text>';
    });
    var step = Math.max(1, Math.ceil(rows.length / 6));
    var labels = rows.map(function (r, i) {
      if (i % step && i !== rows.length - 1) return '';
      return '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#9aa4b4">' +
        esc(r.date.slice(5)) + '</text>';
    }).join('');
    var dots = visitors.map(function (v, i) {
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.4" fill="#4f6bed"><title>' +
        esc(rows[i].date + ' 访客 ' + M.count(v) + ' / 成交客户 ' + M.count(customers[i])) + '</title></circle>';
    }).join('');
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + grid +
      '<path d="' + path(customers) + '" fill="none" stroke="#2bb673" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="' + path(visitors) + '" fill="none" stroke="#4f6bed" stroke-width="2.2" stroke-linejoin="round"/>' +
      dots + labels + '</svg>';
  }

  var VIEW_META = {
    bi: { title: 'BI看板' },
    /* 名称于 2026-11-06 对调：spu 视图是 SPU × 日 的 13 列原子明细 → 叫「商品明细」；
       「单品分析」留给按单/按货号下钻的深度分析（趋势、结构、对比、归因），尚未建。 */
    spu: { title: '商品明细', ready: true },
    detail: { title: '单品分析', ready: true },
    adspu: { title: '每日推广' },
    category: { title: '类目分析', ready: true },
    compare: { title: '数据对比', ready: true },
    datasource: { title: '数据源设置', ready: true },
    master: { title: '数据总表' },
    plan: { title: '计划分析', icon: '—', badge: '未同步', desc: '未检测到词级区间数据 data/keyword-insight.json。', note: '请先运行 python3 engine/build_keywords.py，再运行 python3 engine/build_dataset.py 重建数据集。' },
    service: { title: '客服数据', icon: '—', badge: '未同步', desc: '客服响应时长 / 询单转化未接入。', note: '已有 3 期「商品咨询汇总（新）」可作部分替代，但不含响应时长。' },
    diagnosis: { title: 'AI诊断报表', ready: true },
    monitor: { title: '业绩监控', ready: true }
  };

  function planPeriods() {
    return (DATA.keyword_insight && DATA.keyword_insight.periods) || [];
  }

  function currentPlan() {
    var ps = planPeriods();
    if (!ps.length) return null;
    return ps.filter(function (x) { return x.id === state.planPeriod; })[0] || ps[ps.length - 1];
  }

  function miniKpi(name, val, hint) {
    return '<div class="kpi"><div class="name">' + esc(name) + '</div>' +
      '<div class="value">' + esc(val) + '</div>' +
      '<div class="hint">' + esc(hint) + '</div></div>';
  }

  /** 词级报表里 ctr / cvr 存的是百分数（3.48 = 3.48%），不是 0~1 小数 */
  function pkPct(v) { return v == null ? '—' : Number(v).toFixed(2) + '%'; }

  var PK_COLS = [
    { label: '关键词', i: 'keyword', raw: true },
    { label: '花费', i: 'spend', fmt: M.money },
    { label: '展现', i: 'impressions', fmt: M.count },
    { label: '点击', i: 'clicks', fmt: M.count },
    { label: '点击率', i: 'ctr', fmt: pkPct },
    { label: '加购', i: 'add_cart', fmt: M.count },
    { label: '加购率', i: 'cart_rate', calc: function (r, f) {
        return r[f.clicks] > 0 ? r[f.add_cart] / r[f.clicks] * 100 : null;
      }, fmt: pkPct },
    { label: '订单行', i: 'orders', fmt: M.count },
    { label: '成交额', i: 'order_amount', fmt: M.money },
    { label: 'CPC', i: 'cpc', fmt: M.money },
    { label: 'ROI', i: 'roi', fmt: M.ratio },
    { label: '转化率', i: 'cvr', fmt: pkPct }
  ];

  /** 派生列（加购率）按行计算；普通列直接取字段下标。 */
  function pkCell(c, r, f) { return c.calc ? c.calc(r, f) : r[f[c.i]]; }

  /** 计划 × 关键词：左侧计划列表（按花费降序），右侧所选计划的关键词明细。 */
  function renderPlanKeyword(P, K) {
    var pk = K.plan_keyword, f = {};
    pk.fields.forEach(function (k, i) { f[k] = i; });
    var plans = K.plans || [];
    if (!state.planPick || !plans.some(function (x) { return x.key === state.planPick; })) {
      state.planPick = plans.length ? plans[0].key : null;   // 换区间后原计划不存在则切第 1 个
    }
    $('planPkPlans').innerHTML = plans.map(function (x) {
      return '<button type="button" class="pk-plan' + (x.key === state.planPick ? ' active' : '') +
        '" data-plan="' + esc(x.key) + '" title="' + esc(x.name) + '">' +
        '<span class="pk-pname">' + esc(x.name) + '</span>' +
        '<span class="pk-pmeta"><b>' + esc(M.money(x.spend)) + '</b> · ' +
        esc(M.count(x.clicks)) + ' 点击 · ' + esc(M.count(x.add_cart)) + ' 加购 · ' +
        esc(M.money(x.order_amount)) + ' 成交</span></button>';
    }).join('') || '<div class="pk-empty">该区间没有关键词计划</div>';

    var all = pk.rows[state.planPick] || [];
    var q = (state.planPkQuery || '').trim().toLowerCase();
    var rows = q ? all.filter(function (r) {
      return String(r[f.keyword]).toLowerCase().indexOf(q) >= 0;
    }) : all.slice();
    var sk = state.planPkSort;
    var skCol = PK_COLS.filter(function (c) { return c.i === sk.key; })[0];
    rows.sort(function (a, b) {
      var av = skCol && skCol.calc ? skCol.calc(a, f) : a[f[sk.key]];
      var bv = skCol && skCol.calc ? skCol.calc(b, f) : b[f[sk.key]];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * sk.dir;
      }
      return (av - bv) * sk.dir;
    });

    var cur = plans.filter(function (x) { return x.key === state.planPick; })[0] || {};
    $('planPkNote').textContent = (cur.name || '—') + ' ｜ ' + P.start + ' ~ ' + P.end;
    $('planPkCount').textContent = rows.length + ' / ' + all.length + ' 个关键词';

    var head = '<thead><tr>' + PK_COLS.map(function (c) {
      var arrow = sk.key === c.i ? (sk.dir < 0 ? ' ↓' : ' ↑') : '';
      return '<th data-sort="' + c.i + '">' + esc(c.label) + arrow + '</th>';
    }).join('') + '</tr></thead>';
    var body = rows.map(function (r) {
      return '<tr>' + PK_COLS.map(function (c) {
        var v = pkCell(c, r, f);
        return '<td' + (c.raw ? ' class="ta-l" title="' + esc(v) + '"' : '') + '>' +
          esc(c.raw ? v : c.fmt(v)) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    var t = { spend: 0, impressions: 0, clicks: 0, add_cart: 0, orders: 0, order_amount: 0 };
    rows.forEach(function (r) {
      Object.keys(t).forEach(function (k) { t[k] += r[f[k]] || 0; });
    });
    var footVals = {
      keyword: '合计（' + rows.length + ' 个词）', spend: M.money(t.spend),
      impressions: M.count(t.impressions), clicks: M.count(t.clicks),
      ctr: pkPct(t.impressions ? t.clicks / t.impressions * 100 : null),
      add_cart: M.count(t.add_cart),
      cart_rate: pkPct(t.clicks ? t.add_cart / t.clicks * 100 : null),
      orders: M.count(t.orders),
      order_amount: M.money(t.order_amount),
      cpc: M.money(t.clicks ? t.spend / t.clicks : null),
      roi: M.ratio(t.spend ? t.order_amount / t.spend : null),
      cvr: pkPct(t.clicks ? t.orders / t.clicks * 100 : null)
    };
    var foot = '<tfoot><tr>' + PK_COLS.map(function (c) {
      return '<td' + (c.raw ? ' class="ta-l"' : '') + '>' + esc(footVals[c.i]) + '</td>';
    }).join('') + '</tr></tfoot>';
    $('planPkTable').innerHTML = rows.length
      ? head + '<tbody>' + body + '</tbody>' + foot
      : '<tbody><tr><td colspan="' + PK_COLS.length + '" class="pk-empty">' +
        (q ? '没有匹配「' + esc(state.planPkQuery) + '」的关键词' : '该计划下没有关键词明细') +
        '</td></tr></tbody>';

    $('planPkFoot').innerHTML =
      '口径：只统计 <b>关键词类型=关键词</b> 的行；「加购」是京东「总加购数」（加购件数，非人数），' +
      '「成交额 / 订单行」来自「总订单金额 / 总订单行」（订单行口径，一个订单多个 SKU 会拆多行）。' +
      '点击率＝点击÷展现、加购率＝总加购数÷点击（推广口径，与单品分析关键词表同一算法，' +
      '和顶部销售口径加购率不同源、不可横比）、CPC＝花费÷点击、ROI＝成交额÷花费、转化率＝订单行÷点击。' +
      '数据为<b>区间汇总</b>，无分日行，不能画日趋势；点表头可排序，搜索框只过滤当前计划内的词。';
  }

  /** 关键词 × 市场参考：商智热搜榜已接入（区间数值），京准通行业分析待导出；两源独立不混算。 */
  function renderPlanMarket(P, K) {
    var MKT = (DATA.market_reference && DATA.market_reference.rows) || [];
    var sources = (DATA.market_reference && DATA.market_reference.sources) || [];
    var hasShangzhi = sources.some(function (s) { return s.source === "商智热搜榜"; });

    var bd = $("planMarketBadge");
    if (hasShangzhi) {
      bd.textContent = "已接入 · 商智热搜榜(" + MKT.length + ") ｜ 京准通待接入";
      bd.className = "chip ok";
    } else {
      bd.textContent = "待接入";
      bd.className = "chip warn";
    }

    // ① 商智热搜榜（可搜词过滤）
    var q = (state.planMarketQuery || "").trim().toLowerCase();
    var rows = q ? MKT.filter(function (r) { return (r.term || "").toLowerCase().indexOf(q) >= 0; }) : MKT;
    $("planMarketCount").textContent = rows.length + " / " + MKT.length + " 个热词";
    var head = "<thead><tr><th>搜索词</th><th>搜索人数</th><th>点击率</th><th>成交转化率</th>" +
      "<th>快车参考价</th><th>成交金额</th><th>成交单量</th></tr></thead>";
    var body = rows.map(function (r) {
      return "<tr><td class=\"ta-l\">" + esc(r.term) + "</td><td>" + esc(r.search_people || "—") + "</td><td>" +
        esc(r.ctr || "—") + "</td><td>" + esc(r.cvr || "—") + "</td><td>" + esc(r.kuaiche_price || "—") +
        "</td><td>" + esc(r.gmv || "—") + "</td><td>" + esc(r.order_cnt || "—") + "</td></tr>";
    }).join("");
    $("planMarketTable").innerHTML = rows.length
      ? head + "<tbody>" + body + "</tbody>"
      : "<tbody><tr><td colspan=\"7\" class=\"pk-empty\">没有匹配「" + esc(state.planMarketQuery) + "」的热词</td></tr></tbody>";

    // ② 当前计划关键词 × 市场参考（子串匹配 + 我的 vs 市场对比）
    var out = [];
    if (K && K.plan_keyword) {
      var pk = K.plan_keyword, f = {};
      pk.fields.forEach(function (k, i) { f[k] = i; });
      (pk.rows[state.planPick] || []).forEach(function (r) {
        out.push({ kw: r[f.keyword], spend: r[f.spend], ctr: r[f.ctr], cvr: r[f.cvr], cpc: r[f.cpc],
                   m: matchMarket(r[f.keyword], MKT) });
      });
    }
    if (!out.length) {
      $("planMarketMatch").innerHTML = "<tbody><tr><td colspan=\"9\" class=\"pk-empty\">该区间没有关键词计划可匹配</td></tr></tbody>";
      return;
    }
    var mhead = "<thead><tr><th>关键词</th><th>我的花费</th><th>我的点击率</th><th>我的转化率</th>" +
      "<th>市场点击率</th><th>市场成交转化率</th><th>快车参考价</th><th>对比</th><th>匹配热词</th></tr></thead>";
    var mbody = out.map(function (o) {
      var m = o.m;
      var ctrC = m ? esc(m.ctr) : "—";
      var cvrC = m ? esc(m.cvr) : "—";
      var priceC = m ? esc(m.kuaiche_price) : "—";
      return "<tr><td class=\"ta-l\">" + esc(o.kw) + "</td><td>" + M.money(o.spend) + "</td><td>" + pkPct(o.ctr) +
        "</td><td>" + pkPct(o.cvr) + "</td><td>" + ctrC + "</td><td>" + cvrC + "</td><td>" + priceC +
        "</td><td class=\"ta-l\">" + compareMarket(o, m) + "</td><td class=\"ta-l\">" +
        (m ? esc(m.term) : "未匹配热词") + "</td></tr>";
    }).join("");
    $("planMarketMatch").innerHTML = mhead + "<tbody>" + mbody + "</tbody>";
  }

  /** 关键词 → 商智热搜榜最佳匹配：优先精确，其次热词包含关键词，再次关键词包含热词。 */
  function matchMarket(kw, MKT) {
    if (!kw) return null;
    var k = String(kw).toLowerCase(), exact = null, termHas = [], kwHas = [];
    for (var i = 0; i < MKT.length; i++) {
      var t = String(MKT[i].term || "").toLowerCase();
      if (!t) continue;
      if (t === k) { exact = MKT[i]; break; }
      if (t.indexOf(k) >= 0) termHas.push(MKT[i]);
      else if (k.indexOf(t) >= 0) kwHas.push(MKT[i]);
    }
    if (exact) return exact;
    if (termHas.length) return termHas[0];   // 热搜榜按搜索人数降序，首条最相关
    if (kwHas.length) return kwHas[0];
    return null;
  }

  /** 我的指标 vs 市场区间：CTR/CVR 越高越好，CPC 越低越好。市场值为区间，只给方向不硬算精确差。 */
  function compareMarket(o, m) {
    if (!m) return '<span class="muted">—</span>';
    var parts = [];
    if (o.ctr != null && m.ctr_num) {
      var r = Array.isArray(m.ctr_num) ? m.ctr_num : [m.ctr_num, m.ctr_num];
      if (o.ctr > r[1]) parts.push('<span class="m-up">CTR ▲高于市场</span>');
      else if (o.ctr < r[0]) parts.push('<span class="m-down">CTR ▼低于市场</span>');
      else parts.push('<span class="m-mid">CTR 区间内</span>');
    }
    if (o.cvr != null && m.cvr_num) {
      var r2 = Array.isArray(m.cvr_num) ? m.cvr_num : [m.cvr_num, m.cvr_num];
      if (o.cvr > r2[1]) parts.push('<span class="m-up">CVR ▲高于市场</span>');
      else if (o.cvr < r2[0]) parts.push('<span class="m-down">CVR ▼低于市场</span>');
      else parts.push('<span class="m-mid">CVR 区间内</span>');
    }
    if (o.cpc != null && m.kuaiche_price_num != null) {
      var p = m.kuaiche_price_num;
      if (o.cpc < p) parts.push('<span class="m-up">CPC ✓优于参考价</span>');
      else if (o.cpc > p) parts.push('<span class="m-down">CPC ▲高于参考价</span>');
      else parts.push('<span class="m-mid">CPC=参考价</span>');
    }
    return parts.length ? parts.join("<br>") : '<span class="muted">—</span>';
  }


  function renderPlan() {
    var ps = planPeriods(), P = currentPlan();
    if (!P) return;
    state.planPeriod = P.id;
    var sel = $('planPeriod');
    // 用 innerHTML 里的 option 数判断，不依赖 select.options（DOM 尚未挂载时更稳）
    if ((String(sel.innerHTML || '').match(/<option/g) || []).length !== ps.length) {
      sel.innerHTML = ps.map(function (x) {
        return '<option value="' + esc(x.id) + '">' + esc(x.raw_period) + '</option>';
      }).join('');
    }
    sel.value = P.id;
    var K = P.kw_view;
    if (!K) {
      $('planRows').textContent = '关键词口径视图未生成，请重新运行 python engine/build_keywords.py';
      return;
    }
    var s = K.summary;
    $('planRows').textContent = P.raw_period + ' · ' + M.count(s.rows) + ' 行关键词记录 · ' +
      K.plans.length + ' 个计划 · ' + P.source_files.length + ' 份文件';
    $('planKpis').innerHTML = [
      miniKpi('关键词计划花费', M.money(s.spend), '只算关键词类型=关键词，不含智能投放'),
      miniKpi('展现数', M.count(s.impressions), '区间累计'),
      miniKpi('点击数', M.count(s.clicks), '区间累计'),
      miniKpi('点击率', s.ctr === null ? '—' : s.ctr.toFixed(2) + '%', '点击 ÷ 展现'),
      miniKpi('总加购数', M.count(s.add_cart), '京东口径＝加购件数，不是人数'),
      miniKpi('成交额 / ROI', M.money(s.order_amount) + ' / ' + (s.roi === null ? '—' : s.roi.toFixed(2)),
        M.count(s.orders) + ' 订单行；投产比 = 成交额 ÷ 花费')
    ].join('');

    $('planTerms').innerHTML = rankHtml(K.top_search_terms, 'spend',
      function (x) { return x.key; },
      function (x) { return M.money(x.spend) + ' · ' + M.count(x.clicks) + ' 点击'; });
    $('planTermsByAmount').innerHTML = rankHtml(
      K.top_search_terms_by_amount.filter(function (x) { return x.order_amount > 0; }), 'order_amount',
      function (x) { return x.key; },
      function (x) { return M.money(x.order_amount) + ' · ROI ' + (x.roi === null ? '—' : x.roi.toFixed(2)); });
    $('planKeywords').innerHTML = rankHtml(K.top_keywords, 'spend',
      function (x) { return x.key; },
      function (x) { return M.money(x.spend) + ' · ' + M.count(x.add_cart) + ' 加购'; });

    renderPlanKeyword(P, K);
    renderPlanMarket(P, K);

    var scope = '<div class="validation-item"><div><b>本页口径：' + esc(K.scope) + '</b>' +
      '<span class="v-detail">' + esc(K.scope_note) + '</span></div></div>';
    var diff = (P.summary && s) ? (P.summary.spend - s.spend) : 0;
    var excluded = '<div class="validation-item"><div><b>排除金额</b><span class="v-detail">' +
      '全量词级花费 ' + M.money(P.summary.spend) + ' − 关键词口径 ' + M.money(s.spend) +
      ' = ' + M.money(diff) + '（智能投放行，主要是「全店推广计划」）</span></div></div>';
    var limits = (DATA.keyword_insight.limitations || []).map(function (x) {
      return '<div class="card-note">· ' + esc(x) + '</div>';
    }).join('');
    $('planNote').innerHTML = scope + excluded +
      '<div class="card-note"><b>区间说明</b>：' +
      esc(DATA.keyword_insight.meta.granularity_note) + '</div>' +
      '<div class="card-note"><b>与每日推广报表对照</b>：' +
      esc(DATA.keyword_insight.cross_check.note) + '</div>' + limits;
  }

  function masterData() {
    return (DATA && DATA.master_workbook) || null;
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return Number(v).toLocaleString('zh-CN', {
      minimumFractionDigits: digits || 0, maximumFractionDigits: digits === undefined ? 0 : digits
    });
  }

  function tableHtml(cols, rows, clsOf) {
    var head = '<thead><tr>' + cols.map(function (c) {
      return '<th>' + esc(c.label) + '</th>';
    }).join('') + '</tr></thead>';
    var body = '<tbody>' + rows.map(function (r) {
      return '<tr>' + cols.map(function (c) {
        var raw = c.get(r);
        var cls = (clsOf ? clsOf(c, raw, r) : '') || c.cls || '';
        return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' +
          (c.raw ? raw : esc(c.fmt ? c.fmt(raw) : fmtNum(raw, c.digits))) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody>';
    return head + body;
  }

  /** 每日推广：以「天」为维度，行=单品、列=推广计划或营销场景，值=当日推广花费。
   *  计划列只存在于 2026-11-09 起导出的 17 列 CSV；更早日期自动降级到场景口径并显式标注，
   *  绝不用场景名、单元名或店内均值冒充计划。 */
  /** 每日推广：行=单品、列=推广计划/营销场景。
   *  时间口径两套（用户 2026-11-25 要求）：
   *    - period（默认）：跟顶部周期条，按区间累计（当月 / 上月 / 近7天…）；
   *    - day：点页内「日期」下拉，只看那一天。
   *  两套都按京准通「每日报表」的 SKU 日明细聚合，0 花费的维度不占位；
   *  计划维度只存在于带「计划ID / 推广计划」列的 CSV，缺失时降级到场景口径并显式标注。 */
  function renderAdspu() {
    var planView = DATA.spu_plan_daily || { rows: {}, plans: [], plan_dates: [], no_plan_dates: [] };
    var sceneView = DATA.spu_scene_daily || { rows: {}, groups: [] };
    var labels = (DATA.spu_labels || {}).map || {};
    var daily = DATA.daily || [];
    var dates = daily.map(function (r) { return r.date; }).reverse();   // 最新在前
    if (!state.adspuDate || dates.indexOf(state.adspuDate) < 0) state.adspuDate = dates[0] || lastDate();
    var d = state.adspuDate;

    var mode = (state.mode === 'single_day' || state.adspuMode === 'day') ? 'day' : 'period';
    // 分段按钮与顶部周期条互斥提示：单日模式下周期条淡化，点它任一档即回区间
    var seg = $('adspuModeSeg');
    if (seg && seg.querySelectorAll) {
      Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      });
    }
    $('periods').classList.toggle('is-dim', mode === 'day');
    var pr = currentRange();
    var range = mode === 'day'
      ? { start: d, end: d, days: 1 }
      : { start: pr.start, end: pr.end, days: pr.days };
    var rangeLabel = mode === 'day' ? d + ' 当日'
      : (range.start + ' ~ ' + range.end + '（' + range.days + ' 天）');
    var suffix = mode === 'day' ? '当日' : '本期';
    var rangeWord = mode === 'day' ? '当日' : '区间';

    var planDates = planView.plan_dates || [];
    var planDays = planDates.filter(function (x) { return x >= range.start && x <= range.end; });
    var hasPlan = mode === 'day' ? planDates.indexOf(d) >= 0 : planDays.length > 0;
    var dimSel = $('adspuDim');
    var planOpt = dimSel.querySelector ? dimSel.querySelector('option[value="plan"]') : null;
    if (planOpt) planOpt.disabled = !hasPlan;
    if (!hasPlan && state.adspuDim === 'plan') state.adspuDim = 'scene';
    dimSel.value = state.adspuDim;
    var dim = state.adspuDim;
    $('adspuDimName').textContent = dim === 'plan' ? '推广计划' : '营销场景';

    // 日期下拉始终可用来切「单日」
    var dateSel = $('adspuDate');
    var sig = dates.join('|');
    if (adspuDateSig !== sig) {
      var partialPlan = planDates.length > 0 && planDates.length < dates.length;
      dateSel.innerHTML = dates.map(function (x) {
        var mark = partialPlan && planDates.indexOf(x) >= 0 ? ' · 有计划' : '';
        return '<option value="' + esc(x) + '">' + esc(x + mark) + '</option>';
      }).join('');
      adspuDateSig = sig;
    }
    dateSel.value = d;

    var cov = $('adspuCoverage');
    if (!hasPlan) {
      cov.hidden = false;
      cov.innerHTML = '<strong>' + rangeWord + '内无推广计划维度数据</strong>：' +
        (mode === 'day' ? esc(d) + ' 导出的还是旧版 15 列 CSV（未含「计划ID / 推广计划」）。'
                        : '所选区间的 CSV 均未含「计划ID / 推广计划」列。') +
        '当前为<b>营销场景</b>口径，场景口径全日期可用，计划口径自 ' + esc(planDates[0] || '—') +
        ' 起才有。此处不用场景名或店内均值冒充计划，也不做任何估算回填。';
    } else {
      cov.hidden = true; cov.innerHTML = '';
    }

    var src = dim === 'plan' ? (planView.rows || {}) : (sceneView.rows || {});
    var f = (dim === 'plan' ? planView.fields : sceneView.fields) || [];
    var iSpend = f.indexOf('spend'), iClicks = f.indexOf('clicks'),
        iImpr = f.indexOf('impressions'), iCart = f.indexOf('add_cart'),
        iAmt = f.indexOf('order_amount');
    var bySpu = {}, colTotals = {};
    Object.keys(src).forEach(function (spu) {
      var days = src[spu] || {};
      var row = {}, tot = 0, m = { clicks: 0, impressions: 0, add_cart: 0, order_amount: 0 };
      Object.keys(days).forEach(function (dt) {
        if (dt < range.start || dt > range.end) return;
        var cells = days[dt];
        Object.keys(cells).forEach(function (k) {
          var arr = cells[k] || [];
          var v = iSpend >= 0 ? (arr[iSpend] || 0) : 0;
          if (!v) return;                       // 0 花费的维度不进下钻
          if (!row[k]) row[k] = arr.map(function (x) { return x || 0; });
          else { for (var i = 0; i < arr.length; i++) row[k][i] += arr[i] || 0; }
          tot += v;
          colTotals[k] = (colTotals[k] || 0) + v;
          if (iClicks >= 0) m.clicks += arr[iClicks] || 0;
          if (iImpr >= 0) m.impressions += arr[iImpr] || 0;
          if (iCart >= 0) m.add_cart += arr[iCart] || 0;
          if (iAmt >= 0) m.order_amount += arr[iAmt] || 0;
        });
      });
      if (!tot) return;
      var lm = labels[spu] || {};
      bySpu[spu] = { name: lm.display || spu, spu: spu, cells: row, total: tot, m: m };
    });

    var cols;
    if (dim === 'plan') {
      cols = Object.keys(colTotals).sort(function (a, b) { return colTotals[b] - colTotals[a]; });
    } else {
      cols = (sceneView.groups || []).filter(function (g) { return (colTotals[g] || 0) > 0; });
      Object.keys(colTotals).forEach(function (g) { if (cols.indexOf(g) < 0) cols.push(g); });
    }
    var dimName = dim === 'plan' ? '推广计划' : '营销场景';

    var q = (state.adspuQuery || '').trim().toLowerCase();
    var rows = Object.keys(bySpu).map(function (k) { return bySpu[k]; })
      .filter(function (r) {
        return !q || r.name.toLowerCase().indexOf(q) >= 0 || String(r.spu).indexOf(q) >= 0;
      })
      .sort(function (a, b) { return b.total - a.total; });
    var totalRows = rows.length;
    var limit = Number(state.adspuLimit) || 0;
    var shown = limit > 0 ? rows.slice(0, limit) : rows;
    var matrixSum = rows.reduce(function (s, r) { return s + r.total; }, 0);
    var shopSpend = daily.filter(function (r) { return r.date >= range.start && r.date <= range.end; })
      .reduce(function (s, r) { return s + (r.ad_spend || 0); }, 0);

    if (!state.adspuPick || !shown.some(function (r) { return r.spu === state.adspuPick; })) {
      state.adspuPick = shown.length ? shown[0].spu : null;
    }
    var picked = shown.filter(function (r) { return r.spu === state.adspuPick; })[0] || null;

    $('adspuKpis').innerHTML =
      miniKpi(suffix + '整店推广花费', M.money(shopSpend), rangeLabel + ' 推广 CSV 合计') +
      miniKpi('单品层花费', M.money(matrixSum),
              '与整店差 ' + M.money(Math.abs(shopSpend - matrixSum) < 0.005 ? 0 : shopSpend - matrixSum) +
              '（未匹配 SPU 的投放）') +
      miniKpi('有花费单品', M.count(rows.length) + ' 个', rangeLabel + ' 花费 > 0') +
      miniKpi('有花费' + dimName, M.count(cols.length) + ' 个',
              dim === 'plan' ? '京准通真实推广计划名' : '关键词快车 / 人群 / 全店推广 / 其他 / 智能化') +
      miniKpi('当前选中单品', picked ? picked.name : '—',
              picked ? M.money(picked.total) + ' · ' + Object.keys(picked.cells).length + ' 个' + dimName
                     : rangeWord + '无数据');
    $('adspuRows').textContent = rangeLabel + ' · ' + shown.length + ' / ' + totalRows + ' 个单品 · ' +
      cols.length + ' 个' + dimName;
    $('adspuNote').textContent = mode === 'day'
      ? '左侧选单品 → 右侧只列 ' + d + ' 当天有花费的' + dimName + '，0 花费不占位'
      : '按顶部周期条聚合，左侧选单品 → 右侧只列该区间有花费的' + dimName + '，0 花费不占位；' +
        '想只看某天用上面的「日期」下拉';

    $('adspuPickList').innerHTML = shown.map(function (r) {
      return '<button type="button" class="adspu-pick' +
        (picked && r.spu === picked.spu ? ' active' : '') +
        '" data-spu="' + esc(r.spu) + '" title="SPU ' + esc(r.spu) + '">' +
        '<span class="p-name">' + esc(r.name) + '</span>' +
        '<span class="p-cnt" title="有花费的' + esc(dimName) + '数">' +
        Object.keys(r.cells).length + ' 项</span>' +
        '<span class="p-val">' + esc(M.money(r.total)) + '</span></button>';
    }).join('') || '<div class="adspu-empty">没有匹配的单品</div>';
    $('adspuPickCount').textContent = shown.length + ' / ' + totalRows;

    if (!picked) {
      $('adspuDetailTitle').textContent = '—';
      $('adspuDetailNote').textContent = rangeWord + '无每日推广数据';
      $('adspuDetailTable').innerHTML = '';
    } else {
      var items = Object.keys(picked.cells).map(function (k) {
        var arr = picked.cells[k];
        var sp = arr[iSpend] || 0;
        return {
          key: k, spend: sp,
          share: picked.total ? (sp / picked.total * 100).toFixed(1) + '%' : '0.0%',
          clicks: iClicks >= 0 ? (arr[iClicks] || 0) : 0,
          impressions: iImpr >= 0 ? (arr[iImpr] || 0) : 0,
          add_cart: iCart >= 0 ? (arr[iCart] || 0) : 0,
          order_amount: iAmt >= 0 ? (arr[iAmt] || 0) : 0
        };
      }).sort(function (a, b) { return b.spend - a.spend; });
      var sumOf = function (key) {
        return items.reduce(function (s, r) { return s + (r[key] || 0); }, 0);
      };
      $('adspuDetailTitle').textContent = picked.name + ' · ' + suffix + ' ' + M.money(picked.total);
      $('adspuDetailNote').textContent = '只列有花费的 ' + items.length + ' 个' + dimName +
        '（全店' + suffix + '共 ' + cols.length + ' 个）· 点击 ' + M.count(picked.m.clicks) +
        ' / 展现 ' + M.count(picked.m.impressions);
      var planScenes = (DATA.spu_plan_daily || {}).plan_scenes || {};
      var firstCol = dim === 'plan'
        ? { label: dimName, raw: true, cls: 'ta-l', get: function (r) {
              var raw = planScenes[r.key] || '';
              var label = raw ? (ADSPU_SCENE_LABELS[raw] || raw) : '';
              if (!label) return esc(r.key);
              var c = ADSPU_SCENE_CLASS[label] || 's-other';
              return esc(r.key) + ' <span class="adspu-scene ' + c + '" title="' + esc(raw) + '">' +
                esc(label) + '</span>';
            } }
        : { label: dimName, get: function (r) { return r.key; }, fmt: String, cls: 'ta-l' };
      var tbl = tableHtml([
        firstCol,
        { label: '花费', get: function (r) { return r.spend; }, fmt: M.money },
        { label: '占比', get: function (r) { return r.share; }, fmt: String },
        { label: '点击', get: function (r) { return r.clicks; }, fmt: M.count },
        { label: '展现', get: function (r) { return r.impressions; }, fmt: M.count },
        { label: '加购', get: function (r) { return r.add_cart; }, fmt: M.count },
        { label: '成交额', get: function (r) { return r.order_amount; }, fmt: M.money }
      ], items);
      $('adspuDetailTable').innerHTML = tbl +
        '<tfoot><tr><td><b>合计 · ' + items.length + ' 个' + esc(dimName) + '</b></td>' +
        '<td><b>' + esc(M.money(sumOf('spend'))) + '</b></td>' +
        '<td><b>100.0%</b></td>' +
        '<td>' + esc(M.count(sumOf('clicks'))) + '</td>' +
        '<td>' + esc(M.count(sumOf('impressions'))) + '</td>' +
        '<td>' + esc(M.count(sumOf('add_cart'))) + '</td>' +
        '<td>' + esc(M.money(sumOf('order_amount'))) + '</td></tr></tfoot>';
    }
    $('adspuFoot').innerHTML = '口径：推广花费取京准通「每日报表」SKU 日明细，按跟单SKU ID 反查 SPU；' +
      '未匹配到 SPU 的投放只进整店口径、不摊派到单品。' +
      (mode === 'day'
        ? '下钻明细只列该单品当天花费 > 0 的' + esc(dimName) + '，合计等于该单品当日推广花费。'
        : '当前按区间累计：把区间内每天的同一' + esc(dimName) + '花费相加，0 花费不占位、不估算回填。') +
      (dim === 'plan'
        ? '计划名来自报表「推广计划」列，与「计划分析」页的词级区间汇总<b>不是同一口径</b>，不可横比。'
        : '场景分组：关键词快车 / 人群 / 全店推广 / 其他 / 智能化，与「单品分析」页推广花费分布同源。') +
      ' ' + esc(planView.coverage_note || '');
  }

  function renderService() {
    var m = masterData();
    $('emptyIcon').textContent = m ? '✓' : '—';
    $('emptyTitle').textContent = m ? '客服数据（来自数据总表）' : '客服数据';
    $('emptyDesc').textContent = m
      ? '询单 / 成交客户 / 客服转化率 / 询单率来自桌面「11月专卖店数据总.xlsx」，与 37 列明细口径不同，仅参考。'
      : '客服响应时长 / 询单转化未接入。';
    if (!m) return;
    var rows = m.nov_2026_daily || [];
    var sum = function (k) { return rows.reduce(function (s, r) { return s + (r[k] || 0); }, 0); };
    var cols = [
      { label: '日期', get: function (r) { return r.date; }, raw: true },
      { label: '总访客', get: function (r) { return r.visitors; } },
      { label: '询单人数', get: function (r) { return r.inquiry; } },
      { label: '成交客户数', get: function (r) { return r.buyers; } },
      { label: '客服转化率', get: function (r) { return r.service_cvr; }, digits: 4 },
      { label: '询单率', get: function (r) { return r.inquiry_rate; }, digits: 4 },
      { label: '询单成本', get: function (r) { return r.inquiry_cost; }, digits: 2 },
      { label: '加购客户数', get: function (r) { return r.add_cart; } },
      { label: '加购率', get: function (r) { return r.add_cart_rate; }, digits: 4 }
    ];
    $('emptyNote').innerHTML = '<div style="text-align:left;max-width:820px;margin:0 auto">' +
      '<div class="kpis" style="grid-template-columns:repeat(3,1fr)">' +
      miniKpi('询单人数合计', M.count(sum('inquiry')), '11/01~11/04 累计') +
      miniKpi('成交客户合计', M.count(sum('buyers')), '总表口径') +
      miniKpi('总访客合计', M.count(sum('visitors')), '总表口径，与明细 8,728 略有差异') +
      '</div><div class="tbl-wrap" style="margin-top:12px"><table class="data-table">' +
      tableHtml(cols, rows) + '</table></div>' +
      '<div class="card-note">渠道访客拆分（搜索 / 快车 / 触点 / 海投 / 京速推）在「数据总表」页。</div></div>';
  }

  function renderMaster() {
    var m = masterData();
    if (!m) return;
    var rows = m.nov_2026_daily || [];
    var ly = m.last_year_2025_11_daily || [];
    var sum = function (a, k) { return a.reduce(function (s, r) { return s + (r[k] || 0); }, 0); };
    var T = targetsForRange() || DATA.targets || null, O = DATA.offline_layer || null;
    $('masterKpis').innerHTML = [
      miniKpi((T && T.month ? T.month + ' 月度目标' : '月度目标'), T ? M.money(T.monthly_target) : '—', T ? T.monthly_target_label + ' · 总表 B2，已启用' : '未同步'),
      miniKpi('目标达成率', T ? M.pct(T.achievement) : '—', '含线下净销售额 ÷ 月度目标'),
      miniKpi('净销售额（含线下）', T ? M.money(T.actual_net_sales) : '—', '线上成交 + 线下 − 退款，看板主口径'),
      miniKpi('线上净销售额（对照）', T ? M.money(T.net_sales_online_only) : '—', '仅作对照，未含线下'),
      miniKpi('线下交易金额', O ? M.money(O.total_offline) : '—', '已按日期并入每日销售额'),
      miniKpi('全渠道综合ROI', T ? M.ratio(T.roi) : '—', '成交金额（含线下）÷ 整店推广总花费'),
      miniKpi('推广占比（含线下）', T ? M.pct(T.ad_ratio) : '—', '推广花费 ÷ 含线下净销售额'),
      miniKpi('整店总花费', T ? M.money(T.total_ad_spend) : '—', '只取每日推广 CSV 的 SKU 日明细'),
      miniKpi('总表实际销售（对账）', M.money(sum(rows, 'actual_sales')), '总表口径，退款追溯，与看板不同'),
      miniKpi('询单 / 成交客户', M.count(sum(rows, 'inquiry')) + ' / ' + M.count(sum(rows, 'buyers')), '11/01~11/04 累计，总表口径')
    ].join('');

    $('masterDaily').innerHTML = tableHtml([
      { label: '日期', get: function (r) { return r.date; }, raw: true },
      { label: '月度目标分摊', get: function (r) { return r.target; }, digits: 2 },
      { label: '实际销售', get: function (r) { return r.actual_sales; }, digits: 2 },
      { label: '线下', get: function (r) { return r.offline; }, digits: 0 },
      { label: '总访客', get: function (r) { return r.visitors; } },
      { label: '询单', get: function (r) { return r.inquiry; } },
      { label: '成交客户', get: function (r) { return r.buyers; } },
      { label: '客单价', get: function (r) { return r.aov; }, digits: 2 },
      { label: '转化率', get: function (r) { return r.cvr; }, digits: 5 },
      { label: '加购', get: function (r) { return r.add_cart; } },
      { label: '搜索访客', get: function (r) { return r.visitor_search; } },
      { label: '快车访客', get: function (r) { return r.visitor_kuaiche; } },
      { label: '触点访客', get: function (r) { return r.visitor_touchpoint; } },
      { label: '海投访客', get: function (r) { return r.visitor_haitou; } },
      { label: '推广总花费', get: function (r) { return r.total_ad_spend; }, digits: 2 }
    ], rows);

    $('masterConflicts').innerHTML = (m.conflicts || []).map(function (c) {
      return '<div class="conflict"><b class="sev-' + esc(c.severity) + '">' +
        esc({ critical: '严重', high: '高', medium: '中', low: '低' }[c.severity] || c.severity) + '</b>' +
        esc(c.id) + '<div>' + esc(c.detail) + '</div><span class="rule">规则：' + esc(c.rule) + '</span></div>';
    }).join('');

    var yoy = (m.yoy_compare && m.yoy_compare.rows) || [];
    var h = (m.yoy_compare && m.yoy_compare.header) || [];
    var pick = [1, 2, 5, 6, 17, 18, 20, 21];
    var yoyCols = [{ label: '日期', get: function (r) { return r.key; }, raw: true }].concat(
      pick.filter(function (i) { return i < h.length; }).map(function (i) {
        return { label: h[i], get: function (r) { return r[h[i]]; }, digits: 2 };
      }));
    $('masterYoy').innerHTML = tableHtml(yoyCols, yoy);

    $('masterLyCount').textContent = ly.length + ' 天 · ' + (ly.length ? ly[0].date + '~' + ly[ly.length - 1].date : '');
    $('masterLastYear').innerHTML = tableHtml([
      { label: '日期', get: function (r) { return r.date; }, raw: true },
      { label: '月度目标分摊', get: function (r) { return r.target; }, digits: 2 },
      { label: '实际销售', get: function (r) { return r.actual_sales; }, digits: 2 },
      { label: '线下', get: function (r) { return r.offline; } },
      { label: '总访客', get: function (r) { return r.visitors; } },
      { label: '询单', get: function (r) { return r.inquiry; } },
      { label: '成交客户', get: function (r) { return r.buyers; } },
      { label: '推广总花费', get: function (r) { return r.total_ad_spend; }, digits: 2 }
    ], ly);

    $('masterCross').innerHTML = tableHtml([
      { label: '日期', get: function (r) { return r.date; }, raw: true },
      { label: '明细成交金额（看板口径）', get: function (r) { return r.detail_gmv; }, digits: 2 },
      { label: '总表线上销售', get: function (r) { return r.sheet_online_sales; }, digits: 2 },
      { label: '差额', get: function (r) { return r.gap_detail_minus_sheet; }, digits: 2 },
      { label: '总表实际销售', get: function (r) { return r.sheet_actual_sales; }, digits: 2 },
      { label: '线下', get: function (r) { return r.sheet_offline; }, digits: 0 }
    ], m.cross_check || [], function (c, raw) {
      return c.label === '差额' && raw > 0 ? 'neg' : '';
    });
  }

  function renderMonitor() {
    var T = targetsForRange() || DATA.targets;
    var O = DATA.offline_layer, C = categoriesForRange() || DATA.shop_categories;
    if (!T || T.status !== 'enabled') {
      $('monitorKpis').innerHTML = miniKpi('月度目标', '—', '总表目标未同步');
      $('monitorGap').innerHTML = '<div class="rank-empty">— 目标层未启用</div>';
      return;
    }
    $('monitorKpis').innerHTML = M.targetCards(T).map(function (c) {
      return miniKpi(c.name, c.display, c.hint);
    }).join('');

    $('monitorPace').textContent = T.pace_status + ' · 时间进度 ' + M.pct(T.time_progress) +
      ' / 达成率 ' + M.pct(T.achievement);
    var gapRows = [
      ['累计逐日目标', M.money(T.target_to_date),
        (T.monthly_target_label || '') + ' ÷ ' + T.month_days + ' 天 × ' + T.elapsed_days + ' 天'],
      ['累计净销售额（含线下）', M.money(T.actual_net_sales), '看板主口径，达成率分子'],
      ['进度差', M.money(T.pace_gap), T.pace_status + '（累计目标 − 累计净销售额）'],
      ['剩余缺口', M.money(T.gap_to_target), '月度目标 − 累计净销售额'],
      ['剩余日均需', M.money(T.required_daily_net), '剩余 ' + T.remaining_days + ' 天，每天需完成'],
      ['线下交易金额', M.money(T.offline_total), '已按日期并入每日销售额，参与主口径'],
      ['线上净销售额（对照）', M.money(T.net_sales_online_only), '成交 − 退款，未含线下'],
      ['全渠道综合ROI', M.ratio(T.roi), '成交金额（含线下）÷ 整店推广总花费'],
      ['推广占比（含线下）', M.pct(T.ad_ratio), '推广花费 ÷ 含线下净销售额'],
      ['整店总花费', M.money(T.total_ad_spend), '只取每日推广 CSV 的 SKU 日明细；线下单无推广归因']
    ];
    $('monitorGap').innerHTML = gapRows.map(function (r) {
      return '<div class="validation-item"><div><b>' + esc(r[0]) + '</b>' +
        '<span class="v-detail">' + esc(r[2]) + '</span></div>' +
        '<span class="v-badge">' + esc(r[1]) + '</span></div>';
    }).join('') +
      (O ? '<div class="card-note"><b>与总表对账</b>：' + esc(O.diff_note) +
        '（总表实际销售 ' + M.money(O.sheet_actual_sales_total) + '，差 ' + M.money(O.diff_vs_sheet) + '）</div>' : '') +
      '<div class="card-note"><b>集成规则</b>：' + esc(T.integration_rule || T.isolation_rule || '') + '</div>' +
      (O ? '<div class="card-note"><b>线下覆盖</b>：' + esc(O.coverage_note) + '</div>' : '');

    var offRows = (O && O.rows) || [];
    var pctFmt2 = function (v) {
      return v === null || v === undefined || !isFinite(v) ? '—' : (v * 100).toFixed(2) + '%';
    };
    $('monitorOffline').innerHTML = tableHtml([
      { label: '日期', get: function (r) { return r.date; }, raw: true },
      { label: '线上成交', get: function (r) { return r.online_gmv; }, digits: 2 },
      { label: '线下', get: function (r) { return r.offline; }, digits: 2 },
      { label: '全渠道成交', get: function (r) { return r.gmv_all; }, digits: 2 },
      { label: '退款', get: function (r) { return r.refund; }, digits: 2 },
      { label: '净销售额', get: function (r) { return r.net_sales; }, digits: 2 },
      { label: '整店总花费', get: function (r) { return r.ad_spend; }, digits: 2 },
      { label: '综合ROI', get: function (r) { return r.roi; }, fmt: function (v) { return v === null || v === undefined ? '—' : Number(v).toFixed(2); } },
      { label: '推广占比', get: function (r) { return r.ad_ratio; }, fmt: pctFmt2 },
      { label: '总表实际销售', get: function (r) { return r.sheet_actual_sales; }, digits: 2 }
    ], offRows);

    var cm = (C && C.meta) || {}, catRows = (C && C.rows) || [];
    $('monitorCatNote').textContent = (T.month || '') + ' · 7 类目标合计 ' + M.money(cm.target_sum) +
      '（与总表 ' + (T.monthly_target_label || '') + ' ' +
      (cm.target_sum_matches_master ? '一致' : '不一致') + '）｜未归类成交额占比 ' +
      (cm.unclassified_gmv_share === null || cm.unclassified_gmv_share === undefined ? '—' : M.pct(cm.unclassified_gmv_share)) +
      '｜类目线下已计入 ' + M.money(cm.offline_total_by_category) +
      '｜对登记表未分摊 ' + M.money(cm.offline_unallocated);
    var pctFmt = function (v) {
      return v === null || v === undefined || !isFinite(v) ? '—' : (v * 100).toFixed(2) + '%';
    };
    var ratioFmt = function (v) {
      return v === null || v === undefined || !isFinite(v) ? '—' : Number(v).toFixed(2);
    };
    $('monitorCategory').innerHTML = tableHtml([
      { label: '专卖店类目', get: function (r) { return r.name; }, raw: true },
      { label: '月度目标', get: function (r) { return r.target; }, digits: 2 },
      { label: '线上净销售', get: function (r) { return r.net_sales; }, digits: 2 },
      { label: '线下（登记表）', get: function (r) { return r.offline; }, digits: 2 },
      { label: '全渠道净销售', get: function (r) { return r.net_sales_all_channels; }, digits: 2 },
      { label: '目标达成率', get: function (r) { return r.achievement; }, fmt: pctFmt },
      { label: '缺口', get: function (r) { return r.gap; }, digits: 2 },
      { label: '推广花费', get: function (r) { return r.ad_spend; }, digits: 2 },
      { label: '综合ROI', get: function (r) { return r.roi; }, fmt: ratioFmt },
      { label: '推广占比', get: function (r) { return r.ad_ratio; }, fmt: pctFmt }
    ], catRows, function (c, raw, r) {
      return r.name === '未归类' ? 'dim' : '';
    });
    $('monitorCatRule').textContent = (cm.method || '') + '｜' + (cm.unclassified_note || '') +
      '｜' + (cm.offline_edit_guide || cm.offline_note || '') +
      '｜对账：类目线上净销售 ' + M.money(catRows.reduce(function (s, r) { return s + (r.net_sales || 0); }, 0)) +
      ' + 类目线下 ' + M.money(cm.offline_total_by_category) +
      ' + 未分摊 ' + M.money(cm.offline_unallocated) +
      ' = 全店净销售额 ' + M.money(cm.net_sales_all_channels) +
      '（整店当月线下·登记表 ' + M.money(cm.offline_total_master) + '）';
  }

  function renderView() {
    var meta = VIEW_META[state.view] || VIEW_META.bi;
    $('viewTitle').textContent = meta.title;
    var isBi = state.view === 'bi';
    var isPlan = state.view === 'plan' && planPeriods().length > 0;
    var isMaster = state.view === 'master' && !!masterData();
    var isMonitor = state.view === 'monitor' && !!(DATA.targets && DATA.targets.status === 'enabled');
    var isSpu = state.view === 'spu' && !!DATA.spu_daily;
    var isDetail = state.view === 'detail' && !!DATA.spu_daily;
    var isCategory = state.view === 'category' && !!DATA.spu_daily;
    var isAdspu = state.view === 'adspu' && !!(DATA.spu_scene_daily || DATA.spu_plan_daily);
    var isCompare = state.view === 'compare' && !!DATA.spu_daily;
    var isDiagnosis = state.view === 'diagnosis' && !!DATA.daily;
    $('view-bi').hidden = !isBi;
    $('view-plan').hidden = !isPlan;
    $('view-master').hidden = !isMaster;
    $('view-monitor').hidden = !isMonitor;
    $('view-spu').hidden = !isSpu;
    $('view-detail').hidden = !isDetail;
    $('view-category').hidden = !isCategory;
    $('view-adspu').hidden = !isAdspu;
    $('view-compare').hidden = !isCompare;
    $('view-diagnosis').hidden = !isDiagnosis;
    $('view-other').hidden = isBi || isPlan || isMaster || isMonitor || isSpu || isDetail ||
      isCategory || isAdspu || isCompare || isDiagnosis;
    $('periods').hidden = !(isBi || isSpu || isDetail || isCategory || isCompare || isAdspu || isDiagnosis);
    // 「单日」日期框只在该档出现，值跟 state.singleDate 同步
    if ($('singleDate')) {
      var isSingle = state.mode === 'single_day';
      $('singleDate').hidden = !(isSingle && !$('periods').hidden);
      if (isSingle) $('singleDate').value = state.singleDate || lastDate();
    }
    if (isBi) return;
    if (isPlan) { renderPlan(); return; }
    if (isAdspu) { renderAdspu(); return; }
    if (isMaster) { renderMaster(); return; }
    if (isMonitor) { renderMonitor(); return; }
    if (isCompare) { renderCompare(); return; }
    if (isDiagnosis) { renderDiagnosis(); return; }
    if (isSpu) { renderSpu(); return; }
    if (isDetail) { renderDetail(); return; }
    if (isCategory) { renderCategory(); return; }
    $('emptyIcon').textContent = meta.icon || '—';
    $('emptyTitle').textContent = meta.badge || '待接入';
    $('emptyDesc').textContent = meta.desc || '';
    $('emptyNote').textContent = meta.note || '';
    if (meta.ready) {
      $('emptyIcon').textContent = '✓';
      $('emptyTitle').textContent = '已接入（简版）';
      /* 只剩类目分析的简版排行；商品明细的正常路径在上面的 isSpu 分支，
         这里的 'spu' 只是 spu_daily 缺失时的退路。 */
      var rows = state.view === 'spu'
        ? DATA.by_spu_top : (state.view === 'category' ? DATA.by_category_spend : DATA.by_scene_spend);
      var key = state.view === 'spu' ? 'gmv' : 'spend';
      $('emptyDesc').textContent = '当前展示全周期 Top 10，明细下钻与筛选在下一版补齐。';
      $('emptyNote').innerHTML = rankHtml(rows, key,
        function (x) { return x.key; }, function (x) { return M.money(x[key]); },
        state.view === 'spu' ? spuTip : null);
    }
    if (state.view === 'service' && masterData()) { renderService(); }
    if (state.view === 'datasource') {
      $('emptyIcon').textContent = '✓';
      $('emptyTitle').textContent = '数据源设置';
      $('emptyDesc').textContent = '口径规格 metrics-spec.json（v' + DATA.meta.spec_version + '）；只读源目录：' + DATA.meta.source_root;
      var vv = M.validationView(DATA.validation);
      var doneN = vv.filter(function (v) { return v.status !== 'missing' && v.status !== 'deferred'; }).length;
      var missN = vv.filter(function (v) { return v.status === 'missing'; }).map(function (v) { return v.name; });
      $('emptyNote').innerHTML = '<div style="text-align:left;max-width:680px;margin:0 auto">' +
        '<div class="notice" style="margin-bottom:12px"><strong>数据源校验</strong>：已完成 ' + doneN + '/' + vv.length + ' 张校验' +
          (missN.length ? '；' + missN.join('、') + ' 未同步' : '') + '，完成后自动填充' +
          '<span class="notice-sep">｜</span>未同步指标显示 <b>—</b>；主动留缺口显示 <b>待接入</b>，均不按 0 计算。</div>' +
        vv.map(function (v) {
          var cls = v.status === 'missing' ? 'missing' : (v.status === 'deferred' ? 'deferred' : '');
          return '<div class="validation-item"><div><b>' + esc(v.name) + '</b>' +
            '<span class="v-detail">' + esc(v.detail) + '</span></div>' +
            '<span class="v-badge ' + cls + '">' + esc(v.badge) + '</span></div>';
        }).join('') +
        '<div class="card-note">SKU 反查：' + DATA.sku_lookup.promo_rows_total + ' 行投放，SPU ID=0 共 ' +
          DATA.sku_lookup.spu_id_zero_rows + ' 行，字典命中 ' + DATA.sku_lookup.matched_rows +
          ' 行；未匹配 ' + DATA.sku_lookup.unmatched_skus.length + ' 个 SKU 单独记录，不丢弃。</div>' +
        (DATA.reference_sources || []).map(function (r) {
          return '<div class="validation-item"><b>' + esc(r.name) + '</b><span class="v-badge deferred">参考层</span>' +
            '<span class="v-detail">' + esc(r.role) + '｜不用于：' + esc(r.not_for) + '</span></div>';
        }).join('') +
        dailyUpdateHtml() +
        DATA.warnings.map(function (w) { return '<div class="card-note">· ' + esc(w) + '</div>'; }).join('') + '</div>';
    }
  }

  /* ---------------- 商品明细：SPU × 日 原子指标，前端按顶部周期聚合 ---------------- */
  var SPU_COLS = [
    { key: 'label',         name: '货号',     fmt: 'text' },
    { key: 'visitors',      name: '访客数',   fmt: 'count' },
    { key: 'gmv',           name: '销售额',   fmt: 'money' },
    { key: 'offline',       name: '线下销售额', fmt: 'money_opt' },
    { key: 'net',           name: '净销售额', fmt: 'money' },
    { key: 'headcount',     name: '销售人数', fmt: 'count' },
    { key: 'add_customers', name: '加购人数', fmt: 'count' },
    // 加购件数（add_pieces）2026-11-22 用户要求不展示：京东净件数口径常为负，易误读；数据层仍保留供核对
    { key: 'add_rate',      name: '加购率',   fmt: 'pct' },
    { key: 'aov',           name: '客单价',   fmt: 'money' },
    { key: 'spend',         name: '推广费用', fmt: 'money_opt' },
    { key: 'ad_ratio',      name: '推广占比', fmt: 'pct' },
    { key: 'roi',           name: 'ROI',      fmt: 'ratio' },
    { key: 'inq_persons',   name: '询单人数', fmt: 'count_opt' },
    { key: 'inq_cost',      name: '询单成本', fmt: 'money_opt' }
  ];

  function fmtSpuCell(v, fmt) {
    if (fmt === 'money') return M.money(v);
    if (fmt === 'money_opt') return (!v ? '—' : M.money(v));
    if (fmt === 'count') return M.count(v);
    if (fmt === 'count_opt') return (!v ? '—' : M.count(v));
    if (fmt === 'pct') return M.pct(v);
    if (fmt === 'ratio') return M.ratio(v);
    return v == null ? '' : String(v);
  }

  // ── 询单（商品咨询）───────────────────────────────────────────────
  // 口径（2026-11-20 用户确认）：
  //   · 只统计「状态 = 询单」，非询单留档但不计入；
  //   · 分层询单人数 = 按 (顾客, SPU) 去重 —— 单品层唯一合理口径，且类目/全店可由单品加总；
  //   · 全店另给「去重询单客户数」= 按 (顾客) 去重，与分层的和不是同一口径，页面分开标注。
  function inquiryRange(start, end) {
    var Q = DATA.inquiry || {};
    var o = { ready: false, bySpu: {}, persons: 0, custs: 0, deals: 0,
              minDate: null, maxDate: null, unmatched: 0, coveredEnd: null, partial: false };
    var m = Q.meta || {};
    if (!Q.rows || !Q.rows.length || m.status === 'missing') return o;
    o.ready = true;
    o.minDate = (m.date_range || [])[0];
    o.maxDate = (m.date_range || [])[1];
    // 询单是每周一导的，可能比销售/推广晚几天。成本的分母只能覆盖到询单末日，
    // 所以分子（推广花费）必须同期截断，否则会把没询单数据的那几天的花费算进来、成本虚高。
    o.coveredEnd = (o.maxDate && o.maxDate < end) ? o.maxDate : end;
    o.partial = !!(o.maxDate && o.maxDate < end);
    var g = {}, c = {};
    Q.rows.forEach(function (r) {
      if (r.date < start || r.date > end) return;
      if (r.status !== '询单') return;
      // 全店去重客户数要含「未匹配 SPU」的顾客，否则会比源明细少
      if (r.cust) c[r.cust] = 1;
      var spu = r.spu || '';
      if (!spu) { o.unmatched++; return; }        // 未匹配 SPU 不进分层，避免单品≠全店
      var k = (r.cust || '') + '|' + spu;
      if (g[k]) { if (r.deal) g[k].deal = 1; }
      else g[k] = { spu: spu, deal: r.deal ? 1 : 0 };
    });
    Object.keys(g).forEach(function (k) {
      var spu = g[k].spu;
      o.bySpu[spu] = (o.bySpu[spu] || 0) + 1;
      o.persons++;
      if (g[k].deal) o.deals++;
    });
    o.custs = Object.keys(c).length;
    return o;
  }

  /** 把 SPU×日 原子层按当前周期聚合成单品行，派生指标一律在这里算 */
  function spuRowsInRange(range) {
    var S = DATA.spu_daily;
    if (!S || !S.rows) return [];
    var IQ = inquiryRange(range.start, range.end);
    var inqEnd = IQ.coveredEnd || range.end;
    var ix = {};
    S.fields.forEach(function (k, i) { ix[k] = i; });
    var out = [];
    Object.keys(S.rows).forEach(function (spu) {
      var days = S.rows[spu], hit = false;
      var a = { spu_id: spu, gmv: 0, refund: 0, visitors: 0, customers: 0,
                add_customers: 0, add_pieces: 0, spend: 0, spend_inq: 0, orders: 0,
                online: 0, offline: 0, offline_pieces: 0, offline_customers: 0,
                day_count: 0 };
      Object.keys(days).forEach(function (d) {
        if (d < range.start || d > range.end) return;
        hit = true; a.day_count++;
        var v = days[d];
        a.online += v[ix.gmv] || 0;
        a.offline += v[ix.offline_gmv] || 0;
        a.refund += v[ix.refund] || 0;
        a.visitors += v[ix.visitors] || 0;
        a.customers += v[ix.customers] || 0;
        a.add_customers += v[ix.add_customers] || 0;
        a.add_pieces += v[ix.add_pieces] || 0;
        a.spend += v[ix.spend] || 0;
        if (d <= inqEnd) a.spend_inq += v[ix.spend] || 0;
        a.orders += v[ix.orders] || 0;
        a.offline_pieces += v[ix.offline_pieces] || 0;
        a.offline_customers += v[ix.offline_customers] || 0;
      });
      if (!hit) return;
      var m = (S.meta && S.meta[spu]) || [];
      a.label = m[0] || M.spuLabel(DATA, spu);
      a.cat = m[1] || '';
      // 全渠道口径：销售额 = 线上 + 线下登记，与 BI 页整店主口径一致
      a.gmv = a.online + a.offline;
      a.net = a.gmv - a.refund;
      a.headcount = a.customers + a.offline_customers;
      a.add_rate = a.visitors > 0 ? a.add_customers / a.visitors : null;
      a.aov = a.headcount > 0 ? a.gmv / a.headcount : null;
      a.ad_ratio = a.gmv > 0 ? a.spend / a.gmv : null;
      a.roi = a.spend > 0 ? a.gmv / a.spend : null;
      out.push(a);
    });
    // 询单：单品层按 (顾客, SPU) 去重；询单成本 = 该单品花费 ÷ 该单品询单人数
    // 分子只用「询单数据覆盖期」内的花费，与分母同期，避免询单未更新时成本虚高
    out.forEach(function (r) {
      r.inq_persons = IQ.bySpu[r.spu_id] || 0;
      r.inq_cost = (r.inq_persons > 0 && r.spend_inq > 0) ? r.spend_inq / r.inq_persons : null;
    });
    return out;
  }

  /** 线下人头：row_sum = 各行客户数相加（人次），dedup = 按「日期+同单标记」合并后的真实人数 */
  function offlineHeadcountInRange(range) {
    var OS = DATA.offline_spu || {};
    var byDate = ((OS.customers_recon || {}).by_date) || {};
    var o = { row_sum: 0, dedup: 0, dup_extra: 0, multi_groups: 0, days: 0 };
    Object.keys(byDate).forEach(function (d) {
      if (d < range.start || d > range.end) return;
      var x = byDate[d] || {};
      o.row_sum += x.row_sum || 0;
      o.dedup += x.dedup || 0;
      o.multi_groups += x.multi_groups || 0;
      o.days++;
    });
    o.row_sum = Math.round(o.row_sum);
    o.dedup = Math.round(o.dedup);
    o.dup_extra = o.row_sum - o.dedup;
    return o;
  }

  /* ---------------- 数据对比：单品环比 / 同比（2026-11-24 新增） ----------------
     用户 2026-11-24 指定：按单品看「销售额 / 访客 / 花费 / 加购数 / 加购率 /
     询单数 / 询单率 / 询单成本」的本期、上一周期、去年同期三行，附环比与同比。
     口径全部复用 spuRowsInRange：销售额含线下、询单按 (顾客,SPU) 去重、
     询单成本分子按询单覆盖期截断，与「单品分析」页同一套算法，不另立一套。 */
  var CMP_METRICS = [
    { key: 'gmv',         name: '销售额', fmt: 'money' },
    { key: 'visitors',    name: '访客',   fmt: 'count' },
    { key: 'spend',       name: '花费',   fmt: 'money' },
    { key: 'add_customers', name: '加购数', fmt: 'count' },
    { key: 'add_rate',    name: '加购率', fmt: 'pct' },
    { key: 'inq_persons', name: '询单数', fmt: 'count' },
    { key: 'inq_rate',    name: '询单率', fmt: 'pct' },
    { key: 'inq_cost',    name: '询单成本', fmt: 'money', inverted: true }
  ];

  function cmpFmt(v, kind) {
    if (v === null || v === undefined) return '—';
    if (kind === 'money') return M.money(v);
    if (kind === 'count') return M.count(v);
    if (kind === 'pct') return M.pct(v);
    return String(v);
  }

  /** 环比 / 同比：基期为空或 ≤0 时不编数，直接给 null（页面显示 —） */
  function cmpDelta(cur, base) {
    if (cur === null || cur === undefined || base === null || base === undefined) return null;
    if (!isFinite(cur) || !isFinite(base) || base <= 0) return null;
    return (cur - base) / base;
  }

  /* 涨跌配色（用户 2026-11-24 指定）：
     正向指标（销售额/访客/花费/加购/询单数/各率）涨＝好＝红、跌＝坏＝绿；
     询单成本是负向指标，反过来——成本降＝好＝红、成本涨＝坏＝绿。
     inverted=true 表示该指标「越小越好」。 */
  function cmpDeltaHtml(v, inverted) {
    if (v === null) return '<span class="cmp-na">—</span>';
    var good = inverted ? v < 0 : v > 0;
    var cls = v === 0 ? '' : (good ? 'cmp-up' : 'cmp-down');
    var sign = v > 0 ? '+' : '';
    return '<span class="' + cls + '"' + (inverted ? ' title="成本类指标：降为好（红）、涨为差（绿）"' : '') + '>' +
      sign + (v * 100).toFixed(2) + '%</span>';
  }

  function cmpRow(trCls, label, row, metrics) {
    var tds = metrics.map(function (m) {
      return '<td>' + cmpFmt(row ? row[m.key] : null, m.fmt) + '</td>';
    }).join('');
    return '<tr class="' + trCls + '"><td>' + esc(label) + '</td>' + tds + '</tr>';
  }

  /* 环比基期：用户 2026-11-24 指定「上一个自然月的同日期」——
     11/01~11/23 要对比 10/01~10/23，而不是等长紧邻的 10/09~10/31。
     规则：起止同月（当月/上月/月选择器）→ 上月 1 号 ~ 上月同结束日（上月没有该日则取月末）；
     跨月或滚动窗口（近7/15/30）→ 退回等长紧邻，并在提示条里写明，因为"上月同日期"没有定义。 */
  function cmpPrevRange(range) {
    var sm = range.start.slice(0, 7), em = range.end.slice(0, 7);
    if (sm !== em) {
      var f = M.prevRange(range);
      return { start: f.start, end: f.end, days: f.days, sameMonth: false };
    }
    var y = +sm.slice(0, 4), mo = +sm.slice(5, 7);
    var py = mo === 1 ? y - 1 : y, pm = mo === 1 ? 12 : mo - 1;
    var pmStr = py + '-' + String(pm).padStart(2, '0');
    var lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();   // 上月最后一天
    var endDay = Math.min(+range.end.slice(8, 10), lastDay);
    var startDay = Math.min(+range.start.slice(8, 10), lastDay);
    var st = pmStr + '-' + String(startDay).padStart(2, '0');
    var en = pmStr + '-' + String(endDay).padStart(2, '0');
    var days = (new Date(en + 'T00:00:00Z') - new Date(st + 'T00:00:00Z')) / 86400000 + 1;
    return { start: st, end: en, days: days, sameMonth: true };
  }

  function renderCompare() {
    var range = currentRange();
    var prevR = cmpPrevRange(range);
    var yoyR = M.yoyRange(range);
    var cur = spuRowsInRange(range);
    var prev = spuRowsInRange(prevR);
    var yoy = spuRowsInRange(yoyR);

    var P = {}, Y = {};
    prev.forEach(function (r) { P[r.spu_id] = r; });
    yoy.forEach(function (r) { Y[r.spu_id] = r; });
    [cur, prev, yoy].forEach(function (arr) {
      arr.forEach(function (r) {
        r.inq_rate = r.visitors > 0 ? (r.inq_persons || 0) / r.visitors : null;
      });
    });

    var sortKey = state.cmpSort || 'gmv';
    var q = (state.cmpQuery || '').trim().toLowerCase();
    var list = cur.filter(function (r) {
      if (!q) return true;
      return (r.label + ' ' + r.spu_id + ' ' + (r.cat || '')).toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (x, z) { return (z[sortKey] || 0) - (x[sortKey] || 0); });

    if (!list.length) {
      $('cmpPick').innerHTML = '<option>— 无匹配单品 —</option>';
      $('cmpKpis').innerHTML = '';
      $('cmpTable').innerHTML = '';
      $('cmpHeadNote').textContent = '—';
      $('cmpFootNote').textContent = '当前周期没有匹配的单品，换个搜索词或周期再试。';
      return;
    }
    var pick = state.cmpPick;
    var idx = list.findIndex(function (r) { return r.spu_id === pick; });
    if (idx < 0) idx = 0;
    var row = list[idx];
    state.cmpPick = row.spu_id;
    $('cmpPick').innerHTML = list.map(function (r, i) {
      return '<option value="' + r.spu_id + '"' + (i === idx ? ' selected' : '') + '>' +
        esc(r.label) + (r.cat ? '（' + esc(r.cat) + '）' : '') + '</option>';
    }).join('');

    var p = P[row.spu_id], y = Y[row.spu_id];
    var hasYoY = yoy.length > 0;

    // KPI：本期销售额 + 环比 + 同比 + 本期询单成本
    function kpi(label, value, sub, cls) {
      return '<div class="kpi"><div class="name">' + label + '</div>' +
        '<div class="value' + (cls ? ' ' + cls : '') + '">' + value + '</div>' +
        '<div class="hint">' + (sub || '') + '</div></div>';
    }
    function deltaKpi(label, curV, baseV, sub) {
      var d = cmpDelta(curV, baseV);
      var s = d === null ? '—' : ((d > 0 ? '+' : '') + (d * 100).toFixed(2) + '%');
      return kpi(label, s, sub, d === null ? '' : (d > 0 ? 'up' : (d < 0 ? 'down' : '')));
    }
    $('cmpKpis').innerHTML =
      kpi('本期销售额', M.money(row.gmv), range.start + '~' + range.end) +
      deltaKpi('环比', row.gmv, p ? p.gmv : null, prevR.start + '~' + prevR.end) +
      deltaKpi('同比', row.gmv, y ? y.gmv : null, yoyR.start + '~' + yoyR.end) +
      kpi('本期询单成本', row.inq_cost === null ? '—' : M.money(row.inq_cost),
          row.inq_persons ? row.inq_persons + ' 人询单' : '本期无询单');

    // 对照表：指标为行，周期为列，右侧两列是环比 / 同比
    var head = '<thead><tr><th>指标</th><th>本期<br><span class="th-sub">' + range.start + '~' + range.end +
      '</span></th><th>上一周期<br><span class="th-sub">' + prevR.start + '~' + prevR.end +
      '</span></th><th>去年同期<br><span class="th-sub">' + yoyR.start + '~' + yoyR.end +
      '</span></th><th>环比</th><th>同比</th></tr></thead>';
    var body = CMP_METRICS.map(function (m) {
      return '<tr><td class="ta-l">' + m.name + '</td>' +
        '<td class="cmp-cur-cell">' + cmpFmt(row[m.key], m.fmt) + '</td>' +
        '<td>' + cmpFmt(p ? p[m.key] : null, m.fmt) + '</td>' +
        '<td>' + cmpFmt(y ? y[m.key] : null, m.fmt) + '</td>' +
        '<td>' + cmpDeltaHtml(cmpDelta(row[m.key], p ? p[m.key] : null), m.inverted) + '</td>' +
        '<td>' + cmpDeltaHtml(cmpDelta(row[m.key], y ? y[m.key] : null), m.inverted) + '</td></tr>';
    }).join('');
    $('cmpTable').innerHTML = head + '<tbody>' + body + '</tbody>';

    $('cmpHeadNote').textContent = row.label + (row.cat ? ' · ' + row.cat : '') +
      ' · SPU ' + row.spu_id + ' · 第 ' + (idx + 1) + '/' + list.length + ' 个';
    $('cmpNoticeText').textContent =
      '本期 ' + range.start + ' ~ ' + range.end + '（' + range.days + ' 天）；环比基期 ' +
      prevR.start + ' ~ ' + prevR.end +
      (prevR.sameMonth ? '（上月同日期）' : '（等长紧邻：当前是跨月/滚动窗口，"上月同日期"无定义）') +
      '；同比基期 ' + yoyR.start + ' ~ ' + yoyR.end +
      '。销售额含线下登记；加购数取加购人数；询单按 (顾客,SPU) 去重；询单成本 = 该单品花费 ÷ 该单品询单人数。';
    $('cmpFootNote').innerHTML = (hasYoY
      ? '同比基期有数据（' + yoyR.start + ' 起）。'
      : '<b>同比基期 ' + yoyR.start + ' ~ ' + yoyR.end + ' 库里没有数据</b>，所以同比列显示「—」，不是算不出来，是缺去年同期的销售明细与推广 CSV。') +
      ' 环比行与同比行的百分比 = (本期 − 基期) ÷ 基期，基期为 0 或缺失时显示「—」；涨红跌绿。';
  }

  /* ==================== AI 诊断报表 · 自动洞察 + 转化漏斗（2026-11-25） ====================
     计算层全部在 metrics.js（M.scanRange / M.attributeDelta / M.judgementText），
     这里只负责取数、组装与渲染，方便 selftest.js 用同一套函数断言。 */

  var DIAG_IGNORE_KEY = 'ziye_diag_ignored_v1';
  function diagIgnored() {
    try {
      var raw = localStorage.getItem(DIAG_IGNORE_KEY);
      var o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }
  function diagDataStamp() {
    return (DATA.meta && DATA.meta.date_range && DATA.meta.date_range[1]) || '';
  }
  function diagSetIgnored(id, on) {
    var o = diagIgnored();
    // 存「点忽略时的数据末日」：只要数据还是那一天就保持隐藏；日更到新的一天自动解除
    if (on) o[id] = diagDataStamp(); else delete o[id];
    try { localStorage.setItem(DIAG_IGNORE_KEY, JSON.stringify(o)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function diagAlertId(a) { return a.kind + '|' + (a.date || '') + '|' + (a.key || ''); }
  function diagAlertVisible(a) {
    var ts = diagIgnored()[diagAlertId(a)];
    if (!ts) return true;
    var stamp = diagDataStamp();
    return !!stamp && stamp > ts;   // 数据末日前进 → 自动解除
  }

  /** 构建当期预警：目标进度 + 异常扫描 + 数据覆盖三类，统一 {kind,date,key,title,detail,level,good} */
  function buildAlerts(ctx) {
    var out = [], T = ctx.target, range = ctx.range;
    if (T && T.status === 'enabled' && isFinite(T.pace_gap) && T.pace_gap > 0) {
      out.push({ kind: 'pace', date: range.end, key: '',
        title: '目标进度落后', level: T.pace_gap / Math.max(T.monthly_target, 1) > 0.1 ? 'bad' : 'warn',
        detail: '落后 ' + M.money(T.pace_gap) + '，剩余 ' + T.remaining_days + ' 天日均需 ' +
          M.money(T.required_daily_net) + '（时间进度 ' + M.pct(T.time_progress) +
          ' / 达成率 ' + M.pct(T.achievement) + '）' });
    }
    (ctx.anomalies || []).forEach(function (a) {
      out.push({ kind: 'anomaly', date: a.date, key: a.key,
        title: (a.good ? '有利偏离' : '不利偏离') + ' · ' + a.name,
        level: a.good ? 'good' : (Math.abs(a.z) >= 5 ? 'bad' : 'warn'),
        detail: a.date + ' 实际 ' + a.fmt(a.value) + '，基线 ' + a.fmt(a.mean) +
          '（样本 ' + a.n + ' 天，|z|=' + (isFinite(a.z) ? Math.abs(a.z).toFixed(1) : '∞') +
          '）' + (a.pct !== null ? '，偏离 ' + (a.pct > 0 ? '+' : '') + (a.pct * 100).toFixed(1) + '%' : '') });
    });
    var IQ = ctx.inquiry;
    if (IQ && IQ.ready && IQ.partial && IQ.maxDate && IQ.maxDate < range.end) {
      out.push({ kind: 'coverage', date: range.end, key: 'inquiry',
        title: '询单数据覆盖滞后', level: 'warn',
        detail: '询单明细导到 ' + IQ.maxDate + '，所选周期末日是 ' + range.end +
          '。询单成本分子已按覆盖末日截断，漏斗询单段仅统计已覆盖日期。' });
    }
    return out;
  }

  function diagFmtValue(key, v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (key === 'gmv' || key === 'net_sales' || key === 'ad_spend') return M.money(v);
    if (key === 'roi') return M.ratio(v);
    if (key === 'cart_rate' || key === 'refund_rate') return M.pct(v);
    return M.count(v);
  }

  function renderDiagnosis() {
    var range = currentRange();
    var rows = M.rowsBetween(DATA.daily, range);
    var agg = M.aggregate(rows);
    var prevRange = state.compare && state.mode !== 'yoy' ? cmpPrevRange(range) : null;
    var prevAgg = prevRange ? M.aggregate(M.rowsBetween(DATA.daily, prevRange)) : null;
    var T = targetsForRange();
    // 单日与短周期（≤31 天）逐日扫基线；跨月长周期逐日扫会产生大量伪异常，跳过异常扫描
    var anomalies = rows.length <= 31
      ? M.scanRange(DATA.daily, rows, { window: 28, zThreshold: 3, limit: 8 }) : [];
    var IQ = inquiryRange(range.start, range.end);

    var dPct = (prevAgg && prevAgg.gmv > 0) ? (agg.gmv - prevAgg.gmv) / prevAgg.gmv : null;
    var v = M.judgementText({ target: T, delta: { gmvPct: dPct }, anomalies: anomalies });
    $('diagSummary').innerHTML = '<div class="diag-verdict ' + v.level + '">' +
      '<span class="diag-verdict-tag">' + ({ good: '正常', warn: '需关注', bad: '需处理' }[v.level]) + '</span>' +
      '<span class="diag-verdict-text">' + esc(v.text) + '</span></div>';

    $('diagCompareNote').textContent = range.start + ' ~ ' + range.end + '（' + rows.length + ' 天）' +
      (prevRange ? ' vs ' + prevRange.start + ' ~ ' + prevRange.end +
        (prevRange.sameMonth ? '（上月同日期）' : '（跨月/滚动窗口，等长紧邻）')
        : ' · 未勾选对比');
    var cmpDefs = [
      { key: 'gmv', name: '成交额', fmt: M.money },
      { key: 'net_sales', name: '净销售额', fmt: M.money },
      { key: 'refund', name: '退款', fmt: M.money },
      { key: 'ad_spend', name: '推广花费', fmt: M.money },
      { key: 'visitors', name: '访客数', fmt: M.count },
      { key: 'add_cart', name: '加购人数', fmt: M.count },
      { key: 'orders', name: '成交单量', fmt: M.count },
      { key: 'roi', name: '综合ROI', fmt: M.ratio },
      { key: 'ad_ratio', name: '推广占比', fmt: M.pct }
    ];
    // 涨跌配色全站统一「涨红跌绿」，只有询单成本是反向指标；花费/退款/推广占比
    // 虽是成本类，仍按用户 2026-11-24 定的规则走正向配色，不为它们单独反转。
    var cRows = cmpDefs.map(function (d) {
      var cur = agg[d.key], pv = prevAgg ? prevAgg[d.key] : null;
      var delta = M.deltaOf(cur, pv);
      return '<tr><td>' + esc(d.name) + '</td><td class="ta-r">' + esc(d.fmt(cur)) + '</td>' +
        '<td class="ta-r">' + esc(prevAgg ? d.fmt(pv) : '—') + '</td>' +
        '<td class="ta-r">' + cmpDeltaHtml(delta, false) + '</td></tr>';
    }).join('');
    $('diagKpiTable').innerHTML = '<thead><tr><th>指标</th><th class="ta-r">当期</th>' +
      '<th class="ta-r">上一周期</th><th class="ta-r">变化</th></tr></thead><tbody>' + cRows + '</tbody>';

    $('diagAnomNote').textContent = anomalies.length
      ? '检出 ' + anomalies.length + ' 项 |z|≥3' : '各指标均在基线区间内';
    $('diagAnomalies').innerHTML = anomalies.length ? anomalies.map(function (a) {
      var ztxt = isFinite(a.z) ? Math.abs(a.z).toFixed(1) : '∞';
      return '<div class="diag-anom ' + (a.good ? 'good' : 'bad') + '">' +
        '<div class="diag-anom-top"><b>' + esc(a.name) + ' · ' + esc(a.date.slice(5)) + '</b>' +
        '<span class="diag-anom-z">|z| ' + ztxt + '</span></div>' +
        '<div class="diag-anom-body">实际 <b>' + esc(a.fmt(a.value)) + '</b> ／ 基线 ' +
        esc(a.fmt(a.mean)) + '（' + a.n + ' 天）' +
        (a.pct !== null ? ' · 偏离 ' + (a.pct > 0 ? '+' : '') + (a.pct * 100).toFixed(1) + '%' : '') + '</div>' +
        '<div class="diag-anom-tip">' + (a.good ? '高于' : '低于') + '基线，' +
        (a.sd > 0 ? '基线标准差 ' + esc(a.fmt(a.sd)) : '基线无波动') + '；仅为线索，需结合业务判断</div></div>';
    }).join('') : '<div class="rank-empty">— 当前周期没有显著偏离（|z|≥3）</div>';

    // 变化归因：当期 vs 上一周期，按所选指标拆到「类目 / 单品」维度
    var dk = state.diagDriverMetric || 'gmv';
    // 归因指标是页面级命名（net_sales / ad_spend），SPU 原子层字段叫 net / spend，必须映射
    var SP_DRIVER_FIELD = { gmv: 'gmv', net_sales: 'net', ad_spend: 'spend', visitors: 'visitors' };
    var df = SP_DRIVER_FIELD[dk] || 'gmv';
    var curSpu = spuRowsInRange(range);
    var prevSpu = prevRange ? spuRowsInRange(prevRange) : [];
    var dimKey = state.diagDriverDim || 'cat';
    function pairs(list) {
      var m = {};
      list.forEach(function (r) {
        var k = dimKey === 'spu' ? (r.label || r.spu_id) : (r.cat || '未归类');
        m[k] = (m[k] || 0) + (r[df] || 0);
      });
      return Object.keys(m).map(function (k) { return [k, m[k]]; });
    }
    var A = M.attributeDelta(pairs(curSpu), pairs(prevSpu), { limit: 7 });
    // 列表不截断：用 rowsAll 全量（已按 |差额| 降序），只过滤两期都没变化的项，
    // 否则单品维度滚到底会是一堆 0。容器限高滚动，See all 维度不再只显示 7 条。
    var allDrivers = (A.rowsAll || A.rows).filter(function (r) { return Math.abs(r.delta) > 1e-9; });
    $('diagDriverTotal').textContent = '总差额 ' + diagFmtValue(dk, A.total) +
      ' · 维度 ' + (dimKey === 'spu' ? '单品' : '店内分类') +
      ' · 有变化 ' + allDrivers.length + ' 项';
    $('diagDriverNote').textContent = '贡献 = 维度差额 ÷ 总差额；同向为正贡献、反向为抵消；基期缺数据则显示「—」；点维度名切换类目/单品；列表可上下滚动';
    var maxAbs = Math.max.apply(null, [1].concat(allDrivers.map(function (r) { return Math.abs(r.delta); })));
    var driverHead = '<div class="diag-driver-head"><span>维度（点名切换）</span><span></span>' +
      '<span class="ta-r">差额</span><span class="ta-r">贡献</span></div>';
    $('diagDrivers').innerHTML = driverHead + (allDrivers.length ? allDrivers.map(function (r) {
      var w = Math.max(2, Math.abs(r.delta) / maxAbs * 100);
      var cls = r.delta >= 0 ? 'up' : 'down';
      return '<div class="diag-driver-row"><div class="diag-driver-name" title="' + esc(r.key) + '">' + esc(r.key) + '</div>' +
        '<div class="diag-driver-bar"><i class="' + cls + '" style="width:' + w.toFixed(1) + '%"></i></div>' +
        '<span class="diag-driver-val ' + cls + '">' + esc(diagFmtValue(dk, r.delta)) + '</span>' +
        '<span class="diag-driver-share">' + (r.share === null ? '—' : (r.share * 100).toFixed(0) + '%') + '</span></div>';
    }).join('') : '<div class="rank-empty">— 当前周期无可用归因数据</div>');

    var alerts = buildAlerts({ target: T, range: range, anomalies: anomalies, inquiry: IQ });
    var shown = alerts.filter(diagAlertVisible);
    var hiddenN = alerts.length - shown.length;
    $('diagAlertNote').textContent = '共 ' + alerts.length + ' 条' + (hiddenN ? ' · 已忽略 ' + hiddenN : '');
    $('diagAlerts').innerHTML = shown.length ? shown.map(function (a, i) {
      return '<div class="diag-alert ' + esc(a.level) + '">' +
        '<div class="diag-alert-main"><span class="diag-alert-dot"></span>' +
        '<div><b>' + esc(a.title) + '</b><div class="diag-alert-detail">' + esc(a.detail) + '</div></div></div>' +
        '<button type="button" class="btn diag-ignore" data-alert-id="' + esc(diagAlertId(a)) + '">忽略</button></div>';
    }).join('') + (hiddenN ? '<button type="button" class="btn" id="diagRestoreAll">恢复全部（' + hiddenN + '）</button>' : '')
      : '<div class="rank-empty">— 当前周期无预警</div>';

    renderFunnel(range, rows, agg, IQ);
  }

  /** 转化漏斗：访客 → 加购人数 → 询单人数 → 成交人数。
   *  三段来自销售明细（人次口径），询单来自客服明细（顾客×SPU 去重），
   *  且询单只导到 maxDate —— 不同源、不同去重口径，转化率只能看趋势，不能当同一批人的严格漏斗。 */
  function renderFunnel(range, rows, agg, IQ) {
    var iqReady = IQ && IQ.ready;
    // 询单末日早于所选区间起点（如单日选 11-24、询单只到 11-22）时，不构造倒挂区间：
    // 三段商智指标照常用完整所选周期，询单段留「—」，在下方说明缺数据，不补 0。
    var iqCovered = !!(iqReady && IQ.coveredEnd && range.start <= IQ.coveredEnd);
    var iqEnd = iqCovered ? IQ.coveredEnd : null;
    var iqRows = iqCovered ? M.rowsBetween(DATA.daily, { start: range.start, end: iqEnd }) : [];
    var iqAgg = iqCovered ? M.aggregate(iqRows) : agg;
    var steps = [
      { name: '访客数', value: iqAgg.visitors, src: '商智销售明细 · 人次口径' },
      { name: '加购人数', value: iqAgg.add_cart, src: '商智销售明细 · 加购客户数 col24' },
      { name: '询单人数', value: iqCovered ? IQ.persons : null,
        src: iqCovered ? '客服询单明细 · (顾客,SPU) 去重'
          : '询单只导到 ' + (IQ && IQ.maxDate ? IQ.maxDate : '—') + '，所选区间无覆盖，不补 0' },
      { name: '成交人数', value: iqAgg.customers, src: '商智销售明细 · 成交客户数 col11' }
    ];
    $('funnelNote').textContent = iqCovered
      ? range.start + ' ~ ' + iqEnd +
        (IQ.partial ? '（询单覆盖到 ' + IQ.maxDate + '，其余三段同步截断到该日）' : '（全周期同口径）')
      : range.start + ' ~ ' + range.end +
        '（询单未覆盖该区间，询单段显示 —，其余三段用完整周期）';

    var W = 820, H = 208, maxV = Math.max.apply(null, [1].concat(steps.map(function (s) { return s.value || 0; })));
    var colors = ['#4f6bed', '#5b8def', '#39a0b5', '#2f9e6b'];
    var barW = 520, x0 = 130, gapY = 46, barH = 30;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" class="funnel-svg">';
    steps.forEach(function (s, i) {
      var y = 12 + i * gapY;
      var w = s.value === null ? 0 : Math.max(2, (s.value / maxV) * barW);
      svg += '<text x="' + (x0 - 8) + '" y="' + (y + 20) + '" text-anchor="end" font-size="12" fill="#1d2433">' +
        esc(s.name) + '</text>';
      svg += '<rect x="' + x0 + '" y="' + y + '" width="' + barW + '" height="' + barH +
        '" rx="4" fill="#eef1f6"/>';
      svg += '<rect x="' + x0 + '" y="' + y + '" width="' + w.toFixed(1) + '" height="' + barH +
        '" rx="4" fill="' + colors[i] + '"><title>' + esc(s.name + ' ' + M.count(s.value) + ' · ' + s.src) + '</title></rect>';
      svg += '<text x="' + (x0 + barW + 10) + '" y="' + (y + 20) + '" font-size="12" font-weight="600" fill="#1d2433">' +
        (s.value === null ? '—' : M.count(s.value)) + '</text>';
      if (i > 0 && steps[i - 1].value > 0 && s.value !== null) {
        var rate = s.value / steps[i - 1].value;
        svg += '<text x="' + (x0 + barW + 86) + '" y="' + (y + 20) + '" font-size="11" fill="' +
          (rate >= 1 ? '#8590a2' : '#d93025') + '">' + (rate >= 1 ? '' : '↓ ') + (rate * 100).toFixed(1) + '%</text>';
      }
    });
    svg += '</svg>';
    $('diagFunnel').innerHTML = svg;

    var rates = steps.map(function (s, i) {
      if (i === 0 || s.value === null) return '—';
      var base = steps[i - 1].value;
      return base > 0 ? M.pct(s.value / base) : '—';
    });
    $('funnelTable').innerHTML = '<thead><tr><th>环节</th><th class="ta-r">人数</th>' +
      '<th class="ta-r">环节转化</th><th>数据来源与口径</th></tr></thead><tbody>' +
      steps.map(function (s, i) {
        return '<tr><td>' + esc(s.name) + '</td><td class="ta-r">' +
          (s.value === null ? '—' : M.count(s.value)) + '</td><td class="ta-r">' + rates[i] + '</td>' +
          '<td class="muted">' + esc(s.src) + '</td></tr>';
      }).join('') + '</tbody>';
    $('funnelCaveat').innerHTML = '<b>不可当严格漏斗读</b>：前三段是商智「人次」（同一顾客多日/多货号会重复计），' +
      '询单段是「顾客 × SPU」去重，来源和去重规则都不同；询单与成交也非包含关系' +
      '（不询单可直接下单、询单未必成交）。环节百分比仅用于观察同一口径下的变化趋势，' +
      '不表示同一批用户的流失。<b>询单成本</b>仍按独立口径计算（覆盖期花费 ÷ 分层询单人数）。';
  }

  function renderSpu() {
    var range = currentRange();
    var all = spuRowsInRange(range);
    var q = (state.spuQuery || '').trim().toLowerCase();
    var scope = state.spuScope || 'all';

    var filtered = all.filter(function (r) {
      if (scope === 'sold' && r.gmv <= 0) return false;
      if (scope === 'ad' && r.spend <= 0) return false;
      if (scope === 'active' && r.gmv <= 0 && r.spend <= 0) return false;
      if (scope === 'idle' && !(r.visitors > 0 && r.gmv <= 0)) return false;
      if (!q) return true;
      return (r.label + ' ' + r.spu_id + ' ' + r.cat).toLowerCase().indexOf(q) >= 0;
    });

    var sk = state.spuSort.key, dir = state.spuSort.dir;
    filtered.sort(function (a, b) {
      if (sk === 'label' || sk === 'cat') {
        return String(a[sk] || '').localeCompare(String(b[sk] || ''), 'zh-CN');
      }
      var va = a[sk], vb = b[sk];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;          // 空值永远垫底
      if (vb == null) return -1;
      return dir * (vb - va);            // dir=1 降序，dir=-1 升序
    });

    var tot = { label: '合计', cat: '', gmv: 0, net: 0, refund: 0, visitors: 0,
                customers: 0, add_customers: 0, add_pieces: 0, spend: 0, spend_inq: 0, orders: 0,
                online: 0, offline: 0, offline_pieces: 0, offline_customers: 0, headcount: 0 };
    filtered.forEach(function (r) {
      tot.gmv += r.gmv; tot.net += r.net; tot.refund += r.refund;
      tot.visitors += r.visitors; tot.customers += r.customers;
      tot.add_customers += r.add_customers; tot.add_pieces += r.add_pieces;
      tot.spend += r.spend; tot.spend_inq += (r.spend_inq || 0); tot.orders += r.orders;
      tot.online += r.online; tot.offline += r.offline;
      tot.offline_pieces += r.offline_pieces; tot.offline_customers += r.offline_customers;
    });
    tot.headcount = tot.customers + tot.offline_customers;
    tot.add_rate = tot.visitors > 0 ? tot.add_customers / tot.visitors : null;
    tot.aov = tot.headcount > 0 ? tot.gmv / tot.headcount : null;
    tot.ad_ratio = tot.gmv > 0 ? tot.spend / tot.gmv : null;
    tot.roi = tot.spend > 0 ? tot.gmv / tot.spend : null;
    // 询单按 (顾客,SPU) 去重后各单品互不重叠，可直接相加，正是「分层可加总」口径
    tot.inq_persons = filtered.reduce(function (s, r) { return s + (r.inq_persons || 0); }, 0);
    tot.inq_cost = (tot.inq_persons > 0 && tot.spend_inq > 0) ? tot.spend_inq / tot.inq_persons : null;

    var limit = state.spuLimit || 200;
    var shown = filtered.slice(0, limit);
    $('spuMore').hidden = filtered.length <= limit;
    $('spuMore').textContent = '显示全部 ' + filtered.length + ' 行';
    // 补单剔除只作用在整店日汇总（daily），单品层（spu_daily）无 SPU 粒度来源、不摊派，
    // 因此有补单的月份：单品合计会比首页 KPI 高。这里显式说明，避免两个页面数字互相打脸。
    var adjInfo = (DATA.meta && DATA.meta.sales_adjustments) || {};
    var adjMonths = adjInfo.months || [];
    var adjHit = adjMonths.some(function (m) { return m >= range.start.slice(0, 7) && m <= range.end.slice(0, 7); });
    $('spuCount').textContent = filtered.length + ' 个单品 · ' + range.start + ' ~ ' + range.end +
      (shown.length < filtered.length ? '（显示前 ' + shown.length + ' 行）' : '') +
      (adjHit ? ' · 本期有补单剔除 ¥' + M.money(adjInfo.amount_removed) + '，单品合计按商智明细口径（未扣）' : '');

    var adDays = 0, saleDays = 0, dailyOff = 0;
    M.rowsBetween(DATA.daily, range).forEach(function (r) {
      if ((r.ad_spend || 0) > 0) adDays++;
      if ((r.online_gmv || 0) > 0) saleDays++;
      dailyOff += r.offline_sales || 0;
    });

    var OS = DATA.offline_spu || {};
    var hc = offlineHeadcountInRange(range);
    var notice = '访客 / 销售人数 / 加购人数按日累加，属『人次』口径，' +
      '与商智合计行的区间去重人数不同（当月合计行 8,497 访客，单品层累加要到 10,775 人次）；' +
      '推广费用按 SKU→SPU 字典归集，未匹配的投放只进整店口径、不进单品。';
    if (tot.offline > 0) {
      notice += ' 线下销售额来自「线下销售登记」表（已覆盖 ' +
        ((OS.dates_covered || []).length) + ' 天），已并入销售额、净销售额、客单价，' +
        '推广占比与 ROI 的分母也含线下。';
    }
    if (hc.row_sum > 0) {
      if (hc.dup_extra > 0) {
        notice += ' 线下登记有 ' + hc.multi_groups + ' 笔「一位顾客买多个货号」：' +
          '客户数按行累加是 ' + M.count(hc.row_sum) + ' 人次，按「同单标记」合并后实际 ' +
          M.count(hc.dedup) + ' 位顾客。所以下表合计的销售人数会比真实人头多 ' +
          M.count(hc.dup_extra) + '（单品行各自记 1 人是对的，单品客单价不受影响）。';
      } else if (hc.dedup > 0 && hc.dedup === hc.row_sum) {
        notice += ' 线下客户数按行直接相加（没有填「同单标记」）；若出现一位顾客买多个货号，' +
          '请在登记表把这几行填同一个标记，合计时会自动去重。';
      }
    }
    var gap = dailyOff - tot.offline;
    if (dailyOff > 0 && Math.abs(gap) >= 1) {
      if (tot.offline <= 0) {
        notice += ' 本周期整店线下 ' + M.money(dailyOff) +
          ' 还没按货号登记，所以下表线下金额为空（整店 KPI 不受影响）。' +
          '要按货号看线下，填「917 AI/线下销售登记/线下销售登记_' + range.start.slice(0, 7) + '.xlsx」即可。';
      } else {
        notice += ' 注意：本周期整店线下 ' + M.money(dailyOff) + '，单品登记只有 ' +
          M.money(tot.offline) + '，' + M.money(Math.abs(gap)) +
          ' 未登记到具体货号（不摊派，所以不会出现在本表）。补齐后自动消失。';
      }
    }
    if (saleDays && adDays && adDays < saleDays) {
      notice += ' 注意：本周期推广数据只覆盖 ' + adDays + '/' + saleDays +
        ' 天，推广费用被低估，推广占比与 ROI 会虚高（缺的天数需补导推广 CSV）。';
    }
    $('spuNoticeText').textContent = notice;

    var head = '<thead><tr>' + SPU_COLS.map(function (c) {
      var on = state.spuSort.key === c.key;
      var arrow = on && c.fmt !== 'text' ? (state.spuSort.dir === 1 ? ' ↓' : ' ↑') : '';
      return '<th class="' + (c.fmt === 'text' ? 'ta-l' : '') + (on ? ' sorted' : '') +
        '" data-sort="' + c.key + '">' + esc(c.name) + arrow + '</th>';
    }).join('') + '</tr></thead>';

    var body = shown.length
      ? '<tbody>' + shown.map(function (r) {
          return '<tr><td class="ta-l" title="SPU ' + esc(r.spu_id) + (r.cat ? ' ｜ ' + esc(r.cat) : '') + '">' +
            '<a class="spu-link" data-spu="' + esc(r.spu_id) + '" title="查看该货号的日趋势（单品分析）">' +
              esc(r.label) + '</a></td>' +
            SPU_COLS.slice(1).map(function (c) {
              var cls = '';
              if ((c.key === 'net' && r.net < 0) || (c.key === 'gmv' && r.gmv <= 0)) cls = ' class="dim"';
              else if (c.key === 'offline' && r.offline > 0) {
                cls = ' class="off-cell" title="线下登记 ' + M.money(r.offline) +
                  (r.offline_pieces ? ' ｜ ' + r.offline_pieces + ' 件' : '') +
                  (r.offline_customers ? ' ｜ ' + r.offline_customers + ' 位客户' : '') + '"';
              } else if (c.key === 'add_rate' && r.add_rate != null && r.add_rate > 1) {
                cls = ' class="warn-cell" title="访客数极少时，加购人数可能大于访客数（京东两个指标不同源），不是计算错误"';
              }
              return '<td' + cls + '>' + esc(fmtSpuCell(r[c.key], c.fmt)) + '</td>';
            }).join('') + '</tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td colspan="' + SPU_COLS.length + '" class="ta-l dim">' +
        (!all.length
          ? (state.mode === 'yoy'
              ? '同比模式没有单品数据：京东只提供整店区间汇总，没有去年的单品明细。请切回「当月 / 近 7 天 / 近 30 天」。'
              : '该周期没有任何单品数据。')
          : '没有符合筛选条件的单品') + '</td></tr></tbody>';

    var hcTitle = hc.dup_extra > 0
      ? '各单品相加的人次口径：线下 ' + M.count(hc.row_sum) + ' 人次已按「同单标记」合并为 ' +
        M.count(hc.dedup) + ' 位顾客，合并掉 ' + M.count(hc.dup_extra) + ' 人次'
      : '各单品相加的人次口径；同一顾客买多个不同商品会各算 1 次';
    var foot = '<tfoot><tr><td class="ta-l"><span class="spu-name">合计</span>' +
      '<span class="spu-cat">' + filtered.length + ' 个单品</span></td>' +
      SPU_COLS.slice(1).map(function (c) {
        // 坑：列 key 已从 customers 改为 headcount（全渠道），条件是旧 key 就永远不生效
        var t = c.key === 'headcount' ? ' title="' + esc(hcTitle) + '"' : '';
        return '<td' + t + '>' + esc(fmtSpuCell(tot[c.key], c.fmt)) + '</td>';
      }).join('') + '</tr></tfoot>';

    $('spuTable').innerHTML = head + body + foot;

    var sumItems = [
      ['单品数', filtered.length + ' 个'],
      ['销售额', M.money(tot.gmv)],
      ['线下销售额', M.money(tot.offline)],
      ['净销售额', M.money(tot.net)],
      ['访客', M.count(tot.visitors)],
      ['销售人数', M.count(tot.headcount)],
      ['加购率', M.pct(tot.add_rate)],
      ['客单价', M.money(tot.aov)],
      ['推广费用', M.money(tot.spend)],
      ['推广占比', M.pct(tot.ad_ratio)],
      ['ROI', M.ratio(tot.roi)],
      ['询单人数', tot.inq_persons ? M.count(tot.inq_persons) : '—'],
      ['询单成本', tot.inq_cost == null ? '—' : M.money(tot.inq_cost)]
    ];
    if (hc.row_sum > 0) {
      sumItems.splice(6, 0, ['线下销售人数',
        hc.dup_extra > 0
          ? M.count(hc.row_sum) + ' 人次 / 去重 ' + M.count(hc.dedup) + ' 人'
          : M.count(hc.dedup)]);
    }
    $('spuSummary').innerHTML = sumItems.map(function (x) {
      return '<span><span class="k">' + x[0] + '</span><b>' + esc(x[1]) + '</b></span>';
    }).join('');
    $('spuFootNote').innerHTML =
      '加购率 = 加购人数 ÷ 访客数（与商智「加购转化率」同源，合计行可复算）；' +
      '销售额 = 线上成交 + 线下登记；净销售额 = 销售额 − 退款；' +
      '客单价 = 销售额 ÷ 销售人数（销售人数 = 线上成交客户 + 线下登记客户）；' +
      '推广占比 = 推广费用 ÷ <b>销售额（全渠道）</b>；ROI = <b>销售额（全渠道）</b> ÷ 推广费用，' +
      '与 BI 页整店主口径一致。' +
      '<br><b>销售人数是『人次』不是『人头』</b>：同一顾客买了 A、B 两个货号，A 行和 B 行各记 1 人' +
      '（单品客单价必须用它），合计行相加就把这一个人数了两次。线下部分在登记表填「同单标记」后，' +
      '上方会同时给出「人次 / 去重人数」；线上数据源没有客户 ID、拆不到人，只能按人次看，' +
      '所以合计行的人数会略高于真实人头数，这是口径使然，不是算错。' +
      '<br>线下没有访客与加购概念：只在线下成交的品，访客为 0、加购率显示 —，' +
      '但销售额、净销售额、客单价、ROI 都按全渠道算。' +
      '<br>ROI 只反映推广渠道贡献：自然成交占比高的品会出现极高值（例：凉亭类花费个位数、成交上万），' +
      '不能与整店综合 ROI 横向比较。推广费用为 0 的品 ROI 显示 —。';
  }

  /* ---------------- 单品分析：选一个货号，看它自己的日趋势 ---------------- */

  /** 轴刻度：钱用 万/k 缩写，比例用百分数，ROI 用整数 */
  function axisTick(v, kind) {
    if (kind === 'pct') return (v * 100).toFixed(0) + '%';
    if (kind === 'ratio') return v >= 100 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0);
    var a = Math.abs(v);
    if (a >= 10000) return (v / 10000).toFixed(a >= 100000 ? 0 : 1) + '万';
    if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(Math.round(v));
  }

  function fmtByKind(v, kind) {
    if (v == null) return '—';
    if (kind === 'money') return M.money(v);
    if (kind === 'pct') return M.pct(v);
    if (kind === 'ratio') return M.ratio(v);
    return M.count(v);
  }

  /**
   * 轻量 SVG 图：柱（可堆叠，左轴）+ 可选左折线 + 可选右轴折线。
   * 全部手绘，不引图表库 —— 看板是本地 file:// 打开，CDN 一律加载不到。
   */
  function svgChart(days, cfg) {
    var n = days.length;
    if (!n) return '<div class="rank-empty">— 当前周期无数据</div>';
    var W = 900, H = cfg.height || 200, L = 58, R = cfg.right ? 56 : 18, T = 14, B = 26;
    var iw = (W - L - R) / n;
    var bw = Math.max(2, Math.min(22, iw * 0.62));
    var xc = function (i) { return L + iw * (i + 0.5); };
    var bars = cfg.bars || [];

    var lmax = 0, lmin = 0, rmax = 0;
    days.forEach(function (d) {
      var s = 0;
      bars.forEach(function (b) { s += (d[b.key] || 0); });
      if (s > lmax) lmax = s;
      if (cfg.line) {
        var v = d[cfg.line.key];
        if (v != null && isFinite(v)) { if (v > lmax) lmax = v; if (v < lmin) lmin = v; }
      }
      if (cfg.right) {
        var rv = d[cfg.right.key];
        if (rv != null && isFinite(rv) && rv > rmax) rmax = rv;
      }
    });
    if (lmax <= 0 && lmin >= 0) lmax = 1;
    if (rmax <= 0) rmax = 1;
    var span = (lmax - lmin) || 1;
    var plotH = H - T - B;
    var y = function (v) { return T + (lmax - v) / span * plotH; };
    var yR = function (v) { return T + (rmax - v) / rmax * plotH; };

    var grid = '';
    [lmax, (lmax + lmin) / 2, lmin].forEach(function (v) {
      grid += '<line x1="' + L + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(v).toFixed(1) +
        '" stroke="#eceff4" stroke-width="1"/>' +
        '<text x="' + (L - 8) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="#9aa4b4">' +
        esc(axisTick(v, cfg.leftFmt)) + '</text>';
    });
    if (cfg.right) {
      [rmax, 0].forEach(function (v) {
        grid += '<text x="' + (W - R + 8) + '" y="' + (yR(v) + 4).toFixed(1) + '" font-size="10" fill="#c08a3a">' +
          esc(axisTick(v, cfg.rightFmt)) + '</text>';
      });
    }
    var zero = (lmin < 0)
      ? '<line x1="' + L + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(0).toFixed(1) +
        '" stroke="#c8d0de" stroke-width="1" stroke-dasharray="4 3"/>' : '';

    var barSvg = '';
    days.forEach(function (d, i) {
      var base = 0;
      bars.forEach(function (b) {
        var v = d[b.key] || 0;
        if (v <= 0) return;
        var top = y(base + v), bot = y(base);
        barSvg += '<rect x="' + (xc(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.8, bot - top).toFixed(1) +
          '" rx="1" fill="' + b.color + '"><title>' +
          esc(d.date + ' ｜ ' + (b.label || b.key) + ' ' + fmtByKind(v, b.fmt || cfg.leftFmt)) +
          '</title></rect>';
        base += v;
      });
    });

    function lineSvg(def, yFn, axisName) {
      var pen = false, path = '', dots = '';
      days.forEach(function (d, i) {
        var v = d[def.key];
        if (v == null || !isFinite(v)) { pen = false; return; }
        var px = xc(i).toFixed(1), py = yFn(v).toFixed(1);
        path += (pen ? 'L' : 'M') + px + ',' + py + ' ';
        pen = true;
        dots += '<circle cx="' + px + '" cy="' + py + '" r="2.6" fill="#fff" stroke="' + def.color +
          '" stroke-width="1.8"><title>' + esc(d.date + ' ｜ ' + (def.label || def.key) + ' ' +
          fmtByKind(v, def.fmt)) + (axisName ? '（' + axisName + '）' : '') + '</title></circle>';
      });
      return '<path d="' + path + '" fill="none" stroke="' + def.color +
        '" stroke-width="2" stroke-linejoin="round"/>' + dots;
    }

    var step = Math.max(1, Math.ceil(n / 8));
    var labels = days.map(function (d, i) {
      if (i % step && i !== n - 1) return '';
      return '<text x="' + xc(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#9aa4b4">' +
        esc(d.date.slice(5)) + '</text>';
    }).join('');

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:' + H + 'px">' +
      grid + zero + barSvg +
      (cfg.line ? lineSvg(cfg.line, y, '') : '') +
      (cfg.right ? lineSvg(cfg.right, yR, '右轴') : '') + labels + '</svg>';
  }

  /** 某货号在指定区间内的逐日序列；区间内没有数据的日子补 0，保证 x 轴连续 */
  function spuDaySeries(spu, range) {
    var S = DATA.spu_daily;
    if (!S || !S.rows || !S.rows[spu]) return [];
    var ix = {};
    S.fields.forEach(function (k, i) { ix[k] = i; });
    var row = S.rows[spu];
    return M.rowsBetween(DATA.daily, range).map(function (r) {
      var v = row[r.date] || [];
      var online = v[ix.gmv] || 0, offline = v[ix.offline_gmv] || 0;
      var visitors = v[ix.visitors] || 0;
      var customers = v[ix.customers] || 0, offline_customers = v[ix.offline_customers] || 0;
      var add_customers = v[ix.add_customers] || 0;
      var spend = v[ix.spend] || 0, refund = v[ix.refund] || 0;
      var gmv = online + offline;
      var headcount = customers + offline_customers;
      return {
        date: r.date, online: online, offline: offline, gmv: gmv,
        refund: refund, net: gmv - refund,
        visitors: visitors, customers: customers, offline_customers: offline_customers,
        headcount: headcount,
        add_customers: add_customers, add_pieces: v[ix.add_pieces] || 0,
        spend: spend, orders: v[ix.orders] || 0,
        add_rate: visitors > 0 ? add_customers / visitors : null,
        aov: headcount > 0 ? gmv / headcount : null,
        ad_ratio: gmv > 0 ? spend / gmv : null,
        roi: spend > 0 ? gmv / spend : null
      };
    });
  }

  function sumSpuDays(days) {
    var t = { gmv: 0, online: 0, offline: 0, refund: 0, net: 0, visitors: 0, customers: 0,
              offline_customers: 0, headcount: 0, add_customers: 0, add_pieces: 0, spend: 0, orders: 0 };
    days.forEach(function (d) {
      ['gmv', 'online', 'offline', 'refund', 'net', 'visitors', 'customers', 'offline_customers',
       'headcount', 'add_customers', 'add_pieces', 'spend', 'orders'].forEach(function (k) {
        t[k] += d[k] || 0;
      });
    });
    t.add_rate = t.visitors > 0 ? t.add_customers / t.visitors : null;
    t.aov = t.headcount > 0 ? t.gmv / t.headcount : null;
    t.ad_ratio = t.gmv > 0 ? t.spend / t.gmv : null;
    t.roi = t.spend > 0 ? t.gmv / t.spend : null;
    return t;
  }

  /** 候选货号：本周期按销售额降序；搜索框在货号 / SPU / 类目上过滤 */
  function detailOptions() {
    var ranked = spuRowsInRange(currentRange()).sort(function (a, b) { return (b.gmv || 0) - (a.gmv || 0); });
    var q = (state.detailQuery || '').trim().toLowerCase();
    var opts = q ? ranked.filter(function (r) {
      return (r.label + ' ' + r.spu_id + ' ' + r.cat).toLowerCase().indexOf(q) >= 0;
    }) : ranked;
    return { ranked: ranked, opts: opts };
  }

  var DETAIL_KPIS = [
    { key: 'gmv',        name: '销售额',   fmt: 'money', hint: '线上成交 + 线下登记' },
    { key: 'visitors',   name: '访客数',   fmt: 'count', hint: '按日累加的人次口径，不做区间去重' },
    { key: 'add_rate',   name: '加购率',   fmt: 'pct',   hint: '加购人数 ÷ 访客数，仅线上' },
    { key: 'headcount',  name: '销售人数', fmt: 'count', hint: '线上成交客户 + 线下登记客户' },
    { key: 'aov',        name: '客单价',   fmt: 'money', hint: '销售额 ÷ 销售人数' },
    { key: 'inq_cost',   name: '询单成本', fmt: 'money', hint: '推广花费 ÷ 询单人数（本周期 {inq} 人，按顾客×SPU 去重）' },
    { key: 'spend',      name: '推广费用', fmt: 'money', hint: 'SKU→SPU 归集，未匹配的投放不摊派' },
    { key: 'ad_ratio',   name: '推广占比', fmt: 'pct',   hint: '推广费用 ÷ 销售额（全渠道）' },
    { key: 'roi',        name: 'ROI',      fmt: 'ratio', hint: '销售额（全渠道）÷ 推广费用，不与整店横比' }
    // 2026-11-20 用户指定排列（行优先）：
    //   销售额 访客数 加购率 / 销售人数 客单价 询单成本 / 推广费用 推广占比 ROI
    // 净销售额不占 KPI 位，放在下方标签行（见 detailProfile 末尾的 pill）
  ];

  function detailKpiHtml(tot, prev, kpis) {
    return (kpis || DETAIL_KPIS).map(function (d) {
      var cur = tot[d.key], pv = prev ? prev[d.key] : null;
      var delta = (prev && cur != null && pv != null) ? M.deltaOf(cur, pv) : null;
      var right = delta === null
        ? '<span class="flat">— 对比上一周期</span>'
        : '<span class="' + M.toneOf(cur, pv) + '">' + (delta > 0 ? '+' : '') +
          (delta * 100).toFixed(2) + '%</span> <span class="flat">对比上一周期</span>';
      // 询单成本的分母（询单人数）写进 hint，避免只有成本看不到构成
      var hint = String(d.hint || '').replace('{inq}',
        tot.inq_persons != null ? M.count(tot.inq_persons) : '—');
      return '<div class="kpi' + (d.wide ? ' kpi-wide' : '') + '"><div class="name">' + esc(d.name) + '</div>' +
        '<div class="value">' + esc(fmtByKind(cur, d.fmt)) + '</div>' +
        '<div class="delta">' + right + '</div>' +
        '<div class="hint">' + esc(hint) + '</div></div>';
    }).join('');
  }

  function pill(k, v, note) {
    return '<span class="pill"><span class="pk">' + esc(k) + '</span><span class="pv">' + esc(v) + '</span>' +
      (note ? '<span class="pn">' + esc(note) + '</span>' : '') + '</span>';
  }

  var DETAIL_COLS = [
    { label: '日期', get: function (r) { return r.date; }, raw: true },
    { label: '线上', get: function (r) { return r.online; }, digits: 2 },
    { label: '线下', get: function (r) { return r.offline; }, digits: 2 },
    { label: '退款', get: function (r) { return r.refund; }, digits: 2 },
    { label: '净额', get: function (r) { return r.net; }, digits: 2 },
    { label: '访客', get: function (r) { return r.visitors; } },
    { label: '客户数', get: function (r) { return r.headcount; } },
    { label: '加购人数', get: function (r) { return r.add_customers; } },
    { label: '加购率', get: function (r) { return r.add_rate; }, fmt: function (v) { return M.pct(v); } },
    { label: '客单价', get: function (r) { return r.aov; }, fmt: function (v) { return M.money(v); } },
    { label: '推广费用', get: function (r) { return r.spend; }, digits: 2 },
    { label: '推广占比', get: function (r) { return r.ad_ratio; }, fmt: function (v) { return M.pct(v); } },
    { label: 'ROI', get: function (r) { return r.roi; }, fmt: function (v) { return M.ratio(v); } }
  ];

  /** 找与所选周期重叠最多的词级报表区间。
   *  词级报表是「区间汇总」，不能切子区间，所以只能整段展示，并如实标注区间是否与所选周期一致。 */
  function kwPeriodFor(range) {
    var KI = DATA.keyword_insight;
    if (!KI || !KI.periods || !KI.periods.length) return null;
    if (state.mode === 'yoy') return null;   // 同比没有词级数据：京东只给整店区间汇总
    var rs = new Date(range.start + 'T00:00:00Z').getTime();
    var re = new Date(range.end + 'T00:00:00Z').getTime();
    var best = null, bestOv = 0;
    KI.periods.forEach(function (p) {
      var ps = new Date(p.start + 'T00:00:00Z').getTime();
      var pe = new Date(p.end + 'T00:00:00Z').getTime();
      var ov = Math.min(pe, re) - Math.max(ps, rs);
      if (ov > 0 && ov > bestOv) { bestOv = ov; best = p; }
    });
    if (!best) return null;
    return {
      period: best,
      same: best.start === range.start && best.end === range.end,
      partial: !(best.start <= range.start && best.end >= range.end)
    };
  }

  var KW_COLS = [
    { label: '关键词', get: function (r) { return r.keyword; }, raw: true },
    { label: '花费', get: function (r) { return r.spend; }, fmt: function (v) { return M.money(v); } },
    { label: '占词级', get: function (r) { return r.share; }, fmt: function (v) { return M.pct(v); } },
    { label: '点击', get: function (r) { return r.clicks; } },
    { label: '展现', get: function (r) { return r.impressions; } },
    // 2026-11-09 用户要求补的两个推广口径指标
    { label: '点击率', get: function (r) { return r.ctr; }, fmt: function (v) { return M.pct(v); } },
    { label: '加购', get: function (r) { return r.add_cart; } },
    { label: '加购率', get: function (r) { return r.cart_rate; }, fmt: function (v) { return M.pct(v); } },
    { label: '订单', get: function (r) { return r.orders; } },
    { label: '成交额', get: function (r) { return r.amount; }, fmt: function (v) { return M.money(v); } },
    { label: 'ROI', get: function (r) { return r.roi; }, fmt: function (v) { return M.ratio(v); } }
  ];

  /** 单品分析 · 关键词花费：该货号在词级报表里投了哪些词、各花了多少。
   *  数据只在区间级，不能画日趋势；未归属到货号的词级花费不摊派。 */
  function renderDetailKw(keep, range, tot) {
    var hit = kwPeriodFor(range);
    var sum = $('detailKwSummary');
    if (!hit) {
      var KI = DATA.keyword_insight;
      $('detailKwNote').textContent = '无覆盖';
      sum.innerHTML = '';
      $('detailKwTable').innerHTML = '';
      $('detailKwFootNote').innerHTML = (state.mode === 'yoy'
        ? '同比模式没有关键词数据：京东只提供整店的去年区间汇总，没有去年逐词明细，不做推演。请切回「当月 / 上月 / 近 7 天」。'
        : '当前周期没有可用的关键词报表。' +
          (KI && KI.periods && KI.periods.length
            ? '现有词级区间：' + KI.periods.map(function (p) { return esc(p.start) + ' ~ ' + esc(p.end); }).join('、') + '。'
            : '（尚未导入「词级报表」目录的文件。）') +
          '词级报表是区间汇总、且按需导出，不是每日都覆盖；切到「上月」或「当月」通常有数据。');
      return;
    }
    var P = hit.period;
    var SK = P.spu_keyword;
    $('detailKwNote').textContent = hit.same
      ? P.start + ' ~ ' + P.end + '（与本周期一致）'
      : P.start + ' ~ ' + P.end + '（整段汇总，与本周期不同）';

    var row = null;
    (SK.rows || []).some(function (r) { if (r[0] === keep) { row = r; return true; } return false; });
    if (!row) {
      sum.innerHTML = '';
      $('detailKwTable').innerHTML = '';
      var msg = '词级报表 ' + esc(P.start) + ' ~ ' + esc(P.end) + ' 里没有能确定归属到该货号的关键词记录。';
      if (tot.spend > 0) {
        msg += '该货号本周期在每日推广里花了 <b>' + M.money(tot.spend) + '</b>，' +
          '说明花费在其它场景（智能投放 / 全店商品推广 / 商品成交），或它的推广单元名与货号名对不上——' +
          '后者的花费不会被摊派到任何单品。';
      } else {
        msg += '该货号本周期也没有推广花费，属未投放，正常。';
      }
      if (SK.unassigned && SK.unassigned.spend > 0) {
        msg += '<br>全店同一区间内还有 <b>' + M.money(SK.unassigned.spend) +
          '</b> 的关键词花费未能归属到货号。';
      }
      $('detailKwFootNote').innerHTML = msg;
      return;
    }
    var ix = {};
    SK.fields.forEach(function (k, i) { ix[k] = i; });
    var kix = {};
    SK.kw_fields.forEach(function (k, i) { kix[k] = i; });
    var kw = row[ix.spend];
    var items = (row[ix.kws] || []).map(function (k) {
      return {
        keyword: k[kix.keyword], spend: k[kix.spend], clicks: k[kix.clicks],
        impressions: k[kix.impressions], add_cart: k[kix.add_cart],
        orders: k[kix.orders], amount: k[kix.order_amount],
        ctr: k[kix.impressions] > 0 ? k[kix.clicks] / k[kix.impressions] : null,
        cart_rate: k[kix.clicks] > 0 ? k[kix.add_cart] / k[kix.clicks] : null,
        share: kw > 0 ? k[kix.spend] / kw : null,
        roi: k[kix.spend] > 0 ? k[kix.order_amount] / k[kix.spend] : null
      };
    });
    var rest = row[ix.rest];
    var totClick = row[ix.clicks], totImp = row[ix.impressions];
    var totCart = row[ix.add_cart], totOrd = row[ix.orders], totAmt = row[ix.order_amount];
    var kwRoi = kw > 0 ? totAmt / kw : null;

    sum.innerHTML = [
      ['词级花费', M.money(kw)],
      ['关键词数', (items.length + (rest ? rest[0] : 0)) + ' 个'],
      ['点击', M.count(totClick)],
      ['成交额', M.money(totAmt)],
      ['ROI', M.ratio(kwRoi)],
      ['占该品推广费用', tot.spend > 0 ? M.pct(kw / tot.spend) : '—']
    ].map(function (x) {
      return '<span><span class="k">' + x[0] + '</span><b>' + esc(x[1]) + '</b></span>';
    }).join('');

    var body = items.map(function (r) { return r; });
    if (rest) {
      body.push({
        keyword: '其他 ' + rest[0] + ' 个词（合计）', spend: rest[1], clicks: rest[2],
        impressions: null, ctr: null, add_cart: null, cart_rate: null,
        orders: null, amount: rest[3],
        share: kw > 0 ? rest[1] / kw : null, roi: rest[1] > 0 ? rest[3] / rest[1] : null,
        isRest: true
      });
    }
    var totCtr = totImp > 0 ? totClick / totImp : null;
    var totCartRate = totClick > 0 ? totCart / totClick : null;
    var html = tableHtml(KW_COLS, body, function (c, raw, r) { return r.isRest ? 'kw-rest' : ''; });
    html += '<tfoot><tr><td class="ta-l">合计（' + (items.length + (rest ? rest[0] : 0)) + ' 个词）</td>' +
      '<td>' + esc(M.money(kw)) + '</td><td>' + esc(M.pct(1)) + '</td>' +
      '<td>' + esc(M.count(totClick)) + '</td><td>' + esc(M.count(totImp)) + '</td>' +
      '<td>' + esc(M.pct(totCtr)) + '</td>' +
      '<td>' + esc(M.count(totCart)) + '</td><td>' + esc(M.pct(totCartRate)) + '</td>' +
      '<td>' + esc(M.count(totOrd)) + '</td>' +
      '<td>' + esc(M.money(totAmt)) + '</td><td>' + esc(M.ratio(kwRoi)) + '</td></tr></tfoot>';
    $('detailKwTable').innerHTML = html;

    var foot = '口径：数据来自京准通「搜索词效果报表」，<b>导出的是区间汇总</b>（日期列形如 ' +
      esc(P.raw_period) + '），没有分日粒度，所以只能看整段、画不了日趋势。' +
      '关键词行的「智能投放推广SKU ID」恒为 -1，货号只能靠推广单元名反查，' +
      '因此该货号的关键词花费 ≤「商品明细」页的推广费用（后者含智能投放、全店商品推广等全部场景）。' +
      '<br><b>点击率 = 点击 ÷ 展现；加购率 = 总加购数 ÷ 点击</b>（推广口径）。' +
      '京东「总加购数」是<b>加购商品件数</b>而非人数，与单品分析顶部 KPI 的「加购率」' +
      '（销售明细：加购人数 ÷ 访客数）<b>不同源、不可横比</b>；' +
      '「其他 N 个词」汇总行没有展现与加购明细，分母为 0 时均显示 —。';
    if (!hit.same) {
      foot += '<br><b>注意区间不同</b>：本页选的是 ' + esc(range.start) + ' ~ ' + esc(range.end) +
        '，词级报表覆盖的是 ' + esc(P.start) + ' ~ ' + esc(P.end) +
        '，两者不可直接相减对比，看趋势请切到与词级区间一致的周期（如「上月」）。';
    }
    if (SK.unassigned && SK.unassigned.spend > 0) {
      foot += '<br>全店同区间有 <b>' + M.money(SK.unassigned.spend) + '</b> 的关键词花费未能归属到货号' +
        '（推广单元名与货号名对不上，或对上多个同名货号），这部分<b>不摊派</b>给任何单品。';
    }
    $('detailKwFootNote').innerHTML = foot;
  }

  /* ---------------- 单品分析 · 推广花费分布 ----------------
   * 分组口径 2026-11-09 由用户确认，必须与 engine/build_dataset.py 的 SCENE_GROUPS 一致。
   * 数据来自 spu_scene_daily（SPU × 日 × 场景组），按当前周期逐日聚合。
   */
  var SCENE_META = [
    { name: '关键词快车', color: '#4f6bed', scenes: ['常规推广-关键词'] },
    { name: '人群',       color: '#8b72e8', scenes: ['常规推广-商品成交'] },
    { name: '全店推广',   color: '#f0a13c', scenes: ['全店商品推广', '常规推广-全站智能推广'] },
    { name: '其他',       color: '#9aa4b4', scenes: ['腰带店铺'] }
  ];

  var SCENE_COLS = [
    { label: '场景组', get: function (r) { return r.name; }, raw: true },
    { label: '包含原始营销场景', get: function (r) { return r.scenes; }, raw: true, cls: 'scene-scenes' },
    { label: '花费', get: function (r) { return r.spend; }, fmt: function (v) { return M.money(v); } },
    { label: '占比', get: function (r) { return r.share; }, fmt: function (v) { return M.pct(v); } }
  ];

  function renderDetailScene(keep, range, tot) {
    var S = DATA.spu_scene_daily;
    var sum = $('detailSceneSummary'), bars = $('detailSceneBars'),
        legend = $('detailSceneLegend'), tbl = $('detailSceneTable'),
        foot = $('detailSceneFootNote'), note = $('detailSceneNote');

    if (!S || !S.rows || !S.fields) {
      note.textContent = '—';
      sum.innerHTML = ''; bars.innerHTML = ''; legend.innerHTML = ''; tbl.innerHTML = '';
      foot.innerHTML = '推广花费分布尚未生成：请用桌面「每日更新」重建一次数据。';
      return;
    }
    var dates = {};
    M.rowsBetween(DATA.daily, range).forEach(function (r) { dates[r.date] = 1; });
    var dayCount = Object.keys(dates).length;
    var fi = {};
    S.fields.forEach(function (k, i) { fi[k] = i; });
    var agg = {}, covered = {};
    var days = S.rows[keep] || {};
    Object.keys(days).forEach(function (d) {
      if (!dates[d]) return;                       // 只取所选周期，绝不把区间外的钱算进来
      var groups = days[d];
      Object.keys(groups).forEach(function (g) {
        var v = groups[g][fi.spend] || 0;
        agg[g] = (agg[g] || 0) + v;
        if (v > 0) covered[d] = 1;
      });
    });
    var total = 0;
    Object.keys(agg).forEach(function (g) { total += agg[g]; });

    var body = SCENE_META.map(function (m) {
      var spend = agg[m.name] || 0;
      return { name: m.name, color: m.color, scenes: m.scenes.join(' + '),
               spend: spend, share: total > 0 ? spend / total : null };
    });
    // 兜底：出现分组表里没有的场景也要显示，绝不静默丢钱
    Object.keys(agg).forEach(function (g) {
      if (SCENE_META.some(function (m) { return m.name === g; })) return;
      body.push({ name: g, color: '#9aa4b4', scenes: '未预期场景（已按「其他」口径保留）',
                  spend: agg[g], share: total > 0 ? agg[g] / total : null });
    });

    note.textContent = range.start + ' ~ ' + range.end + '（' + dayCount + ' 天）';
    sum.innerHTML = [
      ['周期推广花费', M.money(total)],
      ['有投放天数', Object.keys(covered).length + ' / ' + dayCount + ' 天'],
      ['有花费场景组', body.filter(function (x) { return x.spend > 0; }).length + ' 组']
    ].map(function (x) {
      return '<span><span class="k">' + x[0] + '</span><b>' + esc(x[1]) + '</b></span>';
    }).join('');

    bars.innerHTML = total > 0
      ? body.filter(function (x) { return x.spend > 0; }).map(function (x) {
          return '<span style="width:' + (x.spend / total * 100).toFixed(2) + '%;background:' +
            x.color + '" title="' + esc(x.name + ' ' + M.money(x.spend) + ' · ' + M.pct(x.share)) +
            '"></span>';
        }).join('')
      : '';
    legend.innerHTML = total > 0
      ? body.map(function (x) {
          return '<span><i style="background:' + x.color + '"></i>' + esc(x.name) +
            ' <b>' + esc(M.pct(x.share)) + '</b></span>';
        }).join('')
      : '';

    var html = tableHtml(SCENE_COLS, body, function (c, raw, r) {
      return r.spend <= 0 ? 'dim' : '';
    });
    html += '<tfoot><tr><td class="ta-l">合计</td><td class="scene-scenes">与「推广费用」KPI 同源</td>' +
      '<td>' + esc(M.money(total)) + '</td><td>' + esc(total > 0 ? M.pct(1) : M.pct(null)) + '</td></tr></tfoot>';
    tbl.innerHTML = html;

    var gap = Math.abs(total - (tot.spend || 0));
    foot.innerHTML =
      '口径：数据来自每日推广 CSV 的「营销场景」列，按跟单 SKU ID 反查 SPU 后逐日归集；' +
      '占比 = 该组花费 ÷ 本单品本周期推广花费合计。<b>「关键词快车 / 人群 / 全店推广」是业务叫法</b>，' +
      '对应的京准通原始场景名已逐行列出。<br>' +
      '分组：关键词快车＝常规推广-关键词；人群＝常规推广-商品成交；' +
      '全店推广＝全店商品推广 + 常规推广-全站智能推广；其他＝腰带店铺。' +
      '日后出现的新场景也归「其他」，不会静默丢弃。<br>' +
      '未匹配到 SPU 的投放<b>不摊派</b>给任何单品（仍计入整店），所以整店推广花费会大于所有单品之和。' +
      '下方「关键词花费」来自搜索词效果报表（区间汇总、按推广单元名反查货号），与本表<b>口径不同，不可直接相减</b>。' +
      (gap > 0.05
        ? '<br><b>注意</b>：本表合计 ' + M.money(total) + ' 与「推广费用」KPI ' +
          M.money(tot.spend) + ' 相差 ' + M.money(gap) + '，请核对数据。'
        : '') +
      (total <= 0
        ? '<br><b>本周期该单品没有推广花费</b>（未投放，或投放的 SKU 未匹配到 SPU），分布为 0 属口径正常，不是数据缺失。'
        : '');
  }

  /* ==================== SKU 明细（2026-11-26）====================
     数据源 data/sku-detail/<SPU>.json，由 engine/build_sku.py 按 SPU 拆分生成。
     只在单品分析选中商品后按需加载，中位数 5KB/SPU，不进主 dataset.js。
     口径：销售 4 项来自 SKU 维度商品明细；花费来自推广 CSV 跟单SKU ID；
     询单人数按 (日期,顾客,SKU) 去重。加购率 = 加购人数 ÷ 访客（人次口径，不是区间去重）。 */
  var skuCache = {};      // spu → {rows:{sku:{date:[...]}}}
  var skuReqToken = 0;    // 切商品/周期时作废旧请求，避免乱序覆盖

  function renderSkuDetail(keep, range) {
    var note = $('skuNote'), table = $('skuTable'), foot = $('skuFootNote');
    if (!note || !table) return;
    if (!keep) {
      note.textContent = '—'; table.innerHTML = ''; foot.textContent = ''; return;
    }
    var token = ++skuReqToken;
    note.textContent = '加载中…';

    function paint(data) {
      if (token !== skuReqToken) return;   // 已被新请求取代
      var fields = data.meta && data.meta.fields
        ? data.meta.fields : ['visitors', 'gmv', 'customers', 'add_customers', 'spend', 'inquiry'];
      var ix = {}; fields.forEach(function (f, i) { ix[f] = i; });
      var out = [];
      Object.keys(data.rows || {}).forEach(function (sku) {
        var days = data.rows[sku], a = { sku: sku, visitors: 0, gmv: 0, customers: 0,
          add_customers: 0, spend: 0, inquiry: 0, days: 0 };
        Object.keys(days).forEach(function (d) {
          if (d < range.start || d > range.end) return;
          var v = days[d];
          a.visitors += v[ix.visitors] || 0;
          a.gmv += v[ix.gmv] || 0;
          a.customers += v[ix.customers] || 0;
          a.add_customers += v[ix.add_customers] || 0;
          a.spend += v[ix.spend] || 0;
          a.inquiry += v[ix.inquiry] || 0;
          a.days++;
        });
        if (!a.days) return;
        a.cart_rate = a.visitors > 0 ? a.add_customers / a.visitors : null;
        a.roi = a.spend > 0 ? a.gmv / a.spend : null;
        out.push(a);
      });
      out.sort(function (x, y) { return y.gmv - x.gmv; });
      note.textContent = range.start + ' ~ ' + range.end + ' · ' + out.length + ' 个 SKU';
      var specs = data.specs || {};
      var cols = [
        { label: 'SKU 规格', get: function (r) {
            var sp = specs[r.sku];
            return sp
              ? '<span title="SKU ' + esc(r.sku) + '">' + esc(sp) + '</span>'
              : '<span class="dim" title="无规格登记 · SKU ' + esc(r.sku) + '">' + esc(r.sku) + '</span>';
          }, raw: true, cls: 'ta-l' },
        { label: '访客数', get: function (r) { return r.visitors; }, fmt: M.count },
        { label: '销售金额', get: function (r) { return r.gmv; }, fmt: M.money },
        { label: '销售人数', get: function (r) { return r.customers; }, fmt: M.count },
        { label: '加购人数', get: function (r) { return r.add_customers; }, fmt: M.count },
        { label: '加购率', get: function (r) { return r.cart_rate; }, fmt: M.pct },
        { label: '推广费用', get: function (r) { return r.spend; }, fmt: M.money },
        { label: '询单人数', get: function (r) { return r.inquiry; }, fmt: M.count }
      ];
      table.innerHTML = out.length ? tableHtml(cols, out) :
        '<tbody><tr><td colspan="8" class="ta-l dim">该周期没有 SKU 级数据</td></tr></tbody>';
      var tot = out.reduce(function (s, r) {
        ['visitors', 'gmv', 'customers', 'add_customers', 'spend', 'inquiry'].forEach(function (k) { s[k] += r[k]; });
        return s;
      }, { visitors: 0, gmv: 0, customers: 0, add_customers: 0, spend: 0, inquiry: 0 });
      foot.innerHTML = '合计：访客 ' + esc(M.count(tot.visitors)) + ' · 销售金额 ' + esc(M.money(tot.gmv)) +
        ' · 销售人数 ' + esc(M.count(tot.customers)) + ' · 加购人数 ' + esc(M.count(tot.add_customers)) +
        ' · 推广费用 ' + esc(M.money(tot.spend)) + ' · 询单人数 ' + esc(M.count(tot.inquiry)) +
        '<br>第一列显示「SKU 规格」（来自全店sku表格.xlsx 的 SKU规格列），鼠标悬停看 SKU 编码；未登记规格的显示编码。' +
        '<br>销售/访客/加购来自「SKU 维度商品销售明细」（按日累加，同一顾客多日会重复计）；' +
        '推广费用按跟单 SKU ID 归集；询单人数按 (日期,顾客,SKU) 去重，不与其它列做严格漏斗。' +
        '合计可能与该单品 SPU 级数字略有差异：未匹配 SKU→SPU 字典的行不进本表。';
    }

    function fail(e) {
      if (token !== skuReqToken) return;
      note.textContent = '加载失败';
      table.innerHTML = '<tbody><tr><td colspan="8" class="ta-l dim">SKU 明细加载失败：' +
        esc(e && e.message ? e.message : e) +
        '。桌面快捷方式用 file:// 打开时若失败，请用 http://127.0.0.1:8899/index.html 访问。</td></tr></tbody>';
      foot.textContent = '';
    }
    if (skuCache[keep]) { paint(skuCache[keep]); return; }

    var base = 'data/sku-detail/' + encodeURIComponent(keep);
    if (location.protocol === 'file:') {
      // 桌面快捷方式是 file://，浏览器禁止 fetch 本地 JSON；用动态 <script src> 加载 JS 包装版
      // （build_sku.py 同时生成 <SPU>.js，与主 dataset.js 同机制）。
      var s = document.createElement('script');
      s.src = base + '.js';
      s.onload = function () {
        var w = window.__SKU_DETAIL__ || {};
        if (w[keep]) { skuCache[keep] = w[keep]; paint(w[keep]); }
        else fail(new Error('数据文件已加载但内容为空'));
      };
      s.onerror = function () { fail(new Error('找不到 ' + keep + '.js（请重新运行 build_sku.py）')); };
      document.head.appendChild(s);
    } else {
      fetch(base + '.json')
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (data) { skuCache[keep] = data; paint(data); })
        .catch(fail);
    }
  }

  function renderDetail() {
    var range = currentRange();
    var pick = $('detailPick');
    var o = detailOptions();
    var keep = state.detailSpu;
    var fellBack = false;
    if (!o.opts.some(function (r) { return r.spu_id === keep; })) {
      fellBack = !!keep;
      keep = o.opts.length ? o.opts[0].spu_id : null;
    }
    state.detailSpu = keep;

    pick.innerHTML = o.opts.length
      ? o.opts.map(function (r) {
          return '<option value="' + esc(r.spu_id) + '"' + (r.spu_id === keep ? ' selected' : '') + '>' +
            esc(r.label) + '　' + M.money(r.gmv) + (r.cat ? '　' + esc(r.cat) : '') + '</option>';
        }).join('')
      : '<option value="">— 该周期没有单品</option>';

    var idx = -1;
    o.opts.forEach(function (r, i) { if (r.spu_id === keep) idx = i; });
    $('detailPrev').disabled = idx <= 0;
    $('detailNext').disabled = idx < 0 || idx >= o.opts.length - 1;

    if (!keep) {
      var empty = '<div class="rank-empty">' +
        (state.mode === 'yoy' ? '同比模式没有单品日数据：京东只提供整店区间汇总。请切回「当月 / 上月 / 近 7 天」。'
                              : '该周期没有可分析的单品。') + '</div>';
      $('detailKpis').innerHTML = '';
      $('detailProfile').innerHTML = '';
      $('detailChartGmv').innerHTML = empty;
      $('detailChartVisit').innerHTML = empty;
      $('detailChartAd').innerHTML = empty;
      $('detailTable').innerHTML = '';
      $('detailRowsNote').textContent = '—';
      $('detailFootNote').textContent = '';
      $('detailRank').textContent = '—';
      $('detailNotice').textContent = '没有选中任何单品。';
      $('detailKwNote').textContent = '—';
      $('detailKwSummary').innerHTML = '';
      $('detailKwTable').innerHTML = '';
      $('detailKwFootNote').textContent = '';
      $('detailSceneNote').textContent = '—';
      $('detailSceneSummary').innerHTML = '';
      $('detailSceneBars').innerHTML = '';
      $('detailSceneLegend').innerHTML = '';
      $('detailSceneTable').innerHTML = '';
      $('detailSceneFootNote').textContent = '';
      return;
    }

    var sel = o.ranked.filter(function (r) { return r.spu_id === keep; })[0] || {};
    var days = spuDaySeries(keep, range);
    var tot = sumSpuDays(days);
    var prevRange = state.mode === 'prev_period' ? prevOfBase() : cmpPrevRange(range);
    var prevDays = spuDaySeries(keep, prevRange);
    var prev = (state.compare && prevDays.some(function (d) {
      return d.gmv > 0 || d.visitors > 0 || d.spend > 0;
    })) ? sumSpuDays(prevDays) : null;

    // 询单：单品层按 (顾客, SPU) 去重；询单成本 = 该单品花费 ÷ 该单品询单人数
    // 分子只用「询单数据覆盖期」内的花费，与分母同期
    var IQd = inquiryRange(range.start, range.end);
    var inqEndD = IQd.coveredEnd || range.end;
    tot.spend_inq = days.reduce(function (s, x) {
      return s + (x.date <= inqEndD ? (x.spend || 0) : 0);
    }, 0);
    tot.inq_persons = IQd.bySpu[keep] || 0;
    tot.inq_cost = (tot.inq_persons > 0 && tot.spend_inq > 0) ? tot.spend_inq / tot.inq_persons : null;
    if (prev) {
      var pIQd = inquiryRange(prevRange.start, prevRange.end);
      var pEndD = pIQd.coveredEnd || prevRange.end;
      prev.spend_inq = prevDays.reduce(function (s, x) {
        return s + (x.date <= pEndD ? (x.spend || 0) : 0);
      }, 0);
      prev.inq_persons = pIQd.bySpu[keep] || 0;
      prev.inq_cost = (prev.inq_persons > 0 && prev.spend_inq > 0) ? prev.spend_inq / prev.inq_persons : null;
    }

    // 排名：全店销售额排名 + 类目内排名
    var rankAll = o.ranked.indexOf(sel) + 1;
    var sameCat = o.ranked.filter(function (r) { return r.cat && r.cat === sel.cat; });
    var catRank = sameCat.map(function (r) { return r.spu_id; }).indexOf(keep) + 1;
    var storeGmv = o.ranked.reduce(function (s, r) { return s + (r.gmv || 0); }, 0);
    var storeHead = o.ranked.reduce(function (s, r) { return s + (r.headcount || 0); }, 0);
    var storeAov = storeHead > 0 ? storeGmv / storeHead : null;

    $('detailRank').textContent = '第 ' + rankAll + ' / ' + o.ranked.length + ' 名' +
      (o.opts.length < o.ranked.length ? '（筛出 ' + o.opts.length + ' 个）' : '');

    $('detailProfile').innerHTML = [
      pill('类目', sel.cat || '未归类'),
      pill('销售额排名', '第 ' + rankAll + ' 名', '共 ' + o.ranked.length + ' 个'),
      pill('类目内排名', sel.cat ? '第 ' + catRank + ' 名' : '—', sel.cat ? '共 ' + sameCat.length + ' 个' : ''),
      pill('占店铺销售额', storeGmv > 0 ? M.pct(tot.gmv / storeGmv) : '—', '本周期'),
      pill('退款率', tot.gmv > 0 ? M.pct(tot.refund / tot.gmv) : '—', '退款 ÷ 销售额'),
      pill('线下占比', tot.gmv > 0 ? M.pct(tot.offline / tot.gmv) : '—', M.money(tot.offline)),
      pill('日均销售额', M.money(tot.gmv / Math.max(days.length, 1)), days.length + ' 天'),
      pill('客单价 / 店铺', (tot.aov != null && storeAov) ? M.ratio(tot.aov / storeAov) + '×' : '—',
        '店铺 ' + M.money(storeAov)),
      // 2026-11-20 用户要求：净销售额从 KPI 卡移到这一排标签，紧跟「客单价 / 店铺」
      pill('净销售额', M.money(tot.net),
        tot.refund > 0 ? '销售额 − 退款 ' + M.money(tot.refund) : '销售额 − 退款')
    ].join('');

    $('detailKpis').innerHTML = detailKpiHtml(tot, prev);

    $('detailChartGmv').innerHTML = svgChart(days, {
      height: 230,
      bars: [{ key: 'online', label: '线上', color: '#4f6bed' },
             { key: 'offline', label: '线下', color: '#8b72e8' }],
      line: { key: 'net', label: '净销售额', color: '#f0a13c', fmt: 'money' },
      leftFmt: 'money'
    });
    $('detailChartVisit').innerHTML = svgChart(days, {
      height: 190,
      bars: [{ key: 'visitors', label: '访客', color: '#c9d3f0' }],
      right: { key: 'add_rate', label: '加购率', color: '#22a06b', fmt: 'pct' },
      leftFmt: 'count', rightFmt: 'pct'
    });
    $('detailChartAd').innerHTML = tot.spend > 0
      ? svgChart(days, {
          height: 190,
          bars: [{ key: 'spend', label: '推广费用', color: '#f6c26b' }],
          right: { key: 'roi', label: 'ROI', color: '#d9534f', fmt: 'ratio' },
          leftFmt: 'money', rightFmt: 'ratio'
        })
      : '<div class="rank-empty">该周期这个货号没有推广花费（未投放，或投放的 SKU 未匹配到 SPU）。' +
        'ROI 无从计算，属口径正常，不是数据缺失。</div>';

    var rows = days.slice().reverse();          // 最新一天在最上面
    $('detailTable').innerHTML = tableHtml(DETAIL_COLS, rows, function (c, raw) {
      return (c.label === '净额' && raw < 0) ? 'neg' : '';
    });
    $('detailRowsNote').textContent = range.start + ' ~ ' + range.end + '（' + days.length + ' 天，含无成交日）';

    var saleDays = days.filter(function (d) { return d.gmv > 0; }).length;
    var adDays = days.filter(function (d) { return d.spend > 0; }).length;
    var offDays = days.filter(function (d) { return d.offline > 0; }).length;
    var note = '当前：<b>' + esc(sel.label) + '</b>（SPU ' + esc(keep) + (sel.cat ? ' ｜ ' + esc(sel.cat) : '') +
      '）。本周期 ' + days.length + ' 天中 ' + saleDays + ' 天有成交、' + adDays + ' 天有推广花费' +
      (offDays ? '、' + offDays + ' 天有线下登记' : '') + '。';
    if (saleDays > 0 && adDays > 0 && adDays < saleDays) {
      note += ' <b>推广只覆盖 ' + adDays + '/' + saleDays + ' 天</b>，费用被低估，推广占比与 ROI 会虚高。';
    }
    if (tot.gmv > 0 && tot.offline <= 0) {
      note += ' 本周期该货号没有线下登记，线下金额为空。';
    }
    if (fellBack) {
      note += ' （原来的选中货号在这个周期没有活动，已切到本周期第 1 名。）';
    }
    $('detailNotice').innerHTML = note;

    $('detailFootNote').innerHTML =
      '列口径：线上 / 线下 / 退款均为当日金额（元），净额 = 线上 + 线下 − 退款；' +
      '访客、客户数、加购人数按日登记，本表不做区间去重（商智区间去重人数见「商品明细」页合计行）；' +
      '客单价 = 净销售额口径之外的当日销售额 ÷ 当日客户数；推广占比 = 花费 ÷ 销售额，ROI = 销售额 ÷ 花费，' +
      '两者分母都含线下。<br>无成交 / 无推广的日子按 0 补齐，所以图表的 x 轴是连续的日历，不是「只有数据的那几天」。' +
      '线下由人工登记，只到货号级、没有访客与加购，因此线下成交日的访客可能为 0、加购率为 —，属正常。';

    renderDetailScene(keep, range, tot);
    renderDetailKw(keep, range, tot);
    renderSkuDetail(keep, range);
  }

  /* ---------------- 类目分析：把「商品明细」的明细表 +「单品分析」的下钻换作类目主体 ----------------
     数据全部来自 spu_daily（SPU×日 原子层），按 meta[spu][1]（店内细分类目）逐日汇总，
     口径与首页「类目销售额」「类目推广花费」两张卡片一致：
       销售额(全渠道) = 线上成交 + 线下登记，净销售额 = 销售额 − 退款，
       推广费用按 SKU→SPU→类目归集。不改引擎、不改 dataset，纯前端按所选周期重算。 */

  var CAT_COLS = [
    { key: 'label',         name: '类目',       fmt: 'text' },
    { key: 'spu_count',     name: '单品数',     fmt: 'count' },
    { key: 'visitors',      name: '访客数',     fmt: 'count' },
    { key: 'gmv',           name: '销售额',     fmt: 'money' },
    { key: 'offline',       name: '线下销售额', fmt: 'money_opt' },
    { key: 'net',           name: '净销售额',   fmt: 'money' },
    { key: 'headcount',     name: '销售人数',   fmt: 'count' },
    { key: 'add_customers', name: '加购人数',   fmt: 'count' },
    // 加购件数（add_pieces）2026-11-22 用户要求不展示：京东净件数口径常为负，易误读；数据层仍保留供核对
    { key: 'add_rate',      name: '加购率',     fmt: 'pct' },
    { key: 'aov',           name: '客单价',     fmt: 'money' },
    { key: 'spend',         name: '推广费用',   fmt: 'money_opt' },
    { key: 'ad_ratio',      name: '推广占比',   fmt: 'pct' },
    { key: 'roi',           name: 'ROI',        fmt: 'ratio' },
    { key: 'inq_persons',   name: '询单人数',   fmt: 'count_opt' },
    { key: 'inq_cost',      name: '询单成本',   fmt: 'money_opt' }
  ];

  var CAT_KPIS = [
    { key: 'gmv',        name: '销售额',   fmt: 'money', hint: '线上成交 + 线下登记，本类目全部单品' },
    { key: 'net',        name: '净销售额', fmt: 'money', hint: '销售额 − 退款（按申请日归期）' },
    { key: 'visitors',   name: '访客数',   fmt: 'count', hint: '类目内单品按日累加，人次口径不做区间去重' },
    { key: 'headcount',  name: '销售人数', fmt: 'count', hint: '线上成交客户 + 线下登记客户' },
    { key: 'add_rate',   name: '加购率',   fmt: 'pct',   hint: '加购人数 ÷ 访客数，仅线上' },
    { key: 'aov',        name: '客单价',   fmt: 'money', hint: '销售额 ÷ 销售人数' },
    { key: 'spend',      name: '推广费用', fmt: 'money', hint: 'SKU→SPU→类目归集，未匹配的投放不摊派' },
    { key: 'ad_ratio',   name: '推广占比', fmt: 'pct',   hint: '推广费用 ÷ 净销售额（全渠道，≤0 显示 —）' },
    { key: 'roi',        name: 'ROI',      fmt: 'ratio', hint: '销售额（全渠道）÷ 推广费用，不与整店横比' }
  ];

  /** 类目层派生指标（metrics-spec v14）：推广占比分母是「净销售额」不是销售额，且 ≤0 显示 —；
      ROI 分子仍是「销售额（全渠道）」。商品明细 / 单品分析页用的是销售额分母，此处按类目口径统一。 */
  function catDerive(a) {
    a.add_rate = a.visitors > 0 ? a.add_customers / a.visitors : null;
    a.aov = a.headcount > 0 ? a.gmv / a.headcount : null;
    a.ad_ratio = a.net > 0 ? a.spend / a.net : null;
    a.roi = a.spend > 0 ? a.gmv / a.spend : null;
    return a;
  }

  var CAT_SPU_COLS = [
    { label: '货号', get: function (r) {
        return '<a class="spu-link" data-spu="' + esc(r.spu_id) + '" title="查看该货号的日趋势（单品分析）">' +
          esc(r.label) + '</a>';
      }, raw: true },
    { label: '销售额',     get: function (r) { return r.gmv; },      fmt: function (v) { return M.money(v); } },
    { label: '线下',       get: function (r) { return r.offline; },  fmt: function (v) { return v ? M.money(v) : '—'; } },
    { label: '净销售额',   get: function (r) { return r.net; },      fmt: function (v) { return M.money(v); } },
    { label: '访客',       get: function (r) { return r.visitors; } },
    { label: '推广费用',   get: function (r) { return r.spend; },    fmt: function (v) { return v ? M.money(v) : '—'; } },
    { label: '推广占比',   get: function (r) { return r.ad_ratio; }, fmt: function (v) { return M.pct(v); } },
    { label: 'ROI',        get: function (r) { return r.roi; },      fmt: function (v) { return M.ratio(v); } },
    { label: '占类目',     get: function (r) { return r.share; },    fmt: function (v) { return M.pct(v); } }
  ];

  function catOfSpu(spu) {
    var m = (DATA.spu_daily.meta || {})[spu] || [];
    return m[1] || '未归类';
  }

  /** 类目 × 周期汇总行：把 SPU×日 原子层按类目累加，派生指标一律在这里算 */
  function catRowsInRange(range) {
    var S = DATA.spu_daily;
    if (!S || !S.rows) return [];
    var IQ = inquiryRange(range.start, range.end);
    var inqEnd = IQ.coveredEnd || range.end;
    var ix = {};
    S.fields.forEach(function (k, i) { ix[k] = i; });
    var out = {};
    Object.keys(S.rows).forEach(function (spu) {
      var cat = catOfSpu(spu);
      var a = out[cat];
      if (!a) {
        a = out[cat] = { label: cat, cat: cat, spu_count: 0,
          online: 0, offline: 0, refund: 0, visitors: 0, customers: 0,
          offline_customers: 0, add_customers: 0, add_pieces: 0,
          spend: 0, spend_inq: 0, orders: 0, offline_pieces: 0 };
      }
      var days = S.rows[spu], hit = false;
      Object.keys(days).forEach(function (d) {
        if (d < range.start || d > range.end) return;
        hit = true;
        var v = days[d];
        a.online += v[ix.gmv] || 0;
        a.offline += v[ix.offline_gmv] || 0;
        a.refund += v[ix.refund] || 0;
        a.visitors += v[ix.visitors] || 0;
        a.customers += v[ix.customers] || 0;
        a.offline_customers += v[ix.offline_customers] || 0;
        a.add_customers += v[ix.add_customers] || 0;
        a.add_pieces += v[ix.add_pieces] || 0;
        a.spend += v[ix.spend] || 0;
        if (d <= inqEnd) a.spend_inq += v[ix.spend] || 0;
        a.orders += v[ix.orders] || 0;
        a.offline_pieces += v[ix.offline_pieces] || 0;
      });
      if (hit) a.spu_count++;
    });
    // 询单：按类目汇总各 SPU 的 (顾客,SPU) 去重人数，再算类目询单成本
    var inqByCat = {};
    if (IQ.ready) {
      Object.keys(IQ.bySpu).forEach(function (spu) {
        var c = catOfSpu(spu);
        inqByCat[c] = (inqByCat[c] || 0) + IQ.bySpu[spu];
      });
    }
    return Object.keys(out).map(function (k) {
      var a = out[k];
      if (!a.spu_count) return null;
      a.gmv = a.online + a.offline;
      a.net = a.gmv - a.refund;
      a.headcount = a.customers + a.offline_customers;
      a.inq_persons = inqByCat[k] || 0;
      a.inq_cost = (a.inq_persons > 0 && a.spend_inq > 0) ? a.spend_inq / a.inq_persons : null;
      return catDerive(a);
    }).filter(Boolean);
  }

  /** 某类目在指定区间内的逐日序列（把类目内所有 SPU 的当日值相加）；无数据的日子补 0 */
  function catDaySeries(cat, range) {
    var S = DATA.spu_daily;
    if (!S || !S.rows) return [];
    var ix = {};
    S.fields.forEach(function (k, i) { ix[k] = i; });
    var dates = M.rowsBetween(DATA.daily, range).map(function (r) { return r.date; });
    var acc = {};
    dates.forEach(function (d) {
      acc[d] = { date: d, online: 0, offline: 0, refund: 0, visitors: 0, customers: 0,
        offline_customers: 0, add_customers: 0, add_pieces: 0, spend: 0, orders: 0 };
    });
    Object.keys(S.rows).forEach(function (spu) {
      if (catOfSpu(spu) !== cat) return;
      var row = S.rows[spu];
      dates.forEach(function (d) {
        var v = row[d]; if (!v) return;
        var t = acc[d];
        t.online += v[ix.gmv] || 0;
        t.offline += v[ix.offline_gmv] || 0;
        t.refund += v[ix.refund] || 0;
        t.visitors += v[ix.visitors] || 0;
        t.customers += v[ix.customers] || 0;
        t.offline_customers += v[ix.offline_customers] || 0;
        t.add_customers += v[ix.add_customers] || 0;
        t.add_pieces += v[ix.add_pieces] || 0;
        t.spend += v[ix.spend] || 0;
        t.orders += v[ix.orders] || 0;
      });
    });
    return dates.map(function (d) {
      var t = acc[d];
      t.gmv = t.online + t.offline;
      t.net = t.gmv - t.refund;
      t.headcount = t.customers + t.offline_customers;
      return catDerive(t);
    });
  }

  function catOptions() {
    return catRowsInRange(currentRange()).sort(function (a, b) { return (b.gmv || 0) - (a.gmv || 0); });
  }

  function renderCategory() {
    var range = currentRange();
    var all = catRowsInRange(range);
    var q = (state.catQuery || '').trim().toLowerCase();
    var scope = state.catScope || 'all';

    var filtered = all.filter(function (r) {
      if (scope === 'sold' && r.gmv <= 0) return false;
      if (scope === 'ad' && r.spend <= 0) return false;
      if (scope === 'active' && r.gmv <= 0 && r.spend <= 0) return false;
      if (!q) return true;
      return String(r.label).toLowerCase().indexOf(q) >= 0;
    });

    var sk = state.catSort.key, dir = state.catSort.dir;
    filtered.sort(function (a, b) {
      if (sk === 'label') return String(a.label).localeCompare(String(b.label), 'zh-CN') * -dir;
      var va = a[sk], vb = b[sk];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return dir * (vb - va);
    });

    var tot = { label: '合计', gmv: 0, net: 0, refund: 0, visitors: 0, headcount: 0,
      add_customers: 0, add_pieces: 0, spend: 0, spend_inq: 0, online: 0, offline: 0, spu_count: 0,
      inq_persons: 0 };
    filtered.forEach(function (r) {
      ['gmv', 'net', 'refund', 'visitors', 'headcount', 'add_customers', 'add_pieces',
       'spend', 'spend_inq', 'online', 'offline', 'spu_count', 'inq_persons'].forEach(function (k) { tot[k] += r[k] || 0; });
    });
    tot.inq_cost = (tot.inq_persons > 0 && tot.spend_inq > 0) ? tot.spend_inq / tot.inq_persons : null;
    catDerive(tot);

    $('catCount').textContent = filtered.length + ' 个类目 · ' + range.start + ' ~ ' + range.end;

    var head = '<thead><tr>' + CAT_COLS.map(function (c) {
      var on = state.catSort.key === c.key;
      var arrow = on && c.fmt !== 'text' ? (state.catSort.dir === 1 ? ' ↓' : ' ↑') : '';
      return '<th class="' + (c.fmt === 'text' ? 'ta-l' : '') + (on ? ' sorted' : '') +
        '" data-sort="' + c.key + '">' + esc(c.name) + arrow + '</th>';
    }).join('') + '</tr></thead>';

    var body = filtered.length
      ? '<tbody>' + filtered.map(function (r) {
          return '<tr><td class="ta-l"><a class="spu-link cat-pick-link" data-cat="' + esc(r.label) +
            '" title="下钻查看该类目的 KPI 与日趋势">' + esc(r.label) + '</a></td>' +
            CAT_COLS.slice(1).map(function (c) {
              var cls = '';
              if (c.key === 'net' && r.net < 0) cls = ' class="dim"';
              else if (c.key === 'offline' && r.offline > 0) cls = ' class="off-cell" title="线下登记 ' + M.money(r.offline) + '"';
              return '<td' + cls + '>' + esc(fmtSpuCell(r[c.key], c.fmt)) + '</td>';
            }).join('') + '</tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td colspan="' + CAT_COLS.length + '" class="ta-l dim">' +
        (!all.length
          ? (state.mode === 'yoy'
              ? '同比模式没有类目日数据：京东只提供整店区间汇总，没有去年的单品明细。请切回「当月 / 近 7 天 / 近 30 天」。'
              : '该周期没有任何类目数据。')
          : '没有符合筛选条件的类目') + '</td></tr></tbody>';

    var foot = '<tfoot><tr><td class="ta-l"><span class="spu-name">合计</span>' +
      '<span class="spu-cat">' + filtered.length + ' 个类目 / ' + tot.spu_count + ' 个单品</span></td>' +
      CAT_COLS.slice(1).map(function (c) {
        return '<td>' + esc(fmtSpuCell(tot[c.key], c.fmt)) + '</td>';
      }).join('') + '</tr></tfoot>';
    $('catTable').innerHTML = head + body + foot;

    $('catSummary').innerHTML = [
      ['类目数', filtered.length + ' 个'],
      ['单品数', M.count(tot.spu_count) + ' 个'],
      ['销售额', M.money(tot.gmv)],
      ['线下销售额', M.money(tot.offline)],
      ['净销售额', M.money(tot.net)],
      ['访客', M.count(tot.visitors)],
      ['销售人数', M.count(tot.headcount)],
      ['加购率', M.pct(tot.add_rate)],
      ['客单价', M.money(tot.aov)],
      ['推广费用', M.money(tot.spend)],
      ['推广占比', M.pct(tot.ad_ratio)],
      ['ROI', M.ratio(tot.roi)],
      ['询单人数', tot.inq_persons ? M.count(tot.inq_persons) : '—'],
      ['询单成本', tot.inq_cost == null ? '—' : M.money(tot.inq_cost)]
    ].map(function (x) {
      return '<span><span class="k">' + x[0] + '</span><b>' + esc(x[1]) + '</b></span>';
    }).join('');

    $('catNoticeText').textContent =
      '类目取「全店 SKU 表」的店内细分类目（与首页「类目销售额 / 类目推广花费」同一套口径），' +
      '按 SPU×日 明细逐日汇总；销售额 = 线上成交 + 线下登记，净销售额 = 销售额 − 退款。' +
      '推广占比 = 花费 ÷ 净销售额（≤0 显示 —），ROI = 销售额 ÷ 花费，与 BI 首页整店主口径一致。' +
      '访客 / 销售人数 / 加购人数为按日累加的人次口径，不做区间去重；' +
      '推广费用按 SKU→SPU→类目归集；与整店若有微小差额会在下方脚注列出，不估算回填。';

    var storeSpend = M.rowsBetween(DATA.daily, range).reduce(function (s, r) { return s + (r.ad_spend || 0); }, 0);
    var spendGap = Math.abs(storeSpend - tot.spend) < 0.005 ? 0 : storeSpend - tot.spend;
    $('catFootNote').innerHTML =
      '点类目名可跳到下方「单类目下钻」；点列头按该指标排序。' +
      '加购率 = 加购人数 ÷ 访客数（仅线上）；客单价 = 销售额 ÷ 销售人数；' +
      '<b>推广占比 = 推广费用 ÷ 净销售额（全渠道）</b>（净销售额 ≤ 0 显示 —，不显示负百分比）；' +
      'ROI = 销售额（全渠道）÷ 推广费用。口径与 BI 首页整店主口径一致。<br>' +
      '<b>与「商品明细 / 单品分析」的差异</b>：那两页的推广占比分母用「销售额」（未扣退款），' +
      '本页按 metrics-spec v14 的类目口径用「净销售额」，同一批数字会略高（如本月 7.74% vs 6.45%），' +
      '属口径不同，不是数据不一致。<br>' +
      '<b>「销售人数」是人次不是人头</b>：同一顾客买了两个不同货号会各记 1 人，合计行会略高于真实人数，属口径使然。' +
      'ROI 只反映推广渠道贡献，自然成交占比高的类目会出现极高值，不能与整店综合 ROI 横向比较；' +
      '推广费用为 0 的类目 ROI 显示 —。<br>' +
      '<b>推广费用对账</b>：本表合计 ' + M.money(tot.spend) + '，整店同周期 ' + M.money(storeSpend) +
      (spendGap === 0
        ? '，差额 ¥0.00（完全平账）。'
        : '，差额 ' + M.money(Math.abs(spendGap)) + '（' +
          (spendGap > 0 ? '未匹配到 SPU 的投放只进整店口径、不摊派到类目' : '类目层多归集') +
          '，属既定口径，不估算回填）。') + '<br>' +
      '注意：本页是<b>细分类目</b>（如「户外遮阳伞」「凉亭帐篷」），与「业绩监控 / 数据总表」里按 7 大类目标考核的' +
      '粗类目层不是同一套分类，两者不要混算。';

    renderCategoryDetail(all, range);
  }

  function renderCategoryDetail(all, range) {
    var ranked = all.slice().sort(function (a, b) { return (b.gmv || 0) - (a.gmv || 0); });
    var keep = state.catPick;
    var fellBack = false;
    if (!ranked.some(function (r) { return r.label === keep; })) {
      fellBack = !!keep;
      keep = ranked.length ? ranked[0].label : null;
    }
    state.catPick = keep;

    var pick = $('catPick');
    pick.innerHTML = ranked.length
      ? ranked.map(function (r) {
          return '<option value="' + esc(r.label) + '"' + (r.label === keep ? ' selected' : '') + '>' +
            esc(r.label) + '　' + M.money(r.gmv) + '　' + r.spu_count + ' 个单品</option>';
        }).join('')
      : '<option value="">— 该周期没有类目</option>';

    var idx = -1;
    ranked.forEach(function (r, i) { if (r.label === keep) idx = i; });
    $('catPrev').disabled = idx <= 0;
    $('catNext').disabled = idx < 0 || idx >= ranked.length - 1;

    var ids = ['catKpis', 'catProfile', 'catChartGmv', 'catChartVisit', 'catChartAd', 'catSpuTable', 'catDetailTable'];
    if (!keep) {
      var empty = '<div class="rank-empty">' +
        (state.mode === 'yoy' ? '同比模式没有类目日数据：京东只提供整店区间汇总。请切回「当月 / 上月 / 近 7 天」。'
                              : '该周期没有可分析的类目。') + '</div>';
      ids.forEach(function (id) { $(id).innerHTML = id.indexOf('Chart') >= 0 || id === 'catKpis' || id === 'catProfile' ? empty : ''; });
      $('catRank').textContent = '—';
      $('catSpuNote').textContent = '—';
      $('catRowsNote').textContent = '—';
      $('catSpuFootNote').textContent = '';
      $('catDetailFootNote').textContent = '';
      return;
    }

    var sel = ranked[idx] || {};
    var days = catDaySeries(keep, range);
    var tot = catDerive(sumSpuDays(days));       // 统一按类目口径重算 ad_ratio
    var prevDays = catDaySeries(keep, state.mode === 'prev_period' ? prevOfBase() : cmpPrevRange(range));
    var prev = (state.compare && prevDays.some(function (d) {
      return d.gmv > 0 || d.visitors > 0 || d.spend > 0;
    })) ? catDerive(sumSpuDays(prevDays)) : null;

    var storeGmv = ranked.reduce(function (s, r) { return s + (r.gmv || 0); }, 0);
    var storeHead = ranked.reduce(function (s, r) { return s + (r.headcount || 0); }, 0);
    var storeAov = storeHead > 0 ? storeGmv / storeHead : null;

    $('catRank').textContent = '第 ' + (idx + 1) + ' / ' + ranked.length + ' 名（按销售额）';
    $('catProfile').innerHTML = [
      pill('类目', keep),
      pill('销售额排名', '第 ' + (idx + 1) + ' 名', '共 ' + ranked.length + ' 个'),
      pill('单品数', sel.spu_count + ' 个', '本周期有数据'),
      pill('占店铺销售额', storeGmv > 0 ? M.pct(tot.gmv / storeGmv) : '—', '本周期'),
      pill('退款率', tot.gmv > 0 ? M.pct(tot.refund / tot.gmv) : '—', '退款 ÷ 销售额'),
      pill('线下占比', tot.gmv > 0 ? M.pct(tot.offline / tot.gmv) : '—', M.money(tot.offline)),
      pill('日均销售额', M.money(tot.gmv / Math.max(days.length, 1)), days.length + ' 天'),
      pill('客单价 / 店铺', (tot.aov != null && storeAov) ? M.ratio(tot.aov / storeAov) + '×' : '—',
        '店铺 ' + M.money(storeAov))
    ].join('');

    $('catKpis').innerHTML = detailKpiHtml(tot, prev, CAT_KPIS);

    $('catChartGmv').innerHTML = svgChart(days, {
      height: 230,
      bars: [{ key: 'online', label: '线上', color: '#4f6bed' },
             { key: 'offline', label: '线下', color: '#8b72e8' }],
      line: { key: 'net', label: '净销售额', color: '#f0a13c', fmt: 'money' },
      leftFmt: 'money'
    });
    $('catChartVisit').innerHTML = svgChart(days, {
      height: 230,
      bars: [{ key: 'visitors', label: '访客', color: '#c9d3f0' }],
      right: { key: 'add_rate', label: '加购率', color: '#22a06b', fmt: 'pct' },
      leftFmt: 'count', rightFmt: 'pct'
    });
    $('catChartAd').innerHTML = tot.spend > 0
      ? svgChart(days, {
          height: 230,
          bars: [{ key: 'spend', label: '推广费用', color: '#f6c26b' }],
          right: { key: 'roi', label: 'ROI', color: '#d9534f', fmt: 'ratio' },
          leftFmt: 'money', rightFmt: 'ratio'
        })
      : '<div class="rank-empty">该周期这个类目没有推广花费，ROI 无从计算，属口径正常，不是数据缺失。</div>';

    // 构成单品：该类目下所有有数据的 SPU，按销售额降序
    var spus = spuRowsInRange(range).filter(function (r) {
      return (r.cat || '未归类') === keep;
    }).sort(function (a, b) { return (b.gmv || 0) - (a.gmv || 0); });
    spus.forEach(function (r) {
      r.share = tot.gmv > 0 ? r.gmv / tot.gmv : null;
      catDerive(r);   // 与类目表口径一致：推广占比分母用净销售额
    });
    $('catSpuNote').textContent = spus.length + ' 个单品 · 按销售额降序';
    $('catSpuTable').innerHTML = spus.length
      ? tableHtml(CAT_SPU_COLS, spus)
      : '<tbody><tr><td class="ta-l dim">该类目本周期没有单品数据</td></tr></tbody>';
    $('catSpuFootNote').innerHTML =
      '「占类目」= 单品销售额 ÷ 类目销售额；点货号可跳到「单品分析」看该货号的日趋势。' +
      '单品销售额合计与上方类目 KPI 同源（spu_daily），按所选周期求和，包含线下登记；' +
      '推广占比同样按本页类目口径（÷ 净销售额），跳转「单品分析」后该页会用销售额分母，属口径差异。';

    var rows = days.slice().reverse();
    $('catDetailTable').innerHTML = tableHtml(DETAIL_COLS, rows, function (c, raw) {
      return (c.label === '净额' && raw < 0) ? 'neg' : '';
    });
    $('catRowsNote').textContent = range.start + ' ~ ' + range.end + '（' + days.length + ' 天，含无成交日）';

    var saleDays = days.filter(function (d) { return d.gmv > 0; }).length;
    var adDays = days.filter(function (d) { return d.spend > 0; }).length;
    var offDays = days.filter(function (d) { return d.offline > 0; }).length;
    var note = '当前：<b>' + esc(keep) + '</b>。本周期 ' + days.length + ' 天中 ' + saleDays + ' 天有成交、' +
      adDays + ' 天有推广花费' + (offDays ? '、' + offDays + ' 天有线下登记' : '') + '。';
    if (saleDays > 0 && adDays > 0 && adDays < saleDays) {
      note += ' <b>推广只覆盖 ' + adDays + '/' + saleDays + ' 天</b>，费用被低估，推广占比与 ROI 会虚高。';
    }
    if (tot.gmv > 0 && tot.offline <= 0) note += ' 本周期该类目没有线下登记，线下金额为空。';
    if (fellBack) note += ' （原来选中的类目在这个周期没有活动，已切到本周期第 1 名。）';
    $('catDetailFootNote').innerHTML = note +
      '<br>列口径：线上 / 线下 / 退款均为当日金额（元），净额 = 线上 + 线下 − 退款；' +
      '访客、客户数、加购人数按日累加，不做区间去重；客单价 = 当日销售额 ÷ 当日客户数；' +
      '推广占比 = 花费 ÷ 当日净销售额（净额 ≤ 0 显示 —），ROI = 销售额 ÷ 花费，口径都含线下。<br>' +
      '无成交 / 无推广的日子按 0 补齐，图表 x 轴是连续日历；线下由人工登记，只到货号级、没有访客与加购，' +
      '因此线下成交日的访客可能为 0、加购率为 —，属正常。';
  }

  /** 每日更新健康巡检：期望覆盖日、采用/淘汰文件、待补动作。数据来自 dataset.data_health。 */
  function dailyUpdateHtml() {
    var H = DATA.data_health;
    if (!H) return '';
    var badge = { ok: '已到位', warn: '待补', info: '说明' };
    var rows = H.checks.map(function (c) {
      return '<div class="validation-item"><b>' + esc(c.label) + '</b>' +
        '<span class="v-badge' + (c.status === 'warn' ? ' deferred' : '') + '">' + esc(badge[c.status]) + '</span>' +
        '<span class="v-detail">' + esc(c.detail) + '</span></div>';
    }).join('');
    var acts = H.next_actions.length
      ? '<div class="card-note">下一步：' + H.next_actions.map(function (a, i) {
          return (i + 1) + '. ' + esc(a);
        }).join('；') + '</div>'
      : '<div class="card-note">数据已更新到 ' + esc(H.meta.expected_through) + '，无待补项。</div>';
    return '<div class="card" style="text-align:left;margin:12px 0;padding:14px">' +
      '<b>每日更新 · 数据健康巡检</b>' +
      '<div class="card-note">模式：销售明细「整月累计重导」｜手动日更双击桌面「每日更新.cmd」（自动快照 → 重建 → 自检 → 摘要）' +
      '｜期望覆盖到 ' + esc(H.meta.expected_through) + '（每天抓前一天）｜检查窗口 ' +
      esc(H.meta.check_window.join(' ~ ')) + '</div>' +
      rows + acts + '</div>';
  }

  function bind() {
    /* 每日推广页：点周期条 = 按该区间聚合；选页内日期 = 只看那一天 */
    $('periods').addEventListener('click', function (e) {
      var b = e.target.closest('.period');
      if (!b || b.id === 'monthToggle') return;   // 「月」按钮走下面的自然月选择器
      // 每日推广页：点「单日」保持单日口径，点其它档回到区间口径
      if (state.view === 'adspu') state.adspuMode = b.dataset.mode === 'single_day' ? 'day' : 'period';
      $('periods').querySelectorAll('.period').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active'); state.mode = b.dataset.mode;
      $('monthToggle').textContent = '月';
      // 记住最后一个「实区间」的选择：「上一周期 / 同比」要跟着它回退，而不是永远按当月
      if (b.dataset.mode !== 'prev_period' && b.dataset.mode !== 'yoy') {
        state.baseMode = b.dataset.mode;
      }
      state.spuLimit = 200; render();
    });
    /* 单日：点「单日」后出现日期框；改日期即重绘。默认取数据末日，避免空值 */
    if ($('singleDate')) $('singleDate').addEventListener('change', function (e) {
      state.singleDate = e.target.value || lastDate();
      state.mode = 'single_day'; state.baseMode = 'single_day';
      if (state.view === 'adspu') state.adspuMode = 'day';
      render();
    });
    // 自然月选择器（参考京东商智「月」）：点按钮开合、点月份格切换、点外部关闭
    $('monthToggle').addEventListener('click', function (e) {
      e.stopPropagation();
      var p = $('monthPicker');
      p.hidden = !p.hidden;
      if (!p.hidden) renderMonthPicker();
    });
    $('mpGrid').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.mp-cell:not([disabled])');
      if (!b) return;
      state.monthPick = b.dataset.month;
      state.mode = 'month'; state.baseMode = 'month';
      $('periods').querySelectorAll('.period').forEach(function (x) { x.classList.remove('active'); });
      $('monthToggle').classList.add('active');
      $('monthToggle').textContent = state.monthPick.slice(5) + '月';
      $('monthPicker').hidden = true;
      state.spuLimit = 200; render();
    });
    ['mpPrevYear', 'mpNextYear'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        e.stopPropagation();
        state.mpYear = (state.mpYear || +lastDate().slice(0, 4)) + (id === 'mpPrevYear' ? -1 : 1);
        renderMonthPicker();
      });
    });
    document.addEventListener('click', function (e) {
      var p = $('monthPicker');
      if (!p.hidden && !(e.target.closest && e.target.closest('.month-pick-wrap'))) p.hidden = true;
    });
    $('comparePrev').addEventListener('change', function (e) { state.compare = e.target.checked; render(); });
    /* 数据对比：搜索 / 排序 / 选单品 / 上一款下一款，只重绘本视图，不动周期条 */
    if ($('cmpSearch')) $('cmpSearch').addEventListener('input', function (e) {
      state.cmpQuery = e.target.value;
      state.cmpPick = null;           // 搜索变了就回到结果第一条，避免停在已过滤掉的单品上
      if (state.view === 'compare') renderCompare();
    });
    if ($('cmpSort')) $('cmpSort').addEventListener('change', function (e) {
      state.cmpSort = e.target.value;
      if (state.view === 'compare') renderCompare();
    });
    if ($('cmpPick')) $('cmpPick').addEventListener('change', function (e) {
      state.cmpPick = e.target.value; if (state.view === 'compare') renderCompare();
    });
    function cmpStep(dir) {
      var opts = Array.prototype.slice.call($('cmpPick').options);
      var i = $('cmpPick').selectedIndex + dir;
      if (i < 0 || i >= opts.length) return;
      state.cmpPick = opts[i].value;
      renderCompare();
    }
    if ($('cmpPrev')) $('cmpPrev').addEventListener('click', function () { cmpStep(-1); });
    if ($('cmpNext')) $('cmpNext').addEventListener('click', function () { cmpStep(1); });
    $('planPeriod').addEventListener('change', function (e) {
      state.planPeriod = e.target.value;
      state.planPkQuery = ''; $('planPkSearch').value = '';
      renderPlan();
    });
    /* 计划 × 关键词：选计划 / 搜词 / 点表头排序，都用事件委托，列表重绘后不必重新绑定 */
    $('planPkPlans').addEventListener('click', function (e) {
      var t = e.target || {};
      var pid = t.getAttribute && t.getAttribute('data-plan');
      if (!pid) return;
      state.planPick = pid;
      state.planPkQuery = ''; $('planPkSearch').value = '';
      renderPlan();
    });
    $('planPkSearch').addEventListener('input', function (e) {
      state.planPkQuery = e.target.value || '';
      var P = currentPlan();
      if (P && P.kw_view) renderPlanKeyword(P, P.kw_view);
    });
    $('planPkTable').addEventListener('click', function (e) {
      var t = e.target || {};
      var k = t.getAttribute && t.getAttribute('data-sort');
      if (!k) return;
      var sk = state.planPkSort;
      state.planPkSort = { key: k, dir: sk.key === k ? -sk.dir : (k === 'keyword' ? 1 : -1) };
      var P = currentPlan();
      if (P && P.kw_view) renderPlanKeyword(P, P.kw_view);
    });
    var mktTimer = null;
    $('planMarketSearch').addEventListener('input', function (e) {
      var v = e.target.value;
      clearTimeout(mktTimer);
      mktTimer = setTimeout(function () {
        state.planMarketQuery = v;
        var P = currentPlan();
        if (P && P.kw_view) renderPlanMarket(P, P.kw_view);
      }, 200);
    });
    /* 每日推广：选单品 / 日期 / 下钻维度 / 行数 / 搜词，任一改动都重绘 */
    $('adspuPickList').addEventListener('click', function (e) {
      var t = e.target || {};
      var spu = t.getAttribute ? t.getAttribute('data-spu') : null;
      if (!spu && t.closest) {
        var btn = t.closest('[data-spu]');
        spu = btn ? btn.getAttribute('data-spu') : null;
      }
      if (!spu) return;
      state.adspuPick = spu; renderAdspu();
    });
    if ($('adspuModeSeg')) $('adspuModeSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mode]');
      if (!b) return;
      var m = b.getAttribute('data-mode');
      state.adspuMode = m;
      if (m === 'day') {               // 与周期条同步：单日 = 周期条的「单日」档
        state.mode = 'single_day'; state.baseMode = 'single_day';
        if (!state.singleDate) state.singleDate = state.adspuDate || lastDate();
        state.singleDate = state.adspuDate || state.singleDate;
      } else {                         // 回区间：退回最近一次选中的周期
        state.mode = state.baseMode && state.baseMode !== 'single_day' ? state.baseMode : 'this_month';
      }
      render();                        // 整页重绘：页头 chip、周期条淡化一起更新
    });
    $('adspuDate').addEventListener('change', function (e) {
      state.adspuDate = e.target.value;
      state.adspuMode = 'day';        // 选了具体日期 = 只看这一天，与周期条的区间口径互斥
      state.mode = 'single_day'; state.baseMode = 'single_day'; state.singleDate = state.adspuDate;
      render();                        // 走整页重绘，顶部「单日 / 区间」chip 才会同步
    });
    $('adspuDim').addEventListener('change', function (e) {
      state.adspuDim = e.target.value; renderAdspu();
    });
    $('adspuLimit').addEventListener('change', function (e) {
      state.adspuLimit = e.target.value; renderAdspu();
    });
    var adspuTimer = null;
    $('adspuSearch').addEventListener('input', function (e) {
      var v = e.target.value;
      clearTimeout(adspuTimer);
      adspuTimer = setTimeout(function () { state.adspuQuery = v; renderAdspu(); }, 200);
    });
    var spuSearchTimer = null;
    $('spuSearch').addEventListener('input', function (e) {
      var v = e.target.value;
      clearTimeout(spuSearchTimer);          // 防抖：每次按键都全表重绘会卡住长列表
      spuSearchTimer = setTimeout(function () {
        state.spuQuery = v; state.spuLimit = 200; renderSpu();
      }, 220);
    });
    $('spuScope').addEventListener('change', function (e) {
      state.spuScope = e.target.value; state.spuLimit = 200; renderSpu();
    });
    $('spuMore').addEventListener('click', function () {
      state.spuLimit = 100000; renderSpu();
    });
    $('spuTable').addEventListener('click', function (e) {
      // 点货号 → 直接跳到该货号的单品分析
      var link = e.target.closest('.spu-link');
      if (link) {
        state.detailSpu = link.getAttribute('data-spu');
        state.detailQuery = '';
        $('detailSearch').value = '';
        state.view = 'detail';
        document.querySelectorAll('.nav-item').forEach(function (x) {
          x.classList.toggle('active', x.dataset.view === 'detail');
        });
        render();
        return;
      }
      var th = e.target.closest('th[data-sort]'); if (!th) return;
      var key = th.getAttribute('data-sort');
      if (state.spuSort.key === key) state.spuSort.dir = -state.spuSort.dir;
      else state.spuSort = { key: key, dir: 1 };
      renderSpu();
    });
    /* 单品分析：搜货号 → 下拉选 → 上一个/下一个 在这份排序里走 */
    var detailTimer = null;
    $('detailSearch').addEventListener('input', function (e) {
      var v = e.target.value;
      clearTimeout(detailTimer);
      detailTimer = setTimeout(function () { state.detailQuery = v; renderDetail(); }, 220);
    });
    $('detailPick').addEventListener('change', function (e) {
      state.detailSpu = e.target.value || null; renderDetail();
    });
    function stepDetail(delta) {
      var opts = detailOptions().opts;
      var i = -1;
      opts.forEach(function (r, k) { if (r.spu_id === state.detailSpu) i = k; });
      var j = i + delta;
      if (i < 0 || j < 0 || j >= opts.length) return;
      state.detailSpu = opts[j].spu_id; renderDetail();
    }
    $('detailPrev').addEventListener('click', function () { stepDetail(-1); });
    $('detailNext').addEventListener('click', function () { stepDetail(1); });
    /* 类目分析：搜索 / 范围 / 列头排序 / 点类目下钻 / 上下切换 / 构成单品跳单品分析 */
    var catTimer = null;
    $('catSearch').addEventListener('input', function (e) {
      var v = e.target.value;
      clearTimeout(catTimer);
      catTimer = setTimeout(function () { state.catQuery = v; renderCategory(); }, 220);
    });
    $('catScope').addEventListener('change', function (e) {
      state.catScope = e.target.value; renderCategory();
    });
    $('catTable').addEventListener('click', function (e) {
      var link = e.target.closest('.cat-pick-link');
      if (link) {
        state.catPick = link.getAttribute('data-cat');
        renderCategory();
        var anchor = document.querySelector('#view-category .sub-head');
        if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      var th = e.target.closest('th[data-sort]'); if (!th) return;
      var key = th.getAttribute('data-sort');
      if (state.catSort.key === key) state.catSort.dir = -state.catSort.dir;
      else state.catSort = { key: key, dir: 1 };
      renderCategory();
    });
    $('catSpuTable').addEventListener('click', function (e) {
      var link = e.target.closest('.spu-link'); if (!link) return;
      state.detailSpu = link.getAttribute('data-spu');
      state.detailQuery = '';
      $('detailSearch').value = '';
      state.view = 'detail';
      document.querySelectorAll('.nav-item').forEach(function (x) {
        x.classList.toggle('active', x.dataset.view === 'detail');
      });
      render();
    });
    $('catPick').addEventListener('change', function (e) {
      state.catPick = e.target.value || null; renderCategory();
    });
    function stepCategory(delta) {
      var opts = catOptions().map(function (r) { return r.label; });
      var i = opts.indexOf(state.catPick), j = i + delta;
      if (i < 0 || j < 0 || j >= opts.length) return;
      state.catPick = opts[j]; renderCategory();
    }
    $('catPrev').addEventListener('click', function () { stepCategory(-1); });
    $('catNext').addEventListener('click', function () { stepCategory(1); });
    // 诊断页：归因维度/指标切换 + 预警忽略与恢复（仅前端 localStorage，不动数据层）
    if ($('diagDriverMetric')) $('diagDriverMetric').addEventListener('change', function (e) {
      state.diagDriverMetric = e.target.value; renderDiagnosis();
    });
    $('diagDrivers').addEventListener('click', function (e) {
      var b = e.target.closest('.diag-driver-name'); if (!b) return;
      state.diagDriverDim = state.diagDriverDim === 'cat' ? 'spu' : 'cat';
      renderDiagnosis();
    });
    $('diagAlerts').addEventListener('click', function (e) {
      var ignore = e.target.closest('.diag-ignore');
      if (ignore) { diagSetIgnored(ignore.getAttribute('data-alert-id'), true); renderDiagnosis(); return; }
      if (e.target.id === 'diagRestoreAll') {
        try { localStorage.removeItem(DIAG_IGNORE_KEY); } catch (err) { /* 隐私模式忽略 */ }
        renderDiagnosis();
      }
    });
    document.querySelectorAll('.nav-item').forEach(function (a) {
      a.addEventListener('click', function () {
        if (a.classList.contains('todo')) { toast(a.dataset.todo + '：尚未接入'); return; }
        document.querySelectorAll('.nav-item').forEach(function (x) { x.classList.remove('active'); });
        a.classList.add('active'); state.view = a.dataset.view; render();
      });
    });
    document.querySelectorAll('.todo').forEach(function (b) {
      b.addEventListener('click', function () { toast((b.dataset.todo || '该模块') + '：骨架占位，尚未接入'); });
    });
    $('btnRebuild').addEventListener('click', async function () {
      if (!window.dashboardAPI || !window.dashboardAPI.rebuildDataset) {
        toast('浏览器模式请用命令行重建：cd dashboard/app && npm run build');
        return;
      }
      toast('正在重建数据，请稍候…');
      var r = await window.dashboardAPI.rebuildDataset();
      if (r && r.code === 0) {
        var d = await window.dashboardAPI.getDataset();
        if (d && !d.error) { DATA = d; render(); }
        toast('重建完成，数据已刷新');
      } else {
        toast('重建失败：' + ((r && r.output) || '').slice(-120));
      }
    });
  }

  load();
})();
