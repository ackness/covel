<!--
用于现有结构化输出纠正请求的模型指令片段。
与 action-labels.md 相同，每行一个 key: value 条目。
模板提供提交指导以及规范化的解析错误原因。
-->

tool-description: 在完成必需的工具工作后，提交本 runtime 的最终结果。参数必须符合此 schema。若提交被拒绝，请修正报告的问题并再次调用此工具。提交成功会结束 runtime，但不代表更改已经保存。
object-required: 参数必须是一个完整 JSON 对象。
required-work: 请先成功完成必需的业务工具工作，并解决失败的业务调用，然后重新提交。不要重复已成功的写入。
required-work-tools: 请先成功完成必需的业务工具工作（{{ tools }}），并解决失败的业务调用，然后重新提交。不要重复已成功的写入。
after-root-object: 根对象已闭合后仍有内容；此处应为输入结束
unexpected-end: JSON 输入意外结束；需要完整的 JSON 值
unterminated-string: JSON 字符串未闭合；需要结束双引号
invalid-escape: JSON 转义无效；需要合法的转义序列
invalid-unicode-escape: Unicode 转义无效；需要四位十六进制数字
unescaped-control-character: 字符串包含未转义的控制字符；需要合法的 JSON 转义
expected-property-name: 需要双引号包裹的 JSON 属性名或对象结束符
expected-colon: JSON 属性名后需要冒号
expected-object-separator: JSON 属性值后需要逗号或对象结束符
expected-array-separator: JSON 数组元素后需要逗号或数组结束符
invalid-number: JSON 数字无效；需要完整的数字
unexpected-token: JSON 符号无效；需要合法的 JSON 语法
unknown-syntax: JSON 语法无效；需要合法的 JSON 值
syntax: JSON 语法错误：{{ reason }}。所有字段必须位于一个完整对象内。
location: 位置：从零开始的偏移 {{ offset }}（原始参数的 JavaScript UTF-16 代码单元）。
location-with-line-column: 位置：从零开始的偏移 {{ offset }}（原始参数的 JavaScript UTF-16 代码单元）；行 {{ line }}，列 {{ column }}。
