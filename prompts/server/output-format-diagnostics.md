<!--
Model-facing fragments for existing structured-output corrections.
One key: value entry per line, as in action-labels.md.
Only normalized parser reasons and numeric locations fill these templates.
-->

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
