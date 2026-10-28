# InstaBox Watchdog

Cloudflare Worker，从沙箱外部给 InstaBox 机器续活动租约，并在连续运行满 6 小时时主动暂停再恢复。做法对齐 [InstaBox-Tool](https://github.com/Pretic/InstaBox-Tool) 的 API 保活，不在沙箱里安装 systemd。

沙箱一旦暂停，里面的进程会一起停，无法再把自己唤醒。这个 Worker 跑在 Cloudflare 上，每 5 分钟调用：

```http
PUT /v1/machines/{id}/activity-leases/{leaseId}
Content-Type: application/json

{"ttlSeconds": 900}
```

租约有效期 15 分钟。平台把它视为活动，用来避开 30 分钟闲置暂停，并按规则唤醒因闲置而暂停的机器。

免费版还有 8 小时连续运行上限，活动租约取消不了它。平台只在机器确认睡过去之后才把 `runStartedAt` 清零，所以 Worker 会在连续运行满 6 小时时：

1. 主动暂停，内存和进程保留。
2. 确认状态已是暂停，再等 15 秒。
3. 再恢复。8 小时和 30 分钟从恢复后重新计算。

暂停通常一两分钟，监控会短暂离线。如果已经被平台因上限暂停，冷却大约 10 分钟，冷却结束后的 30 分钟内会自动恢复。

它不会取消这些状态：

- 你在网页上手动暂停或关机
- 平台归档或回收

关机后不会自动开机。某一轮暂停没能重置计时时，这一轮不再重复暂停。

## 部署

1. 在 [InstaBox API Keys](https://dashboard.instabox.sh/) 创建密钥。Restricted 至少给 `machines:write`。密钥只显示一次，不要写进仓库。
2. Cloudflare 新建 Worker，名称 `instabox-watchdog`。不要覆盖已有的 `cf-server-monitor`。
3. 把 `src/index.js` 贴进编辑器，保存并部署。
4. 设置 → 触发事件 → Cron 触发器，计划填 `*/5 * * * *`。
5. 设置 → 变量和密钥，环境选生产：
   - 密钥 `INSTABOX_API_KEY`：`ibk_` 开头的密钥
   - 变量 `SANDBOX_NAME`：`baka`
   - 密钥 `WATCHDOG_TOKEN`：自己生成的一串随机字符
6. 打开该 Worker 的日志。

本机已登录 Wrangler 时，也可以在本目录执行 `npx wrangler deploy`，再到网页补上述三个变量。

## 检查

```text
https://instabox-watchdog.<你的子域>.workers.dev/health
```

应返回 `{"ok":true,"sandbox":"baka","intervalSeconds":300,"resetAfterHours":6}`。

手动续一轮：

```powershell
curl.exe -X POST "https://instabox-watchdog.sunn61676.workers.dev/tick" -H "X-Watchdog-Token: 你的令牌"
```

成功时日志里有 `租约已续，TTL 900 秒`。Cron 的过去事件大约每 5 分钟一条。

## 排查

| 现象 | 处理 |
| --- | --- |
| 缺少 INSTABOX_API_KEY | 密钥加在「变量和密钥」，不要加在「构建」 |
| 401 invalid api key | 密钥错误，或没有 `machines:write` |
| 找不到机器 | `SANDBOX_NAME` 改成控制台里的机器名 |
| 状态 stopped 不续租 | 机器是关机。看门狗不会自动开机，先在网页里启动 |
| 仍在 30 分钟后暂停 | 看 Cron 是否失败。租约中断超过 15 分钟，闲置计时会继续 |
| 大约每 6 小时短暂离线 | 这是主动暂停再恢复。恢复后计时重新计算 |
| 运行约 8 小时后仍暂停十几分钟 | 没赶上 6 小时重置，正在等平台冷却。冷却结束后会自动恢复 |
| 健康检查没有 resetAfterHours | 线上还是旧版本，重新部署这次提交 |
