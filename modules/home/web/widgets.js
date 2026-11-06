// System widgets on Home: the shared TWS connection and shortcuts to every module. Both are
// add-ons (Edit layout > Add card); the header's status pill shows the TWS state by default.
(function () {
  'use strict';
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  ODWidgets.register({
    id: 'tws', title: 'TWS connection', size: 1, order: 80, optional: true,
    async mount(box) {
      const res = await fetch('/api/broker/status');
      const s = await res.json().catch(() => null);
      const online = s && s.sidecar !== 'offline';
      const connected = online && s.ibkr === 'connected';
      const line = el('div');
      line.append(el('span', `tws-dot ${connected ? 'ok' : online ? '' : 'err'}`),
        el('strong', '', connected ? 'Connected' : online ? 'Not connected' : 'Market service offline'));
      const why = el('div', 'wd-muted', connected ? 'Read-only, shared by the whole app.'
        : (s && s.reason) || 'Use Connect in the sidebar when TWS is open.');
      why.style.marginTop = '8px';
      box.replaceChildren(line, why);
    },
  });

  ODWidgets.register({
    id: 'shortcuts', title: 'Jump to', size: 3, order: 90, optional: true,
    mount(box) {
      const groups = new Map();
      ODNav.MODULES.forEach((m) => groups.set(m.group, [...(groups.get(m.group) || []), m]));
      const wrap = el('div', 'wd-links');
      groups.forEach((mods, name) => {
        const col = el('div');
        col.append(el('h3', '', name));
        mods.flatMap((m) => m.pages.map((p) => ({ ...p, soon: !!m.soon }))).forEach((p) => {
          if (p.soon) col.append(el('span', '', `${p.label} (soon)`));
          else { const a = el('a', '', p.label); a.href = p.href; col.append(a); }
        });
        wrap.append(col);
      });
      box.replaceChildren(wrap);
    },
  });
})();
