# -*- coding: utf-8 -*-
"""
CRB-V2V-CPABDS 演示系统 V2 - Flask 后端

与 V1 的差异（V1 保持零改动）：
  - 默认端口 5001（可 --port 覆盖），可与 V1(:5000) 并行运行；
  - DATA_DIR 通过环境变量 DEMO_DATA_DIR 覆盖；部署包优先使用 ./data，
    本地旧目录结构回退到 ../data；
  - gzip 压缩（flask-compress，缺失时回退内置 gzip）；
  - /api/scenario/* 静态数据带 ETag / Cache-Control（数据不变则 304）。

启动：
    python app.py                 # http://localhost:5001
    DEMO_DATA_DIR=/path/to/data python app.py --port 5001
"""

import argparse
import gzip
import hashlib
import json
import os

from flask import Flask, jsonify, make_response, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_STATIC_DIR = os.path.join(BASE_DIR, "public", "static")
app = Flask(
    __name__,
    static_folder=PUBLIC_STATIC_DIR,
    static_url_path="/static",
    template_folder="templates",
)

BUNDLED_DATA_DIR = os.path.join(BASE_DIR, "data")
LEGACY_DATA_DIR = os.path.join(BASE_DIR, "..", "data")
DEFAULT_DATA_DIR = (
    BUNDLED_DATA_DIR if os.path.isdir(BUNDLED_DATA_DIR) else LEGACY_DATA_DIR
)
DATA_DIR = os.path.abspath(
    os.environ.get("DEMO_DATA_DIR", DEFAULT_DATA_DIR)
)

# gzip：优先 flask-compress；缺失时用内置 after_request 兜底
try:
    from flask_compress import Compress

    Compress(app)
    _HAVE_COMPRESS = True
except ImportError:  # pragma: no cover - 环境兜底
    _HAVE_COMPRESS = False

    @app.after_request
    def _fallback_gzip(resp):
        accept = request.headers.get("Accept-Encoding", "")
        if (
            "gzip" in accept
            and resp.status_code == 200
            and not resp.direct_passthrough
            and resp.content_length is not None
            and resp.content_length > 1024
            and "Content-Encoding" not in resp.headers
            and resp.mimetype in ("application/json", "text/html", "text/css",
                                  "application/javascript", "application/geo+json")
        ):
            resp.set_data(gzip.compress(resp.get_data(), compresslevel=6))
            resp.headers["Content-Encoding"] = "gzip"
            resp.headers["Content-Length"] = str(len(resp.get_data()))
            resp.headers.add("Vary", "Accept-Encoding")
        return resp


def _scenario_path(scenario_id, filename):
    """场景数据文件路径；防目录穿越。"""
    path = os.path.abspath(os.path.join(DATA_DIR, scenario_id, filename))
    if not path.startswith(DATA_DIR + os.sep):
        return None
    return path


_file_cache = {}


def _send_json_file(path, cache_control="public, max-age=3600"):
    """发送数据文件（内存缓存 + ETag/304 + 可被 gzip 压缩的普通响应）。

    不用 send_file：其直通(passthrough)响应会被 flask-compress 跳过，
    1.6MB 的 frames.json 将失去 ~10× 压缩收益。
    """
    stat = os.stat(path)
    etag = f'"{stat.st_mtime_ns}-{stat.st_size}"'
    if request.if_none_match and etag.strip('"') in request.if_none_match:
        resp = make_response("", 304)
        resp.headers["ETag"] = etag
        resp.headers["Cache-Control"] = cache_control
        return resp

    cached = _file_cache.get(path)
    if cached is None or cached[0] != stat.st_mtime_ns or cached[1] != stat.st_size:
        with open(path, "rb") as f:
            _file_cache[path] = (stat.st_mtime_ns, stat.st_size, f.read())
        cached = _file_cache[path]
    resp = make_response(cached[2])
    resp.mimetype = "application/json"
    resp.headers["ETag"] = etag
    resp.headers["Cache-Control"] = cache_control
    return resp


def _json_with_etag(payload):
    """动态 JSON 的 ETag/304（用于 timeline 等转换型响应）。"""
    body = json.dumps(payload, ensure_ascii=False)
    etag = hashlib.md5(body.encode("utf-8")).hexdigest()
    if request.if_none_match and etag in request.if_none_match:
        resp = make_response("", 304)
    else:
        resp = make_response(body)
        resp.mimetype = "application/json"
    resp.set_etag(etag)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


def load_json(path):
    """加载 JSON 文件（进程内缓存）。"""
    if not hasattr(load_json, "_cache"):
        load_json._cache = {}
    if path not in load_json._cache:
        with open(path, "r", encoding="utf-8") as f:
            load_json._cache[path] = json.load(f)
    return load_json._cache[path]


# ============ 页面 ============


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/favicon.ico")
def favicon():
    """Avoid a browser-generated 404 in console-only smoke tests."""
    return make_response("", 204)


# ============ 只读 API（保留 V1 的 6 个端点，另加可选对比结果端点） ============


@app.route("/api/scenarios")
def api_scenarios():
    scenarios_path = os.path.join(DATA_DIR, "scenarios.json")
    if os.path.exists(scenarios_path):
        return _send_json_file(scenarios_path)
    # 自动扫描兜底（与 V1 行为一致）
    scenarios = []
    for d in sorted(os.listdir(DATA_DIR)):
        meta_path = os.path.join(DATA_DIR, d, "meta.json")
        if os.path.exists(meta_path):
            meta = load_json(meta_path)
            scenarios.append(
                {
                    "id": d,
                    "name": f"{meta['attack_label'].replace('_', ' ').title()} - {meta['map']}",
                    "attack_label": meta["attack_label"],
                    "map": meta["map"],
                    "num_frames": meta["num_frames"],
                    "num_vehicles": meta["num_vehicles"],
                    "adversary_cav_ids": meta["adversary_cav_ids"],
                }
            )
    return _json_with_etag(scenarios)


@app.route("/api/scenario/<scenario_id>/meta")
def api_scenario_meta(scenario_id):
    path = _scenario_path(scenario_id, "meta.json")
    if not path or not os.path.exists(path):
        return jsonify({"error": "Scenario not found"}), 404
    return _send_json_file(path)


@app.route("/api/scenario/<scenario_id>/frames")
def api_scenario_frames(scenario_id):
    path = _scenario_path(scenario_id, "frames.json")
    if not path or not os.path.exists(path):
        return jsonify({"error": "Frames not found"}), 404
    return _send_json_file(path)


@app.route("/api/scenario/<scenario_id>/frame/<int:frame_idx>")
def api_scenario_frame(scenario_id, frame_idx):
    path = _scenario_path(scenario_id, "frames.json")
    if not path or not os.path.exists(path):
        return jsonify({"error": "Frames not found"}), 404
    frames = load_json(path)
    if 0 <= frame_idx < len(frames):
        return jsonify(frames[frame_idx])
    return jsonify({"error": "Frame index out of range"}), 404


@app.route("/api/scenario/<scenario_id>/reputation")
def api_scenario_reputation(scenario_id):
    path = _scenario_path(scenario_id, "reputation.json")
    if not path or not os.path.exists(path):
        return jsonify({"error": "Reputation data not found"}), 404
    return _send_json_file(path)


@app.route("/api/scenario/<scenario_id>/comparison")
def api_scenario_comparison(scenario_id):
    """可选三算法离线对比结果。

    comparison.json 仅由预注册实验流程生成；绝不从现有 reputation/trust_logs
    推导或补造基线结果。文件缺失是正常的“尚未运行”状态，供前端显示明确门禁。
    """
    path = _scenario_path(scenario_id, "comparison.json")
    if not path or not os.path.exists(path):
        return jsonify(
            {
                "scenario_id": scenario_id,
                "status": "not_run",
                "reason": (
                    "尚未生成同源、因果、无标签泄漏的三算法 comparison.json；"
                    "现有 trust_logs 不能作为 DRAMBR/PlexeMDS 输入。"
                ),
            }
        ), 404
    # comparison.json is replaced atomically when a newly verified formal run
    # is published. Revalidate it on every page load so an hour-old reputation
    # curve cannot survive the publication event in a browser cache.
    return _send_json_file(path, "no-cache")


@app.route("/api/scenario/<scenario_id>/timeline")
def api_scenario_timeline(scenario_id):
    rep_path = _scenario_path(scenario_id, "reputation.json")
    if not rep_path or not os.path.exists(rep_path):
        return jsonify({"error": "Reputation data not found"}), 404

    meta_path = _scenario_path(scenario_id, "meta.json")
    meta = load_json(meta_path) if meta_path and os.path.exists(meta_path) else {}
    cav_ids = set(meta.get("cav_ids", []))

    rep_data = load_json(rep_path)
    timeline = [
        {
            "frame_idx": snap["frame_idx"],
            "timestamp": snap["timestamp"],
            "reputations": {
                vid: score
                for vid, score in snap["reputations"].items()
                if vid in cav_ids
            },
        }
        for snap in rep_data.get("timeline", [])
    ]
    return _json_with_etag(timeline)


# ============ 启动 ============

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CRB-V2V-CPABDS Demo Server V2")
    parser.add_argument("--port", type=int, default=5001, help="Port number")
    parser.add_argument("--host", default="0.0.0.0", help="Host address")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")
    args = parser.parse_args()

    print(f"[V2] Demo server: http://{args.host}:{args.port}")
    print(f"[V2] Data directory: {DATA_DIR} (readonly, set DEMO_DATA_DIR to override)")
    print(f"[V2] gzip: {'flask-compress' if _HAVE_COMPRESS else 'builtin fallback'}")
    app.run(host=args.host, port=args.port, debug=args.debug)
