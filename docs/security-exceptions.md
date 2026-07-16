# 安全例外

安全例外必须限定版本、攻击面、补偿控制和截止日期。新增例外必须经过安全与运行平台负责人审核，不能仅以测试通过作为批准依据。

## SEC-2026-001：Puma PROXY Protocol v1

状态：本地基线临时例外，生产发布前必须由负责人确认。

责任人：待指定；未指定前不得用于生产发布。

涉及公告：

- `CVE-2026-47736`：PROXY Protocol v1 解析可能导致远程内存耗尽。
- `CVE-2026-47737`：持久连接可能接受重复 PROXY Protocol 头。

当前版本：`puma 5.6.9`。

修复版本：`puma >= 7.2.1`；该版本要求 Ruby `>= 3.0`，与当前 Peatio 2.6.48 的 Ruby 2.6.6 不兼容。

当前攻击面判断：

- 本项目没有启用 Puma PROXY Protocol。
- `bin/api_server` 和 `bin/reference_services_server` 只设置 Rack app、Host 和 Port。
- 服务必须部署在内部网络，不允许绕过受信入口直接暴露到公网。

补偿控制：

- 不增加 `--proxy-protocol` 或等价 Puma 配置。
- 入口代理不得把不可信 PROXY Protocol 数据转发给服务。
- 生产部署前检查实际启动命令和网络暴露范围。
- CI 仅忽略上述两个 CVE，其他 Ruby Advisory Database 命中继续阻断。

截止日期：`2026-08-15`。

退出条件：升级到 Ruby `>= 3.0` 和 Puma `>= 7.2.1`，重新执行单元、组件、性能和安全测试后删除该例外。
