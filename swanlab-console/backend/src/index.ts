/**
 * 服务入口：组装 Express 应用并启动 HTTP 服务。
 * 端口默认 8787（env PORT 可覆盖）；swanlog 目录默认 ../testdata/swanlog（env SWANLOG_DIR 可覆盖）。
 */
import * as path from "path";
import cors from "cors";
import express from "express";
import { createRouter } from "./routes";
import { RunStore } from "./swanlab/reader";

/** swanlog 目录：env SWANLOG_DIR 优先，否则取 backend 包目录的 ../testdata/swanlog */
const SWANLOG_DIR = process.env.SWANLOG_DIR
  ? path.resolve(process.env.SWANLOG_DIR)
  : path.resolve(__dirname, "../../testdata/swanlog");

const PORT = Number(process.env.PORT) || 8787;

// 启动时扫描 SWANLOG_DIR 下的 run-* 目录，请求时懒加载并缓存
const store = new RunStore(SWANLOG_DIR);

const app = express();
app.use(cors()); // 允许任意来源
app.use(express.json());
app.use(createRouter(store));

// 兜底 404：未匹配的路由
app.use((_req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

app.listen(PORT, () => {
  console.log(`swanlab-console backend 已启动: http://127.0.0.1:${PORT} (swanlog: ${SWANLOG_DIR})`);
});
