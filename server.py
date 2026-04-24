# -*- coding: utf-8 -*-
"""
LocalTexOCR Server - Ollama Backend
Handwritten LaTeX OCR + Code LLM formatting workbench
"""
import os
import uuid
import time
import asyncio
import base64
import logging
import shutil
import subprocess
import sqlite3
from contextlib import contextmanager
import httpx
from pathlib import Path
from datetime import datetime
from fastapi import FastAPI, UploadFile, File, HTTPException, Query
import json
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import re
from urllib.parse import quote
import fitz  # PyMuPDF
from PIL import Image
import io
from pydantic import BaseModel

# --- Config ---
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

OLLAMA_BASE  = os.environ.get("OLLAMA_BASE",  "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "glm-ocr:latest")
CODE_MODEL   = os.environ.get("CODE_MODEL",   "qwen2.5-coder:3b")

DEFAULT_OCR_PROMPT = (
    "精准识别图片中所有文字与数学公式。"
    "普通文字原样输出；行内公式用 $...$ 包裹；独立居中公式用 $$...$$ 包裹。"
    "只输出识别结果，不添加任何解释或多余内容。"
)

DEFAULT_FORMAT_PROMPT = r"""你是专业LaTeX纯格式化工具，仅对上面OCR结果内容做格式整理，严格执行以下所有规则，禁止任何变通：

以下是简化版LaTeX导言区，**仅作为语法、环境、宏包参考，绝对不输出导言区的任何代码**！！！
=====================================================================================
【简化核心参考导言（仅用于理解语法，禁止输出）】
\documentclass[12pt,a4paper]{article}
\usepackage[UTF8]{ctex}
\usepackage{amsmath,amssymb,amsthm}
\usepackage{mathtools}
\newcommand{\diff}{\mathop{}\!\mathrm{d}}
\newcommand{\R}{\mathbb{R}}
\theoremstyle{plain}
\newtheorem{theorem}{定理}[section]
\newtheorem{definition}{定义}[section]
\newtheorem{lemma}{引理}[theorem]
\newtheorem{corollary}{推论}[theorem]
=====================================================================================

【核心格式化铁律（必须严格执行，无任何例外）】
1. 输出限制：**只输出纯正文格式化后的LaTeX代码**，禁止输出导言、document环境、注释、解释、多余内容；
2. 公式智能分类（最关键）：
• 【重要独立公式】核心数学公式 → 用 \begin{equation} 公式 \end{equation} 单独成行，**禁止自动添加任何\label标签**；
• 【行内公式】普通/次要公式 → 保留 $...$ 格式，**直接与文本混排，不用text文本，不强制分行**；
• 多行对齐公式 → 用 \begin{equation}\begin{aligned} 第一行 \\ 第二行 \end{aligned}\end{equation}；
3. 语法红线：严禁用 $ 包裹 equation 环境，文本/描述文字绝对不放入公式环境；
4. 强制定理环境：文中出现「定理、定义、引理、推论」必须立即包裹对应环境；
5. 内容保护：100%保留原文文字、公式内容、符号、顺序，不修改公式内容、不增删文字；
6. 禁止额外操作：绝不自动添加\label、绝不新增文字、绝不修改原文结构。

原始OCR文本：
{ocr_text}"""

# --- Logging ---
LOG_FILE = Path(__file__).parent / "server.log"
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE, encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger.info(f"=== LocalTexOCR Server starting ===")

app = FastAPI(title="LocalTexOCR Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

# --- DB ---
DB_PATH = Path(os.environ.get("DB_PATH", Path(__file__).parent / "localtexocr.db"))

MAX_IMAGE_HEIGHT = 1600
SEGMENT_OVERLAP  = 80


def _init_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            doc_id     TEXT PRIMARY KEY,
            filename   TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pages (
            doc_id      TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
            num         INTEGER NOT NULL,
            filename    TEXT NOT NULL,
            ocr_text    TEXT,
            ocr_time    REAL,
            PRIMARY KEY (doc_id, num)
        );
        CREATE TABLE IF NOT EXISTS prompts (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            content    TEXT NOT NULL,
            type       TEXT NOT NULL DEFAULT 'format',
            created_at TEXT NOT NULL
        );
    """)
    conn.commit()

    # Migrate: add new columns to pages if missing
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(pages)")
    existing_cols = {row[1] for row in cur.fetchall()}
    for col, typedef in [
        ("formatted_text", "TEXT"),
        ("format_time",    "REAL"),
        ("prompt_id",      "INTEGER"),
    ]:
        if col not in existing_cols:
            conn.execute(f"ALTER TABLE pages ADD COLUMN {col} {typedef}")
    conn.commit()

    # Seed default prompts if empty
    count = conn.execute("SELECT COUNT(*) FROM prompts").fetchone()[0]
    if count == 0:
        now = datetime.now().isoformat()
        conn.execute(
            "INSERT INTO prompts (name, content, type, created_at) VALUES (?, ?, ?, ?)",
            ("默认OCR提示词", DEFAULT_OCR_PROMPT, "ocr", now),
        )
        conn.execute(
            "INSERT INTO prompts (name, content, type, created_at) VALUES (?, ?, ?, ?)",
            ("默认格式化提示词", DEFAULT_FORMAT_PROMPT, "format", now),
        )
        conn.commit()
    conn.close()


@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


_init_db()

# Shared httpx client
_http_client: httpx.AsyncClient | None = None


@app.on_event("startup")
async def startup_event():
    global _http_client
    # Use direct transports for localhost so system proxies are bypassed
    _http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(300.0),
        mounts={
            "http://localhost":  httpx.AsyncHTTPTransport(),
            "http://127.0.0.1": httpx.AsyncHTTPTransport(),
        },
    )
    with get_db() as conn:
        rows = conn.execute("SELECT doc_id FROM documents").fetchall()
        known_ids = {r["doc_id"] for r in rows}
    for child in UPLOAD_DIR.iterdir():
        if child.is_dir() and child.name not in known_ids:
            logger.info(f"[cleanup] Removing orphan directory: {child}")
            shutil.rmtree(child, ignore_errors=True)


@app.on_event("shutdown")
async def shutdown_event():
    global _http_client
    if _http_client:
        await _http_client.aclose()


# --- Ollama helpers ---

async def check_ollama() -> dict:
    try:
        resp = await _http_client.get(f"{OLLAMA_BASE}/api/tags", timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
        models = [m["name"] for m in data.get("models", [])]
        has_model = any(OLLAMA_MODEL in m for m in models)
        return {"online": True, "model_loaded": has_model, "models": models}
    except Exception:
        return {"online": False, "model_loaded": False, "models": []}


async def ensure_ollama_running() -> dict:
    ollama = await check_ollama()
    if ollama["online"]:
        return ollama
    logger.info("[ollama] Not running, attempting to start ollama serve...")
    try:
        subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except FileNotFoundError:
        raise HTTPException(500, "Ollama not found. Please install Ollama first.")
    for i in range(60):
        await asyncio.sleep(0.5)
        ollama = await check_ollama()
        if ollama["online"]:
            return ollama
    raise HTTPException(500, "Failed to start Ollama after 30s")


# --- OCR helpers ---

def _image_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _split_image(img: Image.Image) -> list[Image.Image]:
    w, h = img.size
    step = MAX_IMAGE_HEIGHT - SEGMENT_OVERLAP
    segments, y = [], 0
    while y < h:
        bottom = min(y + MAX_IMAGE_HEIGHT, h)
        segments.append(img.crop((0, y, w, bottom)))
        y += step
        if bottom == h:
            break
    return segments


async def _ocr_single(image_b64: str, model: str, prompt: str) -> str:
    resp = await _http_client.post(
        f"{OLLAMA_BASE}/api/chat",
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
            "stream": False,
        },
    )
    resp.raise_for_status()
    return resp.json().get("message", {}).get("content", "")


async def ocr_image(image_path: str, model: str, prompt: str) -> str:
    img = Image.open(image_path).convert("RGB")
    segments = _split_image(img) if img.size[1] > MAX_IMAGE_HEIGHT else [img]
    results = []
    for seg in segments:
        text = await _ocr_single(_image_to_b64(seg), model, prompt)
        if text:
            results.append(text)
    img.close()
    return "\n\n".join(results)


def _get_prompt(conn, prompt_id: int | None, default: str) -> str:
    if prompt_id is None:
        return default
    row = conn.execute("SELECT content FROM prompts WHERE id=?", (prompt_id,)).fetchone()
    return row["content"] if row else default


# --- Path helpers ---

def _safe_doc_path(doc_id: str, filename: str = "") -> Path:
    doc_dir = (UPLOAD_DIR / doc_id).resolve()
    if not str(doc_dir).startswith(str(UPLOAD_DIR.resolve())):
        raise HTTPException(403, "Invalid document ID")
    if filename:
        file_path = (doc_dir / filename).resolve()
        if not str(file_path).startswith(str(doc_dir)):
            raise HTTPException(403, "Invalid filename")
        return file_path
    return doc_dir


# ===================== ENDPOINTS =====================

@app.get("/", response_class=HTMLResponse)
async def root():
    with open("index.html", "r", encoding="utf-8") as f:
        return f.read()


@app.get("/api/status")
async def status():
    ollama = await check_ollama()
    return {
        "status": "running",
        "model_loaded": ollama["model_loaded"],
        "device": "ollama",
    }


@app.get("/api/models")
async def list_models():
    ollama = await check_ollama()
    return {"models": ollama["models"], "online": ollama["online"]}


# --- Prompts CRUD ---

class _PromptRequest(BaseModel):
    name: str
    content: str
    type: str = "format"


@app.get("/api/prompts")
async def list_prompts(type: str = Query(None)):
    with get_db() as conn:
        if type:
            rows = conn.execute(
                "SELECT * FROM prompts WHERE type=? ORDER BY id", (type,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM prompts ORDER BY id").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/prompts")
async def create_prompt(req: _PromptRequest):
    now = datetime.now().isoformat()
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO prompts (name, content, type, created_at) VALUES (?, ?, ?, ?)",
            (req.name, req.content, req.type, now),
        )
        new_id = cur.lastrowid
    return {"id": new_id, "name": req.name, "content": req.content,
            "type": req.type, "created_at": now}


@app.put("/api/prompts/{prompt_id}")
async def update_prompt(prompt_id: int, req: _PromptRequest):
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE prompts SET name=?, content=?, type=? WHERE id=?",
            (req.name, req.content, req.type, prompt_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Prompt not found")
    return {"success": True}


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: int):
    with get_db() as conn:
        cur = conn.execute("DELETE FROM prompts WHERE id=?", (prompt_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Prompt not found")
    return {"success": True}


# --- Upload ---

ALLOWED_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.pdf'}


@app.post("/api/upload")
async def upload_files(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(400, "No files provided")
    for f in files:
        if Path(f.filename).suffix.lower() not in ALLOWED_SUFFIXES:
            raise HTTPException(400, f"Unsupported file type: {f.filename}")

    file_data: list[tuple[str, str, bytes]] = []
    for f in files:
        suffix = Path(f.filename).suffix.lower()
        content = await f.read()
        file_data.append((f.filename, suffix, content))

    doc_id = str(uuid.uuid4())
    doc_dir = UPLOAD_DIR / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)
    display_name = file_data[0][0] if len(file_data) == 1 else f"{len(file_data)} files"
    created_at = datetime.now().isoformat()

    with get_db() as conn:
        conn.execute(
            "INSERT INTO documents (doc_id, filename, created_at) VALUES (?, ?, ?)",
            (doc_id, display_name, created_at),
        )

    async def generate():
        page_num = 0
        yield f"data: {json.dumps({'type': 'init', 'doc_id': doc_id, 'filename': display_name})}\n\n"

        for fname, suffix, content in file_data:
            if suffix == ".pdf":
                pdf_path = doc_dir / f"src_{uuid.uuid4().hex[:8]}.pdf"
                with open(pdf_path, "wb") as fp:
                    fp.write(content)
                mat = fitz.Matrix(2.0, 2.0)
                doc = fitz.open(str(pdf_path))
                for fitz_page in doc:
                    page_num += 1
                    pix = fitz_page.get_pixmap(matrix=mat)
                    img_name = f"page_{page_num:03d}.png"
                    pix.save(str(doc_dir / img_name))
                    with get_db() as conn:
                        conn.execute(
                            "INSERT INTO pages (doc_id, num, filename) VALUES (?, ?, ?)",
                            (doc_id, page_num, img_name),
                        )
                    yield f"data: {json.dumps({'type': 'page', 'page': _page_info(doc_id, page_num, img_name)})}\n\n"
                    await asyncio.sleep(0)
                doc.close()
                pdf_path.unlink(missing_ok=True)
            else:
                page_num += 1
                img_name = f"page_{page_num:03d}{suffix}"
                with open(doc_dir / img_name, "wb") as fp:
                    fp.write(content)
                with get_db() as conn:
                    conn.execute(
                        "INSERT INTO pages (doc_id, num, filename) VALUES (?, ?, ?)",
                        (doc_id, page_num, img_name),
                    )
                yield f"data: {json.dumps({'type': 'page', 'page': _page_info(doc_id, page_num, img_name)})}\n\n"
                await asyncio.sleep(0)

        yield f"data: {json.dumps({'type': 'done', 'page_count': page_num})}\n\n"
        logger.info(f"[upload] {display_name} -> {doc_id}, {page_num} page(s)")

    return StreamingResponse(generate(), media_type="text/event-stream")


def _page_info(doc_id: str, num: int, filename: str, page_row=None) -> dict:
    """Build a page info dict for API responses."""
    if page_row:
        return {
            "num": page_row["num"],
            "filename": page_row["filename"],
            "image_url": f"/api/images/{doc_id}/{page_row['filename']}",
            "ocr_text": page_row["ocr_text"],
            "ocr_time": page_row["ocr_time"],
            "formatted_text": page_row["formatted_text"],
            "format_time": page_row["format_time"],
        }
    return {
        "num": num,
        "filename": filename,
        "image_url": f"/api/images/{doc_id}/{filename}",
        "ocr_text": None,
        "ocr_time": None,
        "formatted_text": None,
        "format_time": None,
    }


@app.get("/api/images/{doc_id}/{filename}")
async def get_image(doc_id: str, filename: str):
    file_path = _safe_doc_path(doc_id, filename)
    if not file_path.exists():
        raise HTTPException(404, "Image not found")
    return FileResponse(file_path, media_type="image/png")


# --- OCR endpoints ---

@app.post("/api/ocr/{doc_id}/all")
async def ocr_all_pages(
    doc_id: str,
    model: str = Query(None),
    prompt_id: int = Query(None),
):
    with get_db() as conn:
        doc_row = conn.execute(
            "SELECT * FROM documents WHERE doc_id=?", (doc_id,)
        ).fetchone()
        if doc_row is None:
            raise HTTPException(404, "Document not found")
        pages = conn.execute(
            "SELECT * FROM pages WHERE doc_id=? ORDER BY num", (doc_id,)
        ).fetchall()
        ocr_prompt = _get_prompt(conn, prompt_id, DEFAULT_OCR_PROMPT)

    ocr_model = model or OLLAMA_MODEL
    results = []

    for page in pages:
        if page["ocr_text"] is not None:
            results.append({
                "page_num": page["num"], "text": page["ocr_text"],
                "time": page["ocr_time"], "cached": True,
            })
            continue
        image_path = _safe_doc_path(doc_id, page["filename"])
        try:
            t0 = time.time()
            text = await ocr_image(str(image_path), ocr_model, ocr_prompt)
            elapsed = round(time.time() - t0, 2)
            with get_db() as conn:
                conn.execute(
                    "UPDATE pages SET ocr_text=?, ocr_time=? WHERE doc_id=? AND num=?",
                    (text, elapsed, doc_id, page["num"]),
                )
            results.append({"page_num": page["num"], "text": text, "time": elapsed, "cached": False})
        except Exception as e:
            logger.error(f"[OCR] Page {page['num']} error: {e}", exc_info=True)
            results.append({"page_num": page["num"], "text": None, "time": None, "error": str(e)})

    return {"doc_id": doc_id, "filename": doc_row["filename"], "results": results}


@app.post("/api/ocr/{doc_id}/{page_num}")
async def ocr_single_page(
    doc_id: str,
    page_num: int,
    model: str = Query(None),
    prompt_id: int = Query(None),
    force: bool = Query(False),
):
    with get_db() as conn:
        page = conn.execute(
            "SELECT * FROM pages WHERE doc_id=? AND num=?", (doc_id, page_num)
        ).fetchone()
        ocr_prompt = _get_prompt(conn, prompt_id, DEFAULT_OCR_PROMPT)

    if page is None:
        raise HTTPException(404, f"Page {page_num} not found")
    if page["ocr_text"] is not None and not force:
        return {
            "doc_id": doc_id, "page_num": page_num,
            "text": page["ocr_text"], "time": page["ocr_time"], "cached": True,
        }

    ocr_model = model or OLLAMA_MODEL
    image_path = _safe_doc_path(doc_id, page["filename"])
    if not image_path.exists():
        raise HTTPException(404, "Image file not found")

    try:
        t0 = time.time()
        text = await ocr_image(str(image_path), ocr_model, ocr_prompt)
        elapsed = round(time.time() - t0, 2)
        with get_db() as conn:
            conn.execute(
                "UPDATE pages SET ocr_text=?, ocr_time=? WHERE doc_id=? AND num=?",
                (text, elapsed, doc_id, page_num),
            )
        return {"doc_id": doc_id, "page_num": page_num, "text": text, "time": elapsed, "cached": False}
    except httpx.HTTPStatusError as e:
        raise HTTPException(500, f"OCR failed: {e.response.text}")
    except Exception as e:
        logger.error(f"[OCR] Error: {e}", exc_info=True)
        raise HTTPException(500, f"OCR failed: {e}")


# --- Format endpoints (ALL must come BEFORE /{page_num}) ---

class _FormatRequest(BaseModel):
    code_model: str | None = None
    prompt_id: int | None = None


@app.post("/api/format/{doc_id}/all")
async def format_all_pages(doc_id: str, req: _FormatRequest):
    with get_db() as conn:
        doc_row = conn.execute(
            "SELECT * FROM documents WHERE doc_id=?", (doc_id,)
        ).fetchone()
        if doc_row is None:
            raise HTTPException(404, "Document not found")
        pages = conn.execute(
            "SELECT * FROM pages WHERE doc_id=? ORDER BY num", (doc_id,)
        ).fetchall()
        fmt_prompt_template = _get_prompt(conn, req.prompt_id, DEFAULT_FORMAT_PROMPT)

    code_model = req.code_model or CODE_MODEL
    results = []

    for page in pages:
        if not page["ocr_text"]:
            results.append({"page_num": page["num"], "skipped": True, "reason": "no_ocr_text"})
            continue
        try:
            full_prompt = fmt_prompt_template
            
            # Ensure the ocr_text is injected
            if "{ocr_text}" in full_prompt:
                full_prompt = full_prompt.replace("{ocr_text}", page["ocr_text"])
            else:
                full_prompt = full_prompt.strip() + "\n\n【必须进行处理的原始内容】\n" + page["ocr_text"]
                
            sys_msg = "你是一个无情的LaTeX转化引擎。严格执行转换规则，并且必须处理用户提供的【全部】内容。拒绝任何废话，绝不要输出'好的'或'请提供'等自然语言！直接且只输出LaTeX代码即可！"
            logger.info(f"Formatting page {page['num']} with text length: {len(page['ocr_text'])}")
            
            t0 = time.time()
            resp = await _http_client.post(
                f"{OLLAMA_BASE}/api/chat",
                json={"model": code_model, "messages": [
                    {"role": "system", "content": sys_msg},
                    {"role": "user", "content": full_prompt}
                ], "stream": False},
            )
            resp.raise_for_status()
            fmt_text = resp.json().get("message", {}).get("content", "")
            elapsed = round(time.time() - t0, 2)
            with get_db() as conn:
                conn.execute(
                    "UPDATE pages SET formatted_text=?, format_time=?, prompt_id=? WHERE doc_id=? AND num=?",
                    (fmt_text, elapsed, req.prompt_id, doc_id, page["num"]),
                )
            results.append({"page_num": page["num"], "formatted_text": fmt_text, "format_time": elapsed})
        except Exception as e:
            logger.error(f"[Format] Page {page['num']} error: {e}", exc_info=True)
            results.append({"page_num": page["num"], "error": str(e)})

    return {"doc_id": doc_id, "results": results}


@app.post("/api/format/{doc_id}/{page_num}")
async def format_single_page(doc_id: str, page_num: int, req: _FormatRequest):
    with get_db() as conn:
        page = conn.execute(
            "SELECT * FROM pages WHERE doc_id=? AND num=?", (doc_id, page_num)
        ).fetchone()
        fmt_prompt_template = _get_prompt(conn, req.prompt_id, DEFAULT_FORMAT_PROMPT)

    if page is None:
        raise HTTPException(404, f"Page {page_num} not found")
        
    if not page["ocr_text"]:
        raise HTTPException(400, "Page has no OCR text to format")

    code_model = req.code_model or CODE_MODEL
    full_prompt = fmt_prompt_template
    
    if "{ocr_text}" in full_prompt:
        full_prompt = full_prompt.replace("{ocr_text}", page["ocr_text"])
    else:
        full_prompt = full_prompt.strip() + "\n\n【必须进行处理的原始内容】\n" + page["ocr_text"]

    sys_msg = "你是一个无情的LaTeX转化引擎。严格执行转换规则，并且必须处理用户提供的【全部】内容。拒绝任何废话，绝不要输出'好的'或'请提供'等自然语言！直接且只输出LaTeX代码即可！"
    logger.info(f"Formatting page {page_num} with text length: {len(page['ocr_text'])}")

    try:
        t0 = time.time()
        resp = await _http_client.post(
            f"{OLLAMA_BASE}/api/chat",
            json={"model": code_model, "messages": [
                {"role": "system", "content": sys_msg},
                {"role": "user", "content": full_prompt}
            ], "stream": False},
        )
        resp.raise_for_status()
        fmt_text = resp.json().get("message", {}).get("content", "")
        elapsed = round(time.time() - t0, 2)

        with get_db() as conn:
            conn.execute(
                "UPDATE pages SET formatted_text=?, format_time=?, prompt_id=? WHERE doc_id=? AND num=?",
                (fmt_text, elapsed, req.prompt_id, doc_id, page_num),
            )

        return {
            "doc_id": doc_id, "page_num": page_num,
            "formatted_text": fmt_text, "format_time": elapsed,
        }
    except httpx.HTTPStatusError as e:
        raise HTTPException(500, f"Format failed: {e.response.text}")
    except Exception as e:
        logger.error(f"[Format] Error: {e}", exc_info=True)
        raise HTTPException(500, f"Format failed: {e}")


# --- Export .tex ---

@app.post("/api/export-tex/{doc_id}")
async def export_tex(doc_id: str):
    with get_db() as conn:
        doc_meta = conn.execute(
            "SELECT * FROM documents WHERE doc_id=?", (doc_id,)
        ).fetchone()
        if doc_meta is None:
            raise HTTPException(404, "Document not found")
        pages = conn.execute(
            "SELECT * FROM pages WHERE doc_id=? ORDER BY num", (doc_id,)
        ).fetchall()

    parts = []
    for p in pages:
        text = p["formatted_text"] or p["ocr_text"] or ""
        if len(pages) > 1:
            parts.append(f"% === Page {p['num']} ===\n{text}")
        else:
            parts.append(text)
    content = "\n\n".join(parts)

    safe_name = (doc_meta["filename"] or "document").rsplit(".", 1)[0] + ".tex"
    encoded_name = quote(safe_name)

    return StreamingResponse(
        iter([content.encode("utf-8")]),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


# --- Document CRUD ---

@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT doc_id FROM documents WHERE doc_id=?", (doc_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Document not found")
        conn.execute("DELETE FROM documents WHERE doc_id=?", (doc_id,))
    doc_dir = _safe_doc_path(doc_id)
    if doc_dir.exists():
        shutil.rmtree(doc_dir, ignore_errors=True)
    logger.info(f"[delete] Document {doc_id} removed")
    return {"success": True}


class _SaveTextRequest(BaseModel):
    text: str


@app.put("/api/pages/{doc_id}/{page_num}/text")
async def save_page_text(doc_id: str, page_num: int, req: _SaveTextRequest):
    with get_db() as conn:
        # User explicitly edits textarea -> always update ocr_text to be the new base truth
        # Also clear the formatted_text so it gets evaluated correctly.
        cur = conn.execute(
            "UPDATE pages SET ocr_text=?, formatted_text=NULL, format_time=NULL WHERE doc_id=? AND num=?",
            (req.text, doc_id, page_num),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Page not found")
    return {"success": True}


@app.get("/api/documents")
async def list_documents():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT d.doc_id, d.filename, d.created_at,
                   COUNT(p.num) AS page_count,
                   SUM(CASE WHEN p.ocr_text IS NOT NULL THEN 1 ELSE 0 END) AS ocr_count,
                   SUM(CASE WHEN p.formatted_text IS NOT NULL THEN 1 ELSE 0 END) AS fmt_count
            FROM documents d
            LEFT JOIN pages p ON d.doc_id = p.doc_id
            GROUP BY d.doc_id
            ORDER BY d.created_at DESC
        """).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/documents/{doc_id}")
async def get_document(doc_id: str):
    with get_db() as conn:
        doc_row = conn.execute(
            "SELECT * FROM documents WHERE doc_id=?", (doc_id,)
        ).fetchone()
        if doc_row is None:
            raise HTTPException(404, "Document not found")
        pages = conn.execute(
            "SELECT * FROM pages WHERE doc_id=? ORDER BY num", (doc_id,)
        ).fetchall()
    return {
        "doc_id": doc_row["doc_id"],
        "filename": doc_row["filename"],
        "created_at": doc_row["created_at"],
        "pages": [_page_info(doc_id, p["num"], p["filename"], p) for p in pages],
    }


# Static files — must be last
app.mount("/", StaticFiles(directory="."), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
