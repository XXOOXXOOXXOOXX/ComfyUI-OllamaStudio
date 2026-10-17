let current;
export function openAsset(item, { url, apiURL, kind, items = [item], describe = () => ({ url, kind }) }) {
    current?.();
    const gallery = items.includes(item) ? [...items] : [item];
    let index = gallery.indexOf(item), media, model, closed = false;
    const root = document.createElement("section"); root.className = "os-asset-viewer"; root.setAttribute("role", "dialog"); root.ariaLabel = "素材放大查看";
    const head = document.createElement("header"), name = document.createElement("span"), counter = document.createElement("span"), close = document.createElement("button");
    counter.className = "os-asset-counter"; counter.setAttribute("aria-live", "polite");
    close.textContent = "×"; close.type = "button"; close.ariaLabel = "关闭素材放大查看"; head.append(name, counter, close);
    const stage = document.createElement("div"); stage.className = "os-asset-stage"; root.append(head, stage); document.body.append(root);
    const cleanup = () => { if (media) { media.pause(); media.removeAttribute("src"); media.load(); media = null; } model?.dispose(); model = null; };
    const dismiss = () => { if (closed) return; closed = true; cleanup(); root.remove(); removeEventListener("keydown", onKey, true); if (current === dismiss) current = null; };
    const move = offset => { const next = index + offset; if (next < 0 || next >= gallery.length) return; index = next; render(); };
    const onKey = event => {
        if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
        if (event.altKey || event.ctrlKey || event.metaKey || event.target.matches?.("input,textarea,select,[contenteditable=true]")) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); move(event.key === "ArrowLeft" ? -1 : 1); }
    };
    const navigation = offset => {
        const arrow = document.createElement("button"); arrow.type = "button"; arrow.className = "os-asset-nav " + (offset < 0 ? "os-asset-prev" : "os-asset-next");
        arrow.ariaLabel = arrow.title = offset < 0 ? "上一个素材" : "下一个素材"; arrow.textContent = offset < 0 ? "‹" : "›";
        arrow.disabled = offset < 0 ? index === 0 : index === gallery.length - 1; arrow.hidden = gallery.length < 2;
        arrow.addEventListener("click", () => { move(offset); stage.querySelector(offset < 0 ? ".os-asset-prev" : ".os-asset-next")?.focus(); }); return arrow;
    };
    const render = () => {
        cleanup(); stage.replaceChildren(); const selected = gallery[index], { url: selectedURL, kind: selectedKind } = describe(selected);
        name.textContent = selected.name || "素材预览"; counter.textContent = `${index + 1} / ${gallery.length}`;
        if (["image", "video", "audio"].includes(selectedKind)) {
            const visual = document.createElement(selectedKind === "image" ? "img" : selectedKind); visual.src = selectedURL;
            if (selectedKind !== "image") { media = visual; media.controls = true; media.preload = "metadata"; }
            visual.alt = selected.name || "素材"; stage.append(visual);
        } else if (selectedKind === "model" && globalThis.EagleAssetsModelPreview?.canPreviewModel(selected.ext || selected.name?.split(".").pop())) {
            const status = document.createElement("div"), viewport = document.createElement("div"); viewport.className = "os-asset-model"; status.className = "os-asset-model-status"; stage.append(viewport, status);
            const viewer = model = globalThis.EagleAssetsModelPreview.createModelPreview(viewport, { url: selected.model_url ? apiURL(selected.model_url) : selectedURL, ext: selected.ext || selected.name?.split(".").pop(), apiURL });
            viewer.ready.catch(error => { if (!closed && model === viewer) status.textContent = "模型预览不可用：" + error.message; });
        } else {
            const link = document.createElement("a"); link.href = selectedURL; link.download = selected.name || ""; link.textContent = "此文件类型请下载后查看"; stage.append(link);
        }
        stage.append(navigation(-1), navigation(1));
    };
    current = dismiss; close.addEventListener("click", dismiss); addEventListener("keydown", onKey, true);
    for (const type of ["pointerdown", "keydown", "wheel"]) root.addEventListener(type, event => event.stopPropagation());
    render(); return dismiss;
}
