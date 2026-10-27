set +e
echo "OSTYPE=$OSTYPE"; uname -a; which -a bash jq git | head; jq --version
jq -n '"a"' | od -c | head -3
jq -nr '"a"' | od -c | head -3
jq -nb '"a"' 2>&1 | od -c | head -3
X=$(jq -nr '"a"'); printf '%s' "$X" | od -c | head
node -e "const {spawnSync}=require('child_process');const r=spawnSync('jq',['-nr','\"a\"'],{encoding:'utf8'});console.log(JSON.stringify(r.stdout), r.status)"
node -e "const {spawnSync}=require('child_process');const r=spawnSync('C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe',['-c','echo HOME=\$HOME XDG=\$XDG_CONFIG_HOME TMPDIR=\$TMPDIR; /usr/bin/printf %s \"\$PATH\"|head -c 300; echo; mktemp -d'],{encoding:'utf8',env:{...process.env,XDG_CONFIG_HOME:'C:\\\\Users\\\\x\\\\xdg',HOME:'C:\\\\Users\\\\x'}});console.log(r.stdout,r.stderr)"
