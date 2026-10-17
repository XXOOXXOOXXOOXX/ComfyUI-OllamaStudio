"""ComfyUI-side routes, persistence and cancellable NDJSON Ollama generation."""
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from .client import DEFAULT_HOST, list_models, require_model, stream_chat, validate_host
from .media import asr_status, prepare_media
from .prompts import presets, system_prompt
from .repetition import repeated_tail_cutoff
from .store import get_store, StudioError, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES

_active_chats = set()


def _open_skill_storage(store):
    directory = store.root.resolve()
    try:
        if os.name == "nt":
            os.startfile(str(directory))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(directory)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
                raise StudioError("当前 ComfyUI 没有可用的桌面环境，请复制下方目录路径打开。")
            subprocess.Popen(["xdg-open", str(directory)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        raise StudioError("无法打开文件管理器，请复制下方目录路径手动打开。") from None
    return {"directory": str(directory), "database": str(store.database)}


def public_conversation(conversation):
    data = dict(conversation)
    data["messages"] = [{key: value for key, value in message.items() if not key.startswith("_")} for message in conversation["messages"]]
    return data


def _messages(conversation, system, user_text, media, sanitize_history=True):
    result = [{"role": "system", "content": system}]
    for message in conversation["messages"][-40:]:
        if message["role"] == "assistant" and message.get("status") == "error" and not message["content"]:
            continue
        item = {"role": message["role"], "content": message.get("_model_content", message["content"])}
        if sanitize_history and message["role"] == "assistant":
            cutoff = repeated_tail_cutoff(item["content"])
            if cutoff is not None:
                item["content"] = item["content"][:cutoff].rstrip() + "\n[Repetitive tail omitted.]"
        if message.get("_images"):
            item["images"] = message["_images"]
        result.append(item)
    content = user_text + ("\n\nAttached reference evidence:\n" + media["notes"] if media["notes"] else "")
    item = {"role": "user", "content": content}
    if media["images"]:
        item["images"] = media["images"]
    result.append(item)
    return result, content


def register_routes():
    from aiohttp import web, ClientConnectionError
    from server import PromptServer
    routes = PromptServer.instance.routes

    async def body(request):
        try:
            value = await request.json()
        except (ValueError, TypeError):
            raise StudioError("请求 JSON 无效。") from None
        if not isinstance(value, dict):
            raise StudioError("请求格式无效。")
        return value

    async def handle(request, operation):
        try:
            value = await operation(request)
            return web.json_response({"ok": True, **value})
        except StudioError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception:
            return web.json_response({"ok": False, "error": "本地 Studio 操作失败，请检查服务与文件权限。"}, status=500)

    @routes.post("/ollama_studio/models")
    async def models(request):
        async def operation(request):
            data = await body(request)
            return await list_models(data.get("host", DEFAULT_HOST), refresh=True)
        return await handle(request, operation)

    @routes.post("/ollama_studio/upload")
    async def upload(request):
        async def operation(request):
            store = get_store()
            reader = await request.multipart()
            results = []
            while True:
                part = await reader.next()
                if part is None:
                    break
                if not part.filename:
                    continue
                if len(results) >= MAX_ATTACHMENTS:
                    raise StudioError("一次最多上传 32 个文件。")
                aid, name, kind, path = store.begin_upload(part.filename)
                try:
                    size = 0
                    with path.open("wb") as output:
                        while True:
                            chunk = await part.read_chunk()
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > MAX_UPLOAD_BYTES:
                                raise StudioError("单个上传文件不能超过 256 MB。")
                            output.write(chunk)
                    store.finish_upload(aid, name, kind, path)
                    results.append(store.public_attachment(aid))
                except Exception:
                    store.discard_upload(aid)
                    raise
            if not results:
                raise StudioError("没有接收到可上传的文件。")
            return {"attachments": results}
        return await handle(request, operation)

    @routes.get("/ollama_studio/media/{id}")
    async def media(request):
        try:
            item = get_store().attachment(request.match_info["id"])
            return web.FileResponse(Path(item["_path"]), headers={"Content-Type": item["mime"], "Cache-Control": "private, max-age=60",
                                    "X-Content-Type-Options": "nosniff"})
        except StudioError:
            return web.json_response({"ok": False, "error": "素材不可读取。"}, status=404)

    @routes.get("/ollama_studio/conversations")
    async def conversations(request):
        async def operation(request):
            return {"conversations": await asyncio.to_thread(get_store().list_conversations)}
        return await handle(request, operation)

    @routes.post("/ollama_studio/conversations")
    async def create_conversation(request):
        async def operation(request):
            data = await body(request)
            conversation = await asyncio.to_thread(get_store().create_conversation, data.get("title", "新会话"))
            return {"conversation": public_conversation(conversation)}
        return await handle(request, operation)

    @routes.get("/ollama_studio/conversations/{id}")
    async def conversation(request):
        async def operation(request):
            result = await asyncio.to_thread(get_store().conversation, request.match_info["id"])
            return {"conversation": public_conversation(result)}
        return await handle(request, operation)

    @routes.post("/ollama_studio/conversations/{id}/rename")
    async def rename_conversation(request):
        async def operation(request):
            data = await body(request)
            value = await asyncio.to_thread(get_store().rename_conversation, request.match_info["id"], data.get("title"))
            return {"conversation": public_conversation(value)}
        return await handle(request, operation)

    @routes.get("/ollama_studio/conversations/storage/info")
    async def history_storage(request):
        async def operation(request):
            store = get_store()
            return {"directory": str(store.root), "database": str(store.database)}
        return await handle(request, operation)

    @routes.post("/ollama_studio/conversations/storage/open")
    async def open_history_storage(request):
        return await handle(request, lambda request: asyncio.to_thread(_open_skill_storage, get_store()))

    @routes.delete("/ollama_studio/conversations/{id}")
    async def delete_conversation(request):
        async def operation(request):
            cid = request.match_info["id"]
            if cid in _active_chats:
                raise StudioError("此会话正在生成，请先停止生成再删除。")
            await asyncio.to_thread(get_store().delete_conversation, cid)
            return {}
        return await handle(request, operation)

    @routes.post("/ollama_studio/conversations/{id}/messages/{message_id}/timing")
    async def message_timing(request):
        async def operation(request):
            data = await body(request)
            message = await asyncio.to_thread(get_store().save_message_timing, request.match_info["id"],
                                              request.match_info["message_id"], data.get("elapsed_ms"))
            return {"message": message}
        return await handle(request, operation)

    @routes.get("/ollama_studio/presets")
    async def get_presets(request):
        async def operation(request):
            store = get_store()
            return {**presets(store), "asr": asr_status(store),
                    "skill_storage": {"directory": str(store.root), "database": str(store.database)}}
        return await handle(request, operation)

    @routes.post("/ollama_studio/skills/storage/open")
    async def open_skill_storage(request):
        async def operation(request):
            return await asyncio.to_thread(_open_skill_storage, get_store())
        return await handle(request, operation)

    @routes.post("/ollama_studio/skills")
    async def create_skill(request):
        async def operation(request):
            return {"skill": await asyncio.to_thread(get_store().save_skill, await body(request))}
        return await handle(request, operation)

    @routes.put("/ollama_studio/skills/{id}")
    async def update_skill(request):
        async def operation(request):
            sid = request.match_info["id"]
            if not any(item["id"] == sid for item in get_store().list_skills()):
                raise StudioError("自定义技能不存在；内置技能可复制为新技能后编辑。")
            return {"skill": await asyncio.to_thread(get_store().save_skill, await body(request), sid)}
        return await handle(request, operation)

    @routes.delete("/ollama_studio/skills/{id}")
    async def delete_skill(request):
        async def operation(request):
            await asyncio.to_thread(get_store().delete_skill, request.match_info["id"])
            return {}
        return await handle(request, operation)

    @routes.post("/ollama_studio/chat")
    async def chat(request):
        started_at = time.monotonic()
        store, cid, response = get_store(), None, None
        claimed = False
        content, thinking, generated, status, warnings = "", "", False, "complete", []
        try:
            data = await body(request)
            cid = data.get("conversation_id")
            conversation = await asyncio.to_thread(store.conversation, cid)
            if cid in _active_chats:
                raise StudioError("同一会话已有生成任务，请先停止或等待完成。")
            _active_chats.add(cid)
            claimed = True
            host = validate_host(data.get("host", DEFAULT_HOST))
            model = await require_model(host, data.get("model"))
            text = data.get("text", "")
            if not isinstance(text, str) or len(text) > 120000:
                raise StudioError("消息必须为文字且最多 120000 字符。")
            if not text.strip() and not data.get("upload_ids") and not data.get("eagle_refs"):
                raise StudioError("请填写消息或添加素材。")
            from .prompts import selected_skill_ids
            skill_ids = selected_skill_ids(data.get("skill_id"), data.get("skill_ids"))
            system = system_prompt(store, data.get("mode"), skill_ids=skill_ids)
            prepared = await asyncio.to_thread(prepare_media, store, data.get("upload_ids"), data.get("eagle_refs"), data.get("transcripts"),
                                             data.get("manual_transcript", ""), data.get("asr_model_path"))
            warnings = prepared["warnings"]
            config = store.config()
            messages, model_content = _messages(conversation, system, text, prepared, config.get("repetition_guard", True))
            if any(message.get("images") for message in messages) and not model["vision"]:
                raise StudioError("当前模型未声明 vision 能力，不能读取图片或视频帧。请选择视觉模型，或新建纯文字会话。")
            await asyncio.to_thread(store.add_message, cid, "user", text, attachments=prepared["attachments"],
                                    _model_content=model_content, _images=prepared["images"], mode=data.get("mode", {"kind": "chat"}),
                                    skill_id=skill_ids[0] if skill_ids else None, skill_ids=skill_ids, model=model["name"])
            generated = True
            response = web.StreamResponse(status=200, headers={"Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store"})
            await response.prepare(request)
            async def emit(value):
                await response.write((json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8"))
            for warning in prepared["warnings"]:
                await emit({"type": "warning", "content": warning})
            limit = config.get("max_output_tokens", 8192)
            limit = limit if type(limit) is int and 256 <= limit <= 65536 else 8192
            iterator = stream_chat(host, model["name"], messages, {"repeat_penalty": 1.1, "repeat_last_n": 256, "num_predict": limit})
            checked = {"content": 0, "thinking": 0}
            finish_status = "complete"
            async def monitor_disconnect():
                while True:
                    await asyncio.sleep(.2)
                    if request.transport is None or request.transport.is_closing():
                        return
            disconnect = asyncio.create_task(monitor_disconnect())
            next_chunk = None
            try:
                while True:
                    next_chunk = asyncio.create_task(anext(iterator))
                    completed, _ = await asyncio.wait((next_chunk, disconnect), return_when=asyncio.FIRST_COMPLETED)
                    if disconnect in completed:
                        next_chunk.cancel()
                        await asyncio.gather(next_chunk, return_exceptions=True)
                        raise asyncio.CancelledError()
                    try:
                        chunk = next_chunk.result()
                    except StopAsyncIteration:
                        break
                    message = chunk.get("message") or {}
                    repetitive = False
                    for key in ("content", "thinking"):
                        addition = str(message.get(key) or "")
                        candidate = (content if key == "content" else thinking) + addition
                        if addition and config.get("repetition_guard", True) and len(candidate) - checked[key] >= 48:
                            checked[key] = len(candidate)
                            cutoff = repeated_tail_cutoff(candidate)
                            if cutoff is not None:
                                if key == "content": content = candidate[:cutoff].rstrip()
                                else: thinking = candidate[:cutoff].rstrip()
                                repetitive = True
                                break
                    if repetitive:
                        warning = "检测到模型持续重复同一段文字，已自动停止并保留有效内容。可重新发送问题或切换模型。"
                        warnings.append(warning); await emit({"type": "warning", "content": warning})
                        finish_status = "repetition"
                        break
                    if message.get("thinking"):
                        thinking += str(message["thinking"])
                        await emit({"type": "thinking", "content": str(message["thinking"])})
                    if message.get("content"):
                        content += str(message["content"])
                        await emit({"type": "token", "content": str(message["content"])})
                    if chunk.get("done") and chunk.get("done_reason") == "length":
                        warning = "本次回复达到输出长度上限，已保留内容；需要更多内容时可发送“继续”。"
                        warnings.append(warning); await emit({"type": "warning", "content": warning})
                        finish_status = "limited"
            finally:
                if next_chunk is not None and not next_chunk.done():
                    next_chunk.cancel()
                    await asyncio.gather(next_chunk, return_exceptions=True)
                disconnect.cancel()
                await asyncio.gather(disconnect, return_exceptions=True)
                await iterator.aclose()
            message = await asyncio.to_thread(store.add_message, cid, "assistant", content, thinking=thinking, model=model["name"], status=finish_status, warnings=warnings,
                                             elapsed_ms=round((time.monotonic() - started_at) * 1000))
            generated = False
            await emit({"type": "done", "message": message, "conversation": public_conversation(await asyncio.to_thread(store.conversation, cid))})
            await response.write_eof()
            return response
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except (ConnectionError, ClientConnectionError):
            status = "cancelled"
            if response is not None:
                return response
            raise
        except StudioError as exc:
            status = "error"
            if response is not None:
                try:
                    await response.write((json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False) + "\n").encode("utf-8"))
                    await response.write_eof()
                except (ConnectionError, ClientConnectionError):
                    pass
                return response
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception:
            status = "error"
            if response is not None:
                try:
                    await response.write((json.dumps({"type": "error", "message": "本地对话失败，请检查 Ollama 服务与媒体解码器。"}, ensure_ascii=False) + "\n").encode("utf-8"))
                    await response.write_eof()
                except (ConnectionError, ClientConnectionError):
                    pass
                return response
            return web.json_response({"ok": False, "error": "本地对话失败，请检查服务与素材。"}, status=500)
        finally:
            if generated and cid:
                await asyncio.to_thread(store.add_message, cid, "assistant", content, thinking=thinking, status=status, warnings=warnings,
                                        elapsed_ms=round((time.monotonic() - started_at) * 1000))
            if cid and claimed:
                _active_chats.discard(cid)
