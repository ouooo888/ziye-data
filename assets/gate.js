(function () {
  'use strict';
  // 正确口令的 SHA-256（小写 hex）。源码里只存哈希，不含明文。
  // 修改口令：用 sha256(新口令) 替换下面的值，并把新口令发给使用方。
  var GATE_HASH = '10c650be78875201ce12d803c3c1f6e246149f4a606965b02555c1a905288475';

  function sha256Hex(str) {
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
        .then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return b.toString(16).padStart(2, '0');
          }).join('');
        });
    }
    return Promise.reject(new Error('crypto_unavailable'));
  }

  function fail(msg) {
    var err = document.getElementById('gateErr');
    if (err) err.textContent = msg || '口令不正确';
    var inp = document.getElementById('gateInput');
    if (inp) { inp.value = ''; inp.focus(); }
  }

  function unlock() {
    var gate = document.getElementById('gate');
    if (gate) { gate.style.display = 'none'; gate.setAttribute('aria-hidden', 'true'); }
  }

  function attempt() {
    var inp = document.getElementById('gateInput');
    if (!inp) return;
    var pw = inp.value;
    if (!pw) { fail('请输入口令'); return; }
    sha256Hex(pw).then(function (hex) {
      if (hex === GATE_HASH) {
        try { sessionStorage.setItem('dash_gate', '1'); } catch (e) {}
        unlock();
      } else {
        fail('口令不正确，请重试');
      }
    }).catch(function () {
      fail('当前环境不支持加密校验，请用 Chrome / Edge 打开链接');
    });
  }

  function init() {
    var host = location.hostname;
    // 本地环境（双击打开 / localhost）免口令，分享出去的域名才要求口令
    if (location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' ||
        host === '0.0.0.0' || host === '') {
      unlock();
      return;
    }
    var gate = document.getElementById('gate');
    if (!gate) return;
    var inp = document.getElementById('gateInput');
    var btn = document.getElementById('gateBtn');
    if (btn) btn.addEventListener('click', attempt);
    if (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); attempt(); }
      });
      inp.focus();
    }
    try {
      if (sessionStorage.getItem('dash_gate') === '1') unlock();
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
