# 测试与发布门禁

## 目标运行时

- Ruby：`2.6.6p146`
- Bundler：`2.1.4`
- Peatio 基础镜像：`quay.io/openware/peatio:2.6.48`

Ruby 2.6 已停止上游安全维护。当前版本是与 Peatio 2.6.48 保持兼容的冻结基线；运行时升级需要单独计划，不能与清算行为改动混在同一个发布中。

## 快速验证

已有本地 Ruby 依赖时：

```bash
ruby -Ilib -S rspec
```

使用目标 Peatio 镜像进行隔离测试：

```bash
docker compose -f docker-compose.test.yml run --build --rm rspec
```

验证 Compose 文件：

```bash
docker compose -f docker-compose.test.yml config --quiet
docker compose -f docker-compose.real.yml config --quiet
```

验证可部署镜像：

```bash
docker build --pull -f Dockerfile.real -t perp-liquidation:local .
docker run --rm --network none perp-liquidation:local bundle exec rake spec
```

执行真实 MySQL、Redis、API 和 Worker 组件场景矩阵：

```bash
docker compose -f docker-compose.real.yml --profile test up --build \
  --abort-on-container-exit --exit-code-from component-smoke component-smoke
```

场景输出和汇总报告写入 `tmp/component-smoke/`。检查完成后清理组件环境：

```bash
docker compose -f docker-compose.real.yml --profile test down -v --remove-orphans
```

## CI 门禁

每次 Pull Request 和 `main` 推送必须完成：

1. 两份 Compose 定义解析成功。
2. 目标 Peatio 镜像中的隔离 RSpec 测试通过。
3. `Dockerfile.real` 能从锁定依赖构建。
4. 构建后的可部署镜像再次通过 RSpec。
5. 当前锁文件通过 Ruby Advisory Database 审计；仅允许 [`security-exceptions.md`](security-exceptions.md) 中未过期的明确例外。
6. Pull Request 中新增或升级的高危依赖被阻止。
7. 所有事件示例通过 JSON Schema 和领域契约校验，OpenAPI 引用可解析。
8. Pull Request 中既有版本的契约相对基线保持向后兼容。

CI 只证明单元、契约和目标运行时兼容性。真实 MySQL、Redis、Worker、消息投递及跨模块流程由后续组件集成和端到端门禁覆盖。

## 合并前检查

- 新增行为有正向、拒绝和可重试路径测试。
- 金额、价格和数量继续使用字符串传输、`BigDecimal` 运算和 `DECIMAL` 存储。
- 任何下单路径仍携带稳定 `client_order_id`、`reduce_only` 和 fencing token。
- 数据库迁移具有明确执行顺序，不依赖手工修改已存在的数据结构。
- 日志和测试夹具不包含 Token、API Key 或真实用户数据。
