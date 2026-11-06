// Title page: loads on open, on Refresh and when the TWS connection changes. It never polls and
// never connects by itself. Server text only reaches textContent.
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function render(summary) {
    const tile = el('div', 'stat');
    tile.append(el('div', 'k', 'Rows'), el('div', 'v', String(summary.total)), el('div', 's', 'from the API'));
    $('#tiles').replaceChildren(tile);
    $('#body').replaceChildren(el('div', 'legend-note', summary.total ? '' : 'Nothing here yet.'));
  }

  function message(text, isError) {
    const m = $('#message');
    m.hidden = !text;
    m.textContent = text || '';
    m.className = `card mod-msg${isError ? ' err' : ''}`;
  }

  let inflight = false;
  async function load() {
    if (inflight) return;
    inflight = true;
    $('#refresh').disabled = true;
    try {
      const res = await fetch('/api/REPLACE_ME', { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        message((body && (body.error || body.message)) || `request failed (${res.status})`, true);
        render(NAME.summarise([]));
        return;
      }
      message('');
      render(NAME.summarise(body.rows));
    } catch (e) {
      message('Cannot reach OptionDash. Is it still running?', true);
    } finally {
      inflight = false;
      $('#refresh').disabled = false;
    }
  }

  $('#refresh').addEventListener('click', load);
  window.addEventListener('broker:changed', load);
  load();
})();
