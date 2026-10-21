"""Real local HTTP routes + simulated Ollama; never downloads or runs a model."""
import asyncio
import base64
import importlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

WORKSPACE = Path(__file__).parents[2]
sys.path.insert(0, str(WORKSPACE / ".test-deps"))
sys.path.insert(0, str(WORKSPACE / "ComfyUI-EagleAssets" / "tests"))

import aiohttp
from aiohttp import web
from PIL import Image
from fixture import Fixture


class StudioBackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = Fixture(self.temp.name, media=True, native_web=True)
        name = "ollama_studio_backend_fixture"
        root = WORKSPACE / "ComfyUI-OllamaStudio"
        spec = importlib.util.spec_from_file_location(name, root / "__init__.py", submodule_search_locations=[str(root)])
        module = importlib.util.module_from_spec(spec); sys.modules[name] = module; spec.loader.exec_module(module)
        self.store_module = importlib.import_module(name + ".store")
        self.store = self.store_module.get_store()
        self.media = importlib.import_module(name + ".media")
        self.prompts = importlib.import_module(name + ".prompts")
        self.client_module = importlib.import_module(name + ".client")
        self.eagle_runtime = importlib.import_module("eagle_assets_fixture.runtime")
        self.eagle_nodes = importlib.import_module("eagle_assets_fixture.nodes")
        self.app = web.Application(client_max_size=1024 ** 3)
        self.app.router.add_routes(self.fixture.handlers)
        self.runner = web.AppRunner(self.app); await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0); await self.site.start()
        self.host = "http://127.0.0.1:" + str(self.site._server.sockets[0].getsockname()[1])
        self.session = aiohttp.ClientSession(trust_env=False)

    async def asyncTearDown(self):
        await self.session.close(); await self.runner.cleanup()
        self.fixture.close(); self.temp.cleanup()

    async def request(self, method, path, **kwargs):
        async with self.session.request(method, self.host + "/ollama_studio" + path, **kwargs) as response:
            return response.status, await response.json()

    async def new_conversation(self):
        status, data = await self.request("POST", "/conversations", json={})
        self.assertEqual(status, 200)
        return data["conversation"]["id"]

    async def upload(self, name, raw):
        form = aiohttp.FormData(); form.add_field("files", raw, filename=name, content_type="application/octet-stream")
        status, data = await self.request("POST", "/upload", data=form)
        self.assertEqual(status, 200, data)
        return data["attachments"][0]

    async def chat(self, cid, **extra):
        body = {"conversation_id": cid, "host": self.fixture.host, "model": "mock-vision:latest", "text": "测试创作", **extra}
        async with self.session.post(self.host + "/ollama_studio/chat", json=body) as response:
            raw = await response.text()
            self.assertEqual(response.status, 200, raw)
        events = [json.loads(line) for line in raw.splitlines() if line]
        return events

    async def test_direct_image_bridge_orders_upload_then_numbered_ports_then_eagle(self):
        import torch
        red = torch.tensor([1., 0., 0.]).reshape(1, 1, 1, 3).repeat(1, 8, 8, 1)
        blue = torch.tensor([0., 0., 1.]).reshape(1, 1, 1, 3).repeat(1, 8, 8, 1)
        bridge = self.eagle_nodes.EagleImageStudioBridge().publish(image_10=blue, image_2=red.repeat(2, 1, 1, 1))
        catalog = bridge["ui"]["eagle_image_studio"][0]
        self.assertEqual([item["id"] for item in catalog["items"]], ["image_2_1", "image_2_2", "image_10_1"])
        refs = [{"snapshot_id": catalog["snapshot_id"], "item_id": item["id"]} for item in catalog["items"]]
        buffer = io.BytesIO(); Image.new("RGB", (8, 8), (0, 255, 0)).save(buffer, format="PNG")
        uploaded = await self.upload("drag-first.png", buffer.getvalue())
        eagle = self.eagle_runtime.prepare_catalog(self.fixture.settings(folder_id="media_mix", types=["image"]))
        events = await self.chat(await self.new_conversation(), upload_ids=[uploaded["id"]], image_refs=refs,
                                 eagle_refs=[{"catalog_id": eagle["catalog_id"], "item_id": "media_image"}])
        attachments = events[-1]["conversation"]["messages"][0]["attachments"]
        self.assertEqual(attachments[0]["name"], "drag-first.png")
        self.assertEqual([item["metadata"]["source_ref"]["item_id"] for item in attachments[1:]], ["image_2_1", "image_2_2", "image_10_1", "media_image"])
        images = self.fixture.ollama_calls[-1]["messages"][-1]["images"]
        colors = []
        for raw in images[:4]:
            with Image.open(io.BytesIO(base64.b64decode(raw))) as image:
                colors.append(image.getpixel((0, 0)))
        for actual, expected in zip(colors, [(0, 255, 0), (255, 0, 0), (255, 0, 0), (0, 0, 255)]):
            self.assertTrue(all(abs(a - b) <= 2 for a, b in zip(actual, expected)), "JPEG model input must preserve channel order and colors")
        # Snapshot files and resolved history media are durable, not registry URLs.
        self.eagle_runtime._catalogs.clear(); self.eagle_runtime._media_files.clear()
        many = self.eagle_nodes.EagleImageStudioBridge().publish(image_1=red.repeat(70, 1, 1, 1))["ui"]["eagle_image_studio"][0]
        prepared = self.media.prepare_media(self.store, image_refs=[{"snapshot_id": many["snapshot_id"], "item_id": item["id"]} for item in many["items"]])
        self.assertEqual(len(prepared["images"]), 70, "direct sockets have no fixed 32/64-image ceiling")
        for bad in [[{"snapshot_id": "../bad", "item_id": "image_2_1"}], [{"path": "C:/private.png"}]]:
            with self.assertRaises(ValueError): self.media.prepare_media(self.store, image_refs=bad)

    async def test_models_use_tags_and_show_and_cloud_default_is_excluded(self):
        status, data = await self.request("POST", "/models", json={"host": self.fixture.host})
        self.assertEqual(status, 200)
        self.assertEqual(data["default_model"], "mock-vision:latest")
        self.assertTrue(next(item for item in data["models"] if item["name"] == "mock-vision:latest")["vision"])
        self.assertTrue(next(item for item in data["models"] if item["name"] == "mock-vision:cloud")["cloud"])
        self.assertEqual(self.fixture.counts["ollama/tags"], 1)
        self.assertEqual(self.fixture.counts["ollama/show"], 3)
        for host in ("http://localhost:11434/api", "http://user:token@localhost:11434", "ftp://localhost", "http://localhost?token=secret"):
            with self.assertRaises(self.store_module.StudioError): self.client_module.validate_host(host)

    async def test_multiple_skills_reach_model_and_persist_in_click_order(self):
        cid = await self.new_conversation()
        ids = ["shot-breakdown", "asset-continuity", "shot-breakdown"]
        events = await self.chat(cid, skill_ids=ids)
        system = self.fixture.ollama_calls[-1]["messages"][0]["content"]
        first = "Break the supplied story segment"
        second = "Review the user's script or shot list"
        self.assertLess(system.index(first), system.index(second))
        self.assertEqual(system.count(first), 1)
        user = events[-1]["conversation"]["messages"][0]
        self.assertEqual(user["skill_ids"], ids[:2])
        saved = self.store.conversation(cid)["messages"][0]
        self.assertEqual(saved["skill_ids"], ids[:2])
        cid = await self.new_conversation()
        await self.chat(cid, skill_id="shot-breakdown")  # Legacy clients still work.
        self.assertIn(first, self.fixture.ollama_calls[-1]["messages"][0]["content"])
        cid = await self.new_conversation()
        await self.chat(cid, skill_ids=[], skill_id="shot-breakdown")
        self.assertNotIn(first, self.fixture.ollama_calls[-1]["messages"][0]["content"])
        for invalid in ["shot-breakdown", [None], [""], ["shot-breakdown"] * 33]:
            with self.assertRaises(self.store_module.StudioError):
                self.prompts.system_prompt(self.store, skill_ids=invalid)

    async def test_history_rename_storage_and_repetition_guard(self):
        cid = await self.new_conversation()
        status, renamed = await self.request("POST", f"/conversations/{cid}/rename", json={"title": "新的历史标题"})
        self.assertEqual(status, 200, renamed)
        self.assertEqual(self.store.conversation(cid)["title"], "新的历史标题")
        status, storage = await self.request("GET", "/conversations/storage/info")
        self.assertEqual(status, 200); self.assertEqual(storage["database"], str(self.store.database))
        events = await self.chat(cid, text="[repeat] 分析图片")
        message = events[-1]["message"]
        self.assertEqual(message["status"], "repetition")
        self.assertIn("有效内容", message["content"])
        self.assertLess(message["content"].count("in the image"), 10)
        self.assertTrue(any("重复" in value for value in message["warnings"]))
        self.assertEqual(self.store.conversation(cid)["messages"][-1]["status"], "repetition")
        options = self.fixture.ollama_calls[-1]["options"]
        self.assertGreater(options["repeat_penalty"], 1); self.assertGreater(options["num_predict"], 0)
        guard = importlib.import_module(self.client_module.__package__ + ".repetition")
        self.assertIsNone(guard.repeated_tail_cutoff("\n".join(f"镜头 {index}: 角色在位置 {index} 执行动作。" for index in range(80))))
        fresh = await self.new_conversation()
        self.store.add_message(fresh, "user", "之前的问题")
        previous = "有效前文。\n" + "in the image, " * 2000
        self.store.add_message(fresh, "assistant", previous)
        await self.chat(fresh, text="继续正常创作")
        supplied = self.fixture.ollama_calls[-1]["messages"][2]["content"]
        self.assertIn("有效前文", supplied); self.assertLess(len(supplied), 200)
        self.assertEqual(self.store.conversation(fresh)["messages"][1]["content"], previous)

    async def test_mode_skill_and_constraints_are_sent_as_system_and_history_persists(self):
        cid = await self.new_conversation()
        mode = {"kind": "script", "branch": "adapt", "genres": ["悬疑", "剧情"], "characters": "两名医生", "era": "2030", "audience": "成人", "structure": "三幕式"}
        events = await self.chat(cid, mode=mode, skill_id="three-view-character")
        self.assertEqual(events[-1]["type"], "done")
        self.assertIsInstance(events[-1]["message"]["elapsed_ms"], int)
        self.assertGreaterEqual(events[-1]["message"]["elapsed_ms"], 0)
        system = self.fixture.ollama_calls[-1]["messages"][0]["content"]
        for value in ("screenwriter", "adapt", "悬疑", "两名医生", "2030", "English only", "FRONT VIEW", "SIDE VIEW", "BACK VIEW", "identical visual identity"):
            self.assertIn(value, system)
        status, detail = await self.request("GET", "/conversations/" + cid)
        self.assertEqual(status, 200)
        self.assertEqual([message["role"] for message in detail["conversation"]["messages"]], ["user", "assistant"])
        self.assertFalse(any(key.startswith("_") for message in detail["conversation"]["messages"] for key in message))
        reloaded = self.store_module.Store(self.store.root)
        self.assertEqual(len(reloaded.conversation(cid)["messages"]), 2)
        assistant_id = events[-1]["message"]["id"]
        status, timed = await self.request("POST", f"/conversations/{cid}/messages/{assistant_id}/timing", json={"elapsed_ms": 12345})
        self.assertEqual(status, 200, timed)
        self.assertEqual(self.store_module.Store(self.store.root).conversation(cid)["messages"][-1]["elapsed_ms"], 12345)
        user_id = detail["conversation"]["messages"][0]["id"]
        for message_id, value in ((assistant_id, -1), (user_id, 1000)):
            status, _ = await self.request("POST", f"/conversations/{cid}/messages/{message_id}/timing", json={"elapsed_ms": value})
            self.assertEqual(status, 400)
        await self.chat(cid, mode={"kind": "director", "shot_style": "固定长镜头", "focus": "表演"})
        self.assertIn("固定长镜头", self.fixture.ollama_calls[-1]["messages"][0]["content"])
        self.assertEqual(len(self.fixture.ollama_calls[-1]["messages"]), 4)

    async def test_custom_skills_create_edit_delete_and_builtins_remain(self):
        status, data = await self.request("POST", "/skills", json={"name": "我的模式", "prompt": "Use precise asset names", "language": "en"})
        self.assertEqual(status, 200); sid = data["skill"]["id"]
        status, _ = await self.request("PUT", "/skills/" + sid, json={"name": "更新模式", "prompt": "Updated instruction", "language": "zh"})
        self.assertEqual(status, 200)
        _, data = await self.request("GET", "/presets")
        self.assertEqual(next(item for item in data["skills"] if item["id"] == sid)["prompt"], "Updated instruction")
        self.assertEqual(len(data["modes"]), 3)
        status, _ = await self.request("DELETE", "/skills/" + sid)
        self.assertEqual(status, 200)
        status, _ = await self.request("DELETE", "/skills/three-view-character")
        self.assertEqual(status, 400)

    async def test_skill_storage_opens_configured_directory_and_reports_failure(self):
        from unittest.mock import patch
        routes = importlib.import_module(self.client_module.__package__ + ".routes")
        _, data = await self.request("GET", "/presets")
        self.assertEqual(data["skill_storage"]["directory"], str(self.store.root))
        self.assertEqual(data["skill_storage"]["database"], str(self.store.database))
        target, method = (routes.os, "startfile") if routes.os.name == "nt" else (routes.subprocess, "Popen")
        with patch.dict(routes.os.environ, {"DISPLAY": ":1"}), patch.object(target, method) as opener:
            status, opened = await self.request("POST", "/skills/storage/open", json={"directory": "ignored-client-directory"})
            self.assertEqual(status, 200, opened)
            self.assertEqual(opened["directory"], str(self.store.root))
            argument = opener.call_args.args[0]
            self.assertEqual(argument if isinstance(argument, str) else argument[-1], str(self.store.root))
        with patch.dict(routes.os.environ, {"DISPLAY": ":1"}), patch.object(target, method, side_effect=OSError("No file manager")):
            status, failed = await self.request("POST", "/skills/storage/open")
            self.assertEqual(status, 400)
            self.assertIn("复制", failed["error"])

    async def test_real_image_upload_and_opaque_preview(self):
        image = io.BytesIO(); Image.new("RGB", (120, 90), "red").save(image, "PNG")
        attachment = await self.upload("../test.png", image.getvalue())
        self.assertEqual(attachment["name"], "test.png")
        self.assertNotIn("_path", attachment)
        async with self.session.get(self.host + attachment["preview_url"], headers={"Range": "bytes=0-7"}) as response:
            self.assertEqual(response.status, 206); self.assertEqual(await response.read(), image.getvalue()[:8])
        cid = await self.new_conversation(); await self.chat(cid, upload_ids=[attachment["id"]])
        supplied = self.fixture.ollama_calls[-1]["messages"][-1]["images"]
        self.assertEqual(len(supplied), 1)
        with Image.open(io.BytesIO(base64.b64decode(supplied[0]))) as source:
            self.assertEqual(source.size, (120, 90))
        async with self.session.get(self.host + "/ollama_studio/media/../outside") as response:
            self.assertIn(response.status, (400, 404))

    async def test_video_sends_at_most_eight_actual_equal_interval_frames_and_timestamps(self):
        raw = (self.fixture.library / "images/media_video.info/clip.mp4").read_bytes()
        attachment = await self.upload("reference.mp4", raw)
        cid = await self.new_conversation(); events = await self.chat(cid, upload_ids=[attachment["id"]])
        user = self.fixture.ollama_calls[-1]["messages"][-1]
        self.assertEqual(len(user["images"]), 8)
        self.assertIn("timestamps", user["content"]); self.assertIn("No soundtrack", user["content"])
        stored = events[-1]["conversation"]["messages"][0]["attachments"][0]
        self.assertEqual(len(stored["sample_times"]), 8)
        self.assertGreater(stored["sample_times"][-1], 1.8)
        gaps = [right - left for left, right in zip(stored["sample_times"], stored["sample_times"][1:])]
        self.assertLess(max(gaps) - min(gaps), .06)

    async def test_audio_without_local_asr_warns_and_manual_transcript_is_evidence(self):
        raw = (self.fixture.library / "images/media_audio.info/sound.wav").read_bytes()
        attachment = await self.upload("speech.wav", raw)
        cid = await self.new_conversation(); events = await self.chat(cid, upload_ids=[attachment["id"]])
        self.assertTrue(any(event["type"] == "warning" and "没有听到" in event["content"] for event in events))
        self.assertTrue(events[-1]["message"]["warnings"])
        user = self.fixture.ollama_calls[-1]["messages"][-1]
        self.assertNotIn("images", user); self.assertIn("have not heard", user["content"])
        cid = await self.new_conversation(); await self.chat(cid, upload_ids=[attachment["id"]], transcripts={attachment["id"]: "真正提供的转录内容"})
        self.assertIn("真正提供的转录内容", self.fixture.ollama_calls[-1]["messages"][-1]["content"])
        self.assertIn("user-provided transcript", self.fixture.ollama_calls[-1]["messages"][-1]["content"])

    async def test_eagle_refs_resolve_registered_catalog_only_and_use_durable_copy(self):
        settings = self.fixture.settings(folder_count=1, folder_ids=["media_mix"], types=["image", "video", "audio", "model"])
        catalog = self.eagle_runtime.prepare_catalog(settings)
        cid = await self.new_conversation()
        events = await self.chat(cid, eagle_refs=[{"catalog_id": catalog["catalog_id"], "item_id": "media_image"}])
        self.assertEqual(len(self.fixture.ollama_calls[-1]["messages"][-1]["images"]), 1)
        saved = events[-1]["conversation"]["messages"][0]["attachments"][0]
        self.assertTrue(Path(self.store.attachment(saved["id"])["_path"]).is_file())
        for refs in ([{"catalog_id": catalog["catalog_id"], "item_id": "not-registered"}], [{"catalog_id": catalog["catalog_id"], "item_id": "media_image", "path": "C:/outside.png"}]):
            with self.assertRaises(ValueError): self.eagle_runtime.resolve_studio_media(refs)
        bridge = self.eagle_nodes.EagleStudioBridge().publish(self.eagle_runtime.studio_catalog(catalog_id=catalog["catalog_id"]), '{"version":1,"selected_ids":["media_image"]}')
        self.assertEqual([item["id"] for item in bridge["result"][0]["items"]], ["media_image"])

    async def test_sort_filters_click_selection_but_preserves_full_gallery(self):
        settings = self.fixture.settings()
        bundle = self.eagle_nodes.EagleAssetImport().load(json.dumps(settings), "1/2/3")["result"][0]
        result = self.eagle_nodes.EagleAssetSort().sort(bundle, '{"version":1,"filter_mode":true,"mode":"manual","selected_ids":["asset1","asset0"],"order":["asset1","asset0"]}')
        self.assertEqual([item.metadata["id"] for item in result["result"][0].items], ["asset1", "asset0"])
        self.assertEqual(len(result["ui"]["eagle_catalog"][0]), 3)
        empty = self.eagle_nodes.EagleAssetSort().sort(bundle, '{"version":1,"filter_mode":true,"selected_ids":[]}')
        self.assertEqual(len(empty["result"][0].items), 0)
        old = self.eagle_nodes.EagleAssetSort().sort(bundle, '{"version":1,"mode":"input"}')
        self.assertEqual(len(old["result"][0].items), 3)
        changed = self.eagle_nodes.EagleAssetSort().sort(bundle, '{"version":1,"filter_mode":true,"selected_ids":["previous-batch-id"]}')
        self.assertEqual(len(changed["result"][0].items), 0)
        self.assertTrue(all(value is None for value in self.eagle_nodes.EagleAssetSplit().split(changed["result"][0], 9)))

    async def test_stop_disconnect_closes_ollama_and_preserves_partial_message(self):
        cid = await self.new_conversation()
        response = await self.session.post(self.host + "/ollama_studio/chat", json={"conversation_id": cid, "host": self.fixture.host,
                   "model": "mock-vision:latest", "text": "[slow] 请长输出"})
        while True:
            first = await response.content.readline()
            if json.loads(first)["type"] == "token":
                break
        response.close()
        for _ in range(30):
            await asyncio.sleep(.1)
            messages = self.store.conversation(cid)["messages"]
            if len(messages) == 2:
                break
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[-1]["status"], "cancelled")
        self.assertGreaterEqual(messages[-1]["elapsed_ms"], 0)
        self.assertTrue(messages[-1]["content"])
        self.assertNotIn("逐字输出99", messages[-1]["content"])

    async def test_nonvision_and_unknown_model_rejected_without_inference(self):
        cid = await self.new_conversation()
        form = io.BytesIO(); Image.new("RGB", (10, 10)).save(form, "PNG")
        attachment = await self.upload("tiny.png", form.getvalue())
        for model, uploads in (("mock-text:latest", [attachment["id"]]), ("not-installed", [])):
            status, data = await self.request("POST", "/chat", json={"conversation_id": cid, "host": self.fixture.host, "model": model,
                      "text": "test", "upload_ids": uploads})
            self.assertEqual(status, 400, data)
        self.assertEqual(self.fixture.counts["ollama/chat"], 0)

    async def test_premature_eof_preserves_partial_answer_and_marks_error(self):
        app = web.Application()
        async def tags(request):
            return web.json_response({"models": [{"name": "mock-vision:latest", "size": 1}]})
        async def show(request):
            return web.json_response({"capabilities": ["completion", "vision"]})
        async def incomplete(request):
            response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson"})
            await response.prepare(request)
            await response.write(b'{"message":{"role":"assistant","content":"partial answer"},"done":false}\n')
            await response.write_eof()
            return response
        app.router.add_get("/api/tags", tags)
        app.router.add_post("/api/show", show)
        app.router.add_post("/api/chat", incomplete)
        runner = web.AppRunner(app); await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0); await site.start()
        upstream = "http://127.0.0.1:" + str(site._server.sockets[0].getsockname()[1])
        try:
            cid = await self.new_conversation()
            events = await self.chat(cid, host=upstream)
            self.assertEqual([event["type"] for event in events], ["token", "error"])
            self.assertIn("完成标记", events[-1]["message"])
            messages = self.store.conversation(cid)["messages"]
            self.assertEqual(messages[-1]["content"], "partial answer")
            self.assertEqual(messages[-1]["status"], "error")
        finally:
            await runner.cleanup()


if __name__ == "__main__": unittest.main()
