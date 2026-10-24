// Canvas references are an isolated set. Switching selections never deletes
// manual uploads, Eagle references, or the already submitted conversation.
export function installCanvasBridge(studio){
    studio.canvasRefs=[];studio.canvasRevision=0;studio.canvasAbort=null;
    const button=document.createElement("button");button.type="button";button.textContent="W";button.className="os-icon os-eagle";button.dataset.action="canvas-bridge";studio.imageBridgeButton.after(button);studio.canvasButton=button;
    const update=()=>{button.dataset.on=String(!!studio.prefs.canvas_enabled);button.title=button.ariaLabel=studio.prefs.canvas_enabled?"关闭无限画布素材":"开启无限画布素材";button.setAttribute("aria-pressed",String(!!studio.prefs.canvas_enabled));};
    button.addEventListener("click",()=>{studio.prefs.canvas_enabled=!studio.prefs.canvas_enabled;studio.savePrefs();update();studio.syncCanvasSelection(globalThis.InfiniteCanvasBridgeSelection);});update();
    studio.syncCanvasSelection=async selection=>{
        const revision=++studio.canvasRevision;studio.canvasAbort?.abort();studio.canvasAbort=new AbortController();studio.canvasRefs=[];studio.canvasPending=false;studio.renderAttachments();studio.updateControls();
        if(!studio.prefs.canvas_enabled||!selection?.node)return;
        const owner=selection.board+":"+selection.node;studio.canvasOwner=owner;const signal=studio.canvasAbort.signal;studio.canvasPending=true;studio.updateControls();studio.showStatus("正在引用当前画布节点…");
        try{
            const files=[];
            for(const asset of selection.assets||[]){const ref=asset.ref;if(!ref||!["input","output","temp"].includes(ref.type)||!ref.filename)continue;const response=await studio.api.fetchApi("/view?"+new URLSearchParams(ref),{signal});if(!response.ok)throw Error("无法读取画布素材："+asset.name);files.push(new File([await response.blob()],asset.name||ref.filename,{type:asset.mime||response.headers.get("Content-Type")||"application/octet-stream"}));}
            if(selection.text?.trim())files.push(new File([selection.text],"画布文本.txt",{type:"text/plain"}));
            const completed=[];for(const file of files){if(revision!==studio.canvasRevision||signal.aborted)return;const form=new FormData();form.append("files",file,file.name);const response=await studio.api.fetchApi("/ollama_studio/upload",{method:"POST",body:form,signal});const data=await response.json();if(!response.ok||data.ok===false)throw Error(data.error||"画布素材上传失败");completed.push(...data.attachments||[]);}
            if(revision!==studio.canvasRevision||signal.aborted||!studio.prefs.canvas_enabled)return;studio.canvasRefs=completed;studio.renderAttachments();studio.updateControls();studio.showStatus(completed.length?`已引用当前画布节点的 ${completed.length} 个素材`:"当前画布节点没有可引用的内容");
        }catch(error){if(revision===studio.canvasRevision&&!signal.aborted)studio.showStatus(error.message,true);}
        finally{if(revision===studio.canvasRevision){studio.canvasPending=false;studio.updateControls();}}
    };
    studio.onCanvasSelection=event=>studio.syncCanvasSelection(event.detail);addEventListener("infinite-canvas-selection",studio.onCanvasSelection);
    studio.onCanvasVisibility=event=>{const active=!!event.detail?.open;studio.canvasOpen=active;studio.root.classList.toggle("os-over-infinite",active);studio.reserveCanvas(0);studio.layout();};addEventListener("infinite-canvas-visibility",studio.onCanvasVisibility);
    const originalReserve=studio.reserveCanvas.bind(studio);studio.reserveCanvas=width=>{
        originalReserve(studio.canvasOpen?0:width);
        const canvas=globalThis.InfiniteCanvasUI;
        if(canvas){canvas.shell.style.setProperty("--ic-studio-dock",studio.canvasOpen?width+"px":"0px");canvas.positionEditor?.();}
    };
    studio.onCanvasVisibility({detail:{open:!!globalThis.InfiniteCanvasUI&&!globalThis.InfiniteCanvasUI.shell.hidden}});
    const destroy=studio.destroy.bind(studio);studio.destroy=()=>{studio.canvasAbort?.abort();removeEventListener("infinite-canvas-selection",studio.onCanvasSelection);removeEventListener("infinite-canvas-visibility",studio.onCanvasVisibility);destroy();};
    if(studio.prefs.canvas_enabled)studio.syncCanvasSelection(globalThis.InfiniteCanvasBridgeSelection);
}
