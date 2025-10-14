# qmoji

基于 Node.js 与 node-napcat-ts 的应用程序，用于储存与发送自定义表情。

`config.json` 内容如下：

```jsonc
{
  "napcatWs": "ws://127.0.0.1:3001",
  "napcatToken": "token",
  "admins": [3237266617],
  "prefixes": {
    "save": ["#"], // 须为单字符
    "use": ["."], // 须为单字符
    "utils": ["qmoji"]
  },
  "reactOnNotFound": true
}
```
