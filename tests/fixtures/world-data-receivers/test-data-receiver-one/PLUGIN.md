---
id: test-data-receiver-one
description: Receiver choice fixture
contracts:
  test.receiver-notes@1:
    schema: ./notes.schema.json
  test.single-receiver-notes@1:
    schema: ./notes.schema.json
contributes:
  data:
    notes:
      schema: ./notes.schema.json
      accepts:
        - test.receiver-notes@1
        - test.single-receiver-notes@1
      authoring:
        title: Lamp notes
  datasets:
    notes:
      schema: ./notes.schema.json
      key: id
      ops: [set, delete]
---
