# Advice calls

Optional. Skip a call and its outcome call unless `status` is `answered`; on `agrees: false` say so in one line and keep your judgement. `classify` asks `task-class` itself.

## tier

```bash
"$DOFLOW" advise --kind tier --state "<the package>" --static "<light|standard|frontier>" --task-id "<task id>" --json
"$DOFLOW" advise --action outcome --pick-id "<pickId>" --actual "<tier used>"
```

## mcp-need

```bash
"$DOFLOW" advise --kind mcp-need --server <id> --state "<the stage>" --static <yes|no> --task-id "<task id>" --json
"$DOFLOW" advise --action outcome --pick-id "<pickId>" --actual "<yes|no: server used>"
```

## followup-triage

No `--static`; the pick is input to the question.

```bash
"$DOFLOW" advise --kind followup-triage --state "<its text>" --task-id "<its id>" --json
"$DOFLOW" advise --action outcome --pick-id "<pickId>" --actual "<now|later|dismiss>"
```
