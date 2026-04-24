# LocalTexOCR

一个专为 **LaTeX 公式识别与格式化** 设计的本地轻量级工作台。

本项目基于 [Folio-OCR](https://github.com/vorojar/Folio-OCR) 进行二次开发与精简，去除了复杂的排版分析和 DOCX 导出，专注于将手写或印刷的数学公式、定理、习题快速转化为规范的 LaTeX 代码。

![LocalTexOCR 界面截图](demo.png)

---

## 💡 背景与说明

### 溯源
本项目 fork 自 [Folio-OCR](https://github.com/vorojar/Folio-OCR)（原作者：vorojar）。原项目是一个功能强大的三栏文档 OCR 工作台，支持版面分析、多格式导出以及基于 GLM-OCR 的通用识别。

### 为什么选择 LocalTexOCR？
与原项目相比，`LocalTexOCR` 更加“垂直”：
- **专注 LaTeX**：内置了针对数学公式和学术正文优化的提示词（Prompts）。
- **流程精简**：去掉了原版中对本场景不必要的“版面分析（Layout Detection）”，直接进行全页或选区的公式提取。
- **实时预览**：整合了 KaTeX 渲染引擎，OCR 识别出的 LaTeX 代码可以立即在右侧面板看到数学公式渲染效果，方便比对修正。
- **本地化隐私**：所有模型均运行在本地的 Ollama 容器/服务中，数据完全不出户。

---

## 🛠️ 技术架构

- **核心后端**: [FastAPI](https://fastapi.tiangolo.com/) (Python 3.10+)
- **OCR 引擎**: [Ollama](https://ollama.com/) 驱动的 `glm-ocr` 模型。
- **格式化引擎**: [Ollama](https://ollama.com/) 驱动的 `qwen2.5-coder` 模型（负责将 raw OCR 文本整理成规范的 LaTeX 结构，如 `equation` 环境、定理环境等）。
- **前端交互**: Vanilla JS + CSS (支持双栏对比、实时 KaTeX 渲染)。
- **数据库**: SQLite (保存文档轨迹与编辑历史)。

---

## 🚀 关于性能与显卡加速 (GPU)

很多用户关心识别速度是否可以更快，是否需要“选择显卡”。

### 核心结论
**本项目无需在代码中手动选择显卡。** 所有的显卡调用逻辑由 **Ollama** 后端自动接管：

1.  **NVIDIA (N卡)**: 只要你安装了支持 CUDA 的驱动，Ollama 在加载 `glm-ocr` 或 `qwen2.5-coder` 时会自动优先使用 GPU。
2.  **Mac (Apple Silicon)**: 在 M1/M2/M3/M5 系列芯片上，Ollama 会自动调用 **Metal (MPS)** 加速，速度非常快。
3.  **速度差异**: 
    - 使用 GPU 加速时，单页公式识别通常在 **0.5s - 2s** 左右。
    - 纯 CPU 模式下，速度可能会慢 5-10 倍，且系统风扇会狂转。

### 如何确认是否启用了加速？
- **Windows**: 识别时打开任务管理器，观察显卡的 `Dedicated GPU Memory` 或 `Compute` 占用。
- **Mac**: 识别时打开“活动监视器”，观察 `ollama` 进程的 GPU 使用率（% GPU）。

---

## 📥 快速开始

### 1. 环境准备
- 安装 [Ollama](https://ollama.com/)。
- 下载所需模型（在终端/命令行执行）：
  ```bash
  ollama pull glm-ocr:latest
  ollama pull qwen2.5-coder:3b
  ```

### 2. 启动服务
你可以直接运行预配置好的批处理脚本（Windows）：
```bash
run_workbench.bat
```
或者手动启动：
```bash
pip install -r requirements.txt
python server.py
```
然后访问 `http://localhost:3000`。

---

## 📝 常见问题 (FAQ)

**Q: 那个 “Code Model” (qwen2.5-coder) 是干什么的？**
A: `glm-ocr` 负责“看图识字”，但它输出的格式有时比较随意。`Code Model` 的作用像是一个“排版员”，它会根据预设的 LaTeX 铁律，将识别出来的散乱文本整理成标准的 `.tex` 源代码格式（例如自动包裹 `equation` 环境、处理定理环境等）。

**Q: 我发现加载很慢？**
A: 第一次运行时 Ollama 需要将约 2GB-4GB 的模型加载到显存/内存中（冷启动），这通常需要 10-30 秒。后续的连续识别会非常迅速。

---

## License
[MIT](LICENSE) | 基于 [Folio-OCR](https://github.com/vorojar/Folio-OCR) 修改。
