# 德国高校验证材料：生成、归档与复用

系统在**提交任务时**自动完成：生成德国学生身份 → 生成两份 PDF 材料 → 按
`verificationId` 归档 → 复用归档材料做二次验证。没有任何 `xxx` 之类占位符，所有字段都是
可核查的具体值。

## 1. 数据来源

### 1.1 高校库 `src/data/universities.de.json`

40 所真实德国高校，每所包含：

| 字段 | 示例（TUM） | 用途 |
|---|---|---|
| `name` / `shortName` | Technische Universität München / TUM | 抬头、SheerID 组织名 |
| `street` / `postalCode` / `city` / `state` | Arcisstraße 21 / 80333 / München / Bayern | 材料抬头与落款 |
| `phone` / `website` | +49 89 289 01 / www.tum.de | 材料抬头 |
| `secretariat` | Studierendensekretariat, Campus TUM | 签发部门 |
| `emailDomain` | tum.de | 学生邮箱域名（LMU `campus.lmu.de`、KIT `student.kit.edu` …） |
| `matriculationDigits` / `matriculationPrefix` | 8 / "0" | 学号（Matrikelnummer）长度与前导 |
| `semesterFee` | 144,00 | 学期费（EUR） |
| `programs` | B.Sc. Informatik / M.Sc. … | 真实专业名池 |

覆盖：TUM、LMU、RWTH Aachen、Heidelberg、FU/HU/TU Berlin、Uni Hamburg、KIT、Uni Stuttgart、
Uni Köln、Goethe Frankfurt、Uni Bonn、TU Dresden、Uni Leipzig、Freiburg、Göttingen、Münster、
Tübingen、Jena、Mannheim、Passau、Konstanz、Würzburg、FAU、Mainz、RUB、UDE、HHU、LUH、
TU Darmstadt、Bremen、Potsdam、Regensburg、Augsburg、Bamberg、Bayreuth、Siegen、
TU Braunschweig、Uni des Saarlandes 等。

### 1.2 身份生成 `src/core/german-identity.js`

- 姓名：德国名/姓语料（Alexander、Julia、Müller、Schäfer …），可选中间名。
- 出生日期：年龄 18–28（偏 20–24），按 `verificationId` 的 SHA-256 派生 → **同一任务恒定**，
  不同任务不同。
- 出生地：德国城市池；住址：大学所在城市 + 德国街道名 + 门牌。
- 学号：符合该校位数（如 TUM 8 位、RWTH 6 位），首位非 0。
- 学期：按当前日期推导（10 月–3 月为冬季学期，4 月–9 月为夏季学期），含学期起止日期。
- 学期数（Fachsemester）1–6 且与"自某学期起注册"自洽。
- 邮箱：`vorname.nachname@<大学域名>`，德语变音转写（ä→ae、ß→ss）。
- 学院签发人（`registrar`）：德国姓名 + 学术头衔 + "Leiter/in des Studierendensekretariats"。

运行校里若显式配置了 `data.firstName` / `data.lastName` / `data.birthDate`，以配置为准，
PDF 与提交表单同步使用该身份。

## 2. 生成的两份材料

纯 Node 生成 PDF（`src/materials/pdf.js`，WinAnsi 编码，德语变音正确），无外部依赖：

| 文件 | 内容 |
|---|---|
| `immatrikulationsbescheinigung.pdf` | 在读证明（A4）：抬头、姓名、出生日期/地点、专业、学号、学期数、注册起始学期、学期费、学期起止 8 行信息表、签发日期、手写体签名、圆形印章、页脚 |
| | `semesterbescheinigung.pdf` | 学期注册证明（A4）：含"学期费已入账"区块、签名与印章 |

`materials.kind` 决定上传哪一份：`enrollment`（默认）或 `semester`（学生证因包含人像栏已停止生成，避免人像与身份不符反成疑点）。两份都会归档，上传只用其中一份。

## 3. 归档布局

```
<artifactsDir>/materials/<verificationId>/
├── immatrikulationsbescheinigung.pdf
├── semesterbescheinigung.pdf
└── material.json          # 索引：身份、学校、文件 sha256、来源 URL、attempts
```

`material.json` 片段：

```json
{
  "verificationId": "bbbbbbbbbbbbbbbbbbbbbbbb",
  "url": "https://services.sheerid.com/verify/.../?verificationId=...",
  "createdAt": "2026-11-17T01:13:39.692Z",
  "updatedAt": "2026-11-17T01:14:02.100Z",
  "generated": true,
  "summary": {
    "university": { "id": "tum", "name": "Technische Universität München", "...": "..." },
    "identity": { "fullName": "Kevin Schubert", "birthDate": "2002-07-01", "studentNumber": "05798415", "...": "..." },
    "files": [ { "name": "immatrikulationsbescheinigung.pdf", "mimeType": "application/pdf", "size": 7768, "sha256": "…" } ]
  },
  "attempts": [
    { "runId": "…", "at": "…", "status": "verified", "code": "STEP_RECEIVED", "stage": "wait_review", "uploadAttempt": 1, "document": "immatrikulationsbescheinigung.pdf" }
  ]
}
```

## 4. 复用语义（需求 4）

- `materials.reuse = true`（默认）：同一 `verificationId` 再次提交时，**直接读取归档文件**，
  身份、学号、出生日期与两份 PDF 的 sha256 全部与首次一致；任务快照里
  `material.source = "reused"`。
- `materials.reuse = false` 或 Web 表单 `"reuseMaterials": false`：重新生成（同一 seed 仍稳定）。
- 篡改归档文件会在读取时被 sha256 校验拦下：`MATERIAL_FILE_CORRUPT`。
- 文件缺失时会记录 `material_incomplete` 并重新生成两份材料。

二次验证入口：

- Web 界面「材料存档」面板每张卡片上的 **二次验证** 按钮 → 用归档里的 `url` 提交新任务
  （`reuseMaterials: true`）。
- API：`POST /api/jobs`，body `{"url": "<归档 url>", "reuseMaterials": true}`。

## 5. 查询接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/materials` | 全部归档材料列表（按更新时间倒序），含身份、学校、文件、最近结果 |
| GET | `/api/materials/:verificationId` | 单任务材料详情（含 `attempts`） |
| GET | `/api/materials/:verificationId/files/:name` | 读取归档 PDF（校验 sha256，`Content-Type: application/pdf`） |
| GET | `/api/universities` | 高校列表（id/名称/城市/州/邮箱域名），用于界面下拉选择 |

错误映射：未知任务/文件 → `404`；文件名不在清单内 → `404`；归档损坏 → `400`。

## 6. 命令行

```bash
node src/cli.js --config config/sheerid.local.json --submit
node src/cli.js --submit --university tum --fresh-material
```

- `--university <id>`：指定高校（默认按任务 seed 自动分配）。
- `--fresh-material`：忽略归档、重新生成材料。
- `--file` / `--url`：显式指定材料时**不覆盖**你的来源，但仍会生成并归档身份与两份材料。

## 7. 校验命令

```bash
node --test tests/materials.test.js tests/materials-api.test.js
```
