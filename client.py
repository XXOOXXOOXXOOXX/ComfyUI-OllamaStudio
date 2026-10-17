"""A server-side Ollama proxy, using installed model capabilities rather than name guesses."""
import asyncio
import json
import time
from urllib.parse import urlsplit

from .store import StudioError

DEFAULT_HOST = "http://localhost:11434"
_model_cache = {}


def validate_host(host):
    try:
        host = str(host or DEFAULT_HOST).strip()
        url = urlsplit(host)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}:
            raise ValueError()
        if url.port is not None and not 1 <= url.port <= 65535:
            raise ValueError()
        return host.rstrip("/")
    except ValueError:
        raise StudioError("Ollama 地址必须是 http(s)://主机:端口，不能包含账号、路径或查询参数。") from None


async def _request_json(host, endpoint, payload=None):
    import aiohttp
    try:
        timeout = aiohttp.ClientTimeout(total=30, connect=10)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            request = session.post(host + endpoint, json=payload) if payload is not None else session.get(host + endpoint)
            async with request as response:
                if response.status != 200:
                    raise StudioError(f"Ollama 返回 HTTP {response.status}，请检查服务及已安装模型。")
                result = await response.json(content_type=None)
                if not isinstance(result, dict):
                    raise StudioError("Ollama 返回的数据无效。")
                return result
    except StudioError:
        raise
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
        raise StudioError("无法连接 Ollama，请启动 Ollama 并检查服务地址。") from None


async def list_models(host=DEFAULT_HOST, refresh=False):
    host = validate_host(host)
    if not refresh and host in _model_cache and time.monotonic() - _model_cache[host][0] < 120:
        return _model_cache[host][1]
    tags = await _request_json(host, "/api/tags")
    source = tags.get("models", [])
    if not isinstance(source, list):
        raise StudioError("Ollama 模型列表无效。")
    semaphore = asyncio.Semaphore(4)
    async def describe(item):
        name = item.get("name") or item.get("model")
        if not isinstance(name, str) or not name:
            return None
        async with semaphore:
            try:
                info = await _request_json(host, "/api/show", {"model": name})
                capabilities = info.get("capabilities", [])
                known = "capabilities" in info and isinstance(capabilities, list)
                capabilities = [str(value) for value in capabilities] if known else []
            except StudioError:
                info, capabilities, known = {}, [], False
        cloud = bool(item.get("remote_model") or item.get("remote_host") or info.get("remote_model") or info.get("remote_host")
                     or name.casefold().endswith(":cloud") or name.casefold().endswith("-cloud"))
        return {"name": name, "size": item.get("size", 0), "modified_at": item.get("modified_at"),
                "details": item.get("details", {}), "capabilities": capabilities, "capabilities_available": known,
                "vision": "vision" in capabilities, "cloud": cloud}
    models = [item for item in await asyncio.gather(*(describe(item) for item in source[:100] if isinstance(item, dict))) if item]
    eligible = [item for item in models if not item["cloud"] and ("completion" in item["capabilities"] or not item["capabilities_available"])]
    preferred = next((item for item in eligible if item["name"] == "qwen3-vl:4b" and item["vision"]), None)
    if preferred is None:
        preferred = min((item for item in eligible if item["vision"]), key=lambda item: item.get("size") or 0, default=None)
    if preferred is None:
        preferred = min(eligible, key=lambda item: item.get("size") or 0, default=None)
    result = {"models": models, "default_model": preferred["name"] if preferred else None}
    _model_cache[host] = (time.monotonic(), result)
    return result


async def require_model(host, model):
    if not isinstance(model, str) or not model.strip() or len(model) > 200:
        raise StudioError("请先选择已安装的 Ollama 模型。")
    models = (await list_models(host))["models"]
    item = next((item for item in models if item["name"] == model), None)
    if item is None:
        models = (await list_models(host, refresh=True))["models"]
        item = next((item for item in models if item["name"] == model), None)
    if item is None:
        raise StudioError("所选模型不在 Ollama 已安装列表中；本插件不会自动下载模型。")
    if item["capabilities_available"] and "completion" not in item["capabilities"]:
        raise StudioError("所选模型不支持对话生成，请选择具有 completion 能力的模型。")
    return item


async def stream_chat(host, model, messages, options=None):
    import aiohttp
    host = validate_host(host)
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=300)
    try:
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            async with session.post(host + "/api/chat", json={"model": model, "messages": messages, "stream": True,
                                                           "options": options or {"repeat_penalty": 1.1, "repeat_last_n": 256, "num_predict": 8192}}) as response:
                if response.status != 200:
                    raise StudioError(f"Ollama 对话返回 HTTP {response.status}；请检查模型状态。")
                async for line in response.content:
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)
                    except ValueError:
                        raise StudioError("Ollama 流式响应格式无效。") from None
                    if data.get("error"):
                        raise StudioError("Ollama 生成失败：" + str(data["error"])[:500])
                    yield data
                    if data.get("done") is True:
                        return
                raise StudioError("Ollama 连接提前结束，未收到完成标记。")
    except StudioError:
        raise
    except (aiohttp.ClientError, asyncio.TimeoutError):
        raise StudioError("Ollama 连接中断或生成超时，请重试。") from None
