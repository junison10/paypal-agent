/* PayPal Agent — vanilla JS front end.
 * Talks to the same-origin API only:
 *   GET  /api/health
 *   POST /api/parse   {text}
 *   POST /api/confirm {pendingId, confirmed}
 *   GET  /api/history
 *   GET  /api/settings        PUT /api/settings
 *   POST /api/allowlist       DELETE /api/allowlist
 * No backend knowledge beyond this contract is assumed.
 */
(function () {
  'use strict';

  var chat = document.getElementById('chat');
  var input = document.getElementById('input');
  var composer = document.getElementById('composer');
  var sendBtn = document.getElementById('sendBtn');
  var modeBadge = document.getElementById('modeBadge');
  var historyList = document.getElementById('history');
  var allowlistEl = document.getElementById('allowlist');
  var settingsForm = document.getElementById('settingsForm');
  var settingsMsg = document.getElementById('settingsMsg');
  var allowlistForm = document.getElementById('allowlistForm');
  var allowlistMsg = document.getElementById('allowlistMsg');

  /* ---------- helpers ---------- */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtMoney(amount, currency) {
    if (amount == null) return '—';
    var n = Number(amount);
    if (!isFinite(n)) return esc(amount);
    return n.toFixed(2) + ' ' + esc(currency || '');
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return isNaN(d.getTime()) ? esc(ts) : d.toLocaleString();
  }

  function addMessage(text, kind) {
    var div = document.createElement('div');
    div.className = 'msg ' + (kind || 'agent');
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function addCard(el) {
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  async function api(path, options) {
    var res = await fetch(path, Object.assign(
      { headers: { 'Content-Type': 'application/json' } }, options || {}));
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON body */ }
    if (!res.ok) {
      var msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  /* ---------- health / mode badge ---------- */

  async function loadHealth() {
    try {
      var health = await api('/api/health');
      var mode = (health && health.mode) || 'unknown';
      modeBadge.textContent = 'mode: ' + mode;
      modeBadge.title = 'Backend status: ' + (health.status || 'unknown');
      if (mode === 'mock') {
        addMessage('Running in mock mode — no PayPal credentials configured. ' +
          'Payments are simulated so you can try the full flow; no real money moves.', 'system');
      }
    } catch (err) {
      modeBadge.textContent = 'mode: unreachable';
      addMessage('Could not reach the backend (' + err.message + '). ' +
        'Is the server running? Try: npm start', 'error');
    }
  }

  /* ---------- settings ---------- */

  function fillSettings(s) {
    if (!s) return;
    if (s.perTxCap != null) document.getElementById('perTxCap').value = s.perTxCap;
    if (s.dailyCap != null) document.getElementById('dailyCap').value = s.dailyCap;
    if (s.currency) document.getElementById('currency').value = s.currency;
  }

  async function loadSettings() {
    try { fillSettings(await api('/api/settings')); }
    catch (err) { setMsg(settingsMsg, 'Could not load settings: ' + err.message, false); }
  }

  function setMsg(el, text, ok) {
    el.textContent = text;
    el.className = 'form-msg ' + (ok ? 'ok' : 'err');
  }

  settingsForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var body = {
      perTxCap: Number(document.getElementById('perTxCap').value),
      dailyCap: Number(document.getElementById('dailyCap').value),
      currency: document.getElementById('currency').value
    };
    try {
      fillSettings(await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) }));
      setMsg(settingsMsg, 'Settings saved.', true);
    } catch (err) {
      setMsg(settingsMsg, 'Save failed: ' + err.message, false);
    }
  });

  /* ---------- allowlist ---------- */

  function renderAllowlist(emails) {
    allowlistEl.innerHTML = '';
    if (!emails || emails.length === 0) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Allowlist is empty — add a recipient email to enable payments to them.';
      allowlistEl.appendChild(li);
      return;
    }
    emails.forEach(function (email) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = email;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'danger';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        try {
          var updated = await api('/api/allowlist', {
            method: 'DELETE', body: JSON.stringify({ email: email })
          });
          renderAllowlist(updated.allowlist || updated.emails || []);
          setMsg(allowlistMsg, 'Removed ' + email + '.', true);
        } catch (err) {
          setMsg(allowlistMsg, 'Remove failed: ' + err.message, false);
          btn.disabled = false;
        }
      });
      li.appendChild(span);
      li.appendChild(btn);
      allowlistEl.appendChild(li);
    });
  }

  async function loadAllowlist() {
    try {
      // Settings payload may already carry the allowlist; fall back to a
      // dedicated read via settings, since the contract has no GET allowlist.
      var s = await api('/api/settings');
      fillSettings(s);
      renderAllowlist(s.allowlist || s.emails || []);
    } catch (err) {
      renderAllowlist([]);
      setMsg(allowlistMsg, 'Could not load allowlist: ' + err.message, false);
    }
  }

  allowlistForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var emailInput = document.getElementById('allowlistEmail');
    var email = emailInput.value.trim();
    if (!email) return;
    try {
      var updated = await api('/api/allowlist', {
        method: 'POST', body: JSON.stringify({ email: email })
      });
      renderAllowlist(updated.allowlist || updated.emails || []);
      emailInput.value = '';
      setMsg(allowlistMsg, 'Added ' + email + ' to the allowlist.', true);
    } catch (err) {
      setMsg(allowlistMsg, 'Add failed: ' + err.message, false);
    }
  });

  /* ---------- history ---------- */

  function renderHistory(txs) {
    historyList.innerHTML = '';
    if (!txs || txs.length === 0) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No transactions yet.';
      historyList.appendChild(li);
      return;
    }
    // Newest first.
    var sorted = txs.slice().sort(function (a, b) {
      return new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0);
    });
    sorted.forEach(function (tx) {
      var r = tx.receipt || tx;
      var li = document.createElement('li');
      var status = esc(r.status || tx.status || 'unknown');
      li.innerHTML =
        '<div class="tx-top"><span class="tx-amount">' + fmtMoney(r.amount, r.currency) + '</span>' +
        '<span class="status ' + status.toLowerCase() + '">' + status + '</span></div>' +
        '<div class="tx-meta">' + esc(r.recipient || tx.recipient || '—') +
        (r.invoiceId ? ' · invoice ' + esc(r.invoiceId) : '') + '</div>' +
        '<div class="tx-meta">' + esc(r.memo || tx.memo || '') + '</div>' +
        '<div class="tx-meta">' +
        (r.orderId ? 'order <span class="mono">' + esc(r.orderId) + '</span> · ' : '') +
        (r.captureId ? 'capture <span class="mono">' + esc(r.captureId) + '</span> · ' : '') +
        fmtTime(r.timestamp || tx.timestamp) + '</div>';
      historyList.appendChild(li);
    });
  }

  async function loadHistory() {
    try {
      var data = await api('/api/history');
      renderHistory(data.transactions || data.history || []);
    } catch (err) {
      historyList.innerHTML = '';
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Could not load history: ' + err.message;
      historyList.appendChild(li);
    }
  }

  /* ---------- parse → confirm flow ---------- */

  function renderConfirmation(data) {
    var intent = data.intent || {};
    var guard = data.guardrails || {};
    var checks = guard.checks || [];
    var passed = guard.passed === true && data.requiresConfirmation !== false;

    var card = document.createElement('div');
    card.className = 'card';

    var fields =
      '<dl>' +
      '<dt>Amount</dt><dd>' + fmtMoney(intent.amount, intent.currency) + '</dd>' +
      '<dt>Recipient</dt><dd>' + esc(intent.recipient || '—') + '</dd>' +
      '<dt>Invoice</dt><dd>' + esc(intent.invoiceId || '—') + '</dd>' +
      '<dt>Memo</dt><dd>' + esc(intent.memo || '—') + '</dd>' +
      '<dt>Method</dt><dd>' + esc(intent.method || '—') + '</dd>' +
      '<dt>Confidence</dt><dd>' + esc(intent.confidence != null ? intent.confidence : '—') + '</dd>' +
      '</dl>';

    var checksHtml = '<ul class="checks">' + checks.map(function (c) {
      var ok = c.passed === true;
      return '<li class="' + (ok ? 'pass' : 'fail') + '">' + (ok ? '✅ ' : '❌ ') +
        esc(c.rule || 'check') + ' — ' + esc(c.detail || (ok ? 'passed' : 'failed')) + '</li>';
    }).join('') + '</ul>';

    card.innerHTML =
      '<h3>Confirm payment?</h3>' + fields +
      '<h3>Guardrails</h3>' + checksHtml +
      (passed ? '' : '<p class="blocked-note">⛔ Guardrails failed — this payment is blocked and cannot be confirmed.</p>');

    var actions = document.createElement('div');
    actions.className = 'card-actions';

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Confirm & pay';
    confirmBtn.disabled = !passed;

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);
    addCard(card);

    async function finish(confirmed) {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        var res = await api('/api/confirm', {
          method: 'POST',
          body: JSON.stringify({ pendingId: data.pendingId, confirmed: confirmed })
        });
        if (res.cancelled) {
          renderReceipt(null, true);
        } else if (res.receipt) {
          renderReceipt(res.receipt, false);
        } else {
          addMessage('Unexpected confirm response: ' + JSON.stringify(res), 'error');
        }
        loadHistory();
      } catch (err) {
        addMessage('Confirm failed: ' + err.message, 'error');
        confirmBtn.disabled = !passed;
        cancelBtn.disabled = false;
      }
    }

    confirmBtn.addEventListener('click', function () { finish(true); });
    cancelBtn.addEventListener('click', function () { finish(false); });
  }

  function renderReceipt(receipt, cancelled) {
    var card = document.createElement('div');
    card.className = 'card ' + (cancelled ? 'receipt-cancelled' : 'receipt-ok');
    if (cancelled) {
      card.innerHTML = '<h3>Payment cancelled</h3><p>No money moved. The pending payment was discarded.</p>';
    } else {
      card.innerHTML =
        '<h3>✅ Payment complete</h3>' +
        '<dl>' +
        '<dt>Status</dt><dd>' + esc(receipt.status || '—') + '</dd>' +
        '<dt>Amount</dt><dd>' + fmtMoney(receipt.amount, receipt.currency) + '</dd>' +
        '<dt>Recipient</dt><dd>' + esc(receipt.recipient || '—') + '</dd>' +
        '<dt>Invoice</dt><dd>' + esc(receipt.invoiceId || '—') + '</dd>' +
        '<dt>Memo</dt><dd>' + esc(receipt.memo || '—') + '</dd>' +
        '<dt>Order ID</dt><dd><span class="mono">' + esc(receipt.orderId || '—') + '</span></dd>' +
        '<dt>Capture ID</dt><dd><span class="mono">' + esc(receipt.captureId || '—') + '</span></dd>' +
        '<dt>Time</dt><dd>' + fmtTime(receipt.timestamp) + '</dd>' +
        '</dl>';
    }
    addCard(card);
  }

  async function handleSubmit(text) {
    addMessage(text, 'user');
    input.value = '';
    sendBtn.disabled = true;
    try {
      var data = await api('/api/parse', { method: 'POST', body: JSON.stringify({ text: text }) });
      if (!data || !data.intent) {
        addMessage('The agent could not parse that instruction. Try e.g. "bayar $25 ke supplier@example.com buat invoice #123".', 'agent');
        return;
      }
      renderConfirmation(data);
    } catch (err) {
      addMessage('Parse failed: ' + err.message, 'error');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (text) handleSubmit(text);
  });

  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      input.value = chip.getAttribute('data-prompt');
      input.focus();
      handleSubmit(chip.getAttribute('data-prompt'));
    });
  });

  /* ---------- init ---------- */

  addMessage('Hi! Tell me who to pay and how much — e.g. "bayar $25 ke supplier@example.com buat invoice #123". ' +
    'I\'ll parse it, check the guardrails, and only pay after you confirm.', 'agent');
  loadHealth();
  loadSettings();
  loadAllowlist();
  loadHistory();
})();
