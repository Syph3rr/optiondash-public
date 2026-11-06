/* Screenshot gallery: upload (choose / drop / paste), lightbox, delete. */
(function (root) {
  "use strict";
  const { el, clear, modal, confirmModal, toast } = UI;

  const MAX_BYTES = 10 * 1024 * 1024;
  const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

  /** Renders into `node`; `reload` refreshes the whole trade view after a change. */
  function mount(node, view, reload) {
    const caption = el("input", { type: "text", class: "inp", placeholder: "Caption (optional)", maxlength: 300, style: { maxWidth: "320px" } });
    const file = el("input", { type: "file", accept: TYPES.join(","), class: "hidden" });
    const zone = el("div", { class: "dropzone" }, "Drop an image here, paste with Ctrl+V, or ",
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); file.click(); } }, "choose a file"), ".");

    async function upload(blob, name = "screenshot.png") {
      if (!TYPES.includes(blob.type)) return toast("Only PNG, JPEG, GIF or WebP images can be uploaded.", "err");
      if (blob.size > MAX_BYTES) return toast("That image is larger than 10 MB.", "err");
      const form = new FormData();
      form.append("file", blob, name);
      if (caption.value.trim()) form.append("caption", caption.value.trim());
      zone.textContent = "Uploading…";
      try {
        await Api.upload(`/api/journal/trades/${view.id}/screenshots`, form);
        toast("Screenshot saved.", "ok");
        await reload();
      } catch (_) {
        await reload();  // Api showed the error; redraw the zone
      }
    }

    file.addEventListener("change", () => { if (file.files[0]) upload(file.files[0], file.files[0].name); });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      const f = e.dataTransfer.files[0];
      if (f) upload(f, f.name);
    });
    root.onpaste = (e) => {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target !== caption) return;
      const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); upload(item.getAsFile(), "pasted.png"); }
    };

    const gallery = (view.screenshots || []).map((s) => {
      const src = `/journal/screenshots/${encodeURIComponent(s.filename)}`;
      return el("figure", { class: "shot", style: { margin: 0 } },
        el("img", { src, alt: s.caption || "Trade screenshot", loading: "lazy",
          onclick: () => modal({ title: s.caption || "Screenshot", body: el("div", { class: "lightbox" }, el("img", { src, alt: s.caption || "" })) }) }),
        el("figcaption", { class: "cap" }, el("span", { title: s.caption || "" }, s.caption || Fmt.dateTime(s.created_at)),
          el("button", { type: "button", class: "iconbtn del", title: "Delete screenshot", onclick: async () => {
            if (!(await confirmModal("Delete this screenshot?", { title: "Delete screenshot" }))) return;
            await Api.del(`/api/journal/screenshots/${s.id}`);
            await reload();
          } }, "✕")));
    });

    clear(node, el("div", { style: { display: "grid", gap: "10px" } },
      el("div", { class: "row" }, caption, file), zone,
      gallery.length ? el("div", { class: "shots" }, gallery) : el("div", { class: "note" }, "No screenshots yet.")));
  }

  root.Shots = { mount };
})(window);
