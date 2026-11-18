# 接待席位通知查看器

用于检查授权来源的原始资料并留存接收凭据，并持续接收合作场馆席位列表的订阅通知。当前提供资料预览、原件接收、凭据列表与摘要回读，以及按列表版本、资源实例和 Content-ID 归属的席位状态视图；资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料并核对保存后的原件；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验已有预览、资料控制和原件持久化；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。应用只允许配置到本机的资料服务。

## 席位列表的持续接收

列表订阅的一份 NOTIFY 会带 RLMI 列表和多份状态正文。应用按 Content-ID 把正文回填到列表实例，不使用 multipart 中的排列次序；缺少正文、Content-ID 重复或正文与资源不符时，该成员标为不能确定，而不是猜一个值。

| 操作 | 含义 |
| --- | --- |
| `POST /subscription` | 向来源领取订阅入口，建立或重建一轮有效订阅；重建可能更换对话标识 |
| `POST /notifications` `{"path":"/notify/1"}` | 领取一份通知并持续接收，正文按 Content-ID 对应回实例 |
| `GET /state` | 值班台视图：列表版本、订阅轮次、成员状态与不能确定的成员 |

状态语义：

- `fullState=true` 才构成可信完整名单；增量只更新其中提到的成员，不能单独作为起点。
- 列表版本必须连续。漏掉一版后旧名单保留但标记 `stale-after-gap`，成员标为不能确定；必须等新的完整名单才能恢复 `current`。
- 列表版本的顺序只在同一轮有效订阅内成立。重建订阅后，旧对话的迟到通知一律拒绝，不覆盖新名单。
- 实例 `state="terminated"` 只表示该实例结束，不代表整个场馆离线；其他实例继续独立汇报。
- `receivedNoticeCount` 表示正常收到并解析成功的报文数，`trust.rosterComplete` / `trust.listStatus` 表示是否已经得到可信完整名单，两者分开报告。
- 每个成员和列表都带 `generation` 与对应的订阅信息，说明状态来自哪一轮有效订阅。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料；`src/eventlist.mjs` 解析 RLMI 列表与 PIDF 正文并建立 Content-ID 索引；`src/listtracker.mjs` 维护版本、订阅轮次与成员可信度；`src/catalog.mjs` 管理不可变原件及接收凭据；`src/app.mjs` 提供查看服务。资料含义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t sip-eventlist .
docker run --rm --network none sip-eventlist
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
