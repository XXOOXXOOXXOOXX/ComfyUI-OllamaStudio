export async function showHistory({ node, button }) {
    const { body } = this.modal("对话历史", { footer: false });
    body.append(node("div", { class: "os-note", text: "正在读取已保存对话…" }));
    const [data, storage] = await Promise.all([this.request("/conversations"), this.request("/conversations/storage/info")]);
    if (!body.isConnected) return;
    body.replaceChildren(node("div", { class: "os-field-error", role: "alert" }));
    let conversations = data.conversations || [];
    const search = node("input", { "aria-label": "搜索对话标题", placeholder: "搜索对话标题" });
    const sort = node("select", { "aria-label": "历史对话排序" });
    for (const [value, text] of [["updated", "最近更新"], ["created", "创建时间：从新到旧"], ["oldest", "创建时间：从旧到新"], ["title", "标题 A–Z"], ["title-desc", "标题 Z–A"], ["count", "消息数量"], ["manual", "手动排序"]]) sort.append(node("option", { value, text }));
    sort.value = this.prefs.history_sort || "updated";
    const list = node("div", { class: "os-list" }), error = text => body.querySelector(".os-field-error").textContent = text;
    const ordered = () => {
        const ranks = new Map((this.prefs.history_order || []).map((id, index) => [id, index]));
        return [...conversations].sort((a, b) => {
            if (sort.value === "manual") return (ranks.get(a.id) ?? 1e9) - (ranks.get(b.id) ?? 1e9);
            if (sort.value.startsWith("title")) return a.title.localeCompare(b.title, "zh-CN", { numeric: true }) * (sort.value === "title-desc" ? -1 : 1);
            if (sort.value === "count") return b.message_count - a.message_count;
            const key = sort.value === "updated" ? "updated_at" : "created_at";
            return String(a[key]).localeCompare(String(b[key])) * (sort.value === "oldest" ? 1 : -1);
        });
    };
    const draw = () => {
        list.replaceChildren();
        for (const conversation of ordered().filter(item => item.title.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))) {
            const title = button("对话标题 " + conversation.title, conversation.title || "新对话", null, "os-history-title"); title.title = "双击重命名对话";
            const remove = button("删除对话 " + conversation.title, "删除", null), open = button("打开对话 " + conversation.title, "打开", null);
            const info = node("div", { class: "os-grow" }, title, node("div", { class: "os-description", text: `${conversation.message_count || 0} 条消息` }));
            const row = node("div", { class: "os-list-item" }, info);
            title.addEventListener("dblclick", () => {
                const field = node("input", { "aria-label": "重命名对话标题", maxlength: 120 });
                field.value = conversation.title; title.replaceWith(field); field.focus(); field.select(); let saving = false;
                const save = async () => {
                    if (saving) return; saving = true;
                    try {
                        const result = await this.request(`/conversations/${conversation.id}/rename`, this.json("POST", { title: field.value }));
                        conversation.title = result.conversation.title;
                        if (this.conversation.id === conversation.id) { this.conversation.title = conversation.title; this.title.textContent = conversation.title; }
                        error(""); draw();
                    } catch (failure) { error(failure.message); saving = false; field.focus(); }
                };
                field.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); save(); } else if (event.key === "Escape") { saving = true; draw(); } });
                field.addEventListener("blur", save);
            });
            if (sort.value === "manual") for (const [offset, label] of [[-1, "上移"], [1, "下移"]]) {
                const move = button(label + " " + conversation.title, offset < 0 ? "↑" : "↓", null);
                move.addEventListener("click", () => { const ids = ordered().map(item => item.id), index = ids.indexOf(conversation.id), target = index + offset; if (target < 0 || target >= ids.length) return; [ids[index], ids[target]] = [ids[target], ids[index]]; this.prefs.history_order = ids; this.savePrefs(); draw(); });
                row.append(move);
            }
            open.addEventListener("click", async () => { try { await this.loadConversation(conversation.id); this.closeModal(); } catch (failure) { error(failure.message); } });
            remove.addEventListener("click", async () => { try { await this.request("/conversations/" + conversation.id, { method: "DELETE" }); conversations = conversations.filter(item => item.id !== conversation.id); if (conversation.id === this.conversation.id) await this.newConversation(); draw(); } catch (failure) { error(failure.message); } });
            row.append(remove, open); list.append(row);
        }
        if (!list.children.length) list.append(node("div", { class: "os-nodata", text: conversations.length ? "没有匹配的对话" : "还没有保存的对话" }));
    };
    search.addEventListener("input", draw); sort.addEventListener("change", () => { this.prefs.history_sort = sort.value; this.savePrefs(); draw(); });
    const openStorage = button("打开历史存储位置", "打开存储位置", null), copyPath = button("复制历史存储路径", "复制路径", null);
    openStorage.addEventListener("click", async () => { openStorage.disabled = true; try { await this.request("/conversations/storage/open", { method: "POST" }); error(""); } catch (failure) { error(failure.message); } finally { openStorage.disabled = false; } });
    copyPath.addEventListener("click", () => this.copy(storage.directory, "历史存储路径已复制"));
    body.append(node("div", { class: "os-row" }, search, sort), node("div", { class: "os-note", text: "双击标题重命名，按 Enter 或移开焦点保存；点击右侧“打开”进入对话。" }), list,
        node("div", { class: "os-row" }, openStorage, copyPath), node("div", { class: "os-note os-storage-path", text: "历史数据库：" + storage.database })); draw();
}
