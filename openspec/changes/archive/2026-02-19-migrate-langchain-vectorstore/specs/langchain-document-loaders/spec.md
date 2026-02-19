# LangChain Document Loaders 集成规范

## ADDED Requirements

### Requirement: 使用 PDFLoader 解析 PDF 文档

系统 SHALL 使用 LangChain 的 PDFLoader 替代 pdf-parse 库解析 PDF 文件。

#### Scenario: 解析标准 PDF 文件

- **WHEN** 用户上传一个标准 PDF 文件（10 页，包含文本和图片）
- **THEN** 系统使用 PDFLoader 加载文件
- **AND** 提取所有页面的文本内容
- **AND** 返回 Document 数组，每个 Document 包含 pageContent 和 metadata
- **AND** metadata 包含页码信息（page: number）

#### Scenario: 处理扫描版 PDF

- **WHEN** 用户上传扫描版 PDF（纯图片，无文本层）
- **THEN** PDFLoader 返回空内容
- **AND** 系统抛出 BadRequestException，提示 "PDF 内容为空，请上传包含文本的 PDF"
- **AND** 不插入任何文档到数据库

#### Scenario: 处理损坏的 PDF 文件

- **WHEN** 用户上传损坏的 PDF 文件
- **THEN** PDFLoader 抛出异常
- **AND** 系统捕获异常并抛出 BadRequestException
- **AND** 提示 "PDF 文件解析失败：文件可能已损坏"

### Requirement: 使用 DocxLoader 解析 Word 文档

系统 SHALL 使用 LangChain 的 DocxLoader 替代 mammoth 库解析 Word 文档。

#### Scenario: 解析 .docx 文件

- **WHEN** 用户上传一个 .docx 文件（包含标题、段落、列表）
- **THEN** 系统使用 DocxLoader 加载文件
- **AND** 提取所有文本内容，保留段落结构
- **AND** 返回 Document 数组

#### Scenario: 解析旧版 .doc 文件

- **WHEN** 用户上传一个 .doc 文件（旧版 Word 格式）
- **THEN** 系统首先尝试使用 mammoth 解析（向后兼容）
- **AND** 如果 mammoth 失败，使用 word-extractor 解析
- **AND** 如果都失败，抛出 BadRequestException

#### Scenario: 处理空 Word 文档

- **WHEN** 用户上传一个空的 Word 文档
- **THEN** DocxLoader 返回空内容
- **AND** 系统抛出 BadRequestException，提示 "文件内容为空"

### Requirement: 使用 CSVLoader 解析 Excel 文件

系统 SHALL 使用 LangChain 的 CSVLoader 处理 Excel 文件（.xlsx, .xls）。

#### Scenario: 解析单工作表 Excel

- **WHEN** 用户上传一个 .xlsx 文件（包含一个工作表，10 行数据）
- **THEN** 系统使用 xlsx 库将 Excel 转换为 CSV 格式
- **AND** 使用 CSVLoader 解析 CSV 数据
- **AND** 返回 Document 数组，每行作为一个 Document

#### Scenario: 解析多工作表 Excel

- **WHEN** 用户上传一个 .xlsx 文件（包含 3 个工作表）
- **THEN** 系统遍历所有工作表
- **AND** 将每个工作表转换为独立的 Document
- **AND** 在 pageContent 前添加工作表名称："Sheet: 工作表1\n<内容>"

#### Scenario: 处理公式和格式

- **WHEN** Excel 包含公式（如 =SUM(A1:A10)）
- **THEN** 系统提取公式计算后的值，而非公式本身
- **AND** 忽略单元格格式（颜色、字体等）

### Requirement: 使用 TextLoader 解析文本文件

系统 SHALL 使用 LangChain 的 TextLoader 解析纯文本和 Markdown 文件。

#### Scenario: 解析 .txt 文件

- **WHEN** 用户上传一个 .txt 文件（UTF-8 编码）
- **THEN** 系统使用 TextLoader 加载文件
- **AND** 返回包含全部文本内容的单个 Document

#### Scenario: 解析 .md Markdown 文件

- **WHEN** 用户上传一个 .md 文件（包含标题、列表、代码块）
- **THEN** 系统使用 TextLoader 加载文件
- **AND** 保留 Markdown 格式符号（#, *, ```）
- **AND** 返回包含原始 Markdown 内容的 Document

#### Scenario: 处理不同编码

- **WHEN** 用户上传一个 GBK 编码的 .txt 文件
- **THEN** TextLoader 尝试自动检测编码
- **AND** 如果检测失败，默认使用 UTF-8
- **AND** 如果解码失败，抛出 BadRequestException，提示 "文件编码不支持，请使用 UTF-8"

### Requirement: 统一文档加载接口

系统 SHALL 提供统一的文档加载函数，根据文件扩展名自动选择合适的 Loader。

#### Scenario: 自动选择 Loader

- **WHEN** 用户上传任意支持的文件（.pdf, .docx, .txt, .md, .xlsx, .xls）
- **THEN** 系统根据文件扩展名自动选择对应的 Loader：
  - .pdf → PDFLoader
  - .docx, .doc → DocxLoader 或 mammoth
  - .xlsx, .xls → CSVLoader (via xlsx)
  - .txt, .md → TextLoader
- **AND** 返回统一的 Document[] 格式

#### Scenario: 不支持的文件格式

- **WHEN** 用户上传不支持的文件格式（如 .pptx, .zip）
- **THEN** 系统抛出 BadRequestException
- **AND** 提示 "不支持的文件格式：.pptx"
- **AND** 列出支持的格式：PDF, Word, Excel, TXT, Markdown

### Requirement: 保留文件元数据

系统 SHALL 在解析文档时保留文件元数据（文件名、大小、类型等）。

#### Scenario: 附加元数据到 Document

- **WHEN** 解析任意文件类型
- **THEN** 系统在每个 Document 的 metadata 中添加：
  - fileName: 文件名
  - fileSize: 文件大小（字节）
  - fileType: 文件类型（pdf, docx, xlsx 等）
  - uploadTime: 上传时间
- **AND** 元数据随 Document 一起传递给 TextSplitter

### Requirement: 文档解析性能

系统 SHALL 确保文档解析性能不低于原有实现。

#### Scenario: 大文件解析性能

- **WHEN** 用户上传一个 10MB 的 PDF 文件
- **THEN** 系统在 5 秒内完成解析
- **AND** 解析耗时与原 pdf-parse 实现相当（差异 < 20%）

#### Scenario: 批量文件解析

- **WHEN** 用户批量上传 5 个文件（总计 20MB）
- **THEN** 系统并行解析所有文件
- **AND** 总解析时间 < 15 秒

### Requirement: 错误恢复和降级

系统 SHALL 在新 Loader 失败时尝试降级到原有实现。

#### Scenario: PDFLoader 失败降级

- **WHEN** PDFLoader 解析 PDF 失败
- **THEN** 系统尝试使用原有的 pdf-parse 解析
- **AND** 如果 pdf-parse 成功，继续处理
- **AND** 如果 pdf-parse 也失败，抛出异常

#### Scenario: 记录 Loader 切换日志

- **WHEN** 从新 Loader 切换到旧实现
- **THEN** 系统记录警告日志
- **AND** 包含文件名和失败原因
- **AND** 用于后续问题排查

### Requirement: 清理旧代码

系统 SHALL 在新 Loader 稳定后逐步移除旧的手动解析代码。

#### Scenario: 标记旧代码为 deprecated

- **WHEN** 新 Loader 通过测试并上线
- **THEN** 系统将旧的解析代码（line 140-177）标记为 @deprecated
- **AND** 添加注释说明替换方案
- **AND** 保留代码 3 个月以便回滚

#### Scenario: 最终移除旧代码

- **WHEN** 新 Loader 稳定运行 3 个月无问题
- **THEN** 系统删除旧的解析代码
- **AND** 更新相关测试用例
- **AND** 更新文档说明

### Requirement: 兼容性测试

系统 SHALL 确保新 Loader 与现有数据兼容。

#### Scenario: 解析旧数据验证

- **WHEN** 使用新 Loader 解析文件后
- **THEN** 生成的文本内容与旧实现一致
- **AND** 文本差异 < 5%（由于格式化差异）
- **AND** 不影响检索质量
