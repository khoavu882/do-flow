# kvfile

Read and write `key=value` files.

```js
const { parse, format } = require('./src');
parse('name=kv\nmode=fast'); // { name: 'kv', mode: 'fast' }
format({ b: 2, a: 1 });      // 'a=1\nb=2'
```

`config/default.json` holds the defaults and `config/local.json` overrides them.
