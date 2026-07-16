# 安全例外

当前没有生效中的安全例外。安全例外必须限定版本、攻击面、补偿控制和截止日期；新增例外必须经过安全与运行平台负责人审核，不能仅以测试通过作为批准依据。

## SEC-2026-001：Puma PROXY Protocol v1

状态：已解决，不再作为 CI 或生产发布例外。

解决日期：`2026-07-16`。

涉及公告：

- `CVE-2026-47736`：PROXY Protocol v1 解析可能导致远程内存耗尽。
- `CVE-2026-47737`：持久连接可能接受重复 PROXY Protocol 头。

原受影响版本：`puma 5.6.9`。

解决版本：Ruby `3.3.11`、Puma `7.2.1`。

历史攻击面判断：

- 本项目没有启用 Puma PROXY Protocol。
- `bin/api_server` 和 `bin/reference_services_server` 只设置 Rack app、Host 和 Port。
- 服务必须部署在内部网络，不允许绕过受信入口直接暴露到公网。

升级前补偿控制：

- 不增加 `--proxy-protocol` 或等价 Puma 配置。
- 入口代理不得把不可信 PROXY Protocol 数据转发给服务。
- 生产部署前检查实际启动命令和网络暴露范围。
- CI 曾仅忽略上述两个 CVE；升级完成后已删除全部忽略参数。

关闭依据：独立 Ruby 3.3 运行时和 Puma 7.2.1 已完成单元、组件、镜像及安全审计验证；PROXY Protocol 仍保持禁用。
