import { showHistory } from "./history.js";
import {installCanvasBridge} from "./canvas_bridge.js";
import { openAsset } from "./lightbox.js?v=1.2.1";
const PREFS_KEY = "ollama-studio.ui.v1";
const TYPE_NAMES = { image: "图片", video: "视频", audio: "音频", model: "模型", text: "文档" };
const GENRES = ["都市现实", "古装言情", "悬疑推理", "科幻未来", "玄幻修仙", "文旅非遗", "职场行业", "体育竞技", "喜剧", "冒险", "家庭情感", "其他"];
const GENRE_ICONS = ["◉", "❀", "⌕", "✧", "☯", "◈", "▤", "⚑", "☺", "△", "♡", "✎"];
function node(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (key === "class") element.className = value;
        else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
        else if (key === "text") element.textContent = value;
        else if (key === "dataset") Object.assign(element.dataset, value);
        else if (value != null && value !== false) element.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) if (child != null) element.append(typeof child === "string" ? document.createTextNode(child) : child);
    return element;
}
function button(label, text, action, className = "") {
    return node("button", { type: "button", "aria-label": label, title: label, text, class: className, dataset: action ? { action } : {} });
}
function readPrefs() {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { /* recover corrupt local preferences */ }
    saved.selected_skills = [...new Set((Array.isArray(saved.selected_skills) ? saved.selected_skills : [saved.selected_skill]).filter(id => typeof id === "string" && id))];
    return { view: "floating", rect: { x: Math.max(16, innerWidth - 600), y: 30, width: 560, height: Math.min(800, innerHeight - 60) },
        dock_width: 510, host: "http://localhost:11434", model: "", selected_skill: "", favorites: [], eagle_enabled: false, image_bridge_enabled: false,
        mode: { kind: "chat" }, conversation_id: null, ...saved, rect: { width: 560, height: 760, x: Math.max(16, innerWidth - 600), y: 30, ...saved.rect } };
}
function kindOf(item) {
    if (item.kind || item.media_type) return item.kind || item.media_type;
    const ext = String(item.name || "").split(".").pop().toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].includes(ext)) return "image";
    if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
    if (["wav", "mp3", "flac", "m4a", "ogg", "aac"].includes(ext)) return "audio";
    if (["glb", "gltf", "obj", "fbx", "stl", "ply", "usdz"].includes(ext)) return "model";
    return "text";
}
function formatSize(size) { return Number(size) > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.round((size || 0) / 1024)} KB`; }
function replyTiming(message) {
    if (typeof message.elapsed_ms !== "number" || !Number.isFinite(message.elapsed_ms) || message.elapsed_ms < 0) return message.status === "generating" ? "生成中…" : "耗时未记录";
    const seconds = Math.round(message.elapsed_ms / 100) / 10;
    const minutes = Math.floor(seconds / 60), remainder = (seconds % 60).toFixed(1);
    const duration = minutes ? `${minutes} 分 ${remainder} 秒` : `${seconds.toFixed(1)} 秒`;
    const status = message.status === "cancelled" ? "已停止 · " : message.status === "error" ? "未完成 · " : message.status === "repetition" ? "重复保护 · " : message.status === "limited" ? "长度上限 · " : "";
    return `${status}耗时 ${duration}`;
}
function modelStorageSize(model) {
    const bytes = Number(model?.size);
    if (!Number.isFinite(bytes) || bytes <= 0) return "大小未知";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log10(bytes) / 3)));
    const size = `${(bytes / 1000 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
    return model.cloud ? `本地记录 ${size}` : size;
}

export class OllamaStudio {
    constructor({ app, api }) {
        this.app = app; this.api = api; this.prefs = readPrefs(); this.models = []; this.skills = []; this.uploads = []; this.imageRefs = []; this.eagleRefs = [];
        this.conversation = { messages: [], title: "新对话" }; this.chatRevision = 0; this.busy = false; this.initializing = true; this.dragDepth = 0;
        this.root = node("div", { class: "os-host", id: "ollama-studio" });
        this.panel = node("section", { class: "os-panel", role: "region", "aria-label": "Ollama 创作工作室" });
        this.header = node("header", { class: "os-header" }, this.title = node("div", { class: "os-title", text: "新对话" }));
        for (const [action, label, icon] of [["new", "新对话", "＋"], ["history", "对话历史", "◷"], ["settings", "创作设置", "☷"], ["models", "选择模型", "◇"], ["dock", "停靠右侧", "▣"], ["minimize", "缩为浮球", "−"]]) this.header.append(button(label, icon, action, "os-icon"));
        this.messages = node("div", { class: "os-messages", "aria-label": "对话消息", "aria-live": "polite" });
        this.status = node("div", { class: "os-status", role: "status" });
        this.composer = node("div", { class: "os-composer" }); this.attachments = node("div", { class: "os-attachments", "aria-label": "参考素材" });
        this.prompt = node("textarea", { class: "os-prompt", "aria-label": "输入消息", placeholder: "说说你的想法，也可以拖入图片、视频或音频…", rows: "3" });
        this.actions = node("div", { class: "os-compose-actions" });
        this.actions.append(button("添加文件", "＋", "upload", "os-icon"), this.modeButton = button("创作模式", "对话创作⌄", "mode", "os-mode-button"),
            this.modelButton = button("选择本地模型", "选择模型", "models", "os-model-button"), button("Skill 技能", "⌘", "skills", "os-icon"),
            this.eagleButton = button("开启 Eagle 素材", "E", "eagle", "os-icon os-eagle"),
            this.imageBridgeButton = button("开启图片直连素材", "Z", "image-bridge", "os-icon os-eagle"), node("div", { class: "os-spacer" }),
            this.sendButton = button("发送消息", "↑", "send", "os-send"), this.stopButton = button("停止生成", "■", "stop", "os-send os-stop"));
        this.stopButton.hidden = true;
        this.meta = node("div", { class: "os-compose-meta" }, this.skillBadge = node("span"), this.capability = node("span", { text: "连接本地 Ollama" }));
        this.activeSkill = node("div", { class: "os-active-skills", hidden: true, "aria-label": "已添加的 Skill" });
        this.composer.append(this.activeSkill, this.attachments, this.prompt, this.actions, this.meta);
        this.dropCover = node("div", { class: "os-drop-cover", text: "松开以添加参考素材" }); this.dropCover.hidden = true;
        this.resizeHandle = node("div", { class: "os-resize", "aria-label": "调整浮窗大小", title: "拖动调整大小", text: "◢" });
        this.panel.append(this.header, this.messages, this.status, this.composer, this.dropCover, this.resizeHandle);
        this.orb = button("打开 Ollama Studio", "", "open", "os-orb"); this.orb.append(node("span", { class: "os-orb-art" }));
        this.root.append(this.panel, this.orb); document.body.append(this.root);
        this.fileInput = node("input", { type: "file", multiple: true, accept: "image/*,video/*,audio/*,.glb,.gltf,.obj,.fbx,.stl,.ply,.txt,.md,.json", hidden: true }); this.root.append(this.fileInput);
        this.panel.addEventListener("click", event => { const action = event.target.closest("[data-action]")?.dataset.action; if (action) this.action(action); });
        this.orb.addEventListener("click", () => this.open());
        this.fileInput.addEventListener("change", () => { this.uploadFiles([...this.fileInput.files]); this.fileInput.value = ""; });
        this.prompt.addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); this.send(); } });
        for (const name of ["pointerdown", "keydown", "wheel"]) this.panel.addEventListener(name, event => event.stopPropagation());
        this.attachDrop(); this.attachDrag();
        this.onResize = () => this.layout(); addEventListener("resize", this.onResize);
        this.onEagle = () => this.syncEagle(); addEventListener("eagle-assets-studio-selection", this.onEagle);
        this.setView(["floating", "docked", "minimized"].includes(this.prefs.view) ? this.prefs.view : "floating");
        this.renderMessages(); this.updateControls();installCanvasBridge(this);
        this.ready = this.initialize();
    }
    async request(path, options = {}) {
        const response = await this.api.fetchApi("/ollama_studio" + path, options);
        const data = await response.json();
        if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `请求失败 (${response.status})`);
        return data;
    }
    json(method, body) { return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
    async initialize() {
        const results = await Promise.allSettled([this.refreshModels(), this.refreshPresets()]);
        for (const result of results) if (result.status === "rejected") this.showStatus(result.reason?.message || "无法读取本地服务", true);
        try {
            if (this.prefs.conversation_id) await this.loadConversation(this.prefs.conversation_id);
            else await this.newConversation();
        } catch (error) { this.showStatus(error.message, true); }
        this.syncEagle(); this.initializing = false; this.updateControls(); return this;
    }
    savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* browser quota does not stop chat */ } }
    showStatus(text = "", error = false) { this.status.textContent = text; this.status.dataset.error = String(error); }
    toast(text) {
        this.root.querySelector(".os-toast")?.remove(); const toast = node("div", { class: "os-toast", text }); this.panel.append(toast);
        setTimeout(() => toast.remove(), 2400);
    }
    clamp(rect) {
        const width = Math.min(Math.max(340, rect.width), Math.max(1, innerWidth - 16));
        const height = Math.min(Math.max(430, rect.height), Math.max(1, innerHeight - 16));
        return { width, height, x: Math.max(8, Math.min(rect.x, innerWidth - width - 8)), y: Math.max(8, Math.min(rect.y, innerHeight - height - 8)) };
    }
    layout() {
        if (this.prefs.view === "minimized") return;
        const docked = this.prefs.view === "docked";
        const rect = docked ? { x: Math.max(8, innerWidth - Math.min(this.prefs.dock_width, innerWidth - 16) - 12), y: 12,
            width: Math.min(this.prefs.dock_width, innerWidth - 24), height: innerHeight - 24 } : this.clamp(this.prefs.rect);
        Object.assign(this.panel.style, { width: rect.width + "px", height: rect.height + "px", transform: `translate3d(${rect.x}px,${rect.y}px,0)` });
        this.reserveCanvas(docked ? rect.width + 24 : 0);
    }
    reserveCanvas(width) {
        // Moving a floating panel must not resize or clear ComfyUI's canvas.
        if (!width && !this.canvasReserve) return;
        const canvas = this.app.canvas?.canvas || document.querySelector("canvas.lgraphcanvas"), container = canvas?.parentElement;
        if (!container || container === document.body || container === document.documentElement) return;
        if (width && this.canvasReserve && this.canvasReserve.container !== container) this.reserveCanvas(0);
        if (width && !this.canvasReserve) this.canvasReserve = { container, marginRight: container.style.marginRight, width: container.style.width, boxSizing: container.style.boxSizing };
        const previous = this.canvasReserve;
        if (!width && previous) {
            if (previous.container.style.marginRight === previous.appliedMargin) previous.container.style.marginRight = previous.marginRight;
            if (previous.container.style.width === previous.appliedWidth) previous.container.style.width = previous.width;
            if (previous.container.style.boxSizing === "border-box") previous.container.style.boxSizing = previous.boxSizing;
            this.canvasReserve = null;
        } else if (width && previous) {
            container.style.marginRight = `calc(${previous.marginRight || "0px"} + ${width}px)`;
            container.style.width = `calc(${previous.width || "100%"} - ${width}px)`; container.style.boxSizing = "border-box";
            previous.appliedMargin = container.style.marginRight; previous.appliedWidth = container.style.width;
        }
        this.app.canvas?.resize?.();
        this.app.canvas?.setDirty?.(true, true);
        this.app.graph?.setDirtyCanvas?.(true, true);
    }
    setView(view) {
        if (view === "minimized" && this.prefs.view !== "minimized") this.prefs.previous_view = this.prefs.view;
        this.prefs.view = view; this.panel.dataset.view = view; this.panel.hidden = view === "minimized"; this.orb.hidden = view !== "minimized";
        if (view === "minimized") this.reserveCanvas(0); else this.layout();
        const dock = this.panel.querySelector('[data-action="dock"]'); dock.title = dock.ariaLabel = view === "docked" ? "恢复浮动" : "停靠右侧";
        this.savePrefs();
    }
    open() { this.setView(this.prefs.previous_view === "docked" ? "docked" : "floating"); this.prompt.focus(); }
    close() { this.setView("minimized"); }
    attachDrag() {
        this.header.addEventListener("pointerdown", event => {
            if (event.button !== 0 || event.target.closest("button") || this.prefs.view !== "floating") return;
            event.preventDefault(); const start = { ...this.clamp(this.prefs.rect), pointerX: event.clientX, pointerY: event.clientY };
            this.header.setPointerCapture(event.pointerId);
            const move = moveEvent => { this.prefs.rect = this.clamp({ ...start, x: start.x + moveEvent.clientX - start.pointerX, y: start.y + moveEvent.clientY - start.pointerY }); this.layout(); };
            const end = () => { this.header.removeEventListener("pointermove", move); this.header.removeEventListener("pointerup", end); this.header.removeEventListener("pointercancel", end); this.savePrefs(); };
            this.header.addEventListener("pointermove", move); this.header.addEventListener("pointerup", end); this.header.addEventListener("pointercancel", end);
        });
        this.resizeHandle.addEventListener("pointerdown", event => {
            if (event.button !== 0) return; event.preventDefault(); const box = this.panel.getBoundingClientRect(), start = { x: event.clientX, y: event.clientY, width: box.width, height: box.height };
            this.resizeHandle.setPointerCapture(event.pointerId);
            const move = e => { if (this.prefs.view === "docked") this.prefs.dock_width = Math.max(340, Math.min(innerWidth - 24, start.width - (e.clientX - start.x)));
                else this.prefs.rect = this.clamp({ ...this.prefs.rect, width: start.width + e.clientX - start.x, height: start.height + e.clientY - start.y }); this.layout(); };
            const end = () => { this.resizeHandle.removeEventListener("pointermove", move); this.resizeHandle.removeEventListener("pointerup", end); this.resizeHandle.removeEventListener("pointercancel", end); this.savePrefs(); };
            this.resizeHandle.addEventListener("pointermove", move); this.resizeHandle.addEventListener("pointerup", end); this.resizeHandle.addEventListener("pointercancel", end);
        });
    }
    attachDrop() {
        const isFiles = event => [...(event.dataTransfer?.types || [])].includes("Files");
        this.panel.addEventListener("dragenter", event => { if (!isFiles(event)) return; event.preventDefault(); event.stopPropagation(); this.dragDepth++; this.dropCover.hidden = false; });
        this.panel.addEventListener("dragover", event => { if (!isFiles(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; });
        this.panel.addEventListener("dragleave", event => { if (!isFiles(event)) return; this.dragDepth = Math.max(0, this.dragDepth - 1); if (!this.dragDepth) this.dropCover.hidden = true; });
        this.panel.addEventListener("drop", event => { if (!isFiles(event)) return; event.preventDefault(); event.stopPropagation(); this.dragDepth = 0; this.dropCover.hidden = true; this.uploadFiles([...event.dataTransfer.files]); });
    }
    async action(action) {
        try {
            if (action === "new") return await this.newConversation();
            if (action === "history") return await this.historyDialog();
            if (action === "settings") return this.prefs.mode.kind === "director" ? this.directorDialog() : this.scriptDialog(this.prefs.mode.branch || "original");
            if (action === "dock") return this.setView(this.prefs.view === "docked" ? "floating" : "docked");
            if (action === "minimize") return this.close();
            if (action === "models") return this.modelDialog();
            if (action === "skills") return await this.skillsDialog();
            if (action === "mode") return this.modeDialog();
            if (action === "upload") return this.fileInput.click();
            if (action === "eagle") { this.prefs.eagle_enabled = !this.prefs.eagle_enabled; this.savePrefs(); this.syncEagle(); return this.updateControls(); }
            if (action === "image-bridge") { this.prefs.image_bridge_enabled = !this.prefs.image_bridge_enabled; this.savePrefs(); this.syncEagle(); return this.updateControls(); }
            if (action === "send") return await this.send();
            if (action === "stop") return this.stop();
        } catch (error) { this.showStatus(error.message, true); }
    }
    async refreshModels() {
        const host = this.prefs.host, revision = (this.modelRevision || 0) + 1; this.modelRevision = revision;
        this.showStatus("正在读取已安装的 Ollama 模型…");
        const data = await this.request("/models", this.json("POST", { host }));
        if (revision !== this.modelRevision || host !== this.prefs.host) return data;
        this.models = data.models || [];
        if (!this.models.some(model => model.name === this.prefs.model)) this.prefs.model = this.models.find(model => model.name === data.default_model && !model.cloud)?.name
            || this.models.find(model => model.name === "qwen3-vl:4b" && !model.cloud)?.name || this.models.find(model => !model.cloud)?.name || "";
        this.savePrefs(); this.showStatus(this.models.length ? `已读取 ${this.models.length} 个模型` : "Ollama 中没有可选的已安装模型"); this.updateControls(); return data;
    }
    async refreshPresets() {
        const data = await this.request("/presets"); this.presets = data; this.skills = data.skills || [];
        this.prefs.selected_skills = this.prefs.selected_skills.filter(id => this.skills.some(skill => skill.id === id));
        this.prefs.selected_skill = this.prefs.selected_skills[0] || ""; this.savePrefs();
        this.updateControls(); return data;
    }
    setSkills(ids) {
        this.prefs.selected_skills = [...new Set(ids)].filter(id => this.skills.some(skill => skill.id === id)).slice(0, 32);
        this.prefs.selected_skill = this.prefs.selected_skills[0] || "";
        this.savePrefs(); this.updateControls();
    }
    addSkill(id) { this.setSkills([...this.prefs.selected_skills, id]); }
    updateControls() {
        const names = { chat: "对话创作", script: this.prefs.mode.branch === "adapt" ? "剧本创编·改编" : "剧本创编·原创", director: "导演执导" };
        this.modeButton.textContent = (names[this.prefs.mode.kind] || "对话创作") + "⌄";
        const model = this.models.find(item => item.name === this.prefs.model);
        this.modelButton.textContent = model ? `${model.name} · ${modelStorageSize(model)}` : this.prefs.model || "选择模型";
        this.modelButton.title = model ? `${model.name} · ${modelStorageSize(model)}` : "选择本地模型";
        this.capability.textContent = model ? `${model.cloud ? "云端模型" : "本地模型"}${model.vision ? " · 可理解视觉素材" : " · 文本能力"}` : "选择已安装模型";
        const skills = this.prefs.selected_skills.map(id => this.skills.find(item => item.id === id)).filter(Boolean);
        this.skillBadge.textContent = skills.length ? `已添加 ${skills.length} 个 Skill` : "Ctrl + Enter 发送";
        this.panel.querySelector('[data-action="skills"]').dataset.on = String(!!skills.length);
        this.activeSkill.hidden = !skills.length; this.activeSkill.replaceChildren();
        for (const skill of skills) {
            const remove = button("移除 Skill " + skill.name, "×", null, "os-remove");
            remove.addEventListener("click", () => this.setSkills(this.prefs.selected_skills.filter(id => id !== skill.id)));
            this.activeSkill.append(node("div", { class: "os-active-skill", dataset: { skillId: skill.id } }, node("span", { text: "Skill · " + skill.name }), remove));
        }
        this.eagleButton.dataset.on = String(!!this.prefs.eagle_enabled); this.eagleButton.title = this.eagleButton.ariaLabel = this.prefs.eagle_enabled ? "关闭 Eagle 素材" : "开启 Eagle 素材";
        this.imageBridgeButton.dataset.on = String(!!this.prefs.image_bridge_enabled); this.imageBridgeButton.title = this.imageBridgeButton.ariaLabel = this.prefs.image_bridge_enabled ? "关闭图片直连素材" : "开启图片直连素材";
        this.sendButton.hidden = this.busy; this.stopButton.hidden = !this.busy;
        this.sendButton.disabled = this.busy || this.initializing || this.canvasPending || !this.prefs.model || this.uploads.some(item => item.pending);
        this.prompt.disabled = this.busy;
    }
    async newConversation() {
        this.stop(); ++this.chatRevision;
        const data = await this.request("/conversations", this.json("POST", { title: "新对话" })); this.conversation = data.conversation;
        this.prefs.conversation_id = this.conversation.id; this.uploads = []; this.manualTranscript = ""; this.transcripts = {};
        this.savePrefs(); this.renderMessages(); this.renderAttachments(); this.updateControls(); this.prompt.focus();
    }
    async loadConversation(id) {
        this.stop(); ++this.chatRevision; const revision = this.chatRevision;
        const data = await this.request("/conversations/" + encodeURIComponent(id)); if (revision !== this.chatRevision) return;
        this.conversation = data.conversation; this.prefs.conversation_id = id;
        const lastUser = [...(this.conversation.messages || [])].reverse().find(message => message.role === "user");
        if (["chat", "script", "director"].includes(lastUser?.mode?.kind)) this.prefs.mode = structuredClone(lastUser.mode);
        if (lastUser && (Object.hasOwn(lastUser, "skill_ids") || Object.hasOwn(lastUser, "skill_id")))
            this.setSkills(Array.isArray(lastUser.skill_ids) ? lastUser.skill_ids : lastUser.skill_id ? [lastUser.skill_id] : []);
        if (lastUser?.model && this.models.some(model => model.name === lastUser.model)) this.prefs.model = lastUser.model;
        this.uploads = []; this.manualTranscript = ""; this.transcripts = {}; this.savePrefs(); this.renderMessages(); this.renderAttachments(); this.updateControls();
    }
    renderMessages() {
        this.messages.replaceChildren(); this.title.textContent = this.conversation.title || "新对话";
        if (!(this.conversation.messages || []).length) {
            const welcome = node("div", { class: "os-welcome" }, node("div", { class: "os-orb-art" }), node("h2", { text: "让 Ollama 辅助你的无限创意" }));
            for (const [icon, text, callback] of [["⌁", "从 Eagle 选中素材开始创作", () => { this.prefs.eagle_enabled = true; this.syncEagle(); this.savePrefs(); this.updateControls(); }],
                ["▤", "设置原创剧本", () => this.scriptDialog("original")], ["✎", "上传故事来改编", () => this.scriptDialog("adapt")], ["✧", "进入专业导演模式", () => this.directorDialog()]]) {
                const start = button(text, "", null, "os-start"); start.append(node("span", { text: icon }), node("span", { text }), node("span", { text: "→" })); start.addEventListener("click", callback); welcome.append(start);
            }
            this.messages.append(welcome); return;
        }
        for (const message of this.conversation.messages) this.messages.append(this.messageElement(message)); this.messages.scrollTop = this.messages.scrollHeight;
    }
    messageElement(message) {
        const card = node("article", { class: "os-message", dataset: { role: message.role, messageId: message.id || "" } });
        const head = node("div", { class: "os-message-head" }, node("span", { text: message.role === "user" ? "你" : "Ollama" }));
        if (message.role !== "user") { const copy = button("复制回复", "复制", null); copy.addEventListener("click", () => this.copy(message.content || "")); head.append(node("span", { class: "os-elapsed", text: replyTiming(message), title: "从发送问题到本条回复结束的时间" }), copy); }
        const thinking = node("details", { class: "os-thinking" }, node("summary", { text: "思考过程" }), node("pre", { text: message.thinking || "" })); thinking.hidden = !message.thinking;
        card.append(head, thinking, node("div", { class: "os-text", text: message.content || "" }));
        for (const warning of message.warnings || []) card.append(node("div", { class: "os-warning", text: warning }));
        if (message.attachments?.length) { const attached = node("div"); for (const item of message.attachments) { const chip = node("span", { class: "os-inline-asset", text: item.name || item.item_id || item.kind || "素材", title: "双击放大查看素材" }); chip.addEventListener("dblclick", () => this.openAsset(item, message.attachments)); attached.append(chip); } card.append(attached); }
        return card;
    }
    async copy(text, success = "已复制回复") {
        try { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text); else { const field = node("textarea"); field.value = text; document.body.append(field); field.select(); const copied = document.execCommand("copy"); field.remove(); if (!copied) throw new Error("Copy failed"); } this.toast(success); return true; }
        catch { this.toast("复制未成功，请手动选择文字复制"); return false; }
    }
    mediaURL(item) {
        if (["video", "audio"].includes(kindOf(item))) {
            if (item.media_url) return this.api.apiURL(item.media_url);
            if (item.id) return this.api.apiURL("/ollama_studio/media/" + encodeURIComponent(item.id));
        }
        if (item.preview && typeof item.preview === "object") return this.api.apiURL("/view?" + new URLSearchParams(item.preview));
        return item.preview_url ? this.api.apiURL(item.preview_url) : item.media_url ? this.api.apiURL(item.media_url) : item.id ? this.api.apiURL("/ollama_studio/media/" + encodeURIComponent(item.id)) : "";
    }
    openAsset(item, gallery = [...this.uploads, ...this.imageRefs, ...(this.prefs.eagle_enabled ? this.eagleRefs : [])]) {
        this.closeAsset?.();
        const describe = value => ({ kind: kindOf(value), url: value.media_url ? this.api.apiURL(value.media_url) : this.mediaURL(value) });
        const items = gallery.filter(value => !value.pending && !value.error && describe(value).url);
        this.closeAsset = openAsset(item, { ...describe(item), items, describe, apiURL: url => this.api.apiURL(url) });
    }
    renderAttachments() {
        this.attachments.querySelectorAll("audio,video").forEach(player => player.pause()); this.attachments.replaceChildren();
        for (const [source, items] of [["上传", this.uploads], ["无限画布", this.canvasRefs||[]], ["图片直连", this.imageRefs], ["Eagle", this.prefs.eagle_enabled ? this.eagleRefs : []]]) for (const item of items) {
            const kind = kindOf(item), card = node("div", { class: "os-attachment", dataset: { source, id: item.id || item.item_id || item.local_id, kind } });
            card.title = "双击放大查看素材";
            card.addEventListener("dblclick", event => { if (event.target.closest(".os-remove")) return; event.preventDefault(); event.stopPropagation(); card.querySelectorAll("audio,video").forEach(media => media.pause()); this.openAsset(item); }, true);
            const url = this.mediaURL(item); if (url && ["image", "video", "audio"].includes(kind)) {
                const media = node(kind === "image" ? "img" : kind, { src: url, alt: item.name || "", loading: kind === "image" ? "lazy" : null, controls: kind !== "image", preload: kind !== "image" ? "none" : null }); card.append(media);
                if (kind === "video" && item.preview) media.poster = this.api.apiURL("/view?" + new URLSearchParams(item.preview));
            } else card.append(node("div", { text: { image: "▧", video: "▶", audio: "♫", model: "3D", text: "▤" }[kind] || "▤", style: "height:56px;display:grid;place-items:center;font-size:23px" }));
            card.append(node("div", { class: "os-attachment-name", text: item.name || item.item_id || "素材", title: item.name || "" }), node("div", { class: "os-attachment-source", text: `${source} · ${TYPE_NAMES[kind] || "文件"}${item.error ? " · 失败" : ""}` }));
            if (source === "上传") { const remove = button("移除 " + (item.name || "附件"), "×", null, "os-remove"); remove.addEventListener("click", () => { this.uploads = this.uploads.filter(current => current !== item); this.renderAttachments(); this.updateControls(); }); card.append(remove); }
            if (item.pending) { const progress = node("div", { class: "os-upload-progress" }, node("span", { style: `width:${item.progress || 0}%` })); card.append(progress); }
            this.attachments.append(card);
        }
    }
    syncEagle() {
        try { const refs = this.prefs.image_bridge_enabled ? globalThis.EagleAssetsStudioBridge?.getImageSelection?.() || [] : []; this.imageRefs = Array.isArray(refs) ? refs : []; }
        catch { this.imageRefs = []; }
        if (!this.prefs.eagle_enabled) { this.eagleRefs = []; this.renderAttachments(); return; }
        try { const refs = globalThis.EagleAssetsStudioBridge?.getSelection?.() || []; this.eagleRefs = Array.isArray(refs) ? refs : []; }
        catch { this.eagleRefs = []; }
        this.renderAttachments(); if (!globalThis.EagleAssetsStudioBridge) this.showStatus("Eagle 素材桥尚未加载。请安装新版 EagleAssets 并连接素材桥节点。");
    }
    async uploadFiles(files) {
        const pending = files.map(file => ({ file, name: file.name, kind: kindOf({ name: file.name }), local_id: crypto.randomUUID?.() || String(Math.random()), pending: true, progress: 0 }));
        this.uploads.push(...pending); this.renderAttachments(); this.updateControls();
        for (const item of pending) {
            if (!this.uploads.includes(item)) continue;
            try {
                const form = new FormData(); form.append("files", item.file, item.file.name);
                const data = await this.uploadWithProgress(form, percent => { item.progress = percent; const card = [...this.attachments.children].find(card => card.dataset.id === item.local_id); const bar = card?.querySelector(".os-upload-progress span"); if (bar) bar.style.width = percent + "%"; });
                if (!this.uploads.includes(item)) continue;
                const attachment = data.attachments?.[0]; if (!attachment?.id) throw new Error("服务器未返回附件编号");
                Object.assign(item, attachment, { pending: false }); delete item.file; item.progress = 100;
            } catch (error) { item.pending = false; item.error = error.message; this.showStatus(`${item.name} 上传失败：${error.message}`, true); }
            this.renderAttachments(); this.updateControls();
        }
    }
    uploadWithProgress(form, progress) {
        return new Promise((resolve, reject) => {
            const request = new XMLHttpRequest(); request.open("POST", this.api.apiURL("/ollama_studio/upload")); request.withCredentials = true;
            request.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
            request.onerror = () => reject(new Error("无法连接上传服务")); request.onabort = () => reject(new Error("上传已取消"));
            request.onload = () => { try { const data = JSON.parse(request.responseText); if (request.status < 200 || request.status >= 300 || data.ok === false) throw new Error(data.error || "上传失败"); resolve(data); } catch (error) { reject(error); } };
            request.send(form);
        });
    }
    async send() {
        if (this.busy || this.canvasPending || this.uploads.some(item => item.pending)) return;
        const startedAt = performance.now();
        this.syncEagle();
        const text = this.prompt.value.trim(), uploads = [...this.uploads,...this.canvasRefs||[]].filter(item => item.id && !item.error), images = [...this.imageRefs], refs = this.prefs.eagle_enabled ? [...this.eagleRefs] : [];
        if (!text && !uploads.length && !images.length && !refs.length) return;
        if (!this.prefs.model) { this.showStatus("请先选择已安装的 Ollama 模型。", true); return; }
        if (!this.conversation.id) await this.newConversation();
        const revision = ++this.chatRevision;
        const user = { id: "local-user-" + revision, role: "user", content: text, attachments: [...uploads, ...images, ...refs] };
        const assistant = { id: "local-assistant-" + revision, role: "assistant", content: "", thinking: "", warnings: [], status: "generating" };
        this.conversation.messages.push(user, assistant); this.renderMessages(); const card = this.messages.lastElementChild; card.classList.add("os-live");
        this.prompt.value = ""; this.busy = true; this.updateControls(); this.showStatus("正在生成…"); this.abortController = new AbortController();
        let completed = false;
        let timingMessage = null, elapsedMs = null;
        try {
            const body = { conversation_id: this.conversation.id, host: this.prefs.host, model: this.prefs.model, text, mode: this.prefs.mode,
                skill_ids: [...this.prefs.selected_skills], upload_ids: uploads.map(item => item.id),
                image_refs: images.map(item => ({ snapshot_id: item.snapshot_id, item_id: item.item_id })),
                eagle_refs: refs.map(item => ({ item_id: item.item_id, ...(item.snapshot_id ? { snapshot_id: item.snapshot_id } : { catalog_id: item.catalog_id }) })),
                transcripts: this.transcripts || {}, manual_transcript: this.manualTranscript || "", asr_model_path: this.asrModelPath || "" };
            const response = await this.api.fetchApi("/ollama_studio/chat", { ...this.json("POST", body), signal: this.abortController.signal });
            if (!response.ok) { let error; try { error = await response.json(); } catch { error = {}; } throw new Error(error.error || error.message || `模型请求失败 (${response.status})`); }
            if (!response.body?.getReader) throw new Error("当前浏览器无法读取流式回复");
            const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
            const consume = line => {
                if (!line.trim() || revision !== this.chatRevision) return;
                let event; try { event = JSON.parse(line); } catch { throw new Error("模型返回的流式数据格式无效"); }
                const follow = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 100;
                if (event.type === "token") { assistant.content += event.content || ""; card.querySelector(".os-text").textContent = assistant.content; }
                else if (event.type === "thinking") { assistant.thinking += event.content || ""; const details = card.querySelector(".os-thinking"); details.hidden = false; details.querySelector("pre").textContent = assistant.thinking; }
                else if (event.type === "warning") { const warning = event.content || "素材能力提示"; assistant.warnings.push(warning); card.append(node("div", { class: "os-warning", text: warning })); }
                else if (event.type === "error") throw new Error(event.message || "模型生成失败");
                else if (event.type === "done") {
                    completed = true;
                    elapsedMs = Math.round(performance.now() - startedAt);
                    if (event.conversation) {
                        this.conversation = event.conversation;
                        const saved = [...(this.conversation.messages || [])].reverse().find(message => message.role === "assistant");
                        if (saved && !saved.warnings?.length) saved.warnings = assistant.warnings;
                        timingMessage = saved;
                    } else if (event.message) Object.assign(assistant, event.message, { warnings: event.message.warnings || assistant.warnings });
                    timingMessage ||= assistant;
                    timingMessage.elapsed_ms = elapsedMs;
                    timingMessage.status ||= "complete";
                }
                if (follow) this.messages.scrollTop = this.messages.scrollHeight;
            };
            while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop(); for (const line of lines) consume(line); }
            buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
            if (revision !== this.chatRevision) return;
            if (!completed) throw new Error("连接提前结束，回复已保留；可重试或检查 Ollama。 ");
            this.prefs.conversation_id = this.conversation.id; this.savePrefs(); this.uploads = []; this.showStatus(timingMessage?.status === "repetition" ? "已停止重复输出，已保留有效内容" : timingMessage?.status === "limited" ? "已达到输出长度上限，可发送“继续”" : "回复完成"); this.title.textContent = this.conversation.title || "对话";
            if (this.conversation.messages) this.renderMessages(); this.renderAttachments();
            if (timingMessage?.id && !timingMessage.id.startsWith("local-")) {
                try { await this.request(`/conversations/${encodeURIComponent(this.conversation.id)}/messages/${encodeURIComponent(timingMessage.id)}/timing`, this.json("POST", { elapsed_ms: elapsedMs })); }
                catch { /* The server also persists a fallback duration if the client timing cannot be saved. */ }
            }
        } catch (error) {
            if (revision !== this.chatRevision) return;
            assistant.elapsed_ms = Math.round(performance.now() - startedAt);
            assistant.status = error.name === "AbortError" ? "cancelled" : "error";
            card.querySelector(".os-elapsed").textContent = replyTiming(assistant);
            if (error.name === "AbortError") this.showStatus("已停止生成"); else { this.showStatus(error.message, true); card.append(node("div", { class: "os-warning", text: error.message })); }
        } finally { card.classList.remove("os-live"); if (revision === this.chatRevision) { this.busy = false; this.abortController = null; this.updateControls(); this.prompt.focus(); } }
    }
    stop() {
        if (this.abortController) {
            const controller = this.abortController; this.abortController = null; controller.abort(); this.showStatus("已停止生成");
            this.messages.querySelectorAll(".os-live").forEach(message => message.classList.remove("os-live"));
        }
        this.busy = false; this.updateControls();
    }
    modal(title, { confirm = "确认", onConfirm, footer = true } = {}) {
        this.closeModal(); this.modalLastFocus = document.activeElement;
        const cover = node("div", { class: "os-modal-cover" }); const modal = node("section", { class: "os-modal", role: "dialog", "aria-modal": "true", "aria-label": title });
        const close = button("关闭 " + title, "×", null, "os-icon"); close.addEventListener("click", () => this.closeModal());
        const body = node("div", { class: "os-modal-body" }), foot = node("div", { class: "os-modal-foot" });
        modal.append(node("div", { class: "os-modal-head" }, node("div", { class: "os-modal-title", text: title }), close), body); cover.append(modal); this.root.append(cover); this.modalCover = cover;
        if (footer) {
            const cancel = button("取消", "取消", null), ok = button(confirm, confirm, null, "os-primary"); cancel.addEventListener("click", () => this.closeModal());
            ok.addEventListener("click", async () => { ok.disabled = true; try { await onConfirm?.(); } catch (error) { if (body.isConnected) body.querySelector(".os-field-error").textContent = error.message; } finally { ok.disabled = ok.dataset.on === "true"; } });
            foot.append(cancel, ok); modal.append(foot);
        }
        body.append(node("div", { class: "os-field-error", role: "alert" }));
        cover.addEventListener("click", event => { if (event.target === cover) this.closeModal(); });
        cover.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") { this.closeModal(); return; }
            if (event.key === "Tab") {
                const fields = [...modal.querySelectorAll("button,input,select,textarea,a[href],[tabindex]")].filter(field => !field.disabled && field.getClientRects().length);
                const first = fields[0], last = fields.at(-1);
                if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
            }
        }); close.focus();
        return { body, foot, modal };
    }
    closeModal() { this.modalCover?.remove(); this.modalCover = null; if (this.modalLastFocus?.isConnected) this.modalLastFocus.focus(); this.modalLastFocus = null; }
    modeDialog() {
        const { body } = this.modal("创作模式", { footer: false }); const choices = node("div", { class: "os-list" });
        const chat = button("对话创作", "", null); chat.dataset.modeGroup = "chat";
        chat.append(node("b", { text: "对话创作" }), node("div", { class: "os-note", text: "通用问答、素材分析与创意讨论" }));
        chat.addEventListener("click", () => { this.prefs.mode = { kind: "chat" }; this.savePrefs(); this.updateControls(); this.closeModal(); });
        const script = node("section", { class: "os-mode-group", dataset: { modeGroup: "script" }, "aria-label": "剧本创编" },
            node("h3", { text: "剧本创编" }), node("div", { class: "os-note", text: "选择原创，或基于已有故事进行改编" }));
        const branches = node("div", { class: "os-branch" });
        for (const [branch, title, description] of [["original", "剧本原创", "从题材、角色与结构开始"], ["adapt", "故事改编", "保留原作核心，重新设计视听表达"]]) {
            const choice = button(title, "", null); choice.append(node("b", { text: title }), node("span", { class: "os-note", text: description }));
            choice.addEventListener("click", () => this.scriptDialog(branch)); branches.append(choice);
        }
        script.append(branches);
        const director = button("专业导演执导", "", null); director.dataset.modeGroup = "director";
        director.append(node("b", { text: "导演执导" }), node("div", { class: "os-note", text: "镜头语言、表演、调度与制作建议" }));
        director.addEventListener("click", () => this.directorDialog()); choices.append(chat, script, director);
        body.append(choices);
    }
    branchDialog() {
        const { body } = this.modal("选择剧本创作方式", { footer: false }), choices = node("div", { class: "os-branch" });
        for (const [branch, title, description] of [["original", "剧本原创", "从题材、角色与结构开始"], ["adapt", "故事改编", "保留原作核心，并重新设计视听表达"]]) { const choice = button(title, "", null); choice.append(node("b", { text: title }), node("span", { class: "os-note", text: description })); choice.addEventListener("click", () => this.scriptDialog(branch)); choices.append(choice); }
        body.append(choices);
    }
    scriptDialog(branch = "original") {
        const draft = { kind: "script", branch, genres: [], audience: "", characters: "", era: "", focus: "", visual_style: "", structure: "", adaptation_notes: "", ...(this.prefs.mode.kind === "script" ? structuredClone(this.prefs.mode) : {}), branch };
        const fields = {}, { body } = this.modal("剧本设定器", { onConfirm: () => { for (const [key, field] of Object.entries(fields)) draft[key] = field.value; if (!draft.genres.length) throw new Error("请选择一种或两种融合题材。"); this.prefs.mode = draft; this.savePrefs(); this.updateControls(); this.closeModal(); } });
        body.append(node("div", { class: "os-note", text: `${branch === "adapt" ? "故事改编" : "剧本原创"} · 可选择一种题材，或点击第二种进行融合` }));
        const genres = node("div", { class: "os-genres" }); const refresh = () => [...genres.children].forEach(item => item.dataset.selected = String(draft.genres.includes(item.dataset.genre)));
        for (const [index, genre] of GENRES.entries()) { const item = button(genre, "", null); item.dataset.genre = genre; item.append(node("span", { class: "os-genre-icon", text: GENRE_ICONS[index] }), genre); item.addEventListener("click", () => { if (draft.genres.includes(genre)) draft.genres = draft.genres.filter(value => value !== genre); else if (draft.genres.length < 2) draft.genres.push(genre); else this.toast("最多融合两种题材，先取消一种再选择。"); refresh(); }); genres.append(item); }
        refresh(); body.append(genres); const grid = node("div", { class: "os-fields" });
        for (const [key, label, placeholder] of [["audience", "目标受众", "如：青年观众、家庭观众"], ["characters", "角色设定", "主角、关系与人物弧光"], ["era", "时代背景", "现代、古代或架空"], ["focus", "核心看点", "冲突、主题与独特设定"], ["visual_style", "画风", "写实、东方美学、动画等"], ["structure", "剧本结构", "如：三幕式、12集，每集5分钟"]]) {
            const field = node("input", { "aria-label": label, placeholder }); field.value = draft[key] || ""; fields[key] = field; grid.append(node("label", {}, node("span", { class: "os-label", text: label }), field));
        }
        body.append(grid);
        if (branch === "adapt") { const text = node("textarea", { "aria-label": "改编说明", placeholder: "原故事、要保留的核心以及期望修改的方向，也可将故事作为附件上传。" }); text.value = draft.adaptation_notes || ""; fields.adaptation_notes = text; body.append(node("label", { style: "display:block;margin-top:15px" }, node("span", { class: "os-label", text: "改编说明" }), text)); }
        const preset = button("显示创作参考预设", "显示创作参考预设", null); const examples = node("div", { class: "os-note", text: "参考结构：三幕式短片、单集悬念式、角色成长线。这里只提供创作模板，不代表市场爆款或真实热度。" }); examples.hidden = true; preset.addEventListener("click", () => { examples.hidden = !examples.hidden; }); body.append(node("div", { class: "os-row" }, preset), examples);
    }
    directorDialog() {
        const current = this.prefs.mode.kind === "director" ? this.prefs.mode : {}, fields = {};
        const { body } = this.modal("专业导演执导", { onConfirm: () => { this.prefs.mode = { kind: "director", shot_style: fields.shot_style.value, focus: fields.focus.value, visual_style: fields.visual_style.value }; this.savePrefs(); this.updateControls(); this.closeModal(); } });
        body.append(node("div", { class: "os-note", text: "以专业导演的视角讨论叙事、镜头、调度、表演、声音与可执行的制作方案。" }));
        for (const [key, label, placeholder] of [["shot_style", "镜头与执导风格", "如：自然光、长镜头、克制的运动与纪实表演"], ["focus", "导演关注重点", "叙事节奏、人物动机、动作调度等"], ["visual_style", "视听风格", "色彩、光线、构图、音乐及声音设计"]]) { const field = node("textarea", { "aria-label": label, placeholder }); field.value = current[key] || ""; fields[key] = field; body.append(node("label", { style: "display:block;margin:12px 0" }, node("span", { class: "os-label", text: label }), field)); }
    }
    modelDialog() {
        const { body } = this.modal("模型与本地连接", { footer: false }); const host = node("input", { "aria-label": "Ollama 地址", placeholder: "http://localhost:11434" }); host.value = this.prefs.host;
        const refresh = button("刷新模型列表", "刷新模型", null); const list = node("div", { class: "os-list" });
        const draw = () => { list.replaceChildren(); for (const model of this.models) { const item = button("使用模型 " + model.name, "", null); item.title = `${model.name} · ${modelStorageSize(model)}`; item.append(node("b", { text: `${model.name} · ${modelStorageSize(model)}` }), node("span", { class: "os-model-chip", text: `${model.cloud ? "云端" : "本地"} · ${model.vision ? "视觉" : "文本"}` })); item.dataset.selected = String(model.name === this.prefs.model); item.addEventListener("click", () => { this.prefs.model = model.name; this.savePrefs(); this.updateControls(); this.closeModal(); }); list.append(item); } if (!this.models.length) list.append(node("div", { class: "os-nodata", text: "没有可用的已安装模型" })); };
        refresh.addEventListener("click", async () => { refresh.disabled = true; try { this.prefs.host = host.value.trim(); await this.refreshModels(); draw(); } catch (error) { body.querySelector(".os-field-error").textContent = error.message; } finally { refresh.disabled = false; } });
        body.append(node("div", { class: "os-row" }, host, refresh), node("div", { class: "os-note", text: "仅显示 Ollama 中已有模型，不自动下载。带云端标记的模型会调用对应云服务；初次选择优先使用本地模型。" }), node("div", { class: "os-note", text: "名称后显示实际存储大小（1 GB = 10亿字节）。实际显存占用还受上下文等设置影响；云端项仅显示本地记录大小。" }), list); draw();
        const details = node("details", { class: "os-asr-details" }, node("summary", { text: "音频转录设置" }));
        const directory = node("input", { "aria-label": "本地 Whisper 模型目录", placeholder: "已在服务器配置的本地 Whisper 模型目录" }); directory.value = this.asrModelPath || ""; directory.addEventListener("input", () => this.asrModelPath = directory.value.trim());
        const transcript = node("textarea", { "aria-label": "手动音频转录", placeholder: "模型未提供原生音频能力时，可在这里粘贴音频转录文字。" }); transcript.value = this.manualTranscript || ""; transcript.addEventListener("input", () => this.manualTranscript = transcript.value);
        details.append(node("p", { class: "os-note", text: this.presets?.asr?.configured ? "服务器已配置本地转录。目录应与服务器配置一致，不会自动下载模型。" : "未配置本地转录时，音频仅作为素材记录；粘贴转录文字后模型可基于文字理解。原生视觉能力不等于能听音频。" }), directory, transcript); body.append(details);
    }
    async historyDialog() { return showHistory.call(this, { node, button }); }
    async skillsDialog(tab = "general", searchValue = "") {
        const { body } = this.modal("Skill 技能", { footer: false }); body.append(node("div", { class: "os-note", text: "正在读取技能…" }));
        try { await this.refreshPresets(); } catch (error) { if (body.isConnected) body.querySelector(".os-field-error").textContent = error.message; return; }
        if (!body.isConnected) return; body.replaceChildren(node("div", { class: "os-field-error", role: "alert" }));
        const tabs = node("div", { class: "os-tabs" }); for (const [key, title] of [["general", "通用"], ["favorites", "收藏"], ["mine", "我的"]]) { const item = button(title, title, null); item.dataset.active = String(key === tab); item.addEventListener("click", () => this.skillsDialog(key, search.value)); tabs.append(item); }
        const create = button("创建 Skill", "＋ 创建", null); create.addEventListener("click", () => this.skillEditor());
        const search = node("input", { "aria-label": "搜索 Skill", placeholder: "搜索 Skill" }); search.value = searchValue;
        const list = node("div", { class: "os-list" });
        const draw = () => { list.replaceChildren(); const needle = search.value.trim().toLowerCase();
            for (const skill of this.skills.filter(skill => (tab !== "favorites" || this.prefs.favorites.includes(skill.id)) && (tab !== "mine" || !skill.builtin) && (!needle || `${skill.name} ${skill.description || ""}`.toLowerCase().includes(needle)))) {
                const favorite = button("收藏 " + skill.name, this.prefs.favorites.includes(skill.id) ? "★" : "☆", null);
                favorite.addEventListener("click", () => { const favorites = new Set(this.prefs.favorites); if (favorites.has(skill.id)) favorites.delete(skill.id); else favorites.add(skill.id); this.prefs.favorites = [...favorites]; this.savePrefs(); draw(); });
                const detail = button("详情 " + skill.name, "详情", null); detail.addEventListener("click", () => this.skillDetail(skill));
                const added = this.prefs.selected_skills.includes(skill.id);
                const use = button("添加 Skill " + skill.name, added ? "已添加" : "添加", null); use.dataset.on = String(added); use.disabled = added;
                use.addEventListener("click", () => { this.addSkill(skill.id); draw(); });
                const row = node("div", { class: "os-list-item" }, favorite, node("div", { class: "os-grow" }, node("div", { class: "os-item-title", text: skill.name }), node("div", { class: "os-description", text: skill.description || "" })), detail, use); list.append(row);
            }
            if (!list.children.length) list.append(node("div", { class: "os-nodata", text: "没有匹配的 Skill" }));
        };
        search.addEventListener("input", draw); const clear = button("移除全部 Skill", "移除全部 Skill", null); clear.addEventListener("click", () => { this.setSkills([]); draw(); });
        let storage = this.presets?.skill_storage || {};
        const openStorage = button("打开 Skill 本地存储位置", "打开本地存储位置", null);
        const copyStorage = button("复制 Skill 存储路径", "复制路径", null); copyStorage.disabled = !storage.directory;
        const storagePath = node("div", { class: "os-note os-storage-path", text: storage.directory || "", title: storage.directory || "" });
        const storageStatus = node("div", { class: "os-note", role: "status", hidden: true });
        copyStorage.addEventListener("click", async () => { storageStatus.textContent = await this.copy(storage.directory, "存储路径已复制") ? "存储路径已复制" : "复制未成功，请手动选择下方路径复制"; storageStatus.hidden = false; });
        openStorage.addEventListener("click", async () => {
            openStorage.disabled = true;
            storageStatus.hidden = true; body.querySelector(".os-field-error").textContent = "";
            try {
                storage = await this.request("/skills/storage/open", { method: "POST" });
                storagePath.textContent = storage.directory; storagePath.title = storage.directory; copyStorage.disabled = false;
                storageStatus.textContent = "已打开 Skill 存储文件夹"; storageStatus.hidden = false;
            } catch (error) { if (body.isConnected) body.querySelector(".os-field-error").textContent = error.message; }
            finally { openStorage.disabled = false; }
        });
        body.append(node("div", { class: "os-row" }, tabs, node("div", { class: "os-grow" }), create), search, list,
            node("div", { class: "os-row os-storage-actions" }, clear, node("div", { class: "os-grow" }), copyStorage, openStorage),
            storageStatus, node("div", { class: "os-note", text: "自建 Skill 存放在此目录的 studio.sqlite3 数据库中；打开的是 ComfyUI 所在电脑的文件夹。" }), storagePath); draw();
    }
    skillDetail(skill) {
        const { body, foot } = this.modal(skill.name, { confirm: "添加这个 Skill", onConfirm: () => { this.addSkill(skill.id); markAdded(); } });
        const markAdded = () => { const add = foot.querySelector(".os-primary"); add.textContent = this.prefs.selected_skills.includes(skill.id) ? "已添加" : "添加这个 Skill"; add.disabled = this.prefs.selected_skills.includes(skill.id); add.dataset.on = String(add.disabled); };
        markAdded();
        body.append(node("p", { class: "os-note", text: skill.description || "" }), node("pre", { class: "os-skill-prompt", text: skill.prompt || "" }));
        if (!skill.builtin) {
            const edit = button("编辑 Skill", "编辑", null), remove = button("删除 Skill", "删除", null); edit.addEventListener("click", () => this.skillEditor(skill));
            remove.addEventListener("click", async () => { try { await this.request("/skills/" + encodeURIComponent(skill.id), { method: "DELETE" }); this.setSkills(this.prefs.selected_skills.filter(id => id !== skill.id)); this.prefs.favorites = this.prefs.favorites.filter(id => id !== skill.id); this.savePrefs(); await this.skillsDialog("mine"); } catch (error) { body.querySelector(".os-field-error").textContent = error.message; } }); foot.prepend(edit, remove);
        }
    }
    skillEditor(skill = null) {
        const fields = {}, { body } = this.modal(skill ? "编辑 Skill" : "创建 Skill", { confirm: "保存 Skill", onConfirm: async () => {
            const payload = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value.trim()])); if (!payload.name || !payload.prompt) throw new Error("填写名称和技能指令后再保存。");
            await this.request(skill ? "/skills/" + encodeURIComponent(skill.id) : "/skills", this.json(skill ? "PUT" : "POST", payload)); await this.skillsDialog("mine"); } });
        for (const [key, label, multiline] of [["name", "Skill 名称", false], ["description", "Skill 简介", false], ["prompt", "Skill 系统指令", true]]) { const field = node(multiline ? "textarea" : "input", { "aria-label": label, rows: multiline ? "8" : null }); field.value = skill?.[key] || ""; fields[key] = field; body.append(node("label", { style: "display:block;margin:12px 0" }, node("span", { class: "os-label", text: label }), field)); }
    }
    destroy() { this.stop(); this.closeAsset?.(); this.reserveCanvas(0); removeEventListener("resize", this.onResize); removeEventListener("eagle-assets-studio-selection", this.onEagle); this.closeModal(); this.root.remove(); }
}
