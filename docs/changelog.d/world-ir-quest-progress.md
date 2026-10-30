### Fixed

- **Quest extraction checks every supplied open objective.** World Fact Extraction requires explicit judgments backed by quotes within individual current-story segments and checks them against quest events before succeeding. Plans, partial work, failures and unverified claims cannot also be submitted as finished objectives. Public WorldIR output and quest commit ownership stay unchanged; semantic judgments still depend on the model.
- **World time receives the exact current story and authoritative starting clock.** Its extraction context excludes narrative placeholders and old clock explanations. An optional absolute target lets the tool compute calendar or phase differences while preserving direction, maximum-step, random-mode and transactional checks.
