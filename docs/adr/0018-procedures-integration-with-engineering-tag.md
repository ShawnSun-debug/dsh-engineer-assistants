# 失败诊断写入全局 procedures，并加 engineering 标签

inspector 发现问题后做规则诊断（不做根因分析），master 判断价值，候选进本轮总结的 Procedures 段；用户批准后才写入全局 `~/.dsh/memory/procedures/`。

写入形状沿用现有系统：正文一页五段（触发 / 症状 / 根因 / 正确做法 / 验证），索引 `AGENTS-Procedures.md` 追加一行四列，写前备份 `.bak`。同一根因复发新建一页、slug 加后缀，不覆盖原页。

新增 `procedures/engineering/` 标签目录，里面放指向正文的软链接；索引表不加「标签」列，避免所有既有读取方跟着改。

代价：插件获得全局记忆树的写权，必须自带备份与失败可见；Windows 上软链接可能因权限失败，降级硬链接并如实报告。
