import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { OllamaStudio } from "./studio.js?v=1.4.0";

app.registerExtension({
    name: "OllamaStudio.FloatingStudio",
    async setup() {
        if (globalThis.OllamaStudioUI?.root?.isConnected) return;
        if (!document.getElementById("ollama-studio-style")) {
            const stylesheet = document.createElement("link"); stylesheet.id = "ollama-studio-style"; stylesheet.rel = "stylesheet";
            stylesheet.href = new URL("./studio.css?v=1.4.0", import.meta.url).href; document.head.append(stylesheet);
        }
        globalThis.OllamaStudioUI = new OllamaStudio({ app, api });
        await globalThis.OllamaStudioUI.ready;
    },
});
