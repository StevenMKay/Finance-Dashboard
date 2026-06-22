/* Salary planner — rough US take-home estimate, debounced auto-save. */
(function () {
  // 2025 federal brackets (estimates — confirm against IRS for filing).
  var FED_2025 = {
    single: [
      [0,        0.10], [11925,   0.12], [48475,   0.22], [103350,  0.24],
      [197300,   0.32], [250525,  0.35], [626350,  0.37]
    ],
    mfj: [
      [0,        0.10], [23850,   0.12], [96950,   0.22], [206700,  0.24],
      [394600,   0.32], [501050,  0.35], [751600,  0.37]
    ],
    hoh: [
      [0,        0.10], [17000,   0.12], [64850,   0.22], [103350,  0.24],
      [197300,   0.32], [250500,  0.35], [626350,  0.37]
    ]
  };
  var STANDARD_DEDUCTION_2025 = { single: 15000, mfj: 30000, hoh: 22500 };

  // FICA 2025
  var SS_RATE = 0.062, SS_WAGE_CAP = 176100;
  var MEDICARE_RATE = 0.0145, MEDICARE_ADDL = 0.009, MEDICARE_ADDL_THRESHOLD = 200000;

  // Simple state-tax flat rates (rough averages; user can refine later).
  var STATE_RATES = {
    AL: 0.05, AK: 0,    AZ: 0.025, AR: 0.039, CA: 0.093, CO: 0.044,
    CT: 0.055, DE: 0.055, FL: 0,   GA: 0.0539, HI: 0.075, ID: 0.058,
    IL: 0.0495, IN: 0.0305, IA: 0.038, KS: 0.057, KY: 0.04, LA: 0.0425,
    ME: 0.0715, MD: 0.055, MA: 0.05, MI: 0.0425, MN: 0.0785, MS: 0.0475,
    MO: 0.047, MT: 0.059, NE: 0.052, NV: 0, NH: 0,   NJ: 0.0637,
    NM: 0.049, NY: 0.0685, NC: 0.045, ND: 0.025, OH: 0.0375, OK: 0.0475,
    OR: 0.099, PA: 0.0307, RI: 0.0599, SC: 0.064, SD: 0, TN: 0,
    TX: 0,   UT: 0.0465, VT: 0.0875, VA: 0.0575, WA: 0,   WV: 0.0482,
    WI: 0.0765, WY: 0,  DC: 0.0875
  };

  function fillStates() {
    var sel = FU.$('#sp-state');
    sel.innerHTML = '';
    Object.keys(STATE_RATES).sort().forEach(function (k) {
      sel.appendChild(FU.el('option', { value: k, text: k + (STATE_RATES[k] ? ' (' + (STATE_RATES[k]*100).toFixed(1) + '%)' : ' (no tax)') }));
    });
  }

  function fedTax(taxable, status) {
    var brackets = FED_2025[status] || FED_2025.single;
    if (taxable <= 0) return 0;
    var tax = 0;
    for (var i = 0; i < brackets.length; i++) {
      var lo = brackets[i][0];
      var rate = brackets[i][1];
      var hi = (i + 1 < brackets.length) ? brackets[i + 1][0] : Infinity;
      if (taxable > lo) {
        var slice = Math.min(taxable, hi) - lo;
        tax += slice * rate;
      } else break;
    }
    return tax;
  }

  function fica(gross) {
    var ss = Math.min(gross, SS_WAGE_CAP) * SS_RATE;
    var med = gross * MEDICARE_RATE + Math.max(0, gross - MEDICARE_ADDL_THRESHOLD) * MEDICARE_ADDL;
    return ss + med;
  }

  function compute(plan) {
    var gross = FU.safeNum(plan.targetAnnual, 0);
    var status = plan.filingStatus || 'single';
    var retirePct = Math.max(0, Math.min(50, FU.safeNum(plan.retirementPct, 0))) / 100;
    var healthMonthly = Math.max(0, FU.safeNum(plan.healthMonthly, 0));
    var stateRate = STATE_RATES[plan.state] || 0;

    var retire = gross * retirePct;
    var healthYr = healthMonthly * 12;
    // Pre-tax deductions reduce federal taxable income (401k + health)
    var preTax = retire + healthYr;
    var fedTaxable = Math.max(0, gross - preTax - (STANDARD_DEDUCTION_2025[status] || 15000));
    var fed = fedTax(fedTaxable, status);
    var stateTax = Math.max(0, gross - preTax) * stateRate;
    var ficaTax = fica(gross);

    var netY = gross - retire - healthYr - fed - stateTax - ficaTax;
    if (netY < 0) netY = 0;
    var netM = netY / 12;
    var netBW = netY / 26;
    var netH = netY / (52 * 40);

    var current = FU.safeNum(plan.currentAnnual, 0);
    var gap = gross - current;

    return {
      gross: gross, fed: fed, fica: ficaTax, stateTax: stateTax,
      retire: retire, healthYr: healthYr,
      netY: netY, netM: netM, netBW: netBW, netH: netH,
      gap: gap
    };
  }

  function render(r) {
    FU.$('#sp-gross').textContent      = FU.money(r.gross);
    FU.$('#sp-fed').textContent        = '−' + FU.money(r.fed);
    FU.$('#sp-fica').textContent       = '−' + FU.money(r.fica);
    FU.$('#sp-state-tax').textContent  = '−' + FU.money(r.stateTax);
    FU.$('#sp-401k-amt').textContent   = '−' + FU.money(r.retire);
    FU.$('#sp-health-amt').textContent = '−' + FU.money(r.healthYr);
    FU.$('#sp-net-y').textContent      = FU.money(r.netY);
    FU.$('#sp-net-m').textContent      = FU.money(r.netM);
    FU.$('#sp-net-bw').textContent     = FU.money(r.netBW);
    FU.$('#sp-net-h').textContent      = FU.money(r.netH);
    var gapEl = FU.$('#sp-gap');
    gapEl.textContent = (r.gap > 0 ? '+' : '') + FU.money(r.gap);
    gapEl.className = 'val ' + (r.gap > 0 ? 'up' : (r.gap < 0 ? 'down' : 'muted'));
  }

  function readForm() {
    return {
      targetAnnual:  FU.safeNum(FU.$('#sp-target').value, 0),
      currentAnnual: FU.safeNum(FU.$('#sp-current').value, 0),
      filingStatus:  FU.$('#sp-filing').value,
      state:         FU.$('#sp-state').value,
      retirementPct: FU.safeNum(FU.$('#sp-401k').value, 0),
      healthMonthly: FU.safeNum(FU.$('#sp-health').value, 0)
    };
  }

  function setForm(plan) {
    if (!plan) return;
    FU.$('#sp-target').value  = plan.targetAnnual  || '';
    FU.$('#sp-current').value = plan.currentAnnual || '';
    FU.$('#sp-filing').value  = plan.filingStatus  || 'single';
    FU.$('#sp-state').value   = plan.state         || 'CA';
    FU.$('#sp-401k').value    = plan.retirementPct != null ? plan.retirementPct : 6;
    FU.$('#sp-health').value  = plan.healthMonthly != null ? plan.healthMonthly : 0;
  }

  var save = FU.debounce(function () {
    var plan = readForm();
    FinanceStore.saveSalary(plan).catch(function (e) { console.warn('[salary] save failed', e); });
  }, 600);

  function recompute() {
    var plan = readForm();
    render(compute(plan));
    save();
  }

  function init() {
    fillStates();
    setForm({ filingStatus: 'single', state: 'CA', retirementPct: 6, healthMonthly: 0 });
    ['#sp-target','#sp-current','#sp-filing','#sp-state','#sp-401k','#sp-health'].forEach(function (id) {
      FU.$(id).addEventListener('input', recompute);
      FU.$(id).addEventListener('change', recompute);
    });
    recompute();
  }

  window.FinanceSalary = {
    init: init,
    setPlan: function (plan) {
      if (!plan) return;
      setForm(plan);
      render(compute(readForm()));
    }
  };
})();
