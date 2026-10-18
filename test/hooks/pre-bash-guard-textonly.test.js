'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeEnvelope, runPolicy, parseRecords } = require('../helper/hook-fixtures');

// A scratch policy can be supplied for mutation checks without changing the tree.
const policyPath = process.env.DOFLOW_PRE_BASH_GUARD_TEST_POLICY;
function run(command, role) {
  const input = encodeEnvelope('claude', 'PreToolUse', 'pre-bash-guard', JSON.stringify({
    tool_name: 'Bash', tool_input: { command },
  }), { DOFLOW_SESSION_ROLE: role || '' });
  return runPolicy('pre-bash-guard', input, {
    decisionFd: true, env: { DOFLOW_TELEMETRY: 'off', DOFLOW_SESSION_ROLE: role },
    ...(policyPath ? { policyPath } : {}),
  });
}

const forms = [
  ['commit single quote', (sql) => `git commit -a -q --no-verify -m '${sql}' -m 'notes'`],
  ['commit double quote', (sql) => `git commit -m "${sql}"`],
  ['commit stdin', (sql) => `git commit -q -F - <<'WORDS_1'\n${sql}\nWORDS_1`],
  ['Claude commit', (sql) => `git commit -m "$(cat <<'WORDS_1'\n${sql}\nWORDS_1\n)"`],
  ['echo stdout', (sql) => `echo '${sql}'`],
  ['printf stdout', (sql) => `printf "${sql}"`],
  ['echo file', (sql) => `echo '${sql}' > notes/sql.md`],
  ['printf append', (sql) => `printf "${sql}" >> /tmp/notes.md`],
  ['cat file', (sql) => `cat > notes/sql.md <<'WORDS_1'\n${sql}\nWORDS_1`],
  ['cat stdout', (sql) => `cat <<'WORDS_1'\n${sql}\nWORDS_1\n`],
];
for (const kind of ['pr', 'issue']) for (const action of ['create', 'comment', 'edit']) {
  forms.push([`gh ${kind} ${action} body`, (sql) => `gh ${kind} ${action} --repo owner/repo --body '${sql}'`]);
  forms.push([`gh ${kind} ${action} stdin`, (sql) => `gh ${kind} ${action} --body-file - <<'WORDS_1'\n${sql}\nWORDS_1`]);
}

// Each control has raw SQL and must fail if text-only recognition is widened.
const nearMisses = [
  ['quoted delimiter suffix', 'cat <<"EOF"x\nEOFx\npsql -c \'DROP TABLE users\'\nEOF'],
  ['partially quoted delimiter', 'cat <<E"OF"\nEOF\npsql -c \'DROP TABLE users\''],
  ['function masquerading as cat', "cat () ( psql -c 'DROP TABLE users' ); cat"],
  ['parameter expansion hiding a line', "echo ${x/<<y/}\npsql -c 'DROP TABLE users'\ny"],
  ['arithmetic hiding a line', "echo $[x<<y]\npsql -c 'DROP TABLE users'\ny"],
  ['unquoted heredoc', 'cat <<EOF\nDROP TABLE users\nEOF'],
  ['wrong closing delimiter', 'cat <<EOF\nDROP TABLE users\nEOFx'],
  ['quoted wrong closing delimiter', "cat <<'EOF'\nDROP TABLE users\nEOFx"],
  ['early closing delimiter', "cat <<'EOF'\nEOF\npsql -c 'DROP TABLE users'\nEOF"],
  ['heredoc pipe to psql', "cat <<'EOF' | psql\nDROP TABLE users\nEOF"],
  ['echo pipe to sqlite3', "echo 'DROP TABLE users' | sqlite3 x.db"],
  ['echo substitution', 'echo "$(psql -c \'DROP TABLE users\')"'],
  ['echo backticks', 'echo "`psql -c \'DROP TABLE users\'`"'],
  ['double quoted variable', 'echo "DROP TABLE $table"'],
  ['double quoted backslash', 'echo "DROP TABLE users\\n"'],
  ['commit substitution', 'git commit -m "$(psql -c \'DROP TABLE users\')"'],
  ['commit backticks', 'git commit -m "`psql -c \'DROP TABLE users\'`"'],
  ['commit extra option', "git commit -m 'DROP TABLE users' --template=x"],
  ['commit unquoted heredoc', 'git commit -F - <<EOF\nDROP TABLE users\nEOF'],
  ['Claude trailing command', 'git commit -m "$(cat <<\'EOF\'\nDROP TABLE users\nEOF\n)"; true'],
  ['Claude command in substitution', 'git commit -m "$(cat <<\'EOF\'\nDROP TABLE users\nEOF\npsql -c x\n)"'],
  ['Claude early delimiter', 'git commit -m "$(cat <<\'EOF\'\nEOF\npsql -c \'DROP TABLE users\'\nEOF\n)"'],
  ['hook write', "echo 'DROP TABLE x' > .git/hooks/pre-commit"],
  ['nested dot segment', "echo 'DROP TABLE x' > notes/.git/hooks/pre-commit"],
  ['parent dot segment', "echo 'DROP TABLE x' > notes/../out"],
  ['dotfile write', "echo 'DROP TABLE x' > .psqlrc"],
  ['home write', "echo 'DROP TABLE x' > ~/.psqlrc"],
  ['variable path', "echo 'DROP TABLE x' > $OUT"],
  ['tee psqlrc', "tee -a ~/.psqlrc <<'EOF'\nDROP TABLE users\nEOF"],
  ['shell wrapper', 'sh -c "echo \'DROP TABLE users\'"'],
  ['second command', "echo 'DROP TABLE users'; true"],
  ['compound and', "echo 'DROP TABLE users' && true"],
  ['compound or', "echo 'DROP TABLE users' || true"],
  ['second line', "echo 'DROP TABLE users'\ntrue"],
  ['second redirect', "echo 'DROP TABLE users' > notes > out"],
  ['process substitution', "echo 'DROP TABLE users' > >(psql)"],
  ['cat second command', "cat > notes <<'EOF'\nDROP TABLE users\nEOF\ntrue"],
  ['cat append', "cat >> notes <<'EOF'\nDROP TABLE users\nEOF"],
  ['cat hook target', "cat > .git/hooks/pre-commit <<'EOF'\nDROP TABLE users\nEOF"],
  ['gh substitution', 'gh pr create --body "$(psql -c \'DROP TABLE users\')"'],
  ['gh body requires single quotes', 'gh pr create --body "DROP TABLE users"'],
  ['gh second command', "gh issue comment --body 'DROP TABLE users'; true"],
  ['gh stdin second command', "gh pr edit --body-file - <<'EOF'\nDROP TABLE users\nEOF\ntrue"],
  ['gh pipe', "gh pr create --body 'DROP TABLE users' | psql"],
];

for (const role of [undefined, 'main']) {
  const label = role || 'unset';
  for (const [name, form] of forms) for (const sql of ['DROP TABLE users', 'DELETE FROM t;', 'TRUNCATE TABLE t']) {
    test(`text-only ${label} allows ${name}: ${sql}`, () => {
      const command = form(sql);
      assert.equal(run(command, role).status, 0, command);
    });
  }
  for (const [name, command] of nearMisses) test(`text-only ${label} denies ${name}`, () => {
    const result = run(command, role);
    assert.equal(result.status, 2, command);
    assert.equal(parseRecords(result.records).at(-1)?.outcome, 'deny');
  });
}
