# ChemDraw Bridge · 中文操作说明

这个插件把化合物身份或文献结构变成**可直接编辑的 ChemDraw 源文件**，目前有六个工具：

| 工具 | 用途 |
| --- | --- |
| `search_compounds` | 名称模糊搜索，返回候选（CID、CAS、分子式、来源、匹配度） |
| `import_scifinder` | 读取登录 SciFinder 后导出的 SDF/CSV，返回结构候选 |
| `recognize_image` | 对没有名称的结构图做识图，返回 SMILES 候选 |
| `draw_from_identifier` | 已知 **CAS 号 / 英文名 / CID / SMILES**，生成结构 |
| `draw_reaction` | 由反应物/产物 SMILES 生成一步反应式草稿 |
| `draw_from_paper` | 给一篇**论文或补充材料 PDF**和化合物编号（如 `3a`），从文献里提取结构 |

输出文件：

- `.cdxml`：ChemDraw 原生 XML 源文件，双击即可打开、编辑；
- `.cdx`：ChemDraw 二进制源文件，适合在 Word 里作为 ChemDraw 对象插入；
- `.meta.json`：生成记录，含来源、CAS/CID、分子式、InChIKey、SMILES、ChemDraw 版本和校验结果。

---

## 1. 最快用法：直接在对话里说

不需要记参数，直接描述即可：

- “用 `draw_from_identifier` 生成 **50-78-2**，要 cdx”
- “先用 `search_compounds` 搜一下 **asprin**，把候选列出来让我选”
- “帮我画**阿司匹林**，CAS 50-78-2，只要 cdxml”
- “生成**胆固醇**的 ChemDraw 源文件”
- “从 **10.1039/c7cc02426f** 这篇文献的 SI 里提取 **3a**，PDF 在 `E:\...\source-si.pdf`”

模型会调用对应工具，并把生成的文件路径返回给你。

---

## 2. 工具一：`draw_from_identifier`

### 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `identifier` | 是 | CAS 号（如 `50-78-2`）、英文/IUPAC 名（如 `aspirin`）、`CID:2244` 或 `SMILES:<smiles>` |
| `output_dir` | 否 | 输出目录；默认是当前工作目录下的 `chemdraw` |
| `file_name` | 否 | 文件名（不含扩展名）；默认“标题 (CID xxx)” |
| `also_cdx` | 否 | 同时输出 `.cdx`，默认 `false` |
| `overwrite` | 否 | 覆盖同名文件；默认 `false`，重名会自动加 `(2)`、`(3)` |
| `auto_select` | 否 | 多个模糊候选时直接取匹配度最高的一个，不弹选择；默认 `false` |

### 模糊搜索与选择

名称不必拼得完全准确：

1. 插件先用 PubChem 自动补全，并对较短前缀再做几次探测，以覆盖常见拼写错误（`asprin` → `aspirin`，`caffiene` → `caffeine`）；
2. 再用 ChemicalBook 做补充搜索（它没有公开 API，失败时自动跳过）；
3. 只有一个精确匹配时，直接生成；
4. 有多个候选时，`draw_from_identifier` 会返回候选列表，并提示先用 `search_compounds`；
5. 操作者在候选中选定一个后，用对应的 `CID:<cid>` 再调用 `draw_from_identifier`。

CAS 号和显式 CID 不参与模糊匹配，直接精确处理。

SciFinder 的网页 API 需要 OAuth/ELN 授权，返回的是 SciFinder 网页里的路径，不是结果数据；所以采用“登录后导出、插件读取”的方式，结构最可靠。

### SciFinder 导出

1. 在已登录的 SciFinder 中检索并选中目标化合物；
2. 导出 **SDF**（首选，带权威结构）或带 CAS 号的 **CSV/TSV**；
3. 调用 `import_scifinder(file_path="...")`；
4. 操作者从候选里选择；
5. 用 `draw_from_identifier(identifier="SMILES:<smiles>")` 生成，CSV 已解析出 PubChem CID 时也可用 `CID:<cid>`。

支持 `.sdf`、`.csv`、`.tsv`、`.txt`。SDF 用 RDKit 读取，ChemDraw 生成后再核对 CDXML，不依赖名称查库。

### 识图与反应式

没有 IUPAC 名称的结构图，可以先裁剪成清晰图片再识图：

```text
recognize_image(image_path="E:\\figs\\compound.png")
recognize_image(pdf_path="E:\\paper.pdf", page=5, box=[100, 200, 360, 430])
```

OSRA 识别后用 RDKit 校验，返回 SMILES/分子式候选。**这是候选，不是已确认的身份**：手性、电荷、同位素和缩写基团都可能识别错；`PhthN`、`MQ`、`Boc` 这类缩写无法从像素还原，工具会拒绝而不是猜。确认后再用 `draw_from_identifier(identifier="SMILES:<smiles>")` 生成。

有一组确定的反应物/产物 SMILES 时，可以画一步反应式草稿：

```text
draw_reaction(
  reactants=["CCO"],
  products=["CC=O"],
  conditions="Pd(OAc)2, 80 °C",
  yield_text="82%",
  also_cdx=true
)
```

箭头、条件、收率会放进同一个 ChemDraw 文件；方向、化学计量和条件仍需人工核对。

### 输入规则

1. **CAS 号最可靠**。插件会先算 CAS 校验位，校验位错误直接拒绝；再到 PubChem 查，并要求该 CAS 出现在对应记录的同义词里。
2. **英文/IUPAC 名**会先做模糊搜索；有多个候选时由操作者选择，不会直接猜一个。只有一个精确匹配时才直接生成。
3. **中文名**会先尝试 ChemicalBook；最可靠的输入仍是 CAS 号。

### `search_compounds`

只想先看候选、不生成文件时，可以单独调用：

```text
search_compounds(query="asprin", limit=6)
```

返回按匹配度排序的候选，含 CID、CAS、分子式、来源和匹配度。把候选展示给操作者，选定后用对应的 `CID:<cid>` 调用 `draw_from_identifier`。

### `import_scifinder`

```text
import_scifinder(file_path="E:\\...\\scifinder-export.sdf", query="aspirin")
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `file_path` | 是 | SciFinder 导出的 `.sdf`（首选）、`.csv`、`.tsv` 或 `.txt` |
| `query` | 否 | 用于标注/排序的可选名称 |
| `limit` | 否 | 最多候选数，1–20，默认 10 |

返回候选，每个候选带 `SMILES`；选择后用 `draw_from_identifier(identifier="SMILES:<smiles>")` 生成。CSV 已解析出 PubChem CID 时也可用 `CID:<cid>`。

### 示例

```text
draw_from_identifier(identifier="50-78-2", also_cdx=true)
```

```text
draw_from_identifier(identifier="aspirin", output_dir="E:\\ds\\chemdraw")
```

```text
draw_from_identifier(identifier="CID:2244", file_name="阿司匹林")
```

---

## 4. 文献工具：`draw_from_paper`

### 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `source` | 是 | DOI（如 `10.1039/c7cc02426f`）、PDF 直链，或本地 PDF 路径 |
| `compound` | 是 | 文献里的编号（`3a`、`compound 7`），或完整 IUPAC 名 |
| `local_pdf` | 否 | 本地论文/SI 的 PDF 路径；**出版社拦截下载时必填** |
| `output_dir` | 否 | 输出目录 |
| `file_name` | 否 | 文件名；默认用化合物编号 |
| `also_cdx` | 否 | 同时输出 `.cdx` |
| `overwrite` | 否 | 覆盖同名文件 |

### 提取流程

```text
PDF/SI
  → 找到“3a”这样的编号
  → 取它前面的 IUPAC 名称
  → OPSIN 把名称转成 SMILES
  → RDKit 独立计算分子式和 InChIKey
  → 与 SI 中的 HRMS 分子式交叉核对
  → ChemDraw 生成 .cdxml / .cdx
```

只有名称能唯一解析、且校验通过才输出；失败会明确报错，不会猜一个结构给你。

### 示例

```text
draw_from_paper(
  source="10.1039/c7cc02426f",
  compound="3a",
  local_pdf="E:\\ds\\chemdraw-samples\\literature\\source-si.pdf",
  also_cdx=true
)
```

### 出版社 PDF 下不下来怎么办

很多出版社（RSC、ACS、Wiley 等）会拦截自动下载。此时：

1. 用学校账号从出版社网页下载论文或 SI 的 PDF；
2. 把路径传给 `local_pdf`；
3. `source` 仍填 DOI，元数据里会记录 DOI 和标题。

---

## 4. 输出文件怎么用

### 在 ChemDraw 里继续编辑

双击 `.cdxml`，或 ChemDraw 里“文件 → 打开”。所有键、原子、电荷、手性楔形键都是可编辑对象。

### 插入 Word

推荐用 `.cdx`：

1. 调用时加 `also_cdx=true`；
2. Word 里“插入 → 对象 → 由文件创建”，选 `.cdx`；
3. 双击对象即可回到 ChemDraw 编辑。

`.cdxml` 也可以打开后另存为 `.cdx`，但直接生成 `.cdx` 更省事。

### 元数据

`.meta.json` 记录：

- 来源：PubChem URL 或 DOI；
- 化合物：CAS、CID、分子式、InChIKey、SMILES；
- 校验：重原子数、元素组成、键数、ChemDraw 版本；
- 文献模式还会记录：IUPAC 名、OPSIN InChIKey、RDKit InChIKey、HRMS 分子式。

写论文时如果日后要核对结构来源，看这个文件即可。

---

## 5. 精度规则（为什么可以放心用）

### 已知化合物

- CAS 校验位本地计算；
- CAS 必须出现在 PubChem 同义词中；
- 名称必须与标题/IUPAC/同义词精确匹配；
- 结构由 PubChem 的 isomeric SMILES 生成，保留手性、E/Z、电荷、盐。

### 文献化合物

- 名称由 OPSIN 解析，RDKit 独立复算 InChIKey；
- 两者不一致直接失败；
- SI 中有 `calc. for C27H19N3O4` 这类 HRMS 时再做分子式核对（Na/K/Li 加合物会自动扣除）；
- 生成后再解析 CDXML，核对元素组成和重原子数。

### 失败时的行为

- 生成的 CDXML 与源 SMILES 不一致：删除文件并报错；
- CAS 校验位错误：不联网，直接拒绝；
- 名称模糊：默认拒绝，并列出候选 CID；
- 文献中找不到 IUPAC 名：拒绝，不猜图。

---

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 名称拼错/出现多个候选 | 先用 `search_compounds` 查看候选，让操作者选择，再用 `CID:<cid>` 生成 |
| SciFinder 怎么接 | 登录 SciFinder 后导出 SDF（首选）或带 CAS 的 CSV，用 `import_scifinder` 读取，再用 `SMILES:<smiles>` 生成 |
| “PubChem 中没有找到名称” | 中文名可先试 ChemicalBook；检查英文拼写，或改用 CAS |
| “CAS 校验位不正确” | 号码抄错；按提示的正确校验位核对 |
| “无法自动下载 PDF” | 出版社限制；下载 PDF 后用 `local_pdf` |
| “没有候选名称能被 OPSIN 解析” | SI 里没有 IUPAC 名，或编号不对；换编号或直接给完整 IUPAC 名 |
| “没有找到与 3a 对应的 IUPAC 名称” | 该编号可能只在主文图里，SI 没有实验名称；尝试其他编号 |
| “ChemDraw 在 save-cdxml 失败” | ChemDraw 未安装/未激活，或文档被占用；重试并确认 ChemDraw 能正常打开 |
| 中文/带空格路径失败 | 已处理：插件在 ASCII 临时目录生成，再由 Node 移动到目标路径；仍失败请把完整报错发我 |
| ChemDraw 已经开着 | 插件会附着到现有实例，只关闭自己创建的文档，不会退出你的 ChemDraw |
| 输出的结构方向不理想 | 是 ChemDraw 对 SMILES 的自动排版，化学上正确；可在 ChemDraw 里手动 Clean Up 或旋转 |

---

## 7. 限制

- **纯图片、没有 IUPAC 名**的化合物可以用 `recognize_image` 出候选，但结果必须人工核对；像 `PhthN`、`MQ`、`Boc` 这种缩写结构 OCR 无法可靠还原，工具会拒绝而不是猜。
- `draw_reaction` 输出的是排版草稿，箭头方向、条件、化学计量和产物需要人工核对。
- 有机金属配合物（如二茂铁）原子组成正确，但 ChemDraw 不会自动补金属–环配位键，需要手动加。
- PubChem 没有 SMILES 的记录（某些聚合物、混合物、材料）无法生成。
- 自动排版可直接用于论文，但个别大分子的环角、取代基方向可能还需要手动整理。
- 文献模式需要联网访问 OPSIN；不需要 API key。

---

## 8. 命令行用法（可选）

已知化合物：

```powershell
node E:\ds\dsh-plugin-chemdraw-bridge\tools\cli.mjs "50-78-2" --out "E:\ds\chemdraw" --cdx
node E:\ds\dsh-plugin-chemdraw-bridge\tools\cli.mjs "cholesterol" --cdx
node E:\ds\dsh-plugin-chemdraw-bridge\tools\cli.mjs "CID:2244" --name aspirin
```

文献模式目前通过对话里的 `draw_from_paper` 工具调用；CLI 暂未封装文献参数。

---

## 9. 配置

在插件的 `cordis.patch.yml` 里可以改：

```yaml
- insert:
    - id: chemdraw-bridge
      name: '@local/dsh-plugin-chemdraw-bridge'
      config:
        outputDir: 'E:\ds\chemdraw'
        alsoCdx: true
        timeoutMs: 180000
        pythonPath: 'E:\ds\dsh-plugin-chemdraw-bridge\vendor\venv\Scripts\python.exe'
```

| 配置 | 说明 |
| --- | --- |
| `outputDir` | 默认输出目录 |
| `alsoCdx` | 是否默认同时输出 `.cdx` |
| `timeoutMs` | ChemDraw 转换超时，默认 120000 毫秒 |
| `pythonPath` | 文献/ SciFinder 用的 Python；默认用 `vendor/venv`（先运行 `scripts/setup-python.ps1`） |

---

## 10. 示例与验证

- 已知化合物示例：`E:\ds\chemdraw-samples\`
- 文献提取示例：`E:\ds\chemdraw-samples\literature\`
  - `3a`、`5a`、`6a` 的 `.cdxml/.cdx/.meta.json`
  - `source-si.pdf`：原始 Supporting Information
- 验证记录：`E:\ds\dsh-plugin-chemdraw-bridge\VERIFICATION.md`

文献示例的三个结构都做过 `CDXML → MOL → RDKit InChIKey` 复核，与 OPSIN 结果完全一致：

- 3a：`QWWIAFJZFCQLMC-ZEQRLZLVSA-N`
- 5a：`UCGNPBFEYVSMOX-IRXDYDNUSA-N`
- 6a：`KWJQIHWFBQBREO-MSOLQXFVSA-N`

---

## 11. 安装

1. 把仓库克隆或下载到本地目录；
2. 首次使用先运行 Python 环境脚本（`draw_from_paper` 和 `import_scifinder` 需要）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-python.ps1
   ```

3. 在 DeepSeek Harness 里把这个目录作为 bundle 安装：

   ```text
   plugin_manager install_bundle(target="E:\\path\\to\\chemdraw-bridge")
   ```

4. 确认 `chemdraw-bridge` 插件行已启用。

5. 需要识图时，再安装本地 OCR 组件：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-osra.ps1
   ```

`vendor/venv` 和 `vendor/osra` 不会提交到仓库，由 setup 脚本创建。

## 12. 环境要求

- Windows；
- ChemDraw 已安装并激活（当前测试版本：ChemOffice 2022 / ChemDraw 22.0.0.22）；
- 联网访问 PubChem、ChemicalBook；文献模式还需访问 OPSIN；
- 不需要 API key；
- 文献模式和 SciFinder 导入需要一个带 PyMuPDF + RDKit 的 Python 环境。首次使用先运行：
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\setup-python.ps1
  ```
  它会在 `vendor/venv` 创建环境并安装 `requirements.txt`。
- 识图功能需要 OSRA；首次使用运行：
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\setup-osra.ps1
  ```
