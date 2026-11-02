<!--
Model-facing fragments for existing structured-output corrections.
One key: value entry per line, as in action-labels.md.
Submission guidance and normalized parser reasons use these templates.
-->

tool-description: Submit the final result for this runtime after required tool work is complete. Arguments must match this schema. If the submission is rejected, correct the reported problems and call this tool again. A successful submission ends the runtime; it does not confirm that changes have been saved.
tool-source-description: After {{ tool }} succeeds, call this tool alone with {}. The host submits that business tool's latest successful canonical result. Correct any reported rejection. Acceptance does not confirm persistence.
source-empty: Call submit-output with {} only; the host supplies the output from the business tool.
source-required: Call {{ tool }} successfully before calling submit-output with {}.
object-required: Arguments must be one complete JSON object.
required-work: Complete required business tool work successfully and resolve failed business calls before submitting. Do not repeat successful writes.
required-work-tools: Complete required business tool work ({{ tools }}) successfully and resolve failed business calls before submitting. Do not repeat successful writes.
after-root-object: unexpected content after a closed root object; expected end-of-input
unexpected-end: unexpected end of JSON input; expected a complete JSON value
unterminated-string: unterminated JSON string; expected a closing double quote
invalid-escape: invalid JSON escape; expected a valid escape sequence
invalid-unicode-escape: invalid Unicode escape; expected four hexadecimal digits
unescaped-control-character: unescaped control character; expected an escaped JSON string
expected-property-name: expected a double-quoted JSON property name or the end of the object
expected-colon: expected a colon after the JSON property name
expected-object-separator: expected a comma or closing brace after the JSON property value
expected-array-separator: expected a comma or closing bracket after the JSON array element
invalid-number: invalid JSON number; expected a complete number
unexpected-token: unexpected JSON token; expected valid JSON syntax
unknown-syntax: invalid JSON syntax; expected a valid JSON value
syntax: JSON syntax error: {{ reason }}. Put all fields inside one complete object.
location: Location: zero-based offset {{ offset }} (JavaScript UTF-16 code units in the original arguments).
location-with-line-column: Location: zero-based offset {{ offset }} (JavaScript UTF-16 code units in the original arguments); line {{ line }}, column {{ column }}.
