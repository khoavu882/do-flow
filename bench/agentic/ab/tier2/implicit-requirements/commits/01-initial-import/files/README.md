# tasks

A small command line task list. Tasks live in a JSON file (`tasks.json` in the
current directory unless `--file` says otherwise).

```
tasks add "buy milk"
tasks list --status open
tasks export --format csv > tasks.csv
```

Exit codes: `0` on success, `2` when the command line is wrong.

## Commands

### tasks add

Adds a task. The title is every word after `add`.

| Option | Description |
| --- | --- |
| `--file <path>` | Task file to use. Default `tasks.json`. |

### tasks list

Prints one line per task.

| Option | Description |
| --- | --- |
| `--file <path>` | Task file to use. Default `tasks.json`. |
| `--status open\|done\|all` | Only tasks with this status. Default `all`. |
| `--until <date>` | Only tasks created on or before this date. |

### tasks export

Prints every task, as JSON or CSV, on standard output.

| Option | Description |
| --- | --- |
| `--file <path>` | Task file to use. Default `tasks.json`. |
| `--format json\|csv` | Output format. Default `json`. |
