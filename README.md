# 接待席位通知查看器

用于检查授权来源的一份原始资料并留存接收凭据，并持续接收合作场馆的接待席位列表通知。当前提供资料预览、原件接收、凭据列表与摘要回读，以及按列表版本、资源实例和 Content-ID 归并的席位状态视图；资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料、核对保存后的原件，并依次展示第一轮订阅的版本缺口与重建订阅后的可信完整名单；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验预览、资料控制、原件持久化，以及席位列表的配对、版本缺口、订阅重建和迟到报文处理；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件；`GET /seats/status` 查看当前席位名单及可信性，`GET /seats` 附带对话轮次与接收事件，`POST /seats/notifications` 直接送入一份原始通知，`POST /seats/refresh` 重新读取订阅。应用只允许配置到本机的资料服务。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料并按 Content-ID 归并正文；`src/xml.mjs` 提供所需的 XML 读取；`src/seats.mjs` 按列表版本与订阅轮次维护席位名单；`src/collector.mjs` 持续核对订阅并接收通知；`src/catalog.mjs` 管理不可变原件及接收凭据；`src/app.mjs` 提供查看服务。资料含义、名单语义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t sip-eventlist .
docker run --rm --network none sip-eventlist
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
